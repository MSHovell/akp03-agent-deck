/**
 * Work out, on this machine, how the VOICE key should behave.
 *
 * This exists because the plugin ships through a store: whoever installs it
 * never sees install.ps1, so anything machine-specific has to be discovered
 * here or the key is simply dead with nothing to explain why.
 *
 * The important decision is the voice mode, and it hinges on one fact:
 * Claude Code's own dictation supports 20 languages and Chinese is not among
 * them. So a Chinese speaker needs local transcription (ffmpeg + whisper.cpp,
 * ~1.6GB of model); everyone else needs nothing at all. Defaulting everyone to
 * the Chinese path would leave the majority pressing a key that flashes red.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Languages Claude Code can dictate, per its docs — as BCP 47 codes and as the
 * names the `language` setting also accepts. Chinese, Thai and Vietnamese are
 * deliberately absent: that absence is the whole reason `local` mode exists.
 */
const CLAUDE_DICTATION = new Map([
  ['cs', 'czech'], ['da', 'danish'], ['nl', 'dutch'], ['en', 'english'],
  ['fr', 'french'], ['de', 'german'], ['el', 'greek'], ['hi', 'hindi'],
  ['id', 'indonesian'], ['it', 'italian'], ['ja', 'japanese'], ['ko', 'korean'],
  ['no', 'norwegian'], ['pl', 'polish'], ['pt', 'portuguese'], ['ru', 'russian'],
  ['es', 'spanish'], ['sv', 'swedish'], ['tr', 'turkish'], ['uk', 'ukrainian'],
]);

const SUPPORTED = new Set([...CLAUDE_DICTATION.keys(), ...CLAUDE_DICTATION.values()]);

/** Claude Code's `language` setting, or null if unset. */
export function claudeLanguage() {
  for (const f of ['settings.json', 'settings.local.json']) {
    try {
      const raw = readFileSync(join(homedir(), '.claude', f), 'utf8');
      const j = JSON.parse(raw.replace(/^﻿/, ''));
      if (j.language) return String(j.language).trim();
    } catch {
      /* absent or unreadable: fall through to the next */
    }
  }
  return null;
}

/** The OS locale, e.g. "zh-TW" or "en-US". */
export function systemLocale() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale || null;
  } catch {
    return null;
  }
}

/**
 * What language this person most likely speaks, and how we know.
 *
 * Claude Code's `language` setting is the explicit answer, but almost nobody
 * sets it — this project's own author hadn't, and he is the reason local mode
 * exists. Trusting only that setting handed a Chinese speaker the English-only
 * path, silently.
 *
 * So fall back to the OS locale, which is right far more often than "unset
 * means English" is.
 */
export function guessLanguage() {
  const explicit = claudeLanguage();
  if (explicit) return { language: explicit, from: 'claude settings' };

  const locale = systemLocale();
  if (locale) return { language: locale, from: 'system locale' };

  return { language: null, from: 'nothing — assuming English' };
}

/**
 * Can Claude Code dictate this language itself?
 *
 * Unset counts as yes: Claude Code falls back to English, which it supports.
 * Only an explicitly unsupported language (zh, th…) needs local transcription.
 */
export function claudeSpeaks(language) {
  if (!language) return true;
  const l = language.toLowerCase();
  if (SUPPORTED.has(l)) return true;
  // "zh-CN" / "en-GB" — match on the primary subtag.
  return SUPPORTED.has(l.split(/[-_]/)[0]);
}

