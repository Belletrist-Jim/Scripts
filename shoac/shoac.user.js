// ==UserScript==
// @name         SOAC 上海东方艺术中心 自动抢座
// @namespace    shoac-seat
// @version      1.0.1789383512
// @description  上海东方艺术中心在线购票：选座页悬浮面板 + 快捷键(Alt+Shift+P 预演 / R 抢座 / I 库存 / S 全场扫描 / T 自检) + 可选 autoRun + 详情页开票监控。改 config.yaml 后重新 ./build.sh build，再到油猴“检查更新”。
// @author       -
// @match        https://www.shoac.com.cn/*
// @run-at       document-idle
// @downloadURL  http://127.0.0.1:8772/shoac.user.js
// @updateURL    http://127.0.0.1:8772/shoac.user.js
// @grant        none
// ==/UserScript==

/* 由 build.mjs 从 config.yaml 生成于 2026-09-14T10:58:32.803Z，请勿手改；改配置请改 config.yaml 后重新 ./build.sh build */
window.__SOAC_CONFIG__ = {
  "productId": "",
  "showId": "",
  "sectionId": "",
  "dryRun": false,
  "autoRun": true,
  "submitOrder": true,
  "maxRetry": 4,
  "mode": "auto",
  "jumpToOrder": true,
  "autoSwitchSection": true,
  "rowPreference": "middle",
  "rules": [
    {
      "price": 480,
      "qty": 2,
      "areas": []
    },
    {
      "price": 380,
      "qty": 2,
      "areas": []
    },
    {
      "price": 280,
      "qty": 1,
      "areas": []
    }
  ],
  "watch": {
    "enabled": false,
    "showId": "",
    "date": "",
    "time": "",
    "startAt": "",
    "pollMs": 1500
  }
};

/* ============================================================
 * 上海东方艺术中心(shoac.com.cn) · 选座页自动抢座引擎
 * ------------------------------------------------------------
 * 真正装到浏览器的是 build.mjs 生成的 shoac.user.js（脚本头 + config.yaml 注入的配置 + 本文件）。
 *
 * 运行位置：登录后进入某场次的“在线选座”页
 *   https://www.shoac.com.cn/#/selectPurchase/selectSeat?productId=..&showId=..&sectionId=..
 *
 * 说明：东方艺术中心用的是保利(polyt)票务中台，接口都在 /platform-backend 下。
 * 下面这些是我从官网前端代码里逐个核出来的（不是猜的），其中标 ★ 的还用真实数据在线验证过：
 *   ★ POST /good/search-products                 演出列表
 *   ★ GET  /good/project/detail/{productId}       演出详情
 *   ★ GET  /good/shows/{productId}                场次列表(含 site 是否选座票、status 售票状态)
 *   ★ GET  /good/show/price/{showId}              票价(priceDtos)
 *   ★ GET  /good/show/section/{showId}            分区(showSectionDtos，含座位图 CDN 地址)
 *   ★ GET  /good/seats/{productId}/{showId}/{sectionId}/available   可售位图(0/1 数组)
 *   ★ GET  /good/seats/{showId}/{sectionId}/all    分区全部座位(座位图 CDN 取不到时的兜底)
 *   ★ GET  /good/project/captcha/{productId}       这场是否需要滑块验证
 *     POST /order/lock-seat-choose                选座锁座 → 返回 uuid（座位先被占住）
 *     POST /order/lock-seat-now                   非选座票“立即购买”锁定
 *     GET  /order/advance/{uuid}                  预订单信息
 *     DELETE /order/lock-seat/{uuid}              释放锁座
 *
 * 关键点：**锁座(lock-seat-choose)只是把座位占住**，之后还要在“提交订单”页确认下单、再去付款。
 * 另外官网的“提交订单”页地址里**不带订单号**（uuid 只存在路由内存里），
 * 所以脚本锁座成功后要调用页面自己的 router 跳过去（用 __vue__，Vue 2 一定会挂）。
 *
 * 常用命令（选座页控制台）：
 *   SOAC.diag()      自检：路由/场次/价位/分区/余票/是否需要验证码（只读）
 *   SOAC.inventory() 当前分区：各价位各区域实时余票
 *   SOAC.scan()      全场扫描：本场所有分区各价位余票（找哪个分区有票）
 *   SOAC.plan()      预演：按 rules 推算会挑到哪些座位（不下单）
 *   SOAC.run()       执行：按 rules 挑座并锁座（需要滑块时会自动改成网页点选，你滑一下）
 *   SOAC.release()   释放锁座（把当前还没下单的锁座放掉）
 * ============================================================ */
