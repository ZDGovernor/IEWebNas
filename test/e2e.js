'use strict';

/**
 * 自检脚本：用 Node 内置模块跑一遍完整业务链路
 *   node test/e2e.js
 * 需要先启动 server.js（默认 http://127.0.0.1:3000）
 */

var http = require('http');
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

var BASE = process.env.BASE || 'http://127.0.0.1:3000';
var target = new URL(BASE);
var TMP = path.join(__dirname, 'tmp');
if (!fs.existsSync(TMP)) fs.mkdirSync(TMP, { recursive: true });

var pass = 0;
var fail = 0;
var cookie = '';

// 下载地址：开启提取码时要带 code
function downloadUrl(id, code) {
  return '/download/' + id + (code ? '?code=' + code : '');
}

function ok(name, cond, extra) {
  if (cond) {
    pass++;
    console.log('  [PASS] ' + name);
  } else {
    fail++;
    console.log('  [FAIL] ' + name + (extra ? '  -> ' + extra : ''));
  }
}

function request(method, urlPath, opts, cb) {
  opts = opts || {};
  var body = opts.body || null;
  var headers = {};
  if (opts.headers) {
    Object.keys(opts.headers).forEach(function (k) { headers[k] = opts.headers[k]; });
  }
  if (cookie) headers.Cookie = cookie;
  if (body) headers['Content-Length'] = Buffer.byteLength(body);
  var req = http.request({
    host: target.hostname,
    port: target.port || 80,
    path: urlPath,
    method: method,
    headers: headers
  }, function (res) {
    var chunks = [];
    res.on('data', function (c) { chunks.push(c); });
    res.on('end', function () {
      var sc = res.headers['set-cookie'];
      if (sc && sc.length) cookie = sc[0].split(';')[0];
      cb(null, { status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) });
    });
  });
  req.on('error', cb);
  if (body) req.write(body);
  req.end();
}

// 手工拼 multipart，避免依赖任何第三方库
function multipart(fields, fileField, fileName, fileBuf) {
  var boundary = '----ietest' + crypto.randomBytes(8).toString('hex');
  var parts = [];
  Object.keys(fields || {}).forEach(function (k) {
    parts.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="' + k +
      '"\r\n\r\n' + fields[k] + '\r\n', 'utf8'));
  });
  parts.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="' + fileField +
    '"; filename="' + fileName + '"\r\nContent-Type: application/octet-stream\r\n\r\n', 'utf8'));
  parts.push(fileBuf);
  parts.push(Buffer.from('\r\n--' + boundary + '--\r\n', 'utf8'));
  return { boundary: boundary, body: Buffer.concat(parts) };
}