/** An existing whisper.cpp build, or null. */
export function findWhisper() {
  const home = homedir();
  const bins = [
    join(home, 'whisper.cpp', 'build', 'bin', 'Release', 'whisper-cli.exe'),
    join(home, 'whisper.cpp', 'build', 'bin', 'whisper-cli.exe'),
    join(home, 'whisper.cpp', 'whisper-cli.exe'),
  ];
  const bin = bins.find((b) => existsSync(b));
  if (!bin) return null;

  const modelDir = join(home, 'whisper.cpp', 'models');
  let model = null;
  try {
    // Biggest wins: the larger models are markedly better at Chinese, which is
    // the only reason anyone is on this path.
    const best = readdirSync(modelDir)
      .filter((f) => f.startsWith('ggml-') && f.endsWith('.bin'))
      .map((f) => ({ f, size: statSync(join(modelDir, f)).size }))
      .sort((a, b) => b.size - a.size)[0];
    if (best) model = join(modelDir, best.f);
  } catch {
    /* no models dir */
  }
  if (!model) return null;
  return { bin: bin.replace(/\\/g, '/'), model: model.replace(/\\/g, '/') };
}

/**
 * The default microphone as an ffmpeg dshow device string.
 *
 * Returns the @device_cm_ GUID rather than the friendly name: friendly names are
 * routinely non-ASCII (this machine's is 麥克風排列) and get mangled crossing
 * shell boundaries, while the GUID is pure ASCII and stable.
 */
export function findMicDevice(timeoutMs = 8000) {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn('ffmpeg', ['-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'], {
        stdio: ['ignore', 'ignore', 'pipe'],
      });
    } catch {
      return resolve(null);
    }

    // ffmpeg prints the device list to STDERR and exits non-zero. Both are
    // normal here; only the text matters.
    let out = '';
    proc.stderr.on('data', (d) => (out += d));
    proc.on('error', () => resolve(null));

    const timer = setTimeout(() => {
      try { proc.kill(); } catch { /* already gone */ }
      resolve(null);
    }, timeoutMs);

    proc.on('close', () => {
      clearTimeout(timer);
      const lines = out.split(/\r?\n/);
      for (let i = 0; i < lines.length - 1; i++) {
        if (!/\(audio\)/.test(lines[i])) continue;
        const alt = lines[i + 1].match(/Alternative name "([^"]+)"/);
        if (alt) return resolve(`audio=${alt[1]}`);
      }
      resolve(null);
    });
  });
}

/**
 * Decide the whole voice config for this machine.
 *
 * @param {string} declared  the configured mode: 'auto' | 'gui' | 'local' | 'cli'
 * @param {(msg: string) => void} log
 */
export async function detectVoice(declared, log = () => {}) {
  const { language, from } = guessLanguage();
  const native = claudeSpeaks(language);

  if (declared && declared !== 'auto') {
    log(`voice: mode "${declared}" set explicitly; not auto-detecting`);
    if (declared !== 'local') return { mode: declared, language: language ?? 'en' };
  } else if (native) {
    // The common case, and it needs nothing installed.
    log(`voice: ${language ?? 'English'} (${from}) — Claude Code dictates it; using "gui"`);
    return { mode: 'gui', language: language ?? 'en' };
  } else {
    log(`voice: Claude Code cannot dictate ${language} (${from}); trying local transcription`);
  }

  // local: needs both halves, and says which one is missing.
  const whisper = findWhisper();
  const device = await findMicDevice();

  if (!whisper || !device) {
    const missing = [!device && 'no microphone via ffmpeg', !whisper && 'no whisper.cpp build']
      .filter(Boolean)
      .join(' and ');
    log(`voice: cannot use "local" (${missing}) — falling back to "gui"`);
    if (!native) {
      // Worth spelling out: gui will transcribe their speech as English.
      log(
        `voice: WARNING — "gui" dictates in English, so ${language} will come out wrong. ` +
          `Install ffmpeg and whisper.cpp (see the README) for ${language} dictation.`,
      );
    }
    return { mode: 'gui', language: language ?? 'en' };
  }

  log(`voice: using "local" — ${device.slice(0, 40)}…, model ${whisper.model.split('/').pop()}`);
  return {
    mode: 'local',
    device,
    whisperBin: whisper.bin,
    whisperModel: whisper.model,
    language: language ?? 'zh',
  };
}
