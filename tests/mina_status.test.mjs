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
let debugLogging = false;
const { MinaHTTPClient } = loadSource('../src/mina/client.ts', {
  '../playback/device_state': loadSource('../src/playback/device_state.ts', {}),
  '../utils/cookie': { CookieJar: class { } }, '../utils/http': http,
  '../utils/crypto': {}, '../utils/debug': { isDebugLog: () => debugLogging },
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
    const rawMessage = params.get('message');
    requests.push({
      ...request,
      message: rawMessage ? JSON.parse(rawMessage) : undefined,
    });
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

test('debug status reports device fields beyond a long media payload without logging its metadata', async () => {
  await withClient(async h => {
    const marker = 'private-media-metadata';
    const detail = { title: marker.repeat(100), position: 0, duration: 60029 };
    h.setFetch(async () => response(200, { code: 0, data: {
      info: JSON.stringify({ extra_track_list: [{ title: marker.repeat(100) }], status: 2, play_song_detail: detail }),
    } }));

    debugLogging = true;
    try {
      const state = await h.service.getPlayState('account', 'speaker');
      assert.equal(state.status, 2);
      assert.equal(state.position, 0);
      assert.equal(state.duration, 60.029);
      assert.ok(h.logs.some(({ message }) => message.includes('status sample device=speaker status=2 position_ms=0 duration_ms=60029')));
      assert.ok(h.logs.every(({ message }) => !message.includes(marker)));

      h.setFetch(async () => response(200, { code: 0, data: { info: JSON.stringify({ status: 2 }) } }));
      await h.client.getPlayerStatus('speaker', { verify: true });
      assert.ok(h.logs.some(({ message }) => message.includes('status sample device=speaker status=2 position_ms=missing duration_ms=missing')));
    } finally {
      debugLogging = false;
    }
  });
});

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

test('volume control carries the media context and rejects device-level errors', async () => {
  await withClient(async h => {
    h.setFetch(request => {
      if (request.method === 'player_set_volume') {
        return response(200, { code: 0, data: { code: 7, message: 'unsupported' } });
      }
      return response();
    });

    assert.equal(await h.client.setVolume('speaker', 60), false);
    assert.deepEqual(h.requests.at(-1).message, { volume: 60, media: 'app_ios' });
  });
});

test('tail confirmation shares one-second samples and allows only four accelerated requests per control context', async () => {
  await withClient(async h => {
    await h.client.getPlayerStatus('speaker');
    for (let i = 0; i < 4; i++) {
      h.advance(999);
      await h.client.getPlayerStatus('speaker', { tail: true });
      assert.equal(h.requests.length, i + 1);
      h.advance(1);
      const [tail, ui] = await Promise.all([
        h.service.getPlayState('account', 'speaker', { tail: true }),
        h.service.getPlayState('account', 'speaker'),
      ]);
      assert.equal(h.requests.length, i + 2);
      assert.equal(tail.sampledAt, Date.now());
      assert.equal(ui.sampledAt, tail.sampledAt);
    }
    for (let i = 0; i < 4; i++) {
      h.advance(1000);
      await h.client.getPlayerStatus('speaker', { tail: true });
      assert.equal(h.requests.length, 5, 'a frozen tail cannot enable permanent fast polling');
    }
    h.advance(1000);
    await h.client.getPlayerStatus('speaker', { tail: true });
    assert.equal(h.requests.length, 6);
    h.advance(1000);
    await h.client.getPlayerStatus('speaker', { tail: true });
    assert.equal(h.requests.length, 6, 'ordinary samples do not replenish the burst');
    await h.client.playerPlay('speaker');
    assert.equal(await h.client.getPlayerStatus('speaker', { tail: true }), null, 'control cooldown remains');
    await h.client.getPlayerStatus('speaker', { verify: true });
    h.advance(1000);
    await h.client.getPlayerStatus('speaker', { tail: true });
    assert.equal(h.requests.length, 9, 'a new control context has a new bounded budget');
  });
});

test('tail confirmation cannot bypass failure backoff or make ordinary consumers poll faster', async () => {
  await withClient(async h => {
    await h.client.getPlayerStatus('speaker');
    h.advance(1000);
    await h.client.getPlayerStatus('speaker', { tail: true });
    h.advance(1000);
    await h.client.getPlayerStatus('speaker');
    assert.equal(h.requests.length, 2);
    h.setFetch(async () => { throw new Error('cloud unavailable'); });
    await h.client.getPlayerStatus('speaker', { tail: true });
    assert.equal(h.requests.length, 3);
    for (const delay of [5000, 60000]) {
      const count = h.requests.length;
      h.advance(delay - 1);
      assert.equal(await h.client.getPlayerStatus('speaker', { tail: true }), null);
      assert.equal(h.requests.length, count);
      h.advance(1);
      assert.equal(await h.client.getPlayerStatus('speaker', { tail: true }), null);
      assert.equal(h.requests.length, count + 1);
    }
  });
});

test('a queued control invalidates an accelerated tail query and its late response', async () => {
  await withClient(async h => {
    await h.client.getPlayerStatus('speaker');
    h.advance(1000);
    const slow = deferred();
    h.setFetch(request => request.method === 'player_get_play_status' ? slow.promise : Promise.resolve(response()));
    const tail = h.client.getPlayerStatus('speaker', { tail: true });
    await flush();
    const control = h.client.playerPlay('speaker');
    slow.resolve(response());
    const [tailResult, controlResult] = await Promise.all([tail, control]);
    assert.equal(tailResult, null);
    assert.equal(controlResult, true);
    assert.equal(h.requests.length, 3);
    assert.equal(await h.client.getPlayerStatus('speaker', { tail: true }), null);
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

test('hourly three-second samples share UI requests without changing ordinary cache lifetime', async () => {
  await withClient(async h => {
    const sample = await h.service.getPlayerStatus('account', 'speaker');
    h.advance(2999);
    assert.equal(await h.client.getPlayerStatus('speaker', { maxAgeMs: 3000 }), sample);
    assert.equal(h.requests.length, 1);
    h.advance(1);
    const slow = deferred();
    h.setFetch(() => slow.promise);
    const probes = Array.from({ length: 20 }, () => h.service.getPlayState('account', 'speaker', { maxAgeMs: 3000 }));
    const ui = h.service.getPlayerStatus('account', 'speaker');
    await flush();
    assert.equal(h.requests.length, 2, 'hourly poll refreshes the sample at three seconds');
    slow.resolve(response());
    const states = await Promise.all(probes);
    assert.ok(states.every(state => state.sampledAt === 103000));
    const refreshed = await ui;
    h.advance(4999);
    assert.equal(await h.client.getPlayerStatus('speaker'), refreshed);
    assert.equal(h.requests.length, 2, 'ordinary polling still caches for five seconds');
    h.advance(1);
    await h.client.getPlayerStatus('speaker');
    assert.equal(h.requests.length, 3);
  });
});

for (const maxAgeMs of [0, 1, 3000]) {
  test(`short sample age ${maxAgeMs} never bypasses any failure backoff`, async () => {
    await withClient(async h => {
      h.setFetch(async () => { throw new Error('timeout'); });
      for (const delay of [5000, 60000, 300000, 600000]) {
        assert.equal(await h.client.getPlayerStatus('speaker', { maxAgeMs }), null);
        const calls = h.requests.length;
        h.advance(delay - 1);
        assert.equal(await h.client.getPlayerStatus('speaker', { maxAgeMs }), null);
        assert.equal(h.requests.length, calls);
        h.advance(1);
      }
      h.setFetch(async () => response());
      assert.ok(await h.client.getPlayerStatus('speaker', { maxAgeMs }));
    });
  });
}

for (const maxAgeMs of [0, 1, 1000, 2999, NaN, Infinity, 60000]) {
  test(`sample age ${maxAgeMs} cannot increase traffic beyond the three-second minimum`, async () => {
    await withClient(async h => {
      const sample = await h.client.getPlayerStatus('speaker', { maxAgeMs });
      h.advance(2999);
      assert.equal(await h.client.getPlayerStatus('speaker', { maxAgeMs }), sample);
      assert.equal(h.requests.length, 1);
      h.advance(2001);
      await h.client.getPlayerStatus('speaker', { maxAgeMs });
      assert.equal(h.requests.length, 2);
    });
  });
}

test('three-second cache requests cannot reuse or shorten the wait after a control', async () => {
  await withClient(async h => {
    await h.client.getPlayerStatus('speaker');
    await h.client.playerPlay('speaker');
    h.advance(3000);
    const calls = h.requests.length;
    assert.equal(await h.client.getPlayerStatus('speaker', { maxAgeMs: 3000 }), null);
    assert.equal(h.requests.length, calls);
    h.advance(2000);
    assert.ok(await h.client.getPlayerStatus('speaker', { maxAgeMs: 3000 }));
    assert.equal(h.requests.length, calls + 1);
  });
});

for (const deviceData of [JSON.stringify({ code: 3012, msg: '远程控制超时' }), { code: 3012 }]) {
  test(`TTS timeout is unconfirmed and does not resend through another endpoint (${typeof deviceData})`, async () => {
    await withClient(async h => {
      h.service.getDeviceIdentity = async () => ({ hardware: '', miotDID: '' });
      h.setFetch(async () => response(200, { code: 101, data: { device_data: deviceData } }));
      assert.equal(await h.service.textToSpeech('account', 'speaker', '回答'), null);
      assert.deepEqual(h.requests.map(r => r.method), ['text_to_speech']);
      assert.ok(!h.logs.some(log => log.message.includes('failed on all endpoints')));
    });
  });
}

for (const body of [
  { code: 0, data: { code: 900 } },
  { code: 0, data: { device_data: JSON.stringify({ code: 900 }) } },
  { code: 101, data: { device_data: JSON.stringify({ code: 900 }) } },
  { code: 101, data: { device_data: '{broken' } },
]) {
  test(`TTS definite rejection falls back and does not treat device errors as accepted: ${JSON.stringify(body)}`, async () => {
    await withClient(async h => {
      h.setFetch(async r => response(200, r.method === 'text_to_speech' ? body : { code: 0, data: { code: 0 } }));
      assert.equal(await h.client.textToSpeech('speaker', '回答'), true);
      assert.deepEqual(h.requests.map(r => r.method), ['text_to_speech', 'player_play_tts']);
    });
  });
}

test('fallback TTS timeout is also unconfirmed, and two explicit rejections remain failures', async () => {
  await withClient(async h => {
    h.setFetch(async r => response(200, { code: 101, data: { device_data: JSON.stringify({ code: r.method === 'text_to_speech' ? 900 : 3012 }) } }));
    assert.equal(await h.client.textToSpeech('speaker', '回答'), null);
    assert.equal(h.requests.length, 2);
    h.setFetch(async () => response(200, { code: 101, data: { device_data: '{"code":900}' } }));
    assert.equal(await h.client.textToSpeech('speaker', '回答'), false);
    assert.equal(h.requests.length, 4);
  });
});

test('non-TTS timeout keeps the existing control failure semantics', async () => {
  await withClient(async h => {
    h.setFetch(async () => response(200, { code: 101, data: { device_data: '{"code":3012}' } }));
    assert.equal(await h.client.playerStop('speaker'), false);
  });
});

test('real Mina service and speech polling confirm a timed-out TTS using shared fresh samples', async t => {
  const { SpeechService } = loadSource('../src/chat/speech.ts', {});
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await withClient(async h => {
    h.service.getDeviceIdentity = async () => ({ hardware: '', miotDID: '' });
    let statusQueries = 0;
    h.setFetch(async r => response(200, r.method === 'text_to_speech'
      ? { code: 101, data: { device_data: '{"code":3012}' } }
      : { code: 0, data: { info: JSON.stringify({ status: ++statusQueries === 1 ? 1 : 0 }) } }));
    const speech = new SpeechService(h.service);
    let result;
    const pending = speech.speak('短回答', { account: 'account', device: 'speaker', isCurrent: () => true }).then(value => { result = value; });
    await flush();
    for (let i = 0; i < 10; i++) {
      h.advance(1000);
      t.mock.timers.tick(1000);
      await flush();
    }
    assert.equal(result, undefined, 'a cached idle sample must not count twice');
    h.advance(1000);
    t.mock.timers.tick(1000);
    await flush();
    await pending;
    assert.equal(result, 'completed');
    assert.equal(h.requests.filter(r => r.method === 'text_to_speech').length, 1);
    assert.equal(h.requests.filter(r => r.method === 'player_play_tts').length, 0);
    assert.equal(statusQueries, 3);
  });
});
