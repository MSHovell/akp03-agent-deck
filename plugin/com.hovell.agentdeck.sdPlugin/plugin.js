#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { OpenDeckClient } from './lib/opendeck.js';
import { HookServer } from './lib/hookserver.js';
import { AgentDeck, State } from './lib/state.js';
import { detectVoice } from './lib/detect.js';
import * as icons from './lib/icons.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ID = 'com.hovell.agentdeck';
const A = {
  approve: `${ID}.approve`,
  deny: `${ID}.deny`,
  interrupt: `${ID}.interrupt`,
  status: `${ID}.status`,
  voice: `${ID}.voice`,
  dispatch: `${ID}.dispatch`,
  send: `${ID}.send`,
  usage: `${ID}.usage`,
  act: `${ID}.act`,
  keycap: `${ID}.keycap`,
  session: `${ID}.session`,
  dial: `${ID}.dial`,
};

/**
 * The host owns stdout/stderr, so keep a file log for debugging.
 *
 * It lives under LOCALAPPDATA, not next to plugin.js. This log records voice
 * transcripts and the commands Claude was about to run — someone else's speech
 * has no business sitting in a program directory, where it also rides along in
 * any copy or zip of the plugin.
 */
const LOG_DIR = join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'agent-deck');
const LOG = join(LOG_DIR, 'agent-deck.log');
try {
  mkdirSync(LOG_DIR, { recursive: true });
} catch {
  /* fall through: log() swallows write errors anyway */
}
function log(msg) {
  const line = `${new Date().toISOString()} ${msg}\n`;
  try {
    appendFileSync(LOG, line);
  } catch {
    /* logging must never take the plugin down */
  }
}

function loadConfig() {
  const defaults = {
    // Not 8787: WSL's port relay squats on it, and the collision is invisible
    // from the device — the keys just never light up.
    port: 9317,
    approvalTimeoutMs: 90_000,
    gateTools: ['Bash', 'Write', 'Edit', 'NotebookEdit'],
    claudeBin: 'claude',
    // The VOICE key.
    //
    //   "auto"  — pick per machine on first run. See lib/detect.js.
    //   "gui"   — Claude Code Desktop's own dictation button, toggled through UI
    //             Automation (lib/mic.ps1). Zero dependencies. Its 20 languages.
    //   "local" — record with ffmpeg, transcribe with whisper.cpp, paste the
    //             text in. The only mode that speaks Chinese — and the only one
    //             that needs anything installed.
    //   "cli"   — terminal Claude Code: taps `key` at the focused window.
    //             Needs `/voice tap`.
    //
    // "auto", not "local": local was built for Chinese, but as a default it made
    // everyone else's VOICE key flash red for want of a 1.6GB model they never
    // needed — Claude Code already dictates their language.
    voice: {
      mode: 'auto',
      key: '{SPACE}',
      // Filled in by detection when mode resolves to "local". The @device_cm_
      // GUID, not the friendly name: friendly names are routinely non-ASCII and
      // get mangled crossing shell boundaries.
      device: null,
      whisperBin: null,
      whisperModel: null,
      language: null,
      threads: 8,
      autoSubmit: false,
      maxSeconds: 120,
    },
  };

  let raw;
  try {
    raw = readFileSync(join(HERE, 'config.json'), 'utf8');
  } catch {
    log('no config.json — first run; will detect and write one');
    return defaults;
  }

  try {
    // Strip a UTF-8 BOM. PowerShell 5.1's `Set-Content -Encoding utf8` writes
    // one, and JSON.parse rejects it — which used to fall through to the catch
    // below and silently run on defaults.
    const user = JSON.parse(raw.replace(/^﻿/, ''));
    // Merge `voice` one level deep. A shallow spread would let a partial
    // `"voice": { "mode": "local" }` wipe out threads, maxSeconds and the rest.
    return { ...defaults, ...user, voice: { ...defaults.voice, ...(user.voice ?? {}) } };
  } catch (err) {
    // Loud on purpose. Silently ignoring a broken config means the deck gates
    // the wrong tools on the wrong port, with nothing on screen to explain it.
    log(`FATAL: config.json is not valid JSON — ${err.message}`);
    process.exit(1);
  }
}

const config = loadConfig();

/**
 * Resolve `voice.mode: "auto"` against this machine, and persist the answer.
 *
 * Written back to config.json rather than re-detected each launch, for three
 * reasons: spawning ffmpeg on every start is waste; the file is where someone
 * looks to find out what the plugin decided; and it is where they override it.
 */
async function resolveVoice() {
  if (config.voice.mode !== 'auto' && existsSync(join(HERE, 'config.json'))) return;

  const detected = await detectVoice(config.voice.mode, log);
  Object.assign(config.voice, detected);

  try {
    writeFileSync(join(HERE, 'config.json'), JSON.stringify(config, null, 2) + '\n', 'utf8');
    log(`config.json written (voice.mode = ${config.voice.mode})`);
  } catch (err) {
    // Not fatal: we have the answer in memory, it just costs a detection next
    // launch. Read-only install dirs are a real possibility.
    log(`could not write config.json (${err.message}); detection will repeat next launch`);
  }
}

