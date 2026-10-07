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
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
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
  globalThis.setTimeout = (fn, delay) => { timers.set(++timerId, { fn, at: now + delay }); return timerId; };
  globalThis.clearTimeout = id => timers.delete(id);
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
  const advance = async ms => {
    const target = now + ms;
    let fired = 0;
    while (true) {
      await flush();
      const next = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      assert.ok(++fired < 1000, 'timer must not spin without waiting');
      const [id, timer] = next;
      timers.delete(id);
      now = timer.at;
      timer.fn();
    }
    now = target;
    await flush();
  };
  try {
    await run({
      monitor, calls, timers, webhooks,
      setRequest: fn => { request = fn; },
      setConfig: fn => { getConfig = fn; },
      setDevices: value => { devices = value; },
      advance,
      tick: () => advance(0),
      nextDelay: () => Math.min(...[...timers.values()].map(t => t.at - now)),
    });
  } finally {
    monitor.stop();
    globalThis.setTimeout = original.setTimeout;
    globalThis.clearTimeout = original.clearTimeout;
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
    let timestamp = 0;
    h.setRequest(id => id === 'a' ? slow.promise : Promise.resolve([message(++timestamp)]));
    await h.advance(10000);
    assert.equal(h.calls.filter(id => id === 'a').length, 1);
    assert.equal(h.calls.filter(id => id === 'b').length, 10);
    slow.resolve([]);
    await flush();
    await h.advance(1999);
    assert.equal(h.calls.filter(id => id === 'a').length, 1);
    await h.advance(1);
    assert.equal(h.calls.filter(id => id === 'a').length, 2);
  });
});

test('a slow due device cannot delay another device whose deadline arrives later', async () => {
  await withMonitor(async h => {
    h.setConfig(async () => ({ conversation_poll_interval: 2 }));
    await h.monitor.start();
    h.setRequest(async id => id === 'a' ? [message(1)] : []);
    await h.advance(2000); // a is due at 4s; idle b is due at 6s.
    const slow = deferred();
    h.setRequest(id => id === 'a' ? slow.promise : Promise.resolve([]));
    await h.advance(2000);
    const count = h.calls.filter(id => id === 'b').length;
    await h.advance(1999);
    assert.equal(h.calls.filter(id => id === 'b').length, count);
    await h.advance(1);
    assert.equal(h.calls.filter(id => id === 'b').length, count + 1);
    assert.equal(h.calls.filter(id => id === 'a').length, 3);
    slow.resolve([]);
    await flush();
  });
});

for (const response of ['empty', 'unchanged']) {
  test(`${response} successful polls back off from 2 to 4 to 5 seconds, then new messages reset the delay`, async () => {
    await withMonitor(async h => {
      h.setDevices(['a']);
      h.setConfig(async () => ({}));
      h.setRequest(async () => response === 'empty' ? [] : [message(10)]);
      await h.monitor.start();
      assert.equal(h.nextDelay(), 2000);
      for (const delay of [2000, 4000, 5000, 5000]) {
        const count = h.calls.length;
        await h.advance(delay - 1);
        assert.equal(h.calls.length, count);
        await h.advance(1);
        assert.equal(h.calls.length, count + 1);
      }
      assert.equal(h.monitor.getMessages().length, 0);
      h.setRequest(async () => [message(11)]);
      await h.advance(5000);
      assert.equal(h.monitor.getMessages().length, 1);
      assert.equal(h.webhooks.length, 1);
      assert.equal(h.nextDelay(), 2000);
    });
  });
}

for (const interval of [1, 5, 10, 30]) {
  test(`saved ${interval}-second interval is retained and idle backoff never shortens it`, async () => {
    await withMonitor(async h => {
      h.setDevices(['a']);
      h.setConfig(async () => ({ conversation_poll_interval: interval }));
      await h.monitor.start();
      assert.equal(h.nextDelay(), interval * 1000);
      await h.advance(interval * 1000);
      assert.equal(h.nextDelay(), Math.min(Math.max(5000, interval * 1000), interval * 2000));
    });
  });
}

