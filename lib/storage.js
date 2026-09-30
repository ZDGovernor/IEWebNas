'use strict';

var fs = require('fs');
var path = require('path');
var config = require('../config');
var util = require('./util');

var UPLOAD_DIR = path.join(config.dataDir, 'uploads');
var DB_FILE = path.join(config.dataDir, 'files.json');
var TMP_DIR = path.join(config.dataDir, 'tmp');

function ensureDirs() {
  [config.dataDir, UPLOAD_DIR, TMP_DIR].forEach(function (d) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  });
}

function readAll() {
  ensureDirs();
  try {
    var raw = fs.readFileSync(DB_FILE, 'utf8');
    // 容忍手工编辑时写入的 UTF-8 BOM
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    var list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch (e) {
    return [];
  }
}

function writeAll(list) {
  ensureDirs();
  var tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf8');
  fs.renameSync(tmp, DB_FILE);
}

function add(rec) {
  var list = readAll();
  list.push(rec);
  writeAll(list);
  return rec;
}

function get(id) {
  var list = readAll();
  for (var i = 0; i < list.length; i++) {
    if (list[i].id === id) return list[i];
  }
  return null;
}

// 只返回未过期且提取码匹配的记录
function getByCode(code) {
  var list = readAll();
  for (var i = 0; i < list.length; i++) {
    var it = list[i];
    if (it.code === code && !util.isExpired(it)) return it;
  }
  return null;
}

function existsCode(code) {
  var list = readAll();
  for (var i = 0; i < list.length; i++) {
    if (list[i].code === code && !util.isExpired(list[i])) return true;
  }
  return false;
}

// 生成一个没被占用的 6 位数字提取码
function uniqueCode() {
  for (var i = 0; i < 200; i++) {
    var c = util.newCode();
    if (!existsCode(c)) return c;
  }
  return util.newCode();
}

function remove(id) {
  var list = readAll();
  var out = [];
  var removed = null;
  for (var i = 0; i < list.length; i++) {
    if (list[i].id === id) removed = list[i];
    else out.push(list[i]);
  }
  if (removed) {
    writeAll(out);
    try { fs.unlinkSync(removed.path); } catch (e) { /* 文件可能已被清理 */ }
  }
  return removed;
}

function incDownload(id) {
  var list = readAll();
  for (var i = 0; i < list.length; i++) {
    if (list[i].id === id) {
      list[i].downloads = (list[i].downloads || 0) + 1;
      list[i].lastDownloadAt = Date.now();
      writeAll(list);
      return list[i];
    }
  }
  return null;
}

// 删除所有已过期记录及其文件
function cleanExpired() {
  var list = readAll();
  var keep = [];
  var n = 0;
  for (var i = 0; i < list.length; i++) {
    if (util.isExpired(list[i])) {
      n++;
      try { fs.unlinkSync(list[i].path); } catch (e) { /* ignore */ }
    } else {
      keep.push(list[i]);
    }
  }
  if (n) writeAll(keep);
  return n;
}

module.exports = {
  uploadDir: UPLOAD_DIR,
  tmpDir: TMP_DIR,
  dbFile: DB_FILE,
  ensureDirs: ensureDirs,
  list: readAll,
  add: add,
  get: get,
  getByCode: getByCode,
  uniqueCode: uniqueCode,
  remove: remove,
  incDownload: incDownload,
  cleanExpired: cleanExpired
};