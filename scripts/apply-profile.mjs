#!/usr/bin/env node
/**
 * Writes the docs/LAYOUT.md layout straight into an OpenDeck profile.
 *
 * Dragging eight actions onto keys by hand is fine once; it is not fine every
 * time you reinstall or add a device. The profile is plain JSON, and the shape
 * comes from OpenDeck's `shared.rs` (Profile / ActionInstance / ActionState).
 *
 *   node scripts/apply-profile.mjs               # list devices, dry run
 *   node scripts/apply-profile.mjs --write       # apply
 *
 * OpenDeck must be CLOSED — it rewrites profiles on exit and will clobber this.
 *
 * And "closed" is harder than it looks. OpenDeck defaults to `"background": true`,
 * so closing its window only hides it in the tray: CloseMainWindow() returns
 * happily while the process lives on. From a script the only way out is a force
 * kill — which means anything you had unsaved in its UI is gone. Quit it from the
 * tray icon by hand if you have edits worth keeping.
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = join(HERE, '..', 'plugin', 'com.hovell.agentdeck.sdPlugin');
const PLUGIN_ID = 'com.hovell.agentdeck';
/** `action.plugin` carries the .sdPlugin suffix; the action UUIDs do not. */
const PLUGIN_KEY = `${PLUGIN_ID}.sdPlugin`;
const PROFILES = join(process.env.APPDATA ?? '', 'OpenDeck', 'profiles');

/** OpenDeck stores absolute, forward-slashed paths — not manifest-relative ones. */
const abs = (rel) => join(PLUGIN_DIR, rel).replace(/\\/g, '/');

const manifest = JSON.parse(readFileSync(join(PLUGIN_DIR, 'manifest.json'), 'utf8'));
const byUuid = new Map(manifest.Actions.map((a) => [a.UUID, a]));

/**
 * Physical layout, confirmed against the hardware:
 *
 *   [0][1][2]        (O) K2 big knob
 *   [3][4][5]
 *    .  .  .        .    .        <- keys 6-8 and the two small knobs
 *    6  7  8       K1    K3
 *
 * Keys 0-5 are the LCD keys. Keys 6-8 are the three small round buttons and
 * have NO SCREEN — anything whose job is to show you something is wasted there.
 * That rules out `session` (its entire purpose is displaying a count) and
 * `status`. They suit actions you press from memory, like their stock
 * prev/home/next.
 *
 * See docs/LAYOUT.md for why approve and deny are a full key apart.
 */
const KEYS = [
  'approve', 'status', 'deny',
  'usage', 'voice', 'interrupt',
  'act', 'act', 'act',
];

/**
 * Keys 6-8 have no screen, so their face is invisible and only the binding
 * matters — you press them from muscle memory, left to right. That rules out
 * anything whose job is to report state, and suits actions you press without
 * looking.
 */
const SCREENLESS = [
  { act: 'mode-cycle', label: 'MODE' },
  { act: 'fork', label: 'FORK' },
  { act: 'archive', label: 'ARCHIVE' },
];

/**
 * The knobs. Confirmed against the hardware — nothing documents which slider
 * index is which physical knob, and they are not identical:
 *
 *   K1 = small knob, left      slider 0
 *   K2 = BIG knob              slider 1
 *   K3 = small knob, right     slider 2
 *
 * All three turn and press.
 */
const SLIDERS = [
  { action: 'dial', settings: { mode: 'model' } },
  { action: 'dial', settings: { mode: 'scroll' } },
  { action: 'dial', settings: { mode: 'session' } },
];

const KEY_SETTINGS = {
  dispatch: { label: 'REVIEW', prompt: '/code-review high' },
};

/** Per-position overrides, for keys that repeat the same action. */
const settingsFor = (name, position) =>
  position >= 6 && SCREENLESS[position - 6] ? SCREENLESS[position - 6] : (KEY_SETTINGS[name] ?? {});

