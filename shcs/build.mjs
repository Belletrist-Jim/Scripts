// 读取 config.yaml，校验后生成油猴用户脚本 shcs.user.js
//   node build.mjs          # 本地校验 + 生成
//   node build.mjs --live   # 附带用真实接口核对该演出的场次/余票（公开接口，无需登录）
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
  const zones = asList(r.zones);
  if (!(price > 0)) throw new Error(`rules[${i}] price 非法：${JSON.stringify(r.price)}`);
  if (!Number.isInteger(qty) || qty < 1) throw new Error(`rules[${i}] qty 非法：${JSON.stringify(r.qty)}`);
  return { price, qty, zones };
}
const config = {
  programId: raw.programId != null ? String(raw.programId) : '',
  pollMs: Number(raw.pollMs == null ? 20000 : raw.pollMs),
  minSeats: Number(raw.minSeats == null ? 1 : raw.minSeats),
  notify: raw.notify !== false,
  sound: raw.sound !== false,
  autoOpen: !!raw.autoOpen,
  dryRun: !!raw.dryRun,
  autoRun: !!raw.autoRun,
  maxRetry: Number(raw.maxRetry == null ? 3 : raw.maxRetry),
  jumpToCart: raw.jumpToCart !== false,
  autoCheckout: !!raw.autoCheckout,                        // 默认 false：购物车那步自己点
  autoSubmitOrder: raw.autoSubmitOrder !== false,          // 默认 true：结算页盯着「确认订购」立刻按
  confirmPollMs: Number(raw.confirmPollMs == null ? 150 : raw.confirmPollMs),
  confirmMaxWaitMs: Number(raw.confirmMaxWaitMs == null ? 60000 : raw.confirmMaxWaitMs),
  confirmMaxClicks: Number(raw.confirmMaxClicks == null ? 2 : raw.confirmMaxClicks),
  mode: String(raw.mode || 'auto').toLowerCase(),
  rowPreference: String(raw.rowPreference || 'middle').toLowerCase(),
  rules: (raw.rules || []).map(normRule),
};
if (!(config.pollMs >= 3000)) throw new Error('pollMs 太小了（建议 ≥3000，别把人家服务器当靶子打）');
if (!(config.minSeats >= 0)) throw new Error('minSeats 不能为负');
if (!['auto', 'api', 'dom'].includes(config.mode)) throw new Error('mode 只能是 auto / api / dom');
if (!['front', 'middle', 'back'].includes(config.rowPreference)) throw new Error('rowPreference 只能是 front / middle / back');
if (!config.rules.length) throw new Error('config.yaml 里没有 rules（选座抢票要用；至少写一条）');

console.log(`[build] 监控：programId=${config.programId || '(从页面URL自动识别)'} · pollMs=${config.pollMs} · minSeats=${config.minSeats} · 通知=${config.notify} · 响铃=${config.sound}`);
console.log(`[build] 抢座：规则 ${config.rules.length} 条 · dryRun=${config.dryRun} · autoRun=${config.autoRun} · maxRetry=${config.maxRetry} · mode=${config.mode} · 选排=${config.rowPreference}`);
config.rules.forEach((r, i) => console.log(`  规则${i + 1}: ￥${r.price} × ${r.qty}  区域 ${r.zones.length ? r.zones.join(' > ') : '(不限)'}`));

if (process.argv.includes('--live')) {
  const pid = config.programId || process.env.SHCS_PROGRAM_ID || '';
  if (!pid) console.warn('[live] config.yaml 里没填 programId，跳过联网校验');
  else {
    try {
      const res = await fetch('https://www.shcstheatre.com/webapi.ashx?op=Gettblprogram', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest',
          'User-Agent': 'Mozilla/5.0',
          Referer: 'https://www.shcstheatre.com/Program/ProgramDetails.aspx?id=' + pid,
        },
        body: 'id=' + encodeURIComponent(pid) + '&token=',
      });
      const j = await res.json();
      if (!j || j.code !== 0) console.warn('[live] 取场次失败：', j && j.msg);
      else {
        const ev = (j.data && j.data.TBLEVENT) || [];
        console.log(`[live] 演出 ${pid} 共 ${ev.length} 场：`);
        ev.forEach((e) => console.log(`   ${e.I_EVENT_ID}  ${e.DT_EVENT_DATETIME}  余票 ${e.I_WHGC_WEB_SEAT_CNT}  开售 ${e.IF_BEGIN === '1' ? '是' : '否'}  选座 ${e.B_WEB_SELECTSEAT === 1 ? '支持' : '不支持'}`));
        console.log('[live] 联网校验完成');
      }
    } catch (e) { console.warn('[live] 联网校验异常：', String((e && e.message) || e)); }
  }
}

const engine = read('engine.js');
const buildVersion = '1.0.' + Math.floor(Date.now() / 1000);
config.buildVersion = buildVersion;
const configJs = 'window.__SHCS_CONFIG__ = ' + JSON.stringify(config, null, 2) + ';\n\n';
const banner = `/* 由 build.mjs 从 config.yaml 生成于 ${new Date().toISOString()}，请勿手改；改配置请改 config.yaml 后重新 ./build.sh build */\n`;

const port = process.env.SHCS_SERVE_PORT || 8773;
const selfUrl = `http://127.0.0.1:${port}/shcs.user.js`;
const header = [
  '// ==UserScript==',
  '// @name         SHCS 上海文化广场 抢座+余票监控',
  '// @namespace    shcs-seat',
  `// @version      ${buildVersion}`,
  '// @description  上海文化广场(shcstheatre.com)：选座页按价位/区域自动挑连座并锁进购物车、结算页自动按「确认订购」；另附详情页余票/放票/开售监控。付款始终手动。',
  '// @author       -',
  '// @match        https://www.shcstheatre.com/*',
  '// @match        https://m.shcstheatre.com/*',
  '// @match        https://seat.shcstheatre.com/*',
  '// @match        file:///*',
  '// @run-at       document-idle',
  `// @downloadURL  ${selfUrl}`,
  `// @updateURL    ${selfUrl}`,
  '// @grant        none',
  '// ==/UserScript==',
  '',
].join('\n');

fs.writeFileSync(path.join(dir, 'shcs.user.js'), header + '\n' + banner + configJs + engine, 'utf8');
console.log('[build] 已生成 shcs.user.js（油猴用户脚本）');
console.log('[build] 安装/更新地址：' + selfUrl);
