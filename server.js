'use strict';

/**
 * IE 网盘 —— 兼容 IE8+ 的在线文件上传/下载站
 *
 * 仅依赖 Node 内置模块，无需 npm install。
 *   启动： node server.js   然后访问 http://localhost:3000
 *
 * 功能：
 *   - 登录（session cookie，内存保存）
 *   - 上传文件并设置有效期（1/3/7/30 天）
 *   - 自动生成 6 位数字提取码
 *   - 凭链接 + 提取码匿名下载，过期自动失效
 */

var http = require('http');
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var querystring = require('querystring');

var config = require('./config');
var util = require('./lib/util');
var store = require('./lib/storage');
var view = require('./lib/view');
var multipart = require('./lib/multipart');

var PUBLIC_DIR = path.join(__dirname, 'public');
var SESSION_TTL = 8 * 60 * 60 * 1000; // 登录态 8 小时

store.ensureDirs();

// ---------------------------------------------------------------------------
// 会话（内存）
// ---------------------------------------------------------------------------
var sessions = Object.create(null);

function newSession(user) {
  var sid = crypto.randomBytes(18).toString('hex');
  sessions[sid] = { user: user, expires: Date.now() + SESSION_TTL };
  return sid;
}

function getSession(req) {
  var cookies = parseCookies(req.headers.cookie);
  var sid = cookies.sid;
  if (!sid) return null;
  var s = sessions[sid];
  if (!s) return null;
  if (s.expires < Date.now()) {
    delete sessions[sid];
    return null;
  }
  s.expires = Date.now() + SESSION_TTL; // 滑动续期
  return { sid: sid, user: s.user };
}

function parseCookies(header) {
  var out = Object.create(null);
  if (!header) return out;
  String(header).split(';').forEach(function (part) {
    var i = part.indexOf('=');
    if (i === -1) return;
    var k = part.slice(0, i).trim();
    var v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}

// 定期清理过期会话
setInterval(function () {
  var now = Date.now();
  Object.keys(sessions).forEach(function (sid) {
    if (sessions[sid].expires < now) delete sessions[sid];
  });
}, 10 * 60 * 1000).unref();

// 定期清理过期文件（启动后 5 分钟一次，之后每小时一次）
setTimeout(function () {
  store.cleanExpired();
  setInterval(function () { store.cleanExpired(); }, 60 * 60 * 1000);
}, 5 * 60 * 1000);

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------
// 反向代理（1Panel/Nginx）下通过 X-Forwarded-Proto 判断是否为 HTTPS
function isHttps(req) {
  if (req.socket && req.socket.encrypted) return true;
  var proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  return proto === 'https';
}

function sessionCookie(value, req, maxAge) {
  var c = 'sid=' + value + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + maxAge;
  if (isHttps(req)) c += '; Secure';
  return c;
}

// 解析请求 URL（不使用已废弃的 url.parse）
function parseRequestUrl(req) {
  var host = req.headers.host || ('localhost:' + config.port);
  var u;
  try {
    u = new URL(req.url, 'http://' + host);
  } catch (e) {
    u = null;
  }
  var pathname = '/';
  var query = Object.create(null);
  if (u) {
    try {
      pathname = decodeURIComponent(u.pathname || '/');
    } catch (e2) {
      pathname = u.pathname || '/'; // 非法百分号编码：按原样处理，不抛异常
    }
    u.searchParams.forEach(function (v, k) { query[k] = v; });
  }
  // 归一化多余斜杠，避免 //s/123 绕过路由
  pathname = pathname.replace(/\/{2,}/g, '/');
  return { pathname: pathname, query: query };
}

function sendHtml(res, status, html) {
  var buf = Buffer.from(html, 'utf8');
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-cache'
  });
  res.end(buf);
}

function sendJson(res, status, obj) {
  var buf = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-cache'
  });
  res.end(buf);
}

function redirect(res, location, headers) {
  var h = headers || {};
  h['Location'] = location;
  h['Content-Type'] = 'text/html; charset=utf-8';
  res.writeHead(302, h);
  res.end('<html><body>Redirecting to <a href="' + util.esc(location) + '">' + util.esc(location) + '</a></body></html>');
}

