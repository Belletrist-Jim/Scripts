// 读取 single-concert/config.yaml，校验后生成油猴用户脚本 single-concert.user.js
// 用法（一般用根目录 ./build.sh single-concert）：
//   node build.mjs            # 仅本地校验 + 生成
//   node build.mjs --live     # 额外用 cookie 联网校验 票价/区域 是否真实存在
//                                   # 需要配置 scheduleId；cookie 来源：环境变量 SHS_COOKIE 或同目录 cookies.txt
//                                   # 联网校验可选 pk/sk：环境变量 SHS_PK / SHS_SK，或 config.yaml 里的 programKey / sessionKey
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import yaml from 'js-yaml';

const dir = path.dirname(url.fileURLToPath(import.meta.url));
const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8');

function normRule(r, i) {
  if (!r || typeof r !== 'object') throw new Error(`rules[${i}] 不是对象`);
  const price = Number(r.price);
  const qty = Number(r.qty == null ? 1 : r.qty);
  let areas = r.areas;
  if (typeof areas === 'string') areas = areas.split(/[,\s]+/).filter(Boolean);
  if (!Array.isArray(areas)) areas = [];
  areas = areas.map((a) => String(a).trim().toUpperCase()).filter(Boolean);
  if (!(price > 0)) throw new Error(`rules[${i}] price 非法: ${JSON.stringify(r.price)}`);
  if (!Number.isInteger(qty) || qty < 1) throw new Error(`rules[${i}] qty 非法: ${JSON.stringify(r.qty)}（应为 ≥1 的整数）`);
  if (!areas.length) throw new Error(`rules[${i}] areas 为空（应形如 [J, C, D]）`);
  for (const a of areas) if (!/^[A-Z]$/.test(a)) throw new Error(`rules[${i}] 区域字母非法: ${a}（应为单个字母如 A/J）`);
  return { price, qty, areas };
}

const raw = yaml.load(read('config.yaml')) || {};
const root = Array.isArray(raw) ? { rules: raw } : raw; // 兼容“顶层直接是列表”
const rulesRaw = root.rules || [];
if (!Array.isArray(rulesRaw) || !rulesRaw.length) throw new Error('config.yaml 未找到 rules 列表（或列表为空）');

const config = {
  scheduleId: root.scheduleId != null ? String(root.scheduleId) : '',
  mobile: root.mobile != null ? String(root.mobile) : '',
  dryRun: !!root.dryRun,
  autoRun: !!root.autoRun,
  submitOrder: root.submitOrder !== false,
  maxRetryPerRule: Number(root.maxRetryPerRule || 40),
  rules: rulesRaw.map(normRule),
};

console.log(`[build] 规则 ${config.rules.length} 条，dryRun=${config.dryRun}，autoRun=${config.autoRun}，submitOrder=${config.submitOrder}，maxRetryPerRule=${config.maxRetryPerRule}`);
config.rules.forEach((r, i) => console.log(`  规则${i + 1}: ￥${r.price} × ${r.qty}  区域 ${r.areas.join(' > ')}`));

// 可选：联网校验
if (process.argv.includes('--live')) {
  let cookie = process.env.SHS_COOKIE || '';
  const ck = path.join(dir, 'cookies.txt');
  if (!cookie && fs.existsSync(ck)) cookie = fs.readFileSync(ck, 'utf8').trim();
  const sid = config.scheduleId;
  if (!cookie) console.warn('[live] 未提供 cookie（SHS_COOKIE 或 cookies.txt），跳过联网校验');
  else if (!sid) console.warn('[live] 未配置 scheduleId，跳过联网校验（请在 seat.yaml 顶层填 scheduleId）');
  else {
    const pk = process.env.SHS_PK || (root.programKey ? String(root.programKey) : '');
    const sk = process.env.SHS_SK || (root.sessionKey ? String(root.sessionKey) : '');
    const headers = { cmpappkey: 'shsymphonyPC', lang: 'zh-CN', 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'Mozilla/5.0', cookie };
    if (pk) headers.programKey = pk;
    if (sk) headers.sessionKey = sk;
    const call = async (p) => (await fetch('https://www.shsymphony.cn/' + p, { method: 'POST', headers, body: new URLSearchParams({ scheduleId: sid }).toString() })).json();
    try {
      const info = await call('thvendor/member/symphony/ticket/getScheduleInfo.xhtml');
      const prices = await call('thvendor/member/ticket/getSchedulePrices.xhtml');
      if (!info || !info.success) console.warn('[live] getScheduleInfo 失败：', info && info.msg, '（pk/sk 可能过期，可设 SHS_PK/SHS_SK）');
      else {
        const areaLetters = new Set();
        Object.values(info.data.venueAreaMap || {}).forEach((n) => { const m = String(n).match(/^([A-Za-z])\s*区/); if (m) areaLetters.add(m[1].toUpperCase()); });
        const havePrices = new Set((prices && prices.data || []).map((p) => Number(p.price)));
        console.log(`[live] 场次「${info.data.programName}」 区域: ${[...areaLetters].sort().join(',')} | 价位: ${[...havePrices].sort((a, b) => a - b).join(',')}`);
        config.rules.forEach((r, i) => {
          if (havePrices.size && !havePrices.has(r.price)) console.warn(`[live] 规则${i + 1} 票价 ${r.price} 该场不存在`);
          const missArea = r.areas.filter((a) => !areaLetters.has(a));
          if (missArea.length) console.warn(`[live] 规则${i + 1} 区域该场不存在: ${missArea.join(',')}`);
        });
      }
      console.log('[live] 联网校验完成');
    } catch (e) { console.warn('[live] 联网校验异常：', String(e)); }
  }
}

const engine = read('engine.js');
const configJs = 'window.__SEAT_CONFIG__ = ' + JSON.stringify(config, null, 2) + ';\n\n';
const banner = `/* 由 build.mjs 从 single-concert/config.yaml 生成于 ${new Date().toISOString()}，请勿手改；改配置请改 config.yaml 后重新 ./build.sh single-concert */\n`;

// Tampermonkey / 油猴 用户脚本（装一次永久生效；开票页一打开脚本即就绪）
// 安装/更新走本地 http 服务(./build.sh serve)：Chrome 已禁止直接打开 file:// 安装用户脚本
const port = process.env.SHS_SERVE_PORT || 8770;
const selfUrl = `http://127.0.0.1:${port}/${path.basename(dir)}/single-concert.user.js`;
const header = [
  '// ==UserScript==',
  '// @name         SHS 上交单场选座抢座 (single-concert)',
  '// @namespace    shsymphony-single-concert',
  `// @version      1.0.${Math.floor(Date.now() / 1000)}`,
  '// @description  上海交响乐团单场选座：悬浮面板 + 快捷键(Alt+Shift+P 预演 / R 抢座 / I 库存) + 可选 autoRun。改 config.yaml 后重新 ./build.sh single-concert，再到油猴“检查更新”。',
  '// @author       -',
  '// @match        https://www.shsymphony.cn/symphonypc/*',
  '// @run-at       document-idle',
  `// @downloadURL  ${selfUrl}`,
  `// @updateURL    ${selfUrl}`,
  '// @grant        none',
  '// ==/UserScript==',
  '',
].join('\n');
fs.writeFileSync(path.join(dir, 'single-concert.user.js'), header + '\n' + banner + configJs + engine, 'utf8');
console.log('[build] 已生成 single-concert/single-concert.user.js（Tampermonkey 用户脚本）');
console.log('[build] 安装/更新地址：' + selfUrl);
