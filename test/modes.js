'use strict';

/**
 * 开关组合测试：验证 REQUIRE_LOGIN / REQUIRE_CODE 四种组合
 *   node test/modes.js
 * 会自行拉起多个服务器实例（不同端口），无需手工启动。
 */

var http = require('http');
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var cp = require('child_process');

var ROOT = path.join(__dirname, '..');
var pass = 0, fail = 0;

function ok(name, cond, extra) {
  if (cond) { pass++; console.log('    [PASS] ' + name); }
  else { fail++; console.log('    [FAIL] ' + name + (extra ? '  -> ' + extra : '')); }
}

function waitUp(port, cb, tries) {
  tries = tries || 60;
  var req = http.get({ host: '127.0.0.1', port: port, path: '/healthz' }, function (res) {
    res.resume();
    cb(null);
  });
  req.on('error', function () {
    if (tries <= 0) return cb(new Error('server not up on ' + port));
    setTimeout(function () { waitUp(port, cb, tries - 1); }, 100);
  });
}

function req(port, method, urlPath, opts, cb) {
  opts = opts || {};
  var body = opts.body || null;
  var headers = {};
  Object.keys(opts.headers || {}).forEach(function (k) { headers[k] = opts.headers[k]; });
  if (opts.cookie) headers.Cookie = opts.cookie;
  if (body) headers['Content-Length'] = Buffer.byteLength(body);
  var r = http.request({ host: '127.0.0.1', port: port, path: urlPath, method: method, headers: headers }, function (res) {
    var chunks = [];
    res.on('data', function (c) { chunks.push(c); });
    res.on('end', function () {
      var sc = res.headers['set-cookie'];
      cb(null, {
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks),
        cookie: sc && sc.length ? sc[0].split(';')[0] : null
      });
    });
  });
  r.on('error', cb);
  if (body) r.write(body);
  r.end();
}

function multipart(fields, fileName, fileBuf) {
  var b = '----modes' + crypto.randomBytes(8).toString('hex');
  var parts = [];
  Object.keys(fields).forEach(function (k) {
    parts.push(Buffer.from('--' + b + '\r\nContent-Disposition: form-data; name="' + k + '"\r\n\r\n' + fields[k] + '\r\n', 'utf8'));
  });
  parts.push(Buffer.from('--' + b + '\r\nContent-Disposition: form-data; name="file"; filename="' + fileName +
    '"\r\nContent-Type: application/octet-stream\r\n\r\n', 'utf8'));
  parts.push(fileBuf);
  parts.push(Buffer.from('\r\n--' + b + '--\r\n', 'utf8'));
  return { boundary: b, body: Buffer.concat(parts) };
}

function parsePayload(text) {
  var m = /var d=(\{.*?\});/.exec(text);
  try { return m ? JSON.parse(m[1]) : null; } catch (e) { return null; }
}

// 真正的下载地址（分享页 /s/<code> 只是中转页）
function downloadUrl(f, useCode) {
  return '/download/' + f.id + (useCode ? '?code=' + f.code : '');
}

var scenarios = [
  { name: '默认：无需登录 + 无提取码', login: false, code: false, port: 3210 },
  { name: '只要提取码：无需登录 + 提取码', login: false, code: true, port: 3211 },
  { name: '只要登录：需登录 + 无提取码', login: true, code: false, port: 3212 },
  { name: '全开：需登录 + 提取码', login: true, code: true, port: 3213 }
];

var servers = [];