function run() {
  console.log('测试目标: ' + BASE + '\n');
  var MODE = { requireLogin: false, requireCode: false };

  var bigBuf = crypto.randomBytes(300 * 1024);
  var bigHash = crypto.createHash('sha256').update(bigBuf).digest('hex');
  var cnBuf = Buffer.from('中文内容测试 hello', 'utf8');
  var fileId = null, code = null;

  var steps = [];

  steps.push(function (next) {
    console.log('0) 健康检查 + 开关探测');
    request('GET', '/healthz', null, function (err, res) {
      var data = null;
      try { data = JSON.parse(res.body.toString('utf8')); } catch (e) { data = null; }
      ok('GET /healthz 返回 200', !err && res.status === 200, err && err.message);
      ok('健康检查返回 ok:true', !!(data && data.ok === true));
      if (data) {
        MODE.requireLogin = !!data.requireLogin;
        MODE.requireCode = !!data.requireCode;
        console.log('    当前模式: 登录=' + MODE.requireLogin + ' 提取码=' + MODE.requireCode);
      }
      next();
    });
  });

  steps.push(function (next) {
    console.log('1) 页面可达性');
    if (MODE.requireLogin) {
      // 需登录：首页应重定向到登录页
      request('GET', '/', null, function (err, res) {
        ok('未登录访问首页跳转登录页', !err && res.status === 302 && res.headers.location === '/login',
          'status=' + (res && res.status));
        request('GET', '/login', null, function (e2, r2) {
          var html = e2 ? '' : r2.body.toString('utf8');
          ok('登录页返回 200', !e2 && r2.status === 200);
          ok('登录页含用户名密码表单', html.indexOf('name="username"') !== -1 && html.indexOf('name="password"') !== -1);
          next();
        });
      });
      return;
    }
    request('GET', '/', null, function (err, res) {
      ok('GET / 返回 200', !err && res.status === 200, err && err.message);
      var html = err ? '' : res.body.toString('utf8');
      ok('免登录首页直接显示上传表单', html.indexOf('upForm') !== -1);
      request('GET', '/login', null, function (e2, r2) {
        ok('免登录时 /login 重定向回首页', !e2 && r2.status === 302, 'status=' + (r2 && r2.status));
        next();
      });
    });
  });

  steps.push(function (next) {
    console.log('2) 鉴权与登录');
    if (!MODE.requireLogin) {
      request('GET', '/api/files', null, function (err, res) {
        ok('免登录也能访问 /api/files', !err && res.status === 200, 'status=' + (res && res.status));
        next();
      });
      return;
    }
    request('GET', '/api/files', null, function (err, res) {
      ok('未登录访问 /api/files 返回 401', !err && res.status === 401);
      request('POST', '/login', { body: 'username=admin&password=wrong', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }, function (e2, r2) {
        ok('错误密码被拒绝', !e2 && r2.body.toString('utf8').indexOf('用户名或密码错误') !== -1);
        request('POST', '/login', { body: 'username=admin&password=admin123', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }, function (e3, r3) {
          ok('正确密码登录返回 302', !e3 && r3.status === 302);
          ok('下发 session cookie', !e3 && !!cookie);
          next();
        });
      });
    });
  });

  steps.push(function (next) {
    console.log('3) 上传（中文名 + 指定有效期 3 天）');
    var mp = multipart({ expireDays: '3' }, 'file', '中文 测试文件.txt', cnBuf);
    request('POST', '/api/upload', {
      body: mp.body,
      headers: { 'Content-Type': 'multipart/form-data; boundary=' + mp.boundary }
    }, function (err, res) {
      var text = err ? '' : res.body.toString('utf8');
      var m = /var d=(\{.*?\});/.exec(text);
      var data = null;
      try { data = m ? JSON.parse(m[1]) : null; } catch (e) { data = null; }
      ok('上传成功', !!(data && data.ok), text.slice(0, 200));
      if (data && data.file) {
        fileId = data.file.id;
        code = data.file.code;
        if (MODE.requireCode) {
          ok('返回 6 位数字提取码', /^[0-9]{6}$/.test(code), code);
        } else {
          ok('未生成提取码', !code, String(code));
        }
        ok('有效期按 3 天计算', data.file.expireDays === 3);
        ok('文件名正确存中文', data.file.fileName === '中文 测试文件.txt', data.file.fileName);
      }
      next();
    });
  });

  steps.push(function (next) {
    console.log('4) 上传大文件（300KB）并校验完整性');
    var mp = multipart({ expireDays: '7' }, 'file', 'big.bin', bigBuf);
    request('POST', '/api/upload', {
      body: mp.body,
      headers: { 'Content-Type': 'multipart/form-data; boundary=' + mp.boundary }
    }, function (err, res) {
      var text = err ? '' : res.body.toString('utf8');
      var m = /var d=(\{.*?\});/.exec(text);
      var data = null;
      try { data = m ? JSON.parse(m[1]) : null; } catch (e) { data = null; }
      ok('大文件上传成功', !!(data && data.ok), text.slice(0, 200));
      if (!data || !data.file) return next();
      var bid = data.file.id;
      var bcode = data.file.code;
      request('GET', downloadUrl(bid, bcode), null, function (e2, r2) {
        var h = crypto.createHash('sha256').update(r2.body).digest('hex');
        ok('下载内容与上传完全一致', h === bigHash);
        ok('下载响应带 Content-Disposition', /attachment/.test(r2.headers['content-disposition'] || ''));
        ok('支持断点续传', r2.headers['accept-ranges'] === 'bytes');
        next();
      });
    });
  });

  steps.push(function (next) {
    console.log('5) 提取码校验');
    if (!MODE.requireCode) {
      request('GET', '/s/', null, function (err, res) {
        ok('关闭提取码时提取页重定向回首页', !err && res.status === 302, 'status=' + (res && res.status));
        next();
      });
      return;
    }
    request('GET', '/s/' + code, null, function (err, res) {
      var html = err ? '' : res.body.toString('utf8');
      ok('正确提取码展示文件信息', html.indexOf('中文 测试文件.txt') !== -1 && html.indexOf('下 载 文 件') !== -1);
      request('GET', '/s/000000', null, function (e2, r2) {
        var h2 = e2 ? '' : r2.body.toString('utf8');
        ok('错误提取码给出提示', h2.indexOf('提取码错误') !== -1);
        request('GET', '/s/abc', null, function (e3, r3) {
          ok('非法提取码被拦截', !e3 && r3.status === 200);
          next();
        });
      });
    });
  });

  steps.push(function (next) {
    console.log('6) 缺少提取码时的下载行为');
    if (!MODE.requireCode) {
      request('GET', downloadUrl(fileId, null), null, function (err, res) {
        ok('无提取码模式直链可直接下载', !err && res.status === 200, 'status=' + (res && res.status));
        next();
      });
      return;
    }
    request('GET', '/download/' + fileId, null, function (err, res) {
      ok('未带提取码返回 302', !err && res.status === 302, err && err.message);
      ok('跳转到 /s/<code>', !err && String(res.headers.location).indexOf('/s/') === 0, res && res.headers.location);
      next();
    });
  });

  steps.push(function (next) {
    console.log('7) 中文文件名下载头');
    request('HEAD', downloadUrl(fileId, code), null, function (err, res) {
      var cd = (res && res.headers['content-disposition']) || '';
      ok('Content-Disposition 含 RFC5987 编码', cd.indexOf("filename*=UTF-8''") !== -1, cd);
      ok('Content-Length 正确', !err && res.headers['content-length'] === String(cnBuf.length));
      next();
    });
  });

  steps.push(function (next) {
    console.log('8) 删除文件');
    request('POST', '/api/delete', {
      body: 'id=' + fileId,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    }, function (err, res) {
      var data = null;
      try { data = JSON.parse(res.body.toString('utf8')); } catch (e) { data = null; }
      ok('删除成功', !!(data && data.ok));
      request('GET', downloadUrl(fileId, code), null, function (e2, r2) {
        ok('删除后无法下载(404)', !e2 && r2.status === 404, r2 && r2.status);
        next();
      });
    });
  });

  steps.push(function (next) {
    console.log('9) 上传参数与安全');
    request('POST', '/api/upload', {
      body: 'not-multipart',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    }, function (err, res) {
      var text = err ? '' : res.body.toString('utf8');
      ok('非 multipart 请求被拒绝', text.indexOf('请使用表单上传文件') !== -1);
      var mp = multipart({ expireDays: '999' }, 'file', 'x.txt', Buffer.from('hi'));
      request('POST', '/api/upload', {
        body: mp.body,
        headers: { 'Content-Type': 'multipart/form-data; boundary=' + mp.boundary }
      }, function (e2, r2) {
        var t2 = e2 ? '' : r2.body.toString('utf8');
        var m2 = /var d=(\{.*?\});/.exec(t2);
        var d2 = null;
        try { d2 = m2 ? JSON.parse(m2[1]) : null; } catch (e) { d2 = null; }
        ok('非法有效期被回落到默认值', !!(d2 && d2.file && d2.file.expireDays === 7),
          d2 && d2.file && String(d2.file.expireDays));
        // 清理这条测试记录
        if (d2 && d2.file) {
          request('POST', '/api/delete', {
            body: 'id=' + d2.file.id,
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
          }, function () { next(); });
        } else {
          next();
        }
      });
    });
  });

  steps.push(function (next) {
    console.log('10) 路径穿越与静态资源');
    request('GET', '/static/../config.js', null, function (err, res) {
      ok('静态目录禁止穿越', !err && res.status === 404, res && res.status);
      request('GET', '/static/style.css', null, function (e2, r2) {
        ok('style.css 可访问', !e2 && r2.status === 200);
        ok('CSS 不含 flex 布局(IE8 兼容)', !e2 && r2.body.toString('utf8').indexOf('display:flex') === -1);
        request('GET', '/static/app.js', null, function (e3, r3) {
          var js = e3 ? '' : r3.body.toString('utf8');
          ok('app.js 可访问', !e3 && r3.status === 200);
          ok('JS 为 ES5(无 let/const/箭头函数)', !/\b(let|const)\s+\w|=>/.test(js));
          next();
        });
      });
    });
  });

  var i = 0;
  (function nextStep() {
    if (i >= steps.length) {
      console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
      process.exit(fail ? 1 : 0);
    }
    steps[i++](nextStep);
  })();
}

run();