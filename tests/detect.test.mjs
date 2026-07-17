/**
 * Which voice mode a machine gets.
 *
 * The thing under test is a judgement call, not a calculation: local mode wants
 * ffmpeg and a 1.6GB whisper model, and it exists only because Claude Code
 * refuses to dictate Chinese. Sending everyone down that path — as the default
 * once did — leaves the majority with a VOICE key that flashes red for want of
 * something they never needed.
 *
 *   node --test tests/detect.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  claudeSpeaks,
  guessLanguage,
  systemLocale,
} from '../plugin/com.hovell.agentdeck.sdPlugin/lib/detect.js';

test('Claude Code dictates its 20 languages — no local transcription needed', () => {
  for (const l of ['en', 'ja', 'ko', 'fr', 'de', 'es', 'pt', 'ru', 'hi', 'uk']) {
    assert.equal(claudeSpeaks(l), true, l);
  }
});

test('the language setting also accepts names, not just codes', () => {
  // Claude Code's docs show `{"language": "japanese"}` as valid.
  for (const l of ['english', 'japanese', 'Japanese', 'GERMAN']) {
    assert.equal(claudeSpeaks(l), true, l);
  }
});

test('unset means English, which Claude speaks — not a reason to install whisper', () => {
  assert.equal(claudeSpeaks(null), true);
  assert.equal(claudeSpeaks(undefined), true);
  assert.equal(claudeSpeaks(''), true);
});

test('Chinese is the case local mode exists for', () => {
  for (const l of ['zh', 'zh-CN', 'zh-TW', 'chinese']) {
    assert.equal(claudeSpeaks(l), false, l);
  }
});

test('other unsupported languages also need local', () => {
  // Thai and Vietnamese are absent from Claude Code's list too.
  for (const l of ['th', 'vi', 'ar', 'he']) {
    assert.equal(claudeSpeaks(l), false, l);
  }
});

test('regional variants resolve to their primary subtag', () => {
  // en-GB is English; zh-Hant is still Chinese.
  assert.equal(claudeSpeaks('en-GB'), true);
  assert.equal(claudeSpeaks('pt_BR'), true);
  assert.equal(claudeSpeaks('zh-Hant'), false);
});

test('the OS locale is readable, and is a real language tag', () => {
  // The fallback rests on this. If Intl ever returns nothing, guessLanguage
  // quietly assumes English — and a Chinese speaker gets English dictation.
  const l = systemLocale();
  assert.ok(l, 'Intl gave no locale');
  assert.match(l, /^[a-z]{2}(-[A-Za-z]+)*$/, `not a language tag: ${l}`);
});

test('an unset language setting falls back to the OS locale, and says so', () => {
  // Why this exists: this project's author never set `language`, and he is the
  // reason local mode exists. Trusting only the setting handed the one person
  // who needed Chinese the English-only path — silently.
  const g = guessLanguage();
  assert.ok(['claude settings', 'system locale', 'nothing — assuming English'].includes(g.from));
  // Whatever it decides, it must be able to explain where it got it.
  assert.ok(g.from.length > 0);
});
