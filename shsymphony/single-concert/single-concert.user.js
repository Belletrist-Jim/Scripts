// ==UserScript==
// @name         SHS 上交单场选座抢座 (single-concert)
// @namespace    shsymphony-single-concert
// @version      1.0.1788842914
// @description  上海交响乐团单场选座：悬浮面板 + 快捷键(Alt+Shift+P 预演 / R 抢座 / I 库存) + 可选 autoRun。改 config.yaml 后重新 ./build.sh single-concert，再到油猴“检查更新”。
// @author       -
// @match        https://www.shsymphony.cn/symphonypc/*
// @run-at       document-idle
// @downloadURL  http://127.0.0.1:8770/single-concert/single-concert.user.js
// @updateURL    http://127.0.0.1:8770/single-concert/single-concert.user.js
// @grant        none
// ==/UserScript==

/* 由 build.mjs 从 single-concert/config.yaml 生成于 2026-09-08T04:48:34.540Z，请勿手改；改配置请改 config.yaml 后重新 ./build.sh single-concert */
window.__SEAT_CONFIG__ = {
  "scheduleId": "",
  "mobile": "",
  "dryRun": false,
  "autoRun": true,
  "submitOrder": true,
  "maxRetryPerRule": 5,
  "rules": [
    {
      "price": 280,
      "qty": 3,
      "areas": [
        "A",
        "B",
        "F",
        "J",
        "C",
        "D",
        "I",
        "E",
        "H",
        "G"
      ]
    },
    {
      "price": 280,
      "qty": 2,
      "areas": [
        "A",
        "B",
        "F",
        "J",
        "C",
        "D",
        "I",
        "E",
        "H",
        "G"
      ]
    },
    {
      "price": 280,
      "qty": 1,
      "areas": [
        "A",
        "B",
        "F",
        "J",
        "C",
        "D",
        "I",
        "E",
        "H",
        "G"
      ]
    }
  ]
};

/* ============================================================
 * 上海交响乐团 · 单场“选座”页自动锁座引擎
 * ------------------------------------------------------------
 * 这是逻辑本体。真正粘贴到浏览器控制台的是 build-seat.mjs 生成的
 * seat-console.js（= 本文件 + 由 seat.yaml 注入的配置）。
 *
 * 运行位置：登录后、带 pk/sk 的“选座”页控制台：
 *   https://www.shsymphony.cn/symphonypc/index.html#/zh-CN/pc/seat?id=1646&supportSeat=Y&pk=...&sk=...
 *
 * 核心概念：
 *   - 页面选座只是本地高亮，真正“锁座”是提交 order/create（原子占座并生成待付款订单）。
 *   - 读数据优先复用页面已加载好的 Vue 组件数据（座位图/价位/库存快照），免接口、抗开票期限流；
 *     缺失时再回退到接口。锁座与刷新库存按 App 的请求头规范直接调同样接口，等价于真实点击，
 *     cookie 由浏览器同源自动带上。
 *   - 开票时可能被别人同时抢走：锁座失败会自动刷新库存并重挑次优座位。
 *
 * 座位分布规则（写死；依据线上核实的 捷豹上海交响音乐厅 座位图）：
 *   - A / C / J 区：单一区域、不分左右，从中心向两侧编号（座号 1 在正中）→ 越靠中心越好。
 *   - B/D/E/F/G/H/I 区：分“单号(奇数=左)”与“双号(偶数=右)”→ 优先右边(双号)，其次左边(单号)。
 *   - 排的朝向因区而异，且排内有过道；连坐/相邻一律用座位 x/y 栅格相邻判定，不用座号相减。
 *   - 排的尝试顺序：A/G/H/I/J 区 = 3,4,5,…,末排, 2, 1；其余区 = 1,2,3,…（升序）。
 *
 * 常用命令：
 *   SEAT.reload()      重新拉取场次/价位/库存/座位图
 *   SEAT.inventory()   查看各区各价位实时余票
 *   SEAT.plan()        预演：按当前库存推算每条规则会挑到哪些座（不锁座）
 *   SEAT.run()         执行：按 rules 顺序挑座并锁座，失败自动刷新重挑
 *   SEAT.releaseInfo() 说明如何释放（锁到后是订单，需在订单页取消）
 * ============================================================ */
