import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const ts = require('typescript');
function loadSource(path, dependencies) {
  const { outputText } = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  });
  const exports = {};
  new Function('require', 'exports', outputText)(name => {
    assert.ok(Object.hasOwn(dependencies, name), `unexpected dependency: ${name}`);
    return dependencies[name];
  }, exports);
  return exports;
}
const constants = loadSource('../src/mina/constants.ts', { '../data/tts-commands.json': {} });
const http = { fetchWithRedirects: async () => { throw new Error('unconfigured'); } };
const { MinaHTTPClient } = loadSource('../src/mina/client.ts', {
  '../utils/cookie': { CookieJar: class { } }, '../utils/http': http,
  '../utils/crypto': {}, '../utils/debug': { isDebugLog: () => false },
  './constants': constants, '../miio/client': {},
});
const { MinaService } = loadSource('../src/service/service.ts', {
  '../mina/auth': {}, '../mina/constants': constants,
});
function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}
async function flush() {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}
function response(status = 200, body = {
  code: 0, data: { info: JSON.stringify({ status: 1, volume: 50, play_song_detail: { position: 12000, duration: 300000 } }) },
}) {
  return { response: { status, text: () => JSON.stringify(body) } };
}
async function withClient(run) {
  const original = { now: Date.now, songloft: globalThis.songloft, fetch: http.fetchWithRedirects };
  let now = 100000;
  Date.now = () => now;
  const logs = [];
  globalThis.songloft = { log: Object.fromEntries(['info', 'warn', 'error'].map(level => [level, message => logs.push({ level, message })])) };
  const requests = [];
  let fetcher = async () => response();
  http.fetchWithRedirects = async (url, options) => {
    const params = new URLSearchParams(options.body);
    const request = { url, options, device: params.get('deviceId'), method: params.get('method') };
    requests.push(request);
    return fetcher(request);
  };
  const client = new MinaHTTPClient({
    user_id: 'test', device_id: 'test', services: { [constants.MINA_SID]: { service_token: 'test' } },
  });
  const service = new MinaService({ getMinaClient: () => client }, {});
  try {
    await run({ client, service, requests, logs, advance: ms => { now += ms; }, setFetch: fn => { fetcher = fn; } });
  } finally {
    Date.now = original.now;
    globalThis.songloft = original.songloft;
    http.fetchWithRedirects = original.fetch;
  }
}

test('UI and all playback probes share one request and a five-second sample', async () => {
  await withClient(async h => {
    const slow = deferred();
    h.setFetch(() => slow.promise);
    const probes = Array.from({ length: 20 }, () => h.service.getPlayState('account', 'speaker'));
    const raw = h.service.getPlayerStatus('account', 'speaker');
    await flush();
    assert.equal(h.requests.length, 1);
    slow.resolve(response());
    const states = await Promise.all(probes);
    assert.ok(states.every(state => state.status === 1 && state.position === 12 && state.sampledAt === 100000));
    const sample = await raw;
    h.advance(4999);
    assert.equal(await h.client.getPlayerStatus('speaker'), sample);
    assert.equal(h.requests.length, 1);
    h.advance(1);
    await h.client.getPlayerStatus('speaker');
    assert.equal(h.requests.length, 2);
  });
});

test('active volume readback immediately observes a completed volume control', async () => {
  await withClient(async h => {
    await h.client.getPlayerStatus('speaker');
    assert.equal(await h.client.setVolume('speaker', 60), true);
    h.setFetch(async () => response(200, { code: 0, data: { info: JSON.stringify({ status: 1, volume: 60 }) } }));
    assert.equal(await h.client.getVolume('speaker'), 60);
    assert.equal(h.requests.at(-1).method, 'player_get_play_status');
  });
});

test('voice verification reads fresh idle state instead of the cached pre-interaction playing sample', async () => {
  await withClient(async h => {
    assert.equal((await h.service.getPlayState('account', 'speaker')).status, 1);
    h.advance(1000);
    h.setFetch(async () => response(200, { code: 0, data: { info: JSON.stringify({ status: 2, play_song_detail: { position: 12000, duration: 300000 } }) } }));
    assert.equal((await h.service.getPlayState('account', 'speaker')).status, 1);
    const fresh = await h.service.getPlayState('account', 'speaker', { verify: true });
    assert.equal(fresh.status, 2);
    assert.equal(fresh.sampledAt, 101000);
    assert.equal(h.requests.length, 2);
  });
});

test('successful background samples do not emit repetitive informational logs', async () => {
  await withClient(async h => {
    await h.client.getPlayerStatus('speaker');
    h.advance(5000);
    await h.client.getPlayerStatus('speaker');
    assert.deepEqual(h.logs.filter(log => log.level === 'info'), []);
  });
});

