import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { setImmediate as settle } from 'node:timers/promises';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const source = readFileSync(new URL('../src/store.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
});

function statusStore({ get = async () => ({ position: 42 }), webSocket = true } = {}) {
  const document = new EventTarget();
  document.hidden = false;
  const window = new EventTarget();
  const sockets = [];
  const requests = [];
  const timers = new Map();
  let timerId = 0;
  class Socket {
    OPEN = 1;
    CLOSED = 3;
    readyState = 0;
    constructor() { sockets.push(this); }
    close(code, reason) {
      this.closeArgs = [code, reason];
      this.readyState = this.CLOSED;
    }
    send() {}
    open() { this.readyState = this.OPEN; this.onopen(); }
    status(position) { this.onmessage({ data: JSON.stringify({ type: 'status', data: { position } }) }); }
  }
  const context = {
    exports: {}, document, window, console,
    WebSocket: webSocket ? Socket : undefined,
    setTimeout: (fn, delay) => { const id = ++timerId; timers.set(id, { fn, delay, interval: false }); return id; },
    setInterval: (fn, delay) => { const id = ++timerId; timers.set(id, { fn, delay, interval: true }); return id; },
    clearTimeout: id => timers.delete(id),
    clearInterval: id => timers.delete(id),
    require: name => {
      if (name === 'vue') return { reactive: value => value, computed: fn => ({ get value() { return fn(); } }) };
      if (name === './api') return {
        get: path => { requests.push(path); return get(path); },
        query: () => '', pluginWebSocketUrl: path => path, messageOf: String,
      };
      throw new Error(`unexpected dependency: ${name}`);
    },
  };
  vm.runInNewContext(outputText, context);
  const store = context.exports;
  store.state.currentAccountId = 'account';
  store.state.currentDeviceId = 'device';
  const visible = () => document.dispatchEvent(new Event('visibilitychange'));
  const online = () => window.dispatchEvent(new Event('online'));
  return { store, document, sockets, requests, timers, visible, online };
}

test('returning to a visible page replaces a silently dead OPEN socket and fetches a snapshot', async () => {
  const s = statusStore();
  s.store.connectStatusStream();
  s.sockets[0].open();
  s.sockets[0].status(1);
  assert.equal(s.timers.size, 0);
  s.visible();
  await settle();
  assert.equal(s.sockets.length, 2);
  assert.deepEqual(s.sockets[0].closeArgs, [1000, 'client']);
  assert.equal(s.store.state.statusConnected, false);
  assert.equal(s.requests.length, 1);
  assert.equal(s.store.state.player.position, 42);
  s.sockets[0].status(2);
  s.sockets[0].onopen();
  s.sockets[0].onerror();
  s.sockets[0].onclose();
  assert.equal(s.store.state.player.position, 42);
  assert.equal(s.store.state.statusConnected, false);
  s.sockets[1].open();
  s.sockets[1].status(43);
  assert.equal(s.store.state.player.position, 43);
  assert.equal(s.timers.size, 0);
});

test('hidden notifications do not restart the connection; coming online while visible does', async () => {
  const s = statusStore();
  s.store.connectStatusStream();
  s.document.hidden = true;
  s.visible();
  s.online();
  assert.equal(s.sockets.length, 1);
  assert.equal(s.requests.length, 0);
  s.document.hidden = false;
  s.online();
  await settle();
  assert.equal(s.sockets.length, 2);
  assert.equal(s.store.state.player.position, 42);
});

test('foreground recovery cancels pending backoff and ignores old error/close events', async () => {
  const s = statusStore();
  s.store.connectStatusStream();
  s.sockets[0].onerror();
  assert.equal([...s.timers.values()].filter(timer => !timer.interval && timer.delay === 1000).length, 1);
  s.visible();
  await settle();
  s.sockets[0].onclose();
  assert.equal([...s.timers.values()].filter(timer => !timer.interval && timer.delay === 1000).length, 0);
  s.sockets[1].open();
  assert.equal(s.timers.size, 0);
});

test('repeated connections do not accumulate recovery listeners', () => {
  const s = statusStore();
  s.store.connectStatusStream();
  s.store.connectStatusStream();
  s.visible();
  assert.equal(s.sockets.length, 3);
  assert.equal(s.requests.length, 1);
});

test('a suspended HTTP request cannot block recovery or overwrite the new snapshot', async () => {
  const pending = [];
  const s = statusStore({ get: () => new Promise(resolve => pending.push(resolve)) });
  s.store.connectStatusStream();
  const oldRequest = s.store.refreshPlayerStatus();
  s.visible();
  assert.equal(s.requests.length, 2);
  pending[0]({ position: 1 });
  await oldRequest;
  assert.equal(s.store.state.player.position, undefined);
  // The old finally must not release the new request's busy guard.
  await s.store.refreshPlayerStatus();
  assert.equal(s.requests.length, 2);
  pending[1]({ position: 42 });
  await settle();
  assert.equal(s.store.state.player.position, 42);
});

test('disposing removes listeners and timers and rejects late HTTP/socket updates', async () => {
  let resolve;
  const s = statusStore({ get: () => new Promise(res => { resolve = res; }) });
  s.store.connectStatusStream();
  const request = s.store.refreshPlayerStatus();
  s.store.disposeStore();
  s.visible();
  s.online();
  s.sockets[0].onerror();
  s.sockets[0].status(1);
  resolve({ position: 2 });
  await request;
  assert.equal(s.sockets.length, 1);
  assert.equal(s.requests.length, 1);
  assert.equal(s.timers.size, 0);
  assert.equal(s.store.state.player.position, undefined);
});

test('recovery without an account or device makes no new connection or status request', () => {
  const s = statusStore();
  s.store.connectStatusStream();
  s.store.state.currentDeviceId = '';
  s.visible();
  s.online();
  assert.equal(s.sockets.length, 1);
  assert.equal(s.requests.length, 0);
});

test('environments without WebSocket retain HTTP polling and refresh on resume', async () => {
  const s = statusStore({ webSocket: false });
  s.store.connectStatusStream();
  await settle();
  s.visible();
  await settle();
  assert.equal(s.requests.length, 2);
  assert.equal(s.store.state.player.position, 42);
  assert.equal([...s.timers.values()].filter(timer => timer.interval).length, 1);
  s.store.disconnectStatusStream();
  assert.equal(s.timers.size, 0);
});
