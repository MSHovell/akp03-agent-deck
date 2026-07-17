#!/usr/bin/env node
/**
 * Renders the artwork for the manual.
 *
 * Every figure is built from the SAME icon code the device runs (lib/icons.js,
 * lib/keycaps.js), so the manual cannot drift from the hardware: change a key's
 * look and the manual redraws with it. Nothing here is a mock-up.
 *
 *   node scripts/gen-manual-art.mjs        # writes SVGs
 *   then rasterise with Chrome headless    # see the shell wrapper
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as icons from '../plugin/com.hovell.agentdeck.sdPlugin/lib/icons.js';
import { CAPS, CAP_NAMES } from '../plugin/com.hovell.agentdeck.sdPlugin/lib/keycaps.js';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'art');
mkdirSync(OUT, { recursive: true });

const deck = (state, pending = null) => ({ state, pending, sessions: new Map() });

/** Pull the <svg> body out of one of our data URIs so it can be nested. */
const body = (uri) =>
  Buffer.from(uri.split(',')[1], 'base64')
    .toString('utf8')
    .replace(/^<svg[^>]*>/, '')
    .replace(/<\/svg>$/, '');

const BG = '#0f0f11';
const TXT = '#8a8a92';
const HL = '#d97757';

function text(x, y, s, { size = 13, fill = TXT, anchor = 'middle', weight = 400 } = {}) {
  return `<text x="${x}" y="${y}" font-family="Segoe UI, Inter, sans-serif" font-size="${size}"
    font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${s}</text>`;
}

// ── figure 1: the whole deck, labelled ──────────────────────────────────────

function deckMap() {
  const K = 96, GAP = 10;
  const keys = [
    [icons.approveIcon(deck('awaiting_approval', { toolName: 'Bash' })), '批准'],
    [icons.statusIcon(deck('idle'), { context: 62 }), '狀態 / 送出'],
    [icons.denyIcon(deck('awaiting_approval', { toolName: 'Bash' })), '拒絕'],
    [icons.usageIcon(null, { context: 62, plan: 28 }), '用量'],
    [icons.voiceIcon(null, {}), '語音'],
    [icons.interruptIcon(deck('thinking')), '中斷'],
  ];
  let s = `<svg xmlns="http://www.w3.org/2000/svg" width="760" height="470" viewBox="0 0 760 470">
    <rect width="100%" height="100%" fill="${BG}"/>`;

  const x0 = 40, y0 = 50;
  const ROW = K + GAP + 24;      // key + gap + room for its caption
  keys.forEach(([uri, label], i) => {
    const x = x0 + (i % 3) * (K + GAP);
    const y = y0 + Math.floor(i / 3) * ROW;
    s += `<g transform="translate(${x},${y}) scale(${K / 144})">${body(uri)}</g>`;
    s += text(x + K / 2, y + K + 16, label, { size: 12 });
  });

  // Everything below the LCD block starts here. Derived from the row geometry,
  // not typed in: hand-picked constants had the round buttons sitting on top of
  // the second row's captions.
  const BELOW = y0 + 2 * ROW + 30;

  // the big knob, level with the top row
  s += `<circle cx="500" cy="98" r="34" fill="#26262b" stroke="#3a3a40" stroke-width="3"/>`;
  s += text(500, 104, 'K2', { size: 15, fill: '#e9e9ee', weight: 600 });
  s += text(500, 152, '大旋鈕', { size: 12 });
  s += text(500, 169, '捲動對話', { size: 11, fill: HL });

  // the three screenless buttons
  ['MODE', 'FORK', 'ARCHIVE'].forEach((n, i) => {
    const cx = x0 + 48 + i * (K + GAP);
    s += `<circle cx="${cx}" cy="${BELOW}" r="17" fill="#26262b" stroke="#3a3a40" stroke-width="2"/>`;
    s += text(cx, BELOW + 34, n, { size: 11, fill: HL });
  });
  s += text(x0 + 154, BELOW + 58, '↑ 無螢幕，靠位置記憶', { size: 11 });

  // the two small knobs
  [['K1', 'model', 466], ['K3', 'session', 556]].forEach(([n, role, cx]) => {
    s += `<circle cx="${cx}" cy="${BELOW}" r="21" fill="#26262b" stroke="#3a3a40" stroke-width="2"/>`;
    s += text(cx, BELOW + 6, n, { size: 12, fill: '#e9e9ee', weight: 600 });
    s += text(cx, BELOW + 38, role, { size: 11, fill: HL });
  });
  s += text(511, BELOW + 58, '↑ 小旋鈕', { size: 11 });

  s += text(40, 28, 'AKP03 Agent Deck — 佈局', { size: 15, fill: '#e9e9ee', anchor: 'start', weight: 600 });
  s += text(724, 28, '6 LCD 鍵 · 3 實體鍵 · 3 旋鈕', { size: 11, anchor: 'end' });
  s += '</svg>';
  return s;
}

// ── figure 2: what the status key says ──────────────────────────────────────

