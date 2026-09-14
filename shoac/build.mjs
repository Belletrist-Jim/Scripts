// 读取 config.yaml，校验后生成油猴用户脚本 shoac.user.js
// 用法（一般用 ./build.sh build）：
//   node build.mjs                 # 本地校验 + 生成
//   node build.mjs --live          # 可选：用真实数据核对 config 里的价位是否存在
//                                  #   需要 config.yaml 填 productId/showId/SHsectionId
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
  const areas = asList(r.areas);
  if (!(price > 0)) throw new Error(`rules[${i}] price 非法：${JSON.stringify(r.price)}`);
  if (!Number.isInteger(qty) || qty < 1) throw new Error(`rules[${i}] qty 非法：${JSON.stringify(r.qty)}（应为 ≥1 的整数）`);
  return { price, qty, areas };
}

const rulesRaw = raw.rules || [];
if (!Array.isArray(rulesRaw) || !rulesRaw.length) throw new Error('config.yaml 里没有 rules（或为空）');

const config = {
  productId: raw.productId != null ? String(raw.productId) : '',
  showId: raw.showId != null ? String(raw.showId) : '',
  sectionId: raw.sectionId != null ? String(raw.sectionId) : '',
  dryRun: !!raw.dryRun,
  autoRun: !!raw.autoRun,
  submitOrder: raw.submitOrder !== false,
  maxRetry: Number(raw.maxRetry == null ? 4 : raw.maxRetry),
  mode: String(raw.mode || 'auto').toLowerCase(),
  jumpToOrder: raw.jumpToOrder !== false,
  autoSwitchSection: raw.autoSwitchSection !== false,
  rowPreference: String(raw.rowPreference || 'middle').toLowerCase(),
  rules: rulesRaw.map(normRule),
  watch: {
    enabled: !!(raw.watch && raw.watch.enabled),
    showId: raw.watch && raw.watch.showId != null ? String(raw.watch.showId) : '',
    date: raw.watch && raw.watch.date != null ? String(raw.watch.date) : '',
    time: raw.watch && raw.watch.time != null ? String(raw.watch.time) : '',
    startAt: raw.watch && raw.watch.startAt != null ? String(raw.watch.startAt) : '',
    pollMs: Number((raw.watch && raw.watch.pollMs) || 1500),
  },
};
if (!['auto', 'api', 'dom'].includes(config.mode)) throw new Error('mode 只能是 auto / api / dom');
if (!['front', 'middle', 'back'].includes(config.rowPreference)) throw new Error('rowPreference 只能是 front / middle / back');
if (config.watch.enabled && !config.watch.showId && !config.watch.date) {
  throw new Error('watch.enabled=true 时至少要填 watch.showId 或 watch.date，否则脚本不知道盯哪一场');
}

console.log(`[build] 规则 ${config.rules.length} 条 · 模式=${config.mode} · dryRun=${config.dryRun} · autoRun=${config.autoRun} · submitOrder=${config.submitOrder} · 选排=${config.rowPreference}`);
config.rules.forEach((r, i) => console.log(`  规则${i + 1}: ￥${r.price} × ${r.qty}  区域 ${r.areas.length ? r.areas.join(' > ') : '(不限)'}`));
if (config.watch.enabled) console.log(`[build] 开票监控已启用：${config.watch.showId ? '场次 ' + config.watch.showId : config.watch.date}${config.watch.time ? ' ' + config.watch.time : ''}`);

const BASE = 'https://www.shoac.com.cn/platform-backend';
const HEADERS = { Channel: 'theatre_pc', Location: '121.458563,31.250315', Theater: '1323', 'Flagship-Store': 'true' };
async function get(p, query) {
  const u = new URL(BASE + p);
  Object.entries(query || {}).forEach(([k, v]) => u.searchParams.set(k, v));
  const r = await fetch(u, { headers: HEADERS });
  return r.json();
}

if (process.argv.includes('--live')) {
  const pid = config.productId || process.env.SOAC_PRODUCT_ID || '';
  const showId = config.showId || process.env.SOAC_SHOW_ID || '';
  if (!pid || !showId) console.warn('[live] config.yaml 里没填 productId / showId，跳过联网校验（这两个值可以从选座页 URL 里抄）');
  else {
    try {
      const price = await get('/good/show/price/' + showId);
      const list = (price && price.data && price.data.priceDtos) || [];
      const have = new Set(list.map((p) => Number(p.price)));
      console.log(`[live] 场次 ${showId} 真实价位：${[...have].sort((a, b) => a - b).join(', ')}`);
      config.rules.forEach((r, i) => { if (have.size && !have.has(r.price)) console.warn(`[live] 规则${i + 1} 的票价 ￥${r.price} 该场不存在`); });
      const cap = await get('/good/project/captcha/' + pid);
      console.log('[live] 是否需要滑块验证：' + ((cap && cap.data) ? '需要（脚本会改用网页点选，你滑一下）' : '不需要（可全自动）'));
      console.log('[live] 联网校验完成');
    } catch (e) { console.warn('[live] 联网校验异常：', String((e && e.message) || e)); }
  }
}

const engine = read('engine.js');
const configJs = 'window.__SOAC_CONFIG__ = ' + JSON.stringify(config, null, 2) + ';\n\n';
const banner = `/* 由 build.mjs 从 config.yaml 生成于 ${new Date().toISOString()}，请勿手改；改配置请改 config.yaml 后重新 ./build.sh build */\n`;

const port = process.env.SOAC_SERVE_PORT || 8772;
const selfUrl = `http://127.0.0.1:${port}/shoac.user.js`;
const header = [
  '// ==UserScript==',
  '// @name         SOAC 上海东方艺术中心 自动抢座',
  '// @namespace    shoac-seat',
  `// @version      1.0.${Math.floor(Date.now() / 1000)}`,
  '// @description  上海东方艺术中心在线购票：选座页悬浮面板 + 快捷键(Alt+Shift+P 预演 / R 抢座 / I 库存 / S 全场扫描 / T 自检) + 可选 autoRun + 详情页开票监控。改 config.yaml 后重新 ./build.sh build，再到油猴“检查更新”。',
  '// @author       -',
  '// @match        https://www.shoac.com.cn/*',
  '// @run-at       document-idle',
  `// @downloadURL  ${selfUrl}`,
  `// @updateURL    ${selfUrl}`,
  '// @grant        none',
  '// ==/UserScript==',
  '',
].join('\n');

fs.writeFileSync(path.join(dir, 'shoac.user.js'), header + '\n' + banner + configJs + engine, 'utf8');
console.log('[build] 已生成 shoac.user.js（油猴用户脚本）');
console.log('[build] 安装/更新地址：' + selfUrl);