const deck = new AgentDeck({ log });
const client = new OpenDeckClient({ log });
const voice = {
  recording: false,
  transcribing: false,
  pendingSend: false,
  timer: null,
  proc: null,
  wav: null,
};
/** At most one dispatched run at a time — see dispatch(). */
let dispatchProc = null;
/** Last usage readout, refreshed on a timer. See startUsagePolling(). */
const usage = { context: null, plan: null };
/** Keycap contexts with an action in flight — lights them, and blocks re-entry. */
const busyKeycaps = new Set();
/** Archive keys waiting on a confirming second press. See runAct(). */
const armedArchive = new Set();
/** Current permission mode, for the mode key's face. */
let permMode = null;

// ── rendering ───────────────────────────────────────────────────────────────

const RENDERERS = {
  [A.approve]: (c) => icons.approveIcon(deck, c.settings),
  [A.deny]: (c) => icons.denyIcon(deck, c.settings),
  [A.interrupt]: (c) => icons.interruptIcon(deck, c.settings),
  [A.status]: (c) => icons.statusIcon(deck, { ...c.settings, context: usage.context }),
  [A.voice]: (c) =>
    icons.voiceIcon(deck, {
      ...c.settings,
      recording: voice.recording,
      transcribing: voice.transcribing,
    }),
  [A.dispatch]: (c) => icons.dispatchIcon(deck, c.settings),
  [A.send]: (c) => icons.sendIcon(deck, { ...c.settings, armed: voice.pendingSend }),
  [A.usage]: (c) => icons.usageIcon(deck, { ...c.settings, ...usage }),
  [A.keycap]: (c) =>
    icons.keycapIcon(deck, { ...c.settings, busy: busyKeycaps.has(c.context) }),
  [A.act]: (c) =>
    icons.actIcon(deck, {
      ...c.settings,
      mode: modeStep.target ?? permMode,
      pending: modeStep.target !== null,
      busy: busyKeycaps.has(c.context),
    }),
  [A.session]: (c) => icons.sessionIcon(deck, c.settings),
};

let renderQueued = false;
function render() {
  // State changes arrive in bursts (resolve → setState → emit); coalesce them
  // so we push one image per key per tick instead of hammering the HID pipe.
  if (renderQueued) return;
  renderQueued = true;
  queueMicrotask(() => {
    renderQueued = false;
    for (const ctx of client.contexts.values()) {
      const r = RENDERERS[ctx.action];
      if (!r) continue;
      try {
        client.setImage(ctx.context, r(ctx));
      } catch (err) {
        log(`render failed for ${ctx.action}: ${err.message}`);
      }
    }
    renderDials();
  });
}

function renderDials() {
  for (const ctx of client.byAction(A.dial)) {
    const mode = ctx.settings?.mode ?? 'menu';
    client.setFeedback(ctx.context, {
      title: DIAL_MODES[mode]?.title ?? mode,
      value: DIAL_MODES[mode]?.value(deck) ?? '',
    });
  }
}

deck.on('render', render);

// ── dials ───────────────────────────────────────────────────────────────────

/**
 * Cached labels for the model/mode/effort buttons, so a knob can show what is
 * currently selected without opening anything. Refreshed on demand — each read
 * spawns PowerShell (~300ms), far too slow to do per tick.
 */
const menuLabels = { model: '…', mode: '…', effort: '…' };
/** Which menu we believe is open. See uiaMenuDial for why a guess is safe here. */
const dialMenu = { open: null, timer: null };

async function refreshMenuLabel(which) {
  const res = await runPs('menu.ps1', ['-Menu', which, '-Action', 'state']);
  if (!res.startsWith('ERROR')) {
    menuLabels[which] = res.replace(/^Effort:\s*/, '');
    renderDials();
  }
  return res;
}

/**
 * A knob that drives one of Claude Code Desktop's menus through UI Automation.
 *
 * Opening goes through lib/menu.ps1 — Expand() on the real button — NOT through
 * the documented keyboard shortcut. Ctrl+Shift+I is supposed to open the model
 * menu; it opened an incognito Chat and threw the window off the Code tab. A
 * knob must never be able to do that on a stray turn.
 *
 * `dialMenu.open` is still a guess (the user can dismiss a menu with Esc or the
 * mouse and we never hear about it). That is now a cheap guess to be wrong
 * about: being wrong only means arrow keys land in the transcript and scroll it.
 * Being wrong about the OPEN action was what navigated the app.
 */
/** Name of the newest session, for the session dial's readout. */
let latestSession = null;
/** Whether fast mode is on, as last reported. */
let fastMode = false;

