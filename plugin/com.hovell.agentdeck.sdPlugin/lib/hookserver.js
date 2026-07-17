import { createServer } from 'node:http';
import { State } from './state.js';

/**
 * Receives Claude Code hooks over `type: "http"` and turns PreToolUse into a
 * question the AKP03 asks with its keys.
 *
 * SAFETY: every path that isn't a confident allow/deny answers `defer`, which
 * hands the decision back to Claude Code's normal permission prompt. A crashed
 * plugin, an unplugged deck, or a slow human must never strand the agent — the
 * default hook timeout is 600s, and a silent 10-minute hang is far worse than
 * an on-screen prompt.
 */
export class HookServer {
  /**
   * @param {object} o
   * @param {import('./state.js').AgentDeck} o.deck
   * @param {() => boolean} o.isDeviceReady
   * @param {(msg: string) => void} [o.log]
   * @param {number} [o.port]
   * @param {number} [o.approvalTimeoutMs] must stay under the hook's own timeout
   * @param {string[]} [o.gateTools] tool names that require a physical press
   */
  constructor({
    deck,
    isDeviceReady,
    log = () => {},
    port = 9317,
    approvalTimeoutMs = 90_000,
    gateTools = ['Bash', 'Write', 'Edit', 'NotebookEdit'],
  }) {
    this.deck = deck;
    this.isDeviceReady = isDeviceReady;
    this.log = log;
    this.port = port;
    this.approvalTimeoutMs = approvalTimeoutMs;
    this.gateTools = new Set(gateTools);
    this.server = createServer((req, res) => this.#route(req, res));
  }

  /**
   * Retry-safe: each attempt registers exactly one pair of listeners and removes
   * them both on settling. Passing the callback to `listen()` instead adds a
   * 'listening' handler that a failed attempt never takes back, so a later
   * successful bind fires every one it accumulated — and a second `once('error')`
   * would pile up the same way. Callers do retry, after evicting a stale
   * instance from the port.
   */
  listen() {
    return new Promise((resolve, reject) => {
      const onError = (err) => {
        this.server.off('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        this.server.off('error', onError);
        this.log(`hook server on http://127.0.0.1:${this.port}`);
        resolve();
      };
      this.server.once('error', onError);
      this.server.once('listening', onListening);
      // Loopback only. This endpoint decides whether commands run — it must
      // never be reachable from the network.
      this.server.listen(this.port, '127.0.0.1');
    });
  }

  close() {
    return new Promise((r) => this.server.close(r));
  }

  async #route(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');

    if (req.method === 'GET' && url.pathname === '/status') {
      return json(res, 200, {
        state: this.deck.state,
        deviceReady: this.isDeviceReady(),
        pending: this.deck.pending
          ? { tool: this.deck.pending.toolName, waitingMs: Date.now() - this.deck.pending.at }
          : null,
        sessions: [...this.deck.sessions.values()].map(({ id, cwd, state }) => ({ id, cwd, state })),
      });
    }

    if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });

    let body;
    try {
      body = await readJson(req);
    } catch (err) {
      this.log(`bad hook body: ${err.message}`);
      return json(res, 200, defer('agent-deck could not parse the hook payload'));
    }

    try {
      switch (url.pathname) {
        case '/hook/pretooluse':
          return json(res, 200, await this.#preToolUse(body));
        case '/hook/userpromptsubmit':
          this.deck.touchSession(body.session_id, { cwd: body.cwd, state: State.THINKING });
          this.deck.setState(State.THINKING);
          return json(res, 200, {});
        case '/hook/notification':
          return json(res, 200, this.#notification(body));
        case '/hook/stop':
          this.deck.lastMessage = body.last_assistant_message ?? '';
          this.deck.touchSession(body.session_id, { cwd: body.cwd, state: State.DONE });
          this.deck.setState(State.DONE);
          return json(res, 200, {});
        default:
          return json(res, 404, { error: 'no such hook' });
      }
    } catch (err) {
      this.log(`hook error on ${url.pathname}: ${err.stack}`);
      return json(res, 200, defer(`agent-deck errored: ${err.message}`));
    }
  }

  async #preToolUse(body) {
    const toolName = body.tool_name;

    // Let the deck stay out of the way for modes the user already opted into.
    if (body.permission_mode === 'bypassPermissions' || body.permission_mode === 'plan') {
      return defer(`agent-deck stands down in ${body.permission_mode} mode`);
    }
    if (!this.gateTools.has(toolName)) return defer('not a gated tool');
    if (!this.isDeviceReady()) return defer('AKP03 not connected — use the on-screen prompt');

    const decision = await withTimeout(
      this.deck.requestApproval({
        toolName,
        toolInput: body.tool_input,
        sessionId: body.session_id,
        cwd: body.cwd,
      }),
      this.approvalTimeoutMs,
      () => {
        this.deck.resolvePending('defer', 'no key pressed in time');
        return { decision: 'defer', reason: 'timeout' };
      },
    );

    if (decision.decision === 'defer') {
      return defer(decision.reason || 'deferred to the on-screen prompt');
    }

    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: decision.decision,
        permissionDecisionReason:
          decision.decision === 'allow'
            ? 'Approved on the AKP03 (physical key)'
            : `Denied on the AKP03${decision.reason ? `: ${decision.reason}` : ''}`,
      },
    };
  }

  #notification(body) {
    switch (body.notification_type) {
      case 'permission_prompt':
      case 'agent_needs_input':
      case 'elicitation_dialog':
        // Claude is asking something we did NOT gate (so there is no pending
        // tool call to resolve). Light the status key; the answer lives on screen.
        this.deck.touchSession(body.session_id, { cwd: body.cwd, state: State.AWAITING });
        this.deck.setState(State.AWAITING, { force: true });
        break;
      case 'idle_prompt':
        this.deck.setState(State.IDLE);
        break;
      case 'agent_completed':
        this.deck.setState(State.DONE);
        break;
    }
    return {};
  }
}

const defer = (reason) => ({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'defer',
    permissionDecisionReason: reason,
  },
});

function withTimeout(promise, ms, onTimeout) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(onTimeout()), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1_000_000) reject(new Error('hook payload too large'));
    });
    req.on('error', reject);
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
  });
}

function json(res, code, payload) {
  const buf = Buffer.from(JSON.stringify(payload));
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': buf.length });
  res.end(buf);
}
