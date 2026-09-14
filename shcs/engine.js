/* ============================================================
 * 上海文化广场(shcstheatre.com) · 余票监控 / 开售提醒
 * ------------------------------------------------------------
 * 这个站点的选座页和订单页都要登录才可见（未登录直接 302 到登录页），
 * 所以「自动锁座」那一步的接口我拿不到——需要先用 probe.user.js 在登录状态下录一遍（见 README）。
 *
 * 本文件用**公开接口**做能立刻用上的部分：
 *   - 某个演出每一场的实时余票、是否已开售、销售期
 *   - 盯着它：余票从 0 变有 / 中途放票 / 开售时刻 → 桌面通知 + 响铃 + 标题闪 + 一键打开选座页
 *
 * 已核实的公开接口（带 Referer/UA 就能调，无需登录）：
 *   POST /webapi.ashx?op=Gettblprogram      body: id={节目id}&token=
 *        → data.TBLEVENT[]:
 *          I_EVENT_ID            场次id（选座页要用的 xz_event_id）
 *          DT_EVENT_DATETIME     开演时间
 *          I_WHGC_WEB_SEAT_CNT   网页端余票数
 *          IF_BEGIN              '1' 已开售 / '0' 未开售
 *          BEGIN_DATE / END_DATE 销售期
 *          B_WEB_SELECTSEAT      1 = 这场支持网页选座
 *   POST /webapi.ashx?op=GetTBLEVENTListForCalendar   body: year=&month=   （日历）
 *   POST /JWebAPI.ashx?op=GetWebField               body: key=token        （取登录 token）
 *   选座页：/Program/SelectSeats.aspx?xz_program_id={id}&xz_event_id={eventId}   ← 登录后才可以打开
 *
 * 常用命令：
 *   SHCS.check()     打印这个演出所有场次的余票/开售状态
 *   SHCS.watch()     开始盯（余票变化/开售就提醒）
 *   SHCS.stop()      停止
 *   SHCS.open(100284) 直接打开某场的选座页
 *   SHCS.diag()      自检（可复制）
 * ============================================================ */