function uiaMenuDial(title, which) {
  const openIt = async () => {
    // Claim the menu BEFORE awaiting. A knob emits ticks every ~100ms while
    // menu.ps1 takes ~300ms, so setting this after the await let every tick see
    // "not open" and launch its own opener — a pile of them, all racing.
    dialMenu.open = which;
    clearTimeout(dialMenu.timer);
    // Self-clear: if it was dismissed behind our back, stop believing it's open.
    dialMenu.timer = setTimeout(() => {
      dialMenu.open = null;
      renderDials();
    }, 10_000);
    renderDials();

    const res = await runPs('menu.ps1', ['-Menu', which, '-Action', 'open']);
    if (res.startsWith('ERROR')) {
      log(`dial ${which}: ${res}`);
      dialMenu.open = null; // we didn't get it after all
      renderDials();
      return false;
    }
    return true;
  };

  return {
    title,
    value: () => {
      const label = dialMenu.open === which ? `● ${menuLabels[which]}` : menuLabels[which];
      return which === 'model' && fastMode ? `⚡${label}` : label;
    },
    rotate: async (ticks) => {
      // First turn opens it — that's what a selector knob should feel like.
      if (dialMenu.open !== which) {
        if (!(await openIt())) return;
        await sleep(250);
      }
      sendKeys(ticks > 0 ? 'DOWN' : 'UP', Math.abs(ticks));
    },
    press: async () => {
      if (dialMenu.open === which) {
        sendKeys('ENTER');
        dialMenu.open = null;
        clearTimeout(dialMenu.timer);
        await sleep(400);
        await refreshMenuLabel(which); // read back what actually got selected
      } else {
        await openIt();
      }
    },
    // Double-press to toggle fast mode. Only the model dial has one — fast mode
    // belongs to the model, and it lives inside that same menu. It is a
    // double-press rather than a hold because this hardware cannot report a
    // hold; see the dialDown handler.
    ...(which === 'model'
      ? {
          doublePress: async () => {
            const res = await ps('fast-toggle');
            if (res.startsWith('ERROR')) return log(`fast mode: ${res}`);
            fastMode = res === 'on';
            log(`fast mode -> ${res}`);
            dialMenu.open = null; // the toggle closes the menu behind us
            renderDials();
          },
        }
      : {}),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DIAL_MODES = {
  /**
   * Answers Claude when it offers a choice: a permission dialog, an elicitation.
   * Opens nothing itself, so it is never wrong about what's on screen.
   *
   * LEFT/RIGHT, not up/down. Claude Code cycles dialog options with the
   * horizontal arrows; the vertical ones move the cursor or walk prompt history,
   * so an up/down knob just scrolled through previously sent messages. Vertical
   * lists — the model menu — are the `model` dial's job, and that one does use
   * up/down.
   */
  menu: {
    title: 'Options',
    value: () => '↔ / press',
    rotate: (ticks) => sendKeys(ticks > 0 ? 'RIGHT' : 'LEFT', Math.abs(ticks)),
    press: () => sendKeys('ENTER'),
  },

  /** Turn to walk the sessions; press to come back to the newest. */
  session: {
    title: 'Session',
    value: () => latestSession ?? '—',
    rotate: (ticks) => sendKeysRaw(ticks > 0 ? '^{TAB}' : '^+{TAB}', Math.abs(ticks)),
    press: async () => {
      // Jump to the top of Recents. The list is newest-first, so this is the way
      // back after wandering off with the knob.
      const res = await ps('session-latest');
      if (res.startsWith('ERROR')) return log(`dial session: ${res}`);
      latestSession = res;
      renderDials();
    },
  },

  model: uiaMenuDial('Model', 'model'),
  mode: uiaMenuDial('Mode', 'mode'),
  effort: uiaMenuDial('Effort', 'effort'),

  /**
   * The conversation, under your thumb — like a mouse wheel, but aimed.
   *
   * Drives the transcript's own ScrollPattern through UIA rather than sending
   * arrows or synthesising a wheel event: arrows go wherever focus is (in the
   * composer they walk prompt history), and a real wheel scrolls whatever is
   * under the pointer. This scrolls the conversation regardless of either.
   */
  scroll: {
    title: 'Scroll',
    value: () => (scrollPct === null ? '—' : `${scrollPct}%`),
    // Ticks are banked, not fired. A knob emits one every ~100ms while
    // scroll.ps1 takes ~300ms, so firing per tick meant several processes all
    // read the SAME starting percent and computed the SAME target — a whole
    // spin landed one notch. Now one call is in flight at a time and it picks
    // up everything that piled up behind it.
    rotate: (ticks) => {
      scrollAccum += ticks;
      return drainScroll();
    },
    press: async () => {
      // Press = back to the newest message. The way out of a long scroll-back.
      scrollAccum = 0;
      const res = await ps("scroll-bottom");
      if (!res.startsWith('ERROR')) {
        scrollPct = 100;
        renderDials();
      }
    },
  },

  /** Legacy: blind Up/Down at the focused pane. Kept for terminal Claude Code. */
  diff: {
    title: 'Keys',
    value: () => '↕',
    rotate: (ticks) => sendKeys(ticks > 0 ? 'DOWN' : 'UP', Math.abs(ticks)),
    press: () => sendKeys('ENTER'),
  },
};

let scrollPct = null;
/** Ticks banked while a scroll call is in flight. See the `scroll` dial. */
let scrollAccum = 0;
let scrollBusy = false;

/** Apply banked scroll ticks, one call at a time, until the bank is empty. */
async function drainScroll() {
  if (scrollBusy) return; // the in-flight call will take what we just banked
  scrollBusy = true;
  try {
    while (scrollAccum !== 0) {
      const n = scrollAccum;
      scrollAccum = 0;
      const res = await ps(`scroll ${n}`);
      if (res.startsWith('ERROR')) {
        log(`dial scroll: ${res}`);
        return;
      }
      scrollPct = Math.round(parseFloat(res));
      renderDials();
    }
  } finally {
    scrollBusy = false;
  }
}

const shortCwd = (p) => (p ? p.split(/[\\/]/).filter(Boolean).pop() : '');

// ── key handlers ────────────────────────────────────────────────────────────

client.on('keyDown', ({ action, context, payload }) => {
  const settings = payload?.settings ?? {};
  try {
    switch (action) {
      case A.approve:
        if (!deck.resolvePending('allow')) client.showAlert(context);
        else client.showOk(context);
        break;

      case A.deny:
        if (!deck.resolvePending('deny', settings.reason || 'rejected on the deck'))
          client.showAlert(context);
        else client.showOk(context);
        break;

      case A.interrupt:
        // If something is waiting, denying IS the interrupt — that unblocks the
        // hook immediately instead of leaving Claude Code stuck on our promise.
        if (deck.pending) deck.resolvePending('deny', 'interrupted from the deck');
        else sendKeys('Escape', 1);
        deck.setState(State.IDLE, { force: true });
        break;

      case A.status:
        // Doubles as SEND. It sits between APPROVE and DENY where your eye
        // already is, and it's where dictation ends: speak, glance, press.
        submitComposer(context);
        break;

      case A.usage:
        openUsage(context);
        break;

      case A.keycap:
        runKeycap(context, settings);
        break;

      case A.act:
        runAct(context, settings);
        break;

      case A.voice:
        toggleVoice(context).catch((err) => {
          log(`voice failed: ${err.stack}`);
          client.showAlert(context);
        });
        break;

      case A.dispatch:
        dispatch(context, settings);
        break;

      case A.send:
        submitComposer(context);
        break;

      case A.session:
        deck.emit('render');
        break;
    }
  } catch (err) {
    log(`keyDown ${action} failed: ${err.stack}`);
    client.showAlert(context);
  }
});

client.on('dialRotate', ({ context, payload }) => {
  const ctx = client.contexts.get(context);
  const name = ctx?.settings?.mode ?? 'menu';
  const ticks = payload?.ticks ?? 0;
  // Log every tick: without this a knob that does nothing is indistinguishable
  // from a knob whose event never arrived, and they need very different fixes.
  log(`dial ${name} rotate ${ticks > 0 ? '+' : ''}${ticks}`);
  Promise.resolve(DIAL_MODES[name]?.rotate?.(ticks)).catch((err) =>
    log(`dial ${name} rotate failed: ${err.stack}`),
  );
});

/**
 * Double-press, not long-press.
 *
 * A long press is IMPOSSIBLE on this hardware. Measured on a deliberate
 * five-second hold:
 *
 *     16:57:35.959  dialDown
 *     16:57:35.986  dialUp      <- 27ms later
 *
 * The AKP03 driver reports an encoder press as one instantaneous click however
 * long you hold it. There is no dialLongPress event and dialRotate always says
 * `pressed: false`, so hold duration is discarded below OpenDeck and never
 * reaches us. Individual presses, though, are discrete and reliable — so the
 * second action hangs off a double-press instead.
 *
 * The cost: a dial with a double action must wait DOUBLE_MS before acting on a
 * single press, or the first press of a double would fire the single action too.
 */
const DOUBLE_MS = 400;
const dialTap = new Map(); // context -> { timer, count }

client.on('dialDown', ({ context }) => {
  const ctx = client.contexts.get(context);
  const name = ctx?.settings?.mode ?? 'menu';
  const mode = DIAL_MODES[name];

  if (!mode?.doublePress) {
    // No second action here: fire at once. Waiting would add lag for nothing.
    log(`dial ${name} press`);
    Promise.resolve(mode?.press?.()).catch((err) => log(`dial ${name} press failed: ${err.stack}`));
    return;
  }

  const entry = dialTap.get(context) ?? { count: 0 };
  entry.count++;
  clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    const n = entry.count;
    dialTap.delete(context);
    const fn = n >= 2 ? mode.doublePress : mode.press;
    log(`dial ${name} ${n >= 2 ? 'double' : 'single'} press`);
    Promise.resolve(fn?.()).catch((err) => log(`dial ${name} press failed: ${err.stack}`));
  }, DOUBLE_MS);
  dialTap.set(context, entry);
});