(function () {
  'use strict';

  // 防止重复注入
  if (typeof window !== 'undefined' && window.__SEAT_ENGINE__) { console.warn('[SEAT] 已加载，跳过重复注入。'); return; }
  if (typeof window !== 'undefined') window.__SEAT_ENGINE__ = true;

  // 由 build 注入；独立运行时用这个空配置。
  var DEFAULT_CONFIG = { scheduleId: '', mobile: '', dryRun: false, autoRun: false, submitOrder: true, maxRetryPerRule: 40, rules: [] };
  var CONFIG = (typeof window !== 'undefined' && window.__SEAT_CONFIG__) ? window.__SEAT_CONFIG__ : DEFAULT_CONFIG;

  // ---- 写死的分布规则 ----
  var SPECIAL_ROW_AREAS = { A: 1, G: 1, H: 1, I: 1, J: 1 }; // 这些区从 3 排起往后，再 2、1
  var RIGHT_LABEL = '双号'; // “右边”=双号（已核实双号在布局大 x 一侧）；若你所指“右”相反，改成 '单号'
  var LEFT_LABEL = RIGHT_LABEL === '双号' ? '单号' : '双号';

  var API = {
    scheduleInfo: 'thvendor/member/symphony/ticket/getScheduleInfo.xhtml',
    prices: 'thvendor/member/ticket/getSchedulePrices.xhtml',
    avail: 'thvendor/member/ticket/getAvailableSeats.xhtml',
    create: 'thvendor/member/ticket/order/create.xhtml',
  };

  var SEAT = {};
  SEAT.config = CONFIG;
  SEAT.setConfig = function (o) { CONFIG = o; SEAT.config = o; console.log('[SEAT] 配置已替换'); return o; };

  // ---------------- URL / 请求头 ----------------
  function urlQuery() {
    var hash = location.hash || '';
    var qs = hash.indexOf('?') > -1 ? hash.slice(hash.indexOf('?') + 1) : '';
    return new URLSearchParams(qs);
  }
  function lang() { return (location.href.indexOf('zh-CN') > -1) ? 'zh-CN' : 'en'; }
  function scheduleId() { return String(CONFIG.scheduleId || urlQuery().get('id') || ''); }
  function programKey() { return urlQuery().get('pk') || ''; }
  function sessionKey() { return urlQuery().get('sk') || ''; }
  function supportSeat() { return urlQuery().get('supportSeat') || 'Y'; }

  function rootVue() { var el = document.getElementById('app'); return el && el.__vue__; }
  function mpsessid() {
    try {
      var r = rootVue();
      var mi = r && r.$store && r.$store.state && r.$store.state.user && r.$store.state.user.memberInfo;
      return (mi && mi.memberEncode) || '';
    } catch (e) { return ''; }
  }

  // 在 Vue 组件树里找到“选座”页组件（含已加载好的座位/价位数据），用于免接口读取，降低开票期接口压力。
  function findSeatComp() {
    try {
      var root = rootVue();
      if (!root) return null;
      var found = null, seen = new Set();
      (function walk(vm) {
        if (!vm || found || seen.has(vm)) return;
        seen.add(vm);
        if (vm.venueAreaMap && vm.seatColors && typeof vm.selector === 'function' && ('seatInfo' in vm.$data)) { found = vm; return; }
        (vm.$children || []).forEach(walk);
      })(root);
      return found;
    } catch (e) { return null; }
  }

  // withKeys=true 时附带 programKey/sessionKey 请求头（和页面读/下单接口保持一致）
  function headers(withKeys) {
    var h = {
      'cmpappkey': 'shsymphonyPC',
      'lang': lang(),
      'sourcepage': location.pathname + location.hash,
      'content-type': 'application/x-www-form-urlencoded',
    };
    if (withKeys) {
      var pk = programKey(), sk = sessionKey();
      if (pk) h['programKey'] = pk;
      if (sk) h['sessionKey'] = sk;
    }
    var ms = mpsessid();
    if (ms) h['mpsessid'] = ms;
    return h;
  }

  async function api(path, query, withKeys) {
    var body = new URLSearchParams(query).toString();
    var resp = await fetch('/' + path, {
      method: 'POST', headers: headers(withKeys), body: body, credentials: 'same-origin',
    });
    return resp.json();
  }

  // ---------------- 场馆分布：解析区域字母 ----------------
  // venueAreaMap: { 104:"A区", 105:"B区 单号", 114:"B区 双号", ... }
  // 生成 AREA_INDEX: { A:{single:104}, B:{单号:105,双号:114}, ... }，以及 idMeta[id]={letter,side}
  function buildAreaIndex(venueAreaMap) {
    var index = {}, idMeta = {};
    Object.keys(venueAreaMap || {}).forEach(function (id) {
      var name = String(venueAreaMap[id]);
      var m = name.match(/^([A-Za-z])\s*区/);
      if (!m) return;
      var letter = m[1].toUpperCase();
      var side = name.indexOf('单号') > -1 ? '单号' : (name.indexOf('双号') > -1 ? '双号' : 'single');
      index[letter] = index[letter] || {};
      index[letter][side] = Number(id);
      idMeta[id] = { letter: letter, side: side };
    });
    return { index: index, idMeta: idMeta };
  }

  // 单个区域字母内“子区 + 连坐/上下排”的尝试顺序
  //   分左右区：双(右)连坐 → 单(左)连坐 → 双(右)上下排 → 单(左)上下排
  //   单一区（A/C/J）：连坐 → 上下排
  function bucketsForLetter(letter, areaIndex) {
    var a = areaIndex[letter];
    if (!a) return [];
    if (a.single != null) {
      return [
        { areaId: a.single, side: 'single', type: 'row' },
        { areaId: a.single, side: 'single', type: 'stack' },
      ];
    }
    var right = a[RIGHT_LABEL], left = a[LEFT_LABEL];
    var out = [];
    if (right != null) out.push({ areaId: right, side: '右', type: 'row' });
    if (left != null) out.push({ areaId: left, side: '左', type: 'row' });
    if (right != null) out.push({ areaId: right, side: '右', type: 'stack' });
    if (left != null) out.push({ areaId: left, side: '左', type: 'stack' });
    return out;
  }

  // 排的优先顺序 → 返回“排号 → 优先序号”映射（序号越小越优先）
  function rowRankMap(letter, rowsAsc) {
    var order;
    if (SPECIAL_ROW_AREAS[letter]) {
      var back = rowsAsc.filter(function (r) { return r >= 3; });          // 3,4,5,...
      var front = rowsAsc.filter(function (r) { return r < 3; }).sort(function (x, y) { return y - x; }); // 2,1
      order = back.concat(front);
    } else {
      order = rowsAsc.slice(); // 升序
    }
    var map = {};
    order.forEach(function (r, i) { map[r] = i; });
    return map;
  }

  // ---------------- 状态 ----------------
  var STATE = {
    loaded: false,
    programName: '', schedule: {}, venueAreaMap: {},
    areaIndex: {}, idMeta: {},
    priceById: {}, priceByAmount: {},   // ticketPriceId -> priceObj ; amount -> [ticketPriceId,...]
    seatByKey: {},                      // "areaId:rowNo:colNo" -> {x,y,rowNo,colNo,areaId,letter}
    seatsByArea: {},                    // areaId -> [seat,...]（含全部座位）
    rowsByArea: {},                     // areaId -> 升序 distinct rowNo 数组
    avail: {},                          // "areaId:ticketPriceId" -> [seatKey,...]（实时可售）
    refreshStatus: { ok: false, source: 'none', msg: '' },
  };

  // 用一份座位图数组（[{x,y,rowNo,colNo,venueAreaId}...]）构建 seatByKey / seatsByArea / rowsByArea
  function buildSeatModel(seatArr) {
    STATE.seatByKey = {}; STATE.seatsByArea = {}; STATE.rowsByArea = {};
    (seatArr || []).forEach(function (s) {
      var areaId = Number(s.venueAreaId);
      var seat = {
        x: Number(s.x), y: Number(s.y),
        rowNo: String(s.rowNo), colNo: String(s.colNo),
        rowN: Number(s.rowNo), colN: Number(s.colNo),
        areaId: areaId, letter: (STATE.idMeta[areaId] && STATE.idMeta[areaId].letter) || '?',
      };
      STATE.seatByKey[areaId + ':' + seat.rowNo + ':' + seat.colNo] = seat;
      (STATE.seatsByArea[areaId] = STATE.seatsByArea[areaId] || []).push(seat);
    });
    Object.keys(STATE.seatsByArea).forEach(function (areaId) {
      var rows = {};
      STATE.seatsByArea[areaId].forEach(function (s) { rows[s.rowN] = 1; });
      STATE.rowsByArea[areaId] = Object.keys(rows).map(Number).sort(function (a, b) { return a - b; });
    });
  }

  // 用组件 seatInfo.seats（每座含 ticketPriceId，可售座才有值）重建实时可售集合
  function availFromComponentSeats(seatArr) {
    var avail = {};
    (seatArr || []).forEach(function (s) {
      if (!s.ticketPriceId) return; // 空 = 已售/不可选
      var areaId = Number(s.venueAreaId);
      var key = areaId + ':' + s.ticketPriceId;
      (avail[key] = avail[key] || []).push(areaId + ':' + s.rowNo + ':' + s.colNo);
    });
    return avail;
  }

  // ---------------- 加载 ----------------
  // 优先复用“选座”页组件里已加载好的数据（免接口、抗开票期限流）；缺失时回退到接口。
  SEAT.reload = async function () {
    var sid = scheduleId();
    if (!sid) { console.error('[SEAT] 找不到 scheduleId（URL 无 id 参数，也未在配置里指定）。请在选座页运行。'); return false; }

    var comp = findSeatComp();
    var fromComp = comp && comp.venueAreaMap && comp.seatColors && comp.seatInfo && Array.isArray(comp.seatInfo.seats) && comp.seatInfo.seats.length;

    if (fromComp) {
      STATE.programName = comp.programName || '';
      STATE.schedule = comp.schedule || {};
      STATE.venueAreaMap = comp.venueAreaMap || {};
      var aiC = buildAreaIndex(STATE.venueAreaMap);
      STATE.areaIndex = aiC.index; STATE.idMeta = aiC.idMeta;
      STATE.priceById = {}; STATE.priceByAmount = {};
      Object.keys(comp.seatColors).forEach(function (tpid) {
        var p = comp.seatColors[tpid]; if (!p) return;
        STATE.priceById[tpid] = p;
        var amt = Number(p.price);
        (STATE.priceByAmount[amt] = STATE.priceByAmount[amt] || []).push(isNaN(Number(tpid)) ? tpid : Number(tpid));
      });
      buildSeatModel(comp.seatInfo.seats);
      STATE.avail = availFromComponentSeats(comp.seatInfo.seats);
      STATE.loaded = true;
      console.log('%c[SEAT] 已加载(复用页面数据)：' + STATE.programName + ' | ' + (STATE.schedule.playTime || '') +
        ' | 座位' + Object.keys(STATE.seatByKey).length + ' | 单笔上限' + (STATE.schedule.maxBuyLimit || '?') + '张',
        'color:#0a0;font-weight:bold');
      warnRealname();
      return true;
    }

    // —— 回退：走接口 ——
    var info = await api(API.scheduleInfo, { scheduleId: sid }, true);
    if (!info || !info.success || !info.data) { console.error('[SEAT] getScheduleInfo 失败：', info && info.msg); return false; }
    STATE.programName = info.data.programName || '';
    STATE.schedule = info.data.schedule || {};
    STATE.venueAreaMap = info.data.venueAreaMap || {};
    var ai = buildAreaIndex(STATE.venueAreaMap);
    STATE.areaIndex = ai.index; STATE.idMeta = ai.idMeta;
    var publishUrl = info.data.seatPlan && info.data.seatPlan.publishUrl;
    if (!publishUrl) { console.error('[SEAT] 座位图 publishUrl 缺失。'); return false; }

    var pr = await api(API.prices, { scheduleId: sid }, true);
    if (!pr || !pr.success) { console.error('[SEAT] getSchedulePrices 失败：', pr && pr.msg, '（可尝试先让页面把座位图渲染出来，再运行 SEAT.reload()）'); return false; }
    STATE.priceById = {}; STATE.priceByAmount = {};
    (pr.data || []).forEach(function (p) {
      STATE.priceById[p.ticketPriceId] = p;
      var amt = Number(p.price);
      (STATE.priceByAmount[amt] = STATE.priceByAmount[amt] || []).push(p.ticketPriceId);
    });

    // 座位图（静态 JSON，CDN）：每座 {x,y,rowNo,colNo,venueAreaId}
    var plan = await (await fetch(publishUrl, { credentials: 'omit' })).json();
    buildSeatModel(plan.seats);

    await SEAT.refresh();
    STATE.loaded = true;
    console.log('%c[SEAT] 已加载(接口)：' + STATE.programName + ' | ' + (STATE.schedule.playTime || '') +
      ' | 座位' + Object.keys(STATE.seatByKey).length + ' | 单笔上限' + (STATE.schedule.maxBuyLimit || '?') + '张',
      'color:#0a0;font-weight:bold');
    warnRealname();
    return true;
  };

  function warnRealname() {
    if (STATE.schedule.checkcard && STATE.schedule.checkcard !== 'N') {
      console.warn('[SEAT] 本场为实名场次(checkcard=' + STATE.schedule.checkcard + ')：自动锁座可能需实名信息，锁座失败时请手动完成实名。');
    }
  }

  // 只刷新实时可售库存（下单失败/重挑时用）。接口限流失败时回退到页面组件快照，仍失败则保留上次库存。
  SEAT.refresh = async function () {
    var sid = scheduleId();
    var av = await api(API.avail, { scheduleId: sid }, true);
    if (av && av.success && Array.isArray(av.data)) {
      var next = {};
      av.data.forEach(function (grp) {
        var areaId = Number(grp.venueAreaId), tpid = grp.ticketPriceId;
        next[areaId + ':' + tpid] = String(grp.seats || '').split(',').filter(Boolean).map(function (rc) { return areaId + ':' + rc; });
      });
      STATE.avail = next;
      STATE.refreshStatus = { ok: true, source: 'api', msg: '' };
      return STATE.avail;
    }
    var comp = findSeatComp();
    if (comp && comp.seatInfo && Array.isArray(comp.seatInfo.seats)) {
      STATE.avail = availFromComponentSeats(comp.seatInfo.seats);
      STATE.refreshStatus = { ok: false, source: 'component', msg: av && (av.msg || av.errcode) };
      console.warn('[SEAT] getAvailableSeats 未成功(' + (av && (av.msg || av.errcode)) + ')，改用页面快照库存。');
    } else {
      STATE.refreshStatus = { ok: false, source: 'cached', msg: av && (av.msg || av.errcode) };
      console.warn('[SEAT] 刷新库存失败(' + (av && (av.msg || av.errcode)) + ')，沿用上次库存。');
    }
    return STATE.avail;
  };

  // 取某区某价位当前可售的座位对象（含 x/y），并附上 ticketPriceId / price
  function availableSeats(areaId, tpid) {
    var keys = STATE.avail[areaId + ':' + tpid] || [];
    var out = [];
    var p = STATE.priceById[tpid];
    for (var i = 0; i < keys.length; i++) {
      var s = STATE.seatByKey[keys[i]];
      if (!s) continue; // 座位图里没有该座（异常，跳过）
      out.push(Object.assign({}, s, { ticketPriceId: tpid, price: p ? Number(p.price) : null }));
    }
    return out;
  }

  // ---------------- 挑座核心：栅格直线 ----------------
  // 在一组座位里，沿“固定 y 变 x”和“固定 x 变 y”两个方向，找出步长为 1 的连续直线段（长度≥2）。
  function straightRuns(seats) {
    var runs = [];
    function scan(groupKey, sortKey) {
      var groups = {};
      seats.forEach(function (s) { (groups[s[groupKey]] = groups[s[groupKey]] || []).push(s); });
      Object.keys(groups).forEach(function (g) {
        var arr = groups[g].slice().sort(function (a, b) { return a[sortKey] - b[sortKey]; });
        var run = [arr[0]];
        for (var i = 1; i < arr.length; i++) {
          if (arr[i][sortKey] - arr[i - 1][sortKey] === 1) run.push(arr[i]);
          else { if (run.length > 1) runs.push(run.slice()); run = [arr[i]]; }
        }
        if (run.length > 1) runs.push(run);
      });
    }
    scan('y', 'x'); // 水平直线
    scan('x', 'y'); // 竖直直线
    return runs;
  }

  function distinctRows(seatArr) { var m = {}; seatArr.forEach(function (s) { m[s.rowN] = 1; }); return Object.keys(m); }

  // 在某区某价位、按 type（row=连坐 / stack=上下排）找出所有 qty 连续座位候选
  function candidatesIn(areaId, tpid, qty, type, letter) {
    var seats = availableSeats(areaId, tpid);
    if (!seats.length) return [];
    var rowMap = rowRankMap(letter, STATE.rowsByArea[areaId] || []);
    var cands = [];

    if (qty <= 1) {
      if (type !== 'row') return []; // qty=1 只在 row 桶里产出，避免重复
      seats.forEach(function (s) { cands.push(makeCand([s], rowMap)); });
      return sortCands(cands);
    }

    var runs = straightRuns(seats);
    runs.forEach(function (run) {
      for (var i = 0; i + qty <= run.length; i++) {
        var win = run.slice(i, i + qty);
        var rows = distinctRows(win);
        var isRow = rows.length === 1;
        if (type === 'row' && !isRow) continue;
        if (type === 'stack' && isRow) continue; // 同排的归“连坐”，不算“上下排”
        cands.push(makeCand(win, rowMap));
      }
    });
    return sortCands(cands);
  }

  function makeCand(seatWin, rowMap) {
    var rowScore = Infinity, colSum = 0, maxCol = 0;
    seatWin.forEach(function (s) {
      var rs = rowMap[s.rowN]; if (rs == null) rs = 9999;
      if (rs < rowScore) rowScore = rs;
      colSum += s.colN; if (s.colN > maxCol) maxCol = s.colN;
    });
    return { seats: seatWin, rowScore: rowScore, colSum: colSum, maxCol: maxCol };
  }

  function sortCands(cands) {
    return cands.sort(function (a, b) {
      return a.rowScore - b.rowScore || a.colSum - b.colSum || a.maxCol - b.maxCol;
    });
  }

  // 按“区域优先 → 桶顺序”为一条规则挑出最佳候选组；找不到返回 null。
  // failedCombos 记录本轮已失败的座位组合，避免库存滞后时反复撞同一组。
  function pickForRule(rule, failedCombos) {
    var qty = Number(rule.qty) || 1;
    var tpids = ticketPriceIds(rule.price);
    if (!tpids.length) return { error: '该场没有票价 ' + rule.price + ' 元' };
    var areas = (rule.areas || []).map(function (x) { return String(x).trim().toUpperCase(); });

    for (var ai = 0; ai < areas.length; ai++) {
      var letter = areas[ai];
      var buckets = bucketsForLetter(letter, STATE.areaIndex);
      if (!buckets.length) continue; // 该场没有此区
      for (var bi = 0; bi < buckets.length; bi++) {
        var b = buckets[bi];
        var all = [];
        for (var ti = 0; ti < tpids.length; ti++) {
          all = all.concat(candidatesIn(b.areaId, tpids[ti], qty, b.type, letter));
        }
        if (failedCombos && failedCombos.size) {
          all = all.filter(function (cand) { return !failedCombos.has(seatComboKey(cand.seats)); });
        }
        if (all.length) {
          var best = sortCands(all)[0];
          return {
            rule: rule, letter: letter, side: b.side,
            type: b.type, typeName: b.type === 'row' ? '连坐' : '上下排',
            areaId: b.areaId, seats: best.seats, cand: best,
          };
        }
      }
    }
    return null;
  }

  function ticketPriceIds(price) {
    var ids = STATE.priceByAmount[Number(price)] || [];
    return ids.slice();
  }

  function seatLabel(s) { return (STATE.venueAreaMap[s.areaId] || s.letter + '区') + ' ' + s.rowNo + '排' + s.colNo + '座'; }
  function pickLabel(pick) {
    if (!pick || pick.error) return pick && pick.error ? pick.error : '无';
    return '[' + pick.letter + '区/' + pick.side + '/' + pick.typeName + '] ' + pick.seats.map(seatLabel).join(' , ');
  }

  function seatToken(s) { return [s.ticketPriceId, s.areaId, s.rowNo, s.colNo].join(':'); }
  function seatComboKey(seats) { return seats.map(seatToken).sort().join('|'); }
  function totalAvailCount() {
    var n = 0;
    Object.keys(STATE.avail || {}).forEach(function (k) { n += (STATE.avail[k] || []).length; });
    return n;
  }

  function componentSeat(s) {
    var fullKey = s.areaId + ':' + s.rowNo + ':' + s.colNo;
    return Object.assign({}, s, {
      fullKey: fullKey,
      venueAreaId: s.areaId,
      certificationId: s.certificationId || '',
    });
  }

  function wait(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

  // ---------------- 选座 / 锁座 ----------------
  function selectSeatsInComponent(seats) {
    var comp = findSeatComp();
    if (!comp) return null;

    var nextSeats = {};
    seats.forEach(function (s) {
      var cs = componentSeat(s);
      nextSeats[cs.fullKey] = cs;
    });

    comp.slectSeats = nextSeats;
    comp.slectSeatsKeys = Object.keys(nextSeats);
    comp.totalPrice = seats.reduce(function (sum, s) { return sum + (Number(s.price) || 0); }, 0);
    return comp;
  }

  async function lockSeatsViaComponent(seats) {
    var comp = selectSeatsInComponent(seats);
    if (!comp || typeof comp.createOrder !== 'function') return null;
    if (comp.schedule && comp.schedule.checkcard === 'M') {
      return { success: false, fatal: true, errcode: 'REALNAME', msg: '实名场次需要手动绑定实名信息' };
    }

    var oldRouterPush = comp.$router && comp.$router.push;
    var oldShowToast = comp.$showToast;
    var settled = false;
    var restore = function () {
      if (comp.$router && oldRouterPush) comp.$router.push = oldRouterPush;
      if (oldShowToast) comp.$showToast = oldShowToast;
    };

    comp.lockLoadding = true;

    return new Promise(function (resolve) {
      function done(res) {
        if (settled) return;
        settled = true;
        restore();
        resolve(Object.assign({ viaComponent: true }, res || {}));
      }

      if (comp.$router && oldRouterPush) {
        comp.$router.push = function (to) {
          var path = String((to && to.path) || to || '');
          var m = path.match(/[?&]tradeNo=([^&]+)/);
          done({ success: true, data: m ? decodeURIComponent(m[1]) : path, routePath: path });
          return oldRouterPush.apply(this, arguments);
        };
      }
      if (oldShowToast) {
        comp.$showToast = function (msg) {
          done({ success: false, msg: String(msg || '页面下单失败') });
          return oldShowToast.apply(this, arguments);
        };
      }

      try {
        comp.createOrder();
      } catch (e) {
        done({ success: false, msg: String(e) });
      }

      wait(8000).then(function () {
        done({ success: false, msg: '页面下单超时（未捕获到成功跳转或失败提示）' });
      });
    });
  }

  async function lockSeats(seats) {
    var byComp = await lockSeatsViaComponent(seats);
    if (byComp) return byComp;

    var payload = {
      scheduleId: scheduleId(), lockNo: '', mobile: CONFIG.mobile || '', platform: 'PC',
      seats: seats.map(function (s) {
        return { ticketPrice: s.price, ticketPriceId: s.ticketPriceId, venueAreaId: s.areaId, rowNo: s.rowNo, colNo: s.colNo, certificationId: '' };
      }),
    };
    var res = await api(API.create, { createOrderReq: JSON.stringify(payload) }, true);
    return res || { success: false, msg: '无响应' };
  }

  // 无法靠“刷新重挑”解决、需要停下人工处理的错误码：
  //   1121 = 需先处理待付款订单/会员或实名等（页面会弹“去处理”）；1122/1202/1203 = 登录态失效
  var FATAL_ERRCODES = { 1121: 1, 1122: 1, 1202: 1, 1203: 1 };

  // ---------------- 对外命令 ----------------
  SEAT.inventory = async function () {
    if (!STATE.loaded) { if (!(await SEAT.reload())) return; } else { await SEAT.refresh(); }
    var rows = [];
    Object.keys(STATE.avail).forEach(function (k) {
      var parts = k.split(':'), areaId = Number(parts[0]), tpid = Number(parts[1]);
      var p = STATE.priceById[tpid];
      rows.push({ 区域: STATE.venueAreaMap[areaId] || areaId, 价位: p ? p.price : tpid, 余票: (STATE.avail[k] || []).length });
    });
    rows.sort(function (a, b) { return String(a.区域).localeCompare(String(b.区域)) || a.价位 - b.价位; });
    console.table(rows);
    return rows;
  };

  SEAT.plan = async function () {
    if (!STATE.loaded) { if (!(await SEAT.reload())) return; } else { await SEAT.refresh(); }
    var rows = [];
    (CONFIG.rules || []).forEach(function (rule, i) {
      var pick = pickForRule(rule);
      rows.push({
        序: i + 1, 票价: rule.price, 数量: rule.qty, 区域偏好: (rule.areas || []).join('>'),
        计划: pick ? pickLabel(pick) : '当前无可满足座位',
      });
    });
    console.table(rows);
    console.log('[SEAT] 以上为“若现在锁座”的预演，不代表已占座。执行请运行 SEAT.run()');
    return rows;
  };

  SEAT.run = async function () {
    if (!(await SEAT.reload())) return;
    var maxTries = Math.max(1, Number(CONFIG.maxRetryPerRule) || 40);
    var dry = !!CONFIG.dryRun;
    var submitOrder = CONFIG.submitOrder !== false;
    if (dry) console.log('%c[SEAT] dryRun=true：只预演不锁座', 'color:#c60;font-weight:bold');
    console.log('%c[SEAT] 开始按备选链' + (submitOrder ? '挑座锁座' : '自动选座(不提交订单)') +
      '…最多每条规则尝试 ' + maxTries + ' 次', 'color:#06c;font-weight:bold');

    for (var i = 0; i < (CONFIG.rules || []).length; i++) {
      var rule = CONFIG.rules[i];
      var tag = '规则' + (i + 1) + '(￥' + rule.price + '×' + rule.qty + ' @ ' + (rule.areas || []).join('>') + ')';
      var failedCombos = new Set();

      for (var attempt = 0; attempt < maxTries; attempt++) {
        if (attempt > 0) {
          var beforeAvail = totalAvailCount();
          await SEAT.refresh(); // 被抢座后刷新库存再挑
          var afterAvail = totalAvailCount();
          var rs = STATE.refreshStatus || {};
          var refreshText = rs.ok ? 'api成功' : (rs.source === 'component' ? '接口失败/页面快照' : '接口失败/沿用旧库存');
          console.log('[SEAT] ' + tag + ' 刷新库存：' + beforeAvail + ' → ' + afterAvail +
            '，刷新=' + refreshText + '，已跳过失败组合 ' + failedCombos.size + ' 组');
        }
        var pick = pickForRule(rule, failedCombos);
        if (!pick || pick.error) {
          var reason = pick && pick.error ? pick.error : '当前无可满足座位';
          if (failedCombos.size) reason += '（已排除失败组合 ' + failedCombos.size + ' 组）';
          console.warn('[SEAT] ' + tag + '：' + reason + '，跳到下一条规则。');
          break;
        }
        console.log('[SEAT] ' + tag + ' 第' + (attempt + 1) + '次尝试 → ' + pickLabel(pick));
        if (dry) { console.log('[SEAT] dryRun：不锁座，跳到下一条规则。'); break; }

        if (!submitOrder) {
          var comp = selectSeatsInComponent(pick.seats);
          if (!comp) {
            console.error('[SEAT] 无法写入页面已选座位：未找到选座组件。');
            return { success: false, selectedOnly: true, pick: pick };
          }
          console.log('%c[SEAT] 已自动选中座位（未提交订单）：' + pickLabel(pick) +
            '。请检查/调整后手动点页面“确认选座”。', 'color:#0a0;font-weight:bold');
          return { success: true, selectedOnly: true, pick: pick };
        }

        var comboKey = seatComboKey(pick.seats);
        var res = await lockSeats(pick.seats);
        if (res.success) {
          var tradeNo = res.data;
          console.log('%c[SEAT] 锁座成功！订单 tradeNo=' + tradeNo + '，正在跳转确认/付款页…', 'color:#0a0;font-weight:bold');
          console.log('%c[SEAT] 已锁座位：' + pickLabel(pick) + '。请在 15 分钟内完成付款。', 'color:#0a0;font-weight:bold');
          try { location.hash = '#/' + lang() + '/pc/confirmOrder?tradeNo=' + tradeNo + '&cancel=true&supportSeat=' + supportSeat(); } catch (e) {}
          return { success: true, tradeNo: tradeNo, pick: pick };
        }
        if (res.fatal || FATAL_ERRCODES[res.errcode]) {
          console.error('%c[SEAT] 需人工处理(errcode=' + res.errcode + '): ' + (res.msg || '') +
            '。（如登录过期请重进选座页；如有待付款订单/实名/会员提示请先在页面处理后再跑）', 'color:#c00;font-weight:bold');
          return { success: false, fatal: true, res: res };
        }
        failedCombos.add(comboKey);
        console.warn('[SEAT] ' + tag + ' 锁座失败: errcode=' + (res.errcode == null ? '-' : res.errcode) +
          ', msg=' + (res.msg || '未知') + '，已排除组合 ' + comboKey + '，刷新库存重挑…');
      }
    }
    console.error('%c[SEAT] 备选链已全部尝试，未能锁到座位。可调整 config.yaml 后重跑 SEAT.run()。', 'color:#c00;font-weight:bold');
    return { success: false };
  };

  SEAT.releaseInfo = function () {
    console.log('[SEAT] 锁座成功后生成的是“待付款订单”，座位由订单持有；如需放弃请到订单/确认页点“取消订单”，或等待 15 分钟超时自动释放。');
  };

  // 便于调试/自测（无副作用）：可查看内部状态与纯函数
  SEAT._internal = {
    STATE: STATE, pickForRule: pickForRule, candidatesIn: candidatesIn, availableSeats: availableSeats,
    straightRuns: straightRuns, bucketsForLetter: bucketsForLetter, rowRankMap: rowRankMap,
    buildAreaIndex: buildAreaIndex, ticketPriceIds: ticketPriceIds, seatLabel: seatLabel, pickLabel: pickLabel,
  };

  window.SEAT = SEAT;

  // “选座”路由判定（两个油猴脚本都 match 同域，各自认路由；仅在此页可真正抢座）
  function onRoute() { return /\/pc\/seat(?:[?#/&]|$)/.test(String(location.href || '') + ' ' + String(location.hash || '')); }

  var canDom = (typeof window !== 'undefined' && typeof window.addEventListener === 'function' && typeof document !== 'undefined' && document.createElement);

  // ---- 悬浮面板 + 快捷键 ----
  var statusEl = null;
  function setStatus(t) { if (statusEl) statusEl.textContent = t; }
  function refreshState() {
    if (!statusEl) return;
    setStatus(onRoute() ? (STATE.loaded ? '✅ 选座页就绪，可抢座' : '选座页：点“刷新”或等待就绪') : '未在选座页；打开选座页后就绪');
  }
  // 动作入口：不在选座页时给提示而非静默失败
  function act(label, fn) {
    if (!onRoute()) { setStatus('请先进入“选座”页再操作'); console.warn('[SEAT] 当前不在选座页(/pc/seat)。'); return; }
    setStatus(label);
    return Promise.resolve(fn()).then(function () { setStatus('完成，见控制台'); }, function (e) { setStatus('出错:' + e); console.error(e); });
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
  // 面板常驻左下角（与 preorder 右下角错开，互不遮挡）
  function mountPanel() {
    if (!canDom || window.__SEAT_PANEL__) return;
    var box = document.createElement('div');
    box.style.cssText = 'position:fixed;left:16px;bottom:16px;z-index:2147483647;background:#22303f;color:#e6e6e6;font-family:system-ui,Arial;box-shadow:0 6px 24px rgba(0,0,0,.35);border-radius:10px;padding:10px 12px;width:240px;';
    var title = document.createElement('div'); title.textContent = 'SHS 单场选座抢座'; title.style.cssText = 'font-weight:700;font-size:13px;margin-bottom:6px;';
    var info = document.createElement('div'); info.style.cssText = 'font-size:11px;color:#9ab;margin-bottom:8px;line-height:1.5;';
    info.innerHTML = '规则 ' + ((CONFIG.rules || []).length) + ' 条 · autoRun ' + (!!CONFIG.autoRun) +
      ' · submitOrder ' + (CONFIG.submitOrder !== false) + '<br>快捷键 Alt+Shift+ P/R/I';
    var w = document.createElement('div');
    w.appendChild(btn('预演', '#3a7', function () { act('预演中…', function () { return SEAT.plan(); }); }));
    w.appendChild(btn(CONFIG.submitOrder === false ? '自动选座' : '一键抢座', '#e5533c', function () {
      act(CONFIG.submitOrder === false ? '选座中…' : '抢座中…', function () { return SEAT.run(); });
    }));
    w.appendChild(btn('库存', '#48c', function () { act('查库存…', function () { return SEAT.inventory(); }); }));
    w.appendChild(btn('刷新', '#777', function () { act('刷新…', function () { return SEAT.reload().then(refreshState); }); }));
    statusEl = document.createElement('div'); statusEl.style.cssText = 'font-size:11px;color:#8cf;margin-top:8px;min-height:14px;';
    box.appendChild(title); box.appendChild(info); box.appendChild(w); box.appendChild(statusEl);
    document.body.appendChild(box); window.__SEAT_PANEL__ = box;
    refreshState();
  }
  if (canDom) window.addEventListener('keydown', function (e) {
    if (!e.altKey || !e.shiftKey || e.ctrlKey || e.metaKey) return;
    var k = (e.key || '').toLowerCase();
    if (k === 'p') { e.preventDefault(); act('预演中…', function () { return SEAT.plan(); }); }
    else if (k === 'r') { e.preventDefault(); act('抢座中…', function () { return SEAT.run(); }); }
    else if (k === 'i') { e.preventDefault(); act('查库存…', function () { return SEAT.inventory(); }); }
  }, true);

  var _autoDone = false, _autoLoading = false, _autoTimer = null, _routeKey = '', _lastUrl = '';
  function currentRouteKey() { return scheduleId() + '|' + programKey() + '|' + sessionKey(); }
  function resetAutoStateIfNeeded() {
    var key = currentRouteKey();
    if (key !== _routeKey) {
      _routeKey = key;
      _autoDone = false;
      _autoLoading = false;
      if (_autoTimer) { clearTimeout(_autoTimer); _autoTimer = null; }
    }
  }
  function autoRunLabel() { return CONFIG.submitOrder === false ? 'autoRun 选座中…' : 'autoRun 抢座中…'; }
  function startAutoRun() {
    if (!CONFIG.autoRun || _autoDone || !onRoute()) return;
    _autoDone = true;
    setStatus(CONFIG.submitOrder === false ? 'autoRun：自动选座中…' : 'autoRun：自动抢座中…');
    console.log('%c[SEAT] autoRun 触发，自动执行 run()', 'color:#e5533c;font-weight:bold');
    act(autoRunLabel(), function () { return SEAT.run(); });
  }
  function loadForAutoRun(attempt) {
    if (!onRoute() || _autoDone || _autoLoading) { refreshState(); return; }
    _autoLoading = true;
    setStatus(attempt ? ('选座页加载中…重试 ' + attempt) : '选座页加载中…');
    SEAT.reload().then(function (ok) {
      _autoLoading = false;
      refreshState();
      if (ok) {
        console.log('[SEAT] 数据就绪，可 SEAT.plan() 预演，或点“一键抢座”/Alt+Shift+R。');
        startAutoRun();
        return;
      }
      if (CONFIG.autoRun && !_autoDone && attempt < 30) {
        _autoTimer = setTimeout(function () { loadForAutoRun(attempt + 1); }, 500);
      }
    }, function (e) {
      _autoLoading = false;
      console.warn('[SEAT] 自动加载失败，稍后重试：', e);
      if (CONFIG.autoRun && !_autoDone && attempt < 30) {
        _autoTimer = setTimeout(function () { loadForAutoRun(attempt + 1); }, 500);
      }
    });
  }
  function onEnterRoute() {
    if (!onRoute()) { refreshState(); return; }
    resetAutoStateIfNeeded();
    loadForAutoRun(0);
  }
  function watchRoute() {
    var u = String(location.href || '') + '|' + String(location.hash || '');
    if (u === _lastUrl) return;
    _lastUrl = u;
    refreshState();
    onEnterRoute();
  }

  console.log('%c[SEAT] 已加载(单场选座)。', 'color:#0a0;font-weight:bold',
    '面板常驻左下角 · 仅 /pc/seat 页可抢 · autoRun=' + (!!CONFIG.autoRun));
  if (canDom) {
    window.addEventListener('hashchange', function () { watchRoute(); });
    window.addEventListener('popstate', function () { watchRoute(); });
    var boot = function () {
      mountPanel();
      watchRoute();
      setInterval(watchRoute, 300);
    };
    if (document.body) boot(); else window.addEventListener('DOMContentLoaded', boot);
  }
})();
