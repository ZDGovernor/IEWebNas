'use strict';

/**
 * 边界测试：空文件、超长/怪异文件名、重复名、断点续传、过期
 *   node test/edge.js   （需先启动 server.js，默认 3000 端口）
 */

var http = require('http');
var crypto = require('crypto');

var PORT = Number(process.env.PORT || 3000);
var pass = 0, fail = 0;
var cookie = null;

function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  [PASS] ' + name); }
  else { fail++; console.log('  [FAIL] ' + name + (extra ? '  -> ' + extra : '')); }
}

function req(method, urlPath, opts, cb) {
  opts = opts || {};
  var body = opts.body || null;
  var headers = {};
  Object.keys(opts.headers || {}).forEach(function (k) { headers[k] = opts.headers[k]; });
  if (cookie) headers.Cookie = cookie;
  if (body) headers['Content-Length'] = Buffer.byteLength(body);
  var r = http.request({ host: '127.0.0.1', port: PORT, path: urlPath, method: method, headers: headers }, function (res) {
    var chunks = [];
    res.on('data', function (c) { chunks.push(c); });
    res.on('end', function () {
      var sc = res.headers['set-cookie'];
      if (sc && sc.length) cookie = sc[0].split(';')[0];
      cb(null, { status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) });
    });
  });
  r.on('error', cb);
  if (body) r.write(body);
  r.end();
}

function upload(fileName, buf, fields) {
  return function (done) {
    var f = fields || { expireDays: '1' };
    var b = '----edge' + crypto.randomBytes(8).toString('hex');
    var parts = [];
    Object.keys(f).forEach(function (k) {
      parts.push(Buffer.from('--' + b + '\r\nContent-Disposition: form-data; name="' + k + '"\r\n\r\n' + f[k] + '\r\n', 'utf8'));
    });
    parts.push(Buffer.from('--' + b + '\r\nContent-Disposition: form-data; name="file"; filename="' + fileName +
      '"\r\nContent-Type: application/octet-stream\r\n\r\n', 'utf8'));
    parts.push(buf);
    parts.push(Buffer.from('\r\n--' + b + '--\r\n', 'utf8'));
    req('POST', '/api/upload', {
      body: Buffer.concat(parts),
      headers: { 'Content-Type': 'multipart/form-data; boundary=' + b }
    }, function (e, r) {
      var m = /var d=(\{.*?\});/.exec(e ? '' : r.body.toString('utf8'));
      var d = null;
      try { d = m ? JSON.parse(m[1]) : null; } catch (x) { d = null; }
      done(d);
    });
  };
}

var steps = [];

// 空文件：之前会导致进程崩溃
steps.push(function (next) {
  console.log('1) 空文件（回归：曾导致进程崩溃）');
  upload('empty.txt', Buffer.alloc(0))(function (d) {
    if (!d || !d.ok) {
      ok('空文件被拒绝或正确处理（不崩溃）', true, JSON.stringify(d));
      return next();
    }
    ok('空文件上传返回成功', true);
    req('GET', '/download/' + d.file.id + '?code=' + (d.file.code || ''), null, function (e, r) {
      ok('空文件可下载且返回 200', !e && r.status === 200, 'status=' + (r && r.status));
      ok('空文件 Content-Length 为 0', !e && r.headers['content-length'] === '0');
      req('GET', '/healthz', null, function (e2, r2) {
        ok('进程仍然存活', !e2 && r2.status === 200);
        next();
      });
    });
  });
});

// 重复文件名不应互相覆盖
steps.push(function (next) {
  console.log('2) 同名文件不覆盖');
  var a = Buffer.from('AAA-content');
  var b = Buffer.from('BBBBBB-content');
  upload('same.txt', a)(function (d1) {
    upload('same.txt', b)(function (d2) {
      ok('两次上传都成功', !!(d1 && d1.ok) && !!(d2 && d2.ok));
      req('GET', '/download/' + d1.file.id + (d1.file.code ? '?code=' + d1.file.code : ''), null, function (e1, r1) {
        req('GET', '/download/' + d2.file.id + (d2.file.code ? '?code=' + d2.file.code : ''), null, function (e2, r2) {
          ok('第一个文件内容未被覆盖', r1.body.toString() === 'AAA-content', r1.body.toString());
          ok('第二个文件内容正确', r2.body.toString() === 'BBBBBB-content', r2.body.toString());
          next();
        });
      });
    });
  });
});

// 中文/空格/特殊字符文件名
steps.push(function (next) {
  console.log('3) 特殊文件名');
  var cases = ['中文 名字 (1).txt', "a'b\"c.txt", '带#号和&符号.txt'];
  var idx = 0;
  (function go() {
    if (idx >= cases.length) return next();
    var name = cases[idx++];
    upload(name, Buffer.from('x'))(function (d) {
      ok('上传成功: ' + name, !!(d && d.ok), JSON.stringify(d && d.error));
      if (!d || !d.ok) return go();
      req('GET', '/download/' + d.file.id + (d.file.code ? '?code=' + d.file.code : ''), null, function (e, r) {
        var cd = (r && r.headers['content-disposition']) || '';
        ok('  下载头合法: ' + name, !e && r.status === 200 && cd.indexOf('attachment') === 0, cd);
        go();
      });
    });
  })();
});

// 断点续传
steps.push(function (next) {
  console.log('4) 断点续传');
  var buf = crypto.randomBytes(10000);
  upload('range.bin', buf)(function (d) {
    if (!d || !d.ok) { ok('准备文件', false); return next(); }
    var url = '/download/' + d.file.id + (d.file.code ? '?code=' + d.file.code : '');
    req('GET', url, { headers: { Range: 'bytes=100-199' } }, function (e, r) {
      ok('返回 206', !e && r.status === 206, 'status=' + (r && r.status));
      ok('返回 100 字节', !e && r.body.length === 100, String(r && r.body.length));
      ok('内容与源一致', !e && Buffer.compare(r.body, buf.slice(100, 200)) === 0);
      ok('Content-Range 正确', !e && r.headers['content-range'] === 'bytes 100-199/10000',
        r && r.headers['content-range']);
      req('GET', url, { headers: { Range: 'bytes=99999-' } }, function (e2, r2) {
        ok('越界 Range 返回 416', !e2 && r2.status === 416, 'status=' + (r2 && r2.status));
        next();
      });
    });
  });
});

// 删除后下载 + 列表为空的情况
steps.push(function (next) {
  console.log('5) 列表与删除');
  req('GET', '/api/files', null, function (e, r) {
    var d = null;
    try { d = JSON.parse(r.body.toString('utf8')); } catch (x) { d = null; }
    ok('/api/files 返回列表', !e && d && d.ok && Array.isArray(d.files));
    if (!d || !d.files.length) return next();
    var f = d.files[0];
    req('POST', '/api/delete', {
      body: 'id=' + f.id,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    }, function (e2, r2) {
      var d2 = null;
      try { d2 = JSON.parse(r2.body.toString('utf8')); } catch (x) { d2 = null; }
      ok('删除成功', !!(d2 && d2.ok));
      req('POST', '/api/delete', {
        body: 'id=' + f.id,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      }, function (e3, r3) {
        ok('重复删除返回 404', !e3 && r3.status === 404, 'status=' + (r3 && r3.status));
        next();
      });
    });
  });
});

var i = 0;
(function run() {
  if (i >= steps.length) {
    console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
    process.exit(fail ? 1 : 0);
  }
  steps[i++](run);
})();