function readBody(req, limit, cb) {
  var chunks = [];
  var size = 0;
  var over = false;
  req.on('data', function (c) {
    if (over) return;
    size += c.length;
    if (size > limit) {
      over = true;
      cb(new Error('请求体过大'));
      return;
    }
    chunks.push(c);
  });
  req.on('end', function () {
    if (over) return;
    cb(null, Buffer.concat(chunks).toString('utf8'));
  });
  req.on('error', function (e) { if (!over) { over = true; cb(e); } });
}

function clientIp(req) {
  var xf = req.headers['x-forwarded-for'];
  if (xf) return String(xf).split(',')[0].trim();
  return (req.socket && (req.socket.remoteAddress || req.socket.remoteAddress)) || 'unknown';
}

// 简易限流：防止提取码被暴力猜测
var hits = Object.create(null);
function rateLimited(req, scope) {
  var key = scope + ':' + clientIp(req);
  var now = Date.now();
  var rec = hits[key];
  if (!rec || now - rec.start > config.rateLimit.windowMs) {
    hits[key] = { start: now, count: 1 };
    return false;
  }
  rec.count++;
  return rec.count > config.rateLimit.max;
}
setInterval(function () {
  var now = Date.now();
  Object.keys(hits).forEach(function (k) {
    if (now - hits[k].start > config.rateLimit.windowMs * 2) delete hits[k];
  });
}, 5 * 60 * 1000).unref();

var MIME = {
  '.txt': 'text/plain; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.rar': 'application/x-rar-compressed',
  '.7z': 'application/x-7z-compressed',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.exe': 'application/octet-stream',
  '.msi': 'application/octet-stream'
};

function mimeOf(name) {
  return MIME[path.extname(String(name)).toLowerCase()] || 'application/octet-stream';
}

// Content-Disposition：同时给 ASCII 回退名和 RFC5987 的 UTF-8 名，兼容 IE 与新版浏览器
function contentDisposition(fileName) {
  var ascii = String(fileName).replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  var encoded = encodeURIComponent(fileName).replace(/['()*]/g, function (c) {
    return '%' + c.charCodeAt(0).toString(16).toUpperCase();
  });
  return 'attachment; filename="' + ascii + '"; filename*=UTF-8\'\'' + encoded;
}

function serveStatic(res, pathname) {
  var rel = pathname.replace(/^\/static\/?/, '');
  var full = util.safeJoin(PUBLIC_DIR, rel);
  if (!full) return sendHtml(res, 404, view.messagePage('404', '找不到该资源'));
  fs.stat(full, function (err, st) {
    if (err || !st.isFile()) return sendHtml(res, 404, view.messagePage('404', '找不到该资源'));
    res.writeHead(200, {
      'Content-Type': mimeOf(full),
      'Content-Length': st.size,
      'Cache-Control': 'public, max-age=300'
    });
    fs.createReadStream(full).pipe(res);
  });
}

// ---------------------------------------------------------------------------
// 路由处理
// ---------------------------------------------------------------------------
// 是否需要登录（开关关闭时所有请求都视为已登录的匿名用户）
function hasAccess(session) {
  return !config.requireLogin || !!session;
}

// 当前操作者名（开放模式下为 anonymous）
function actorName(session) {
  return session ? session.user : 'anonymous';
}

function handleLoginPage(req, res, session) {
  if (!config.requireLogin) return redirect(res, '/');
  if (session) return redirect(res, '/');
  sendHtml(res, 200, view.loginPage(null, ''));
}

function handleLoginPost(req, res) {
  if (!config.requireLogin) return redirect(res, '/');
  readBody(req, 64 * 1024, function (err, raw) {
    if (err) return sendHtml(res, 200, view.loginPage('请求异常，请重试', ''));
    var body = querystring.parse(raw);
    var username = String(body.username || '').trim();
    var password = String(body.password || '');
    var expect = config.users[username];
    if (!expect || expect !== password) {
      return sendHtml(res, 200, view.loginPage('用户名或密码错误', username));
    }
    var sid = newSession(username);
    redirect(res, '/', {
      'Set-Cookie': sessionCookie(sid, req, Math.floor(SESSION_TTL / 1000))
    });
  });
}

