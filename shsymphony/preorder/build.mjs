// 读取 config.yaml，校验后生成可粘贴到浏览器控制台的 presale-console.js
// 用法：
//   node build.mjs            # 仅本地校验 + 生成
//   node build.mjs --live     # 额外用 cookie 联网校验 场次/价位 是否真实存在
//                             # cookie 来源：环境变量 SHS_COOKIE，或同目录 cookies.txt
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import yaml from 'js-yaml';

const dir = path.dirname(url.fileURLToPath(import.meta.url));
const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8');

const PACK_CODE = 'PKG2606250018'; // 2026-27 音乐季预售票

function parseOpt(o) {
  if (o && typeof o === 'object') return { price: Number(o.price), qty: Number(o.qty || 1) };
  const m = String(o).replace(/\s/g, '').match(/^(\d+(?:\.\d+)?)[x*:×](\d+)$/i);
  if (!m) throw new Error(`票价选项无法解析: ${JSON.stringify(o)}（应形如 "80x2"）`);
  return { price: Number(m[1]), qty: Number(m[2]) };
}
function normEntry(e, where, i) {
  if (!e || (e.date == null && e.title == null && e.scheduleId == null))
    throw new Error(`${where}[${i}] 至少要有 date / title / scheduleId 之一`);
  const slots = (e.slots || []).map((s) => (s || []).map(parseOpt)).filter((s) => s.length);
  if (!slots.length) throw new Error(`${where}[${i}] (${e.date || ''} ${e.title || ''}) 没有有效的 slots`);
  return { date: e.date || '', title: e.title || '', scheduleId: e.scheduleId, slots };
}

const raw = yaml.load(read('config.yaml')) || {};
const config = {
  desiredSessions: Number(raw.desiredSessions || 5),
  preferConnected: !!raw.preferConnected,
  autoRun: !!raw.autoRun,
  sessions: (raw.sessions || []).map((e, i) => normEntry(e, 'sessions', i)),
  backup: (raw.backup || []).map((e, i) => normEntry(e, 'backup', i)),
};

// 本地静态校验：单场总张数（取每槽第一档估算）不超过 4
for (const list of ['sessions', 'backup']) {
  for (const e of config[list]) {
    const est = e.slots.reduce((a, s) => a + (s[0]?.qty || 0), 0);
    if (est > 4) console.warn(`[warn] ${list} ${e.date} ${e.title} 首选合计 ${est} 张 > 单场上限 4，将被截断`);
  }
}

console.log(`[build] 主选 ${config.sessions.length} 场，备用 ${config.backup.length} 场，期望 ${config.desiredSessions} 场，连座=${config.preferConnected}`);

// 可选：联网校验
if (process.argv.includes('--live')) {
  let cookie = process.env.SHS_COOKIE || '';
  const ck = path.join(dir, 'cookies.txt');
  if (!cookie && fs.existsSync(ck)) cookie = fs.readFileSync(ck, 'utf8').trim();
  if (!cookie) { console.warn('[live] 未提供 cookie（SHS_COOKIE 或 cookies.txt），跳过联网校验'); }
  else {
    const resp = await fetch(`https://www.shsymphony.cn/thvendor/ticket/seasonpack/getSchedules.xhtml?packCode=${PACK_CODE}`, {
      headers: { cmpappkey: 'shsymphonyPC', lang: 'zh-CN', cookie, 'user-agent': 'Mozilla/5.0' },
    });
    const j = await resp.json();
    const det = await (await fetch(`https://www.shsymphony.cn/thvendor/ticket/seasonpack/detail.xhtml?packCode=${PACK_CODE}`, {
      headers: { cmpappkey: 'shsymphonyPC', lang: 'zh-CN', cookie, 'user-agent': 'Mozilla/5.0' },
    })).json();
    const progs = {}; (det.data?.programs || []).forEach((p) => (progs[p.id] = p));
    const live = (j.data || []).map((s) => ({ playTime: s.playTime, name: (progs[s.programId]?.fullCnName) || s.cnName || '', prices: s.priceList.map((p) => Number(p.price)) }));
    const check = (e, where) => {
      const ms = live.filter((s) => (!e.date || s.playTime.startsWith(e.date)) && (!e.title || s.name.includes(e.title)));
      if (ms.length !== 1) { console.warn(`[live] ${where} "${e.date} ${e.title}" 匹配到 ${ms.length} 场` + (ms.length ? ': ' + ms.map((x) => x.playTime).join(', ') : '')); return; }
      const have = new Set(ms[0].prices);
      const want = new Set(e.slots.flat().map((o) => o.price));
      const miss = [...want].filter((p) => !have.has(p));
      if (miss.length) console.warn(`[live] ${where} ${ms[0].playTime} ${ms[0].name.slice(0, 16)} 缺少价位: ${miss.join(', ')}（该场有: ${[...have].join(', ')}）`);
    };
    config.sessions.forEach((e) => check(e, '主选'));
    config.backup.forEach((e) => check(e, '备用'));
    console.log('[live] 联网校验完成');
  }
}

const engine = read('engine.js');
const configJs = 'window.__SHS_CONFIG__ = ' + JSON.stringify(config, null, 2) + ';\n\n';
const banner = `/* 由 build.mjs 从 preorder/config.yaml 生成于 ${new Date().toISOString()}，请勿手改；改配置请改 config.yaml 后重新 ./build.sh preorder */\n`;

// Tampermonkey / 油猴 用户脚本（装一次永久生效；开票页一打开脚本即就绪）
// 安装/更新走本地 http 服务(./build.sh serve)：Chrome 已禁止直接打开 file:// 安装用户脚本
const port = process.env.SHS_SERVE_PORT || 8770;
const selfUrl = `http://127.0.0.1:${port}/${path.basename(dir)}/preorder.user.js`;
const header = [
  '// ==UserScript==',
  '// @name         SHS 上交预售套票自动锁座 (preorder)',
  '// @namespace    shsymphony-preorder',
  `// @version      1.0.${Math.floor(Date.now() / 1000)}`,
  '// @description  上海交响乐团预售套票(多场次)：悬浮面板 + 快捷键(Alt+Shift+P 预演 / R 抢票 / X 释放) + 可选 autoRun。改 config.yaml 后重新 ./build.sh preorder，再到油猴“检查更新”。',
  '// @author       -',
  '// @match        https://www.shsymphony.cn/symphonypc/*',
  '// @run-at       document-idle',
  `// @downloadURL  ${selfUrl}`,
  `// @updateURL    ${selfUrl}`,
  '// @grant        none',
  '// ==/UserScript==',
  '',
].join('\n');
fs.writeFileSync(path.join(dir, 'preorder.user.js'), header + '\n' + banner + configJs + engine, 'utf8');
console.log('[build] 已生成 preorder/preorder.user.js（Tampermonkey 用户脚本）');
console.log('[build] 安装/更新地址：' + selfUrl);