(function () {
  'use strict';

  if (typeof window === 'undefined') return;
  if (window.__SOAC_ENGINE__) { console.warn('[SOAC] 已加载，跳过重复注入。'); return; }
  window.__SOAC_ENGINE__ = true;

  var DEFAULT_CONFIG = {
    dryRun: false, autoRun: false, submitOrder: true, maxRetry: 4, mode: 'auto',
    jumpToOrder: true, autoSwitchSection: true, rowPreference: 'middle', rules: [], watch: {},
  };
  var CONFIG = window.__SOAC_CONFIG__ ? window.__SOAC_CONFIG__ : DEFAULT_CONFIG;
  if (!CONFIG.watch) CONFIG.watch = {};

  var BASE = '/platform-backend';
  var THEATER = '1323';
  var LOCATION = '121.458563,31.250315';   // 官网前端里写死的
  var API = {
    project: '/good/project/detail/',
    projectOld: '/good/project/detail/old/',
    shows: '/good/shows/',
    price: '/good/show/price/',
    section: '/good/show/section/',
    captcha: '/good/project/captcha/',
    seatsAll: function (showId, sectionId) { return '/good/seats/' + showId + '/' + sectionId + '/all'; },
    avail: function (pid, showId, sectionId) { return '/good/seats/' + pid + '/' + showId + '/' + sectionId + '/available'; },
    lockChoose: '/order/lock-seat-choose',
    lockNow: '/order/lock-seat-now',
    advance: '/order/advance/',
    lockDelete: '/order/lock-seat/',
  };

  // ---------------------------------------------------------------
  // 小工具
  // ---------------------------------------------------------------
  function log() { console.log.apply(console, ['%c[SOAC]', 'color:#0a0;font-weight:bold'].concat([].slice.call(arguments))); }
  function warn() { console.warn.apply(console, ['[SOAC]'].concat([].slice.call(arguments))); }
  function err() { console.error.apply(console, ['[SOAC]'].concat([].slice.call(arguments))); }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function ts() { var d = new Date(); return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function median(arr) {
    if (!arr || !arr.length) return 0;
    var a = arr.slice().sort(function (x, y) { return x - y; });
    var m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }
  function asArray(d, keys) {
    if (Array.isArray(d)) return d;
    if (!d || typeof d !== 'object') return [];
    var i;
    for (i = 0; i < keys.length; i++) if (keys[i] && Array.isArray(d[keys[i]])) return d[keys[i]];
    var vals = Object.keys(d).map(function (k) { return d[k]; });
    for (i = 0; i < vals.length; i++) if (Array.isArray(vals[i])) return vals[i];
    return [];
  }
  function isOk(j) { return !!(j && (j.success === true || String(j.code) === '200')); }
  function errMsg(j) {
    if (!j) return '无响应';
    return j.errors || (j.ext && (j.ext.message || j.ext.msg)) || j.state || j.message || '未知错误';
  }
  // 座位描述形如 “1楼乐池特2排21座” / “D区6排47座”
  function parseDesc(desc) {
    var s = String(desc || '').trim();
    var m = s.match(/^(.*?)(\d+)\s*排\s*(\d+)\s*座/);
    if (m) return { area: m[1].replace(/\s+$/, ''), row: Number(m[2]), col: Number(m[3]) };
    return { area: s, row: null, col: null };
  }

  var PAY_KEY = 'soac.pendingLock';
  function savePending(o) { try { localStorage.setItem(PAY_KEY, JSON.stringify(o)); } catch (e) {} }
  function readPending() { try { var s = localStorage.getItem(PAY_KEY); return s ? JSON.parse(s) : null; } catch (e) { return null; } }
  function clearPending() { try { localStorage.removeItem(PAY_KEY); } catch (e) {} }
  function setAutoRunOnce(v) { try { sessionStorage.setItem('soac.autoRunOnce', v ? '1' : ''); } catch (e) {} }
  function takeAutoRunOnce() {
    try {
      var v = sessionStorage.getItem('soac.autoRunOnce');
      if (v) { sessionStorage.removeItem('soac.autoRunOnce'); return true; }
    } catch (e) {}
    return false;
  }

  // ---------------------------------------------------------------
  // 登录态 / 请求头
  // ---------------------------------------------------------------
  function token() {
    try {
      var raw = localStorage.getItem('vuex');
      if (raw) {
        var j = JSON.parse(raw);
        var t = j && j.app && (j.app.accessToken || j.app.token);
        if (t) return t;
      }
    } catch (e) {}
    try {
      for (var k in localStorage) {
        if (!Object.prototype.hasOwnProperty.call(localStorage, k)) continue;
        var v = localStorage.getItem(k);
        if (!v) continue;
        var m = v.match(/"accessToken"\s*:\s*"([^"]{8,})"/);
        if (m) return m[1];
      }
    } catch (e) {}
    return '';
  }
  function headers(json) {
    return {
      'Channel': 'theatre_pc',
      'Location': LOCATION,
      'Theater': THEATER,
      'Flagship-Store': 'true',
      'Authorization': token(),
      'Accept': 'application/json, text/plain, */*',
      ...(json ? { 'Content-Type': 'application/json;charset=UTF-8' } : {}),
    };
  }
  async function http(path, opts) {
    opts = opts || {};
    // 座位图放在 CDN 上（跨域），只能用“不带自定义头”的普通请求，否则会触发预检被拒
    if (path.indexOf('http') === 0) {
      var cdnRes = await fetch(path, { credentials: 'omit' });
      return parseBody(await cdnRes.text(), cdnRes.status);
    }
    var url = BASE + path;
    if (opts.query) {
      var qs = new URLSearchParams();
      Object.keys(opts.query).forEach(function (k) {
        if (opts.query[k] !== undefined && opts.query[k] !== null) qs.append(k, String(opts.query[k]));
      });
      var s = qs.toString();
      if (s) url += (url.indexOf('?') > -1 ? '&' : '?') + s;
    }
    var init = { method: opts.method || 'GET', headers: headers(opts.body !== undefined), credentials: 'same-origin' };
    if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
    var res = await fetch(url, init);
    var text = await res.text();
    var j = parseBody(text, res.status);
    if (res.status === 401 || res.status === 403) {
      var e1 = new Error('未登录或登录已过期（HTTP ' + res.status + '）——请先在官网登录再回到这个页面');
      e1.needLogin = true;
      throw e1;
    }
    if (!isOk(j) && String(j.code) === '0001') {
      var e2 = new Error('接口说“没有登录”（code 0001），请先登录官网');
      e2.needLogin = true;
      throw e2;
    }
    return j;
  }
  function parseBody(text, status) {
    try { return JSON.parse(text); } catch (e) {
      if (/^[a-zA-Z0-9_$]+\(/.test(text)) {
        // 座位图文件是 JSONP 包一层
        return JSON.parse(text.replace(/^[^(]*\(/, '').replace(/\)\s*;?\s*$/, ''));
      }
      throw new Error('接口没返回 JSON（HTTP ' + status + '）：' + String(text).slice(0, 120));
    }
  }

  // ---------------------------------------------------------------
  // 路由
  // ---------------------------------------------------------------
  function route() {
    var hash = String(location.hash || '');
    var q = {};
    var qi = hash.indexOf('?');
    var grab = function (s) { if (s) new URLSearchParams(s).forEach(function (v, k) { if (q[k] == null || q[k] === '') q[k] = v; }); };
    grab(qi > -1 ? hash.slice(qi + 1) : '');
    grab(String(location.search || '').replace(/^\?/, ''));
    return {
      onSeatPage: /\/selectPurchase\/selectSeat/.test(hash),
      onAreaPage: /\/selectPurchase\/selectArea/.test(hash),
      onDetail: /\/detail(?:[?#]|$)/.test(hash),
      onOrder: /\/order\/orderDetail/.test(hash),
      productId: String(q.productId || ''),
      projectId: String(q.projectId || ''),
      showId: String(q.showId || ''),
      sectionId: String(q.sectionId || ''),
    };
  }

  // ---------------------------------------------------------------
  // 状态
  // ---------------------------------------------------------------
  var STATE = {
    ok: false, productId: '', showId: '', sectionId: '',
    project: null, show: null, showList: [],
    priceList: [], priceById: {},
    sections: [], sectionDto: null,
    free: [],            // [{sid,desc,area,row,col,priceId,price,remark}]
    seatTotal: 0,
    needCaptcha: false,
    lastError: '',
  };
  function resetState() {
    STATE.ok = false; STATE.project = null; STATE.show = null; STATE.showList = [];
    STATE.priceList = []; STATE.priceById = {}; STATE.sections = []; STATE.sectionDto = null;
    STATE.free = []; STATE.seatTotal = 0; STATE.needCaptcha = false; STATE.lastError = '';
  }

  // ---------------------------------------------------------------
  // 读数据
  // ---------------------------------------------------------------
  function num(v) { var n = Number(v); return isFinite(n) ? n : null; }
  function findShow(list, showId) {
    if (!showId) return null;
    return list.filter(function (s) { return String(s.showId) === String(showId); })[0] || null;
  }

  async function loadBasic() {
    var r = route();
    var pid = r.productId;
    if (!pid && r.projectId) {
      var old = await http(API.projectOld + r.projectId);
      if (isOk(old) && old.data) pid = String(old.data.productId || (old.data.product && old.data.product.productId) || '');
    }
    if (!pid) throw new Error('URL 里没有 productId，请在“选座页”或“演出详情页”运行');
    STATE.productId = pid;
    STATE.showId = r.showId;
    STATE.sectionId = r.sectionId;

    var proj = await http(API.project + pid);
    if (isOk(proj)) STATE.project = proj.data;

    var shows = await http(API.shows + pid);
    STATE.showList = asArray(shows && shows.data, ['showInfoDetailList', 'showList', '']);
    STATE.show = findShow(STATE.showList, r.showId) || STATE.showList[0] || null;
    if (STATE.show && !STATE.showId) STATE.showId = String(STATE.show.showId);
    if (STATE.show && !STATE.sectionId && STATE.show.sectionId) STATE.sectionId = String(STATE.show.sectionId);

    // 是否需要滑块
    try {
      var cap = await http(API.captcha + pid);
      STATE.needCaptcha = !!(cap && isOk(cap) && cap.data);
    } catch (e) { STATE.needCaptcha = false; }
  }

  async function loadPrices() {
    var res = await http(API.price + STATE.showId);
    if (!isOk(res)) throw new Error('取票价失败：' + errMsg(res));
    var d = res.data || {};
    STATE.priceList = asArray(d.priceDtos || d, ['priceDtos', '']);
    STATE.priceById = {};
    STATE.priceList.forEach(function (p) {
      var id = p.ticketPriceId != null ? p.ticketPriceId : p.priceId;
      if (id == null) return;
      STATE.priceById[String(id)] = { id: String(id), price: Number(p.price), color: p.ticketPriceColor || '', grade: p.priceGrade || '', raw: p };
    });
    if (d.captcha) STATE.needCaptcha = true;
    return STATE.priceList;
  }

  async function loadSections() {
    var res = await http(API.section + STATE.showId, { query: { distributionSeriesId: '', distributionChannelId: '' } });
    if (!isOk(res)) throw new Error('取分区失败：' + errMsg(res));
    STATE.sections = asArray(res.data, ['showSectionDtos', '']);
    STATE.sectionDto = STATE.sections.filter(function (s) { return String(s.sectionId) === String(STATE.sectionId); })[0] || null;
    return STATE.sections;
  }

  // 座位图：优先 CDN（页面也是这么做的），失败再退回 /all 接口
  async function loadSeats(sectionId) {
    var sid = String(sectionId);
    if (!sid) throw new Error('URL 里没有 sectionId：这个演出有多个分区，请先在详情页点“选座购买”，进到具体分区的选座页再抢');
    var dto = STATE.sections.filter(function (s) { return String(s.sectionId) === sid; })[0];
    var raw = null;
    if (dto && (dto.webCdnPath || dto.appCdnPath)) {
      try {
        var cdn = await http(dto.webCdnPath || dto.appCdnPath);
        raw = asArray(cdn && cdn.data, ['data', '']);
      } catch (e) { raw = null; }
    }
    if (!raw || !raw.length) {
      var res = await http(API.seatsAll(STATE.showId, sid));
      if (isOk(res)) raw = asArray(res.data, ['', 'data']);
    }
    if (!raw || !raw.length) throw new Error('拿不到分区 ' + sid + ' 的座位图（可能这个分区不可售）');
    return raw;
  }
  async function loadAvail(sectionId) {
    var res = await http(API.avail(STATE.productId, STATE.showId, sectionId), { query: { distributionSeriesId: '', distributionChannelId: '' } });
    if (!isOk(res)) throw new Error('取可售座位失败：' + errMsg(res));
    return asArray(res.data, ['', 'data']);
  }

  // 把“座位图 + 可售位图”合成可售座位列表
  function mergeSeats(raw, avail) {
    var out = [];
    (raw || []).forEach(function (s) {
      if (!s || Number(s.t) !== 1 || s.sid == null) return;      // t=1 才是座位，t=2 是舞台
      var idx = s.i;
      var free = Array.isArray(avail) ? avail[idx] == 1 : false;
      if (!free) return;
      var p = parseDesc(s.d);
      var priceRec = STATE.priceById[String(s.p)] || {};
      out.push({
        sid: String(s.sid), desc: String(s.d || ''), remark: String(s.b || ''),
        area: p.area, row: p.row, col: p.col,
        priceId: String(s.p), price: priceRec.price == null ? null : priceRec.price,
        x: s.x, y: s.y,
      });
    });
    return out;
  }

  async function reload() {
    resetState();
    try {
      await loadBasic();
      await loadPrices();
      await loadSections();
      var raw = await loadSeats(STATE.sectionId);
      var avail = await loadAvail(STATE.sectionId);
      STATE.free = mergeSeats(raw, avail);
      STATE.seatTotal = (raw || []).filter(function (s) { return s && Number(s.t) === 1; }).length;
      STATE.ok = true;
      log('数据就绪：' + (STATE.project && STATE.project.productName || STATE.productId)
        + ' ｜ 场次 ' + STATE.showId
        + ' ｜ 分区 ' + (STATE.sectionDto ? STATE.sectionDto.cname : STATE.sectionId)
        + ' ｜ 可售 ' + STATE.free.length + '/' + STATE.seatTotal + ' 座'
        + ' ｜ 价位 ' + STATE.priceList.map(function (p) { return p.price; }).join('/')
        + ' ｜ ' + (STATE.needCaptcha ? '⚠️ 这场需要滑块验证（脚本会自动改用网页点选，你滑一下）' : '无需滑块，可全自动'));
      return true;
    } catch (e) {
      STATE.lastError = e && e.message ? e.message : String(e);
      err('加载失败：' + STATE.lastError);
      if (e && e.needLogin) log('→ 请先在同浏览器登录 www.shoac.com.cn，再刷新这个选座页。');
      return false;
    }
  }
  async function refreshFree() {
    try {
      var raw = await loadSeats(STATE.sectionId);
      var avail = await loadAvail(STATE.sectionId);
      STATE.free = mergeSeats(raw, avail);
      return true;
    } catch (e) { warn('刷新余票失败：', e.message || e); return false; }
  }

  // ---------------------------------------------------------------
  // 选座
  // ---------------------------------------------------------------
  function areaHit(areas, name) {
    if (!areas || !areas.length) return true;      // 空 = 不限
    var nm = String(name || '').toUpperCase();
    return areas.some(function (a) { return nm.indexOf(String(a).trim().toUpperCase()) > -1; });
  }
  function candidatesForPool(pool, rule) {
    var qty = Number(rule.qty) || 1;
    var groups = pool.filter(function (s) {
      if (Number(s.price) !== Number(rule.price)) return false;
      return areaHit(rule.areas, s.area);
    });
    if (!groups.length) return [];
    // 区域顺序：按 rule.areas 出现位置；不限区域时按区域名排序
    var areaNames = [];
    groups.forEach(function (s) { if (areaNames.indexOf(s.area) < 0) areaNames.push(s.area); });
    if (!rule.areas || !rule.areas.length) areaNames.sort();
    function areaIdx(s) {
      if (!rule.areas || !rule.areas.length) return areaNames.indexOf(s.area);
      for (var i = 0; i < rule.areas.length; i++) {
        if (String(s.area).toUpperCase().indexOf(String(rule.areas[i]).trim().toUpperCase()) > -1) return i;
      }
      return 99;
    }
    // 按 区域|排 分组
    var byRow = {};
    groups.forEach(function (s) {
      if (s.row == null || s.col == null) return;
      var k = s.area + '|' + s.row + '|' + s.priceId;
      (byRow[k] = byRow[k] || []).push(s);
    });
    var rows = Object.keys(byRow).map(function (k) { return { key: k, area: byRow[k][0].area, row: byRow[k][0].row, seats: byRow[k].slice().sort(function (a, b) { return a.col - b.col; }) }; });
    var ranks = {};
    (function () {
      var uniq = rows.map(function (r) { return r.row; }).filter(function (v, i, a) { return a.indexOf(v) === i; }).sort(function (a, b) { return a - b; });
      var pref = String(CONFIG.rowPreference || 'middle').toLowerCase();
      var order;
      if (pref === 'front') order = uniq;
      else if (pref === 'back') order = uniq.slice().reverse();
      else {
        var mid = (uniq.length - 1) / 2;
        order = uniq.map(function (r, i) { return { r: r, d: Math.abs(i - mid) }; })
          .sort(function (x, y) { return x.d - y.d || x.r - y.r; }).map(function (x) { return x.r; });
      }
      order.forEach(function (r, i) { ranks[r] = i; });
    })();
    var out = [];
    // 1) 同排连坐
    rows.forEach(function (r) {
      var cols = r.seats, mid = median(cols.map(function (s) { return s.col; }));
      var i = 0;
      while (i < cols.length) {
        var j = i;
        while (j + 1 < cols.length && cols[j + 1].col === cols[j].col + 1) j++;
        var run = cols.slice(i, j + 1);
        if (run.length >= qty) {
          var best = null;
          for (var s0 = 0; s0 + qty <= run.length; s0++) {
            var sub = run.slice(s0, s0 + qty);
            var c = (sub[0].col + sub[sub.length - 1].col) / 2;
            var sc = Math.abs(c - mid);
            if (!best || sc < best.sc) best = { sc: sc, seats: sub };
          }
          out.push({
            tier: 1, tierName: qty === 1 ? '单座' : '同排连坐', area: r.area, areaIdx: areaIdx(best.seats[0]),
            seats: best.seats, score: (ranks[r.row] == null ? 999 : ranks[r.row]) * 1000 + best.sc,
          });
        }
        i = j + 1;
      }
    });
    // 2) 上下排相邻（同列附近、连续排）
    if (qty > 1) {
      var byArea = {};
      rows.forEach(function (r) { (byArea[r.area + '|' + r.seats[0].priceId] = byArea[r.area + '|' + r.seats[0].priceId] || []).push(r); });
      Object.keys(byArea).forEach(function (k) {
        var list = byArea[k].slice().sort(function (a, b) { return a.row - b.row; });
        for (var ri = 0; ri + qty - 1 < list.length; ri++) {
          var seq = list.slice(ri, ri + qty);
          var contiguous = seq.every(function (r, i) { return i === 0 || r.row === seq[i - 1].row + 1; });
          if (!contiguous) continue;
          seq[0].seats.forEach(function (base) {
            var pick = [base], ok = true;
            for (var k2 = 1; k2 < qty; k2++) {
              var cand = seq[k2].seats.filter(function (s) { return Math.abs(s.col - base.col) <= 1; })[0];
              if (!cand) { ok = false; break; }
              pick.push(cand);
            }
            if (!ok) return;
            var avg = seq.reduce(function (a, r) { return a + (ranks[r.row] == null ? 999 : ranks[r.row]); }, 0) / qty;
            out.push({ tier: 2, tierName: '上下排相邻', area: base.area, areaIdx: areaIdx(base), seats: pick, score: avg * 1000 + base.col / 100 });
          });
        }
      });
    }
    // 3) 散座兜底
    var loose = groups.filter(function (s) { return s.row != null; }).map(function (s) {
      var rowSeats = byRow[s.area + '|' + s.row + '|' + s.priceId] || [];
      var mid = median(rowSeats.map(function (x) { return x.col; }));
      return { s: s, score: (ranks[s.row] == null ? 999 : ranks[s.row]) * 1000 + Math.abs(s.col - mid) };
    }).sort(function (a, b) { return a.score - b.score; });
    if (loose.length >= qty) {
      var pickLoose = loose.slice(0, qty);
      out.push({
        tier: 3, tierName: '散座', area: pickLoose[0].s.area, areaIdx: areaIdx(pickLoose[0].s),
        seats: pickLoose.map(function (x) { return x.s; }), score: pickLoose[pickLoose.length - 1].score,
      });
    }
    out.sort(function (a, b) {
      if (a.areaIdx !== b.areaIdx) return a.areaIdx - b.areaIdx;
      if (a.tier !== b.tier) return a.tier - b.tier;
      return a.score - b.score;
    });
    return out;
  }
  function describe(cand) {
    var byArea = {};
    cand.seats.forEach(function (s) { (byArea[s.area] = byArea[s.area] || []).push(s.desc.replace(s.area, '')); });
    var price = cand.seats[0].price;
    return Object.keys(byArea).map(function (a) { return a + ' ' + byArea[a].join('、'); }).join(' | ')
      + '（￥' + price + ' × ' + cand.seats.length + '，' + cand.tierName + '）';
  }
  function priceOf(s) { return s.price; }

  // ---------------------------------------------------------------
  // 锁座（接口方式）
  // ---------------------------------------------------------------
  async function apiLock(cand) {
    var body = {
      productId: STATE.productId,
      showId: Number(STATE.showId),
      sectionId: Number(STATE.sectionId),
      seatList: cand.seats.map(function (s) { return String(s.sid); }),
    };
    log('调用锁座接口 lock-seat-choose：', JSON.stringify(body));
    var j = await http(API.lockChoose, { method: 'POST', body: body });
    if (!isOk(j)) {
      var e = new Error('锁座被拒：' + errMsg(j));
      e.resp = j;
      throw e;
    }
    return j.data;
  }

  // ---------------------------------------------------------------
  // 锁座（网页点选方式：由页面自己去锁，能处理滑块验证）
  // ---------------------------------------------------------------
  function seatElByDesc(desc) {
    var list = document.querySelectorAll('#seatContent li.seat-item');
    for (var i = 0; i < list.length; i++) {
      var t = String(list[i].getAttribute('title') || '').trim();
      if (t === desc || t.indexOf(desc) === 0) return list[i];
    }
    return null;
  }
  function clickDialog(re) {
    var btns = document.querySelectorAll('.el-dialog button, .el-message-box button, .el-drawer button');
    for (var i = 0; i < btns.length; i++) {
      if (re.test(String(btns[i].textContent || ''))) { btns[i].click(); return true; }
    }
    return false;
  }
  async function waitFor(fn, ms) {
    var waited = 0;
    while (waited < ms) { if (fn()) return true; await sleep(200); waited += 200; }
    return fn();
  }
  async function domLock(cand) {
    if (!document.querySelector('#seatContent li.seat-item')) {
      var ok = await waitFor(function () { return !!document.querySelector('#seatContent li.seat-item'); }, 10000);
      if (!ok) throw new Error('页面座位图还没渲染出来，没法点选（先确认这个分区有票、或手动刷新一下）');
    }
    var hit = 0, miss = [];
    for (var i = 0; i < cand.seats.length; i++) {
      var el = seatElByDesc(cand.seats[i].desc);
      if (el) { el.click(); hit++; } else miss.push(cand.seats[i].desc);
      await sleep(150);
    }
    if (!hit) throw new Error('一个座位都没点到：' + miss.join('、') + '（可能已被抢走，试试点“刷新”重来）');
    if (miss.length) warn('有 ' + miss.length + ' 个座位在页面上没找到（可能刚被抢）：' + miss.join('、'));
    await sleep(400);
    var btn = document.querySelector('.cart-bottom button') || document.querySelector('.seat-cart .el-button--primary');
    if (!btn) throw new Error('没找到右侧购物车的“结账”按钮（购物车可能没展开）');
    if (btn.disabled) throw new Error('“结账”按钮是灰的，说明座位没真正选中，请手动点一下座位再试');
    btn.click();
    log('已点“结账”。' + (STATE.needCaptcha ? '⚠️ 这场需要滑块验证，请手动拖一下滑块，之后页面会自己跳到提交订单页。' : '如果弹出“座位包含特殊信息”提示，点“继续购买”即可。'));
    await sleep(800);
    if (clickDialog(/继续购买/)) log('已点“继续购买”。');
    return 'dom';
  }

  // ---------------------------------------------------------------
  // 跳转到“提交订单”页（uuid 只在路由内存里，必须用页面自己的 router）
  // ---------------------------------------------------------------
  function rootVm() {
    var el = document.getElementById('app');
    return el && el.__vue__ ? el.__vue__ : null;
  }
  function gotoOrder(uuid) {
    var vm = rootVm();
    if (vm && vm.$router) {
      vm.$router.push({ name: 'orderDetail', params: { uuid: JSON.stringify(String(uuid)) } });
      return true;
    }
    return false;
  }
  function gotoTab(name, query) {
    var vm = rootVm();
    if (vm && vm.$router) { vm.$router.push({ name: name, query: query }); return true; }
    var qs = new URLSearchParams(query).toString();
    var path = name === 'selectSeat' ? '/selectPurchase/selectSeat' : (name === 'selectArea' ? '/selectPurchase/selectArea' : '/detail');
    location.hash = '#' + path + (qs ? '?' + qs : '');
    return true;
  }

  // ---------------------------------------------------------------
  // 对外命令
  // ---------------------------------------------------------------
  var SOAC = {};
  SOAC.config = CONFIG;
  SOAC.state = STATE;
  SOAC.reload = function () { return reload(); };
  SOAC.gotoTab = gotoTab;

  SOAC.inventory = function () {
    if (!STATE.ok) { warn('还没数据，先 SOAC.reload()'); return; }
    var agg = {};
    STATE.free.forEach(function (s) {
      var k = s.area + ' | ￥' + s.price;
      agg[k] = (agg[k] || 0) + 1;
    });
    console.table(Object.keys(agg).sort().map(function (k) { return { 区域: k, 余票: agg[k] }; }));
    log('本分区可售 ' + STATE.free.length + '/' + STATE.seatTotal + ' 座');
  };

  SOAC.scan = async function () {
    if (!STATE.sections.length) { warn('还没数据，先 SOAC.reload()'); return; }
    log('扫描全场 ' + STATE.sections.length + ' 个分区的余票（要几个请求，稍等）…');
    var rows = [];
    for (var i = 0; i < STATE.sections.length; i++) {
      var sec = STATE.sections[i];
      var sid = String(sec.sectionId);
      try {
        var raw = await loadSeats(sid);
        var av = await loadAvail(sid);
        var free = mergeSeats(raw, av);
        var byPrice = {};
        free.forEach(function (s) { byPrice['￥' + s.price] = (byPrice['￥' + s.price] || 0) + 1; });
        rows.push({ 分区: sec.cname + '(' + sid + ')', 可售: free.length, 分布: Object.keys(byPrice).sort().map(function (p) { return p + '×' + byPrice[p]; }).join(' ') || '无' });
      } catch (e) {
        rows.push({ 分区: sec.cname + '(' + sid + ')', 可售: '读不到', 分布: String(e.message || e).slice(0, 30) });
      }
    }
    console.table(rows);
    log('提示：换个分区抢，可以直接把浏览器地址里的 sectionId 改成上面某个 id，或在详情页重新点“选座购买”。');
    return rows;
  };

  SOAC.plan = function () {
    if (!STATE.ok) { warn('还没数据，先 SOAC.reload()'); return; }
    var rules = CONFIG.rules || [];
    var rows = rules.map(function (r, i) {
      var cs = candidatesForPool(STATE.free, r);
      return {
        规则: '#' + (i + 1),
        要求: '￥' + r.price + ' × ' + r.qty + ((r.areas && r.areas.length) ? ' · 区域 ' + r.areas.join('>') : ' · 不限区域'),
        命中: cs.length ? describe(cs[0]) : '无（这个价位/区域凑不齐 ' + r.qty + ' 张）',
        备选数: cs.length,
      };
    });
    console.table(rows);
    var first = rules.map(function (r) { return candidatesForPool(STATE.free, r); }).filter(function (c) { return c.length; })[0];
    if (first) log('预演结果：会锁 → ' + describe(first[0]));
    else warn('预演结果：所有规则都凑不齐。点“库存/全场扫描”看真实价位与分区，再改 config.yaml。');
    return rows;
  };

  var RUNNING = false;
  SOAC.run = async function () {
    if (RUNNING) { warn('正在跑，别重复点'); return { success: false, busy: true }; }
    if (!route().onSeatPage) { warn('请先进入“在线选座”页（#/selectPurchase/selectSeat?...）再抢座'); return { success: false, reason: 'not-on-seat-page' }; }
    RUNNING = true;
    try {
      if (!STATE.ok) {
        if (!await reload()) return { success: false, reason: 'load-failed', error: STATE.lastError };
      }
      var rules = CONFIG.rules || [];
      if (!rules.length) { warn('config.yaml 里没有 rules'); return { success: false, reason: 'no-rules' }; }
      var dry = !!CONFIG.dryRun || CONFIG.submitOrder === false;
      var attempts = Math.max(1, Number(CONFIG.maxRetry) || 1);
      var switched = false;
      for (var attempt = 0; attempt < attempts; attempt++) {
        if (attempt > 0) { log('第 ' + (attempt + 1) + '/' + attempts + ' 轮：刷新余票重挑'); await refreshFree(); }
        var any = false;
        for (var i = 0; i < rules.length; i++) {
          var cs = candidatesForPool(STATE.free, rules[i]);
          if (!cs.length) { warn('规则#' + (i + 1) + '（￥' + rules[i].price + ' × ' + rules[i].qty + '）在本分区凑不齐，跳过'); continue; }
          any = true;
          var cand = cs[0];
          if (cs.length > 1) log('规则#' + (i + 1) + ' 有 ' + cs.length + ' 种挑法，首选：' + describe(cand));
          if (dry) {
            log('%c【预演】会锁 → ' + describe(cand), 'color:#e5533c;font-weight:bold');
            return { success: true, planned: true, pick: cand };
          }
          // 需要滑块 或 指定 dom 模式 → 让页面自己去锁
          var useDom = CONFIG.mode === 'dom' || (CONFIG.mode !== 'api' && STATE.needCaptcha);
          if (useDom) {
            log('锁定（网页点选方式）→ ' + describe(cand));
            await domLock(cand);
            return { success: true, via: 'dom', pick: cand };
          }
          log('锁定 → ' + describe(cand));
          var uuid = null;
          try { uuid = await apiLock(cand); }
          catch (e) {
            err('锁座失败：' + (e.message || e));
            if (e.needLogin) return { success: false, reason: 'need-login', error: e.message };
            // 接口方式失败（可能是参数/风控），退回网页点选试试
            if (CONFIG.mode === 'auto' && !switched) {
              switched = true;
              log('改用“网页点选”方式再试一次（用的是页面自己的下单逻辑）…');
              try { await domLock(cand); return { success: true, via: 'dom', pick: cand }; }
              catch (e2) { err('网页点选也失败了：' + (e2.message || e2)); }
            }
            continue;
          }
          clearPending();
          savePending({ uuid: String(uuid), ts: Date.now(), productId: STATE.productId, showId: STATE.showId, sectionId: STATE.sectionId, seats: cand.seats.map(function (s) { return s.desc; }) });
          console.log('%c[SOAC] ✅ 座位已锁住！uuid=' + uuid, 'color:#fff;background:#0a0;padding:2px 6px;border-radius:4px;font-weight:bold');
          log('座位已被这笔“锁座”占住，但还没生成订单：接下来要在“提交订单”页确认取票方式/实名后提交，再去付款。');
          log('锁定座位：' + cand.seats.map(function (s) { return s.area + s.desc.replace(s.area, ''); }).join('、'));
          if (CONFIG.jumpToOrder) {
            if (gotoOrder(uuid)) log('已跳到提交订单页。');
            else { warn('拿不到页面 router，没法自动跳。请刷新页面后执行 SOAC.order()，或去“我的订单”里找。'); }
          }
          return { success: true, uuid: String(uuid), pick: cand };
        }
        if (!any && CONFIG.autoSwitchSection) {
          log('本分区没有符合规则的座位，扫描其他分区…');
          var better = null;
          for (var k = 0; k < STATE.sections.length; k++) {
            var sec = STATE.sections[k];
            if (String(sec.sectionId) === String(STATE.sectionId)) continue;
            try {
              var raw2 = await loadSeats(String(sec.sectionId));
              var av2 = await loadAvail(String(sec.sectionId));
              var pool2 = mergeSeats(raw2, av2);
              for (var ri = 0; ri < rules.length; ri++) {
                var cs2 = candidatesForPool(pool2, rules[ri]);
                if (cs2.length) { better = { section: sec, cand: cs2[0], ruleIdx: ri }; break; }
              }
            } catch (e) { /* 这个分区读不到就跳过 */ }
            if (better) break;
          }
          if (better) {
            log('发现分区「' + better.section.cname + '」有票：' + describe(better.cand) + ' → 自动切过去，切好后会自动继续抢（或点一次“一键抢座”）');
            setAutoRunOnce(true);
            gotoTab('selectSeat', { productId: STATE.productId, showId: STATE.showId, sectionId: String(better.section.sectionId) });
            return { success: false, reason: 'switching-section', section: better.section };
          }
          warn('全场所有分区都不满足当前规则。');
          break;
        }
      }
      warn('试满 ' + attempts + ' 轮仍未锁到。建议放宽 rules（加更多价位/区域、减少张数），或点“全场扫描”看哪个分区有票。');
      return { success: false, reason: 'exhausted' };
    } finally {
      RUNNING = false;
    }
  };

  // 刷新后重新跳到刚才的订单页（uuid 存在 localStorage 里）
  SOAC.order = function () {
    var p = readPending();
    if (!p || !p.uuid) { warn('没有记录到刚锁的座位。可去“我的订单”看看。'); return null; }
    if (gotoOrder(p.uuid)) { log('已跳到提交订单页（uuid ' + p.uuid + '）'); return p; }
    warn('拿不到页面 router；试试刷新页面再执行 SOAC.order()。');
    return p;
  };
  SOAC.release = async function () {
    var p = readPending();
    if (!p || !p.uuid) { warn('没有记录到锁座信息（本次没锁过，或已清掉）。'); return; }
    try {
      var j = await http(API.lockDelete + encodeURIComponent(p.uuid), { method: 'DELETE' });
      if (isOk(j)) { log('已释放锁座 ' + p.uuid); clearPending(); }
      else warn('释放失败：' + errMsg(j));
    } catch (e) { err('释放出错：' + (e.message || e)); }
  };

  // 自检
  SOAC.diag = async function () {
    var r = route();
    var out = {
      when: ts(), href: location.href, route: r, loggedIn: !!token(), hasToken: !!token(),
      productId: '', productName: '', showId: '', showTime: '', sectionId: '', sectionName: '',
      needCaptcha: null, prices: [], inventory: [], areas: [], errors: [],
    };
    log('自检开始（只读接口，不会锁座）…');
    try {
      await loadBasic();
      out.productId = STATE.productId;
      out.productName = (STATE.project && STATE.project.productName) || '';
      out.showId = STATE.showId;
      out.showTime = (STATE.show && STATE.show.showTime) || '';
      out.needCaptcha = STATE.needCaptcha;
      out.shows = STATE.showList.map(function (s) { return { showId: s.showId, time: s.showTime, site: s.site, status: s.status, name: s.showStatusName, sectionId: s.sectionId, sectionNum: s.sectionNum }; });
      if (!r.showId && STATE.showList.length > 1) out.errors.push('URL 没带 showId，详情页请先点一个场次再自检');
      await loadPrices();
      out.prices = STATE.priceList.map(function (p) { return p.ticketPriceId + '=￥' + p.price + '(' + (p.priceGrade || '') + ')'; });
      await loadSections();
      out.sectionId = STATE.sectionId;
      out.sectionName = STATE.sectionDto ? STATE.sectionDto.cname : '';
      out.allSections = STATE.sections.map(function (s) { return s.sectionId + '=' + s.cname; });
      if (STATE.sectionId) {
        var raw = await loadSeats(STATE.sectionId);
        var av = await loadAvail(STATE.sectionId);
        STATE.free = mergeSeats(raw, av);
        var agg = {};
        STATE.free.forEach(function (s) { var k = s.area + ' ￥' + s.price; agg[k] = (agg[k] || 0) + 1; });
        out.inventory = Object.keys(agg).sort().map(function (k) { return k + ' → ' + agg[k]; });
        out.seatSample = STATE.free.slice(0, 5).map(function (s) { return { sid: s.sid, desc: s.desc, price: s.price, priceId: s.priceId }; });
      }
    } catch (e) {
      out.errors.push(String(e && e.message || e));
    }
    console.log('%c[SOAC-DIAG] 自检结果（可整段复制）', 'color:#08f;font-weight:bold');
    console.log(JSON.stringify(out, null, 2));
    showText('SOAC 自检结果（复制这段发我）', JSON.stringify(out, null, 2));
    log('自检结束' + (out.errors.length ? '：有 ' + out.errors.length + ' 条异常' : '：没有异常'));
    return out;
  };

  // ---------------------------------------------------------------
  // 开票监控（演出详情页）
  // ---------------------------------------------------------------
  function watchEnabled() { return !!(CONFIG.watch && CONFIG.watch.enabled); }
  function showMatch(s) {
    var w = CONFIG.watch || {};
    if (w.showId) return String(s.showId) === String(w.showId);
    var t = String(s.showTime || '');
    if (w.date && t.indexOf(String(w.date)) === -1) return false;
    if (w.time && t.indexOf(String(w.time)) === -1) return false;
    return !!(w.date || w.time);
  }
  var WATCH = { timer: null, busy: false, logged: false, entered: false, key: '' };
  async function watchOnce() {
    var r = route();
    if (!r.onDetail || WATCH.entered) return null;
    var pid = r.productId;
    if (!pid && r.projectId) {
      var old = await http(API.projectOld + r.projectId);
      if (isOk(old) && old.data) pid = String(old.data.productId || '');
    }
    if (!pid) { setStatus('监控：这个详情页 URL 里没有 productId'); return null; }
    var shows = await http(API.shows + pid);
    var list = asArray(shows && shows.data, ['showInfoDetailList', 'showList', '']);
    if (!WATCH.logged) {
      WATCH.logged = true;
      console.table(list.map(function (s) {
        return { showId: s.showId, 时间: s.showTime, 选座票: s.site === 1 ? '是' : '否', status: s.status, 状态: s.showStatusName, 开售: s.saleBeginTimeStr };
      }));
    }
    var hit = list.filter(showMatch).filter(function (s) { return s.site === 1 && String(s.status) === '05'; })[0];
    if (!hit) {
      var soon = list.filter(showMatch)[0];
      setStatus('监控中：目标场次还没开卖' + (soon ? '（' + soon.showTime + ' status=' + soon.status + ' ' + (soon.showStatusName || '') + '）' : '（没找到匹配的场次）'));
      return null;
    }
    WATCH.entered = true;
    var query = { productId: String(pid), showId: String(hit.showId), sectionId: String(hit.sectionId || '') };
    console.log('%c[SOAC] 🎯 目标场次开卖，自动进入选座页', 'color:#fff;background:#e5533c;padding:2px 6px;border-radius:4px;font-weight:bold', hit.showTime, JSON.stringify(query));
    setStatus('已进入选座页，等待抢座…');
    setAutoRunOnce(true);
    if (Number(hit.sectionNum) > 1 && !hit.sectionId) gotoTab('selectArea', query);
    else gotoTab('selectSeat', query);
    return hit;
  }
  function scheduleWatch(delay) {
    if (!watchEnabled()) return;
    if (WATCH.timer) clearTimeout(WATCH.timer);
    WATCH.timer = setTimeout(watchStep, delay == null ? (Number(CONFIG.watch.pollMs) || 1500) : delay);
  }
  function watchStep() {
    if (!watchEnabled() || !route().onDetail) return;
    var key = route().productId + '|' + route().projectId;
    if (key !== WATCH.key) { WATCH.key = key; WATCH.entered = false; WATCH.logged = false; }
    if (CONFIG.watch.startAt) {
      var start = Date.parse(String(CONFIG.watch.startAt).replace(/\./g, '-').replace(' ', 'T'));
      if (!isNaN(start) && Date.now() < start) {
        setStatus('监控：距离开抢还有 ' + Math.ceil((start - Date.now()) / 1000) + ' 秒');
        scheduleWatch(1000);
        return;
      }
    }
    if (WATCH.busy) { scheduleWatch(400); return; }
    WATCH.busy = true;
    watchOnce().then(function () { WATCH.busy = false; scheduleWatch(); }, function (e) {
      WATCH.busy = false;
      setStatus('监控出错：' + (e.message || e) + '，继续重试…');
      scheduleWatch(2000);
    });
  }
  SOAC.watchCheck = async function () {
    if (!watchEnabled()) { warn('config.yaml 里 watch.enabled 还是 false'); return null; }
    if (!route().onDetail) { warn('请在“演出详情页”用这个命令（#/detail?productId=..）'); return null; }
    return watchOnce();
  };

  // ---------------------------------------------------------------
  // 面板
  // ---------------------------------------------------------------
  var canDom = typeof document !== 'undefined' && !!document.createElement;
  var statusEl = null;
  function setStatus(t) { if (statusEl) statusEl.textContent = t; }
  function routeLabel() {
    var r = route();
    if (r.onSeatPage) return STATE.ok ? '✅ 选座页就绪，可抢座' : (STATE.lastError ? '⚠️ ' + STATE.lastError : '选座页：加载中…');
    if (r.onAreaPage) return '选择分区页：点进具体分区后即可抢座';
    if (r.onDetail) return watchEnabled() ? '详情页：监控中…' : '详情页（可在 config.yaml 打开 watch 监控开票）';
    if (r.onOrder) return '提交订单页：填写取票方式/实名后提交，再去付款';
    return '未在选座页；打开选座页后就绪';
  }
  function guard(label, fn) {
    setStatus(label);
    return Promise.resolve().then(fn).then(function () { setStatus(routeLabel()); }, function (e) {
      setStatus('出错：' + ((e && e.message) || e)); err(e);
    });
  }
  function btn(label, color, onClick) {
    var b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = 'margin:2px;padding:6px 10px;border:0;border-radius:6px;color:#fff;cursor:pointer;font-size:13px;background:' + color;
    b.onmouseenter = function () { b.style.opacity = '.85'; };
    b.onmouseleave = function () { b.style.opacity = '1'; };
    b.onclick = onClick;
    return b;
  }
  function showText(title, text) {
    if (!canDom || !document.body) { console.log('[SOAC] ' + title + '\n' + text); return; }
    var old = document.getElementById('soac-diag-box');
    if (old && old.parentNode) old.parentNode.removeChild(old);
    var wrap = document.createElement('div');
    wrap.id = 'soac-diag-box';
    wrap.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;width:520px;max-width:92vw;background:#101a24;color:#e6e6e6;border-radius:10px;padding:10px 12px;box-shadow:0 6px 24px rgba(0,0,0,.5);font-family:system-ui,Arial;';
    var h = document.createElement('div');
    h.textContent = title;
    h.style.cssText = 'font-weight:700;font-size:13px;margin-bottom:6px;';
    var ta = document.createElement('textarea');
    ta.value = text; ta.spellcheck = false;
    ta.style.cssText = 'width:100%;height:230px;box-sizing:border-box;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;line-height:1.45;background:#0b1219;color:#cfe;border:1px solid #2a3a4a;border-radius:6px;padding:6px;';
    ta.onclick = function () { ta.select(); };
    var bar = document.createElement('div');
    var copyBtn = btn('复制', '#48c', function () {
      ta.focus(); ta.select();
      var done = false;
      try { done = document.execCommand('copy'); } catch (e) { done = false; }
      if (!done && navigator.clipboard) navigator.clipboard.writeText(ta.value).catch(function () {});
      copyBtn.textContent = '已复制 ✓（不行就 Ctrl/Cmd+C）';
      setTimeout(function () { copyBtn.textContent = '复制'; }, 2500);
    });
    var closeBtn = btn('关闭', '#556', function () { if (wrap.parentNode) wrap.parentNode.removeChild(wrap); });
    bar.appendChild(copyBtn); bar.appendChild(closeBtn);
    wrap.appendChild(h); wrap.appendChild(ta); wrap.appendChild(bar);
    document.body.appendChild(wrap);
    ta.focus(); ta.select();
  }
  function mountPanel() {
    if (!canDom || window.__SOAC_PANEL__) return;
    var box = document.createElement('div');
    box.style.cssText = 'position:fixed;left:16px;bottom:16px;z-index:2147483647;background:#22303f;color:#e6e6e6;font-family:system-ui,Arial;box-shadow:0 6px 24px rgba(0,0,0,.35);border-radius:10px;padding:10px 12px;width:250px;';
    var title = document.createElement('div');
    title.textContent = 'SOAC 东艺抢座';
    title.style.cssText = 'font-weight:700;font-size:13px;margin-bottom:6px;';
    var info = document.createElement('div');
    info.style.cssText = 'font-size:11px;color:#9ab;margin-bottom:8px;line-height:1.5;';
    info.innerHTML = '规则 ' + ((CONFIG.rules || []).length) + ' 条 · autoRun ' + (!!CONFIG.autoRun) + ' · mode ' + CONFIG.mode
      + '<br>快捷键 Alt+Shift+ P/R/I/T/S<br>不对劲先点“自检/复制”，把弹框里的 JSON 发我';
    var w = document.createElement('div');
    w.appendChild(btn('自检/复制', '#48c', function () { guard('自检中…', function () { return SOAC.diag(); }); }));
    w.appendChild(btn('预演', '#3a7', function () { guard('预演中…', function () { return SOAC.plan(); }); }));
    w.appendChild(btn(CONFIG.submitOrder === false ? '只挑座' : '一键抢座', '#e5533c', function () { guard('抢座中…', function () { return SOAC.run(); }); }));
    w.appendChild(btn('库存', '#7a5', function () { guard('查库存…', function () { return SOAC.inventory(); }); }));
    w.appendChild(btn('全场扫描', '#875', function () { guard('扫描中…', function () { return SOAC.scan(); }); }));
    w.appendChild(btn('刷新', '#777', function () { guard('刷新中…', function () { return SOAC.reload(); }); }));
    w.appendChild(btn('去订单页', '#d81', function () { guard('跳转…', function () { return SOAC.order(); }); }));
    w.appendChild(btn('释放锁座', '#556', function () { guard('释放中…', function () { return SOAC.release(); }); }));
    statusEl = document.createElement('div');
    statusEl.style.cssText = 'font-size:11px;color:#8cf;margin-top:8px;min-height:14px;line-height:1.4;';
    box.appendChild(title); box.appendChild(info); box.appendChild(w); box.appendChild(statusEl);
    document.body.appendChild(box);
    window.__SOAC_PANEL__ = box;
    setStatus(routeLabel());
  }
  if (canDom) window.addEventListener('keydown', function (e) {
    if (!e.altKey || !e.shiftKey || e.ctrlKey || e.metaKey) return;
    var k = String(e.key || '').toLowerCase();
    if (k === 'p') { e.preventDefault(); guard('预演中…', function () { return SOAC.plan(); }); }
    else if (k === 'r') { e.preventDefault(); guard('抢座中…', function () { return SOAC.run(); }); }
    else if (k === 'i') { e.preventDefault(); guard('查库存…', function () { return SOAC.inventory(); }); }
    else if (k === 't') { e.preventDefault(); guard('自检中…', function () { return SOAC.diag(); }); }
    else if (k === 's') { e.preventDefault(); guard('扫描中…', function () { return SOAC.scan(); }); }
  }, true);

  // ---------------------------------------------------------------
  // 自动运行 / 路由监听
  // ---------------------------------------------------------------
  var AUTO = { done: false, loading: false, key: '' };
  function currentKey() { var r = route(); return r.productId + '|' + r.showId + '|' + r.sectionId; }
  function bootForRoute(attempt) {
    var r = route();
    if (r.onSeatPage) {
      if (AUTO.key !== currentKey()) { AUTO.key = currentKey(); AUTO.done = false; AUTO.loading = false; AUTO.reported = false; }
      if (AUTO.loading) return;
      if (STATE.ok) {
        if (!AUTO.done && (CONFIG.autoRun || pendingAuto())) { AUTO.done = true; log('autoRun 触发'); guard('autoRun：抢座中…', function () { return SOAC.run(); }); }
        return;
      }
      AUTO.loading = true;
      setStatus('选座页加载中…' + (attempt ? ' 重试 ' + attempt : ''));
      reload().then(function (ok) {
        AUTO.loading = false;
        setStatus(routeLabel());
        if (ok) {
          log('数据就绪。可 SOAC.plan() 预演，或点“一键抢座”/Alt+Shift+R。');
          if (!AUTO.done && (CONFIG.autoRun || pendingAuto())) { AUTO.done = true; guard('autoRun：抢座中…', function () { return SOAC.run(); }); }
        } else {
          if (!AUTO.reported) { AUTO.reported = true; bootReport('选座页数据加载失败'); }
          if (attempt < 15) setTimeout(function () { bootForRoute(attempt + 1); }, 800);
        }
      }, function () {
        AUTO.loading = false;
        if (attempt < 15) setTimeout(function () { bootForRoute(attempt + 1); }, 800);
      });
      return;
    }
    if (r.onDetail) { if (watchEnabled()) watchStep(); setStatus(routeLabel()); return; }
    setStatus(routeLabel());
  }
  function pendingAuto() {
    if (PENDING) return true;
    PENDING = takeAutoRunOnce();      // 只在进入新页面后消费一次，避免之后乱抢
    return PENDING;
  }
  var PENDING = false;
  function bootReport(why) {
    var info = {
      when: ts(), why: why, href: location.href, route: route(),
      config: { rules: CONFIG.rules, mode: CONFIG.mode, autoRun: !!CONFIG.autoRun, dryRun: !!CONFIG.dryRun },
      state: { ok: STATE.ok, lastError: STATE.lastError, productId: STATE.productId, showId: STATE.showId, sectionId: STATE.sectionId, needCaptcha: STATE.needCaptcha, free: STATE.free.length, prices: STATE.priceList.length },
      hasToken: !!token(),
    };
    log('加载失败，现场信息如下：');
    console.log(JSON.stringify(info, null, 2));
    showText('加载失败（复制这段发我 · 完整自检随后弹出）', JSON.stringify(info, null, 2));
    SOAC.diag().catch(function (e) { warn('自检也失败了：', (e && e.message) || e); });
  }
  var lastUrl = '';
  function watchRoute() {
    var u = String(location.href || '') + '|' + String(location.hash || '');
    if (u === lastUrl) return;
    lastUrl = u;
    setStatus(routeLabel());
    bootForRoute(0);
  }

  window.SOAC = SOAC;
  SOAC._internal = { route: route, parseDesc: parseDesc, mergeSeats: mergeSeats, candidatesForPool: candidatesForPool, gotoOrder: gotoOrder, token: token };
  log('已加载(东艺抢座)。面板常驻左下角 · autoRun=' + (!!CONFIG.autoRun) + ' · dryRun=' + (!!CONFIG.dryRun)
    + ' · mode=' + CONFIG.mode + ' · watch=' + (watchEnabled() ? 'on' : 'off'));
  if (canDom) {
    window.addEventListener('hashchange', watchRoute);
    window.addEventListener('popstate', watchRoute);
    var boot = function () { mountPanel(); watchRoute(); setInterval(watchRoute, 300); };
    if (document.body) boot(); else window.addEventListener('DOMContentLoaded', boot);
  }
})();
