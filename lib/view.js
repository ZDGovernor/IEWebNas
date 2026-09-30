'use strict';

var util = require('./util');
var config = require('../config');

// ---------------------------------------------------------------------------
// 所有页面都在服务端拼好 HTML 再输出：
//  * IE8 不需要执行 JS 也能看到完整内容
//  * 不使用 flex / grid / rgba / box-shadow 等 IE8 不认的样式
//
// 两个开关决定了整套页面长什么样：
//   config.requireLogin  是否需要登录（默认 false）
//   config.requireCode   是否使用 6 位提取码（默认 false）
// ---------------------------------------------------------------------------

var CSS_VERSION = '2';
var JS_VERSION = '2';

function layout(title, body, opts) {
  opts = opts || {};
  var head = [
    '<!DOCTYPE html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta http-equiv="X-UA-Compatible" content="IE=edge" />',
    '<meta http-equiv="Content-Type" content="text/html; charset=utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    '<title>' + util.esc(title) + '</title>',
    '<link rel="stylesheet" type="text/css" href="/static/style.css?v=' + CSS_VERSION + '" />',
    '</head>',
    '<body>'
  ].join('\n');

  // 把开关传给前端脚本，用于无刷新刷新列表时渲染出正确的列
  var optsJs = '<script type="text/javascript">var APP_OPTS=' +
    JSON.stringify({ requireLogin: !!config.requireLogin, requireCode: !!config.requireCode }) +
    ';</script>';

  var foot = [
    '<div class="footer">IE 网盘 · 兼容 IE8+ / Chrome / Edge / Firefox &nbsp;|&nbsp; ' +
      '数据保存在服务器 <code>data/</code> 目录</div>',
    optsJs,
    opts.script || '',
    '</body>',
    '</html>'
  ].join('\n');

  return head + '\n' + body + '\n' + foot;
}

function topbar(user) {
  var right = '';
  if (config.requireLogin) {
    if (user) {
      right = '<span class="user">' + util.esc(user) + '</span>' +
        '<a class="toplink" href="/logout">退出</a>';
    } else {
      right = '<a class="toplink" href="/login">登录</a>';
    }
  } else {
    // 未开启登录：不显示登录入口
    right = '<span class="user">开放模式 · 无需登录</span>';
  }
  return [
    '<div class="topbar">',
    '  <div class="wrap">',
    '    <a class="logo" href="/">IE&nbsp;网盘</a>',
    '    <div class="topright">' + right + '</div>',
    '  </div>',
    '</div>'
  ].join('\n');
}

// 分享链接：开启提取码走 /s/<code>，否则走直链 /d/<id>
function sharePath(item) {
  return config.requireCode ? ('/s/' + item.code) : ('/d/' + item.id);
}

// --------------------------------------------------------------------------
// 登录页
// --------------------------------------------------------------------------
function loginPage(err, username) {
  var errHtml = err ? '<div class="alert alert-error">' + util.esc(err) + '</div>' : '';
  var body = [
    topbar(null),
    '<div class="wrap">',
    '  <div class="loginbox">',
    '    <h2 class="login-title">管理员登录</h2>',
    errHtml,
    '    <form method="post" action="/login">',
    '      <div class="field"><label for="username">用户名</label>',
    '        <input type="text" id="username" name="username" class="ipt" value="' + util.esc(username || '') + '" />',
    '      </div>',
    '      <div class="field"><label for="password">密码</label>',
    '        <input type="password" id="password" name="password" class="ipt" />',
    '      </div>',
    '      <div class="field">',
    '        <input type="submit" class="btn btn-primary btn-block" value="登 录" />',
    '      </div>',
    '    </form>',
    '    <div class="tip">账号通过环境变量 <code>ADMIN_USER</code> / <code>ADMIN_PASSWORD</code> 配置</div>',
    '  </div>',
    '</div>'
  ].join('\n');
  return layout('登录 - IE 网盘', body);
}

// --------------------------------------------------------------------------
// 控制台 / 首页（上传 + 文件列表）
// --------------------------------------------------------------------------
function expireSelect() {
  var opts = config.expireOptions.map(function (d) {
    return '<option value="' + d + '"' + (d === config.defaultExpireDays ? ' selected="selected"' : '') +
      '>' + d + ' 天</option>';
  }).join('');
  return '<select name="expireDays" id="expireDays" class="ipt ipt-small">' + opts + '</select>';
}

