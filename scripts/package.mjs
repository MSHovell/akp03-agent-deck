#!/usr/bin/env node
/**
 * Build the distributable plugin: akp03-agent-deck.plugin.zip
 *
 * The format is whatever OpenDeck's "Install from file" accepts, which I settled
 * by unzipping opendeck-akp03's release rather than reading a spec: a zip whose
 * root holds the `<bundle-id>.sdPlugin` directory. Nothing else.
 *
 *   node scripts/package.mjs
 *
 * The exclusions matter more than the zipping. config.json is machine-specific —
 * shipping one would hand every user this machine's microphone GUID and whisper
 * paths, and the plugin would trust them over its own detection. The logs carry
 * voice transcripts.
 *
 * The zip is written here rather than by PowerShell's Compress-Archive, which on
 * Windows PowerShell 5.1 writes BACKSLASHES as the in-archive separator. The ZIP
 * spec says forward slashes, and opendeck-akp03's own release uses them; a
 * backslash archive reads as one long filename instead of a directory tree.
 * Node has zlib but no zip container, so the container is assembled below — the
 * same trade this project already made for PNG encoding.
 */
import { deflateRawSync } from 'node:zlib';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const BUNDLE = 'com.hovell.agentdeck.sdPlugin';
const SRC = join(ROOT, 'plugin', BUNDLE);
const OUT = join(ROOT, 'akp03-agent-deck.plugin.zip');

/**
 * Never ship these.
 *
 * Deliberately the same list as .gitignore's, for the same reasons — if the two
 * ever disagree, one of them is leaking. Spelled out here rather than parsed from
 * .gitignore, because a silent parse failure would ship the lot.
 */
const EXCLUDE = new Set([
  'config.json', // this machine's mic GUID + whisper paths; detection writes it
  'agent-deck.log', // voice transcripts, in plaintext
]);
const EXCLUDE_EXT = ['.log', '.wav', '.bak'];
const shouldSkip = (name) => EXCLUDE.has(name) || EXCLUDE_EXT.some((e) => name.endsWith(e));

// ── zip ─────────────────────────────────────────────────────────────────────

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** MS-DOS time/date, which is what ZIP stores. Two-second resolution. */
function dosTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

/** @param {{name: string, data: Buffer}[]} files  names use '/' */
function makeZip(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  const { time, date } = dosTime(new Date());

  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const crc = crc32(f.data);
    const deflated = deflateRawSync(f.data, { level: 9 });
    // Only compress when it actually helps; tiny files can grow.
    const useDeflate = deflated.length < f.data.length;
    const body = useDeflate ? deflated : f.data;
    const method = useDeflate ? 8 : 0;

    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0); // local file header signature
    lfh.writeUInt16LE(20, 4); // version needed
    lfh.writeUInt16LE(0x0800, 6); // flags: bit 11 = names are UTF-8
    lfh.writeUInt16LE(method, 8);
    lfh.writeUInt16LE(time, 10);
    lfh.writeUInt16LE(date, 12);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(body.length, 18);
    lfh.writeUInt32LE(f.data.length, 22);
    lfh.writeUInt16LE(name.length, 26);
    lfh.writeUInt16LE(0, 28); // extra len
    locals.push(lfh, name, body);

    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0); // central directory signature
    cdh.writeUInt16LE(20, 4); // version made by
    cdh.writeUInt16LE(20, 6); // version needed
    cdh.writeUInt16LE(0x0800, 8);
    cdh.writeUInt16LE(method, 10);
    cdh.writeUInt16LE(time, 12);
    cdh.writeUInt16LE(date, 14);
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(body.length, 20);
    cdh.writeUInt32LE(f.data.length, 24);
    cdh.writeUInt16LE(name.length, 28);
    cdh.writeUInt16LE(0, 30); // extra
    cdh.writeUInt16LE(0, 32); // comment
    cdh.writeUInt16LE(0, 34); // disk number
    cdh.writeUInt16LE(0, 36); // internal attrs
    // >>> 0 because JS's << is a 32-bit SIGNED shift: 0o100644 << 16 overflows
    // straight to negative, and writeUInt32LE rejects it.
    cdh.writeUInt32LE((0o100644 << 16) >>> 0, 38); // external attrs: regular file, 0644
    cdh.writeUInt32LE(offset, 42);
    central.push(cdh, name);

    offset += lfh.length + name.length + body.length;
  }

  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // end of central directory
  eocd.writeUInt16LE(0, 4); // this disk
  eocd.writeUInt16LE(0, 6); // disk with cd
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...locals, cd, eocd]);
}

// ── collect ─────────────────────────────────────────────────────────────────

const files = [];
const skipped = new Set();

(function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (shouldSkip(e.name)) {
      skipped.add(e.name);
      continue;
    }
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else {
      // Forward slashes, always — see the header comment.
      const name = `${BUNDLE}/${relative(SRC, p).replace(/\\/g, '/')}`;
      files.push({ name, data: readFileSync(p) });
    }
  }
})(SRC);

// Prove the exclusions took, rather than trusting the filter. A leaked
// config.json is the whole reason this script exists.
const leaked = files.filter((f) => shouldSkip(f.name.split('/').pop()));
if (leaked.length) {
  console.error('REFUSING to package — these should have been excluded:');
  for (const l of leaked) console.error('  ' + l.name);
  process.exit(1);
}

rmSync(OUT, { force: true });
writeFileSync(OUT, makeZip(files));

const kb = (statSync(OUT).size / 1024).toFixed(0);
console.log(`\n  akp03-agent-deck.plugin.zip  (${kb} KB, ${files.length} files)`);
if (skipped.size) console.log(`  excluded: ${[...skipped].join(', ')}`);
console.log('\n  Install in OpenDeck via Plugins → Install from file.');