function handleLogout(req, res, session) {
  if (session) delete sessions[session.sid];
  redirect(res, '/', { 'Set-Cookie': sessionCookie('', req, 0) });
}

// 健康检查（1Panel / Docker 探活用）
function handleHealth(req, res) {
  sendJson(res, 200, {
    ok: true,
    service: 'ie-webdisk',
    time: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    files: store.list().length,
    requireLogin: !!config.requireLogin,
    requireCode: !!config.requireCode
  });
}

// 文件可见性：开启登录时只显示自己的文件，开放模式下所有人共享同一列表
function visibleFiles(session) {
  var list = store.list();
  if (!config.requireLogin) return list;
  return list.filter(function (f) {
    return !f.owner || f.owner === session.user;
  });
}

function handleHome(req, res, session) {
  if (!hasAccess(session)) {
    // 需要登录但未登录：直接给登录页
    return redirect(res, '/login');
  }
  var files = visibleFiles(session).sort(function (a, b) { return b.createdAt - a.createdAt; });
  sendHtml(res, 200, view.dashboardPage(session ? session.user : null, files));
}

function handleFilesApi(req, res, session) {
  if (!hasAccess(session)) return sendJson(res, 401, { ok: false, error: '未登录' });
  var files = visibleFiles(session).sort(function (a, b) { return b.createdAt - a.createdAt; });
  sendJson(res, 200, {
    ok: true,
    files: files.map(function (f) {
      return {
        id: f.id,
        fileName: f.fileName,
        size: f.size,
        sizeText: util.fmtSize(f.size),
        code: f.code,
        expiresAt: util.fmtTime(f.expiresAt),
        leftText: util.isExpired(f) ? '已过期' : util.fmtLeft(f.expiresAt),
        expired: util.isExpired(f),
        downloads: f.downloads || 0,
        url: view.sharePath(f)
      };
    })
  });
}

function handleDeleteApi(req, res, session) {
  if (!hasAccess(session)) return sendJson(res, 401, { ok: false, error: '未登录' });
  readBody(req, 64 * 1024, function (err, raw) {
    if (err) return sendJson(res, 400, { ok: false, error: '请求异常' });
    var body = querystring.parse(raw);
    var id = String(body.id || '');
    var item = store.get(id);
    if (!item) return sendJson(res, 404, { ok: false, error: '文件不存在' });
    // 仅在开启登录时校验归属；开放模式下任何人都能管理列表
    if (config.requireLogin && item.owner && item.owner !== session.user) {
      return sendJson(res, 403, { ok: false, error: '无权删除该文件' });
    }
    store.remove(id);
    sendJson(res, 200, { ok: true });
  });
}

function handleUpload(req, res, session) {
  if (!hasAccess(session)) {
    return sendHtml(res, 200, view.uploadResultPage({ ok: false, error: '登录已过期，请重新登录' }));
  }
  var ctype = String(req.headers['content-type'] || '');
  if (ctype.indexOf('multipart/form-data') === -1) {
    return sendHtml(res, 200, view.uploadResultPage({ ok: false, error: '请使用表单上传文件' }));
  }
  // 浏览器没有传 Content-Length（分块传输）时直接拒绝，避免磁盘被写爆
  var declared = parseInt(req.headers['content-length'], 10);
  if (!isNaN(declared) && declared > config.maxFileSize + 1024 * 1024) {
    return sendHtml(res, 200, view.uploadResultPage({
      ok: false,
      error: '文件超过大小限制（最大 ' + util.fmtSize(config.maxFileSize) + '）'
    }));
  }

  multipart.parse(req, { uploadDir: store.uploadDir, maxFileSize: config.maxFileSize }, function (err, data) {
    if (err) {
      return sendHtml(res, 200, view.uploadResultPage({ ok: false, error: err.message }));
    }
    var file = data.files && data.files[0];
    if (!file || !file.size) {
      if (file && file.path) { try { fs.unlinkSync(file.path); } catch (e) { /* ignore */ } }
      return sendHtml(res, 200, view.uploadResultPage({ ok: false, error: '没有选择文件或文件为空' }));
    }

    var days = parseInt(data.fields.expireDays, 10);
    if (config.expireOptions.indexOf(days) === -1) days = config.defaultExpireDays;

    // 仅当开启提取码时才生成 6 位数字码，否则留空（下载走直链）
    var code = config.requireCode ? store.uniqueCode() : null;
    var rec = {
      id: crypto.randomBytes(8).toString('hex'),
      fileName: file.fileName,
      storedName: path.basename(file.path),
      path: file.path,
      size: file.size,
      code: code,
      owner: actorName(session),
      createdAt: Date.now(),
      expiresAt: Date.now() + days * 24 * 60 * 60 * 1000,
      expireDays: days,
      downloads: 0
    };
    store.add(rec);

    sendHtml(res, 200, view.uploadResultPage({
      ok: true,
      file: {
        id: rec.id,
        fileName: rec.fileName,
        sizeText: util.fmtSize(rec.size),
        code: rec.code,
        hasCode: !!rec.code,
        expireDays: days,
        expiresAt: util.fmtTime(rec.expiresAt),
        url: view.sharePath(rec)
      }
    }));
  });
}

