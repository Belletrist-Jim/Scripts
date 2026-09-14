// 读取 config.yaml，校验后生成油猴用户脚本 shgtheatre.user.js
// 用法（一般用 ./build.sh build）：
//   node build.mjs                 # 本地校验 + 生成
//   node build.mjs --live          # 额外联网校验：用 cookie 查该场次的真实价位/区域/余票
//                                  #   需要 config.yaml 里填 scheduleId，且提供 cookie：
//                                  #   环境变量 SGT_COOKIE 或同目录 cookies.txt
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const dir = path.dirname(url.fileURLToPath(import.meta.url));
const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8');

// ---------------------------------------------------------------------------
// 极简 YAML 解析器：只支持 config.yaml 用到的那点语法（键值 / 嵌套 / 列表 / 行内数组）
// 这样整个项目不依赖任何 npm 包，拿到就能跑。
// ---------------------------------------------------------------------------
function parseScalar(s) {
  s = String(s).trim();
  if (s === '') return '';
  if (/^\[.*\]$/.test(s)) {
    const inner = s.slice(1, -1).trim();
    return inner ? inner.split(',').map(parseScalar).filter((v) => v !== '') : [];
  }
  if ((s[0] === '"' && s[s.length - 1] === '"') || (s[0] === "'" && s[s.length - 1] === "'")) return s.slice(1, -1);
  if (/^(true|false)$/i.test(s)) return /^true$/i.test(s);
  if (/^(null|~)$/i.test(s)) return null;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s;
}
function parseYaml(text) {
  // 先清洗：去空行、去整行注释、去行尾注释
  const rows = [];
  for (const raw of String(text).split(/\r?\n/)) {
    if (!raw.trim() || /^\s*#/.test(raw)) continue;
    const indent = raw.match(/^\s*/)[0].length;
    let content = raw.trim(), inQ = false;
    for (let i = 0; i < content.length; i++) {
      const c = content[i];
      if (c === '"' || c === "'") inQ = !inQ;
      else if (c === '#' && !inQ && (i === 0 || /\s/.test(content[i - 1]))) { content = content.slice(0, i).trim(); break; }
    }
    if (content) rows.push({ indent, content });
  }
  let i = 0;
  const kv = (s) => { const m = String(s).match(/^([^:]+):\s*(.*)$/); return m ? { k: m[1].trim(), v: m[2] } : null; };
  function block(indent) {
    if (rows[i] && rows[i].indent === indent && rows[i].content.startsWith('- ')) {
      const arr = [];
      while (i < rows.length && rows[i].indent === indent && rows[i].content.startsWith('- ')) {
        const itemText = rows[i].content.slice(2).trim(); i++;
        const first = kv(itemText);
        if (!first) { arr.push(parseScalar(itemText)); continue; }
        const obj = {};
        obj[first.k] = first.v === '' ? (rows[i] && rows[i].indent > indent ? block(rows[i].indent) : {}) : parseScalar(first.v);
        while (i < rows.length && rows[i].indent > indent) {
          const p = kv(rows[i].content);
          if (!p) { i++; continue; }
          i++;
          obj[p.k] = p.v === '' ? (rows[i] && rows[i].indent > indent ? block(rows[i].indent) : {}) : parseScalar(p.v);
        }
        arr.push(obj);
      }
      return arr;
    }
    const obj = {};
    while (i < rows.length && rows[i].indent === indent && !rows[i].content.startsWith('- ')) {
      const p = kv(rows[i].content);
      if (!p) { i++; continue; }
      i++;
      obj[p.k] = p.v === ''
        ? (rows[i] && rows[i].indent > indent ? block(rows[i].indent) : {})
        : parseScalar(p.v);
    }
    return obj;
  }
  return block(rows.length ? rows[0].indent : 0);
}

const raw = parseYaml(read('config.yaml')) || {};

const asList = (v) => (Array.isArray(v) ? v : (v == null || v === '' ? [] : String(v).split(/[,\s]+/))).map((x) => String(x).trim()).filter(Boolean);

function normRule(r, i) {
  if (!r || typeof r !== 'object') throw new Error(`rules[${i}] 不是对象`);
  const price = Number(r.price);
  const qty = Number(r.qty == null ? 1 : r.qty);
  const areas = asList(r.areas).map((a) => a.toUpperCase());
  if (!(price > 0)) throw new Error(`rules[${i}] price 非法：${JSON.stringify(r.price)}`);
  if (!Number.isInteger(qty) || qty < 1) throw new Error(`rules[${i}] qty 非法：${JSON.stringify(r.qty)}（应为 ≥1 的整数）`);
  return { price, qty, areas };
}

const rulesRaw = raw.rules || [];
if (!Array.isArray(rulesRaw) || !rulesRaw.length) throw new Error('config.yaml 里没有 rules（或为空）');

const config = {
  scheduleId: raw.scheduleId != null ? String(raw.scheduleId) : '',
  dryRun: !!raw.dryRun,
  autoRun: !!raw.autoRun,
  submitOrder: raw.submitOrder !== false,
  maxRetry: Number(raw.maxRetry == null ? 6 : raw.maxRetry),
  jumpToConfirm: !!raw.jumpToConfirm,
  autoAdvanceToPay: !!raw.autoAdvanceToPay,
  mobile: raw.mobile != null ? String(raw.mobile) : '',
  certificationIds: asList(raw.certificationIds),
  rowPreference: String(raw.rowPreference || 'middle').toLowerCase(),
  rules: rulesRaw.map(normRule),
  watch: {
    enabled: !!(raw.watch && raw.watch.enabled),
    sessionId: raw.watch && raw.watch.sessionId != null ? String(raw.watch.sessionId) : '',
    date: raw.watch && raw.watch.date != null ? String(raw.watch.date) : '',
    time: raw.watch && raw.watch.time != null ? String(raw.watch.time) : '',
    startAt: raw.watch && raw.watch.startAt != null ? String(raw.watch.startAt) : '',
    pollMs: Number((raw.watch && raw.watch.pollMs) || 800),
  },
};
if (!['front', 'middle', 'back'].includes(config.rowPreference)) throw new Error('rowPreference 只能是 front / middle / back');
if (config.watch.enabled && !config.watch.sessionId && !config.watch.date) {
  throw new Error('watch.enabled=true 时至少要填 watch.sessionId 或 watch.date，否则脚本不知道盯哪一场');
}

console.log(`[build] 规则 ${config.rules.length} 条 · dryRun=${config.dryRun} · autoRun=${config.autoRun} · submitOrder=${config.submitOrder} · maxRetry=${config.maxRetry} · 选排偏好=${config.rowPreference}`);
config.rules.forEach((r, i) => console.log(`  规则${i + 1}: ￥${r.price} × ${r.qty}  区域 ${r.areas.length ? r.areas.join(' > ') : '(不限)'}`));
if (config.watch.enabled) console.log(`[build] 开票监控已启用：${config.watch.sessionId ? '场次 ' + config.watch.sessionId : config.watch.date + (config.watch.time ? ' ' + config.watch.time : '')}${config.watch.startAt ? ' · 开抢 ' + config.watch.startAt : ''}`);

const APPKEY = 'grandtheatrepc';
const ORIGIN = 'https://www.shgtheatre.com';
async function call(pathname, body, cookie) {
  const res = await fetch(ORIGIN + pathname, {
    method: 'POST',
    headers: {
      cmpappkey: APPKEY, lang: 'zh-CN',
      'content-type': 'application/x-www-form-urlencoded;charset=utf-8',
      'user-agent': 'Mozilla/5.0', cookie: cookie || '',
    },
    body: new URLSearchParams(body).toString(),
  });
  return res.json();
}

if (process.argv.includes('--live')) {
  let cookie = process.env.SGT_COOKIE || '';
  const ck = path.join(dir, 'cookies.txt');
  if (!cookie && fs.existsSync(ck)) cookie = read('cookies.txt').trim();
  const sid = config.scheduleId || process.env.SGT_SCHEDULE_ID || '';
  if (!cookie) console.warn('[live] 未提供 cookie（环境变量 SGT_COOKIE 或同目录 cookies.txt），跳过联网校验');
  else if (!sid) console.warn('[live] config.yaml 里没填 scheduleId，跳过联网校验');
  else {
    const extra = {};
    const sk = process.env.SGT_SK || '';
    try {
      const info = await call('/thvendor/member/ticket/getScheduleInfo.xhtml', { scheduleId: sid, ...(sk ? { sessionKey: sk } : {}) }, cookie);
      if (!info || !info.success) console.warn('[live] getScheduleInfo 失败：', info && info.msg);
      else {
        const areas = Object.entries(info.data.venueAreaMap || {}).map(([k, v]) => `${k}=${v}`);
        console.log(`[live] 场次 ${sid} 区域：${areas.join(' | ') || '(空)'} · checkcard=${info.data.schedule && info.data.schedule.checkcard}`);
      }
      const prices = await call('/thvendor/member/ticket/getSchedulePrices.xhtml', { scheduleId: sid, ...(sk ? { sessionKey: sk } : {}) }, cookie);
      const plist = (prices && prices.data) || [];
      const have = new Set(plist.map((p) => Number(p.price)));
      console.log(`[live] 真实价位：${[...have].sort((a, b) => a - b).join(', ')}`);
      config.rules.forEach((r, i) => { if (have.size && !have.has(r.price)) console.warn(`[live] 规则${i + 1} 的票价 ￥${r.price} 该场不存在`); });
      const avail = await call('/thvendor/member/ticket/getAvailableSeats.xhtml', { scheduleId: sid, ...(sk ? { sessionKey: sk } : {}) }, cookie);
      const groups = (avail && avail.data) || [];
      const agg = {};
      groups.forEach((g) => {
        const area = (info.data && info.data.venueAreaMap && info.data.venueAreaMap[g.venueAreaId]) || g.venueAreaId;
        const price = (plist.find((p) => String(p.ticketPriceId) === String(g.ticketPriceId)) || {}).price;
        const key = `${area} ￥${price}`;
        agg[key] = (agg[key] || 0) + String(g.seats || '').split(',').filter(Boolean).length;
      });
      Object.keys(agg).sort().forEach((k) => console.log(`[live]   余票 ${k} → ${agg[k]} 座`));
      console.log('[live] 联网校验完成');
    } catch (e) { console.warn('[live] 联网校验异常：', String(e && e.message || e)); }
  }
}

const engine = read('engine.js');
const configJs = 'window.__SGT_CONFIG__ = ' + JSON.stringify(config, null, 2) + ';\n\n';
const banner = `/* 由 build.mjs 从 config.yaml 生成于 ${new Date().toISOString()}，请勿手改；改配置请改 config.yaml 后重新 ./build.sh build */\n`;

const port = process.env.SGT_SERVE_PORT || 8771;
const selfUrl = `http://127.0.0.1:${port}/shgtheatre.user.js`;
const header = [
  '// ==UserScript==',
  '// @name         SGT 上海大剧院 自动抢座 (shgtheatre)',
  '// @namespace    shgtheatre-seat',
  `// @version      1.0.${Math.floor(Date.now() / 1000)}`,
  '// @description  上海大剧院在线购票：选座页悬浮面板 + 快捷键(Alt+Shift+P 预演 / R 抢座 / I 库存 / T 自检) + 可选 autoRun，以及详情页开票监控自动进场次。改 config.yaml 后重新 ./build.sh build，再到油猴“检查更新”。',
  '// @author       -',
  `// @match        ${ORIGIN}/shtheatre/*`,
  `// @match        ${ORIGIN}/*`,
  '// @run-at       document-idle',
  `// @downloadURL  ${selfUrl}`,
  `// @updateURL    ${selfUrl}`,
  '// @grant        none',
  '// ==/UserScript==',
  '',
].join('\n');

fs.writeFileSync(path.join(dir, 'shgtheatre.user.js'), header + '\n' + banner + configJs + engine, 'utf8');
console.log('[build] 已生成 shgtheatre.user.js（油猴用户脚本）');
console.log('[build] 安装/更新地址：' + selfUrl);