// 表头：是否显示「提取码」列由开关决定
function tableHead() {
  var cols = ['<th>文件名</th>', '<th>大小</th>'];
  if (config.requireCode) cols.push('<th>提取码</th>');
  cols.push('<th>有效期至</th>', '<th>剩余</th>', '<th>下载</th>', '<th>操作</th>');
  return '<tr>' + cols.join('') + '</tr>';
}

function fileRows(files) {
  var colSpan = config.requireCode ? 7 : 6;
  if (!files.length) {
    return '<tr><td colspan="' + colSpan + '" class="empty">还没有文件，先在上面选一个文件上传吧。</td></tr>';
  }
  var rows = files.map(function (f) {
    var expired = util.isExpired(f);
    var link = sharePath(f);
    var cells = [
      '<td class="col-name"><span class="fname" title="' + util.esc(f.fileName) + '">' +
        util.esc(f.fileName) + '</span></td>',
      '<td class="col-size">' + util.fmtSize(f.size) + '</td>'
    ];
    if (config.requireCode) {
      cells.push('<td class="col-code"><span class="code">' + util.esc(f.code) + '</span></td>');
    }
    cells.push(
      '<td class="col-time">' + util.fmtTime(f.expiresAt) + '</td>',
      '<td class="col-left">' + (expired ? '<span class="bad">已过期</span>' : util.fmtLeft(f.expiresAt)) + '</td>',
      '<td class="col-dl">' + (f.downloads || 0) + '</td>',
      '<td class="col-op">'
    );
    if (expired) {
      cells.push('<span class="muted">不可下载</span>');
    } else {
      // 未开启提取码时，链接本身就是下载地址
      cells.push('<a class="btn btn-mini" href="' + util.esc(link) + '"' +
        (config.requireCode ? ' target="_blank"' : '') + '>' +
        (config.requireCode ? '打开' : '下载') + '</a>');
    }
    cells.push(
      '<a class="btn btn-mini" href="javascript:void(0)" onclick="copyLink(\'' + util.esc(link) + '\',\'' +
        util.esc(config.requireCode ? f.code : '') + '\')">复制链接</a>',
      '<a class="btn btn-mini btn-danger" href="javascript:void(0)" onclick="delFile(\'' + util.esc(f.id) +
        '\',\'' + util.esc(f.fileName) + '\')">删除</a>',
      '</td>'
    );
    return '<tr>' + cells.join('') + '</tr>';
  });
  return rows.join('\n');
}

function dashboardPage(user, files) {
  var codeHint = config.requireCode
    ? '分享时把「链接 + 提取码」一起发给对方'
    : '直接复制链接发给对方即可下载，无需提取码';

  var body = [
    topbar(user),
    '<div class="wrap">',

    '  <div class="card">',
    '    <h2 class="card-title">上传文件</h2>',
    '    <div class="upload-area">',
    '      <iframe id="upFrame" name="upFrame" class="hidden-frame" src="about:blank"></iframe>',
    '      <form id="upForm" method="post" action="/api/upload" enctype="multipart/form-data" target="upFrame">',
    '        <div class="field-inline">',
    '          <label>选择文件：</label>',
    '          <input type="file" id="fileInput" name="file" class="file" />',
    '        </div>',
    '        <div class="field-inline">',
    '          <label>有效期：</label>', expireSelect(),
    '          <span class="hint">到期后自动失效并清理</span>',
    '        </div>',
    '        <div class="field-inline">',
    '          <input type="submit" id="upBtn" class="btn btn-primary" value="上 传" />',
    '          <span id="upStatus" class="hint"></span>',
    '        </div>',
    '      </form>',
    '    </div>',
    '    <div id="upResult" class="up-result" style="display:none"></div>',
    '  </div>',

    '  <div class="card">',
    '    <h2 class="card-title">文件列表 <a class="btn btn-mini" href="javascript:void(0)" onclick="refreshList()">刷新</a></h2>',
    '    <table class="tb" id="fileTable" cellspacing="0" cellpadding="0">',
    '      <thead>', tableHead(), '</thead>',
    '      <tbody id="fileBody">',
    fileRows(files),
    '      </tbody>',
    '    </table>',
    '    <div class="tip">提示：' + util.esc(codeHint) + '。</div>',
    '  </div>',

    '</div>',
    '<script type="text/javascript" src="/static/app.js?v=' + JS_VERSION + '"></script>'
  ].join('\n');
  return layout(config.requireLogin ? '控制台 - IE 网盘' : 'IE 网盘', body);
}

