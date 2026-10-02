import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const source = readFileSync(new URL('../src/conversation/monitor.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
});
const module = { exports: {} };
new Function('require', 'exports', outputText)(name => {
  assert.equal(name, '../utils/debug');
  return { isDebugLog: () => false };
}, module.exports);
const { ConversationMonitor } = module.exports;

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

async function flush() {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

async function withMonitor(run) {
  const original = {
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    songloft: globalThis.songloft,
    fetch: globalThis.fetch,
    now: Date.now,
  };
  const timers = new Map();
  let timerId = 0;
  let now = 100000;
  const calls = [];
  const webhooks = [];
  let devices = ['a', 'b'];
  let request = async () => [];
  let getConfig = async () => ({ conversation_poll_interval: 1 });
  globalThis.songloft = { log: { info() { }, warn() { }, error() { } } };
  globalThis.setInterval = fn => { timers.set(++timerId, fn); return timerId; };
  globalThis.clearInterval = id => timers.delete(id);
  Date.now = () => now;
  globalThis.fetch = async url => { webhooks.push(url); };
  const accounts = {
    getAccounts: async () => [{ id: 'account' }],
    getManagedDevices: async () => devices.map(id => ({ device_id: id, device_name: id, hardware: 'LX04' })),
    getMinaClient: () => ({ getLatestAskFromXiaoai: id => { calls.push(id); return request(id); } }),
  };
  const monitor = new ConversationMonitor(accounts, {
    getConfig: () => getConfig(),
    getWebhooks: async () => [{ id: 'hook', url: 'https://example.test/hook' }],
  });
  try {
    await run({
      monitor, calls, timers, webhooks,
      setRequest: fn => { request = fn; },
      setConfig: fn => { getConfig = fn; },
      setDevices: value => { devices = value; },
      advance: ms => { now += ms; },
      tick: async () => { for (const fn of [...timers.values()]) fn(); await flush(); },
    });
  } finally {
    monitor.stop();
    globalThis.setInterval = original.setInterval;
    globalThis.clearInterval = original.clearInterval;
    globalThis.songloft = original.songloft;
    globalThis.fetch = original.fetch;
    Date.now = original.now;
  }
}

const message = timestamp_ms => ({ timestamp_ms, response: { answer: [] } });

test('slow device has one request while other devices keep polling', async () => {
  await withMonitor(async h => {
    await h.monitor.start();
    h.calls.length = 0;
    const slow = deferred();
    h.setRequest(id => id === 'a' ? slow.promise : Promise.resolve([]));
    for (let i = 0; i < 10; i++) { h.advance(1000); await h.tick(); }
    assert.equal(h.calls.filter(id => id === 'a').length, 1);
    assert.equal(h.calls.filter(id => id === 'b').length, 10);
    slow.resolve([]);
    await flush();
    await h.tick();
    assert.equal(h.calls.filter(id => id === 'a').length, 2);
  });
});

test('failed polls back off to 30 seconds and successful empty response resets delay', async () => {
  await withMonitor(async h => {
    h.setDevices(['a']);
    await h.monitor.start();
    h.calls.length = 0;
    h.setRequest(async () => null);
    await h.tick();
    let count = 1;
    for (const delay of [2000, 4000, 8000, 16000, 30000, 30000]) {
      h.advance(delay - 1); await h.tick();
      assert.equal(h.calls.length, count);
      h.advance(1); await h.tick();
      assert.equal(h.calls.length, ++count);
    }
    h.setRequest(async () => []);
    h.advance(30000); await h.tick();
    assert.equal(h.calls.length, ++count);
    h.advance(1000); await h.tick();
    assert.equal(h.calls.length, ++count);
  });
});

test('thrown requests back off and release the device for recovery', async () => {
  await withMonitor(async h => {
    h.setDevices(['a']);
    await h.monitor.start();
    h.calls.length = 0;
    h.setRequest(async () => { throw new Error('timeout'); });
    await h.tick();
    h.advance(1000); await h.tick();
    assert.equal(h.calls.length, 1);
    h.setRequest(async () => []);
    h.advance(1000); await h.tick();
    assert.equal(h.calls.length, 2);
  });
});

test('restart waits for old device request to settle and discards its messages', async () => {
  await withMonitor(async h => {
    h.setDevices(['a']);
    await h.monitor.start();
    let delivered = 0;
    h.monitor.registerCallback('test', () => { delivered++; });
    const slow = deferred();
    h.setRequest(() => slow.promise);
    await h.tick();
    const count = h.calls.length;
    h.monitor.stop();
    await h.monitor.start();
    await h.tick();
    assert.equal(h.calls.length, count);
    slow.resolve([message(1)]); await flush();
    assert.equal(delivered, 0);
    assert.equal(h.monitor.getMessages().length, 0);
    assert.equal(h.webhooks.length, 0);
    h.setRequest(async () => [message(2)]);
    await h.tick(); // establish new baseline without replaying history
    assert.equal(delivered, 0);
    h.setRequest(async () => [message(3)]);
    await h.tick();
    assert.equal(delivered, 1);
    assert.equal(h.webhooks.length, 1);
  });
});

test('concurrent start calls share initialization and install one timer', async () => {
  await withMonitor(async h => {
    const config = deferred();
    let configCalls = 0;
    h.setConfig(() => { configCalls++; return config.promise; });
    const a = h.monitor.start();
    const b = h.monitor.start();
    config.resolve({ conversation_poll_interval: 1 });
    await Promise.all([a, b]);
    assert.equal(configCalls, 1);
    assert.equal(h.calls.length, 2);
    assert.equal(h.timers.size, 1);
  });
});

test('stopped initialization cannot install a timer after restart', async () => {
  await withMonitor(async h => {
    const config = deferred();
    h.setConfig(() => config.promise);
    const oldStart = h.monitor.start();
    h.monitor.stop();
    h.setConfig(async () => ({ conversation_poll_interval: 1 }));
    await h.monitor.start();
    config.resolve({ conversation_poll_interval: 30 });
    await oldStart;
    assert.equal(h.timers.size, 1);
    assert.equal(h.calls.length, 2);
  });
});

test('removed device results are discarded, including after re-adding same device', async () => {
  await withMonitor(async h => {
    h.setDevices(['a']);
    await h.monitor.start();
    const slow = deferred();
    h.setRequest(() => slow.promise);
    await h.tick();
    h.setDevices([]); await h.monitor.refresh();
    h.setDevices(['a']); await h.monitor.refresh();
    const count = h.calls.length;
    await h.tick();
    assert.equal(h.calls.length, count);
    slow.resolve([message(1)]); await flush();
    assert.equal(h.monitor.getMessages().length, 0);
    assert.equal((await h.monitor.getStatus()).devices[0].primed, false);
    h.setRequest(async () => []);
    await h.tick();
    assert.equal((await h.monitor.getStatus()).devices[0].primed, true);
  });
});

test('stopping inside a callback prevents later callbacks and webhooks', async () => {
  await withMonitor(async h => {
    h.setDevices(['a']);
    await h.monitor.start();
    let later = 0;
    h.monitor.registerCallback('stop', () => h.monitor.stop());
    h.monitor.registerCallback('later', () => { later++; });
    h.setRequest(async () => [message(1), message(2)]);
    await h.tick();
    assert.equal(later, 0);
    assert.equal(h.webhooks.length, 0);
    assert.equal(h.timers.size, 0);
  });
});

test('failed initial fetch does not establish a baseline or replay old messages on recovery', async () => {
  await withMonitor(async h => {
    h.setDevices(['a']);
    h.setRequest(async () => null);
    await h.monitor.start();
    assert.equal((await h.monitor.getStatus()).devices[0].primed, false);
    let delivered = 0;
    h.monitor.registerCallback('test', () => { delivered++; });
    h.setRequest(async () => [message(10)]);
    h.advance(2000); await h.tick();
    assert.equal((await h.monitor.getStatus()).devices[0].last_timestamp_ms, 10);
    assert.equal(delivered, 0);
    h.advance(1000); await h.tick();
    assert.equal(delivered, 0);
    h.setRequest(async () => [message(11)]);
    h.advance(1000); await h.tick();
    assert.equal(delivered, 1);
  });
});

test('old initial fetch cannot prime a restarted session or replace its timer', async () => {
  await withMonitor(async h => {
    h.setDevices(['a']);
    const slow = deferred();
    h.setRequest(() => slow.promise);
    const oldStart = h.monitor.start();
    await flush();
    assert.equal(h.calls.length, 1);
    h.monitor.stop();
    await h.monitor.start();
    const timerIds = [...h.timers.keys()];
    slow.resolve([message(10)]);
    await oldStart;
    assert.deepEqual([...h.timers.keys()], timerIds);
    assert.equal((await h.monitor.getStatus()).devices[0].primed, false);
    h.setRequest(async () => []);
    await h.tick();
    assert.equal((await h.monitor.getStatus()).devices[0].primed, true);
  });
});
