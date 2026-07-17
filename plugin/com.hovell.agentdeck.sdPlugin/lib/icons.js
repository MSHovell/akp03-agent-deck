/**
 * Key art, rendered as SVG data URIs — no image library, no build step.
 * setImage accepts `data:image/svg+xml`, so state changes are just a string.
 * viewBox is square and unitless so it scales to whatever the AKP03 keys are.
 */
import { CAPS, CAP_NAMES } from './keycaps.js';

const BG = {
  idle: '#1b1b1e',
  thinking: '#241a15', // warm dark, to sit under the clay pulse
  awaiting: '#3a2a12',
  allow: '#14301c',
  deny: '#331616',
  done: '#14301c',
  error: '#331616',
  dim: '#141416',
};

const FG = {
  idle: '#8a8a92',
  live: '#e9e9ee',
  accent: '#7aa2f7',
  warn: '#e0af68',
  good: '#7ad07a',
  bad: '#f07a7a',
  claude: '#d97757', // Claude's clay orange — the working indicator
};

/**
 * Heat for a percentage: green while there's room, amber when it's getting
 * close, red when it's nearly gone.
 */
export function heat(pct) {
  return pct >= 90 ? FG.bad : pct >= 75 ? FG.warn : FG.good;
}

/**
 * A thin fill bar across the very bottom of a key.
 *
 * It sits below the label, in the few pixels that were doing nothing, so it
 * costs the icon and the status text nothing.
 */
function bottomBar(pct) {
  const p = Math.max(0, Math.min(100, pct));
  const x = 14;
  const w = 116;
  return `
    <rect x="${x}" y="130" width="${w}" height="6" rx="3" fill="#2f2f36"/>
    ${p > 0 ? `<rect x="${x}" y="130" width="${((w * p) / 100).toFixed(1)}" height="6" rx="3" fill="${heat(p)}"/>` : ''}`;
}

/** Wrap glyph markup in a rounded-rect key face. */
function key({ bg = BG.idle, glyph = '', label = '', labelColor = FG.idle, ring = null, bar = null }) {
  // The label lifts a little when a bar is present, so the two never touch.
  const labelY = bar === null ? 122 : 116;
  return svg(`
    <rect width="144" height="144" rx="18" fill="${bg}"/>
    ${ring ? `<rect x="2.5" y="2.5" width="139" height="139" rx="16" fill="none" stroke="${ring}" stroke-width="5"/>` : ''}
    <g transform="translate(72, ${label ? (bar === null ? 58 : 54) : 72})">${glyph}</g>
    ${
      label
        ? `<text x="72" y="${labelY}" font-family="Segoe UI, Inter, sans-serif" font-size="19"
             font-weight="600" fill="${labelColor}" text-anchor="middle">${esc(label)}</text>`
        : ''
    }
    ${bar === null ? '' : bottomBar(bar)}
  `);
}

function svg(inner) {
  const doc = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144" width="144" height="144">${inner}</svg>`;
  // base64, not percent-encoding: OpenDeck splits the data URI on the comma and
  // writes the payload straight to disk as <state>.svg. With `charset=utf8,` +
  // encodeURIComponent it saves the literal "%3Csvg%20..." text, which is not
  // parseable XML — the key renders blank. base64 it decodes properly.
  return 'data:image/svg+xml;base64,' + Buffer.from(doc, 'utf8').toString('base64');
}

function esc(s) {
  return String(s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]);
}

const stroke = (d, color, w = 8) =>
  `<path d="${d}" fill="none" stroke="${color}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`;

// ── glyphs (drawn centred on 0,0) ───────────────────────────────────────────

