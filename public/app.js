/* IE 网盘前端脚本：全部 ES5 写法，不使用 JSON.parse 以外的新 API */
/* jshint esversion: 5 */
(function () {
  'use strict';

  // 老浏览器没有原生 JSON 时兜底（内容来自本站接口，风险可控）
  function parseJson(text) {
    if (window.JSON && window.JSON.parse) {
      return window.JSON.parse(text);
    }
    /* jshint evil: true */
    return eval('(' + text + ')');
  }

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function $(id) {
    return document.getElementById(id);
  }

  // 统一封装 XMLHttpRequest（IE8/IE9 用 XDomainRequest 的老写法这里用不到，同源即可）
  function xhr(method, url, body, cb) {
    var req;
    try {
      req = window.XMLHttpRequest ? new XMLHttpRequest() : new ActiveXObject('Microsoft.XMLHTTP');
    } catch (e) {
      return cb(new Error('浏览器不支持 Ajax'));
    }
    req.onreadystatechange = function () {
      if (req.readyState !== 4) return;
      if (req.status >= 200 && req.status < 300) {
        cb(null, req.responseText);
      } else {
        cb(new Error('请求失败(' + req.status + ')'));
      }
    };
    try {
      req.open(method, url, true);
      if (method === 'POST') {
        req.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
      }
      req.send(body || null);
    } catch (e2) {
      cb(e2);
    }
  }

  function absUrl(p) {
    return window.location.protocol + '//' + window.location.host + p;
  }

  // 复制到剪贴板：优先用 IE 的 clipboardData，其次 execCommand，最后 prompt
  function copyText(text) {
    if (window.clipboardData && window.clipboardData.setData) {
      try {
        if (window.clipboardData.setData('Text', text)) return true;
      } catch (e) { /* 继续尝试其他方式 */ }
    }
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'absolute';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try {
      ok = document.execCommand('copy');
    } catch (e2) {
      ok = false;
    }
    try { document.body.removeChild(ta); } catch (e3) { /* ignore */ }
    return ok;
  }

  // ------------------------------------------------------------------
  // 复制分享链接
  // ------------------------------------------------------------------
  window.copyLink = function (path, code) {
    var text = '下载地址：' + absUrl(path);
    if (code) text += '\n提取码：' + code;
    if (copyText(text)) {
      alert('已复制到剪贴板：\n\n' + text);
    } else {
      window.prompt('请手动复制下面的下载信息：', text);
    }
  };

  // 由服务端注入的开关（见 lib/view.js）
  var OPTS = window.APP_OPTS || { requireLogin: false, requireCode: false };

  // ------------------------------------------------------------------
  // 刷新文件列表
  // ------------------------------------------------------------------
  function renderRows(files) {
    var colSpan = OPTS.requireCode ? 7 : 6;
    if (!files || !files.length) {
      return '<tr><td colspan="' + colSpan + '" class="empty">还没有文件，先在上面选一个文件上传吧。</td></tr>';
    }
    var html = [];
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      html.push('<tr>');
      html.push('<td class="col-name"><span class="fname" title="' + esc(f.fileName) + '">' + esc(f.fileName) + '</span></td>');
      html.push('<td class="col-size">' + esc(f.sizeText) + '</td>');
      if (OPTS.requireCode) {
        html.push('<td class="col-code"><span class="code">' + esc(f.code) + '</span></td>');
      }
      html.push('<td class="col-time">' + esc(f.expiresAt) + '</td>');
      html.push('<td class="col-left">' + (f.expired ? '<span class="bad">已过期</span>' : esc(f.leftText)) + '</td>');
      html.push('<td class="col-dl">' + f.downloads + '</td>');
      html.push('<td class="col-op">');
      if (f.expired) {
        html.push('<span class="muted">不可下载</span>');
      } else if (OPTS.requireCode) {
        html.push('<a class="btn btn-mini" href="' + esc(f.url) + '" target="_blank">打开</a>');
      } else {
        html.push('<a class="btn btn-mini" href="' + esc(f.url) + '">下载</a>');
      }
      html.push('<a class="btn btn-mini" href="javascript:void(0)" onclick="copyLink(\'' + esc(f.url) + '\',\'' + esc(OPTS.requireCode ? f.code : '') + '\')">复制链接</a>');
      html.push('<a class="btn btn-mini btn-danger" href="javascript:void(0)" onclick="delFile(\'' + esc(f.id) + '\',\'' + esc(f.fileName) + '\')">删除</a>');
      html.push('</td>');
      html.push('</tr>');
    }
    return html.join('');
  }

  window.refreshList = function () {
    var tbody = $('fileBody');
    if (!tbody) return;
    xhr('GET', '/api/files?t=' + new Date().getTime(), null, function (err, text) {
      if (err) return;
      var data;
      try { data = parseJson(text); } catch (e) { return; }
      if (!data || !data.ok) return;
      tbody.innerHTML = renderRows(data.files);
    });
  };

  // ------------------------------------------------------------------
  // 删除文件
  // ------------------------------------------------------------------
  window.delFile = function (id, name) {
    if (!window.confirm('确定删除文件「' + name + '」吗？\n删除后提取码立即失效，且不可恢复。')) return;
    xhr('POST', '/api/delete', 'id=' + encodeURIComponent(id), function (err, text) {
      if (err) { alert('删除失败：' + err.message); return; }
      var data;
      try { data = parseJson(text); } catch (e) { data = null; }
      if (data && data.ok) window.refreshList();
      else alert('删除失败：' + ((data && data.error) || '未知错误'));
    });
  };

  // ------------------------------------------------------------------
  // 上传：表单提交到隐藏 iframe，避免页面刷新（IE8 也支持）
  // ------------------------------------------------------------------
  function showResult(file) {
    var box = $('upResult');
    if (!box) return;
    var html = '上传成功：<b>' + esc(file.fileName) + '</b>（' + esc(file.sizeText) + '，有效期 ' + file.expireDays + ' 天，至 ' + esc(file.expiresAt) + '）<br />';
    if (file.hasCode) {
      html += '提取码：<span class="code">' + esc(file.code) + '</span><br />';
    }
    html += '下载地址：<a class="url" href="' + esc(file.url) + '">' + esc(absUrl(file.url)) + '</a> ' +
      '<a class="btn btn-mini" href="javascript:void(0)" onclick="copyLink(\'' + esc(file.url) + '\',\'' +
      esc(file.hasCode ? file.code : '') + '\')">复制链接' + (file.hasCode ? '+提取码' : '') + '</a>';
    box.style.display = 'block';
    box.innerHTML = html;
  }

  // 供 iframe 内的页面回调
  window.__uploadDone = function (payload) {
    var btn = $('upBtn');
    var status = $('upStatus');
    if (btn) { btn.disabled = false; btn.value = '上 传'; }
    if (status) status.innerHTML = '';
    if (payload && payload.ok && payload.file) {
      showResult(payload.file);
      var form = $('upForm');
      if (form && form.reset) form.reset();
      window.refreshList();
    } else {
      alert('上传失败：' + ((payload && payload.error) || '未知错误'));
    }
  };

  function bindUpload() {
    var form = $('upForm');
    if (!form) return;
    form.onsubmit = function () {
      var input = $('fileInput');
      if (!input || !input.value) {
        alert('请先选择要上传的文件');
        return false;
      }
      var btn = $('upBtn');
      var status = $('upStatus');
      if (btn) { btn.disabled = true; btn.value = '上传中...'; }
      if (status) status.innerHTML = '正在上传，请勿关闭页面...';
      var box = $('upResult');
      if (box) box.style.display = 'none';
      return true; // 交给隐藏 iframe 提交
    };
  }

  // 页面加载完成后绑定
  if (window.attachEvent) {
    window.attachEvent('onload', bindUpload);
  } else {
    window.onload = bindUpload;
  }
})();