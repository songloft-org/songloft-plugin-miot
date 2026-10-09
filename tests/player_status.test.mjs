import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const ts = require('typescript');

function loadSource(path, dependencies) {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  });
  const exports = {};
  new Function('require', 'exports', outputText)(name => {
    assert.ok(Object.hasOwn(dependencies, name), `unexpected dependency: ${name}`);
    return dependencies[name];
  }, exports);
  return exports;
}

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

async function flush() {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

for (const stored of [{}, { conversation_poll_interval: 1 }, { conversation_poll_interval: 7 }]) {
  test(`config defaults to 2 seconds and preserves stored interval ${stored.conversation_poll_interval}`, async () => {
    const original = globalThis.songloft;
    const { ConfigManager } = loadSource('../src/config/manager.ts', {
      '../memory/types': loadSource('../src/memory/types.ts', {}),
      '../voicecmd/defaults': loadSource('../src/voicecmd/defaults.ts', {}),
    });
    globalThis.songloft = { storage: { get: async () => JSON.stringify(stored) } };
    try {
      const config = await new ConfigManager().getConfig();
      assert.equal(config.conversation_poll_interval, stored.conversation_poll_interval ?? 2);
    } finally {
      globalThis.songloft = original;
    }
  });
}

async function withStatus(run) {
  const original = { now: Date.now, songloft: globalThis.songloft };
  let now = 100000;
  Date.now = () => now;
  globalThis.songloft = { log: { info() { }, warn() { }, error() { } } };
  const handlers = loadSource('../src/handlers/playlist.ts', {
    '@songloft/plugin-sdk': {},
    '../player/manager': {},
    '../config/manager': {},
    '../utils/http': {},
    '../utils/favorites': {},
  });
  const resets = [];
  let localPosition = 20;
  let sample = { status: 1, volume: 40, play_song_detail: { position: 5000, duration: 300000 } };
  let readSample = async () => ({ data: { info: JSON.stringify(sample) } });
  const manager = {
    getStatus: () => ({ state: 'playing', position: localPosition, duration: 300 }),
    getPosition: () => localPosition,
    getStreamSeekOffsetSec: () => 0,
    getPlaybackSpeed: () => 1,
    getPlaybackRevision: () => 0,
    isVoiceSuspended: () => false,
    isHourlyResumePending: () => false,
    matchDeviceStream: () => 'ours',
    canCalibrateAutoNextTimer: () => true,
    resetAutoNextTimer: position => { resets.push(position); },
  };
  let calls = 0;
  const mina = { getPlayerStatus: () => { calls++; return readSample(); } };
  const resolve = () => handlers.resolvePlayerStatus({ getOrCreate: async () => manager }, mina, 'account', 'speaker');
  try {
    await run({
      resolve, resets, manager, handlers,
      refresh: async () => {
        const initial = await resolve();
        await flush();
        return handlers.getDeviceStatusCache('account', 'speaker') ? resolve() : initial;
      },
      calls: () => calls,
      advance: ms => { now += ms; },
      setPosition: value => { localPosition = value; },
      setSample: value => { sample = value; },
      setRequest: value => { readSample = value; },
    });
  } finally {
    await flush();
    Date.now = original.now;
    globalThis.songloft = original.songloft;
  }
}

test('cached samples only extrapolate display position and never reset the timer again', async () => {
  await withStatus(async h => {
    assert.equal((await h.refresh()).position, 5);
    assert.deepEqual(h.resets, [5]);
    for (let i = 1; i <= 3; i++) {
      h.advance(1000);
      assert.equal((await h.resolve()).position, 5 + i);
    }
    assert.equal(h.calls(), 1);
    assert.deepEqual(h.resets, [5]);
  });
});

test('fresh and cached status preserve fractional progress after seek and speed conversion', async () => {
  await withStatus(async h => {
    h.manager.getPlaybackSpeed = () => 0.5;
    h.manager.getStreamSeekOffsetSec = () => 100;
    h.setPosition(110);
    h.setSample({ status: 1, play_song_detail: { position: 5375, duration: 399520 } });
    const status = await h.refresh();
    assert.equal(status.position, 102.6875);
    assert.deepEqual(h.resets, [102.6875]);
    h.advance(250);
    assert.equal((await h.resolve()).position, 102.8125);
    assert.equal(h.calls(), 1);
    assert.deepEqual(h.resets, [102.6875]);
  });
});

test('fresh but frozen progress cannot repeatedly postpone the timer', async () => {
  await withStatus(async h => {
    await h.refresh();
    h.advance(5000);
    await h.refresh();
    assert.equal(h.calls(), 2);
    assert.deepEqual(h.resets, [5]);
    h.advance(5000);
    h.setSample({ status: 1, play_song_detail: { position: 10000, duration: 300000 } });
    await h.refresh();
    assert.deepEqual(h.resets, [5, 10]);
  });
});

for (const detail of [undefined, { position: NaN }, { position: -1000 }, { position: 0 }]) {
  test(`unusable device progress cannot rewind the timer: ${JSON.stringify(detail)}`, async () => {
    await withStatus(async h => {
      h.setSample({ status: 1, play_song_detail: detail });
      await h.refresh();
      assert.deepEqual(h.resets, []);
    });
  });
}

test('playing foreign media cannot calibrate the current song timer', async () => {
  await withStatus(async h => {
    h.manager.matchDeviceStream = () => 'foreign';
    await h.refresh();
    assert.deepEqual(h.resets, []);
  });
});

test('concurrent status requests share both the query and one timer calibration', async () => {
  await withStatus(async h => {
    const request = deferred();
    h.setRequest(() => request.promise);
    const pending = Array.from({ length: 20 }, () => h.resolve());
    await flush();
    assert.equal(h.calls(), 1);
    const results = await Promise.all(pending);
    assert.ok(results.every(result => result.position === 20));
    assert.deepEqual(h.resets, []);
    request.resolve({ data: { info: JSON.stringify({ status: 1, play_song_detail: { position: 5000, duration: 300000 } }) } });
    await flush();
    assert.deepEqual(h.resets, [5]);
  });
});

test('slow response does not block local progress and caches the completed sample for five seconds', async () => {
  await withStatus(async h => {
    const request = deferred();
    h.setRequest(() => request.promise);
    const pending = h.resolve();
    await flush();
    assert.equal((await pending).position, 20);
    h.advance(10000);
    h.setPosition(30);
    assert.equal((await h.resolve()).position, 30);
    request.resolve({ data: { info: JSON.stringify({ status: 1, play_song_detail: { position: 5000, duration: 300000 } }) } });
    await flush();
    h.advance(4999);
    await h.refresh();
    assert.equal(h.calls(), 1);
    assert.deepEqual(h.resets, [5]);
    h.advance(1);
    await h.refresh();
    assert.equal(h.calls(), 2);
  });
});

test('a failed status request releases its in-flight slot for recovery', async () => {
  await withStatus(async h => {
    h.setRequest(async () => { throw new Error('timeout'); });
    await h.resolve();
    await flush();
    assert.deepEqual(h.resets, []);
    h.advance(5000);
    h.setRequest(async () => ({ data: { info: JSON.stringify({ status: 1, play_song_detail: { position: 5000 } }) } }));
    await h.refresh();
    assert.equal(h.calls(), 2);
    assert.deepEqual(h.resets, [5]);
  });
});

for (const action of ['pause', 'next', 'optimistic update']) {
  test(`a slow old sample cannot overwrite ${action}`, async () => {
    await withStatus(async h => {
      const request = deferred();
      let revision = 0;
      h.manager.getPlaybackRevision = () => revision;
      h.setRequest(() => request.promise);
      assert.equal((await h.resolve()).position, 20);
      if (action === 'optimistic update') {
        h.handlers.updateDeviceStatusCache('account', 'speaker', { state: 'paused', position: 20 });
      } else {
        revision++;
      }
      request.resolve({ data: { info: JSON.stringify({ status: 1, volume: 99, play_song_detail: { position: 5000 } }) } });
      await flush();
      assert.deepEqual(h.resets, []);
      const cache = h.handlers.getDeviceStatusCache('account', 'speaker');
      if (action === 'optimistic update') assert.equal(cache.state, 'paused');
      else assert.equal(cache, undefined);
    });
  });
}

test('a shared old sample is extrapolated for display but cannot rewind the timer', async () => {
  await withStatus(async h => {
    h.setRequest(async () => ({ sampledAt: 97000, data: { info: JSON.stringify({ status: 1, play_song_detail: { position: 5000 } }) } }));
    assert.equal((await h.refresh()).position, 8);
    assert.deepEqual(h.resets, []);
  });
});

async function withStream(run) {
  const original = {
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    songloft: globalThis.songloft,
  };
  const timers = new Map();
  let timerId = 0;
  let calls = 0;
  let query = async () => ({ position: calls });
  globalThis.songloft = { log: { warn() { } } };
  globalThis.setInterval = fn => { timers.set(++timerId, fn); return timerId; };
  globalThis.clearInterval = id => timers.delete(id);
  const stream = loadSource('../src/ws/status-stream.ts', {
    '@songloft/plugin-sdk': { parseQuery: () => ({ account_id: 'account', device_id: 'speaker' }) },
    '../handlers/playlist': { resolvePlayerStatus: () => { calls++; return query(); } },
  });
  stream.initStatusStream({}, {});
  const connect = () => {
    const sent = [];
    const callbacks = {};
    const socket = {
      OPEN: 1, readyState: 1,
      send: async frame => { sent.push(JSON.parse(frame)); },
      onClose: fn => { callbacks.close = fn; },
      onError: fn => { callbacks.error = fn; },
      onMessage: fn => { callbacks.message = fn; },
    };
    return {
      sent,
      close: () => { socket.readyState = 3; callbacks.close(); },
      pending: stream.handleStatusWebSocket({ query: '' }, socket),
    };
  };
  try {
    await run({
      connect, timers,
      calls: () => calls,
      setRequest: fn => { query = fn; },
      tick: async () => { for (const fn of [...timers.values()]) fn(); await flush(); },
    });
  } finally {
    globalThis.setInterval = original.setInterval;
    globalThis.clearInterval = original.clearInterval;
    globalThis.songloft = original.songloft;
  }
}

test('status stream skips overlapping ticks during a slow query', async () => {
  await withStream(async h => {
    const connection = h.connect();
    await connection.pending;
    const request = deferred();
    h.setRequest(() => request.promise);
    for (let i = 0; i < 10; i++) await h.tick();
    assert.equal(h.calls(), 2);
    request.resolve({ position: 10 });
    await flush();
    assert.equal(connection.sent.length, 2);
    h.setRequest(async () => ({ position: 11 }));
    await h.tick();
    assert.equal(h.calls(), 3);
    connection.close();
    assert.equal(h.timers.size, 0);
  });
});

test('closing during the initial snapshot cannot install an orphan stream timer', async () => {
  await withStream(async h => {
    const request = deferred();
    h.setRequest(() => request.promise);
    const connection = h.connect();
    connection.close();
    request.resolve({ position: 10 });
    await connection.pending;
    assert.equal(h.timers.size, 0);
    assert.equal(connection.sent.length, 0);
  });
});

test('a new subscriber gets its snapshot while another subscriber query is pending', async () => {
  await withStream(async h => {
    const first = h.connect();
    await first.pending;
    const request = deferred();
    h.setRequest(() => request.promise);
    await h.tick();
    const second = h.connect();
    request.resolve({ position: 10 });
    await second.pending;
    assert.ok(second.sent.length >= 1);
    assert.equal(h.timers.size, 1);
    first.close();
    second.close();
    assert.equal(h.timers.size, 0);
  });
});

test('hourly waiting keeps the saved song position even when cached broadcast progress advances', async () => {
  await withStatus(async h => {
    h.manager.isHourlyResumePending = () => true;
    const status = await h.resolve();
    assert.equal(status.position, 20);
    assert.deepEqual(h.resets, []);
  });
});
