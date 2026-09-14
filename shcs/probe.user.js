// ==UserScript==
// @name         SHCS 东文广 接口记录器（上海文化广场）
// @namespace    shcs-probe
// @version      1.0.0
// @description  上海文化广场选座页的接口是登录后才可见的。这个脚本把页面自己的接口调用（op/参数/返回）和页面结构记录下来，复制发出来就能据此写抢票脚本。
// @match        https://www.shcstheatre.com/*
// @match        https://m.shcstheatre.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==
(function () {
  'use strict';
  if (window.__SHCS_PROBE__) return;
  window.__SHCS_PROBE__ = true;

  var LOG = [];
  var MAX = 120;
  var recording = true;

  function nowStr() { var d = new Date(); return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2) + ':' + ('0' + d.getSeconds()).slice(-2); }
  function clip(s, n) { s = String(s == null ? '' : s); return s.length > n ? (s.slice(0, n) + '…(截断)') : s; }

  function push(rec) {
    if (!recording) return;
    LOG.push(rec);
    if (LOG.length > MAX) LOG.shift();
    render();
  }

  // ---------- 拦截 XMLHttpRequest（jQuery 的 $.ajax 也走这里） ----------
  var XO = XMLHttpRequest.prototype.open, XS = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) { this.__m = m; this.__u = u; return XO.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function (body) {
    var self = this, t0 = Date.now();
    this.addEventListener('load', function () {
      var txt = '';
      try { txt = self.responseText || ''; } catch (e) {}
      push({
        kind: 'xhr', time: nowStr(), ms: Date.now() - t0,
        method: self.__m, url: String(self.__u || ''),
        params: clip(body, 1500), status: self.status, resp: clip(txt, 4000),
      });
    });
    return XS.apply(this, arguments);
  };

  // ---------- 拦截 fetch ----------
  var of = window.fetch;
  if (of) {
    window.fetch = function (input, init) {
      var url = (typeof input === 'string') ? input : (input && input.url);
      var self = this, t0 = Date.now();
      return of.apply(self, arguments).then(function (res) {
        try {
          res.clone().text().then(function (txt) {
            push({
              kind: 'fetch', time: nowStr(), ms: Date.now() - t0,
              method: (init && init.method) || (input && input.method) || 'GET', url: String(url || ''),
              params: clip(init && init.body, 1500), status: res.status, resp: clip(txt, 4000),
            });
          });
        } catch (e) {}
        return res;
      });
    };
  }

  // ---------- 页面结构快照（找座位元素/按钮用） ----------
  function domSnapshot() {
    var out = { url: location.href, title: document.title, counts: {}, buttons: [], seatish: [], checkboxes: [] };
    var btns = document.querySelectorAll('button, a, li[onclick], div[onclick], span[onclick], input[type=button], input[type=submit]');
    out.counts.buttons = btns.length;
    var seen = {};
    Array.prototype.forEach.call(btns, function (el, i) {
      if (i > 400) return;
      var txt = (el.textContent || el.value || '').trim().replace(/\s+/g, ' ').slice(0, 24);
      var oc = el.getAttribute('onclick') || '';
      var key = txt + '|' + oc.slice(0, 40);
      if (!txt && !oc) return;
      if (seen[key]) return;
      seen[key] = 1;
      out.buttons.push((el.tagName + '.' + String(el.className || '').split(' ')[0]) + ' | ' + txt + (oc ? (' | onclick=' + oc.slice(0, 60)) : ''));
    });
    out.counts.buttonsUniq = out.buttons.length;

    var cand = document.querySelectorAll('[seatid],[seat_id],[data-seat],[seatno],[data-id],[id^=seat],[class*=seat],[class*=Seat]');
    out.counts.seatish = cand.length;
    var seen2 = {};
    Array.prototype.forEach.call(cand, function (el) {
      if (out.seatish.length > 40) return;
      var key = el.tagName + '.' + String(el.className || '').slice(0, 30);
      if (seen2[key]) return;
      seen2[key] = 1;
      var attrs = [];
      for (var i = 0; i < el.attributes.length && i < 10; i++) attrs.push(el.attributes[i].name + '=' + String(el.attributes[i].value).slice(0, 24));
      out.seatish.push({ tag: el.tagName, cls: String(el.className || '').slice(0, 40), attrs: attrs, text: (el.textContent || '').trim().slice(0, 16) });
    });
    out.counts.img = document.images.length;
    out.counts.canvas = document.querySelectorAll('canvas').length;
    return out;
  }

  // ---------- 面板 ----------
  function btn(label, color, onClick) {
    var b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = 'margin:2px;padding:5px 9px;border:0;border-radius:6px;color:#fff;cursor:pointer;font-size:12px;background:' + color;
    b.onclick = onClick;
    return b;
  }
  var statusEl = null;
  function render() {
    if (!statusEl) return;
    var ops = {};
    LOG.forEach(function (r) {
      var m = String(r.url).match(/[?&]op=([A-Za-z_]+)/);
      if (m) ops[m[1]] = (ops[m[1]] || 0) + 1;
    });
    statusEl.textContent = '已记录 ' + LOG.length + ' 条' + (recording ? '（记录中）' : '（已暂停）')
      + (Object.keys(ops).length ? ' · 接口: ' + Object.keys(ops).slice(0, 6).join(',') : '');
  }
  function showText(title, text) {
    var old = document.getElementById('shcs-probe-box');
    if (old && old.parentNode) old.parentNode.removeChild(old);
    var wrap = document.createElement('div');
    wrap.id = 'shcs-probe-box';
    wrap.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;width:560px;max-width:94vw;background:#101a24;color:#e6e6e6;border-radius:10px;padding:10px 12px;box-shadow:0 6px 24px rgba(0,0,0,.55);font-family:system-ui,Arial;';
    var h = document.createElement('div');
    h.textContent = title;
    h.style.cssText = 'font-weight:700;font-size:13px;margin-bottom:6px;';
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'width:100%;height:300px;box-sizing:border-box;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;line-height:1.4;background:#0b1219;color:#cfe;border:1px solid #2a3a4a;border-radius:6px;padding:6px;';
    ta.onclick = function () { ta.select(); };
    var bar = document.createElement('div');
    var copy = btn('复制全部', '#48c', function () {
      ta.focus(); ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) {}
      if (!ok && navigator.clipboard) navigator.clipboard.writeText(ta.value).catch(function () {});
      copy.textContent = '已复制 ✓（不行就 Ctrl/Cmd+C）';
      setTimeout(function () { copy.textContent = '复制全部'; }, 2500);
    });
    var close = btn('关闭', '#556', function () { if (wrap.parentNode) wrap.parentNode.removeChild(wrap); });
    bar.appendChild(copy); bar.appendChild(close);
    wrap.appendChild(h); wrap.appendChild(ta); wrap.appendChild(bar);
    document.body.appendChild(wrap);
    ta.focus(); ta.select();
  }
  function payload(extra) {
    return JSON.stringify({
      when: new Date().toISOString(), url: location.href,
      ua: navigator.userAgent, extra: extra || null,
      log: LOG,
    }, null, 1);
  }

  function mount() {
    if (window.__SHCS_PROBE_PANEL__) return;
    var box = document.createElement('div');
    box.style.cssText = 'position:fixed;left:16px;bottom:16px;z-index:2147483647;background:#2a2118;color:#e6e6e6;font-family:system-ui,Arial;box-shadow:0 6px 24px rgba(0,0,0,.4);border-radius:10px;padding:10px 12px;width:250px;';
    var t = document.createElement('div');
    t.textContent = 'SHCS 接口记录器';
    t.style.cssText = 'font-weight:700;font-size:13px;margin-bottom:6px;';
    var info = document.createElement('div');
    info.style.cssText = 'font-size:11px;color:#c9b79a;margin-bottom:8px;line-height:1.5;';
    info.innerHTML = '用法：在<b>选座页</b>录一遍——选几个座位 → 下一步/加入购物车（不要付款）→ 点“复制全部”把内容发我。';
    var w = document.createElement('div');
    w.appendChild(btn(recording ? '暂停记录' : '开始记录', '#8a6', function (e) { recording = !recording; e.target.textContent = recording ? '暂停记录' : '开始记录'; render(); }));
    w.appendChild(btn('抓页面结构', '#48c', function () { showText('页面结构（连着上面的日志一起发我）', payload(domSnapshot())); }));
    w.appendChild(btn('复制全部', '#e5533c', function () { showText('接口日志（复制发我）', payload(null)); }));
    w.appendChild(btn('清空', '#556', function () { LOG = []; render(); }));
    statusEl = document.createElement('div');
    statusEl.style.cssText = 'font-size:11px;color:#8cf;margin-top:8px;min-height:14px;';
    box.appendChild(t); box.appendChild(info); box.appendChild(w); box.appendChild(statusEl);
    document.body.appendChild(box);
    window.__SHCS_PROBE_PANEL__ = box;
    render();
  }

  if (document.body) mount(); else window.addEventListener('DOMContentLoaded', mount);
  console.log('%c[SHCS-PROBE] 接口记录器已加载', 'color:#fff;background:#a86;padding:2px 6px;border-radius:4px;');
})();
