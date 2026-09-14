/* ============================================================
 * 上海大剧院(shgtheatre.com) · 单场“选座”页自动锁座引擎
 * ------------------------------------------------------------
 * 这是逻辑本体。真正安装到浏览器的是 build.mjs 生成的 shgtheatre.user.js
 * （= 脚本头 + 由 config.yaml 注入的配置 + 本文件）。
 *
 * 运行位置：登录后、进入某场次的“选座”页：
 *   https://www.shgtheatre.com/shtheatre/index.html#/ticket/seats/<场次id>?pk=...&sk=...
 *
 * 核心事实（从官网前端代码里核出来的，不是猜的）：
 *   - 选座页里点座位只是本地高亮，真正“锁座”是提交
 *       POST /thvendor/member/ticket/order/create.xhtml
 *       body: createOrderReq = JSON{scheduleId, mobile, platform:"PC",
 *                                   seats:[{venueAreaId,rowNo,colNo,ticketPrice,ticketPriceId}]}
 *     成功即生成“待付款订单”，座位由订单持有（付款仍需你手动完成）。
 *   - 余票来自 POST /thvendor/member/ticket/getAvailableSeats.xhtml，
 *     返回按「区域+价位」分组的可售座位："12:3,12:4" 这种 排:座 字符串。
 *   - 价位来自 POST /thvendor/member/ticket/getSchedulePrices.xhtml。
 *   - 场次信息(是否实名/区域表)来自 POST /thvendor/member/ticket/getScheduleInfo.xhtml。
 *   - 所有请求头必须带 cmpappkey: grandtheatrepc；pk/sk 在请求头里传(programKey/sessionKey)，
 *     这几点跟官网页面自己的 axios 拦截器一致。
 *
 * 常用命令（选座页控制台）：
 *   SGT.diag()        自检：把路由/场次/价位/区域/余票/实名 一次性打印出来（只读，安全）
 *   SGT.inventory()   看各区各价位实时余票
 *   SGT.plan()        预演：按 rules 顺序推算会挑到哪些座位（不下单）
 *   SGT.run()         执行：按 rules 挑座并锁座，被别人抢走会自动刷新重挑
 *   SGT.reload()      重新拉取场次/价位/余票
 *   SGT.releaseInfo() 锁到之后怎么释放
 * ============================================================ */