client.on('appeared', (ctx) => {
  render();
  // Populate a menu dial's readout so it shows the current model/mode/effort
  // straight away instead of an em-dash until first use.
  const mode = ctx?.settings?.mode;
  if (mode && mode in menuLabels) {
    refreshMenuLabel(mode).catch((err) => log(`label refresh failed: ${err.message}`));
  }
});

// The host going away is our cue to die. OpenDeck does not reap plugin
// processes when it is killed, and an orphan still holds the hook port — so the
// NEXT launch fails with EADDRINUSE and the deck stays dark, while /status
// answers from the zombie and looks healthy. Exit instead.
client.on('closed', () => {
  log('host disconnected — exiting so the port is free for the next launch');
  stopVoicePolling();
  host.proc?.kill();
  deck.resolvePending('defer', 'agent-deck lost its host');
  hooks.close().finally(() => process.exit(0));
});

// ── actions ─────────────────────────────────────────────────────────────────

/** Fire a prompt at a fresh headless Claude Code run. */
function dispatch(context, settings) {
  const prompt = settings.prompt?.trim();
  if (!prompt) {
    log('dispatch pressed with no prompt configured');
    return client.showAlert(context);
  }
  // One dispatch at a time. Each press used to spawn another headless run, and
  // three impatient taps meant three agents all fighting for the deck's single
  // pending slot — they superseded each other into deferral and hung around as
  // zombies. The deck cannot arbitrate a crowd.
  if (dispatchProc) {
    log('dispatch already running; ignoring press');
    return client.showAlert(context);
  }

  const cwd = settings.cwd || deck.sessions.get(deck.activeSessionId)?.cwd || process.cwd();
  log(`dispatch in ${cwd}: ${prompt}`);
  deck.setState(State.THINKING, { force: true });

  const proc = spawn(
    config.claudeBin,
    // A dispatched run is headless: nobody is watching for its permission
    // prompts, and gating it on this deck deadlocks — the run blocks on a key
    // press that only makes sense for the session you are looking at. Point it
    // at an empty settings file so our own hooks do not apply to it.
    ['-p', prompt, '--settings', '{"hooks":{}}'],
    { cwd, shell: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  dispatchProc = proc;
  let out = '';
  proc.stdout.on('data', (d) => (out += d));
  proc.stderr.on('data', (d) => log(`dispatch stderr: ${d}`));
  proc.on('error', (err) => {
    log(`dispatch spawn failed: ${err.message}`);
    dispatchProc = null;
    deck.setState(State.ERROR, { force: true });
    client.showAlert(context);
    render();
  });
  proc.on('close', (code) => {
    dispatchProc = null;
    deck.lastMessage = out.trim();
    log(`dispatch finished with code ${code}`);
    deck.setState(code === 0 ? State.DONE : State.ERROR, { force: true });
    if (code === 0) client.showOk(context);
    else client.showAlert(context);
    render();
  });
}

/** Ask lib/mic.ps1 to toggle or read Claude Code Desktop's dictation button. */
function mic(action) {
  return new Promise((resolve) => {
    const proc = spawn(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
       '-File', join(HERE, 'lib', 'mic.ps1'), '-Action', action],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    proc.stdout.on('data', (d) => (out += d));
    proc.on('error', (err) => resolve(`ERROR: ${err.message}`));
    proc.on('close', () => resolve(out.trim()));
  });
}

/**
 * Toggle Claude Code's dictation. Claude Code records and transcribes; the deck
 * only works the control.
 *
 * Unlike every other key here, this one shows a REAL state, not a guess: the
 * dictation button exposes a UIA TogglePattern, so we can read back whether it
 * is actually recording. That is also why we poll — Claude stops on its own
 * after ~15s of silence, and without polling the key would sit there lit,
 * lying about a recording that already ended.
 */
async function toggleVoice(context) {
  if (config.voice?.mode === 'local') return toggleLocalVoice(context);

  if (config.voice?.mode === 'cli') {
    // Terminal Claude Code: no UIA surface, just tap the push-to-talk key.
    sendKeysRaw(config.voice.key ?? '{SPACE}');
    voice.recording = !voice.recording;
    client.showOk(context);
    return render();
  }

  const state = await mic('toggle');
  if (state.startsWith('ERROR')) {
    log(`voice: ${state}`);
    voice.recording = false;
    client.showAlert(context);
    return render();
  }

  voice.recording = state === 'On';
  log(`voice toggled -> ${state}`);
  client.showOk(context);
  render();
  voice.recording ? startVoicePolling() : stopVoicePolling();
}

/**
 * Chinese dictation: ffmpeg records, whisper.cpp transcribes, paste.ps1 drops
 * the text in the composer.
 *
 * This exists because Claude Code's built-in dictation is English-only and
 * refuses zh-CN. Everything here is local — no audio leaves the machine.
 *
 * Recording is owned by this process, so unlike "gui" mode the REC state is
 * simply true, not a reading of someone else's control.
 */
async function toggleLocalVoice(context) {
  const v = config.voice;
  for (const k of ['device', 'whisperBin', 'whisperModel']) {
    if (!v?.[k]) {
      log(`voice: config.voice.${k} is not set — see config.example.json`);
      return client.showAlert(context);
    }
  }

  if (voice.recording) return stopLocalRecording(context);

  const wav = join(tmpdir(), `agent-deck-${Date.now()}.wav`);
  // -t caps the file so a forgotten recording can't fill the disk.
  const proc = spawn(
    'ffmpeg',
    ['-hide_banner', '-loglevel', 'error', '-f', 'dshow', '-i', v.device,
     '-ar', '16000', '-ac', '1', '-t', String(v.maxSeconds ?? 120), '-y', wav],
    { stdio: ['pipe', 'ignore', 'pipe'] },
  );
  voice.proc = proc;
  voice.wav = wav;
  voice.recording = true;
  voice.transcribing = false;

  proc.stderr.on('data', (d) => log(`ffmpeg: ${String(d).trim()}`));
  proc.on('error', (err) => {
    log(`voice: ffmpeg failed to start — ${err.message}`);
    voice.recording = false;
    voice.proc = null;
    client.showAlert(context);
    render();
  });

  log(`voice: recording -> ${wav}`);
  client.showOk(context);
  render();
}

async function stopLocalRecording(context) {
  const v = config.voice;
  const proc = voice.proc;
  const wav = voice.wav;
  voice.recording = false;
  voice.transcribing = true;
  voice.proc = null;
  render();

  // 'q' on stdin is ffmpeg's clean shutdown. Killing it instead leaves the WAV
  // header's size fields unwritten and whisper reads an empty file.
  await new Promise((resolve) => {
    if (!proc || proc.exitCode !== null) return resolve();
    proc.once('close', resolve);
    try {
      proc.stdin.write('q');
      proc.stdin.end();
    } catch {
      proc.kill();
    }
    setTimeout(() => {
      if (proc.exitCode === null) proc.kill();
      resolve();
    }, 3000);
  });

  try {
    const text = await transcribe(wav);
    if (!text) {
      log('voice: nothing transcribed');
      client.showAlert(context);
      return;
    }
    log(`voice: transcript = ${text}`);

    const txtFile = join(tmpdir(), `agent-deck-${Date.now()}.txt`);
    writeFileSync(txtFile, text, 'utf8');
    const res = await runPs('paste.ps1', [
      '-TextFile', txtFile,
      ...(v.autoSubmit ? ['-Submit'] : []),
    ]);
    if (res.startsWith('ERROR')) {
      log(`voice: paste failed — ${res}`);
      client.showAlert(context);
    } else {
      // Light SEND: there is now a transcript sitting in the composer, unsent.
      // autoSubmit already sent it, so there is nothing left to arm.
      voice.pendingSend = !v.autoSubmit;
      client.showOk(context);
    }
    rmSync(txtFile, { force: true });
  } catch (err) {
    log(`voice: transcription failed — ${err.message}`);
    client.showAlert(context);
  } finally {
    rmSync(wav, { force: true });
    voice.transcribing = false;
    render();
  }
}

function transcribe(wav) {
  const v = config.voice;
  return new Promise((resolve, reject) => {
    const proc = spawn(
      v.whisperBin,
      ['-m', v.whisperModel, '-f', wav, '-l', v.language ?? 'zh',
       '-nt', '-t', String(v.threads ?? 8)],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    proc.stdout.on('data', (d) => (out += d));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`whisper exited ${code}`));
      // -nt gives bare text, but whisper still emits blank lines and the odd
      // "[BLANK_AUDIO]" marker for silence.
      resolve(
        out.split('\n').map((l) => l.trim())
          .filter((l) => l && !/^\[.*\]$/.test(l))
          .join(' ').trim(),
      );
    });
  });
}