function handleExtract(req, res, parsed) {
  // 未开启提取码功能时，提取页没有意义，直接回首页
  if (!config.requireCode) return redirect(res, '/');
  if (rateLimited(req, 's')) {
    return sendHtml(res, 429, view.messagePage('访问过于频繁', '请稍后再试。'));
  }
  var code = parsed.query.code || parsed.code || '';
  code = String(code).replace(/\D/g, '');
  if (!code) return sendHtml(res, 200, view.extractPage('', null, null));
  if (!util.isCode(code)) return sendHtml(res, 200, view.extractPage(code, null, '提取码必须是 6 位数字'));
  var item = store.getByCode(code);
  if (!item) return sendHtml(res, 200, view.extractPage(code, null, '提取码错误，或文件已过期被清理'));
  sendHtml(res, 200, view.extractPage(code, item, null));
}

function handleDownload(req, res, id) {
  if (rateLimited(req, 'dl')) {
    return sendHtml(res, 429, view.messagePage('访问过于频繁', '请稍后再试。'));
  }
  var item = store.get(id);
  if (!item) return sendHtml(res, 404, view.messagePage('文件不存在', '该文件可能已被删除。'));
  if (util.isExpired(item)) {
    return sendHtml(res, 410, view.messagePage('文件已过期', '该文件已超过有效期，无法下载。'));
  }
  // 仅在开启提取码时才校验；关闭时 /d/<id> 直链即可下载
  if (config.requireCode) {
    var parsed = parseRequestUrl(req);
    var code = String(parsed.query.code || '').replace(/\D/g, '');
    if (!util.isCode(code) || code !== item.code) {
      // 提取码不对：跳回提取页让用户输入
      return redirect(res, '/s/' + item.code);
    }
  }

  fs.stat(item.path, function (err, st) {
    if (err || !st.isFile()) {
      return sendHtml(res, 404, view.messagePage('文件不存在', '文件已从服务器上丢失。'));
    }
    // 支持断点续传（IE 下载工具常用）
    var start = 0;
    var end = st.size > 0 ? st.size - 1 : 0;
    var status = 200;
    var range = req.headers.range;
    if (range) {
      var m = /bytes=(\d*)-(\d*)/.exec(range);
      if (m && st.size > 0) {
        if (m[1] !== '') start = parseInt(m[1], 10);
        if (m[2] !== '') end = parseInt(m[2], 10);
        if (isNaN(start) || start < 0) start = 0;
        if (isNaN(end) || end >= st.size) end = st.size - 1;
        if (start > end) {
          res.writeHead(416, { 'Content-Range': 'bytes */' + st.size });
          return res.end();
        }
        status = 206;
      }
    }

    var headers = {
      'Content-Type': mimeOf(item.fileName),
      'Content-Disposition': contentDisposition(item.fileName),
      'Content-Length': st.size > 0 ? (end - start + 1) : 0,
      'Accept-Ranges': 'bytes',
      'Last-Modified': new Date(item.createdAt).toUTCString(),
      'Cache-Control': 'no-cache'
    };
    if (status === 206) {
      headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + st.size;
    }
    if (req.method !== 'HEAD') {
      // 只统计真正发起的下载
      store.incDownload(item.id);
    }
    res.writeHead(status, headers);
    // 空文件：没有内容可读，直接结束（避免 createReadStream 的 end=0 报错）
    if (req.method === 'HEAD' || st.size === 0) return res.end();

    var rs = fs.createReadStream(item.path, { start: start, end: end });
    rs.on('error', function () {
      try { res.destroy(); } catch (e) { /* ignore */ }
    });
    rs.pipe(res);
  });
}