const G = {
  check: (c) => stroke('M-22 2 L-7 17 L22 -15', c, 10),
  cross: (c) => stroke('M-17 -17 L17 17 M17 -17 L-17 17', c, 10),
  bolt: (c) => `<path d="M4 -26 L-18 4 L-2 4 L-4 26 L18 -4 L2 -4 Z" fill="${c}"/>`,
  mic: (c) => `
    <rect x="-9" y="-26" width="18" height="32" rx="9" fill="${c}"/>
    ${stroke('M-18 0 a18 18 0 0 0 36 0', c, 6)}
    ${stroke('M0 18 L0 27', c, 6)}`,
  stop: (c) => `<rect x="-15" y="-15" width="30" height="30" rx="5" fill="${c}"/>`,
  branch: (c) => `
    ${stroke('M-16 22 L-16 -8 a10 10 0 0 1 10 -10 L14 -18', c, 7)}
    ${stroke('M4 -28 L16 -18 L4 -8', c, 7)}
    <circle cx="-16" cy="24" r="7" fill="${c}"/>`,
  chat: (c) => `
    ${stroke('M-24 -18 h48 a6 6 0 0 1 6 6 v22 a6 6 0 0 1 -6 6 h-30 l-14 12 v-12 h-4 a6 6 0 0 1 -6 -6 v-22 a6 6 0 0 1 6 -6 z', c, 6)}`,
  /**
   * Claude's asterisk mark: tapered rays around a centre.
   *
   * Deliberately static. The deck shows a still bitmap — OpenDeck rasterises the
   * SVG once, so <animate> never runs — and faking motion would mean pumping
   * ~10 images/sec down the HID pipe for one key. The clay colour already says
   * "working"; the label says the rest.
   */
  claudeMark: (c, r = 26) => {
    // Spikes radiating OUT from the centre — not bars through it. A bar is
    // symmetric, so rotating one by 180° redraws the same shape: the obvious
    // "8 rays over 360°" loop silently paints each ray twice.
    const rays = 10;
    const w = r * 0.19; // half-width at the fattest point
    let out = '';
    for (let i = 0; i < rays; i++) {
      const a = (i * 360) / rays;
      out +=
        `<path d="M 0 0 Q ${w} ${-r * 0.55} 0 ${-r} ` +
        `Q ${-w} ${-r * 0.55} 0 0 Z" fill="${c}" transform="rotate(${a})"/>`;
    }
    return out;
  },

  /**
   * Two concentric arcs: context (outer) and plan (inner) usage.
   * Arcs are drawn from 12 o'clock clockwise, so a fuller ring reads as "more
   * used" at a glance.
   */
  usageRings: (ctxPct, planPct, colours) => {
    const arc = (radius, pct, colour, width) => {
      const p = Math.max(0, Math.min(100, pct));
      const track = `<circle cx="0" cy="0" r="${radius}" fill="none"
        stroke="#2f2f36" stroke-width="${width}"/>`;
      if (p <= 0) return track;
      const circ = 2 * Math.PI * radius;
      const on = (circ * p) / 100;
      return (
        track +
        `<circle cx="0" cy="0" r="${radius}" fill="none" stroke="${colour}"
          stroke-width="${width}" stroke-linecap="round"
          stroke-dasharray="${on.toFixed(2)} ${(circ - on).toFixed(2)}"
          transform="rotate(-90)"/>`
      );
    };
    return arc(30, ctxPct, colours[0], 7) + arc(19, planPct, colours[1], 7);
  },

  dots: (c) => `
    <circle cx="-18" cy="0" r="6" fill="${c}"/>
    <circle cx="0" cy="0" r="6" fill="${c}" opacity="0.6"/>
    <circle cx="18" cy="0" r="6" fill="${c}" opacity="0.3"/>`,
  sleep: (c) => stroke('M18 8 a22 22 0 1 1 -22 -26 a17 17 0 0 0 22 26 z', c, 7),
  plane: (c) => `<path d="M-22 4 L20 -16 L4 20 L-4 6 Z" fill="none" stroke="${c}"
    stroke-width="7" stroke-linejoin="round"/>`,
};

// ── public: one renderer per action ─────────────────────────────────────────

/** ✓ — only lit while a tool call is actually waiting on you. */
export function approveIcon(deck) {
  const armed = !!deck.pending;
  return key({
    bg: armed ? BG.allow : BG.dim,
    glyph: G.check(armed ? FG.good : '#3a3a40'),
    label: armed ? 'APPROVE' : '',
    labelColor: FG.good,
    ring: armed ? FG.good : null,
  });
}