(function () {
  'use strict';

  if (typeof window === 'undefined') return;
  if (window.__SGT_ENGINE__) { console.warn('[SGT] 已加载，跳过重复注入。'); return; }
  window.__SGT_ENGINE__ = true;

  var DEFAULT_CONFIG = {
    dryRun: false, autoRun: false, submitOrder: true, maxRetry: 6, jumpToConfirm: false, autoAdvanceToPay: false,
    mobile: '', certificationIds: [], rowPreference: 'middle', rules: [], watch: {},
  };
  var CONFIG = (window.__SGT_CONFIG__) ? window.__SGT_CONFIG__ : DEFAULT_CONFIG;
  if (!CONFIG.watch) CONFIG.watch = {};

  // 官网前端里写死的 appkey（index-8410cb79.js: Xz="grandtheatrepc"）
  var APPKEY = 'grandtheatrepc';

  var API = {
    scheduleInfo: '/thvendor/member/ticket/getScheduleInfo.xhtml',
    prices: '/thvendor/member/ticket/getSchedulePrices.xhtml',
    avail: '/thvendor/member/ticket/getAvailableSeats.xhtml',
    create: '/thvendor/member/ticket/order/create.xhtml',
    member: '/thvendor/member/info/getMemberInfo.xhtml',
    certs: '/thvendor/member/getCertificationList.xhtml',
    program: '/thvendor/ticket/program/getProgramById.xhtml',
    schedules: '/thvendor/ticket/listScheduleByDate.xhtml',
    serverTime: '/thvendor/serverTime.xhtml',
  };

  // ---------------------------------------------------------------
  // 工具
  // ---------------------------------------------------------------
  function log() { console.log.apply(console, ['%c[SGT]', 'color:#0a0;font-weight:bold'].concat([].slice.call(arguments))); }
  function warn() { console.warn.apply(console, ['[SGT]'].concat([].slice.call(arguments))); }
  function err() { console.error.apply(console, ['[SGT]'].concat([].slice.call(arguments))); }

  // 与页面同款签名：feat = md5("H5" + cmpappkey + orderKey).substring(8, 24)
  // （已用 node crypto 对 ASCII/中文/emoji 多组数据核对一致）
  function md5(str) {
    function toBytes(s) {
      var bytes = [];
      for (var i = 0; i < s.length; i++) {
        var c = s.charCodeAt(i);
        if (c < 128) bytes.push(c);
        else if (c < 2048) { bytes.push((c >> 6) | 192, (c & 63) | 128); }
        else if (c < 55296 || c >= 57344) { bytes.push((c >> 12) | 224, ((c >> 6) & 63) | 128, (c & 63) | 128); }
        else {
          i++;
          var c2 = s.charCodeAt(i);
          var cp = 65536 + (((c & 1023) << 10) | (c2 & 1023));
          bytes.push((cp >> 18) | 240, ((cp >> 12) & 63) | 128, ((cp >> 6) & 63) | 128, (cp & 63) | 128);
        }
      }
      return bytes;
    }
    function rl(n, c) { return (n << c) | (n >>> (32 - c)); }
    function au(x, y) { var l = (x & 0xffff) + (y & 0xffff); return (((x >> 16) + (y >> 16) + (l >> 16)) << 16) | (l & 0xffff); }
    function cmn(q, a, b, x, s, t) { return au(rl(au(au(a, q), au(x, t)), s), b); }
    function ff(a, b, c, d, x, s, t) { return cmn((b & c) | (~b & d), a, b, x, s, t); }
    function gg(a, b, c, d, x, s, t) { return cmn((b & d) | (c & ~d), a, b, x, s, t); }
    function hh(a, b, c, d, x, s, t) { return cmn(b ^ c ^ d, a, b, x, s, t); }
    function ii(a, b, c, d, x, s, t) { return cmn(c ^ (b | ~d), a, b, x, s, t); }
    var bytes = toBytes(String(str));
    var len = bytes.length;
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    var bitLen = len * 8;
    bytes.push(bitLen & 0xff, (bitLen >>> 8) & 0xff, (bitLen >>> 16) & 0xff, (bitLen >>> 24) & 0xff, 0, 0, 0, 0);
    var a = 1732584193, b = -271733879, c = -1732584194, d = 271733878;
    for (var i = 0; i < bytes.length; i += 64) {
      var x = [];
      for (var j = 0; j < 64; j += 4) x[j >> 2] = bytes[i + j] | (bytes[i + j + 1] << 8) | (bytes[i + j + 2] << 16) | (bytes[i + j + 3] << 24);
      var oa = a, ob = b, oc = c, od = d;
      a = ff(a, b, c, d, x[0], 7, -680876936); d = ff(d, a, b, c, x[1], 12, -389564586); c = ff(c, d, a, b, x[2], 17, 606105819); b = ff(b, c, d, a, x[3], 22, -1044525330);
      a = ff(a, b, c, d, x[4], 7, -176418897); d = ff(d, a, b, c, x[5], 12, 1200080426); c = ff(c, d, a, b, x[6], 17, -1473231341); b = ff(b, c, d, a, x[7], 22, -45705983);
      a = ff(a, b, c, d, x[8], 7, 1770035416); d = ff(d, a, b, c, x[9], 12, -1958414417); c = ff(c, d, a, b, x[10], 17, -42063); b = ff(b, c, d, a, x[11], 22, -1990404162);
      a = ff(a, b, c, d, x[12], 7, 1804603682); d = ff(d, a, b, c, x[13], 12, -40341101); c = ff(c, d, a, b, x[14], 17, -1502002290); b = ff(b, c, d, a, x[15], 22, 1236535329);
      a = gg(a, b, c, d, x[1], 5, -165796510); d = gg(d, a, b, c, x[6], 9, -1069501632); c = gg(c, d, a, b, x[11], 14, 643717713); b = gg(b, c, d, a, x[0], 20, -373897302);
      a = gg(a, b, c, d, x[5], 5, -701558691); d = gg(d, a, b, c, x[10], 9, 38016083); c = gg(c, d, a, b, x[15], 14, -660478335); b = gg(b, c, d, a, x[4], 20, -405537848);
      a = gg(a, b, c, d, x[9], 5, 568446438); d = gg(d, a, b, c, x[14], 9, -1019803690); c = gg(c, d, a, b, x[3], 14, -187363961); b = gg(b, c, d, a, x[8], 20, 1163531501);
      a = gg(a, b, c, d, x[13], 5, -1444681467); d = gg(d, a, b, c, x[2], 9, -51403784); c = gg(c, d, a, b, x[7], 14, 1735328473); b = gg(b, c, d, a, x[12], 20, -1926607734);
      a = hh(a, b, c, d, x[5], 4, -378558); d = hh(d, a, b, c, x[8], 11, -2022574463); c = hh(c, d, a, b, x[11], 16, 1839030562); b = hh(b, c, d, a, x[14], 23, -35309556);
      a = hh(a, b, c, d, x[1], 4, -1530992060); d = hh(d, a, b, c, x[4], 11, 1272893353); c = hh(c, d, a, b, x[7], 16, -155497632); b = hh(b, c, d, a, x[10], 23, -1094730640);
      a = hh(a, b, c, d, x[13], 4, 681279174); d = hh(d, a, b, c, x[0], 11, -358537222); c = hh(c, d, a, b, x[3], 16, -722521979); b = hh(b, c, d, a, x[6], 23, 76029189);
      a = hh(a, b, c, d, x[9], 4, -640364487); d = hh(d, a, b, c, x[12], 11, -421815835); c = hh(c, d, a, b, x[15], 16, 530742520); b = hh(b, c, d, a, x[2], 23, -995338651);
      a = ii(a, b, c, d, x[0], 6, -198630844); d = ii(d, a, b, c, x[7], 10, 1126891415); c = ii(c, d, a, b, x[14], 15, -1416354905); b = ii(b, c, d, a, x[5], 21, -57434055);
      a = ii(a, b, c, d, x[12], 6, 1700485571); d = ii(d, a, b, c, x[3], 10, -1894986606); c = ii(c, d, a, b, x[10], 15, -1051523); b = ii(b, c, d, a, x[1], 21, -2054922799);
      a = ii(a, b, c, d, x[8], 6, 1873313359); d = ii(d, a, b, c, x[15], 10, -30611744); c = ii(c, d, a, b, x[6], 15, -1560198380); b = ii(b, c, d, a, x[13], 21, 1309151649);
      a = ii(a, b, c, d, x[4], 6, -145523070); d = ii(d, a, b, c, x[11], 10, -1120210379); c = ii(c, d, a, b, x[2], 15, 718787259); b = ii(b, c, d, a, x[9], 21, -343485551);
      a = au(a, oa); b = au(b, ob); c = au(c, oc); d = au(d, od);
    }
    function hex(n) { var s = ''; for (var k = 0; k < 4; k++) s += ('0' + ((n >> (k * 8)) & 0xff).toString(16)).slice(-2); return s; }
    return hex(a) + hex(b) + hex(c) + hex(d);
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function ts() { var d = new Date(); return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  // 记住“刚锁到的那笔订单”，这样跳到确认页后脚本还知道是你刚抢到的那单
  var PAY_KEY = 'sgt.pendingPay';
  function savePending(o) { try { localStorage.setItem(PAY_KEY, JSON.stringify(o)); } catch (e) { /* 隐私模式等忽略 */ } }
  function readPending() { try { var s = localStorage.getItem(PAY_KEY); return s ? JSON.parse(s) : null; } catch (e) { return null; } }
  function patchPending(patch) {
    var p = readPending();
    if (!p) return null;
    Object.keys(patch).forEach(function (k) { p[k] = patch[k]; });
    savePending(p);
    return p;
  }
  function median(arr) {
    if (!arr.length) return 0;
    var a = arr.slice().sort(function (x, y) { return x - y; });
    var m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }
  // 从 {a:{b:[]}} 这种不确定的接口返回里摸出数组（抗后端改字段）
  function asArray(data, keys) {
    if (Array.isArray(data)) return data;
    if (!data || typeof data !== 'object') return [];
    var i, k;
    for (i = 0; i < keys.length; i++) {
      k = keys[i];
      if (k && Array.isArray(data[k])) return data[k];
    }
    var vals = Object.keys(data).map(function (key) { return data[key]; });
    for (i = 0; i < vals.length; i++) if (Array.isArray(vals[i])) return vals[i];
    return [];
  }

  // ---------------------------------------------------------------
  // 路由 / 参数
  // ---------------------------------------------------------------
  function query() {
    var q = {};
    var grab = function (s) {
      if (!s) return;
      new URLSearchParams(s).forEach(function (v, k) {
        if (q[k] == null || q[k] === '') q[k] = v;
      });
    };
    grab(String(location.search || '').replace(/^\?/, ''));
    var hash = String(location.hash || '');
    var qi = hash.indexOf('?');
    if (qi > -1) grab(hash.slice(qi + 1));
    return q;
  }
  function route() {
    var hash = String(location.hash || '');
    var q = query();
    var seat = hash.match(/\/ticket\/seats\/(\d+)/);
    var packSeat = hash.match(/\/package\/(?:chooseSeat|confirmSeat)/);
    var detail = hash.match(/\/ticket\/detail\/(\d+)/);
    var confirm = hash.match(/\/ticket\/confirm/);
    return {
      seatScheduleId: seat ? seat[1] : '',
      onPackageSeat: !!packSeat,
      detailProgramId: detail ? detail[1] : '',
      onConfirm: !!confirm,
      pk: q.pk || q.programKey || '',
      sk: q.sk || q.sessionKey || '',
      tradeNo: q.tradeNo || '',
    };
  }
  function onSeatPage() { return !!route().seatScheduleId; }
  function onDetailPage() { return !!route().detailProgramId; }

  // ---------------------------------------------------------------
  // 请求（完全照页面 axios 拦截器的规矩来）
  // ---------------------------------------------------------------
  var orderKey = '';
  function headers(extra) {
    var h = {
      'cmpappkey': APPKEY,
      'lang': 'zh-CN',
      'sourcepage': String(location.pathname || '') + String(location.hash || ''),
      'content-type': 'application/x-www-form-urlencoded;charset=utf-8',
    };
    if (orderKey) {
      h['orderKey'] = orderKey;
      h['feat'] = md5('H5' + APPKEY + orderKey).substring(8, 24);
    }
    if (extra) Object.keys(extra).forEach(function (k) { if (extra[k]) h[k] = extra[k]; });
    return h;
  }
  async function api(path, body, extra) {
    var res = await fetch(path, {
      method: 'POST',
      headers: headers(extra),
      body: new URLSearchParams(body || {}).toString(),
      credentials: 'same-origin',
    });
    var ok = res.headers.get('orderKey') || res.headers.get('orderkey') || res.headers.get('Orderkey');
    if (ok) orderKey = ok;
    var data = null;
    try { data = await res.json(); } catch (e) { throw new Error('接口没返回 JSON（HTTP ' + res.status + '）：' + path); }
    if (res.status === 401 || (data && String(data.errcode) === '1203')) {
      var e2 = new Error('未登录/登录已过期（' + (data && data.msg || 'HTTP 401') + '）——请在官网登录后再运行脚本。');
      e2.needLogin = true;
      throw e2;
    }
    return data;
  }

  // ---------------------------------------------------------------
  // 状态
  // ---------------------------------------------------------------
  var STATE = {
    ok: false,
    scheduleId: '',
    programId: '',
    schedule: {},          // { checkcard, programId, ... }
    venueAreaMap: {},      // { venueAreaId: "一楼 1区" }
    priceById: {},         // ticketPriceId -> { price, colorStr }
    priceList: [],
    groups: [],            // [{ ticketPriceId, venueAreaId, seats:[{row,col,key}] }]
    certs: [],
    member: null,
    lastError: '',
  };
  function resetState() {
    STATE.ok = false; STATE.schedule = {}; STATE.venueAreaMap = {};
    STATE.priceById = {}; STATE.priceList = []; STATE.groups = []; STATE.lastError = '';
  }
  function needCert() { return String(STATE.schedule && STATE.schedule.checkcard || '').toUpperCase() === 'Y'; }
  function areaNameOf(venueAreaId) {
    var m = STATE.venueAreaMap || {};
    var v = m[String(venueAreaId)];
    if (v == null) {
      var key = Object.keys(m).find(function (k) { return String(k) === String(venueAreaId); });
      v = key != null ? m[key] : null;
    }
    return v == null ? String(venueAreaId == null ? '' : venueAreaId) : String(v);
  }

  // ---------------------------------------------------------------
  // 读数据
  // ---------------------------------------------------------------
  function skExtra() { var r = route(); return r.sk ? { sessionKey: r.sk } : null; }
  function pkExtra() { var r = route(); return r.pk ? { programKey: r.pk } : null; }

  function normPrices(data) {
    var list = asArray(data, ['', 'priceList', 'list', 'prices']);
    var byId = {}, out = [];
    list.forEach(function (p) {
      if (!p || typeof p !== 'object') return;
      var id = p.ticketPriceId != null ? p.ticketPriceId : p.id;
      if (id == null) return;
      var price = p.price != null ? p.price : (p.salePrice != null ? p.salePrice : p.originalPrice);
      var rec = { id: String(id), price: Number(price), colorStr: p.colorStr || p.color || '', raw: p };
      byId[rec.id] = rec; out.push(rec);
    });
    return { byId: byId, list: out };
  }

  function parseSeatEntry(s) {
    if (s == null) return null;
    if (Array.isArray(s)) return { row: Number(s[0]), col: Number(s[1]) };
    if (typeof s === 'object') return { row: Number(s.rowNo), col: Number(s.colNo) };
    var str = String(s).trim();
    if (!str) return null;
    var m = str.match(/^(\d+)\s*[:\-_|,]\s*(\d+)$/);
    if (m) return { row: Number(m[1]), col: Number(m[2]) };
    return null;
  }

  // getAvailableSeats -> [{ticketPriceId, venueAreaId, seats:"12:3,12:4"}]
  function normGroups(data) {
    var list = asArray(data, ['', 'seatList', 'list', 'seats']);
    var out = [];
    list.forEach(function (g) {
      if (!g || typeof g !== 'object') return;
      var raw = g.seats != null ? g.seats : g.seatList;
      var arr = Array.isArray(raw) ? raw : (raw == null ? [] : String(raw).split(','));
      var seats = [];
      arr.forEach(function (s) {
        var p = parseSeatEntry(s);
        if (!p || !isFinite(p.row) || !isFinite(p.col)) return;
        seats.push({
          key: p.row + ':' + p.col, row: p.row, col: p.col,
          ticketPriceId: String(g.ticketPriceId),
          ticketPriceIdRaw: g.ticketPriceId,     // 送接口时用原始类型（数字就是数字）
          venueAreaId: g.venueAreaId != null ? g.venueAreaId : g.venueId,
          colorStr: g.colorStr || '',
        });
      });
      if (!seats.length) return;
      out.push({
        ticketPriceId: String(g.ticketPriceId),
        venueAreaId: g.venueAreaId != null ? g.venueAreaId : g.venueId,
        colorStr: g.colorStr || '',
        seats: seats,
      });
    });
    return out;
  }

  async function loadScheduleInfo() {
    var r = route();
    if (!r.seatScheduleId) throw new Error('当前页面不是选座页（URL 里没有 #/ticket/seats/<id>）');
    var info = await api(API.scheduleInfo, { scheduleId: r.seatScheduleId }, skExtra());
    if (!info || !info.success) throw new Error('getScheduleInfo 失败：' + ((info && info.msg) || '未知错误'));
    STATE.scheduleId = r.seatScheduleId;
    STATE.schedule = info.data.schedule || {};
    STATE.venueAreaMap = info.data.venueAreaMap || {};
    STATE.programId = STATE.schedule.programId || r.detailProgramId || '';
    return info.data;
  }
  async function loadPrices() {
    var res = await api(API.prices, { scheduleId: STATE.scheduleId }, skExtra());
    if (!res || !res.success) throw new Error('getSchedulePrices 失败：' + ((res && res.msg) || '未知错误'));
    var norm = normPrices(res.data);
    STATE.priceById = norm.byId; STATE.priceList = norm.list;
    return norm.list;
  }
  async function loadAvail() {
    var res = await api(API.avail, { scheduleId: STATE.scheduleId }, skExtra());
    if (!res || !res.success) throw new Error('getAvailableSeats 失败：' + ((res && res.msg) || '未知错误'));
    STATE.groups = normGroups(res.data);
    return STATE.groups;
  }
  async function loadCerts() {
    if (STATE.certs.length) return STATE.certs;
    try {
      var res = await api(API.certs, {});
      var list = res && res.success ? asArray(res.data, ['resultList', 'list', '']) : [];
      STATE.certs = list || [];
    } catch (e) { warn('取实名信息失败：', e.message || e); STATE.certs = []; }
    return STATE.certs;
  }
  async function loadMember() {
    if (STATE.member) return STATE.member;
    try {
      var res = await api(API.member, { showToast: 'N' });
      if (res && res.success) STATE.member = res.data || {};
    } catch (e) { warn('取会员信息失败（不影响抢座）：', e.message || e); }
    return STATE.member;
  }

  async function reload() {
    resetState();
    try {
      await loadScheduleInfo();
      await loadPrices();
      await loadAvail();
      await loadCerts();
      await loadMember();
      STATE.ok = true;
      log('数据就绪：场次 ' + STATE.scheduleId + (STATE.programId ? '（节目 ' + STATE.programId + '）' : '')
        + '，价位 ' + STATE.priceList.length + ' 档，可售座位组 ' + STATE.groups.length
        + '，' + (needCert() ? '实名场次（checkcard=Y）' : '非实名场次'));
      return true;
    } catch (e) {
      STATE.lastError = e && e.message ? e.message : String(e);
      err('加载失败：' + STATE.lastError);
      if (e && e.needLogin) log('→ 请在同一个浏览器里登录 www.shgtheatre.com，再回到选座页刷新。');
      return false;
    }
  }
  async function refreshAvailOnly() {
    try { await loadAvail(); return true; } catch (e) { warn('刷新余票失败：', e.message || e); return false; }
  }

  // ---------------------------------------------------------------
  // 选座
  // ---------------------------------------------------------------
  function priceOf(ticketPriceId) {
    var p = STATE.priceById[String(ticketPriceId)];
    return p ? p.price : null;
  }
  function areaHit(areas, name) {
    if (!areas || !areas.length) return true;   // 空 = 不限
    var nm = String(name || '').toUpperCase();
    return areas.some(function (a) {
      var s = String(a).trim();
      if (!s) return true;
      if (/^[A-Za-z]$/.test(s)) {
        // 单字母：按 “X区” 匹配（也容忍 “X 区”“X区 单号” 这类写法）
        return new RegExp('(^|[^A-Z0-9])' + s.toUpperCase() + '\\s*区').test(nm + '区');
      }
      return nm.indexOf(s.toUpperCase()) > -1;
    });
  }
  function rowRankMap(rows) {
    var pref = String(CONFIG.rowPreference || 'middle').toLowerCase();
    var asc = rows.slice().sort(function (a, b) { return a - b; });
    var order;
    if (pref === 'front') order = asc;
    else if (pref === 'back') order = asc.slice().reverse();
    else {
      // 中间排优先：从中间往两头扩散（同距离时靠前的排优先）
      var midIdx = (asc.length - 1) / 2;
      order = asc.map(function (r, i) { return { r: r, d: Math.abs(i - midIdx) }; })
        .sort(function (x, y) { return x.d - y.d || x.r - y.r; })
        .map(function (x) { return x.r; });
    }
    var map = {};
    order.forEach(function (r, i) { map[r] = i; });
    return map;
  }
  function rowsOf(group) {
    var map = {};
    group.seats.forEach(function (s) { (map[s.row] = map[s.row] || []).push(s); });
    Object.keys(map).forEach(function (k) { map[k].sort(function (a, b) { return a.col - b.col; }); });
    return map;
  }

  // 同排连坐：返回本组内最优的若干候选
  function picksSameRow(group, qty, ranks, areaIdx) {
    var rows = rowsOf(group), out = [];
    Object.keys(rows).map(Number).forEach(function (row) {
      var cols = rows[row], mid = median(cols.map(function (s) { return s.col; }));
      var i = 0;
      while (i < cols.length) {
        var j = i;
        while (j + 1 < cols.length && cols[j + 1].col === cols[j].col + 1) j++;
        var run = cols.slice(i, j + 1);
        if (run.length >= qty) {
          var best = null;
          for (var s0 = 0; s0 + qty <= run.length; s0++) {
            var sub = run.slice(s0, s0 + qty);
            var center = (sub[0].col + sub[sub.length - 1].col) / 2;
            var score = Math.abs(center - mid);
            if (!best || score < best.score) best = { score: score, seats: sub };
          }
          out.push({
            tier: 1, tierName: '同排连坐', group: group, areaIdx: areaIdx,
            rows: [row], seats: best.seats,
            score: (ranks[row] == null ? 999 : ranks[row]) * 1000 + best.score,
          });
        }
        i = j + 1;
      }
    });
    return out;
  }

  // 上下排相邻（同一列附近的连续排）
  function picksStacked(group, qty, ranks, areaIdx) {
    if (qty < 2) return [];
    var rows = rowsOf(group), out = [];
    var rowNums = Object.keys(rows).map(Number).sort(function (a, b) { return a - b; });
    for (var ri = 0; ri + qty - 1 < rowNums.length; ri++) {
      var seq = rowNums.slice(ri, ri + qty);
      var contiguousRows = seq.every(function (r, i) { return i === 0 || r === seq[i - 1] + 1; });
      if (!contiguousRows) continue;
      var first = rows[seq[0]];
      for (var ci = 0; ci < first.length; ci++) {
        var col = first[ci].col, seats = [first[ci]], ok = true;
        for (var k = 1; k < qty; k++) {
          var cand = rows[seq[k]].filter(function (s) { return Math.abs(s.col - col) <= 1; });
          if (!cand.length) { ok = false; break; }
          seats.push(cand[0]);
        }
        if (!ok) continue;
        var avgRank = seq.reduce(function (a, r) { return a + (ranks[r] == null ? 999 : ranks[r]); }, 0) / qty;
        out.push({
          tier: 2, tierName: '上下排相邻', group: group, areaIdx: areaIdx,
          rows: seq, seats: seats, score: avgRank * 1000 + col / 100,
        });
      }
    }
    return out;
  }

  // 散座兜底：同区域内凑不满连坐时，挑最靠中间/最靠优选的 qty 个
  function picksLoose(group, qty, ranks, areaIdx) {
    var rows = rowsOf(group), all = [];
    Object.keys(rows).map(Number).forEach(function (row) {
      var cols = rows[row], mid = median(cols.map(function (s) { return s.col; }));
      cols.forEach(function (s) {
        all.push({
          tier: 3, tierName: '散座', group: group, areaIdx: areaIdx, rows: [row], seats: [s],
          score: (ranks[row] == null ? 999 : ranks[row]) * 1000 + Math.abs(s.col - mid),
        });
      });
    });
    all.sort(function (a, b) { return a.score - b.score; });
    if (all.length < qty) return [];
    var seats = all.slice(0, qty);
    return [{
      tier: 3, tierName: '散座', group: group, areaIdx: areaIdx,
      rows: seats.map(function (s) { return s.seats[0].row; }),
      seats: seats.map(function (s) { return s.seats[0]; }),
      score: seats[seats.length - 1].score,
    }];
  }

  // 某条规则的全部候选（按 区域顺序 → 连坐优先 → 排/居中程度 排序）
  function candidatesFor(rule) {
    var qty = Number(rule.qty) || 1;
    var groups = STATE.groups.filter(function (g) {
      var p = priceOf(g.ticketPriceId);
      if (p == null && g.price != null) p = Number(g.price);
      if (p == null) return false;
      if (Number(p) !== Number(rule.price)) return false;
      return areaHit(rule.areas, areaNameOf(g.venueAreaId));
    });
    if (!groups.length) return [];
    // 区域顺序：按 rule.areas 里出现的位置；不限区域时按区域名稳定排序
    var names = groups.map(function (g) { return areaNameOf(g.venueAreaId); });
    var uniq = names.filter(function (n, i) { return names.indexOf(n) === i; });
    function areaIdx(g) {
      var name = areaNameOf(g.venueAreaId).toUpperCase();
      var areas = (rule.areas && rule.areas.length) ? rule.areas : uniq;
      for (var i = 0; i < areas.length; i++) {
        var a = String(areas[i]).trim().toUpperCase();
        var hit = /^[A-Z]$/.test(a) ? new RegExp('(^|[^A-Z0-9])' + a + '\\s*区').test(name + '区') : name.indexOf(a) > -1;
        if (hit) return i;
      }
      return 99;
    }
    var out = [];
    groups.forEach(function (g) {
      var ai = areaIdx(g);
      var rows = Object.keys(rowsOf(g)).map(Number);
      var ranks = rowRankMap(rows);
      out = out.concat(picksSameRow(g, qty, ranks, ai));
      out = out.concat(picksStacked(g, qty, ranks, ai));
      out = out.concat(picksLoose(g, qty, ranks, ai));   // 兜底，排序时排最后
    });
    out.sort(function (a, b) {
      if (a.areaIdx !== b.areaIdx) return a.areaIdx - b.areaIdx;
      if (a.tier !== b.tier) return a.tier - b.tier;
      return a.score - b.score;
    });
    return out;
  }

  function describe(cand) {
    var byArea = {};
    cand.seats.forEach(function (s) {
      var n = areaNameOf(s.venueAreaId);
      (byArea[n] = byArea[n] || []).push(s.row + '排' + s.col + '座');
    });
    var price = priceOf(cand.seats[0].ticketPriceId);
    var kind = cand.seats.length === 1 ? '单座' : cand.tierName;
    return Object.keys(byArea).map(function (n) { return n + ' ' + byArea[n].join('、'); }).join(' | ')
      + '（￥' + price + ' × ' + cand.seats.length + '，' + kind + '）';
  }

  // ---------------------------------------------------------------
  // 下单（= 真正锁座）
  // ---------------------------------------------------------------
  function certForIndex(i) {
    var ids = (CONFIG.certificationIds || []).map(String);
    if (ids.length) {
      var want = ids[Math.min(i, ids.length - 1)];
      var hit = STATE.certs.filter(function (c) { return String(c.id) === want; })[0];
      if (hit) return hit;
    }
    return STATE.certs[i] || STATE.certs[0] || null;
  }
  async function submitOrder(cand) {
    if (needCert() && !STATE.certs.length) {
      var eFatal = new Error('这场是实名场次(checkcard=Y)，但账号里没有可用实名信息：请先在官网“个人中心-实名信息”添加，'
        + '或把 config.yaml 的 certificationIds 填上（选座页点“自检”可看到实名 id）。');
      eFatal.fatal = true;
      throw eFatal;
    }
    var seats = cand.seats.map(function (s, i) {
      var o = {
        venueAreaId: s.venueAreaId != null ? s.venueAreaId : '',
        rowNo: s.row,
        colNo: s.col,
        ticketPrice: priceOf(s.ticketPriceId),
        ticketPriceId: s.ticketPriceIdRaw != null ? s.ticketPriceIdRaw : s.ticketPriceId,
      };
      if (needCert()) {
        var cert = certForIndex(i);
        if (cert && cert.id != null) o.certificationId = cert.id;
      }
      return o;
    });
    var member = await loadMember();
    var mobile = CONFIG.mobile || (member && (member.mobile || member.phone)) || '';
    var req = { scheduleId: STATE.scheduleId, platform: 'PC', seats: seats };
    if (mobile) req.mobile = mobile;
    var body = { createOrderReq: JSON.stringify(req) };
    log('提交下单：', JSON.stringify(req));
    var res = await api(API.create, body, skExtra());
    return { res: res, req: req };
  }

  // ---------------------------------------------------------------
  // 对外命令
  // ---------------------------------------------------------------
  var SGT = {};
  SGT.config = CONFIG;
  SGT.state = STATE;

  SGT.reload = function () { return reload(); };

  SGT.inventory = function () {
    if (!STATE.ok) { log('还没加载数据，先 SGT.reload()'); return; }
    var table = {};
    STATE.groups.forEach(function (g) {
      var n = areaNameOf(g.venueAreaId) + ' | ￥' + priceOf(g.ticketPriceId);
      table[n] = (table[n] || 0) + g.seats.length;
    });
    var rows = Object.keys(table).map(function (k) { return { 区域: k, 余票: table[k] }; }).sort(function (a, b) { return b.余票 - a.余票; });
    console.table(rows);
    log('合计可售座位 ' + STATE.groups.reduce(function (a, g) { return a + g.seats.length; }, 0) + ' 个');
  };

  SGT.plan = function () {
    if (!STATE.ok) { log('还没加载数据，先 SGT.reload()'); return; }
    var rules = CONFIG.rules || [];
    if (!rules.length) { warn('config.yaml 里没有 rules'); return; }
    var out = [];
    rules.forEach(function (r, i) {
      var cs = candidatesFor(r);
      out.push({
        规则: '#' + (i + 1),
        要求: '￥' + r.price + ' × ' + r.qty + (r.areas && r.areas.length ? ' · 区域 ' + r.areas.join('>') : ' · 不限区域'),
        命中: cs.length ? describe(cs[0]) : '无（该价位/区域凑不齐 ' + r.qty + ' 张）',
        备选数: cs.length,
      });
    });
    console.table(out);
    var first = rules.map(candidatesFor).find(function (cs) { return cs.length; });
    if (first) log('预演结果：会下单 → ' + describe(first[0]));
    else warn('预演结果：所有规则都凑不齐座位。可点“库存/自检”看真实价位与区域，再改 config.yaml。');
    return out;
  };

  var RUNNING = false;
  SGT.run = async function () {
    if (RUNNING) { warn('正在跑，别重复点'); return { success: false, busy: true }; }
    if (!onSeatPage()) { warn('当前不在选座页（URL 里要有 #/ticket/seats/<id>）'); return { success: false, reason: 'not-on-seat-page' }; }
    RUNNING = true;
    try {
      if (!STATE.ok) {
        var okLoad = await reload();
        if (!okLoad) return { success: false, reason: 'load-failed', error: STATE.lastError };
      }
      var rules = CONFIG.rules || [];
      if (!rules.length) { warn('config.yaml 里没有 rules'); return { success: false, reason: 'no-rules' }; }
      var attempts = Math.max(1, Number(CONFIG.maxRetry) || 1);
      var dry = !!CONFIG.dryRun || CONFIG.submitOrder === false;
      for (var attempt = 0; attempt < attempts; attempt++) {
        if (attempt > 0) {
          log('第 ' + (attempt + 1) + '/' + attempts + ' 轮：刷新库存后重挑');
          await refreshAvailOnly();
        }
        for (var i = 0; i < rules.length; i++) {
          var cs = candidatesFor(rules[i]);
          if (!cs.length) { warn('规则#' + (i + 1) + '（￥' + rules[i].price + ' × ' + rules[i].qty + '）凑不齐，跳过'); continue; }
          var cand = cs[0];
          if (cs.length > 1) log('规则#' + (i + 1) + ' 有 ' + cs.length + ' 种挑法，首选：' + describe(cand));
          if (dry) {
            log('%c【预演】会锁定 → ' + describe(cand), 'color:#e5533c;font-weight:bold');
            if (cand.seats.length < Number(rules[i].qty)) warn('注意：只凑到 ' + cand.seats.length + '/' + rules[i].qty + ' 张');
            return { success: true, planned: true, pick: cand };
          }
          log('锁定 → ' + describe(cand));
          var r;
          try { r = await submitOrder(cand); }
          catch (e) {
            err('下单异常：' + (e.message || e));
            if (e.needLogin) { STATE.lastError = e.message; return { success: false, reason: 'need-login', error: e.message }; }
            if (e.fatal) return { success: false, reason: 'fatal', error: e.message };
            continue;
          }
          var res = r.res;
          if (res && res.success) {
            // 有的版本会回对象，稳妥起见都兼容
            var tradeNo = (res.data && typeof res.data === 'object')
              ? (res.data.tradeNo || res.data.orderNo || res.data.outTradeNo || '')
              : res.data;
            var url = location.origin + '/shtheatre/index.html#/ticket/confirm?tradeNo=' + encodeURIComponent(tradeNo)
              + (STATE.programId ? '&programId=' + encodeURIComponent(STATE.programId) : '');
            savePending({ tradeNo: String(tradeNo), programId: STATE.programId, url: url, ts: Date.now(), advancedAt: 0 });
            console.log('%c[SGT] ✅ 抢到并锁座成功！订单号 ' + tradeNo, 'color:#fff;background:#0a0;padding:2px 6px;border-radius:4px;font-weight:bold');
            log('座位已经被这笔订单占住了，但“锁座”不等于“付款”：还要在确认页点一次「确认支付」才会出现付款码。');
            log('→ 立刻去付款（通常 15 分钟内有效）：' + url);
            log('（付款永远手动：脚本最多帮你点到二维码，扫不扫、付不付由你决定）');
            SGT.lastOrder = { tradeNo: tradeNo, url: url, pick: cand };
            if (CONFIG.jumpToConfirm || CONFIG.autoAdvanceToPay) {
              log('跳转到确认页：' + url);
              location.hash = '#/ticket/confirm?tradeNo=' + encodeURIComponent(tradeNo) + (STATE.programId ? '&programId=' + STATE.programId : '');
            }
            return { success: true, tradeNo: tradeNo, url: url, pick: cand };
          }
          var code = res && res.errcode;
          warn('下单被拒：[' + code + '] ' + ((res && res.msg) || '未知原因'));
          if (String(code) === '1121' || /未支付/.test(String(res && res.msg))) {
            warn('你有一笔未支付订单，必须先取消或支付后才能再下。→ 我的订单：' + location.origin + '/shtheatre/index.html#/mine?orderType=ticket&status=1');
            return { success: false, reason: 'unpaid-order', res: res };
          }
          // 否则多为“座位已被抢”，刷新库存后重试
        }
      }
      warn('已试满 ' + attempts + ' 轮仍未锁到。建议：放宽 rules（加更多价位/区域/少买几张）或稍后手动再试。');
      return { success: false, reason: 'exhausted' };
    } finally {
      RUNNING = false;
    }
  };

  SGT.releaseInfo = function () {
    log('锁座成功后生成的是“待付款订单”，座位由订单持有；不要了就去 “我的-我的订单” 点取消订单，或等超时自动释放。');
    log('订单页：' + location.origin + '/shtheatre/index.html#/mine?orderType=ticket&status=1');
  };

  // 自检：把所有关键信息一次打印（只读接口，安全）
  SGT.diag = async function () {
    var r = route();
    var out = { when: ts(), href: location.href, route: r, loggedIn: null, scheduleId: '', programName: '', checkcard: null, areas: [], prices: [], inventory: [], certs: [], errors: [] };
    log('自检开始…（只读接口，不会下单）');
    try {
      var m = await api(API.member, { showToast: 'N' });
      out.loggedIn = !!(m && m.success);
      if (!out.loggedIn) out.errors.push('会员信息接口：' + ((m && m.msg) || '未登录'));
    } catch (e) { out.loggedIn = false; out.errors.push('会员信息接口异常：' + (e.message || e)); }
    if (!r.seatScheduleId) {
      out.errors.push('当前不是选座页；请在选座页执行自检（详情页可先点某场次进入选座页）。');
    } else {
      try {
        var info = await loadScheduleInfo();
        out.scheduleId = STATE.scheduleId;
        out.checkcard = STATE.schedule.checkcard;
        out.programName = (info.schedule && (info.schedule.cnName || info.schedule.programName)) || '';
        out.areas = Object.keys(STATE.venueAreaMap).map(function (k) { return k + ' = ' + STATE.venueAreaMap[k]; });
        if (info.seatPlan) out.seatPlan = { name: info.seatPlan.name, planType: info.seatPlan.planType, hasBg: !!(info.seatPlan.background || info.seatPlan.publishUrl) };
      } catch (e) { out.errors.push('getScheduleInfo：' + (e.message || e)); }
      try {
        var prices = await loadPrices();
        out.prices = prices.map(function (p) { return p.id + ' = ￥' + p.price; });
        out._pricesRaw0 = prices[0] ? Object.keys(prices[0].raw) : [];
      } catch (e) { out.errors.push('getSchedulePrices：' + (e.message || e)); }
      try {
        var groups = await loadAvail();
        out._groupsRaw0 = groups[0] ? groups[0] : null;
        var agg = {};
        groups.forEach(function (g) {
          var n = areaNameOf(g.venueAreaId) + ' | ￥' + priceOf(g.ticketPriceId);
          agg[n] = (agg[n] || 0) + g.seats.length;
        });
        out.inventory = Object.keys(agg).sort().map(function (k) { return k + ' → ' + agg[k] + ' 座'; });
      } catch (e) { out.errors.push('getAvailableSeats：' + (e.message || e)); }
      try {
        var certs = await loadCerts();
        out.certs = (certs || []).map(function (c) { return c.id + ' = ' + (c.realname || c.contactName || '') + ' ' + (c.certificateNo || ''); });
      } catch (e) { out.errors.push('getCertificationList：' + (e.message || e)); }
    }
    console.log('%c[SGT-DIAG] 下面是自检结果（可整段复制发给别人看）', 'color:#08f;font-weight:bold');
    console.log(JSON.stringify(out, null, 2));
    showText('SGT 自检结果（复制这段发我）', JSON.stringify(out, null, 2));
    log('自检结束。' + (out.errors.length ? '有 ' + out.errors.length + ' 条异常，见 errors 字段。' : '没有异常。'));
    return out;
  };

  // ---------------------------------------------------------------
  // 开票监控（用在“演出详情页”）
  // ---------------------------------------------------------------
  var srvOffset = 0;
  function nowMs() { return Date.now() + srvOffset; }
  async function syncServerTime() {
    try {
      var res = await api(API.serverTime, {});
      if (res && res.success && res.data) {
        var t = Date.parse(String(res.data).replace(' ', 'T'));
        if (!isNaN(t)) srvOffset = t - Date.now();
      }
    } catch (e) { /* 用本机时间兜底 */ }
  }
  function watchEnabled() { return !!(CONFIG.watch && CONFIG.watch.enabled); }
  function sessionMatch(s) {
    var w = CONFIG.watch || {};
    if (w.sessionId) return String(s.id) === String(w.sessionId);
    var pt = String(s.playTime || s.showTime || s.startTime || '');
    if (w.date && pt.indexOf(String(w.date)) !== 0) return false;
    if (w.time && pt.indexOf(String(w.time)) === -1) return false;
    return !!(w.date || w.time);
  }
  function sessionBuyable(s) {
    if (String(s.available || 'Y').toUpperCase() === 'N') return false;
    if (String(s.showStatus || 'Y').toUpperCase() === 'N') return false;
    return true;
  }
  var WATCH = { timer: null, entered: false, key: '', busy: false };
  async function watchOnce() {
    var r = route();
    if (!r.detailProgramId || WATCH.entered) return null;
    var prog = await api(API.program, { programId: r.detailProgramId });
    var pk = (prog && prog.success && prog.data && prog.data.programKey) || r.pk || '';
    // 注意：官网前端会把 programKey 从参数搬到请求头，这里照做
    var res = await api(API.schedules, { programId: r.detailProgramId, date: (CONFIG.watch && CONFIG.watch.date) || '', action: 'commit' }, pk ? { programKey: pk } : null);
    if (!res || !res.success) { setStatus('监控中：场次接口 ' + ((res && res.msg) || '异常') + '，重试中…'); return null; }
    var list = asArray(res.data, ['', 'list']);
    if (!WATCH.logged) {
      WATCH.logged = true;
      console.table(list.map(function (s) {
        return { id: s.id, 时间: s.playTime || s.showTime || '', 可售: s.available, 状态: s.showStatus, sk: s.sessionKey || '', 限购: s.maxBuyLimit };
      }));
    }
    var hit = list.filter(sessionMatch).filter(sessionBuyable)[0];
    if (!hit) {
      var soon = list.filter(sessionMatch)[0];
      setStatus('监控中：目标场次还没开卖' + (soon ? '（' + (soon.playTime || '') + ' available=' + soon.available + ' status=' + soon.showStatus + '）' : '（未找到符合条件的场次）'));
      return null;
    }
    WATCH.entered = true;
    var sk = hit.sessionKey || '';
    var url = '#/ticket/seats/' + hit.id + '?pk=' + encodeURIComponent(pk) + (sk ? '&sk=' + encodeURIComponent(sk) : '');
    console.log('%c[SGT] 🎯 目标场次开卖，自动进入选座页',
      'color:#fff;background:#e5533c;padding:2px 6px;border-radius:4px;font-weight:bold', hit.playTime || '', url);
    setStatus('已进入选座页，等待抢座…');
    location.hash = url;
    return hit;
  }
  function scheduleWatch(delay) {
    if (!watchEnabled()) return;
    if (WATCH.timer) clearTimeout(WATCH.timer);
    WATCH.timer = setTimeout(watchStep, delay == null ? (Number(CONFIG.watch.pollMs) || 800) : delay);
  }

  // 手动查一次（详情页调试监控用）：SGT.watchCheck()
  SGT.watchCheck = async function () {
    if (!watchEnabled()) { warn('config.yaml 里 watch.enabled 还是 false，先打开它并重新 ./build.sh build'); return null; }
    if (!onDetailPage()) { warn('请到“演出详情页”再查（URL 形如 #/ticket/detail/<id>）'); return null; }
    await syncServerTime();
    return watchOnce();
  };
  function watchStep() {
    if (!watchEnabled() || !onDetailPage()) { return; }
    var key = route().detailProgramId;
    if (key !== WATCH.key) { WATCH.key = key; WATCH.entered = false; }
    if (CONFIG.watch.startAt) {
      var start = Date.parse(String(CONFIG.watch.startAt).replace(' ', 'T'));
      if (!isNaN(start) && nowMs() < start) {
        var left = Math.ceil((start - nowMs()) / 1000);
        setStatus('监控：距离开抢还有 ' + left + ' 秒（' + CONFIG.watch.startAt + '）');
        scheduleWatch(left > 60 ? 5000 : 500);
        return;
      }
    }
    if (WATCH.busy) { scheduleWatch(300); return; }
    WATCH.busy = true;
    watchOnce().then(function () { WATCH.busy = false; scheduleWatch(); }, function (e) {
      WATCH.busy = false;
      setStatus('监控出错：' + (e.message || e) + '，继续重试…');
      scheduleWatch(1500);
    });
  }

  // ---------------------------------------------------------------
  // 锁座之后：自动推进到支付页（最多帮你点到二维码，绝不代付）
  // 官网确认页的流程：勾“我已详细阅读并同意” → 点「确认支付」→ 订单确认 → 弹出付款方式/二维码
  // ---------------------------------------------------------------
  var PAYADV = { running: false, done: false };
  function agreementChecked() {
    var wrap = document.querySelector('.protocol-wrap');
    if (!wrap) return true;                       // 没有协议框就当已勾
    var icon = wrap.querySelector('span.iconfont');
    if (!icon) return true;
    return String(icon.className || '').indexOf('icon-radio-active') > -1;
  }
  function checkAgreement() {
    var wrap = document.querySelector('.protocol-wrap');
    if (!wrap) return false;
    var icon = wrap.querySelector('span.iconfont');
    if (!icon) return false;
    if (String(icon.className || '').indexOf('icon-radio-active') === -1) icon.click();
    return true;
  }
  function payUIOpened() {
    var sel = ['.wxPay-content', '.qr-code', '.el-overlay', '.el-dialog', '.el-message-box', '.pay-wrap', '.pay-way', '.payType'];
    for (var i = 0; i < sel.length; i++) if (document.querySelector(sel[i])) return true;
    return false;
  }
  async function maybeAutoAdvancePay() {
    if (!canDom) return;
    var r = route();
    if (!r.onConfirm || !CONFIG.autoAdvanceToPay) return;
    var p = readPending();
    if (!p || !p.tradeNo || String(p.tradeNo) !== String(r.tradeNo)) return;   // 不是脚本刚锁的那单，不碰
    if (Date.now() - Number(p.ts || 0) > 15 * 60 * 1000) { warn('这笔订单已经超过 15 分钟，不再自动点支付。'); return; }
    if (p.advancedAt && Date.now() - Number(p.advancedAt) < 10 * 60 * 1000) return;  // 已推过，别重复点
    if (PAYADV.running || PAYADV.done) return;
    PAYADV.running = true;
    try {
      log('autoAdvanceToPay：自动推进到支付页（只点到二维码，绝不代付）…');
      setStatus('自动推进支付中…');
      var waited = 0;
      while (waited < 15000 && !document.querySelector('button.confirm-btn')) { await sleep(300); waited += 300; }
      var btn = document.querySelector('button.confirm-btn');
      if (!btn) { warn('没找到「确认支付」按钮（可能订单状态已变），请自己在页面上操作。'); return; }
      for (var i = 0; i < 2; i++) {
        checkAgreement();
        await sleep(250);
        btn = document.querySelector('button.confirm-btn');
        if (!btn) { await sleep(600); continue; }
        if (btn.disabled) { await sleep(600); continue; }
        if (!agreementChecked()) { warn('协议没勾上，先帮你勾一下再点。'); checkAgreement(); await sleep(250); }
        btn.click();
        log('已点击「确认支付」' + (agreementChecked() ? '' : '（协议仍未勾上，可能被拦）'));
        patchPending({ advancedAt: Date.now() });
        await sleep(1500);
        if (payUIOpened()) {
          PAYADV.done = true;
          console.log('%c[SGT] 💳 支付界面已弹出，请选支付方式并扫码付款（脚本不会替你付款）',
            'color:#fff;background:#e5533c;padding:2px 6px;border-radius:4px;font-weight:bold');
          setStatus('支付界面已弹出，请扫码付款');
          return;
        }
      }
      PAYADV.done = true;
      warn('已点过「确认支付」，但没识别到支付弹窗。请看一眼页面：若还是确认页，再点一次；若已出现付款方式/二维码，直接付即可。');
      setStatus('已点确认支付，请看页面完成付款');
    } catch (e) {
      warn('自动推进支付出错：' + (e && e.message || e), '（不影响已锁的座位，手动点「确认支付」即可）');
    } finally {
      PAYADV.running = false;
    }
  }

  // 手动去支付：跳回刚才那笔订单的确认页
  SGT.pay = function () {
    var p = readPending();
    if (!p || !p.url) { warn('没记录到刚锁的订单。可去“我的订单”里找待付款单。'); return null; }
    log('跳转到确认/支付页：' + p.url);
    location.href = p.url;
    return p;
  };

  // 便于排查/自测（无副作用）
  SGT._internal = {
    maybeAutoAdvancePay: maybeAutoAdvancePay, paymentUIOpened: payUIOpened,
    readPending: readPending, savePending: savePending, route: route, md5: md5,
  };

  // ---------------------------------------------------------------
  // 面板 + 快捷键
  // ---------------------------------------------------------------
  var canDom = typeof document !== 'undefined' && !!document.createElement;
  var statusEl = null;
  function setStatus(t) { if (statusEl) statusEl.textContent = t; }
  function routeLabel() {
    if (onSeatPage()) return STATE.ok ? '✅ 选座页就绪，可抢座' : (STATE.lastError ? '⚠️ ' + STATE.lastError : '选座页：加载中…');
    if (route().onPackageSeat) return '套票选座页暂不支持（本脚本只做单场选座）';
    if (onDetailPage()) return watchEnabled() ? '详情页：监控中…' : '详情页（可在 config.yaml 打开 watch 监控开票）';
    if (route().onConfirm) {
      var p = readPending();
      return (p && String(p.tradeNo) === String(route().tradeNo))
        ? '确认页：订单 ' + route().tradeNo + ' → 勾选协议后点「确认支付」'
        : '确认页：勾选协议后点「确认支付」';
    }
    return '未在选座页；打开选座页后就绪';
  }
  function guard(label, fn) {
    setStatus(label);
    return Promise.resolve()
      .then(fn)
      .then(function () { setStatus(routeLabel()); }, function (e) { setStatus('出错：' + (e && e.message || e)); err(e); });
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
  // 把一段文本弹成“可全选复制”的框（控制台不一定好操作，这个更直接）
  function showText(title, text) {
    if (!canDom || !document.body) { console.log('[SGT] ' + title + '\n' + text); return; }
    var old = document.getElementById('sgt-diag-box');
    if (old && old.parentNode) old.parentNode.removeChild(old);
    var wrap = document.createElement('div');
    wrap.id = 'sgt-diag-box';
    wrap.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;width:520px;max-width:92vw;background:#101a24;color:#e6e6e6;border-radius:10px;padding:10px 12px;box-shadow:0 6px 24px rgba(0,0,0,.5);font-family:system-ui,Arial;';
    var h = document.createElement('div');
    h.textContent = title;
    h.style.cssText = 'font-weight:700;font-size:13px;margin-bottom:6px;';
    var tip = document.createElement('div');
    tip.textContent = '点一下文本 → 全选 → 复制（或直接点“复制”按钮）。';
    tip.style.cssText = 'font-size:11px;color:#9ab;margin-bottom:6px;';
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.spellcheck = false;
    ta.style.cssText = 'width:100%;height:230px;box-sizing:border-box;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;line-height:1.45;background:#0b1219;color:#cfe;border:1px solid #2a3a4a;border-radius:6px;padding:6px;';
    ta.onclick = function () { ta.select(); };
    var bar = document.createElement('div');
    var copyBtn = btn('复制', '#48c', function () {
      ta.removeAttribute('readonly'); ta.focus(); ta.select();
      var done = false;
      try { done = document.execCommand('copy'); } catch (e) { done = false; }
      if (!done && navigator.clipboard) { navigator.clipboard.writeText(ta.value).catch(function () {}); }
      copyBtn.textContent = '已复制 ✓（不行就 Ctrl/Cmd+C）';
      setTimeout(function () { copyBtn.textContent = '复制'; }, 2500);
    });
    var closeBtn = btn('关闭', '#556', function () { if (wrap.parentNode) wrap.parentNode.removeChild(wrap); });
    bar.appendChild(copyBtn); bar.appendChild(closeBtn);
    wrap.appendChild(h); wrap.appendChild(tip); wrap.appendChild(ta); wrap.appendChild(bar);
    document.body.appendChild(wrap);
    ta.focus(); ta.select();
  }
  function mountPanel() {
    if (!canDom || window.__SGT_PANEL__) return;
    var box = document.createElement('div');
    box.style.cssText = 'position:fixed;left:16px;bottom:16px;z-index:2147483647;background:#22303f;color:#e6e6e6;font-family:system-ui,Arial;box-shadow:0 6px 24px rgba(0,0,0,.35);border-radius:10px;padding:10px 12px;width:250px;';
    var title = document.createElement('div');
    title.textContent = 'SGT 大剧院抢座';
    title.style.cssText = 'font-weight:700;font-size:13px;margin-bottom:6px;';
    var info = document.createElement('div');
    info.style.cssText = 'font-size:11px;color:#9ab;margin-bottom:8px;line-height:1.5;';
    info.innerHTML = '规则 ' + ((CONFIG.rules || []).length) + ' 条 · autoRun ' + (!!CONFIG.autoRun)
      + ' · dryRun ' + (!!CONFIG.dryRun) + '<br>快捷键 Alt+Shift+ P/R/I/T'
      + '<br>不对劲就先点“自检/复制”，把弹框里的 JSON 发我';
    var w = document.createElement('div');
    w.appendChild(btn('自检/复制', '#48c', function () { guard('自检中…', function () { return SGT.diag(); }); }));
    w.appendChild(btn('预演', '#3a7', function () { guard('预演中…', function () { return SGT.plan(); }); }));
    w.appendChild(btn(CONFIG.submitOrder === false ? '只挑座' : '一键抢座', '#e5533c', function () { guard('抢座中…', function () { return SGT.run(); }); }));
    w.appendChild(btn('库存', '#7a5', function () { guard('查库存…', function () { return SGT.inventory(); }); }));
    w.appendChild(btn('刷新', '#777', function () { guard('刷新中…', function () { return SGT.reload(); }); }));
    w.appendChild(btn('查场次', '#875', function () { guard('查场次…', function () { return SGT.watchCheck(); }); }));
    w.appendChild(btn('去支付', '#d81', function () { guard('跳转支付…', function () { return SGT.pay(); }); }));
    w.appendChild(btn('释放说明', '#556', function () { guard('', function () { return SGT.releaseInfo(); }); }));
    statusEl = document.createElement('div');
    statusEl.style.cssText = 'font-size:11px;color:#8cf;margin-top:8px;min-height:14px;line-height:1.4;';
    box.appendChild(title); box.appendChild(info); box.appendChild(w); box.appendChild(statusEl);
    document.body.appendChild(box);
    window.__SGT_PANEL__ = box;
    setStatus(routeLabel());
  }
  if (canDom) window.addEventListener('keydown', function (e) {
    if (!e.altKey || !e.shiftKey || e.ctrlKey || e.metaKey) return;
    var k = String(e.key || '').toLowerCase();
    if (k === 'p') { e.preventDefault(); guard('预演中…', function () { return SGT.plan(); }); }
    else if (k === 'r') { e.preventDefault(); guard('抢座中…', function () { return SGT.run(); }); }
    else if (k === 'i') { e.preventDefault(); guard('查库存…', function () { return SGT.inventory(); }); }
    else if (k === 't') { e.preventDefault(); guard('自检中…', function () { return SGT.diag(); }); }
  }, true);

  // ---------------------------------------------------------------
  // 自动运行 / 路由监听
  // ---------------------------------------------------------------
  var AUTO = { done: false, loading: false, key: '' };
  function currentKey() { var r = route(); return r.seatScheduleId + '|' + r.pk + '|' + r.sk; }
  function bootReport(why) {
    var info = {
      when: ts(), why: why, href: location.href, route: route(),
      config: {
        rules: (CONFIG.rules || []).map(function (r) { return '￥' + r.price + ' × ' + r.qty + ' 区域 ' + ((r.areas && r.areas.length) ? r.areas.join('>') : '不限'); }),
        autoRun: !!CONFIG.autoRun, dryRun: !!CONFIG.dryRun,
        watch: CONFIG.watch ? { enabled: !!CONFIG.watch.enabled, sessionId: CONFIG.watch.sessionId || '', date: CONFIG.watch.date || '' } : null,
      },
      state: {
        ok: STATE.ok, scheduleId: STATE.scheduleId, lastError: STATE.lastError,
        prices: (STATE.priceList || []).length, seatGroups: (STATE.groups || []).length,
        areaMap: STATE.venueAreaMap, checkcard: STATE.schedule && STATE.schedule.checkcard,
        certs: (STATE.certs || []).length, hasMobile: !!(STATE.member && STATE.member.mobile),
      },
    };
    log('加载失败，现场信息如下（也已经弹成一个可复制的框）：');
    console.log(JSON.stringify(info, null, 2));
    showText('加载失败（复制这段发我 · 完整自检随后弹出）', JSON.stringify(info, null, 2));
    SGT.diag().catch(function (e) { warn('自检也失败了：', e && e.message || e); });
  }
  function safeAutoRun() {
    if (!CONFIG.autoRun || AUTO.done || !onSeatPage()) return;
    AUTO.done = true;
    console.log('%c[SGT] autoRun 触发，自动执行 run()', 'color:#e5533c;font-weight:bold');
    guard('autoRun：抢座中…', function () { return SGT.run(); });
  }
  function bootForRoute(attempt) {
    var r = route();
    if (r.seatScheduleId) {
      if (AUTO.key !== currentKey()) {
        AUTO.key = currentKey(); AUTO.done = false; AUTO.loading = false; AUTO.reported = false;
      }
      if (AUTO.loading || STATE.ok) { safeAutoRun(); return; }
      AUTO.loading = true;
      setStatus('选座页加载中…' + (attempt ? ' 重试 ' + attempt : ''));
      reload().then(function (ok) {
        AUTO.loading = false;
        setStatus(routeLabel());
        if (ok) { log('数据就绪。可 SGT.plan() 预演，或点“一键抢座”/Alt+Shift+R。'); safeAutoRun(); }
        else {
          // 加载不出来就把现场信息摊开给用户看（只弹一次，别刷屏）
          if (!AUTO.reported) {
            AUTO.reported = true;
            bootReport('选座页数据加载失败');
          }
          if (attempt < 20) setTimeout(function () { bootForRoute(attempt + 1); }, 700);
        }
      }, function () {
        AUTO.loading = false;
        if (attempt < 20) setTimeout(function () { bootForRoute(attempt + 1); }, 700);
      });
      return;
    }
    if (r.detailProgramId) {
      if (watchEnabled()) { syncServerTime().then(function () { watchStep(); }); }
      setStatus(routeLabel());
      return;
    }
    if (r.onConfirm) {
      setStatus(routeLabel());
      maybeAutoAdvancePay();
      return;
    }
    setStatus(routeLabel());
  }
  var lastUrl = '';
  function watchRoute() {
    var u = String(location.href || '') + '|' + String(location.hash || '');
    if (u === lastUrl) return;
    lastUrl = u;
    setStatus(routeLabel());
    bootForRoute(0);
  }

  window.SGT = SGT;
  log('已加载(大剧院抢座)。面板常驻左下角 · autoRun=' + (!!CONFIG.autoRun) + ' · dryRun=' + (!!CONFIG.dryRun)
    + ' · watch=' + (watchEnabled() ? 'on' : 'off'));
  if (canDom) {
    window.addEventListener('hashchange', watchRoute);
    window.addEventListener('popstate', watchRoute);
    var boot = function () { mountPanel(); watchRoute(); setInterval(watchRoute, 300); };
    if (document.body) boot(); else window.addEventListener('DOMContentLoaded', boot);
  }
})();
