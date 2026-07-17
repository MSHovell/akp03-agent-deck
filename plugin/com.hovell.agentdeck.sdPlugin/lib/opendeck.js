import { EventEmitter } from 'node:events';

/**
 * Elgato plugin-protocol client. OpenDeck speaks the same WebSocket dialect,
 * so this works against either host. Uses Node's built-in global WebSocket
 * (Node >= 22), which is why this plugin ships with zero dependencies.
 *
 * The host launches us as:
 *   plugin -port N -pluginUUID X -registerEvent registerPlugin -info {json}
 */
export class OpenDeckClient extends EventEmitter {
  constructor({ argv = process.argv.slice(2), log = () => {} } = {}) {
    super();
    this.log = log;
    const a = parseArgs(argv);
    this.port = a['-port'];
    this.uuid = a['-pluginUUID'];
    this.registerEvent = a['-registerEvent'];
    this.info = safeParse(a['-info']);
    this.ws = null;
    this.ready = false;
    /** context -> { action, context, settings, controller, coordinates } */
    this.contexts = new Map();
  }

  get launchedByHost() {
    return Boolean(this.port && this.uuid && this.registerEvent);
  }

  connect() {
    return new Promise((resolve, reject) => {
      if (!this.launchedByHost) {
        return reject(new Error('missing -port/-pluginUUID/-registerEvent; not launched by a host'));
      }
      const ws = new WebSocket(`ws://127.0.0.1:${this.port}`);
      this.ws = ws;

      ws.addEventListener('open', () => {
        ws.send(JSON.stringify({ event: this.registerEvent, uuid: this.uuid }));
        this.ready = true;
        this.log(`registered with host on port ${this.port}`);
        this.emit('ready');
        resolve();
      });

      ws.addEventListener('message', (ev) => {
        let msg;
        try {
          msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
        } catch {
          return;
        }
        this.#track(msg);
        this.emit(msg.event, msg);
        this.emit('*', msg);
      });

      ws.addEventListener('close', () => {
        this.ready = false;
        this.log('host connection closed');
        this.emit('closed');
      });

      ws.addEventListener('error', (e) => {
        this.ready = false;
        this.emit('ws-error', e);
        reject(new Error(`websocket error: ${e.message ?? 'unknown'}`));
      });
    });
  }

  /** Keep a live map of which action instances exist on which keys. */
  #track(msg) {
    const { event, context, action, payload } = msg;
    if (!context) return;
    if (event === 'willAppear') {
      this.contexts.set(context, {
        action,
        context,
        settings: payload?.settings ?? {},
        controller: payload?.controller ?? 'Keypad',
        coordinates: payload?.coordinates,
      });
      this.emit('appeared', this.contexts.get(context));
    } else if (event === 'willDisappear') {
      this.contexts.delete(context);
    } else if (event === 'didReceiveSettings') {
      const c = this.contexts.get(context);
      if (c) c.settings = payload?.settings ?? {};
    }
  }

  /** All live contexts running a given action UUID. */
  byAction(actionUuid) {
    return [...this.contexts.values()].filter((c) => c.action === actionUuid);
  }

  send(obj) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(obj));
  }

  setImage(context, image, target = 0) {
    this.send({ event: 'setImage', context, payload: { image, target } });
  }

  setTitle(context, title, target = 0) {
    this.send({ event: 'setTitle', context, payload: { title, target } });
  }

  setState(context, state) {
    this.send({ event: 'setState', context, payload: { state } });
  }

  /** Encoder touchscreen strip / dial readout, where the host supports it. */
  setFeedback(context, payload) {
    this.send({ event: 'setFeedback', context, payload });
  }

  showAlert(context) {
    this.send({ event: 'showAlert', context });
  }

  showOk(context) {
    this.send({ event: 'showOk', context });
  }

  switchToProfile(device, profile) {
    this.send({ event: 'switchToProfile', context: this.uuid, device, payload: { profile } });
  }

  logMessage(message) {
    this.send({ event: 'logMessage', payload: { message } });
  }
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) out[argv[i]] = argv[i + 1];
  return out;
}

function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}
