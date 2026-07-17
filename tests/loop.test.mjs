/**
 * Contract tests for the approve/deny loop.
 *
 * The thing worth protecting here is not the happy path — it's that every
 * failure mode answers `defer`. A bug that makes this server hang or throw
 * silently blocks a real agent for the full 600s hook timeout.
 *
 *   node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { AgentDeck, State, summarize } from '../plugin/com.hovell.agentdeck.sdPlugin/lib/state.js';
import { HookServer } from '../plugin/com.hovell.agentdeck.sdPlugin/lib/hookserver.js';

let portSeq = 8900;

/** Spin up a server on its own port so tests can run in parallel. */
async function harness({ deviceReady = true, ...opts } = {}) {
  const deck = new AgentDeck();
  const server = new HookServer({
    deck,
    isDeviceReady: () => deviceReady,
    port: portSeq++,
    approvalTimeoutMs: 200,
    ...opts,
  });
  await server.listen();
  const post = async (path, body) => {
    const res = await fetch(`http://127.0.0.1:${server.port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.json();
  };
  return { deck, server, post, close: () => server.close() };
}

const preToolUse = (over = {}) => ({
  session_id: 's1',
  cwd: 'C:\\proj',
  hook_event_name: 'PreToolUse',
  permission_mode: 'default',
  tool_name: 'Bash',
  tool_input: { command: 'npm test' },
  ...over,
});

const decisionOf = (r) => r.hookSpecificOutput?.permissionDecision;

test('approving on the deck allows the tool call', async (t) => {
  const h = await harness();
  t.after(h.close);

  const inflight = h.post('/hook/pretooluse', preToolUse());
  await once(h.deck, 'pending');

  assert.equal(h.deck.state, State.AWAITING);
  assert.equal(h.deck.pending.toolName, 'Bash');

  h.deck.resolvePending('allow');
  const res = await inflight;

  assert.equal(decisionOf(res), 'allow');
  assert.equal(res.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.match(res.hookSpecificOutput.permissionDecisionReason, /AKP03/);
});

test('denying on the deck blocks it and surfaces the reason', async (t) => {
  const h = await harness();
  t.after(h.close);

  const inflight = h.post('/hook/pretooluse', preToolUse());
  await once(h.deck, 'pending');
  h.deck.resolvePending('deny', 'looks destructive');
  const res = await inflight;

  assert.equal(decisionOf(res), 'deny');
  assert.match(res.hookSpecificOutput.permissionDecisionReason, /looks destructive/);
});

test('no key pressed in time defers instead of hanging', async (t) => {
  const h = await harness(); // approvalTimeoutMs: 200
  t.after(h.close);

  const started = Date.now();
  const res = await h.post('/hook/pretooluse', preToolUse());

  assert.equal(decisionOf(res), 'defer');
  assert.ok(Date.now() - started < 2000, 'must not outlive its own timeout');
  assert.equal(h.deck.pending, null, 'stale pending must be cleared');
});

test('an unplugged deck defers rather than gating the agent', async (t) => {
  const h = await harness({ deviceReady: false });
  t.after(h.close);

  const res = await h.post('/hook/pretooluse', preToolUse());
  assert.equal(decisionOf(res), 'defer');
  assert.match(res.hookSpecificOutput.permissionDecisionReason, /not connected/);
});

test('ungated tools pass straight through', async (t) => {
  const h = await harness();
  t.after(h.close);

  const res = await h.post('/hook/pretooluse', preToolUse({ tool_name: 'Read', tool_input: { file_path: 'a.js' } }));
  assert.equal(decisionOf(res), 'defer');
  assert.equal(h.deck.state, State.IDLE, 'must not light the deck');
});

test('the deck stands down in plan and bypassPermissions modes', async (t) => {
  const h = await harness();
  t.after(h.close);

  for (const mode of ['plan', 'bypassPermissions']) {
    const res = await h.post('/hook/pretooluse', preToolUse({ permission_mode: mode }));
    assert.equal(decisionOf(res), 'defer', `mode ${mode}`);
  }
});

test('a newer tool call defers the stale one instead of stranding it', async (t) => {
  const h = await harness();
  t.after(h.close);

  const first = h.post('/hook/pretooluse', preToolUse({ tool_input: { command: 'first' } }));
  await once(h.deck, 'pending');

  const second = h.post('/hook/pretooluse', preToolUse({ tool_input: { command: 'second' } }));
  await once(h.deck, 'pending');

  assert.equal(decisionOf(await first), 'defer', 'the superseded call must not hang');

  h.deck.resolvePending('allow');
  assert.equal(decisionOf(await second), 'allow');
});

test('malformed hook bodies defer instead of throwing', async (t) => {
  const h = await harness();
  t.after(h.close);

  const res = await fetch(`http://127.0.0.1:${h.server.port}/hook/pretooluse`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{ not json',
  });
  assert.equal(res.status, 200, 'a non-200 would be treated as a hook failure');
  assert.equal(decisionOf(await res.json()), 'defer');
});

test('lifecycle hooks drive the status key', async (t) => {
  const h = await harness();
  t.after(h.close);

  await h.post('/hook/userpromptsubmit', { session_id: 's1', cwd: 'C:\\proj' });
  assert.equal(h.deck.state, State.THINKING);

  await h.post('/hook/notification', { session_id: 's1', notification_type: 'permission_prompt' });
  assert.equal(h.deck.state, State.AWAITING);

  await h.post('/hook/notification', { session_id: 's1', notification_type: 'idle_prompt' });
  assert.equal(h.deck.state, State.IDLE);

  await h.post('/hook/stop', { session_id: 's1', cwd: 'C:\\proj', last_assistant_message: 'all done' });
  assert.equal(h.deck.state, State.DONE);
  assert.equal(h.deck.lastMessage, 'all done');
  assert.equal(h.deck.sessions.get('s1').cwd, 'C:\\proj');
});

test('/status reports enough to debug a silent deck', async (t) => {
  const h = await harness();
  t.after(h.close);

  h.post('/hook/pretooluse', preToolUse());
  await once(h.deck, 'pending');

  const res = await (await fetch(`http://127.0.0.1:${h.server.port}/status`)).json();
  assert.equal(res.state, State.AWAITING);
  assert.equal(res.deviceReady, true);
  assert.equal(res.pending.tool, 'Bash');
  h.deck.resolvePending('deny');
});

test('summarize keeps tool input readable on a 72px key', () => {
  assert.equal(summarize({ command: 'npm   test\n--watch' }, 40), 'npm test --watch');
  assert.equal(summarize({ file_path: 'C:\\a\\b.js' }), 'C:\\a\\b.js');
  assert.equal(summarize({ command: 'x'.repeat(80) }, 10).length, 10);
  assert.ok(summarize({ command: 'x'.repeat(80) }, 10).endsWith('…'));
  assert.equal(summarize(null), '');
});

function once(emitter, event) {
  return new Promise((resolve) => emitter.once(event, resolve));
}