test('four slow queries cannot build a backlog in front of a play operation', async () => {
  await withClient(async h => {
    const slow = deferred();
    h.setFetch(request => request.method === 'player_get_play_status' ? slow.promise : Promise.resolve(response()));
    const reads = Array.from({ length: 4 }, () => h.client.getPlayerStatus('speaker'));
    const play = h.client.playerPlay('speaker');
    await flush();
    assert.equal(h.requests.length, 1);
    slow.resolve(response());
    assert.deepEqual(await Promise.all(reads), [null, null, null, null]);
    assert.equal(await play, true);
    assert.deepEqual(h.requests.map(r => r.method), ['player_get_play_status', 'player_play_operation']);
    assert.equal(h.client.ubusQueues.size, 0);
  });
});

test('queued control overtakes and invalidates a waiting background read', async () => {
  await withClient(async h => {
    const slow = deferred();
    h.setFetch(() => h.requests.length === 1 ? slow.promise : Promise.resolve(response()));
    const play = h.client.playerPlay('speaker');
    const read = h.client.getPlayerStatus('speaker');
    const pause = h.client.playerPause('speaker');
    slow.resolve(response());
    assert.equal(await play, true);
    assert.equal(await pause, true);
    assert.equal(await read, null);
    assert.deepEqual(h.requests.map(r => r.method), ['player_play_operation', 'player_play_operation']);
  });
});

test('verification after control never reuses an old query or sample', async () => {
  await withClient(async h => {
    const slow = deferred();
    h.setFetch(() => h.requests.length === 1 ? slow.promise : Promise.resolve(response()));
    const old = h.client.getPlayerStatus('speaker');
    const pause = h.client.playerPause('speaker');
    const verify = h.client.getPlayerStatus('speaker', { verify: true });
    slow.resolve(response());
    assert.equal(await old, null);
    assert.equal(await pause, true);
    assert.ok(await verify);
    assert.deepEqual(h.requests.map(r => r.method), ['player_get_play_status', 'player_play_operation', 'player_get_play_status']);
    await h.client.playerPlay('speaker');
    assert.equal(await h.client.getPlayerStatus('speaker'), null);
    assert.ok(await h.client.getPlayerStatus('speaker', { verify: true }));
  });
});

test('status failures back off for 5 seconds, 1 minute, 5 minutes, and 10 minutes then recover', async () => {
  await withClient(async h => {
    h.setFetch(async () => { throw new Error('timeout'); });
    for (const delay of [5000, 60000, 300000, 600000, 600000]) {
      assert.equal(await h.client.getPlayerStatus('speaker'), null);
      const calls = h.requests.length;
      h.advance(delay - 1);
      for (let i = 0; i < 10; i++) assert.equal(await h.client.getPlayerStatus('speaker'), null);
      assert.equal(h.requests.length, calls);
      h.advance(1);
    }
    h.setFetch(async () => response());
    assert.ok(await h.client.getPlayerStatus('speaker'));
    h.advance(5000);
    assert.ok(await h.client.getPlayerStatus('speaker'));
  });
});

for (const [label, failure] of [['429', response(429)], ['503', response(503)], ['ubus error', response(200, { code: 101 })], ['missing info', response(200, { code: 0 })], ['invalid JSON', response(200, { code: 0, data: { info: 'broken' } })]]) {
  test(`unusable HTTP/ubus responses enter backoff: ${label}`, async () => {
    await withClient(async h => {
      h.setFetch(async () => failure);
      assert.equal(await h.client.getPlayerStatus('speaker'), null);
      h.advance(4999);
      assert.equal(await h.client.getPlayerStatus('speaker'), null);
      assert.equal(h.requests.length, 1);
    });
  });
}

test('backoff is isolated by device and never blocks user controls or their verification', async () => {
  await withClient(async h => {
    h.setFetch(async request => request.device === 'speaker' && request.method === 'player_get_play_status'
      ? response(429) : response());
    await h.client.getPlayerStatus('speaker');
    h.advance(5000);
    await h.client.getPlayerStatus('speaker');
    assert.ok(await h.client.getPlayerStatus('other'));
    assert.equal(await h.client.playerPlay('speaker'), true);
    const calls = h.requests.length;
    await h.client.getPlayerStatus('speaker');
    assert.equal(h.requests.length, calls);
    h.setFetch(async () => response());
    assert.ok(await h.client.getPlayerStatus('speaker', { verify: true }));
  });
});

test('ubus passes the real five-second network timeout on both initial and token-retry requests', async () => {
  await withClient(async h => {
    h.client.setOnTokenExpired(async () => true);
    h.setFetch(async () => h.requests.length === 1 ? response(401) : response());
    assert.ok(await h.client.getPlayerStatus('speaker'));
    assert.equal(h.requests.length, 2);
    assert.ok(h.requests.every(r => r.options.headers['X-Fetch-Timeout-Ms'] === '5000'));
    await h.client.playerPlay('speaker');
    assert.equal(h.requests.at(-1).options.headers['X-Fetch-Timeout-Ms'], '5000');
    await h.client.searchAudioId('test');
    assert.equal(h.requests.at(-1).options.headers['X-Fetch-Timeout-Ms'], undefined);
  });
});
