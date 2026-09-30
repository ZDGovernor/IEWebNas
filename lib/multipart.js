'use strict';

// 极简 multipart/form-data 流式解析器。
// 只依赖 Node 内置模块，上传大文件时边收边写盘，不占内存。
//
// 重要：所有文件写流都 flush 完成（close 事件）之后才会回调 cb，
// 否则调用方可能在数据落盘前就 fs.stat 到 size=0。

var fs = require('fs');
var path = require('path');
var util = require('./util');

var CRLFCRLF = Buffer.from('\r\n\r\n');
var DASH = 0x2d; // '-'

function parseContentDisposition(value) {
  var out = { name: '', filename: null };
  var nameM = /name="([^"]*)"/i.exec(value);
  if (nameM) out.name = nameM[1];
  var fileM = /filename="([^"]*)"/i.exec(value);
  if (fileM) out.filename = fileM[1];
  // filename*=UTF-8''xxx 形式（现代浏览器）
  var fileStar = /filename\*=UTF-8''([^;]*)/i.exec(value);
  if (!fileStar) fileStar = /filename\*=utf-8''([^;]*)/i.exec(value);
  if (fileStar) {
    try { out.filename = decodeURIComponent(fileStar[1]); } catch (e) { /* 保留原值 */ }
  }
  return out;
}

/**
 * @param {http.IncomingMessage} req
 * @param {object} opts
 *   opts.uploadDir   文件落盘目录
 *   opts.maxFileSize 单文件上限（字节）
 * @param {function(Error, object)} cb  cb(err, { fields: {...}, files: [...] })
 */
