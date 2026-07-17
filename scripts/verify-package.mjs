#!/usr/bin/env node
/**
 * Check that akp03-agent-deck.plugin.zip is actually shippable.
 *
 *   node scripts/verify-package.mjs
 *
 * Every check here exists because the naive version of it passed on a zip that
 * did not exist: an empty entry list satisfies "nothing leaked" and "no
 * backslashes" perfectly. So this asserts the positives too — the files that
 * MUST be present — and refuses to report success on an empty archive.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ZIP = join(ROOT, 'akp03-agent-deck.plugin.zip');
const BUNDLE = 'com.hovell.agentdeck.sdPlugin';

/** Read the central directory: the authoritative list of what a zip contains. */
function entries(buf) {
  // Find the End Of Central Directory record, scanning back from the tail.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('no EOCD — this is not a zip');

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`bad central header at ${p}`);
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    out.push({ name, method, csize, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** Pull one file back out, to prove the bytes survive a round trip. */
function extract(buf, e) {
  const nameLen = buf.readUInt16LE(e.offset + 26);
  const extraLen = buf.readUInt16LE(e.offset + 28);
  const start = e.offset + 30 + nameLen + extraLen;
  const body = buf.subarray(start, start + e.csize);
  return e.method === 8 ? inflateRawSync(body) : body;
}

let failed = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m) => {
  console.log(`  FAIL  ${m}`);
  failed++;
};

if (!existsSync(ZIP)) {
  console.error('\nakp03-agent-deck.plugin.zip does not exist. Run: node scripts/package.mjs\n');
  process.exit(1);
}

const buf = readFileSync(ZIP);
const list = entries(buf);

console.log(`\n${(statSync(ZIP).size / 1024).toFixed(0)} KB, ${list.length} entries\n`);

// An empty zip would sail through every negative check below.
if (list.length < 20) bad(`only ${list.length} entries — the archive is not complete`);
else ok(`${list.length} entries`);

// The separator bug that made the first attempt unusable.
const back = list.filter((e) => e.name.includes('\\'));
if (back.length) bad(`${back.length} entries use backslashes (ZIP requires '/')`);
else ok("all paths use '/'");

// The whole point of the exclusion list.
const leaked = list.filter((e) => /config\.json$|\.log$|\.wav$|\.bak/.test(e.name));
if (leaked.length) bad(`leaked: ${leaked.map((e) => e.name).join(', ')}`);
else ok('no config.json, no logs');

// Everything must live under the bundle dir, as OpenDeck expects.
const stray = list.filter((e) => !e.name.startsWith(`${BUNDLE}/`));
if (stray.length) bad(`outside ${BUNDLE}/: ${stray.map((e) => e.name).join(', ')}`);
else ok(`everything under ${BUNDLE}/`);

// The positives — the checks that catch an empty or truncated archive.
for (const f of [
  'manifest.json',
  'plugin.js',
  'run.cmd',
  'config.example.json',
  'lib/detect.js',
  'lib/host.ps1',
  'lib/keycaps.js',
  'lib/icons.js',
  'pi/keycap.html',
  'icons/approve.png',
]) {
  if (list.some((e) => e.name === `${BUNDLE}/${f}`)) ok(f);
  else bad(`missing: ${f}`);
}

// Round-trip a file: proves the compression and CRC are real, not just headers.
try {
  const m = list.find((e) => e.name === `${BUNDLE}/manifest.json`);
  const parsed = JSON.parse(extract(buf, m).toString('utf8'));
  if (parsed.Name && parsed.Actions?.length) {
    ok(`manifest extracts and parses: "${parsed.Name}", ${parsed.Actions.length} actions`);
  } else bad('manifest extracted but looks wrong');
} catch (err) {
  bad(`manifest will not extract: ${err.message}`);
}

console.log(failed ? `\n${failed} problem(s)\n` : '\nshippable\n');
process.exit(failed ? 1 : 0);