function statusStates() {
  const K = 96, GAP = 14;
  const cases = [
    [icons.statusIcon(deck('idle'), { context: 40 }), '待命 — 按下送出'],
    [icons.statusIcon(deck('thinking'), { context: 62 }), 'Claude 工作中'],
    [icons.statusIcon(deck('awaiting_approval', { toolName: 'Bash' }), { context: 78 }), '等你批准'],
    [icons.statusIcon(deck('idle'), { context: 94 }), '上下文快滿了'],
  ];
  let s = `<svg xmlns="http://www.w3.org/2000/svg" width="620" height="190" viewBox="0 0 620 190">
    <rect width="100%" height="100%" fill="${BG}"/>`;
  s += text(20, 26, 'Key1 狀態鍵 — 底部細線是 context 用量', { size: 14, fill: '#e9e9ee', anchor: 'start', weight: 600 });
  cases.forEach(([uri, label], i) => {
    const x = 20 + i * (K + GAP + 40);
    s += `<g transform="translate(${x},44) scale(${K / 144})">${body(uri)}</g>`;
    s += text(x + K / 2, 168, label, { size: 11 });
  });
  s += '</svg>';
  return s;
}

// ── figure 3: the keycap library ────────────────────────────────────────────

function capSheet() {
  const cols = 7, S = 74, GAP = 8;
  const rows = Math.ceil(CAP_NAMES.length / cols);
  const W = cols * (S + GAP) + GAP;
  const H = rows * (S + GAP + 15) + 46;
  let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <rect width="100%" height="100%" fill="${BG}"/>`;
  s += text(GAP, 26, `可替換鍵面 — ${CAP_NAMES.length} 個`, { size: 14, fill: '#e9e9ee', anchor: 'start', weight: 600 });
  CAP_NAMES.forEach((n, i) => {
    const x = GAP + (i % cols) * (S + GAP);
    const y = 40 + Math.floor(i / cols) * (S + GAP + 15);
    s += `<rect x="${x}" y="${y}" width="${S}" height="${S}" rx="10" fill="#1b1b1e"/>`;
    s += `<g transform="translate(${x + S / 2},${y + S / 2}) scale(0.95)">${CAPS[n]('#e9e9ee')}</g>`;
    s += text(x + S / 2, y + S + 11, n.replace('+', '&#43;'), { size: 8 });
  });
  s += '</svg>';
  return s;
}

// ── figure 4: the approval loop ─────────────────────────────────────────────

function loopDiagram() {
  const box = (x, y, w, h, fill, stroke) =>
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="9" fill="${fill}" stroke="${stroke}" stroke-width="2"/>`;
  const arrow = (x1, y1, x2, y2) =>
    `<path d="M${x1} ${y1} L${x2} ${y2}" stroke="#4a4a52" stroke-width="2" marker-end="url(#a)"/>`;

  let s = `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="290" viewBox="0 0 720 290">
    <defs><marker id="a" markerWidth="9" markerHeight="9" refX="8" refY="3" orient="auto">
      <path d="M0 0 L8 3 L0 6 z" fill="#4a4a52"/></marker></defs>
    <rect width="100%" height="100%" fill="${BG}"/>`;
  s += text(24, 28, '實體按鍵如何決定工具跑不跑', { size: 15, fill: '#e9e9ee', anchor: 'start', weight: 600 });

  s += box(24, 56, 170, 52, '#1b1b1e', '#3a3a40');
  s += text(109, 79, 'Claude Code', { size: 12, fill: '#e9e9ee' });
  s += text(109, 96, '要跑 Bash', { size: 11 });

  s += box(250, 56, 190, 52, '#1d2433', '#7aa2f7');
  s += text(345, 79, 'PreToolUse hook', { size: 12, fill: '#7aa2f7' });
  s += text(345, 96, 'POST → :9317', { size: 11 });

  s += box(500, 56, 190, 52, '#3a2a12', '#e0af68');
  s += text(595, 79, 'Agent Deck', { size: 12, fill: '#e0af68' });
  s += text(595, 96, 'agent 停下來等', { size: 11 });

  s += box(500, 150, 190, 62, '#14301c', '#7ad07a');
  s += text(595, 174, '你按下 ✓', { size: 13, fill: '#7ad07a', weight: 600 });
  s += text(595, 194, '指令印在鍵面上', { size: 11 });

  s += box(24, 150, 400, 62, '#1b1b1e', '#3a3a40');
  s += text(224, 176, '{"permissionDecision": "allow"}', { size: 12, fill: '#7ad07a' });
  s += text(224, 196, 'Claude 繼續跑 — 你按的那一下就是回傳值', { size: 11 });

  s += arrow(196, 82, 246, 82);
  s += arrow(442, 82, 496, 82);
  s += arrow(595, 110, 595, 146);
  s += arrow(498, 181, 430, 181);

  s += text(24, 252, '關鍵：agent 問，你答。這條路完全不碰畫面 —— 走的是 hook，不是 UI 自動化。', { size: 11, anchor: 'start' });
  s += text(24, 272, '所有失敗路徑都回 defer：裝置沒插、plugin 崩了、逾時 → 交還給螢幕上的權限提示。', { size: 11, anchor: 'start' });
  s += '</svg>';
  return s;
}

const figs = {
  'deck-map': deckMap(),
  'status-states': statusStates(),
  'caps': capSheet(),
  'loop': loopDiagram(),
};
for (const [name, svg] of Object.entries(figs)) {
  writeFileSync(join(OUT, `${name}.svg`), svg);
}
console.log(Object.keys(figs).join(' '));
