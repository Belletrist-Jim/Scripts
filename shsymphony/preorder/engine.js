/* ============================================================
 * 上海交响乐团 2026-27 预售票 · 自动锁座引擎
 * ------------------------------------------------------------
 * 这是逻辑本体。真正粘贴到浏览器控制台的是 build 生成的
 * presale-console.js（= 本文件 + 由 config.yaml 注入的配置）。
 *
 * 运行位置：登录后的“预售票选场”页面控制台：
 *   https://www.shsymphony.cn/symphonypc/index.html#/zh-CN/pc/presale-schedule?tradeNo=...
 *
 * 核心概念：
 *   - “增加/减少”只改本地数字，不占座；真正占座是“确认锁座”(addPackDetail)。
 *   - 本引擎直接调用页面自身的 Vue 组件方法锁座，复用登录态与签名，最稳。
 *   - 规则：提交订单需 ≥ minBuyNum(通常5) 场；每场最多 maxBuyLimit(通常4) 张；订单 15 分钟倒计时。
 *
 * 常用命令：
 *   SHS.inventory()   查看实时库存
 *   SHS.plan()        预演（按当前余票推算会锁什么，不下手）
 *   SHS.run()         执行：按 config 顺序锁座，并用备用列表补足到期望场次数
 *   SHS.releaseAll()  释放当前所有已锁座位，便于重来
 *   SHS.setConfig(o)  临时替换配置对象
 * ============================================================ */