/**
 * Send what's in the composer. The other half of dictation: the transcript
 * lands in the box so you can read it, and this commits it — without your hands
 * leaving the deck.
 */
async function submitComposer(context) {
  const res = await runPs('submit.ps1', []);
  if (res.startsWith('ERROR')) {
    log(`send: ${res}`);
    client.showAlert(context);
  } else {
    log('send: prompt submitted');
    client.showOk(context);
  }
  voice.pendingSend = false;
  render();
}

/**
 * Session actions: cycle the permission mode, fork, archive.
 *
 * `archive` is confirm-on-second-press. It is one menu item away from Delete,
 * a knocked knee can reach a screenless key, and nothing on the device says
 * what just happened. Fork and mode are cheap to undo; this one isn't.
 */
async function runAct(context, settings) {
  const act = settings.act ?? 'mode-cycle';
  if (act === 'mode-cycle') return stepMode(context);
  if (busyKeycaps.has(context)) return;

  if (act === 'archive' && !armedArchive.has(context)) {
    armedArchive.add(context);
    client.showAlert(context); // the device's own "are you sure" flash
    log('archive armed — press again within 3s to confirm');
    setTimeout(() => armedArchive.delete(context), 3000);
    return;
  }
  armedArchive.delete(context);

  busyKeycaps.add(context);
  render();
  try {
    const res = await ps(act);
    if (res.startsWith('ERROR')) {
      log(`act ${act}: ${res}`);
      client.showAlert(context);
    } else {
      log(`act ${act} -> ${res}`);
      if (act === 'mode-cycle') permMode = res;
      client.showOk(context);
    }
  } finally {
    busyKeycaps.delete(context);
    render();
  }
}

