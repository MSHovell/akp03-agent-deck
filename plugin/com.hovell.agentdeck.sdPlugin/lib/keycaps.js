/**
 * A library of swappable keycaps, in the spirit of Codex Micro's keycap picker:
 * pick a face, bind it to whatever you want the key to do.
 *
 * Every glyph is drawn centred on 0,0 in a roughly -30..30 box, stroked in
 * `c`. Keep them line-art and chunky: these end up ~40px tall on the device, so
 * fine detail turns to mud.
 *
 * OpenAI-specific caps from the original (CODEX, OAI) are deliberately absent —
 * this deck drives Claude Code. CLAUDE is here instead.
 */

const s = (d, c, w = 6) =>
  `<path d="${d}" fill="none" stroke="${c}" stroke-width="${w}"
    stroke-linecap="round" stroke-linejoin="round"/>`;
const circle = (cx, cy, r, c, w = 6) =>
  `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${c}" stroke-width="${w}"/>`;
const dot = (cx, cy, r, c) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${c}"/>`;

/** name -> (colour) => svg markup */
export const CAPS = {
  // ── agent control ────────────────────────────────────────────────────────
  FAST: (c) => `<path d="M4 -26 L-16 4 L-2 4 L-4 26 L16 -4 L2 -4 Z" fill="${c}"/>`,
  APPR: (c) => circle(0, 0, 22, c, 5) + s('M-10 1 L-3 8 L11 -8', c, 5),
  REJ: (c) => circle(0, 0, 22, c, 5) + s('M-8 -8 L8 8 M8 -8 L-8 8', c, 5),
  STOP: (c) => `<rect x="-13" y="-13" width="26" height="26" rx="4" fill="${c}"/>`,
  CLAUDE: (c) => {
    let out = '';
    for (let i = 0; i < 10; i++) {
      out += `<path d="M 0 0 Q 4 -13 0 -24 Q -4 -13 0 0 Z" fill="${c}"
        transform="rotate(${(i * 360) / 10})"/>`;
    }
    return out;
  },

  // ── git ──────────────────────────────────────────────────────────────────
  FORK: (c) => dot(-14, -16, 6, c) + dot(14, -16, 6, c) + dot(0, 18, 6, c) +
    s('M-14 -10 v6 a8 8 0 0 0 8 8 h12 a8 8 0 0 1 8 -8 v-6', c, 5).replace(/v6 a8.*$/, '') +
    s('M-14 -10 C-14 2 0 2 0 12 M14 -10 C14 2 0 2 0 12', c, 5),
  BRCH: (c) => dot(-14, -16, 6, c) + dot(-14, 16, 6, c) + dot(14, -16, 6, c) +
    s('M-14 -10 v20 M-14 -16 h10 a18 18 0 0 1 18 0', c, 5),
  MRG: (c) => dot(-14, -16, 6, c) + dot(-14, 16, 6, c) + dot(14, 16, 6, c) +
    s('M-14 -10 v20 M-14 -2 a16 16 0 0 0 16 16 h6', c, 5),
  PR: (c) => s('M-20 -8 h30 a8 8 0 0 1 8 8 v14 M2 -18 L12 -8 L2 2', c, 5) +
    dot(-20, -8, 6, c) + dot(18, 18, 6, c),
  GIT: (c) => `<rect x="-22" y="-22" width="44" height="44" rx="8" fill="none"
    stroke="${c}" stroke-width="5" transform="rotate(45)"/>` + s('M-6 -6 L6 6', c, 5),
  DIFF: (c) => s('M-20 -10 h22 M-9 -21 v22 M-2 14 h22', c, 6),

  // ── workflow ─────────────────────────────────────────────────────────────
  PLAY: (c) => `<path d="M-10 -18 L18 0 L-10 18 Z" fill="${c}"/>`,
  TERM: (c) => `<rect x="-24" y="-18" width="48" height="36" rx="5" fill="none"
    stroke="${c}" stroke-width="5"/>` + s('M-14 -6 L-6 0 L-14 6 M-2 8 h12', c, 4),
  // Legs stay SHORT and the body stays SOLID. An outlined ellipse with long
  // radiating legs renders as a sunburst at 40px, not an insect.
  BUG: (c) =>
    s('M-9 -17 L-14 -24 M9 -17 L14 -24', c, 3) +
    `<ellipse cx="0" cy="3" rx="12" ry="17" fill="${c}"/>` +
    s('M-12 -4 h-9 M12 -4 h9 M-12 4 h-10 M12 4 h10 M-11 12 h-8 M11 12 h8', c, 3) +
    `<circle cx="0" cy="-13" r="6" fill="${c}"/>` +
    s('M0 -12 v28', '#1b1b1e', 2),
  LAB: (c) => s('M-7 -22 v14 L-18 14 a4 4 0 0 0 4 6 h28 a4 4 0 0 0 4 -6 L7 -8 v-14 M-11 -22 h22', c, 5),
  MAGIC: (c) => `<path d="M0 -24 L5 -6 L23 0 L5 6 L0 24 L-5 6 L-23 0 L-5 -6 Z" fill="${c}"/>`,
  PARTY: (c) => s('M-20 20 L-4 -16 L20 8 Z', c, 5) + dot(14, -14, 4, c) + dot(2, -22, 3, c) + dot(22, -4, 3, c),
  PAINT: (c) => s('M14 -20 L22 -12 L-2 12 L-12 14 L-10 4 Z M-12 14 L-20 22', c, 5),
  TIME: (c) => circle(0, 0, 21, c, 5) + s('M0 -11 v11 l8 6', c, 4),

  // ── files ────────────────────────────────────────────────────────────────
  FOLD: (c) => s('M-22 16 v-28 h12 l5 6 h27 v22 z', c, 5),
  NEW: (c) => s('M12 -20 L20 -12 L-4 12 L-14 14 L-12 4 Z M-20 20 h40', c, 5),
  DEL: (c) => s('M-16 -12 h32 M-11 -12 v24 M0 -12 v24 M11 -12 v24 M-13 -12 l2 26 h22 l2 -26 M-7 -12 v-6 h14 v6', c, 4),
  DWN: (c) => s('M0 -20 v26 M-10 -4 L0 6 L10 -4 M-18 16 h36', c, 5),
  UPL: (c) => s('M0 16 v-26 M-10 0 L0 -10 L10 0 M-18 -16 h36', c, 5),
  NAV: (c) => `<path d="M-16 18 L0 -20 L16 18 L0 8 Z" fill="none" stroke="${c}"
    stroke-width="5" stroke-linejoin="round"/>`,

  // ── effort / thinking ────────────────────────────────────────────────────
  'MIND+': (c) => circle(0, 0, 20, c, 5) + s('M0 -10 v20 M-10 0 h20', c, 5),
  'MIND-': (c) => circle(0, 0, 20, c, 5) + s('M-10 0 h20', c, 5),

  EMPTY: (c) => circle(0, 0, 18, c, 4),
};

export const CAP_NAMES = Object.keys(CAPS);