(function () {
  'use strict';

  // 防止重复注入（粘贴 + 扩展同时存在、或 SPA 多次触发）
  if (window.__SHS_ENGINE__) { console.warn('[SHS] 已加载，跳过重复注入。'); return; }
  window.__SHS_ENGINE__ = true;

  // 由 build 注入；独立运行时用这个空配置（什么都不做）
  var DEFAULT_CONFIG = { desiredSessions: 5, preferConnected: false, autoRun: false, sessions: [], backup: [] };
  var CONFIG = (typeof window !== 'undefined' && window.__SHS_CONFIG__) ? window.__SHS_CONFIG__ : DEFAULT_CONFIG;

  var SHS = {};
  SHS.config = CONFIG;
  SHS.setConfig = function (o) { CONFIG = o; SHS.config = o; console.log('[SHS] 配置已替换'); return o; };

  // ---- 找到承载“场次列表”的 Vue 组件实例 ----
  SHS.comp = function (silent) {
    var rootEl = document.getElementById('app');
    var root = rootEl && rootEl.__vue__;
    if (!root) { if (!silent) console.error('[SHS] 没找到 Vue 实例，请确认在预售选场页面且页面已加载。'); return null; }
    var found = null, seen = new Set();
    (function walk(vm) {
      if (!vm || seen.has(vm) || found) return;
      seen.add(vm);
      if (Array.isArray(vm.list) && typeof vm.lockSeat === 'function' && typeof vm.addPackDetail === 'function') { found = vm; return; }
      (vm.$children || []).forEach(walk);
    })(root);
    if (!found && !silent) console.error('[SHS] 没找到场次列表组件，请把页面滚到能看到各场次后重试。');
    return found;
  };

  SHS.minBuy = function () { var c = SHS.comp(); return (c && c.ticketPack && c.ticketPack.minBuyNum) || 5; };

  function tradeNo(comp) {
    if (comp.tradeNo) return comp.tradeNo;
    var q = (location.hash || '').split('?')[1] || '';
    var t = new URLSearchParams(q).get('tradeNo');
    if (t) comp.tradeNo = t;
    return comp.tradeNo;
  }

  function progName(it) {
    return (it.programMap && (it.programMap.fullCnName || it.programMap.cnName)) || it.cnName || '';
  }

  // "80x2" / "80*2" / {price:80,qty:2} -> {price:80, qty:2}
  function normOpt(o) {
    if (o && typeof o === 'object') return { price: Number(o.price), qty: Number(o.qty || o.num || 1) };
    var m = String(o).replace(/\s/g, '').match(/^(\d+(?:\.\d+)?)[x*:×](\d+)$/i);
    if (!m) { console.warn('[SHS] 无法解析票价选项:', o); return null; }
    return { price: Number(m[1]), qty: Number(m[2]) };
  }
  function normSlots(slots) {
    return (slots || []).map(function (slot) { return (slot || []).map(normOpt).filter(Boolean); }).filter(function (s) { return s.length; });
  }

  // ---- 实时库存 ----
  SHS.inventory = function () {
    var c = SHS.comp(); if (!c) return;
    var rows = [];
    c.list.forEach(function (it) {
      it.priceList.forEach(function (p) {
        rows.push({ 日期: it.playTime, scheduleId: it.id, 节目: progName(it).slice(0, 30), 价位: p.price, ticketPriceId: p.ticketPriceId, 余票: p.availableNum, 已选: p.quantity, 状态: p.status || '' });
      });
    });
    console.table(rows); return rows;
  };

  // 按 日期 + 标题子串 匹配场次
  function matchSession(comp, entry) {
    var date = entry.date ? String(entry.date).trim() : '';
    var title = entry.title ? String(entry.title).trim() : '';
    if (entry.scheduleId != null) {
      var byId = comp.list.find(function (it) { return String(it.id) === String(entry.scheduleId); });
      return byId ? { it: byId, reason: '' } : { it: null, reason: 'scheduleId 未匹配: ' + entry.scheduleId };
    }
    var ms = comp.list.filter(function (it) {
      var okDate = date ? String(it.playTime).indexOf(date) === 0 : true;
      var okTitle = title ? progName(it).indexOf(title) > -1 : true;
      return (date || title) && okDate && okTitle;
    });
    if (!ms.length) return { it: null, reason: '未匹配到场次 (' + date + ' / ' + title + ')' };
    if (ms.length > 1) return { it: ms[0], reason: '匹配到多场，取第一个: ' + ms.map(function (x) { return x.playTime; }).join(' , ') };
    return { it: ms[0], reason: '' };
  }

  function findPrice(it, price) { return it.priceList.find(function (p) { return Number(p.price) === Number(price); }); }

  // 某个槽没锁到时，逐个价位说明原因（余票/售罄/无此价位/超上限）
  function slotReason(it, slot, cap, used) {
    return slot.opts.map(function (opt) {
      var po = findPrice(it, opt.price);
      if (!po) return opt.price + '无此价位';
      if (po.status === 'success' || po.status === 'unconnected') return opt.price + '已锁';
      if (opt.qty > cap - used) return opt.price + '超单场上限';
      var a = po.availableNum || 0;
      if (a < opt.qty) return opt.price + (a === 0 ? '售罄' : '仅余' + a);
      return opt.price + '锁座失败';
    }).join('/');
  }

  // 单价位锁座（复用组件 addPackDetail，等价于点“确认锁座”）
  async function lockPrice(comp, it, priceObj, qty) {
    var cmd = JSON.stringify({ tradeNo: tradeNo(comp), packItemId: it.packItemId, scheduleId: it.id, priceId: priceObj.ticketPriceId, quantity: qty });
    priceObj.quantity = qty; priceObj.status = 'locking';
    var res = {};
    try { res = await comp.addPackDetail({ lockItemCmd: cmd, showToast: 'noMsg' }); } catch (e) { res = { success: false, msg: String(e) }; }
    var success = res && res.success, data = res && res.data, msg = res && res.msg, errcode = res && res.errcode;
    if (success) {
      priceObj.status = (data && data.segmentCounts && data.segmentCounts.length > 1) ? 'unconnected' : 'success';
      priceObj.tip = '';
      if (data) priceObj.packDetailId = data.packDetailId;
    } else {
      priceObj.status = (msg && String(msg).indexOf('不足') > -1) ? 'sellout' : 'error';
      priceObj.tip = msg || '失败';
    }
    try { comp.calculateTotalPrice2(it); comp.calculateTotalPrice(); } catch (e) {}
    return { success: !!success, status: priceObj.status, msg: msg, errcode: errcode, data: data };
  }

  // 释放某个已锁价位
  async function release(comp, it, priceObj) {
    try { await comp.handlerDelete(priceObj); } catch (e) {}
  }

  // 处理单个场次：按 slots 优先级/降级链锁座，失败自动降级
  async function runSession(comp, entry) {
    var m = matchSession(comp, entry);
    if (m.reason) console.warn('[SHS] ' + m.reason);
    if (!m.it) return { matched: false, entry: entry, reason: m.reason, tickets: 0, locked: false, log: [] };
    var it = m.it, cap = it.maxBuyLimit || 4;
    // 该场已有锁定（上次运行/手动锁的）→ 直接计入，不再重复抢，避免超买
    var pre = it.priceList.filter(function (p) { return p.status === 'success' || p.status === 'unconnected'; });
    if (pre.length) {
      var pt = pre.reduce(function (a, p) { return a + (p.quantity || 0); }, 0);
      return { matched: true, it: it, tickets: pt, locked: true, aborted: false, reason: '',
        log: pre.map(function (p) { return { 价位: p.price, 张数: p.quantity, 结果: '已锁(上次)' }; }) };
    }
    var slots = normSlots(entry.slots).map(function (opts) { return { opts: opts, done: false, price: null, qty: 0 }; });
    var excluded = new Set();   // 本场内已确认买不到的价位
    var used = 0;               // 已成功锁定的张数（占用 cap）
    var log = [], aborted = false;

    for (var pass = 0; pass < 8 && !aborted; pass++) {
      // 1) 为所有未完成的 slot 各选一个可行选项
      var decisions = [], tentative = used, plannedByPrice = {};
      slots.forEach(function (slot) {
        if (slot.done) return;
        for (var i = 0; i < slot.opts.length; i++) {
          var opt = slot.opts[i];
          if (excluded.has(opt.price)) continue;
          var po = findPrice(it, opt.price);
          if (!po) continue;                                  // 该场没有此价位
          if (po.status === 'success' || po.status === 'unconnected') continue;
          if (opt.qty > cap - tentative) continue;            // 超单场上限
          var planned = plannedByPrice[opt.price] || 0;
          if ((po.availableNum || 0) - planned < opt.qty) continue; // 余票不够
          decisions.push({ slot: slot, opt: opt, po: po });
          plannedByPrice[opt.price] = planned + opt.qty;
          tentative += opt.qty;
          return;
        }
      });
      if (!decisions.length) break;

      // 2) 同价位合并成一次锁座
      var groups = new Map();
      decisions.forEach(function (d) {
        var k = d.po.ticketPriceId;
        if (!groups.has(k)) groups.set(k, { po: d.po, price: d.opt.price, items: [] });
        groups.get(k).items.push(d);
      });

      var progressed = false;
      for (var g of groups.values()) {
        var qty = g.items.reduce(function (a, d) { return a + d.opt.qty; }, 0);
        var r = await lockPrice(comp, it, g.po, qty);
        log.push({ 价位: g.price, 张数: qty, 结果: r.status, 提示: r.msg || '' });
        progressed = true;
        if (r.errcode == 1123) { aborted = true; break; }
        if (r.success) {
          if (r.status === 'unconnected' && CONFIG.preferConnected && qty > 1) {
            await release(comp, it, g.po);              // 要求连座但不连座 -> 释放并降级
            excluded.add(g.price);
          } else {
            used += qty;
            g.items.forEach(function (d) { d.slot.done = true; d.slot.price = g.price; d.slot.qty = d.opt.qty; });
          }
        } else {
          excluded.add(g.price);                        // 失败价位 -> 排除后下一轮降级
        }
      }
      if (!progressed) break;
    }

    var tickets = slots.filter(function (s) { return s.done; }).reduce(function (a, s) { return a + s.qty; }, 0);
    var notDone = slots.filter(function (s) { return !s.done; });
    var reason = notDone.map(function (s) { return slotReason(it, s, cap, used); }).join(' ; ');
    return { matched: true, it: it, tickets: tickets, locked: tickets > 0, aborted: aborted, log: log, slots: slots, reason: reason };
  }

  function label(entry, r) {
    var it = r.it;
    var name = it ? (it.playTime + ' ' + progName(it).slice(0, 20)) : ((entry.date || '') + ' ' + (entry.title || ''));
    return name;
  }
  function detail(r) {
    var a = (r.log || []).map(function (x) { return x.价位 + '×' + x.张数 + '=' + x.结果; }).join(' | ');
    if (r.reason) a += (a ? ' ｜ ' : '') + '未成:' + r.reason;
    return a;
  }

  // 预演：按当前余票推算会锁什么（不真正下单，不考虑抢购中失败）
  SHS.plan = function (cfg) {
    cfg = cfg || CONFIG; var c = SHS.comp(); if (!c) return;
    var need = cfg.desiredSessions || SHS.minBuy();
    var rows = [], achieved = 0;
    function simulate(entry, listName) {
      var m = matchSession(c, entry); var it = m.it;
      if (!it) { rows.push({ 清单: listName, 场次: (entry.date || '') + ' ' + (entry.title || ''), 计划: '未匹配', 备注: m.reason }); return false; }
      var cap = it.maxBuyLimit || 4, used = 0, picks = [];
      normSlots(entry.slots).forEach(function (slot) {
        for (var i = 0; i < slot.length; i++) {
          var opt = slot[i], po = findPrice(it, opt.price);
          if (!po) continue;
          if (opt.qty > cap - used) continue;
          if ((po.availableNum || 0) < opt.qty) continue;
          picks.push(opt.price + '×' + opt.qty); used += opt.qty; return;
        }
        picks.push('(该槽无票)');
      });
      var ok = used > 0;
      rows.push({ 清单: listName, 场次: it.playTime + ' ' + progName(it).slice(0, 18), 计划: picks.join(' + ') || '无', 张数: used });
      return ok;
    }
    (cfg.sessions || []).forEach(function (e) { if (simulate(e, '主选')) achieved++; });
    (cfg.backup || []).forEach(function (e) { if (achieved >= need) { rows.push({ 清单: '备用(不需要)', 场次: (e.date || '') + ' ' + (e.title || ''), 计划: '已达期望场次，跳过' }); return; } if (simulate(e, '备用')) achieved++; });
    console.table(rows);
    console.log('[SHS] 预演：预计可锁 ' + achieved + ' 场（期望 ' + need + '，最少 ' + SHS.minBuy() + '）');
    return rows;
  };

  // 执行
  SHS.run = async function (cfg) {
    cfg = cfg || CONFIG; var comp = SHS.comp(); if (!comp) return;
    if (!tradeNo(comp)) { console.error('[SHS] 找不到 tradeNo，请确认在带 ?tradeNo= 的选场页面。'); return; }
    var need = cfg.desiredSessions || SHS.minBuy();
    var results = [], achieved = 0, aborted = false;

    console.log('%c[SHS] 开始锁座（按 config 顺序）...', 'color:#06c;font-weight:bold');
    for (var e of (cfg.sessions || [])) {
      var r = await runSession(comp, e);
      results.push({ 清单: '主选', 场次: label(e, r), 结果: r.matched ? (r.locked ? '锁到 ' + r.tickets + ' 张' : '未锁到') : '未匹配', 明细: detail(r) });
      if (r.aborted) { aborted = true; break; }
      if (r.locked) achieved++;
    }
    if (!aborted && achieved < need) {
      console.log('%c[SHS] 主选锁到 ' + achieved + ' 场，未达期望 ' + need + '，开始从备用列表补足...', 'color:#c60');
      for (var b of (cfg.backup || [])) {
        if (achieved >= need) break;
        var rb = await runSession(comp, b);
        results.push({ 清单: '备用', 场次: label(b, rb), 结果: rb.matched ? (rb.locked ? '锁到 ' + rb.tickets + ' 张' : '未锁到') : '未匹配', 明细: detail(rb) });
        if (rb.aborted) { aborted = true; break; }
        if (rb.locked) achieved++;
      }
    }

    console.table(results);
    if (aborted) { console.error('%c[SHS] 订单已超时(1123)，请重新进入选场页面拿新窗口后再跑。', 'color:#c00;font-weight:bold'); return results; }
    var minBuy = SHS.minBuy();
    console.log('[SHS] 完成：成功锁到 ' + achieved + ' 场（期望 ' + need + '，最少 ' + minBuy + '）。');
    if (achieved >= need) console.log('%c[SHS] 已达期望场次，请人工点击页面底部“提交订单”并付款。', 'color:#0a0;font-weight:bold');
    else if (achieved >= minBuy) console.warn('[SHS] 未达期望场次，但已满足最少 ' + minBuy + ' 场，可提交（优惠档位可能不同）。');
    else console.warn('[SHS] 场次不足 ' + minBuy + '，无法提交。');
    if (achieved < need) console.warn('[SHS] 提示：上表“明细/未成”里若多为“80售罄”，说明该场只配了已售罄的价位。请在 config.yaml 给对应场次的 slots 增加更高价位降级链（如 "180x1","380x1"）后重试。');
    return results;
  };

  // 释放所有已锁
  SHS.releaseAll = async function () {
    var c = SHS.comp(); if (!c) return;
    var locked = [];
    c.list.forEach(function (it) { it.priceList.forEach(function (p) { if (['success', 'unconnected', 'error', 'sellout'].indexOf(p.status) > -1) locked.push({ it: it, p: p }); }); });
    console.log('[SHS] 释放 ' + locked.length + ' 个已锁价位...');
    for (var x of locked) { await release(c, x.it, x.p); }
    try { c.calculateTotalPrice(); } catch (e) {}
    console.log('[SHS] 已释放。');
  };

  window.SHS = SHS;

  // ---- 快捷键 / 悬浮面板 / 扩展命令 ----
  function trigger(cmd) {
    if (cmd === 'plan') return SHS.plan();
    if (cmd === 'run') return SHS.run();
    if (cmd === 'release') return SHS.releaseAll();
    if (cmd === 'inventory') return SHS.inventory();
  }
  SHS.trigger = trigger;

  var canDom = (typeof window !== 'undefined' && typeof window.addEventListener === 'function' && typeof document !== 'undefined' && document.createElement);
  // “预售选场”路由判定（两个油猴脚本都 match 同域，各自认路由；仅在此页可真正抢票）
  function onRoute() { return (location.hash || '').indexOf('presale-schedule') > -1; }

  var statusEl = null;
  function setStatus(t) { if (statusEl) statusEl.textContent = t; }
  function refreshState() {
    if (!statusEl) return;
    if (onRoute()) {
      var c = SHS.comp(true);
      setStatus((c && Array.isArray(c.list) && c.list.length) ? '✅ 选场页就绪，可抢票' : '选场页加载中…');
    } else {
      setStatus('未在选场页；打开预售选场页后就绪');
    }
  }
  // 动作入口：不在选场页时给提示而非静默失败
  function act(label, fn) {
    if (!onRoute()) { setStatus('请先进入“预售选场”页再操作'); console.warn('[SHS] 当前不在 presale-schedule 页。'); return; }
    setStatus(label);
    return Promise.resolve(fn()).then(function () { setStatus('完成，见控制台'); }, function (e) { setStatus('出错:' + e); console.error(e); });
  }

  // 快捷键：Alt+Shift+P 预演 / R 抢票 / X 释放
  if (canDom) window.addEventListener('keydown', function (e) {
    if (!e.altKey || !e.shiftKey || e.ctrlKey || e.metaKey) return;
    var k = (e.key || '').toLowerCase();
    if (k === 'p') { e.preventDefault(); act('预演中…', function () { return SHS.plan(); }); }
    else if (k === 'r') { e.preventDefault(); act('抢票中…', function () { return SHS.run(); }); }
    else if (k === 'x') { e.preventDefault(); act('释放中…', function () { return SHS.releaseAll(); }); }
  }, true);

  function btn(label, color, onClick) {
    var b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = 'margin:2px;padding:6px 10px;border:0;border-radius:6px;color:#fff;cursor:pointer;font-size:13px;background:' + color;
    b.onmouseenter = function () { b.style.opacity = '.85'; };
    b.onmouseleave = function () { b.style.opacity = '1'; };
    b.onclick = onClick;
    return b;
  }
  // 面板：任意本站页面都常驻（右下角），让你确认脚本已装；只有选场页能真正抢
  function mountPanel() {
    if (!canDom || window.__SHS_PANEL__) return;
    var box = document.createElement('div');
    box.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;background:#1f2430;color:#e6e6e6;font-family:system-ui,Arial;box-shadow:0 6px 24px rgba(0,0,0,.35);border-radius:10px;padding:10px 12px;width:230px;';
    var title = document.createElement('div');
    title.textContent = 'SHS 预售套票抢票';
    title.style.cssText = 'font-weight:700;font-size:13px;margin-bottom:6px;';
    var info = document.createElement('div');
    info.style.cssText = 'font-size:11px;color:#9aa;margin-bottom:8px;line-height:1.5;';
    info.innerHTML = '期望 ' + (CONFIG.desiredSessions || '-') + ' 场 · 主选 ' + ((CONFIG.sessions || []).length) + ' · 备用 ' + ((CONFIG.backup || []).length) + ' · autoRun ' + (!!CONFIG.autoRun) + '<br>快捷键 Alt+Shift+ P/R/X';
    var wrap = document.createElement('div');
    wrap.appendChild(btn('预演', '#3a7', function () { act('预演中…', function () { return SHS.plan(); }); }));
    wrap.appendChild(btn('一键抢票', '#e5533c', function () { act('抢票中…', function () { return SHS.run(); }); }));
    wrap.appendChild(btn('库存', '#48c', function () { act('查库存…', function () { return SHS.inventory(); }); }));
    wrap.appendChild(btn('释放', '#777', function () { act('释放中…', function () { return SHS.releaseAll(); }); }));
    statusEl = document.createElement('div');
    statusEl.style.cssText = 'font-size:11px;color:#8cf;margin-top:8px;min-height:14px;';
    box.appendChild(title); box.appendChild(info); box.appendChild(wrap); box.appendChild(statusEl);
    document.body.appendChild(box);
    window.__SHS_PANEL__ = box;
    refreshState();
  }
  var _autoStarted = false;
  function startAutoRun() {
    if (_autoStarted) return; _autoStarted = true;
    var _tries = 0;
    var _timer = setInterval(function () {
      _tries++;
      var c = SHS.comp(true);
      if (c && Array.isArray(c.list) && c.list.length && tradeNo(c)) {
        clearInterval(_timer);
        setStatus('autoRun：自动抢票中…');
        console.log('%c[SHS] autoRun 触发，自动执行 run()', 'color:#e5533c;font-weight:bold');
        Promise.resolve(SHS.run()).then(function () { setStatus('autoRun 完成，见控制台'); });
      } else if (_tries > 120) { // 约 60s
        clearInterval(_timer);
        console.warn('[SHS] autoRun 等待场次列表超时，请手动点“一键抢票”或按 Alt+Shift+R。');
      }
    }, 500);
  }
  var _entered = false;
  function onEnterRoute() {
    if (!onRoute()) return;
    refreshState();
    if (!_entered) { // 场次列表可能稍后加载，短轮询刷新状态
      _entered = true;
      var n = 0, t = setInterval(function () { n++; refreshState(); var c = SHS.comp(true); if (n > 40 || (c && c.list && c.list.length)) clearInterval(t); }, 500);
    }
    if (CONFIG.autoRun) startAutoRun();
  }
  if (canDom) {
    window.addEventListener('SHS_CMD', function (e) { try { trigger(e && e.detail); } catch (err) { console.error(err); } });
    window.addEventListener('hashchange', function () { refreshState(); onEnterRoute(); });
    var boot = function () { mountPanel(); onEnterRoute(); };
    if (document.body) boot(); else window.addEventListener('DOMContentLoaded', boot);
  }

  console.log('%c[SHS] 已加载(预售)。', 'color:#0a0;font-weight:bold', '面板常驻右下角 · 仅 presale-schedule 页可抢 · autoRun=' + (!!CONFIG.autoRun));
})();