(function () {
  'use strict';
  if (typeof window === 'undefined') return;
  if (window.__SHCS_ENGINE__) { console.warn('[SHCS] 已加载，跳过重复注入。'); return; }
  window.__SHCS_ENGINE__ = true;

  var DEFAULT_CONFIG = {
    programId: '', pollMs: 20000, minSeats: 1, notify: true, sound: true, autoOpen: false,
    // 选座页（抢座）用
    dryRun: false, autoRun: false, maxRetry: 3, jumpToCart: true, mode: 'auto',
    autoCheckout: false, autoSubmitOrder: true, confirmPollMs: 150, confirmMaxWaitMs: 60000, confirmMaxClicks: 2,
    rowPreference: 'middle', rules: [],
  };
  var CONFIG = window.__SHCS_CONFIG__ ? window.__SHCS_CONFIG__ : DEFAULT_CONFIG;

  function log() { console.log.apply(console, ['%c[SHCS]', 'color:#0a0;font-weight:bold'].concat([].slice.call(arguments))); }
  function warn() { console.warn.apply(console, ['[SHCS]'].concat([].slice.call(arguments))); }
  function err() { console.error.apply(console, ['[SHCS]'].concat([].slice.call(arguments))); }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function ts() { var d = new Date(); return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // ---------------------------------------------------------------
  // 请求（同源、带登录 Cookie；按站点要求带 X-Requested-With）
  // ---------------------------------------------------------------
  function formHeaders() {
    return {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      'Accept': 'application/json, text/javascript, */*; q=0.01',
    };
  }
  async function postForm(path, data) {
    var body = new URLSearchParams(data || {}).toString();
    var res = await fetch(path, { method: 'POST', headers: formHeaders(), body: body, credentials: 'same-origin' });
    var text = await res.text();
    var j = null;
    try { j = JSON.parse(text); } catch (e) {
      var e1 = new Error('接口没返回 JSON（HTTP ' + res.status + '）：' + text.slice(0, 120));
      e1.needLogin = res.status === 302 || res.redirected || /login\.aspx/i.test(res.url || '');
      throw e1;
    }
    if (j && j.IsLogin === false && j.code !== 0) log('（接口返回 IsLogin=false）');
    return j;
  }

  // ---------------------------------------------------------------
  // 基本数据
  // ---------------------------------------------------------------
  var STATE = { programId: '', program: null, sessions: [], lastError: '', token: '', watching: false, lastRefresh: 0 };

  function route() {
    var out = { programId: '', onSeatPage: /SelectSeats\.aspx/i.test(location.pathname), onDetail: /ProgramDetails/i.test(location.pathname) };
    try {
      var q = new URLSearchParams(location.search);
      out.programId = String(q.get('id') || q.get('ARTICLE_ID') || q.get('xz_program_id') || '');
      out.eventId = String(q.get('xz_event_id') || '');
    } catch (e) {}
    if (!out.programId) out.programId = String(CONFIG.programId || '');
    return out;
  }
  function programId() { return route().programId; }

  async function getToken() {
    if (STATE.token) return STATE.token;
    try {
      var res = await fetch('/JWebAPI.ashx?op=GetWebField', {
        method: 'POST', headers: formHeaders(), body: 'key=token', credentials: 'same-origin',
      });
      var t = (await res.text()).trim();
      STATE.token = (t && t !== 'null') ? t : '';
    } catch (e) { STATE.token = ''; }
    return STATE.token;
  }

  function normSessions(events) {
    return (events || []).map(function (e) {
      return {
        eventId: String(e.I_EVENT_ID),
        time: String(e.DT_EVENT_DATETIME || ''),
        seats: Number(e.I_WHGC_WEB_SEAT_CNT == null ? 0 : e.I_WHGC_WEB_SEAT_CNT),
        ifBegin: String(e.IF_BEGIN || '0'),
        beginDate: String(e.BEGIN_DATE || ''),
        endDate: String(e.END_DATE || ''),
        canSeat: Number(e.B_WEB_SELECTSEAT) === 1,
        name: e.VC_EVENT_NAME || '',
      };
    }).sort(function (a, b) { return a.time < b.time ? -1 : 1; });
  }

  async function fetchProgram(pid) {
    var token = await getToken();
    var j = await postForm('/webapi.ashx?op=Gettblprogram', { id: pid, token: token });
    if (!j || j.code !== 0) {
      var e = new Error('取场次失败：' + ((j && j.msg) || '未知错误'));
      e.raw = j;
      throw e;
    }
    var list = (j.data && j.data.TBLEVENT) || [];
    return { sessions: normSessions(list), isLogin: j.IsLogin === true, raw: j };
  }

  async function refresh(silent) {
    var pid = programId();
    if (!pid) { if (!silent) warn('这个页面的 URL 里没有演出 id（ProgramDetails.aspx?...&id=NNN），也没在 config.yaml 填 programId'); return false; }
    try {
      var r = await fetchProgram(pid);
      STATE.programId = pid;
      STATE.sessions = r.sessions;
      STATE.lastError = '';
      STATE.lastRefresh = Date.now();
      if (!silent) log('场次 ' + r.sessions.length + ' 个 · 登录状态 ' + (r.isLogin ? '已登录' : '未登录/未取到 token（不影响看余票）'));
      return true;
    } catch (e) {
      STATE.lastError = e && e.message ? e.message : String(e);
      err('取数据失败：' + STATE.lastError);
      return false;
    }
  }

  // ---------------------------------------------------------------
  // 提醒
  // ---------------------------------------------------------------
  function beep() {
    if (!CONFIG.sound) return;
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      var ctx = new AC();
      [0, 0.25, 0.5].forEach(function (t) {
        var o = ctx.createOscillator(), g = ctx.createGain();
        o.type = 'sine'; o.frequency.value = 880;
        g.gain.value = 0.15;
        o.connect(g); g.connect(ctx.destination);
        o.start(ctx.currentTime + t); o.stop(ctx.currentTime + t + 0.18);
      });
      setTimeout(function () { try { ctx.close(); } catch (e) {} }, 1500);
    } catch (e) {}
  }
  function notify(title, body) {
    log('🔔 ' + title + ' — ' + body);
    if (!CONFIG.notify) return;
    try {
      if (window.Notification) {
        if (Notification.permission === 'granted') new Notification(title, { body: body });
        else if (Notification.permission !== 'denied') Notification.requestPermission();
      }
    } catch (e) {}
    try {
      var orig = document.title;
      var n = 0;
      var iv = setInterval(function () {
        document.title = (n % 2 ? '🔔【放票了】' : orig);
        if (++n > 12) { clearInterval(iv); document.title = orig; }
      }, 500);
    } catch (e) {}
    beep();
  }

  // ---------------------------------------------------------------
  // 对外命令
  // ---------------------------------------------------------------
  var SHCS = {};
  SHCS.config = CONFIG;
  SHCS.state = STATE;

  SHCS.reload = function () { return refresh(false); };

  SHCS.check = async function () {
    var ok = await refresh(false);
    if (!ok) return null;
    console.table(STATE.sessions.map(function (s) {
      return { 场次id: s.eventId, 时间: s.time, 余票: s.seats, 开售: s.ifBegin === '1' ? '已开售' : '未开售', 选座: s.canSeat ? '支持' : '不支持', 销售期至: s.endDate };
    }));
    return STATE.sessions;
  };

  SHCS.open = function (eventId) {
    var pid = programId();
    var eid = eventId || route().eventId;
    if (!pid || !eid) { warn('需要 programId 和 eventId；也可以先把选座页参数从 SHCS.check() 的表里抄出来'); return; }
    var url = location.origin + '/Program/SelectSeats.aspx?xz_program_id=' + encodeURIComponent(pid) + '&xz_event_id=' + encodeURIComponent(eid);
    log('打开选座页：' + url);
    if (typeof window.open === 'function') window.open(url, '_blank');
    else location.href = url;
    return url;
  };

  var WATCH = { timer: null, started: false };
  function snapshot() {
    var m = {};
    STATE.sessions.forEach(function (s) { m[s.eventId] = s; });
    return m;
  }
  // 返回 {text, seats} 数组：seats 用真实余票数，便于按 minSeats 过滤
  function diffAndAlert(prev, now) {
    var alerts = [];
    Object.keys(now).forEach(function (id) {
      var s = now[id], p = prev[id];
      if (!p) { alerts.push({ text: '新上架场次 ' + s.time + '（余票 ' + s.seats + '）', seats: s.seats }); return; }
      if (s.ifBegin !== p.ifBegin && s.ifBegin === '1') alerts.push({ text: '开售了：' + s.time + '（余票 ' + s.seats + '）', seats: s.seats });
      if (s.seats > p.seats) {
        alerts.push({ text: (p.seats <= 0 ? '有票了：' : '放票：') + s.time + ' 余票 ' + p.seats + ' → ' + s.seats, seats: s.seats });
      }
    });
    return alerts;
  }
  async function tick() {
    if (!STATE.watching) return;
    var before = snapshot();
    var ok = await refresh(true);
    if (ok) {
      var after = snapshot();
      if (!WATCH.started) {              // 第一轮只建立基线，别把所有场次都当“新上架”报一遍
        WATCH.started = true;
        var tot0 = STATE.sessions.reduce(function (a, s) { return a + s.seats; }, 0);
        setStatus('监控中 · ' + STATE.sessions.length + ' 场 · 合计余票 ' + tot0 + ' · ' + ts());
        WATCH.timer = setTimeout(tick, Math.max(3000, Number(CONFIG.pollMs) || 20000));
        return;
      }
      var alerts = diffAndAlert(before, after).filter(function (a) { return a.seats >= Number(CONFIG.minSeats || 1); });
      var msgs = alerts.map(function (a) { return a.text; });
      if (msgs.length) {
        notify('上海文化广场放票', msgs.join('；'));
        msgs.forEach(function (m) { log('　' + m); });
        if (CONFIG.autoOpen) {
          var hit = STATE.sessions.filter(function (s) { return s.seats >= Number(CONFIG.minSeats || 1); })[0];
          if (hit) SHCS.open(hit.eventId);
        }
      } else {
        var tot = STATE.sessions.reduce(function (a, s) { return a + s.seats; }, 0);
        setStatus('监控中 · ' + STATE.sessions.length + ' 场 · 合计余票 ' + tot + ' · ' + ts());
      }
    } else {
      setStatus('监控中（取数失败：' + STATE.lastError + '）');
    }
    if (STATE.watching) WATCH.timer = setTimeout(tick, Math.max(3000, Number(CONFIG.pollMs) || 20000));
  }
  SHCS.watch = async function () {
    if (STATE.watching) { warn('已经在监控了'); return; }
    if (!STATE.sessions.length) { var ok = await refresh(false); if (!ok) return; }
    STATE.watching = true;
    WATCH.started = false;
    log('开始监控：每 ' + (Number(CONFIG.pollMs) || 20000) + 'ms 查一次，只在“有余票/放票/开售”时提醒');
    setStatus('监控中…');
    tick();
  };
  SHCS.stop = function () {
    STATE.watching = false;
    if (WATCH.timer) { clearTimeout(WATCH.timer); WATCH.timer = null; }
    log('已停止监控');
    setStatus('已停止');
  };

  SHCS.diag = async function () {
    var out = { when: new Date().toISOString(), href: location.href, programId: programId(), token: (await getToken()) ? '(已取到)' : '(空，未登录?)', sessions: [], errors: [] };
    try {
      await refresh(false);
      out.sessions = STATE.sessions;
    } catch (e) { out.errors.push(String((e && e.message) || e)); }
    console.log('%c[SHCS-DIAG] 自检结果', 'color:#08f;font-weight:bold');
    console.log(JSON.stringify(out, null, 2));
    showText('SHCS 自检结果（复制发我）', JSON.stringify(out, null, 2));
    return out;
  };

  // ---------------------------------------------------------------
  // 面板
  // ---------------------------------------------------------------

  // ===============================================================
  // 选座页：自动抢座
  // ---------------------------------------------------------------
  // 页面自己的流程（在保存下来的选座页源码里核出来的）：
  //   座位 = <s class="s-c" ed=场次id esd=座位id z=分区id zn=分区名 rw=排 cl=座 pa=票价 not_sale=1/0>
  //   选座 = 给 <s> 加 .seld 并往 #shoppingcart_div 放一个 .check-seat[esd]
  //   抢座 = POST /SK_WebAPI.ashx?op=LockSeatsInsertShoppingCart
  //          data: { pid: 演出id, iEventSeat_ids: "座位id,座位id,",
  //                  hk_token, hk_sessionid, hk_sig, hk_vparam }   ← 后四个平时是空串，只有触发滑块才有值
  //          返回 code 0 或 3569 都算成功 → 跳 /Order/OrderStep_First.aspx?Shoppingcart_type=343
  //   座位数据也来自 POST /SK_WebAPI.ashx?op=GetSeatsByID_Redis {event_id, clk}
  //          （返回 base64(gzip(json))，页面用 pako 解压）
  // 所以本脚本两手都做：能直接调接口就直接调；需要滑块/接口失败就改成"替你在页面上点座位 + 点加入购物车"。
  // ===============================================================
  var SEATAPI = {
    seats: '/SK_WebAPI.ashx?op=GetSeatsByID_Redis',
    lock: '/SK_WebAPI.ashx?op=LockSeatsInsertShoppingCart',
    prices: '/SK_WebAPI.ashx?op=GetEventPriceByID',
    remain: '/SK_WebAPI.ashx?op=GetOrderTicketRemainCnt',
    eventList: '/SK_WebAPI.ashx?op=GetSelectSeats_EventList',
    cart: '/Order/OrderStep_First.aspx?Shoppingcart_type=343',
  };
  var SEAT = {
    ok: false, programId: '', eventId: '', eventTime: '', seats: [], zones: {}, remark: '', lastError: '', source: '',
  };

  function seatRoute() {
    var q = {};
    try { q = new URLSearchParams(location.search); } catch (e) {}
    var m = String(location.hash || '').match(/xz_program_id=(\d+)/);
    return {
      onSeat: /SelectSeats\.aspx/i.test(location.pathname),
      // 本地另存为的页面（file://）没有查询参数，靠页面里的座位/脚本判断
      onLocalSeat: location.protocol === 'file:' && !!document.querySelector('s.s-c, .s-c'),
      programId: String(q.get('xz_program_id') || q.get('i_program_id') || (m ? m[1] : '') || ''),
      eventId: String(q.get('xz_event_id') || q.get('i_event_id') || ''),
    };
  }
  function isLocalFile() { return location.protocol === 'file:'; }

  // ---- 从页面 DOM 直接读座位（页面已经渲染好了，最快最稳） ----
  function readSeatsFromDom() {
    var els = document.querySelectorAll('s.s-c, .s-c');
    var out = [];
    for (var i = 0; i < els.length; i++) {
      var e = els[i];
      var esd = e.getAttribute('esd') || e.getAttribute('ESD');
      if (!esd) continue;
      var x = null, y = null;
      var st = e.getAttribute('style') || '';
      var mx = st.match(/left:\s*(-?\d+(?:\.\d+)?)px/), my = st.match(/top:\s*(-?\d+(?:\.\d+)?)px/);
      if (mx) x = Number(mx[1]);
      if (my) y = Number(my[1]);
      out.push({
        esd: String(esd),
        ed: String(e.getAttribute('ed') || e.getAttribute('ED') || ''),
        z: String(e.getAttribute('z') || e.getAttribute('Z') || ''),
        zn: String(e.getAttribute('zn') || e.getAttribute('ZN') || ''),
        rw: Number(e.getAttribute('rw') || e.getAttribute('RW') || 0),
        cl: Number(e.getAttribute('cl') || e.getAttribute('CL') || 0),
        pa: Number(e.getAttribute('pa') || e.getAttribute('PA') || 0),
        notSale: String(e.getAttribute('not_sale') || '0') === '1',
        x: x, y: y,
        selected: String(e.className || '').indexOf('seld') > -1,
        el: e,
      });
    }
    return out;
  }

  // ---- 从接口读座位（最新，含刚被别人买走的实时状态） ----
  async function gunzipBase64(b64) {
    var bin = atob(String(b64).replace(/\s+/g, ''));
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    if (typeof DecompressionStream === 'function') {
      try {
        var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
        var out = await new Response(stream).text();
        SEAT.gunzipBy = 'DecompressionStream';
        return out;
      } catch (e) { /* 落到 pako */ }
    }
    if (window.pako && window.pako.ungzip) { SEAT.gunzipBy = 'pako'; return window.pako.ungzip(bytes, { to: 'string' }); }
    throw new Error('浏览器不支持 DecompressionStream，页面的 pako 也没加载 → 解不开座位数据（多半是静态资源被拦了）');
  }
  function clkFromPage() {
    try {
      var m = document.documentElement.innerHTML.match(/clk:\s*"([0-9a-fA-F\-]{8,})"/);
      if (m) return m[1];
    } catch (e) {}
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0; return (c === 'x' ? r : ((r & 0x3) | 0x8)).toString(16);
    });
  }
  // 页面可能把 clk 当数字用（接口报过 Convert.ToInt32 格式错），所以准备几种候选挨个试
  function clkCandidates() {
    var out = [];
    try {
      var m = document.documentElement.innerHTML.match(/clk\s*[:=]\s*["']?([0-9a-zA-Z\-]{6,})/);
      if (m) out.push(m[1]);
    } catch (e) {}
    try { var el = document.querySelector('[clk]'); if (el) out.push(el.getAttribute('clk')); } catch (e) {}
    out.push(String(Date.now()));                                   // 数字型（最常见的坑）
    out.push(clkFromPage());                                        // 页面里的或随机 GUID
    return out.filter(function (v, i, a) { return v && a.indexOf(v) === i; });
  }
  // 场次 id：URL 没有时，从页面里找（选中的场次 / 隐藏域 / 座位元素 / 内联变量）
  function eventIdFromPage() {
    try {
      var el = document.querySelector('#DT_EVENT_DATETIME li.date-details-curr, #DT_EVENT_DATETIME li.curr, li[I_EVENT_ID][class*="curr"], .sign-time[ED]');
      if (el) {
        var v = el.getAttribute('I_EVENT_ID') || el.getAttribute('i_event_id') || el.getAttribute('ED');
        if (v) return String(v);
      }
    } catch (e) {}
    try { var hid = document.querySelector('#hid_sel_event_id'); if (hid && hid.value) return String(hid.value); } catch (e) {}
    try {
      var seat = document.querySelector('s.s-c[ed], .s-c[ed]');
      if (seat) { var e2 = seat.getAttribute('ed'); if (e2) return String(e2); }
    } catch (e) {}
    try {
      var m = document.documentElement.innerHTML.match(/var\s+event_id\s*=\s*(\d+)/);
      if (m) return m[1];
    } catch (e) {}
    return '';
  }
  async function readSeatsFromApi(eventId) {
    if (!eventId) throw new Error('没有场次 id（event_id），没法调座位接口');
    var cands = clkCandidates();
    var lastErr = null;
    for (var ci = 0; ci < cands.length; ci++) {
      var res = await fetch(SEATAPI.seats, {
        method: 'POST', credentials: 'same-origin', headers: formHeaders(),
        body: new URLSearchParams({ event_id: eventId, clk: cands[ci] }).toString(),
      });
      var text = await res.text();
      SEAT.rawSnippet = String(text).slice(0, 200);
      SEAT.httpStatus = res.status;
      // 后端对参数格式不满（我们见过 Convert.ToInt32 报 FormatException）→ 换一种 clk 再试
      if (/FormatException|格式不正确|StringToNumber|Convert\.ToInt32/i.test(text)) {
        lastErr = new Error('座位接口说参数格式不对（clk=' + cands[ci] + '）：' + String(text).replace(/\s+/g, ' ').slice(0, 120));
        continue;
      }
      var j = null;
      var t = String(text).trim();
      if (t.charAt(0) === '{') {                       // 万一后端改成明文 JSON
        try { j = JSON.parse(t); SEAT.gunzipBy = 'plain-json'; } catch (e) { j = null; }
      }
      if (!j) {
        var json = await gunzipBase64(t);              // 正常：base64(gzip(json))
        j = JSON.parse(json);
      }
      if (!j || j.code !== 0 || !j.data) {
        lastErr = new Error('座位接口返回异常：' + ((j && j.msg) || ('HTTP ' + res.status)));
        continue;
      }
      SEAT.clkUsed = cands[ci];
      var priceMap = {}, zoneMap = j.data.zone || {}, seats = [];
      Object.keys(j.data.price || {}).forEach(function (k) {
        try { priceMap[k] = JSON.parse(j.data.price[k]); } catch (e) {}
      });
      Object.keys(j.data.seat || {}).forEach(function (k) {
        var st;
        try { st = JSON.parse(j.data.seat[k]); } catch (e) { return; }
        var pr = priceMap[st.P];
        var notSale = (pr === undefined) || Number(st.ST) !== 0 || Number(st.SL) > 0 || Number(st.MK) === 1;
        seats.push({
          esd: String(k), ed: String(eventId), z: String(st.Z || ''),
          zn: String(zoneMap[st.ZD] || ''), rw: Number(st.RW), cl: Number(st.CL),
          pa: pr ? Number(pr.I_PRICE_AMT) : 0, notSale: notSale, x: Number(st.X), y: Number(st.Y),
          selected: false, el: null,
        });
      });
      return seats;
    }
    throw (lastErr || new Error('座位接口没成功'));
  }

  async function seatReload() {
    var r = seatRoute();
    SEAT.lastError = ''; SEAT.ok = false;
    if (!r.onSeat && !r.onLocalSeat) { SEAT.lastError = '当前不在选座页（/Program/SelectSeats.aspx?...）'; return false; }
    SEAT.programId = r.programId || String(CONFIG.programId || '');
    SEAT.eventId = r.eventId || eventIdFromPage();     // URL 没有场次id时，从页面里找
    try {
      var seats = [];
      try {
        seats = await readSeatsFromApi(SEAT.eventId);
        SEAT.source = 'api';
      } catch (e) {
        warn('接口取座位失败（' + (e.message || e) + '），改用页面上的座位快照');
        seats = readSeatsFromDom();
        SEAT.source = 'dom';
      }
      if (!seats.length) {
        seats = readSeatsFromDom();
        if (seats.length) SEAT.source = 'dom';
      }
      if (!seats.length) {
        // 页面自己的 JS 挂了（比如控制台报 $ is not defined）时，座位图根本不会渲染
        SEAT.pageBroken = !window.jQuery && document.querySelectorAll('s.s-c, .s-c').length === 0;
        throw new Error('接口和页面都没拿到座位'
          + (SEAT.pageBroken ? '；而且这个页面自己的 jQuery 没加载（控制台会报 $ is not defined），座位图压根没渲染出来' : '')
          + (SEAT.rawSnippet ? '。接口原始返回：' + SEAT.rawSnippet : ''));
      }
      SEAT.seats = seats;
      if (!SEAT.eventId) {
        // 本地另存为的页面：场次 id 从座位元素自己身上取（ed="100467"）
        var withEd = seats.filter(function (s) { return s.ed; })[0];
        SEAT.eventId = withEd ? withEd.ed : '';
      }
      if (!SEAT.programId) {
        // 从页面内联脚本里兜底抓演出 id
        var m = document.documentElement.innerHTML.match(/i_program_id\s*=\s*(\d+)/);
        if (m) SEAT.programId = m[1];
      }
      var free = seats.filter(function (s) { return !s.notSale; });
      var prices = {};
      free.forEach(function (s) { prices[s.pa] = (prices[s.pa] || 0) + 1; });
      SEAT.ok = true;
      log('选座数据就绪（' + (SEAT.source === 'api' ? '接口实时' : '页面快照') + '）：场次 ' + SEAT.eventId
        + ' · 座位 ' + seats.length + ' 个 · 可售 ' + free.length + ' 个 · 价位 '
        + Object.keys(prices).sort(function (a, b) { return a - b; }).map(function (p) { return '￥' + p + '(' + prices[p] + ')'; }).join(' '));
      return true;
    } catch (e) {
      SEAT.lastError = e && e.message ? e.message : String(e);
      err('选座数据加载失败：' + SEAT.lastError);
      return false;
    }
  }

  // ---- 选座算法：同排连坐优先（按 X 坐标判断相邻，座位号可能是双号跳 2） ----
  function rowRankMap(rows) {
    var pref = String(CONFIG.rowPreference || 'middle').toLowerCase();
    var asc = rows.slice().sort(function (a, b) { return a - b; });
    var order;
    if (pref === 'front') order = asc;
    else if (pref === 'back') order = asc.slice().reverse();
    else {
      var mid = (asc.length - 1) / 2;
      order = asc.map(function (r, i) { return { r: r, d: Math.abs(i - mid) }; })
        .sort(function (a, b) { return a.d - b.d || a.r - b.r; }).map(function (x) { return x.r; });
    }
    var m = {};
    order.forEach(function (r, i) { m[r] = i; });
    return m;
  }
  function zoneHit(zones, zn) {
    if (!zones || !zones.length) return true;
    var s = String(zn || '').toUpperCase();
    return zones.some(function (z) { return s.indexOf(String(z).trim().toUpperCase()) > -1; });
  }
  function candidatesFor(pool, rule) {
    var qty = Number(rule.qty) || 1;
    var list = pool.filter(function (s) {
      if (Number(s.pa) !== Number(rule.price)) return false;
      return zoneHit(rule.zones, s.zn);
    });
    if (!list.length) return [];
    var zoneNames = [];
    list.forEach(function (s) { if (zoneNames.indexOf(s.zn) < 0) zoneNames.push(s.zn); });
    if (!rule.zones || !rule.zones.length) zoneNames.sort();
    function zoneIdx(s) {
      if (!rule.zones || !rule.zones.length) return zoneNames.indexOf(s.zn);
      for (var i = 0; i < rule.zones.length; i++) {
        if (String(s.zn).toUpperCase().indexOf(String(rule.zones[i]).trim().toUpperCase()) > -1) return i;
      }
      return 99;
    }
    // 同区域 + 同排 分组（用 X 排序，X 缺失时用座号）
    var rows = {};
    list.forEach(function (s) {
      var k = s.z + '|' + s.rw + '|' + s.pa;
      (rows[k] = rows[k] || []).push(s);
    });
    var rowList = Object.keys(rows).map(function (k) {
      var arr = rows[k].slice().sort(function (a, b) {
        var ax = a.x == null ? a.cl : a.x, bx = b.x == null ? b.cl : b.x;
        return ax - bx;
      });
      return { key: k, zn: arr[0].zn, rw: arr[0].rw, seats: arr };
    });
    var ranks = rowRankMap(rowList.map(function (r) { return r.rw; }).filter(function (v, i, a) { return a.indexOf(v) === i; }));
    var out = [];
    // 1) 同排连坐
    rowList.forEach(function (r) {
      if (r.seats.length < qty) return;
      var xs = r.seats.map(function (s) { return s.x == null ? s.cl : s.x; });
      // 这一排的常见座位间距（页面里相邻座左边缘差 11px 左右），用它判断“真的是挨着”
      var minGap = Infinity;
      for (var g = 1; g < xs.length; g++) { var gg = xs[g] - xs[g - 1]; if (gg > 0 && gg < minGap) minGap = gg; }
      if (!isFinite(minGap) || minGap <= 0) minGap = 1;
      var maxGap = minGap * 1.6;
      var center = (Math.min.apply(null, xs) + Math.max.apply(null, xs)) / 2;
      var best = null;
      for (var i = 0; i + qty <= r.seats.length; i++) {
        var win = r.seats.slice(i, i + qty);
        // 窗口内相邻性检查：X 间距不超过该排常见间距的 1.6 倍
        var ok = true;
        for (var k = 1; k < win.length; k++) {
          var d = (win[k].x == null ? win[k].cl : win[k].x) - (win[k - 1].x == null ? win[k - 1].cl : win[k - 1].x);
          if (d <= 0 || d > maxGap) { ok = false; break; }
        }
        if (!ok) continue;
        var c = ((win[0].x == null ? win[0].cl : win[0].x) + (win[win.length - 1].x == null ? win[win.length - 1].cl : win[win.length - 1].x)) / 2;
        var score = Math.abs(c - center);
        if (!best || score < best.score) best = { score: score, seats: win };
      }
      if (best) out.push({ tier: 1, tierName: qty === 1 ? '单座' : '同排连坐', zoneIdx: zoneIdx(best.seats[0]), seats: best.seats, score: (ranks[r.rw] == null ? 999 : ranks[r.rw]) * 1000 + best.score });
    });
    // 2) 上下排相邻（同区域、连续排、列位置接近）
    if (qty > 1) {
      var byZone = {};
      rowList.forEach(function (r) { (byZone[r.zn] = byZone[r.zn] || []).push(r); });
      Object.keys(byZone).forEach(function (zn) {
        var rs = byZone[zn].slice().sort(function (a, b) { return a.rw - b.rw; });
        for (var i = 0; i + qty - 1 < rs.length; i++) {
          var seq = rs.slice(i, i + qty);
          var contiguous = seq.every(function (r, k) { return k === 0 || r.rw === seq[k - 1].rw + 1; });
          if (!contiguous) continue;
          seq[0].seats.forEach(function (base) {
            var pick = [base], ok = true;
            var xs0 = seq[0].seats.map(function (s) { return s.x == null ? s.cl : s.x; });
            var minGap0 = Infinity;
            for (var g2 = 1; g2 < xs0.length; g2++) { var gg2 = xs0[g2] - xs0[g2 - 1]; if (gg2 > 0 && gg2 < minGap0) minGap0 = gg2; }
            var tol = isFinite(minGap0) && minGap0 > 0 ? Math.max(4, minGap0 * 0.6) : 12;
            for (var k = 1; k < qty; k++) {
              var bx = base.x == null ? base.cl : base.x;
              var cand = seq[k].seats.filter(function (s) { return Math.abs((s.x == null ? s.cl : s.x) - bx) <= tol; })[0];
              if (!cand) { ok = false; break; }
              pick.push(cand);
            }
            if (!ok) return;
            var avg = seq.reduce(function (a, r) { return a + (ranks[r.rw] == null ? 999 : ranks[r.rw]); }, 0) / qty;
            out.push({ tier: 2, tierName: '上下排相邻', zoneIdx: zoneIdx(base), seats: pick, score: avg * 1000 + (base.cl % 100) });
          });
        }
      });
    }
    // 3) 散座兜底
    var loose = list.map(function (s) {
      var r = rowList.filter(function (x) { return x.key === s.z + '|' + s.rw + '|' + s.pa; })[0];
      var xs = r ? r.seats.map(function (y) { return y.x == null ? y.cl : y.x; }) : [0];
      var center = (Math.min.apply(null, xs) + Math.max.apply(null, xs)) / 2;
      var sx = s.x == null ? s.cl : s.x;
      return { s: s, score: (ranks[s.rw] == null ? 999 : ranks[s.rw]) * 1000 + Math.abs(sx - center) };
    }).sort(function (a, b) { return a.score - b.score; });
    if (loose.length >= qty) {
      var pickLoose = loose.slice(0, qty);
      out.push({ tier: 3, tierName: '散座', zoneIdx: zoneIdx(pickLoose[0].s), seats: pickLoose.map(function (x) { return x.s; }), score: pickLoose[pickLoose.length - 1].score });
    }
    out.sort(function (a, b) {
      if (a.zoneIdx !== b.zoneIdx) return a.zoneIdx - b.zoneIdx;
      if (a.tier !== b.tier) return a.tier - b.tier;
      return a.score - b.score;
    });
    return out;
  }
  function describePick(c) {
    var byZone = {};
    c.seats.forEach(function (s) { (byZone[s.zn] = byZone[s.zn] || []).push(s.rw + '排' + s.cl + '座'); });
    return Object.keys(byZone).map(function (z) { return z + ' ' + byZone[z].join('、'); }).join(' | ')
      + '（￥' + c.seats[0].pa + ' × ' + c.seats.length + '，' + c.tierName + '）';
  }
  function freeSeats() { return SEAT.seats.filter(function (s) { return !s.notSale; }); }

  // ---- 锁座：先走接口，失败/需要滑块再走页面点选 ----
  async function lockViaApi(picks) {
    var ids = picks.map(function (s) { return s.esd; }).join(',') + ',';
    var body = {
      pid: SEAT.programId,           // 演出 id
      iEventSeat_ids: ids,           // "120944282,120944283,"  ← 末尾那个逗号是页面原样带的
      hk_token: '', hk_sessionid: '', hk_sig: '', hk_vparam: '',   // 平时是空串；要滑块时页面才会填
    };
    var j = await postForm(SEATAPI.lock, body);
    return j;
  }
  // 选座页的「确认订购 Confirm Order」按钮长这样：
  //   <div class="chose-list common-bottom" onclick="Buy()"><div class="sign-btn">确认订购 Confirm Order</div></div>
  // 页面自带 4 秒冷却：TimeStart() → BtnGray() 给 .sign-btn 加 gray_s，4 秒后 BtnBk() 去掉。
  // 灰着的时候点它没用（页面里的 Buy() 第一行就是 if (bo_gray) return;）。所以要"等它变亮再按"。
  function buyButtonState() {
    var wrap = null;
    var list = document.querySelectorAll('.chose-list.common-bottom, [onclick]');
    for (var i = 0; i < list.length; i++) {
      var oc = String(list[i].getAttribute('onclick') || '');
      if (/Buy\s*\(/.test(oc) && !/MkBuy/.test(oc)) { wrap = list[i]; break; }
    }
    if (!wrap) return { wrap: null, inner: null, gray: true, text: '' };
    var inner = wrap.querySelector ? (wrap.querySelector('.sign-btn') || wrap) : wrap;
    var cls = String((inner && inner.className) || '') + ' ' + String(wrap.className || '');
    return {
      wrap: wrap, inner: inner, gray: /gray/i.test(cls),
      text: String((inner && inner.textContent) || '').replace(/\s+/g, ' ').trim(),
    };
  }
  function findBuyBtn() { return buyButtonState().wrap; }
  // 盯着「确认订购」：一变亮立刻按（返回是否按下）
  async function pressBuyWhenReady(maxWaitMs) {
    var maxWait = Number(maxWaitMs || 20000), waited = 0, poll = 100, t0 = Date.now(), told = false;
    while (waited <= maxWait) {
      var st = buyButtonState();
      if (st.wrap && !st.gray) {
        var secs = ((Date.now() - t0) / 1000).toFixed(1);
        console.log('%c[SHCS] 「' + (st.text || '确认订购') + '」可以点了（等了 ' + secs + 's）→ 立刻按',
          'color:#fff;background:#e5533c;padding:2px 6px;border-radius:4px;font-weight:bold');
        try { st.wrap.click(); } catch (e) { err('点击失败：' + (e.message || e)); return false; }
        return true;
      }
      if (!told) {
        told = true;
        log('「' + (st.text || '确认订购') + '」现在是灰的' + (st.wrap ? '（页面 4 秒冷却/校验中）' : '（按钮还没出现）') + '，盯着它…');
      }
      if (!st.wrap && waited > 5000) break;
      await sleep(poll); waited += poll;
    }
    return false;
  }
  async function lockViaDom(picks) {
    var hit = 0, miss = [];
    for (var i = 0; i < picks.length; i++) {
      var el = document.querySelector('s.s-c[esd="' + picks[i].esd + '"]') || document.querySelector('.s-c[esd="' + picks[i].esd + '"]');
      if (!el) { miss.push(picks[i].esd); continue; }
      if (String(el.className).indexOf('seld') < 0) el.click();
      hit++;
      await sleep(120);
    }
    if (!hit) throw new Error('页面上没找到这些座位元素（刷新一下选座页再试）');
    if (miss.length) warn('有 ' + miss.length + ' 个座位在页面上没找到：' + miss.join(','));
    await sleep(200);
    var chosen = document.querySelectorAll('#shoppingcart_div .check-seat').length;
    if (!chosen) throw new Error('座位没被选中（可能都被别人锁了）');
    if (!findBuyBtn()) throw new Error('没找到「确认订购」按钮');
    var pressed = await pressBuyWhenReady(20000);
    if (!pressed) throw new Error('「确认订购」一直是灰的（页面冷却中/需要验证），请手动点一下');
    log('已按「确认订购」（走页面自己的流程' + (SEAT.needCaptcha ? '，如果弹出滑块请手动拖一下' : '') + '）');
    return 'dom';
  }

  SEAT.reload = seatReload;
  SEAT.inventory = function () {
    if (!SEAT.ok) { warn('还没数据，先 SHCS.seatReload()'); return; }
    var agg = {};
    freeSeats().forEach(function (s) { var k = s.zn + ' | ￥' + s.pa; agg[k] = (agg[k] || 0) + 1; });
    console.table(Object.keys(agg).sort().map(function (k) { return { 区域座位: k, 可售: agg[k] }; }));
    log('可售 ' + freeSeats().length + ' / 全场 ' + SEAT.seats.length + '（数据源：' + SEAT.source + '）');
  };
  SEAT.plan = function () {
    if (!SEAT.ok) { warn('还没数据，先 SHCS.seatReload()'); return; }
    var rules = CONFIG.rules || [];
    var rows = rules.map(function (r, i) {
      var cs = candidatesFor(freeSeats(), r);
      return { 规则: '#' + (i + 1), 要求: '￥' + r.price + ' × ' + r.qty + ((r.zones && r.zones.length) ? ' · 区域 ' + r.zones.join('>') : ' · 不限'), 命中: cs.length ? describePick(cs[0]) : '无（凑不齐）', 备选数: cs.length };
    });
    console.table(rows);
    var first = rules.map(function (r) { return candidatesFor(freeSeats(), r); }).filter(function (c) { return c.length; })[0];
    if (first) log('预演：会锁 → ' + describePick(first[0]));
    else warn('预演：所有规则都凑不齐。点“库存”看真实价位/区域，再改 config.yaml 的 rules。');
    return rows;
  };
  var SEATRUN = false;
  SEAT.run = async function () {
    if (SEATRUN) { warn('正在抢，别重复点'); return { success: false, busy: true }; }
    var rt = seatRoute();
    if (!rt.onSeat && !rt.onLocalSeat) { warn('请先在“选座页”（/Program/SelectSeats.aspx）上运行'); return { success: false, reason: 'not-on-seat-page' }; }
    SEATRUN = true;
    try {
      if (!SEAT.ok && !await seatReload()) return { success: false, reason: 'load-failed', error: SEAT.lastError };
      var rules = CONFIG.rules || [];
      if (!rules.length) { warn('config.yaml 里没有 rules'); return { success: false, reason: 'no-rules' }; }
      var dry = !!CONFIG.dryRun;
      if (isLocalFile()) {
        // 本地另存为的页面连不到服务器（也没有登录态），只能预演，绝不假装“抢到了”
        dry = true;
        warn('这是本地保存的网页（file://），连不到官网接口、也没有登录态 —— 只能预演挑座。');
        warn('真正抢座请在浏览器里打开官网的选座页：https://www.shcstheatre.com/Program/SelectSeats.aspx?xz_program_id=..&xz_event_id=..');
      }
      var attempts = Math.max(1, Number(CONFIG.maxRetry) || 1);
      for (var attempt = 0; attempt < attempts; attempt++) {
        if (attempt > 0) { log('第 ' + (attempt + 1) + '/' + attempts + ' 轮：刷新座位重挑'); await seatReload(); }
        for (var i = 0; i < rules.length; i++) {
          var cs = candidatesFor(freeSeats(), rules[i]);
          if (!cs.length) { warn('规则#' + (i + 1) + '（￥' + rules[i].price + ' × ' + rules[i].qty + '）凑不齐，跳过'); continue; }
          var pick = cs[0];
          if (cs.length > 1) log('规则#' + (i + 1) + ' 有 ' + cs.length + ' 种挑法，首选：' + describePick(pick));
          if (dry) { log('%c【预演】会锁 → ' + describePick(pick), 'color:#e5533c;font-weight:bold'); return { success: true, planned: true, pick: pick }; }
          log('锁定 → ' + describePick(pick));
          var j = null;
          try { j = await lockViaApi(pick.seats); }
          catch (e) { err('锁座接口异常：' + (e.message || e)); }
          if (j && (j.code === 0 || j.code === 3569)) {
            if (j.code === 3569) warn('部分座位被别人锁走了，其余已进购物车');
            console.log('%c[SHCS] ✅ 座位已锁进购物车！', 'color:#fff;background:#0a0;padding:2px 6px;border-radius:4px;font-weight:bold');
            var url = location.origin + SEATAPI.cart;
            var summary = pick.seats.map(function (s) { return s.zn + s.rw + '排' + s.cl + '座(￥' + s.pa + ')'; }).join('、');
            log('锁定座位：' + summary);
            log('→ 下一步是结算页（选票种/取票方式 → 提交订单 → 付款）：' + url);
            if (CONFIG.jumpToCart) { location.href = url; }
            return { success: true, url: url, pick: pick };
          }
          if (j) warn('锁座被拒：[' + j.code + '] ' + (j.msg || ''));
          // 需要滑块 / 接口失败 → 走页面点选
          if (CONFIG.mode === 'auto' || !j) {
            log('改用“页面点选 + 加入购物车”方式再试一次…');
            try { await lockViaDom(pick.seats); return { success: true, via: 'dom', pick: pick }; }
            catch (e2) { err('页面点选也失败了：' + (e2.message || e2)); }
          }
        }
      }
      warn('试满 ' + attempts + ' 轮仍未锁到。建议放宽 rules（多写几个价位/区域、少买几张）或稍后手动再试。');
      return { success: false, reason: 'exhausted' };
    } finally { SEATRUN = false; }
  };
  SEAT.cart = function () { location.href = location.origin + SEATAPI.cart; };
  // 手动：盯着选座页的「确认订购」，一亮就按（座位要先被选中）
  SHCS.pressSeatConfirm = async function () {
    if (!seatRoute().onSeat && !seatRoute().onLocalSeat) { warn('这个命令要在选座页用'); return false; }
    if (!findBuyBtn()) { warn('页面上没找到「确认订购」按钮'); return false; }
    var chosen = 0;
    try { chosen = document.querySelectorAll('#shoppingcart_div .check-seat').length; } catch (e) {}
    if (!chosen) warn('注意：现在购物车里还没选中任何座位（先去页面上点座位，或点「一键抢座」）');
    var ok = await pressBuyWhenReady(30000);
    log(ok ? '已按「确认订购」' : '「确认订购」一直点不了，请手动点一下');
    return ok;
  };

  // ===============================================================
  // 结算流程（锁座之后的第二段）
  //   购物车页 /Order/OrderStep_First.aspx   ← 锁座后跳到这里
  //     结算入口：<a href="https://www.shcstheatre.com/Order/OrderStep_Second.aspx?Shoppingcart_type=0" class="jiesuan">结算 Checkout</a>
  //   结算页   /Order/OrderStep_Second.aspx   ← 这里选票种/取票方式/实名、勾条款、提交订单
  // ===============================================================
  function cartRoute() {
    var p = String(location.pathname || '');
    return {
      onCart: /OrderStep_First\.aspx/i.test(p),
      onConfirm: /OrderStep_Second\.aspx/i.test(p),
      onPay: /OrderStep_Third\.aspx|orderPay|pay/i.test(p),
    };
  }
  function findClickable(re, sel) {
    var list = document.querySelectorAll(sel || 'a, button, div[onclick], span[onclick], li[onclick]');
    for (var i = 0; i < list.length; i++) {
      var t = String(list[i].textContent || '').replace(/\s+/g, '');
      if (re.test(t)) return list[i];
    }
    return null;
  }
  function checkAgreements() {
    var boxes = document.querySelectorAll('input[type=checkbox]');
    var n = 0;
    for (var i = 0; i < boxes.length; i++) {
      if (!boxes[i].checked && !boxes[i].disabled) { try { boxes[i].click(); n++; } catch (e) {} }
    }
    // 有些站用 span.icon 做勾选
    if (!boxes.length) {
      var sp = findClickable(/我已.*(阅读|同意)|同意.*条款|同意以上/, 'span[onclick], div[onclick], i');
      if (sp) { try { sp.click(); n++; } catch (e) {} }
    }
    return n;
  }
  var CHECKOUT_DONE = false;
  // 结算页的「确认订购」按钮要等几秒才算完金额/名额 —— 盯着它，一可用立刻按
  var CONFIRM = { timer: null, started: 0, clicks: 0, done: false };
  // 这个站的选座/下单流程有的地方是套在 iframe 里的，所以按钮要在所有同源文档里找
  function collectDocs() {
    var out = [document];
    function walk(doc, depth) {
      if (!doc || depth > 3) return;
      var frames;
      try { frames = doc.querySelectorAll('iframe, frame'); } catch (e) { return; }
      for (var i = 0; i < frames.length; i++) {
        var d = null;
        try { d = frames[i].contentDocument; } catch (e) { d = null; }   // 跨域会抛
        if (d && out.indexOf(d) < 0) { out.push(d); walk(d, depth + 1); }
      }
    }
    walk(document, 0);
    return out;
  }
  var CLICKABLE_SEL = 'a, button, div[onclick], span[onclick], li[onclick], input[type=button], input[type=submit]';
  function clickablesIn(doc) {
    var list = [];
    try { list = doc.querySelectorAll(CLICKABLE_SEL); } catch (e) { return []; }
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      var txt = String(el.textContent || el.value || '').replace(/\s+/g, '');
      if (txt) out.push({ el: el, txt: txt });
    }
    return out;
  }
  function allClickables() {
    var out = [];
    collectDocs().forEach(function (d) { out = out.concat(clickablesIn(d)); });
    return out;
  }
  function findConfirmButton() {
    var wanted = /确认订购|确认订单|提交订单|确认下单|确认支付|立即支付|去支付|确认|订购|提交|结算/;
    var bad = /返回|取消|上一步|继续购|删除|重新选择|再看看|关闭/;
    var pool = allClickables().filter(function (x) { return wanted.test(x.txt) && !bad.test(x.txt); });
    if (!pool.length) return null;
    // 越"像确认订购"的越优先
    var order = ['确认订购', '确认下单', '确认订单', '提交订单', '确认支付', '立即支付', '去支付', '订购', '确认', '提交', '结算'];
    for (var k = 0; k < order.length; k++) {
      for (var j = 0; j < pool.length; j++) if (pool[j].txt.indexOf(order[k]) > -1) return pool[j].el;
    }
    return pool[0].el;
  }
  // 诊断：把页面上所有可点元素列出来（找不到按钮时用）
  function listClickables() {
    var seen = {}, out = [];
    allClickables().forEach(function (x) {
      var t = x.txt.slice(0, 20);
      if (seen[t]) return;
      seen[t] = 1;
      out.push(t + '  [' + String(x.el.className || x.el.tagName || '').slice(0, 24) + ']'
        + (isDisabled(x.el) ? ' (灰)' : '')
        + (isVisible(x.el) ? '' : ' (不可见)'));
    });
    return out.slice(0, 60);
  }
  SHCS.whatButtons = function () {
    var list = listClickables();
    var docs = collectDocs().length;
    console.table(list.map(function (s) { return { 可点元素: s }; }));
    log('共 ' + list.length + ' 个（含 ' + docs + ' 个文档/iframe）。找「确认订购」的结果：' + (findConfirmButton() ? '找到了' : '没找到'));
    return list;
  };
  function isDisabled(el) {
    if (!el) return true;
    if (el.disabled) return true;
    if (el.getAttribute) {
      if (el.getAttribute('disabled') != null) return true;
      if (String(el.getAttribute('aria-disabled')).toLowerCase() === 'true') return true;
    }
    var cls = String(el.className || '');
    if (/(^|[^a-z])(disabled|is-disabled|un-btn|btn-disabled|btn_disabled|gray|hui|forbid)([^a-z]|$)/i.test(cls)) return true;
    return false;
  }
  function isVisible(el) {
    try { if (el.getClientRects && el.getClientRects().length === 0) return false; } catch (e) {}
    try {
      var st = window.getComputedStyle ? window.getComputedStyle(el) : null;
      if (st) {
        if (st.display === 'none' || st.visibility === 'hidden' || st.pointerEvents === 'none') return false;
        if (st.opacity !== '' && Number(st.opacity) < 0.5) return false;
      }
    } catch (e) {}
    return true;
  }
  function confirmReady() {
    var b = findConfirmButton();
    return (b && isVisible(b) && !isDisabled(b)) ? b : null;
  }
  function watchConfirmButton() {
    if (!canDom) return;
    if (CONFIRM.timer) { clearTimeout(CONFIRM.timer); CONFIRM.timer = null; }
    var maxWait = Math.max(3000, Number(CONFIG.confirmMaxWaitMs) || 60000);
    var poll = Math.max(50, Number(CONFIG.confirmPollMs) || 150);
    CONFIRM.started = Date.now(); CONFIRM.done = false; CONFIRM.clicks = 0;
    log('盯着「确认订购」：一变成可点就立刻按（每 ' + poll + 'ms 看一次，最多等 ' + Math.round(maxWait / 1000) + 's）');
    function retry() {
      setTimeout(function () {
        var maxClicks = Math.max(1, Number(CONFIG.confirmMaxClicks) || 2);
        if (CONFIRM.clicks >= maxClicks) {
          CONFIRM.done = true;
          log('已按 ' + CONFIRM.clicks + ' 次，不再自动重复按（每次都可能生成订单，宁可留给你手动）');
          return;
        }
        var b = confirmReady();
        if (b) {
          log('3 秒后页面还停在这一步、按钮仍可点 → 再按一次（第 ' + (CONFIRM.clicks + 1) + ' 次，最多 ' + maxClicks + ' 次）');
          try { b.click(); CONFIRM.clicks++; } catch (e) {}
          retry();
        } else { CONFIRM.done = true; log('提交这一步完成（页面已跳转 / 按钮已变灰）'); }
      }, 3000);
    }
    function step() {
      if (CONFIRM.done) return;
      var btn = confirmReady();
      if (btn) {
        var waited = ((Date.now() - CONFIRM.started) / 1000).toFixed(1);
        var n = checkAgreements();
        if (n) log('顺手勾上 ' + n + ' 个“同意”项');
        console.log('%c[SHCS] 「确认订购」可用了（等了 ' + waited + 's）→ 立刻按',
          'color:#fff;background:#e5533c;padding:2px 6px;border-radius:4px;font-weight:bold');
        try { btn.click(); CONFIRM.clicks++; setStatus('已按「确认订购」（等了 ' + waited + 's）'); }
        catch (e) { err('点击失败：' + (e.message || e)); }
        retry();
        return;
      }
      var el = Date.now() - CONFIRM.started;
      if (el > maxWait) {
        warn('等了 ' + Math.round(el / 1000) + 's 按钮还是不可点 —— 多半缺取票方式/实名信息，或没勾同意，请你手动处理');
        warn('页面上现有的可点元素（发我这份我就能对上）：' + JSON.stringify(listClickables()));
        setStatus('放弃自动按（按钮一直不可点）');
        CONFIRM.done = true;
        return;
      }
      var any = findConfirmButton();
      // 找了 3 秒还没见到按钮，先把页面上的按钮列出来，方便定位
      if (!any && el > 3000 && !CONFIRM.listed) {
        CONFIRM.listed = true;
        log('暂时没看到「确认订购」这类按钮，页面上可点的是：');
        console.table(listClickables().map(function (s) { return { 可点元素: s }; }));
        log('（如果这里是 iframe 套的，我也已经在所有同源 iframe 里找过了）');
      }
      setStatus('盯着「确认订购」…已等 ' + (el / 1000).toFixed(1) + 's' + (any ? '（按钮在，还不可点）' : '（按钮还没出现）'));
      CONFIRM.timer = setTimeout(step, poll);
    }
    step();
  }
  SHCS.pressConfirm = function () {
    var b = findConfirmButton();
    if (!b) { warn('页面上没找到「确认订购」按钮'); return false; }
    if (!isVisible(b) || isDisabled(b)) {
      warn('按钮还不可点，我继续盯着（autoSubmitOrder=' + (!!CONFIG.autoSubmitOrder) + '）');
      if (CONFIG.autoSubmitOrder) watchConfirmButton();
      return false;
    }
    var n = checkAgreements();
    if (n) log('勾了 ' + n + ' 个“同意”项');
    try { b.click(); log('已按「确认订购」'); return true; } catch (e) { err('点击失败：' + (e.message || e)); return false; }
  };
  async function autoCheckout() {
    var r = cartRoute();
    if (CHECKOUT_DONE) return;
    if (r.onCart && CONFIG.autoCheckout) {
      CHECKOUT_DONE = true;
      var btn = document.querySelector('a.jiesuan') || findClickable(/结算|Checkout/, 'a');
      if (btn) {
        log('购物车页：自动点「结算 Checkout」→ ' + (btn.href || btn.getAttribute('href') || ''));
        setStatus('已自动去结算…');
        btn.click();
      } else {
        warn('购物车页没找到「结算 Checkout」按钮（购物车是不是空的？）');
      }
      return;
    }
    if (r.onConfirm && CONFIG.autoSubmitOrder) {
      CHECKOUT_DONE = true;
      watchConfirmButton();
    }
  }
  SHCS.checkout = function () {
    var r = cartRoute();
    if (r.onCart) {
      var btn = document.querySelector('a.jiesuan') || findClickable(/结算|Checkout/, 'a');
      if (btn) { btn.click(); return true; }
      warn('没找到「结算 Checkout」按钮'); return false;
    }
    if (r.onConfirm) {
      return SHCS.pressConfirm();
    }
    warn('当前不在购物车页/结算页（' + location.pathname + '）');
    return false;
  };
  SEAT.diag = async function () {
    var out = {
      when: new Date().toISOString(), href: location.href, protocol: location.protocol, route: seatRoute(),
      ok: SEAT.ok, source: SEAT.source, gunzipBy: SEAT.gunzipBy || '', httpStatus: SEAT.httpStatus || '',
      programId: SEAT.programId, eventId: SEAT.eventId,
      seats: SEAT.seats.length, free: freeSeats().length, error: SEAT.lastError,
      env: {
        jQuery: !!window.jQuery, jQueryVersion: (window.jQuery && window.jQuery.fn && window.jQuery.fn.jquery) || '',
        pako: !!window.pako, DecompressionStream: typeof DecompressionStream === 'function',
        seatElsInDom: document.querySelectorAll('s.s-c, .s-c').length,
        pageBroken: !!SEAT.pageBroken,
      },
      apiRawSnippet: SEAT.rawSnippet || '',
      buyButton: (function () { var st = buyButtonState(); return { found: !!st.wrap, gray: st.gray, text: st.text }; })(),
      rules: CONFIG.rules,
    };
    var agg = {};
    freeSeats().forEach(function (s) { var k = s.zn + ' ￥' + s.pa; agg[k] = (agg[k] || 0) + 1; });
    out.inventory = Object.keys(agg).sort().map(function (k) { return k + ' → ' + agg[k]; });
    out.sampleSeat = freeSeats().slice(0, 3);
    console.log('%c[SHCS-DIAG] 选座页自检', 'color:#08f;font-weight:bold');
    console.log(JSON.stringify(out, null, 2));
    showText('SHCS 选座页自检（复制发我）', JSON.stringify(out, null, 2));
    return out;
  };

  var canDom = typeof document !== 'undefined' && !!document.createElement;
  var statusEl = null;
  function setStatus(t) { if (statusEl) statusEl.textContent = t; }
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
    if (!canDom || !document.body) { console.log('[SHCS] ' + title + '\n' + text); return; }
    var old = document.getElementById('shcs-diag-box');
    if (old && old.parentNode) old.parentNode.removeChild(old);
    var wrap = document.createElement('div');
    wrap.id = 'shcs-diag-box';
    wrap.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;width:520px;max-width:92vw;background:#101a24;color:#e6e6e6;border-radius:10px;padding:10px 12px;box-shadow:0 6px 24px rgba(0,0,0,.5);font-family:system-ui,Arial;';
    var h = document.createElement('div');
    h.textContent = title;
    h.style.cssText = 'font-weight:700;font-size:13px;margin-bottom:6px;';
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'width:100%;height:230px;box-sizing:border-box;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;line-height:1.45;background:#0b1219;color:#cfe;border:1px solid #2a3a4a;border-radius:6px;padding:6px;';
    ta.onclick = function () { ta.select(); };
    var bar = document.createElement('div');
    var copy = btn('复制', '#48c', function () {
      ta.focus(); ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) {}
      if (!ok && navigator.clipboard) navigator.clipboard.writeText(ta.value).catch(function () {});
      copy.textContent = '已复制 ✓';
      setTimeout(function () { copy.textContent = '复制'; }, 2500);
    });
    var close = btn('关闭', '#556', function () { if (wrap.parentNode) wrap.parentNode.removeChild(wrap); });
    bar.appendChild(copy); bar.appendChild(close);
    wrap.appendChild(h); wrap.appendChild(ta); wrap.appendChild(bar);
    document.body.appendChild(wrap);
    ta.focus(); ta.select();
  }
  function mountPanel() {
    if (!canDom || window.__SHCS_PANEL__) return;
    var onSeat = seatRoute().onSeat || seatRoute().onLocalSeat;
    var cr = cartRoute();
    var box = document.createElement('div');
    box.style.cssText = 'position:fixed;left:16px;bottom:16px;z-index:2147483647;background:#22303f;color:#e6e6e6;font-family:system-ui,Arial;box-shadow:0 6px 24px rgba(0,0,0,.35);border-radius:10px;padding:10px 12px;width:250px;';
    var t = document.createElement('div');
    t.textContent = onSeat ? 'SHCS 文化广场 · 一键抢座'
      : (cr.onCart ? 'SHCS 文化广场 · 购物车'
        : (cr.onConfirm ? 'SHCS 文化广场 · 结算页' : 'SHCS 文化广场 · 余票监控'));
    t.style.cssText = 'font-weight:700;font-size:13px;margin-bottom:6px;';
    var info = document.createElement('div');
    info.style.cssText = 'font-size:11px;color:#9ab;margin-bottom:8px;line-height:1.5;';
    var w = document.createElement('div');
    if (cr.onCart || cr.onConfirm) {
      info.innerHTML = cr.onCart
        ? '锁到座位后停在这里。autoCheckout=' + (!!CONFIG.autoCheckout) + ' 时会自动点「结算 Checkout」'
        : '选票种/取票方式/实名 → 「确认订购」→ 付款。<br>autoSubmitOrder=' + (!!CONFIG.autoSubmitOrder)
          + ' 时脚本盯着按钮，一可点就立刻按（每 ' + (Number(CONFIG.confirmPollMs) || 150) + 'ms 看一次）';
      w.appendChild(btn(cr.onCart ? '去结算' : '立即按「确认订购」', '#e5533c', function () { SHCS.checkout(); }));
      w.appendChild(btn('重查购物车', '#48c', function () { location.reload(); }));
      if (cr.onConfirm) w.appendChild(btn('看按钮(诊断)', '#875', function () { SHCS.whatButtons(); }));
    } else if (onSeat) {
      info.innerHTML = '规则 ' + ((CONFIG.rules || []).length) + ' 条 · 场次 ' + (seatRoute().eventId || '?')
        + ' · dryRun ' + (!!CONFIG.dryRun) + ' · autoRun ' + (!!CONFIG.autoRun)
        + '<br>快捷键 Alt+Shift+ P 预演 / R 抢座 / I 库存 / T 自检';
      w.appendChild(btn('库存', '#48c', function () { setStatus('读座位中…'); SHCS.seatReload().then(function (ok) { if (ok) SHCS.seat.inventory(); setStatus(ok ? '库存见控制台' : '失败，点“自检”看原因'); }); }));
      w.appendChild(btn('预演', '#3a7', function () { setStatus('预演中…'); SHCS.seatReload().then(function (ok) { if (ok) SHCS.seat.plan(); setStatus(ok ? '预演完，见控制台' : '失败，点“自检”'); }); }));
      w.appendChild(btn('一键抢座', '#e5533c', function () { setStatus('抢座中…'); SHCS.seat.run().then(function (r) { setStatus(r && r.success ? (r.planned ? '预演完成' : '已锁座，去结算页') : '没抢到，看控制台'); }); }));
      w.appendChild(btn('刷新座位', '#777', function () { setStatus('刷新中…'); SHCS.seatReload().then(function () { setStatus(SEAT.ok ? '座位已刷新' : ('失败：' + SEAT.lastError)); }); }));
      w.appendChild(btn('按「确认订购」', '#d81', function () { setStatus('盯着「确认订购」…'); SHCS.pressSeatConfirm().then(function (ok) { setStatus(ok ? '已按「确认订购」' : '没按成，看控制台'); }); }));
      w.appendChild(btn('去结算页', '#d81', function () { SHCS.seat.cart(); }));
      w.appendChild(btn('自检/复制', '#875', function () { SHCS.seat.diag(); }));
    } else {
      info.innerHTML = '演出 ' + (programId() || '(未识别)') + ' · 每 ' + ((Number(CONFIG.pollMs) || 20000) / 1000) + 's 查一次'
        + '<br>快捷键 Alt+Shift+C 查场次 · W 监控 · X 停止';
      w.appendChild(btn('查场次', '#48c', function () { setStatus('查询中…'); SHCS.check().then(function () { setStatus('查完，见控制台表格'); }); }));
      w.appendChild(btn('开始监控', '#e5533c', function () { SHCS.watch(); }));
      w.appendChild(btn('停止', '#777', function () { SHCS.stop(); }));
      w.appendChild(btn('选座页', '#d81', function () { SHCS.open(); }));
      w.appendChild(btn('自检/复制', '#875', function () { SHCS.diag(); }));
    }
    statusEl = document.createElement('div');
    statusEl.style.cssText = 'font-size:11px;color:#8cf;margin-top:8px;min-height:14px;line-height:1.4;';
    box.appendChild(t); box.appendChild(info); box.appendChild(w); box.appendChild(statusEl);
    document.body.appendChild(box);
    window.__SHCS_PANEL__ = box;
    setStatus(onSeat
      ? (seatRoute().eventId ? '选座页就绪：先点“库存”看一眼，再“预演”' : '这个选座页 URL 里没有 xz_event_id')
      : (cr.onCart ? (CONFIG.autoCheckout ? '购物车页：正在自动去结算…' : '购物车页：点“去结算”') : (programId() ? '就绪：点“查场次”' : '这个页面没带演出 id，去演出详情页或填 config.yaml')));
  }
  if (canDom) window.addEventListener('keydown', function (e) {
    if (!e.altKey || !e.shiftKey || e.ctrlKey || e.metaKey) return;
    var k = String(e.key || '').toLowerCase();
    var onSeat = seatRoute().onSeat || seatRoute().onLocalSeat;
    if (onSeat && k === 'r') { e.preventDefault(); setStatus('抢座中…'); SHCS.seat.run().then(function (r) { setStatus(r && r.success ? '完成' : '没抢到，看控制台'); }); }
    else if (onSeat && k === 'p') { e.preventDefault(); SHCS.seatReload().then(function (ok) { if (ok) SHCS.seat.plan(); }); }
    else if (onSeat && k === 'i') { e.preventDefault(); SHCS.seatReload().then(function (ok) { if (ok) SHCS.seat.inventory(); }); }
    else if (onSeat && k === 't') { e.preventDefault(); SHCS.seat.diag(); }
    else if (!onSeat && k === 'c') { e.preventDefault(); SHCS.check(); }
    else if (!onSeat && k === 'w') { e.preventDefault(); SHCS.watch(); }
    else if (!onSeat && k === 'x') { e.preventDefault(); SHCS.stop(); }
  }, true);

  window.SHCS = SHCS;
  SHCS.seat = SEAT;
  SHCS.seatReload = seatReload;
  SHCS.seatRun = function () { return SEAT.run(); };
  log('已加载(文化广场) v' + (CONFIG.buildVersion || '?') + '。' + (seatRoute().onSeat || seatRoute().onLocalSeat
    ? '选座页模式：Alt+Shift+ P 预演 / R 抢座 / I 库存 / T 自检'
      : (cartRoute().onCart ? ('购物车页：autoCheckout=' + (!!CONFIG.autoCheckout) + '（自动点“结算 Checkout”）')
      : (cartRoute().onConfirm ? ('结算页：盯着「确认订购」，autoSubmitOrder=' + (!!CONFIG.autoSubmitOrder))
        : '余票监控模式：Alt+Shift+C 查场次 / W 监控 / X 停止'))));
  if (canDom) {
    var boot = function () {
      var r = seatRoute();
      var seatLike = r.onSeat || r.onLocalSeat;
      var cr = cartRoute();
      // 本地另存为的普通网页（不是选座页）就别弹面板了
      if (isLocalFile() && !seatLike && !cr.onCart && !cr.onConfirm) return;
      mountPanel();
      if (cr.onCart || cr.onConfirm) {
        // 购物车：按配置自动去结算；结算页：盯着「确认订购」，一可点就按
        if (cr.onCart && CONFIG.autoCheckout) setTimeout(function () { autoCheckout(); }, 800);
        if (cr.onConfirm && CONFIG.autoSubmitOrder) watchConfirmButton();
        return;
      }
      if (seatLike) {
        seatReload().then(function (ok) {
          setStatus(ok ? '选座页就绪，可“预演/一键抢座”' : ('加载失败：' + SEAT.lastError));
          if (!ok) {
            // 加载失败就把现场信息摊开（含：页面自己的 JS 是不是挂了）
            err('选座页数据加载失败：' + SEAT.lastError);
            SEAT.diag().catch(function (e) { warn('自检也失败了：', (e && e.message) || e); });
          }
          if (ok && CONFIG.autoRun && !window.__SHCS_AUTORUN__) {
            window.__SHCS_AUTORUN__ = true;
            log('autoRun 触发，自动抢座');
            SEAT.run();
          }
        });
      }
    };
    if (document.body) boot(); else window.addEventListener('DOMContentLoaded', boot);
  }
})();