/** The five permission modes, in the order Claude's own menu lists them. */
const MODES = ['Manual', 'Accept edits', 'Plan', 'Auto', 'Bypass permissions'];

/**
 * Step the permission mode — press to advance, and it commits once you stop.
 *
 * Doing it in one shot was unusable: the menu opened, chose, and closed faster
 * than you could read, so you never saw what you were cycling towards. Now the
 * first press opens the menu and leaves it open, each press moves the target
 * (shown on the key), and COMMIT_AFTER of quiet lands it. Press three times
 * quickly and you jump three modes, having watched the whole way.
 */
const COMMIT_AFTER = 900;
const modeStep = { target: null, timer: null };

async function stepMode(context) {
  const from = modeStep.target ?? permMode;
  const i = MODES.findIndex((m) => from?.startsWith(m));
  modeStep.target = MODES[(i + 1) % MODES.length]; // -1 wraps to 0: unknown starts over
  render(); // the key shows where you're heading, before anything happens

  clearTimeout(modeStep.timer);
  modeStep.timer = setTimeout(() => commitMode(context), COMMIT_AFTER);

  // Open it once, so you can watch. Cheap to repeat — mode-open is idempotent.
  const res = await ps("mode-open");
  if (res.startsWith('ERROR')) {
    log(`mode: ${res}`);
    clearTimeout(modeStep.timer);
    modeStep.target = null;
    client.showAlert(context);
    render();
  }
}

async function commitMode(context) {
  const target = modeStep.target;
  modeStep.target = null;
  if (!target) return;

  const res = await ps(`mode-set ${target}`);
  if (res.startsWith('ERROR')) {
    log(`mode-set: ${res}`);
    await ps("mode-close").catch(() => {});
    client.showAlert(context);
  } else {
    log(`mode -> ${res}`);
    permMode = res;
    client.showOk(context);
  }
  render();
}

/** Read the permission mode without changing it, so the key can show it. */
async function refreshMode() {
  if (modeStep.target) return; // mid-step: don't fight the user's selection
  const res = await ps("mode");
  if (res.startsWith('ERROR') || res === permMode) return;
  permMode = res;
  render();
}

/**
 * A keycap press: type its prompt into the composer and send it.
 *
 * Deliberately NOT a headless `claude -p` run like DISPATCH. A keycap is a
 * shortcut for something you'd have typed yourself, so it belongs in the
 * conversation you're looking at — you see the answer, and it keeps your
 * context. DISPATCH's fire-and-forget model is what produced three orphaned
 * agents fighting over one deck.
 */