for (const interval of ['invalid', NaN, Infinity]) {
  test(`invalid interval ${interval} uses a finite 2-second default`, async () => {
    await withMonitor(async h => {
      h.setConfig(async () => ({ conversation_poll_interval: interval }));
      await h.monitor.start();
      assert.equal(h.nextDelay(), 2000);
    });
  });
}

test('failed polls back off to 30 seconds and new messages reset both delays', async () => {
  await withMonitor(async h => {
    h.setDevices(['a']);
    await h.monitor.start();
    h.calls.length = 0;
    h.setRequest(async () => null);
    await h.advance(1000);
    let count = 1;
    for (const delay of [2000, 4000, 8000, 16000, 30000, 30000]) {
      await h.advance(delay - 1);
      assert.equal(h.calls.length, count);
      await h.advance(1);
      assert.equal(h.calls.length, ++count);
    }
    h.setRequest(async () => [message(1)]);
    await h.advance(30000);
    assert.equal(h.calls.length, ++count);
    assert.equal(h.nextDelay(), 1000);
    h.setRequest(async () => null);
    await h.advance(1000);
    assert.equal(h.nextDelay(), 2000);
  });
});

test('thrown requests back off and release the device for recovery', async () => {
  await withMonitor(async h => {
    h.setDevices(['a']);
    await h.monitor.start();
    h.calls.length = 0;
    h.setRequest(async () => { throw new Error('timeout'); });
    await h.advance(1000);
    await h.advance(1999);
    assert.equal(h.calls.length, 1);
    h.setRequest(async () => []);
    await h.advance(1);
    assert.equal(h.calls.length, 2);
  });
});

test('a slow successful request waits the configured interval after completion', async () => {
  await withMonitor(async h => {
    h.setDevices(['a']);
    await h.monitor.start();
    const slow = deferred();
    h.setRequest(() => slow.promise);
    await h.advance(1000);
    await h.advance(9000);
    const count = h.calls.length;
    slow.resolve([message(1)]);
    await flush();
    assert.equal(h.nextDelay(), 1000);
    await h.advance(999);
    assert.equal(h.calls.length, count);
    await h.advance(1);
    assert.equal(h.calls.length, count + 1);
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
    await h.advance(1000);
    const count = h.calls.length;
    h.monitor.stop();
    await h.monitor.start();
    await h.advance(1000);
    assert.equal(h.calls.length, count);
    slow.resolve([message(1)]);
    await flush();
    assert.equal(delivered, 0);
    assert.equal(h.monitor.getMessages().length, 0);
    assert.equal(h.webhooks.length, 0);
    h.setRequest(async () => [message(2)]);
    await h.tick();
    assert.equal(delivered, 0);
    h.setRequest(async () => [message(3)]);
    await h.advance(1000);
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
    await h.advance(1000);
    h.setDevices([]); await h.monitor.refresh();
    assert.equal(h.timers.size, 0);
    h.setDevices(['a']); await h.monitor.refresh();
    const count = h.calls.length;
    await h.advance(1000);
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
    await h.advance(1000);
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
    await h.advance(2000);
    assert.equal((await h.monitor.getStatus()).devices[0].last_timestamp_ms, 10);
    assert.equal(delivered, 0);
    await h.advance(1000);
    assert.equal(delivered, 0);
    h.setRequest(async () => [message(11)]);
    await h.advance(2000);
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
    assert.equal(h.timers.size, 0);
    slow.resolve([message(10)]);
    await oldStart;
    assert.equal((await h.monitor.getStatus()).devices[0].primed, false);
    h.setRequest(async () => []);
    await h.tick();
    assert.equal(h.timers.size, 1);
    assert.equal((await h.monitor.getStatus()).devices[0].primed, true);
  });
});

test('starting an enabled monitor with all devices in flight does not reset its session', async () => {
  await withMonitor(async h => {
    h.setDevices(['a']);
    await h.monitor.start();
    const slow = deferred();
    h.setRequest(() => slow.promise);
    await h.advance(1000);
    assert.equal(h.timers.size, 0);
    await h.monitor.start();
    assert.equal((await h.monitor.getStatus()).devices[0].primed, true);
    slow.resolve([]);
    await flush();
    assert.equal(h.timers.size, 1);
  });
});