function parse(req, opts, cb) {
  var boundary = null;
  var ctype = req.headers['content-type'] || '';
  var m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(ctype);
  if (m) boundary = m[1] || m[2];
  if (!boundary) return cb(new Error('不是合法的 multipart/form-data 请求'));
  var delim = Buffer.from('--' + boundary);

  var fields = {};
  var files = [];
  var done = false;
  var buf = Buffer.alloc(0);
  var state = 'preamble';   // preamble -> headers -> body
  var cur = null;           // 当前 part
  var stream = null;        // 当前文件写流
  var pendingWrites = 0;    // 尚未 close 的文件写流数量
  var parseEnded = false;   // 解析是否已走到结尾

  function fail(e) {
    if (done) return;
    done = true;
    cleanup();
    cb(e || new Error('上传解析失败'));
  }

  function cleanup() {
    if (stream) {
      try { stream.destroy(); } catch (e) { /* ignore */ }
      stream = null;
    }
    if (cur && cur.path) {
      try { fs.unlinkSync(cur.path); } catch (e) { /* ignore */ }
    }
  }

  // 解析结束 + 所有写流 flush 完成后才回调
  function maybeFinish() {
    if (done || !parseEnded || pendingWrites > 0) return;
    done = true;
    req.removeListener('data', onData);
    req.removeListener('end', onEnd);
    req.removeListener('error', fail);
    cb(null, { fields: fields, files: files });
  }

  // 打开一个文件写流，遇到已存在文件名自动加序号
  function openFile(rawName) {
    var base = path.basename(String(rawName || 'file')).replace(/[\r\n\0]/g, '').trim() || 'file';
    if (base.length > 180) {
      var ext = path.extname(base).slice(0, 20);
      base = base.slice(0, 120) + ext;
    }
    var target = util.safeJoin(opts.uploadDir, base);
    if (!target) target = path.join(opts.uploadDir, 'file_' + Date.now());
    var name = path.basename(target);
    var n = 1;
    while (fs.existsSync(target)) {
      var e2 = path.extname(name);
      var stem = name.slice(0, name.length - e2.length);
      target = path.join(opts.uploadDir, stem + '(' + (++n) + ')' + e2);
    }
    var ws = fs.createWriteStream(target);
    ws.on('error', fail);
    return { stream: ws, path: target, name: path.basename(target) };
  }

  function beginBody() {
    if (cur && cur.isFile) {
      var f = openFile(cur.filename);
      cur.path = f.path;
      cur.name = f.name;
      cur.size = 0;
      stream = f.stream;
    }
  }

  function endBody() {
    if (cur && cur.isFile) {
      var info = cur;
      var ws = stream;
      stream = null;
      files.push({ field: info.name, fileName: info.name, size: info.size, path: info.path });
      if (ws) {
        pendingWrites++;
        ws.on('close', function () {
          pendingWrites--;
          maybeFinish();
        });
        ws.end();
      }
    } else if (cur && cur.name) {
      fields[cur.name] = cur.value || '';
    }
    cur = null;
  }

  function parseHeaders() {
    var idx = buf.indexOf(CRLFCRLF);
    if (idx === -1) {
      if (buf.length > 64 * 1024) { fail(new Error('请求头过大')); return false; }
      return false;
    }
    var head = buf.slice(0, idx).toString('utf8');
    buf = buf.slice(idx + 4);
    cur = { isFile: false, name: '', filename: null, size: 0, path: null };
    head.split('\r\n').forEach(function (line) {
      var p = line.indexOf(':');
      if (p === -1) return;
      var k = line.slice(0, p).trim().toLowerCase();
      var v = line.slice(p + 1).trim();
      if (k === 'content-disposition') {
        var cd = parseContentDisposition(v);
        cur.name = cd.name;
        cur.filename = cd.filename;
        if (cd.filename !== null) cur.isFile = true;
      }
    });
    beginBody();
    return true;
  }

  function writeOut(out) {
    if (!out.length) return;
    if (cur && cur.isFile && stream) {
      cur.size += out.length;
      if (cur.size > opts.maxFileSize) return fail(new Error('文件超过大小限制'));
      stream.write(out);
    } else if (cur && !cur.isFile) {
      if (cur.size > 1024 * 1024) return fail(new Error('表单字段过大'));
      cur.size += out.length;
      cur.value = (cur.value || '') + out.toString('utf8');
    }
  }

  function onData(chunk) {
    if (done) return;
    try {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;

      if (state === 'preamble') {
        var s = buf.indexOf(delim);
        if (s === -1) {
          if (buf.length > delim.length * 2) buf = buf.slice(-delim.length);
          return;
        }
        buf = buf.slice(s + delim.length);
        state = 'headers';
      }

      for (;;) {
        if (state === 'headers') {
          if (!parseHeaders()) return;
          state = 'body';
        }

        // 找下一个边界：必须匹配 \r\n--boundary
        var pos = -1;
        var from = 0;
        for (;;) {
          var p = buf.indexOf(delim, from);
          if (p === -1) { pos = -1; break; }
          if (p >= 2 && buf[p - 2] === 0x0d && buf[p - 1] === 0x0a) { pos = p - 2; break; }
          from = p + 1;
        }

        if (pos === -1) {
          // 边界还没到齐，先写下安全部分（保留 delim.length + 4 字节尾巴）
          var keep = delim.length + 4;
          if (buf.length > keep) {
            var out = buf.slice(0, buf.length - keep);
            buf = buf.slice(buf.length - keep);
            writeOut(out);
          }
          return;
        }

        writeOut(buf.slice(0, pos));
        var after = pos + 2 + delim.length; // 跳过 \r\n--
        if (buf.length >= after + 2 && buf[after] === DASH && buf[after + 1] === DASH) {
          endBody();
          buf = Buffer.alloc(0);
          state = 'epilogue';
          parseEnded = true;
          maybeFinish();
          return;
        }
        // 普通分隔：跳过后面的 \r\n
        var next = after;
        if (buf.length >= next + 2 && buf[next] === 0x0d && buf[next + 1] === 0x0a) next += 2;
        else if (buf.length < next + 2) { buf = buf.slice(pos); return; }

        buf = buf.slice(next);
        endBody();
        state = 'headers';
      }
    } catch (e) {
      fail(e);
    }
  }

  function onEnd() {
    if (done) return;
    // 收尾：把当前普通字段落下来
    if (cur && !cur.isFile) {
      fields[cur.name] = cur.value || '';
      cur = null;
    }
    parseEnded = true;
    maybeFinish();
  }

  req.on('data', onData);
  req.on('end', onEnd);
  req.on('error', fail);
}

module.exports = { parse: parse };