function scenarioTest(s, done) {
  console.log('\n== ' + s.name + ' ==');
  var dir = path.join(__dirname, 'tmp', 'modes-' + s.port);
  fs.rmSync(dir, { recursive: true, force: true });

  var env = Object.assign({}, process.env, {
    PORT: String(s.port),
    HOST: '127.0.0.1',
    DATA_DIR: dir,
    ADMIN_USER: 'admin',
    ADMIN_PASSWORD: 'admin123',
    REQUIRE_LOGIN: s.login ? 'true' : 'false',
    REQUIRE_CODE: s.code ? 'true' : 'false',
    RATE_MAX: '1000'
  });
  var child = cp.spawn(process.execPath, ['server.js'], { cwd: ROOT, env: env, stdio: ['ignore', 'pipe', 'pipe'] });
  var stderr = '';
  child.stderr.on('data', function (c) { stderr += c.toString(); });
  child.on('exit', function (code) {
    if (code !== 0 && code !== null) {
      console.log('    [!!] 服务进程意外退出 code=' + code + '\n' + stderr);
    }
  });
  servers.push({ child: child, dir: dir });

  waitUp(s.port, function (err) {
    if (err) { ok('服务启动', false, err.message); return done(); }
    var cookie = null;

    // 1) 首页
    req(s.port, 'GET', '/', null, function (e1, r1) {
      if (s.login) {
        // 需要登录：未登录访问首页应 302 到 /login，跟着跳转拿到登录页
        ok('需登录时首页重定向到 /login', !e1 && r1.status === 302 && r1.headers.location === '/login',
          'status=' + (r1 && r1.status));
        req(s.port, 'GET', '/login', null, function (e1b, r1b) {
          ok('登录页可访问', !e1b && r1b.status === 200);
          next();
        });
        return;
      }
      ok('GET / 返回 200', !e1 && r1.status === 200, e1 && e1.message);
      var home = e1 ? '' : r1.body.toString('utf8');
      ok('首页含上传表单', home.indexOf('upForm') !== -1);
      ok('首页含有效期选择', home.indexOf('expireDays') !== -1);
      ok('免登录首页直接是上传页', home.indexOf('文件列表') !== -1);
      ok('免登录不显示登录入口', home.indexOf('>登录<') === -1);
      if (s.code) {
        ok('开启提取码时显示提取码列', home.indexOf('提取码') !== -1);
      } else {
        ok('关闭提取码时无提取码列', home.indexOf('col-code') === -1);
      }
      next();
    });

    function next() { step2(); }

    // 2) 登录（仅在需要时）
    function step2() {
      if (!s.login) return step3();
      req(s.port, 'POST', '/login', {
        body: 'username=admin&password=admin123',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      }, function (e, r) {
        ok('登录成功', !e && r.status === 302 && !!r.cookie);
        cookie = r.cookie;
        step3();
      });
    }

    // 3) 上传
    function step3() {
      var buf = crypto.randomBytes(5000);
      var mp = multipart({ expireDays: '3' }, '测试.txt', buf);
      req(s.port, 'POST', '/api/upload', {
        body: mp.body,
        cookie: cookie,
        headers: { 'Content-Type': 'multipart/form-data; boundary=' + mp.boundary }
      }, function (e, r) {
        var text = e ? '' : r.body.toString('utf8');
        var d = parsePayload(text);
        ok('上传成功', !!(d && d.ok), text.slice(0, 160));
        if (!d || !d.file) return done();
        var f = d.file;
        if (s.code) {
          ok('生成了 6 位数字提取码', /^[0-9]{6}$/.test(f.code), f.code);
          ok('分享链接为 /s/<code>', f.url.indexOf('/s/') === 0, f.url);
        } else {
          ok('未生成提取码', !f.code, String(f.code));
          ok('分享链接为 /d/<id> 直链', f.url.indexOf('/d/') === 0, f.url);
        }

        // 4) 下载（走真实下载地址）
        req(s.port, 'GET', downloadUrl(f, s.code), null, function (e2, r2) {
          var h = r2 ? crypto.createHash('sha256').update(r2.body).digest('hex') : '';
          var orig = crypto.createHash('sha256').update(buf).digest('hex');
          ok('下载成功且内容一致', !e2 && r2.status === 200 && h === orig,
            'status=' + (r2 && r2.status));
          step4b(f);
        });
      });
    }

    // 4b) 无提取码时必须跳回提取页；直链模式则可直接下载
    function step4b(f) {
      if (!s.code) return step5(f);
      req(s.port, 'GET', '/download/' + f.id, null, function (e, r) {
        ok('带提取码模式下缺码下载重定向到提取页',
          !e && r.status === 302 && r.headers.location === '/s/' + f.code,
          'status=' + (r && r.status) + ' loc=' + (r && r.headers.location));
        step5(f);
      });
    }

    // 5) 提取页行为
    function step5(f) {
      req(s.port, 'GET', '/s/', null, function (e, r) {
        if (s.code) {
          ok('开启提取码时 /s/ 显示输入框', !e && r.status === 200 && r.body.toString('utf8').indexOf('codeInput') !== -1);
        } else {
          ok('关闭提取码时 /s/ 重定向回首页', !e && r.status === 302, 'status=' + (r && r.status));
        }
        step6(f);
      });
    }

    // 6) 删除
    function step6(f) {
      req(s.port, 'POST', '/api/delete', {
        body: 'id=' + f.id,
        cookie: cookie,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      }, function (e, r) {
        var d = null;
        try { d = JSON.parse(r.body.toString('utf8')); } catch (x) { d = null; }
        ok('删除成功', !!(d && d.ok), r && r.body.toString().slice(0, 120));
        req(s.port, 'GET', downloadUrl(f, s.code), null, function (e2, r2) {
          ok('删除后下载 404', !e2 && r2.status === 404, 'status=' + (r2 && r2.status));
          done();
        });
      });
    }
  });
}

var i = 0;
(function runNext() {
  if (i >= scenarios.length) {
    servers.forEach(function (s) {
      try { s.child.kill(); } catch (e) { /* ignore */ }
      try { fs.rmSync(s.dir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    });
    console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
    process.exit(fail ? 1 : 0);
  }
  scenarioTest(scenarios[i++], runNext);
})();