/** ✗ — likewise dark unless there is something to reject. */
export function denyIcon(deck) {
  const armed = !!deck.pending;
  return key({
    bg: armed ? BG.deny : BG.dim,
    glyph: G.cross(armed ? FG.bad : '#3a3a40'),
    label: armed ? 'DENY' : '',
    labelColor: FG.bad,
    ring: armed ? FG.bad : null,
  });
}

/**
 * The centre key: says what Claude is doing, sends when you press it, and
 * carries a context-window bar along the bottom.
 *
 * Doubling up is deliberate. It sits between APPROVE and DENY, so it is where
 * your eye already goes; and dictation ends here — speak, glance, press. The
 * Claude mark is constant so the key stays recognisable while its label changes.
 *
 * The bar rides here rather than on the USAGE key because context is what you
 * need to know at the moment you send: it is the thing your next message eats.
 * `context` is a real reading off the app's own usage button, not an estimate.
 */
export function statusIcon(deck, { context = null } = {}) {
  const bar = context; // null hides it entirely — no bar until we have a number
  switch (deck.state) {
    case 'awaiting_approval':
      return key({
        bg: BG.awaiting,
        glyph: G.chat(FG.warn),
        label: deck.pending?.toolName ?? 'ASKING',
        labelColor: FG.warn,
        ring: FG.warn,
        bar,
      });
    case 'thinking':
      return key({
        bg: BG.thinking,
        glyph: G.claudeMark(FG.claude),
        label: 'THINKING',
        labelColor: FG.claude,
        bar,
      });
    case 'error':
      return key({ bg: BG.error, glyph: G.cross(FG.bad), label: 'ERROR', labelColor: FG.bad, bar });
    // idle and done both mean "your turn" — the key is a send button again.
    // The mark stays clay in every state: it is Claude's colour, not a status
    // light. The label carries the state.
    default:
      return key({
        bg: BG.idle,
        glyph: G.claudeMark(FG.claude),
        label: 'SEND',
        labelColor: FG.idle,
        bar,
      });
  }
}

/**
 * Claude usage as two rings: context (outer) and plan (inner).
 *
 * The numbers are read straight off the app's own usage button, whose
 * accessible name is literally "Usage: context 55%, plan 94%" — so this is a
 * readout, not an estimate. Rings turn amber past 75% and red past 90%.
 */
export function usageIcon(_deck, { context = null, plan = null } = {}) {
  if (context === null || plan === null) {
    return key({ bg: BG.dim, glyph: G.usageRings(0, 0, ['#3a3a40', '#3a3a40']), label: '' });
  }
  const heat = (p) => (p >= 90 ? FG.bad : p >= 75 ? FG.warn : FG.accent);
  const worst = Math.max(context, plan);
  return key({
    bg: worst >= 90 ? BG.deny : BG.idle,
    glyph: G.usageRings(context, plan, [heat(context), heat(plan)]),
    label: `${plan}%`,
    labelColor: heat(worst),
    ring: worst >= 90 ? FG.bad : null,
  });
}

export function interruptIcon(deck) {
  const live = deck.state === 'thinking' || deck.state === 'awaiting_approval';
  return key({
    bg: live ? BG.idle : BG.dim,
    glyph: G.stop(live ? FG.bad : '#3a3a40'),
    label: live ? 'STOP' : '',
    labelColor: FG.bad,
  });
}

/**
 * Three states, all real — never guessed. In "local" mode we own the ffmpeg
 * process; in "gui" mode the dictation button reports its own ToggleState.
 *
 * TRANSCRIBING matters: whisper takes a couple of seconds on a local model, and
 * a key that goes dark in that gap reads as a dropped press.
 */