function actionDef(shortName) {
  const uuid = `${PLUGIN_ID}.${shortName}`;
  const m = byUuid.get(uuid);
  if (!m) throw new Error(`no action "${uuid}" in manifest.json`);
  return {
    name: m.Name,
    uuid: m.UUID,
    plugin: PLUGIN_KEY,
    tooltip: m.Tooltip ?? '',
    // OpenDeck resolves manifest "icons/approve" to the @2x file, absolute.
    icon: abs(`${m.Icon}@2x.png`),
    disable_automatic_states: false,
    visible_in_action_list: true,
    supported_in_multi_actions: m.SupportedInMultiActions ?? false,
    property_inspector: m.PropertyInspectorPath ? abs(m.PropertyInspectorPath) : '',
    controllers: m.Controllers ?? ['Keypad'],
    encoder: m.Encoder ?? null,
    states: m.States.map(state),
  };
}

function state(s) {
  return {
    image: s.Image ? abs(`${s.Image}.png`) : 'actionDefaultImage',
    image_scale: 100,
    background_colour: '#000000',
    name: '',
    text: '',
    show: s.ShowTitle ?? false,
    colour: '#FFFFFF',
    stroke_colour: '#000000',
    alignment: s.TitleAlignment ?? 'middle',
    family: 'Liberation Sans',
    style: 'Regular',
    size: 16,
    stroke_size: 3,
    underline: false,
  };
}

function instance(shortName, { controller, position, settings = {} }) {
  const action = actionDef(shortName);
  return {
    action,
    // Verified against a profile OpenDeck wrote itself: the context is just
    // "controller.position.index". The five-part "device.profile.…" form in
    // shared.rs on main is NOT what v2.13.1 persists — writing that makes the
    // profile fail to deserialize, and OpenDeck silently replaces it with a
    // blank one. The only symptom is a dark deck, so it looks like nothing ran.
    context: `${controller}.${position}.0`,
    states: action.states,
    current_state: 0,
    settings,
    children: null,
  };
}

/** No top-level `id`: OpenDeck's own files don't carry one. */
function buildProfile() {
  return {
    infobars: [],
    keys: KEYS.map((name, position) =>
      name
        ? instance(name, { controller: 'Keypad', position, settings: settingsFor(name, position) })
        : null,
    ),
    sliders: SLIDERS.map((s, position) =>
      s ? instance(s.action, { controller: 'Encoder', position, settings: s.settings }) : null,
    ),
  };
}

// ── main ────────────────────────────────────────────────────────────────────

if (!existsSync(PROFILES)) {
  console.error(`No OpenDeck profiles at ${PROFILES} — launch OpenDeck once first.`);
  process.exit(1);
}

const devices = readdirSync(PROFILES, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);

if (!devices.length) {
  console.error('No devices. Plug the AKP03 in and launch OpenDeck once.');
  process.exit(1);
}

const write = process.argv.includes('--write');
const n3 = devices.filter((d) => d.startsWith('n3-'));
if (!n3.length) {
  console.error(`No AKP03 (n3-*) device. Found: ${devices.join(', ')}`);
  process.exit(1);
}

for (const device of n3) {
  const file = join(PROFILES, device, 'Default.json');
  const built = buildProfile();

  console.log(`\n  ${device}`);
  for (const [i, name] of KEYS.entries()) {
    console.log(`    key ${i}  ${name ?? '(empty)'}`);
  }
  for (const [i, s] of SLIDERS.entries()) {
    console.log(`    knob ${i}  ${s.action} (${s.settings.mode})`);
  }

  if (!write) continue;

  if (existsSync(file)) {
    const backup = `${file}.bak-${Date.now()}`;
    copyFileSync(file, backup);
    console.log(`\n    backed up -> ${backup.split(/[\\/]/).pop()}`);
  }
  writeFileSync(file, JSON.stringify(built, null, 2) + '\n');
  console.log(`    wrote ${file}`);
}

console.log(write ? '\n  done — start OpenDeck.\n' : '\n  dry run. Pass --write to apply (close OpenDeck first).\n');