// ---------------------------------------------------------------------------
// 服务器
// ---------------------------------------------------------------------------
var server = http.createServer(function (req, res) {
  var parsed;
  try {
    parsed = parseRequestUrl(req);
  } catch (e) {
    // 极端畸形请求不能拖垮整个进程
    try {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Bad Request');
    } catch (e2) { /* ignore */ }
    return;
  }
  var pathname = parsed.pathname;
  var session = getSession(req);

  // 统一附加一层安全响应头（IE 也认）
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.method === 'GET' || req.method === 'HEAD') {
    if (pathname.indexOf('/static/') === 0) return serveStatic(res, pathname);
    if (pathname === '/') return handleHome(req, res, session);
    if (pathname === '/login') return handleLoginPage(req, res, session);
    if (pathname === '/logout') return handleLogout(req, res, session);
    if (pathname === '/api/files') return handleFilesApi(req, res, session);
    if (pathname === '/healthz') return handleHealth(req, res);
    if (pathname === '/favicon.ico') {
      res.writeHead(204);
      return res.end();
    }
    if (pathname === '/s' || pathname === '/s/') return handleExtract(req, res, parsed);
    if (pathname.indexOf('/s/') === 0) {
      parsed.code = pathname.slice(3);
      return handleExtract(req, res, parsed);
    }
    if (pathname.indexOf('/download/') === 0) {
      return handleDownload(req, res, pathname.slice('/download/'.length));
    }
    // 短直链：/d/<id>（未开启提取码时分享用）
    if (pathname.indexOf('/d/') === 0) {
      return handleDownload(req, res, pathname.slice('/d/'.length));
    }
    return sendHtml(res, 404, view.messagePage('404', '页面不存在'));
  }

  if (req.method === 'POST') {
    if (pathname === '/login') return handleLoginPost(req, res);
    if (pathname === '/api/upload') return handleUpload(req, res, session);
    if (pathname === '/api/delete') return handleDeleteApi(req, res, session);
    return sendJson(res, 404, { ok: false, error: '接口不存在' });
  }

  sendJson(res, 405, { ok: false, error: '不支持的请求方法' });
});

server.on('clientError', function (err, socket) {
  try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch (e) { /* ignore */ }
});

// 兜底：任何未捕获异常都不能让整个站点挂掉（例如某个文件在下载中途被删）
process.on('uncaughtException', function (err) {
  console.error('[未捕获异常] ' + (err && err.stack ? err.stack : err));
});
process.on('unhandledRejection', function (err) {
  console.error('[未处理的 Promise 拒绝] ' + (err && err.stack ? err.stack : err));
});

server.listen(config.port, config.host, function () {
  var n = store.cleanExpired();
  var admins = Object.keys(config.users);
  console.log('IE 网盘已启动');
  console.log('  本机访问 : http://localhost:' + config.port);
  console.log('  局域网访问: http://<本机IP>:' + config.port);
  console.log('  登录     : ' + (config.requireLogin ? '开启（账号 ' + admins.join(', ') + '）' : '关闭（免登录即可上传）'));
  console.log('  提取码   : ' + (config.requireCode ? '开启（6 位数字）' : '关闭（分享直链即可下载）'));
  if (!config.requireCode) {
    console.log('  提示     : 分享链接形如 http://<域名>/d/<文件ID>');
  }
  if (config.requireLogin && config.users[admins[0]] === 'admin123') {
    console.log('  ⚠ 警告   : 正在使用默认密码 admin123，请修改环境变量 ADMIN_PASSWORD');
  }
  console.log('  数据目录 : ' + config.dataDir + (n ? '（已清理 ' + n + ' 个过期文件）' : ''));
  console.log('  按 Ctrl+C 停止服务');
});

process.on('SIGINT', function () {
  console.log('\n正在停止服务...');
  server.close(function () { process.exit(0); });
  setTimeout(function () { process.exit(0); }, 1500);
});