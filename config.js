'use strict';

// 统一配置：优先读环境变量（1Panel / Docker 里通过环境变量配置），否则用默认值。
var path = require('path');

function env(name, def) {
  var v = process.env[name];
  return (v === undefined || v === '') ? def : v;
}

// 布尔型环境变量：1/true/yes/on 为真，0/false/no/off 为假
function envBool(name, def) {
  var v = process.env[name];
  if (v === undefined || v === '') return def;
  v = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'y'].indexOf(v) !== -1) return true;
  if (['0', 'false', 'no', 'off', 'n'].indexOf(v) !== -1) return false;
  return def;
}

// 账号：默认 admin/admin123
//   ADMIN_USER / ADMIN_PASSWORD  单个管理员
//   USERS="zhang:123456,li:abcdef" 额外账号（逗号分隔，冒号分割用户名密码）
function buildUsers() {
  var users = {};
  var primary = env('ADMIN_USER', 'admin');
  users[primary] = env('ADMIN_PASSWORD', 'admin123');

  var extra = env('USERS', '');
  if (extra) {
    extra.split(',').forEach(function (pair) {
      var i = pair.indexOf(':');
      if (i > 0) {
        var u = pair.slice(0, i).trim();
        var p = pair.slice(i + 1).trim();
        if (u && p) users[u] = p;
      }
    });
  }
  return users;
}

// 可选有效期（天）
function buildExpireOptions() {
  var raw = env('EXPIRE_DAYS', '1,3,7,30');
  var list = String(raw).split(',').map(function (s) { return parseInt(s, 10); })
    .filter(function (n) { return !isNaN(n) && n > 0 && n <= 365; });
  return list.length ? list : [1, 3, 7, 30];
}

var expireOptions = buildExpireOptions();
var defaultExpireDays = parseInt(env('DEFAULT_EXPIRE_DAYS', '7'), 10);
if (expireOptions.indexOf(defaultExpireDays) === -1) defaultExpireDays = expireOptions[0];

module.exports = {
  // 监听端口 / 地址（容器里必须 0.0.0.0）
  port: Number(env('PORT', 3000)),
  host: env('HOST', '0.0.0.0'),
  // 数据目录：上传的文件 + 元数据都在这里，容器部署请挂载出来
  dataDir: path.resolve(env('DATA_DIR', path.join(__dirname, 'data'))),

  // ===== 可选功能开关（默认都是关闭，开箱即用直接上传/下载）=====
  // 是否需要登录后才能上传 / 删除文件。关闭时任何人打开首页即可上传。
  requireLogin: envBool('REQUIRE_LOGIN', false),
  // 是否要求提取码：开启后每个文件生成 6 位数字提取码，凭码才能下载。
  // 关闭时下载链接直接可用（/d/<id>），无需提取码。
  requireCode: envBool('REQUIRE_CODE', false),

  // 账号（仅在 requireLogin=true 时生效）
  users: buildUsers(),
  // 单个文件大小上限（字节），默认 500MB
  maxFileSize: Number(env('MAX_FILE_SIZE', 500 * 1024 * 1024)),
  // 提取码有效期可选值（天）
  expireOptions: expireOptions,
  defaultExpireDays: defaultExpireDays,
  // 下载尝试频率限制（每个 IP 的窗口内最大次数）
  rateLimit: {
    windowMs: Number(env('RATE_WINDOW_MS', 60000)),
    max: Number(env('RATE_MAX', 30))
  }
};