async function runKeycap(context, settings) {
  const prompt = settings.prompt?.trim();
  if (!prompt) {
    log(`keycap '${settings.cap ?? '?'}' pressed with no prompt configured`);
    return client.showAlert(context);
  }
  if (busyKeycaps.has(context)) return; // ignore the double-tap

  busyKeycaps.add(context);
  render();
  try {
    const txtFile = join(tmpdir(), `agent-deck-cap-${Date.now()}.txt`);
    writeFileSync(txtFile, prompt, 'utf8');
    const res = await runPs('paste.ps1', ['-TextFile', txtFile, ...(settings.send === false ? [] : ['-Submit'])]);
    rmSync(txtFile, { force: true });
    if (res.startsWith('ERROR')) {
      log(`keycap: ${res}`);
      client.showAlert(context);
    } else {
      log(`keycap '${settings.cap}' -> ${prompt}`);
      client.showOk(context);
    }
  } finally {
    busyKeycaps.delete(context);
    render();
  }
}

/**
 * Refresh the usage rings. The numbers come off the app's own usage button,
 * whose accessible name is literally "Usage: context 55%, plan 94%" — a readout,
 * not an estimate.
 */
async function refreshUsage() {
  const res = await ps("usage");
  if (res.startsWith('ERROR')) return;
  const [c, p] = res.split(',').map((n) => parseInt(n, 10));
  if (Number.isNaN(c) || Number.isNaN(p)) return;
  if (c === usage.context && p === usage.plan) return; // nothing to redraw
  usage.context = c;
  usage.plan = p;
  render();
}

/** Poll usage slowly: each read costs a PowerShell spawn, and it barely moves. */
function startUsagePolling() {
  clearInterval(usage.timer);
  const tick = () => {
    refreshUsage().catch(() => {});
    // Mode can change from the app's own UI, so read it back on the same beat.
    refreshMode().catch(() => {});
  };
  tick();
  usage.timer = setInterval(tick, 30_000);
}

/** Press the usage key: show Claude's own usage panel, press again to dismiss. */
async function openUsage(context) {
  const res = await ps("usage-toggle");
  if (res.startsWith('ERROR')) {
    log(`usage: ${res}`);
    client.showAlert(context);
  } else {
    client.showOk(context);
    await refreshUsage();
  }
}

/** Run one of our PowerShell helpers and return its last line. */
function runPs(script, args) {
  return new Promise((resolve) => {
    const proc = spawn(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
       '-File', join(HERE, 'lib', script), ...args],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    proc.stdout.on('data', (d) => (out += d));
    proc.stderr.on('data', (d) => log(`${script} stderr: ${String(d).trim()}`));
    proc.on('error', (err) => resolve(`ERROR: ${err.message}`));
    proc.on('close', () => resolve(out.trim().split('\n').pop()?.trim() ?? ''));
  });
}

/**
 * The resident UI Automation host (lib/host.ps1).
 *
 * Spawning a script per command costs ~690ms — 215ms of PowerShell start, 75ms
 * of assembly load, ~400ms walking 600+ elements. A knob emits a tick every
 * ~100ms, so per-spawn scrolling was a slideshow. One long-lived process pays
 * that once: measured 690ms -> 3ms.
 *
 * Commands are queued in order, one line each, replies matched FIFO. It restarts
 * itself if it dies.
 */
const host = {
  proc: null,
  waiters: [],
  buf: '',
  ready: false,
  starting: null,
};

function startHost() {
  if (host.starting) return host.starting;
  host.starting = new Promise((resolve) => {
    const proc = spawn(
      'powershell',
      // Hand it our pid: closing stdin does not end it (ReadLine blocks on a
      // broken pipe), and OpenDeck can only ever force-kill us, so it has to
      // watch for our death itself.
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
       '-File', join(HERE, 'lib', 'host.ps1'), '-ParentPid', String(process.pid)],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    host.proc = proc;
    host.buf = '';
    host.ready = false;

    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      host.buf += chunk;
      let i;
      while ((i = host.buf.indexOf('\n')) >= 0) {
        const line = host.buf.slice(0, i).trim();
        host.buf = host.buf.slice(i + 1);
        if (!host.ready) {
          if (line === 'READY') {
            host.ready = true;
            resolve();
          }
          continue;
        }
        host.waiters.shift()?.(line);
      }
    });
    proc.stderr.on('data', (d) => log(`host stderr: ${String(d).trim()}`));
    proc.on('error', (err) => {
      log(`host failed to start: ${err.message}`);
      host.ready = false;
      resolve();
    });
    proc.on('close', () => {
      log('host exited');
      host.ready = false;
      host.proc = null;
      host.starting = null;
      // Anything still waiting must be answered, or its key hangs forever.
      while (host.waiters.length) host.waiters.shift()('ERROR: host died');
    });
  });
  return host.starting;
}

/** Send one command to the resident host. Starts it on first use. */
async function ps(cmd) {
  if (!host.ready) await startHost();
  if (!host.proc || !host.ready) return 'ERROR: host unavailable';
  return new Promise((resolve) => {
    host.waiters.push(resolve);
    try {
      host.proc.stdin.write(cmd + '\n');
    } catch (err) {
      host.waiters.pop();
      resolve(`ERROR: ${err.message}`);
    }
  });
}

/** Watch for Claude ending the recording on its own (silence timeout). */
function startVoicePolling() {
  stopVoicePolling();
  voice.timer = setInterval(async () => {
    const state = await mic('state');
    const on = state === 'On';
    if (on === voice.recording) return;
    voice.recording = on;
    log(`voice stopped on its own (${state})`);
    render();
    if (!on) stopVoicePolling();
  }, 2000);
}