export function voiceIcon(_deck, { recording = false, transcribing = false } = {}) {
  if (transcribing) {
    return key({
      bg: BG.thinking,
      glyph: G.dots(FG.accent),
      label: 'HEARING',
      labelColor: FG.accent,
    });
  }
  return key({
    bg: recording ? BG.deny : BG.idle,
    glyph: G.mic(recording ? FG.bad : FG.live),
    label: recording ? 'REC' : 'VOICE',
    labelColor: recording ? FG.bad : FG.idle,
    ring: recording ? FG.bad : null,
  });
}

export function dispatchIcon(_deck, { label = 'DISPATCH' } = {}) {
  return key({ bg: BG.idle, glyph: G.bolt(FG.warn), label, labelColor: FG.idle });
}

/**
 * Unlike APPROVE, this is always usable — it's an action, not an answer to a
 * question, so it never goes dark. It just lights up when a fresh transcript is
 * sitting in the composer waiting on you.
 */
export function sendIcon(_deck, { armed = false } = {}) {
  return key({
    bg: armed ? BG.allow : BG.idle,
    glyph: G.plane(armed ? FG.good : FG.live),
    label: 'SEND',
    labelColor: armed ? FG.good : FG.idle,
    ring: armed ? FG.good : null,
  });
}

export function sessionIcon(deck, { label = 'SESSION' } = {}) {
  const n = deck.sessions.size;
  return key({ bg: BG.idle, glyph: G.branch(FG.accent), label: n ? `${label} ${n}` : label, labelColor: FG.idle });
}

/**
 * A swappable keycap: pick a face from the library, give it a label, bind it to
 * whatever you want. Codex Micro's keycap picker, for this deck.
 *
 * `busy` lights it while its action is running, so a key that fires a slow
 * prompt doesn't look dead.
 */
export function keycapIcon(_deck, { cap = 'EMPTY', label = '', colour = null, busy = false } = {}) {
  const face = CAPS[cap] ?? CAPS.EMPTY;
  const c = busy ? FG.claude : colour || FG.live;
  return key({
    bg: busy ? BG.thinking : BG.idle,
    glyph: face(c),
    label: label || cap,
    labelColor: busy ? FG.claude : FG.idle,
    ring: busy ? FG.claude : null,
  });
}

/** Colour per permission mode: green is loose, blue is careful. */
const MODE_TINT = {
  Manual: FG.good,
  'Accept edits': FG.accent,
  Plan: FG.warn,
  Auto: FG.warn,
  'Bypass permissions': FG.bad,
};

/**
 * Session actions: cycle mode, fork, archive.
 *
 * The mode face carries a tint per mode AND its name, because it's on a
 * screenless key half the time — the tint is for the on-screen keys, the label
 * for nothing, and the readout is really for you checking the deck.
 */
export function actIcon(
  _deck,
  { act = 'mode-cycle', label = '', mode = null, pending = false, busy = false } = {},
) {
  if (act === 'fork') {
    return key({
      bg: busy ? BG.thinking : BG.idle,
      glyph: CAPS.FORK(busy ? FG.claude : FG.live),
      label: label || 'FORK',
      labelColor: FG.idle,
    });
  }
  if (act === 'archive') {
    return key({
      bg: busy ? BG.thinking : BG.idle,
      glyph: CAPS.FOLD(busy ? FG.claude : FG.live),
      label: label || 'ARCHIVE',
      labelColor: FG.idle,
    });
  }
  // mode-cycle. `pending` means you're mid-step: this is where you're heading,
  // not where you are. It gets a ring so a glance tells the two apart.
  const tint = MODE_TINT[mode] ?? FG.idle;
  const short = { 'Accept edits': 'EDITS', 'Bypass permissions': 'BYPASS' }[mode] ?? mode ?? 'MODE';
  return key({
    bg: pending ? BG.thinking : BG.idle,
    glyph: CAPS.MAGIC(tint),
    label: short.toUpperCase(),
    labelColor: tint,
    ring: pending ? FG.claude : mode === 'Bypass permissions' ? FG.bad : null,
  });
}

export const glyphs = G;
export const palette = { BG, FG };
export { CAP_NAMES };
