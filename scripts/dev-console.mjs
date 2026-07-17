#!/usr/bin/env node
/**
 * The AKP03 as a terminal. Runs the real AgentDeck + HookServer with your
 * keyboard standing in for the deck's keys, so the whole approve/deny loop is
 * testable before OpenDeck or the hardware are in the picture.
 *
 *   node scripts/dev-console.mjs
 *
 * Then point Claude Code's hooks at http://127.0.0.1:8787 (see claude/settings.hooks.json)
 * and run something that trips a Bash call. The prompt shows up here.
 *
 * Keys:  a = approve   d = deny   i = interrupt   s = status   q = quit
 */
import { emitKeypressEvents } from 'node:readline';
import { AgentDeck, summarize } from '../plugin/com.hovell.agentdeck.sdPlugin/lib/state.js';
import { HookServer } from '../plugin/com.hovell.agentdeck.sdPlugin/lib/hookserver.js';

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  blue: (s) => `\x1b[34m${s}\x1b[0m`,
};

const STATE_STYLE = {
  idle: C.dim,
  thinking: C.blue,
  awaiting_approval: C.yellow,
  done: C.green,
  error: C.red,
};

const deck = new AgentDeck({ log: (m) => console.log(C.dim(`  · ${m}`)) });

// The console IS the device, so it is always "ready" — that keeps the
// hookserver's defer-when-disconnected guard from short-circuiting the test.
const hooks = new HookServer({
  deck,
  isDeviceReady: () => true,
  log: (m) => console.log(C.dim(`  · ${m}`)),
  // 9317, matching the plugin and the hook URLs. NOT 8787: WSL's port relay
  // squats on that one, which this project already learned the hard way.
  port: Number(process.env.AGENT_DECK_PORT ?? 9317),
});

function paint() {
  const style = STATE_STYLE[deck.state] ?? ((s) => s);
  const bar = style(`● ${deck.state.toUpperCase()}`);
  let line = `\n  ${bar}`;
  if (deck.pending) {
    line += `\n  ${C.bold(deck.pending.toolName)}  ${C.dim(summarize(deck.pending.toolInput, 60))}`;
    line += `\n  ${C.green('[a] approve')}   ${C.red('[d] deny')}   ${C.dim('[i] interrupt')}`;
  }
  if (deck.sessions.size) {
    const s = [...deck.sessions.values()].map((x) => `${x.cwd?.split(/[\\/]/).pop() ?? x.id.slice(0, 6)}:${x.state}`);
    line += `\n  ${C.dim(`sessions: ${s.join('  ')}`)}`;
  }
  console.log(line);
}

deck.on('render', paint);

emitKeypressEvents(process.stdin);
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.on('keypress', (_str, k) => {
  switch (k.name) {
    case 'a':
      if (!deck.resolvePending('allow')) console.log(C.dim('  nothing pending'));
      break;
    case 'd':
      if (!deck.resolvePending('deny', 'rejected at the dev console')) console.log(C.dim('  nothing pending'));
      break;
    case 'i':
      deck.resolvePending('deny', 'interrupted');
      deck.setState('idle', { force: true });
      break;
    case 's':
      paint();
      break;
    case 'q':
    case 'c':
      if (k.name === 'c' && !k.ctrl) break;
      console.log('\nbye');
      process.exit(0);
  }
});

await hooks.listen();
console.log(C.bold('\n  agent-deck dev console') + C.dim('  — your keyboard is the AKP03'));
console.log(C.dim(`  hooks: http://127.0.0.1:${hooks.port}   keys: a/d/i/s/q\n`));
paint();
