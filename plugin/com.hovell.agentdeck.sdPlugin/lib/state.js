import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

/** Agent lifecycle states. Drives what every key renders. */
export const State = {
  IDLE: 'idle',
  THINKING: 'thinking',
  AWAITING: 'awaiting_approval',
  DONE: 'done',
  ERROR: 'error',
};

/**
 * The brain. Holds agent state, the pending approval, and the session list.
 * Knows nothing about OpenDeck or HTTP — both of those drive it from outside,
 * which is what lets dev-console.mjs exercise the whole loop with no hardware.
 */
export class AgentDeck extends EventEmitter {
  constructor({ log = () => {} } = {}) {
    super();
    this.log = log;
    this.state = State.IDLE;
    /** @type {null | {id, toolName, toolInput, sessionId, cwd, resolve, at}} */
    this.pending = null;
    /** @type {Map<string, {id, cwd, state, lastMessage, at}>} */
    this.sessions = new Map();
    this.activeSessionId = null;
    this.lastMessage = '';
    this.dialIndex = 0;
  }

  setState(next, detail = {}) {
    if (this.state === next && !detail.force) return;
    this.state = next;
    this.emit('state', next, detail);
    this.emit('render');
  }

  touchSession(sessionId, patch = {}) {
    if (!sessionId) return null;
    const prev = this.sessions.get(sessionId) ?? { id: sessionId, cwd: '', state: State.IDLE };
    const next = { ...prev, ...patch, at: Date.now() };
    this.sessions.set(sessionId, next);
    this.activeSessionId = sessionId;
    this.emit('render');
    return next;
  }

  /**
   * Called by the PreToolUse hook. Resolves only when a physical key is pressed
   * or the caller times out. The HTTP layer is responsible for the timeout —
   * this promise itself never self-cancels.
   */
  requestApproval({ toolName, toolInput, sessionId, cwd }) {
    // A second request while one is pending means the first is stale; defer it
    // so Claude Code falls back to its own prompt rather than hanging.
    if (this.pending) this.resolvePending('defer', 'superseded by a newer tool call');

    return new Promise((resolve) => {
      this.pending = {
        id: randomUUID(),
        toolName,
        toolInput,
        sessionId,
        cwd,
        resolve,
        at: Date.now(),
      };
      // setState first: touchSession also renders, and doing it the other way
      // round paints one frame with the pending call but the previous state —
      // a visible wrong-state flash on the key as it lights up.
      this.setState(State.AWAITING, { force: true });
      this.touchSession(sessionId, { cwd, state: State.AWAITING });
      this.log(`awaiting approval: ${toolName} ${summarize(toolInput)}`);
      this.emit('pending', this.pending);
    });
  }

  /** @param {'allow'|'deny'|'defer'} decision */
  resolvePending(decision, reason = '') {
    if (!this.pending) return false;
    const p = this.pending;
    this.pending = null;
    this.log(`approval resolved: ${decision} (${p.toolName})`);
    p.resolve({ decision, reason });
    this.setState(decision === 'allow' ? State.THINKING : State.IDLE, { force: true });
    this.emit('resolved', { ...p, decision });
    return true;
  }

  get pendingLabel() {
    if (!this.pending) return '';
    return `${this.pending.toolName}\n${summarize(this.pending.toolInput, 18)}`;
  }
}

/** Squeeze a tool_input object into something readable on a 72px key. */
export function summarize(toolInput, max = 40) {
  if (!toolInput) return '';
  const raw =
    toolInput.command ??
    toolInput.file_path ??
    toolInput.pattern ??
    toolInput.url ??
    toolInput.prompt ??
    JSON.stringify(toolInput);
  const flat = String(raw).replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
}