function stopVoicePolling() {
  clearInterval(voice.timer);
  voice.timer = null;
}

/**
 * Send an already-escaped SendKeys string verbatim (e.g. "{SPACE}", "^+v").
 * Best-effort: we cannot know which window has focus, so this goes wherever the
 * user last clicked. Keep the terminal focused.
 */
function sendKeysRaw(keys, times = 1) {
  const escaped = keys.replace(/'/g, "''");
  const script = `$w=New-Object -ComObject WScript.Shell; 1..${times} | %{ $w.SendKeys('${escaped}') }`;
  spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    stdio: 'ignore',
  }).on('error', (err) => log(`sendKeys failed: ${err.message}`));
}

/** Convenience for bare key names: sendKeys('Down') -> "{Down}". */
function sendKeys(key, times = 1) {
  sendKeysRaw(`{${key}}`, times);
}

// ── boot ────────────────────────────────────────────────────────────────────

const hooks = new HookServer({
  deck,
  isDeviceReady: () => client.ready && client.contexts.size > 0,
  log,
  port: config.port,
  approvalTimeoutMs: config.approvalTimeoutMs,
  gateTools: config.gateTools,
});

/**
 * End a previous copy of this plugin that is still holding our port.
 *
 * Reinstalling from a file starts the new plugin process before OpenDeck has
 * stopped the old one — and OpenDeck never closes the old WebSocket, so the old
 * process has no idea it has been replaced. The new one dies on EADDRINUSE while
 * the old one keeps the port and keeps answering /status. The deck looks alive
 * and is running code OpenDeck no longer even lists as registered: an update
 * that silently doesn't apply.
 *
 * So the newest instance wins — it is the one OpenDeck just launched. Only a
 * process whose command line is this same plugin.js is ever touched; anything
 * else holding the port (WSL's relay, say) is reported, not killed.
 *
 * @returns {Promise<boolean>} whether something was evicted
 */
function evictStaleInstance(port) {
  return new Promise((resolve) => {
    const ps = `
$c = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $c) { exit 0 }
$p = Get-CimInstance Win32_Process -Filter "ProcessId = $($c.OwningProcess)" -ErrorAction SilentlyContinue
if (-not $p) { exit 0 }
if ($p.ProcessId -eq ${process.pid}) { exit 0 }
if ($p.CommandLine -like '*com.hovell.agentdeck*plugin.js*') {
  Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
  Write-Output "EVICTED $($p.ProcessId)"
} else {
  Write-Output "FOREIGN $($p.ProcessId) $($p.Name)"
}`;
    let out = '';
    const proc = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    proc.stdout.on('data', (d) => (out += d));
    proc.on('error', () => resolve(false));
    proc.on('close', () => {
      const m = out.trim();
      if (m.startsWith('EVICTED')) {
        log(`port ${port} was held by a previous instance (${m.split(' ')[1]}); it has been replaced`);
        resolve(true);
      } else {
        if (m.startsWith('FOREIGN')) log(`port ${port} is held by ${m.slice(8)} — not ours, leaving it alone`);
        resolve(false);
      }
    });
  });
}

async function main() {
  log(`agent-deck starting (pid ${process.pid})`);
  try {
    await hooks.listen();
  } catch (err) {
    if (err.code !== 'EADDRINUSE') throw err;

    // Most likely a stale copy of ourselves after a reinstall. Take the port back.
    if (await evictStaleInstance(config.port)) {
      await sleep(600); // let Windows release the socket
      try {
        await hooks.listen();
      } catch (again) {
        log(`FATAL: port ${config.port} still busy after evicting the old instance: ${again.code}`);
        process.exit(1);
      }
    } else {
      // Worth spelling out: the deck goes dead with no on-device symptom, and
      // the port may well be some unrelated process (WSL's relay squats on 8787).
      log(
        `FATAL: port ${config.port} is already in use by something that isn't us.\n` +
          `  Find it with:\n` +
          `    Get-NetTCPConnection -LocalPort ${config.port} -State Listen | ` +
          `ForEach-Object { Get-Process -Id $_.OwningProcess }\n` +
          `  Then either free it, or set a different "port" in config.json\n` +
          `  AND update the hook URLs in .claude/settings.json to match.`,
      );
      process.exit(1);
    }
  }
  // Before the first paint: the VOICE key's face depends on the resolved mode.
  await resolveVoice();
  await client.connect();
  render();
  // Warm the UIA host now: its first command pays a ~400ms tree walk, and that
  // should not land on the user's first knob turn.
  startHost().then(() => ps('scroll-pct')).catch(() => {});
  startUsagePolling();
  log(`ready — voice=${config.voice.mode}, gating ${[...hooks.gateTools].join(', ')}`);
}

main().catch((err) => {
  log(`fatal: ${err.stack}`);
  process.exit(1);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    log(`shutting down on ${sig}`);
    stopVoicePolling(); // an open interval would keep the loop alive
    clearInterval(usage.timer);
    host.proc?.kill();
    deck.resolvePending('defer', 'agent-deck shutting down');
    await hooks.close().catch(() => {});
    process.exit(0);
  });
}

process.on('uncaughtException', (err) => {
  log(`uncaught: ${err.stack}`);
  // Never leave Claude Code blocked on a promise we can no longer resolve.
  deck.resolvePending('defer', 'agent-deck crashed');
});
