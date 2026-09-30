'use strict';

var crypto = require('crypto');
var path = require('path');

function sha256(str) {
  return crypto.createHash('sha256').update(String(str), 'utf8').digest('hex');
}

// 生成 6 位纯数字提取码（100000 - 999999），用 crypto 保证随机性
function newCode() {
  var n = crypto.randomBytes(4).readUInt32BE(0) % 900000;
  return String(100000 + n);
}

function isCode(code) {
  return /^[0-9]{6}$/.test(String(code || ''));
}

function fmtSize(bytes) {
  bytes = Number(bytes) || 0;
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(2) + ' MB';
  return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

function fmtTime(ms) {
  var d = new Date(Number(ms) || 0);
  function p(n) { return n < 10 ? '0' + n : String(n); }
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
    ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

function fmtLeft(expiresAt) {
  var left = Number(expiresAt) - Date.now();
  if (left <= 0) return '已过期';
  var h = Math.floor(left / 3600000);
  if (h >= 24) return Math.floor(h / 24) + ' 天 ' + (h % 24) + ' 小时';
  if (h >= 1) return h + ' 小时';
  return Math.max(1, Math.floor(left / 60000)) + ' 分钟';
}

function isExpired(item) {
  return !item || !item.expiresAt || Number(item.expiresAt) <= Date.now();
}

// 防止路径穿越
function safeJoin(root, name) {
  var base = path.resolve(root);
  var full = path.resolve(base, String(name));
  if (full !== base && full.indexOf(base + path.sep) === 0) return full;
  return null;
}

// 转义 HTML（服务端渲染所有动态内容都用它）
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// 记录下载次数（简单的读改写，单进程够用）
function noop() {}

module.exports = {
  sha256: sha256,
  newCode: newCode,
  isCode: isCode,
  fmtSize: fmtSize,
  fmtTime: fmtTime,
  fmtLeft: fmtLeft,
  isExpired: isExpired,
  safeJoin: safeJoin,
  esc: esc,
  noop: noop
};