// --------------------------------------------------------------------------
// 提取页 /s/<code>（仅开启提取码时使用）
// --------------------------------------------------------------------------
function extractPage(code, item, err) {
  var inner;
  if (item) {
    inner = [
      '<div class="card file-card">',
      '  <div class="file-icon">&#128196;</div>',
      '  <div class="file-name">' + util.esc(item.fileName) + '</div>',
      '  <table class="kv" cellspacing="0" cellpadding="0">',
      '    <tr><th>文件大小</th><td>' + util.fmtSize(item.size) + '</td></tr>',
      '    <tr><th>提取码</th><td><span class="code">' + util.esc(item.code) + '</span></td></tr>',
      '    <tr><th>有效期至</th><td>' + util.fmtTime(item.expiresAt) + '（剩余 ' + util.fmtLeft(item.expiresAt) + '）</td></tr>',
      '    <tr><th>上传时间</th><td>' + util.fmtTime(item.createdAt) + '</td></tr>',
      '    <tr><th>下载次数</th><td>' + (item.downloads || 0) + '</td></tr>',
      '  </table>',
      '  <div class="center">',
      '    <a class="btn btn-primary btn-lg" href="/download/' + util.esc(item.id) + '?code=' + util.esc(item.code) + '">下 载 文 件</a>',
      '  </div>',
      '</div>'
    ].join('\n');
  } else {
    var errHtml = err ? '<div class="alert alert-error">' + util.esc(err) + '</div>' : '';
    inner = [
      '<div class="card extract-card">',
      '  <h2 class="card-title">文件提取</h2>',
      '  <p class="extract-tip">请输入 6 位数字提取码</p>',
      errHtml,
      '  <form method="get" action="/s/" onsubmit="return checkCode(this)">',
      '    <input type="text" name="code" id="codeInput" class="ipt code-ipt" maxlength="6" value="' + util.esc(code || '') + '" />',
      '    <input type="submit" class="btn btn-primary" value="提 取" />',
      '  </form>',
      '</div>',
      '<script type="text/javascript">',
      'function checkCode(f){ var v=f.code.value.replace(/\\D/g,""); if(v.length!==6){ alert("请输入 6 位数字提取码"); return false; } f.code.value=v; return true; }',
      'document.getElementById("codeInput").focus();',
      '</script>'
    ].join('\n');
  }

  var body = [
    topbar(null),
    '<div class="wrap">',
    inner,
    '</div>'
  ].join('\n');
  return layout('文件提取 - IE 网盘', body);
}

function messagePage(title, text, extraHtml) {
  var body = [
    topbar(null),
    '<div class="wrap">',
    '  <div class="card center-card">',
    '    <h2 class="card-title">' + util.esc(title) + '</h2>',
    '    <p class="msg">' + util.esc(text) + '</p>',
    extraHtml || '',
    '    <p><a class="btn" href="/">返回首页</a></p>',
    '  </div>',
    '</div>'
  ].join('\n');
  return layout(title + ' - IE 网盘', body);
}

// 上传 iframe 内页面：通知父窗口后不做别的
function uploadResultPage(payload) {
  var json = JSON.stringify(payload)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
  var body = [
    '<div style="font:13px/1.6 Microsoft YaHei,Arial;padding:6px;color:' + (payload.ok ? '#137333' : '#c5221f') + '">',
    util.esc(payload.ok ? '上传完成' : (payload.error || '上传失败')),
    '</div>',
    '<script type="text/javascript">',
    '(function(){var d=' + json + ';try{if(window.parent&&window.parent.__uploadDone){window.parent.__uploadDone(d);}}catch(e){}})();',
    '</script>'
  ].join('\n');
  return layout('上传结果', body, {});
}

module.exports = {
  layout: layout,
  loginPage: loginPage,
  dashboardPage: dashboardPage,
  extractPage: extractPage,
  messagePage: messagePage,
  uploadResultPage: uploadResultPage,
  fileRows: fileRows,
  tableHead: tableHead,
  sharePath: sharePath
};