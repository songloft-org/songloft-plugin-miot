import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { loader } from './chat_loader.mjs';

const load = loader();
const { AIChatService } = load('../src/chat/service.ts');
const { DEFAULT_CHAT_CONFIG } = load('../src/chat/types.ts');

const require = createRequire(import.meta.url);
const ts = require('typescript');
function loadSource(path, dependencies) {
  const { outputText } = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  });
  const exports = {};
  new Function('require', 'exports', outputText)(name => {
    assert.ok(Object.hasOwn(dependencies, name), `unexpected dependency: ${name}`);
    return dependencies[name];
  }, exports);
  return exports;
}
const constants = loadSource('../src/mina/constants.ts', { '../data/tts-commands.json': { default: {} } });
const http = {};
const { MinaHTTPClient } = loadSource('../src/mina/client.ts', {
  '../playback/device_state': loadSource('../src/playback/device_state.ts', {}),
  '../utils/cookie': { CookieJar: class { } }, '../utils/http': http,
  '../utils/crypto': {}, '../utils/debug': { isDebugLog: () => false },
  './constants': constants, '../miio/client': {},
});
const { MinaService } = loadSource('../src/service/service.ts', {
  '../mina/auth': {}, '../mina/constants': constants,
});
const { PlaybackCoordinator } = loadSource('../src/playback/coordinator.ts', {
  '../chat/types': { chatScope: (account, device) => JSON.stringify([account, device]) },
});
const cacheWrites = [];
const { registerDeviceHandlers } = loadSource('../src/handlers/device.ts', {
  '@songloft/plugin-sdk': { jsonResponse: body => body },
  './playlist': { updateDeviceStatusCache: (...args) => cacheWrites.push(args) },
});
async function flush() {
  for (let i = 0; i < 100; i++) await Promise.resolve();
}
function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}
function response(code = 0) {
  return { response: { status: 200, text: () => JSON.stringify({ code: 0, data: { code } }) } };
}
async function harness(run) {
  const original = { songloft: globalThis.songloft, setTimeout, now: Date.now, fetch: http.fetchWithRedirects };
  let now = 100000, timerId = 0;
  const timers = new Map(), requests = [];
  const stored = new Map();
  globalThis.songloft = {
    log: { info() { }, warn() { }, error() { } }, storage: {
      get: async key => stored.get(key) ?? null,
      set: async (key, value) => { stored.set(key, value); },
    }
  };
  Date.now = () => now;
  globalThis.setTimeout = (fn, delay) => {
    const id = ++timerId;
    timers.set(id, { at: now + delay, fn });
    return id;
  };
  let fetcher = async () => response();
  http.fetchWithRedirects = async (_url, options) => {
    const params = new URLSearchParams(options.body);
    const message = JSON.parse(params.get('message'));
    const request = { device: params.get('deviceId'), method: params.get('method'), action: message.action, at: now };
    requests.push(request);
    return fetcher(request);
  };
  const client = new MinaHTTPClient({
    user_id: 'test', device_id: 'test', services: { [constants.MINA_SID]: { service_token: 'test' } },
  });
  let currentClient = client;
  const service = new MinaService({ getMinaClient: () => currentClient }, { getConfig: async () => ({}) });
  service.getDeviceIdentity = async () => ({ hardware: '', miotDID: '' });
  const advance = async ms => {
    now += ms;
    for (const [id, timer] of timers) {
      if (timer.at <= now) {
        timers.delete(id);
        timer.fn();
      }
    }
    await flush();
  };
  try {
    await run({ client, service, requests, timers, advance, setFetch: fn => { fetcher = fn; }, setClient: value => { currentClient = value; } });
    assert.equal(service.interruptions.size, 0, 'interrupt tasks must be released');
    assert.equal(timers.size, 0, 'waits must finish');
    assert.equal(client.ubusQueues.size, 0, 'device queues must drain');
  } finally {
    globalThis.songloft = original.songloft;
    globalThis.setTimeout = original.setTimeout;
    Date.now = original.now;
    http.fetchWithRedirects = original.fetch;
  }
}
const actions = h => h.requests.map(r => r.action || r.method);

test('chat takeover sends only the two interrupt rounds through the real Mina client', async () => {
  await harness(async h => {
    const manager = {
      getPosition: () => 43, getPlaybackRevision: () => 1,
      isPlaying: () => true, isExternalPlayback: () => false,
      cancelHourlyResume() {}, reserveForVoiceInteraction() {},
      setInteractionGuard: () => () => {},
    };
    const playback = new PlaybackCoordinator({ get: () => manager }, h.service, { findDeviceGroup: async () => null });
    const token = playback.token('chat', 'a', 'd');
    const pending = playback.prepare(token);
    await flush();
    assert.deepEqual(actions(h), ['pause', 'stop']);
    await h.advance(600);
    await pending;
    assert.deepEqual(actions(h), ['pause', 'stop', 'pause', 'stop']);
    assert.equal(token.isCurrent(), true);
    assert.equal(token.position, 43);
    assert.equal(token.restore, true);
    playback.close();
  });
});

test('interrupt sends exactly two stop rounds, waits 600ms after the first acknowledgment, and responds after the second', async () => {
  await harness(async h => {
    const firstStop = deferred();
    h.setFetch(r => r.action === 'stop' && h.requests.length === 2 ? firstStop.promise : response());
    let finished = false;
    const pending = h.service.interruptAnswer('a', 'd').then(result => { finished = true; return result; });
    await flush();
    assert.deepEqual(actions(h), ['pause', 'stop']);
    assert.equal(h.timers.size, 0);
    await h.advance(3000);
    firstStop.resolve(response());
    await flush();
    await h.advance(599);
    assert.deepEqual(actions(h), ['pause', 'stop']);
    assert.equal(finished, false);
    await h.advance(1);
    assert.deepEqual(await pending, { status: 'accepted', stop_rounds: 2 });
    assert.deepEqual(actions(h), ['pause', 'stop', 'pause', 'stop']);
    assert.equal(h.requests[2].at, 103600);
  });
});

for (const failingStop of [1, 2]) {
  test(`stop rejection in round ${failingStop} is reported without further retries`, async () => {
    await harness(async h => {
      let stops = 0;
      h.setFetch(r => response(r.action === 'stop' && ++stops === failingStop ? 1 : 0));
      const pending = h.service.interruptAnswer('a', 'd');
      await flush();
      if (failingStop === 2) await h.advance(600);
      assert.deepEqual(await pending, { status: 'failed', stop_rounds: failingStop - 1 });
      assert.equal(h.requests.length, failingStop * 2 + 1, 'one inconclusive status read must not turn rejection into success');
    });
  });
}

test('rejected pause still attempts stop for firmware compatibility', async () => {
  await harness(async h => {
    h.setFetch(r => response(r.action === 'pause' ? 1 : 0));
    const pending = h.service.interruptAnswer('a', 'd');
    await flush();
    await h.advance(2000);
    assert.deepEqual(await pending, { status: 'accepted', stop_rounds: 2 });
  });
});

function statusResponse(status) {
  return { response: { status: 200, text: () => JSON.stringify({ code: 0, data: { info: JSON.stringify({ status }) } }) } };
}

for (const code of [114, 123, 131]) {
  for (const status of [0, 2, 3]) {
    test(`nonzero stop code ${code} with two fresh idle ${status} reads still completes both interrupt rounds`, async () => {
      await harness(async h => {
        h.setFetch(r => r.method === 'player_get_play_status' ? statusResponse(status) : response(code));
        const pending = h.service.interruptAnswer('a', 'd');
        await flush();
        assert.deepEqual(actions(h), ['pause', 'stop', 'player_get_play_status']);
        await h.advance(700);
        assert.deepEqual(actions(h), ['pause', 'stop', 'player_get_play_status', 'player_get_play_status']);
        await h.advance(600);
        await h.advance(700);
        assert.deepEqual(await pending, { status: 'accepted', stop_rounds: 2 });
        assert.equal(h.requests.filter(r => r.action === 'stop').length, 2);
        assert.equal(h.requests.filter(r => r.method === 'player_get_play_status').length, 4);
      });
    });
  }
}

for (const statuses of [[1], [-1], [9], [0, 1], [0, -1]]) {
  test(`rejected stop remains failed for status sequence ${statuses}`, async () => {
    await harness(async h => {
      let reads = 0;
      h.setFetch(r => r.method === 'player_get_play_status' ? statusResponse(statuses[reads++]) : response(123));
      const pending = h.service.interruptAnswer('a', 'd');
      await flush();
      if (statuses.length > 1) await h.advance(700);
      assert.deepEqual(await pending, { status: 'failed', stop_rounds: 0 });
      assert.equal(reads, statuses.length);
      assert.equal(h.requests.filter(r => r.action === 'stop').length, 1);
    });
  });
}

test('pre-stop idle cache cannot confirm a rejected interruption', async () => {
  await harness(async h => {
    h.setFetch(() => statusResponse(0));
    await h.client.getPlayerStatus('d');
    h.setFetch(r => r.method === 'player_get_play_status' ? statusResponse(1) : response(131));
    assert.deepEqual(await h.service.interruptAnswer('a', 'd'), { status: 'failed', stop_rounds: 0 });
    assert.deepEqual(actions(h), ['player_get_play_status', 'pause', 'stop', 'player_get_play_status']);
  });
});

test('a new operation cancels rejected-stop verification before the next read and second stop', async () => {
  await harness(async h => {
    h.setFetch(r => r.method === 'player_get_play_status' ? statusResponse(0) : response(123));
    let current = true;
    const pending = h.service.interruptAnswer('a', 'd', () => current);
    await flush();
    current = false;
    await h.advance(700);
    assert.deepEqual(await pending, { status: 'cancelled', stop_rounds: 0 });
    assert.deepEqual(actions(h), ['pause', 'stop', 'player_get_play_status']);
  });
});

for (const cancelledRead of [1, 2]) {
  test(`cancellation during rejected-stop status read ${cancelledRead} discards the late idle result`, async () => {
    await harness(async h => {
      const slow = deferred();
      let reads = 0, current = true;
      h.setFetch(r => r.method === 'player_get_play_status'
        ? ++reads === cancelledRead ? slow.promise : statusResponse(0) : response(123));
      const pending = h.service.interruptAnswer('a', 'd', () => current);
      await flush();
      if (cancelledRead === 2) await h.advance(700);
      current = false;
      slow.resolve(statusResponse(0));
      await flush();
      assert.deepEqual(await pending, { status: 'cancelled', stop_rounds: 0 });
      assert.equal(reads, cancelledRead);
      assert.equal(h.requests.filter(r => r.action === 'stop').length, 1);
    });
  });
}

test('ordinary stop and group interaction stop retain strict rejection semantics', async () => {
  await harness(async h => {
    h.setFetch(() => response(123));
    assert.equal(await h.service.stopPlay('a', 'd'), false);
    assert.equal(await h.service.stopForInteraction('a', 'd', () => true), 'failed');
    assert.deepEqual(actions(h), ['pause', 'stop', 'pause', 'stop']);
  });
});

test('cloud rejection does not probe idle to manufacture successful interruption', async () => {
  await harness(async h => {
    h.setFetch(() => ({ response: { status: 200, text: () => JSON.stringify({ code: 101, data: { code: 123 } }) } }));
    assert.deepEqual(await h.service.interruptAnswer('a', 'd'), { status: 'failed', stop_rounds: 0 });
    assert.deepEqual(actions(h), ['pause', 'stop']);
  });
});

test('HD-style rejected stops reach AI answer dispatch only after both verified rounds', async () => {
  await harness(async h => {
    h.setFetch(r => r.method === 'player_get_play_status' ? statusResponse(0)
      : response(r.action === 'stop' || r.action === 'pause' ? 123 : 0));
    const config = {
      findDeviceGroup: async () => null,
      getChatConfig: async () => ({
        ...DEFAULT_CHAT_CONFIG, enabled: true, waiting_feedback: false,
        memory_enabled: false, summary_enabled: false, connection: 'independent',
        api_url: 'https://model.test/v1', api_key: 'test-only', model: 'test'
      }),
      getAIConfig: async () => ({}),
    };
    const playback = new PlaybackCoordinator({ get: () => null }, h.service, config);
    const speech = {
      // Use the real TTS dispatch; speech completion itself remains simulated.
      speak: async (text, token, current) => await h.service.textToSpeech(token.account, token.device, text, current) ? 'completed' : 'failed',
      stop: async () => { },
    };
    const chat = new AIChatService(config, playback, speech);
    chat.client.request = async () => '回归测试回答';
    try {
      await chat.submit('a', 'd', '测试问题');
      await h.advance(0);
      await h.advance(700);
      await h.advance(600);
      assert.equal(chat.status('a', 'd').phase, 'preparing');
      assert.ok(!actions(h).includes('text_to_speech'));
      await h.advance(700);
      assert.equal(chat.status('a', 'd').phase, 'completed');
      assert.equal(chat.status('a', 'd').answer, '回归测试回答');
      assert.deepEqual(actions(h).filter(a => a === 'stop' || a === 'text_to_speech'), ['stop', 'stop', 'text_to_speech']);
    } finally {
      chat.close();
      playback.close();
    }
  });
});

test('failed status device result cannot confirm a rejected stop even with an idle info field', async () => {
  await harness(async h => {
    h.setFetch(r => r.method === 'player_get_play_status'
      ? { response: { status: 200, text: () => JSON.stringify({ code: 0, data: { code: 1, info: '{"status":0}' } }) } }
      : response(131));
    assert.deepEqual(await h.service.interruptAnswer('a', 'd'), { status: 'failed', stop_rounds: 0 });
  });
});

test('missing client and transport failures return failure and release tasks', async () => {
  await harness(async h => {
    h.setClient(null);
    assert.deepEqual(await h.service.interruptAnswer('a', 'd'), { status: 'failed', stop_rounds: 0 });
    h.setClient(h.client);
    h.setFetch(() => { throw new Error('network failure'); });
    assert.deepEqual(await h.service.interruptAnswer('a', 'd'), { status: 'failed', stop_rounds: 0 });
  });
});

test('unexpected client exception returns failure and releases the interrupt ticket', async () => {
  await harness(async h => {
    h.client.playerStopGuarded = async () => { throw new Error('unexpected client failure'); };
    assert.deepEqual(await h.service.interruptAnswer('a', 'd'), { status: 'failed', stop_rounds: 0 });
  });
});

for (const operation of ['playURL', 'resumePlay', 'pausePlay', 'pausePlayVerified', 'stopPlay', 'textToSpeech']) {
  test(`${operation} cancels unsent interrupt commands before any asynchronous preparation`, async () => {
    await harness(async h => {
      const pending = h.service.interruptAnswer('a', 'd');
      await flush();
      const preparation = deferred();
      if (operation === 'pausePlayVerified') h.client.playerPauseVerified = async () => 'paused';
      if (operation === 'playURL' || operation === 'textToSpeech') h.service.getDeviceIdentity = () => preparation.promise;
      const args = operation === 'playURL' ? ['a', 'd', 'http://example.test/song.mp3'] : operation === 'textToSpeech' ? ['a', 'd', 'hello'] : ['a', 'd'];
      const newer = h.service[operation](...args);
      await flush();
      const before = h.requests.length;
      await h.advance(2000);
      assert.deepEqual(await pending, { status: 'cancelled', stop_rounds: 1 });
      assert.equal(h.requests.length, before, 'second stop must not be sent');
      preparation.resolve({ hardware: '', miotDID: '' });
      await newer;
    });
  });
}

test('new interrupt supersedes the old task without letting old cleanup delete the new task', async () => {
  await harness(async h => {
    const old = h.service.interruptAnswer('a', 'd');
    await flush();
    await h.advance(300);
    const newer = h.service.interruptAnswer('a', 'd');
    await flush();
    await h.advance(300);
    assert.deepEqual(await old, { status: 'cancelled', stop_rounds: 1 });
    assert.equal(h.service.interruptions.size, 1);
    await h.advance(600);
    assert.deepEqual(await newer, { status: 'accepted', stop_rounds: 2 });
    assert.deepEqual(actions(h), ['pause', 'stop', 'pause', 'stop', 'pause', 'stop']);
  });
});

test('client replacement cancels a pending repeat', async () => {
  await harness(async h => {
    const pending = h.service.interruptAnswer('a', 'd');
    await flush();
    h.setClient(null);
    await h.advance(2000);
    assert.deepEqual(await pending, { status: 'cancelled', stop_rounds: 1 });
    assert.deepEqual(actions(h), ['pause', 'stop']);
  });
});

test('other devices, accounts, volume changes, and status reads do not cancel an interrupt', async () => {
  await harness(async h => {
    const pending = h.service.interruptAnswer('a', 'd');
    await flush();
    await h.service.stopPlay('a', 'other-device');
    await h.service.stopPlay('other-account', 'd');
    await h.client.setVolume('d', 50);
    await h.client.getPlayerStatus('d');
    await h.advance(2000);
    assert.deepEqual(await pending, { status: 'accepted', stop_rounds: 2 });
  });
});

test('queued repeat pause is rechecked at dispatch, so newer playback stays last', async () => {
  await harness(async h => {
    const pending = h.service.interruptAnswer('a', 'd');
    await flush();
    const slowVolume = deferred();
    h.setFetch(r => r.method === 'player_set_volume' ? slowVolume.promise : response());
    const volume = h.client.setVolume('d', 50);
    await flush();
    await h.advance(2000);
    const newer = h.service.resumePlay('a', 'd');
    await flush();
    slowVolume.resolve(response());
    await volume;
    await newer;
    assert.deepEqual(await pending, { status: 'cancelled', stop_rounds: 1 });
    assert.deepEqual(actions(h), ['pause', 'stop', 'player_set_volume', 'play']);
  });
});

test('new operation during an in-flight repeat pause prevents the following stop', async () => {
  await harness(async h => {
    const pending = h.service.interruptAnswer('a', 'd');
    await flush();
    const slowPause = deferred();
    h.setFetch(r => r.action === 'pause' ? slowPause.promise : response());
    await h.advance(600);
    const newer = h.service.resumePlay('a', 'd');
    slowPause.resolve(response());
    await newer;
    assert.deepEqual(await pending, { status: 'cancelled', stop_rounds: 1 });
    assert.deepEqual(actions(h), ['pause', 'stop', 'pause', 'play']);
  });
});

test('a queued stop is rechecked even when its pause has already completed', async () => {
  await harness(async h => {
    const slowPause = deferred(), slowVolume = deferred();
    h.setFetch(r => r.action === 'pause' ? slowPause.promise
      : r.method === 'player_set_volume' ? slowVolume.promise : response());
    const pending = h.service.interruptAnswer('a', 'd');
    await flush();
    const volume = h.client.setVolume('d', 50);
    slowPause.resolve(response());
    await flush();
    const newer = h.service.resumePlay('a', 'd');
    slowVolume.resolve(response());
    await volume;
    await newer;
    assert.deepEqual(await pending, { status: 'cancelled', stop_rounds: 0 });
    assert.deepEqual(actions(h), ['pause', 'player_set_volume', 'play']);
  });
});

for (const action of ['pause', 'stop']) {
  test(`token refresh cannot resend a superseded ${action} command`, async () => {
    await harness(async h => {
      const refresh = deferred();
      h.client.setOnTokenExpired(() => refresh.promise);
      h.setFetch(r => r.action === action
        ? { response: { status: 401, text: () => '' } } : response());
      const pending = h.service.interruptAnswer('a', 'd');
      await flush();
      const newer = h.service.resumePlay('a', 'd');
      refresh.resolve(true);
      await newer;
      assert.deepEqual(await pending, { status: 'cancelled', stop_rounds: 0 });
      assert.deepEqual(actions(h), action === 'pause' ? ['pause', 'play'] : ['pause', 'stop', 'play']);
    });
  });
}

test('token refresh retries a current interrupt command and completes both rounds', async () => {
  await harness(async h => {
    let refreshed = false;
    h.client.setOnTokenExpired(async () => { refreshed = true; return true; });
    h.setFetch(() => refreshed ? response() : { response: { status: 401, text: () => '' } });
    const pending = h.service.interruptAnswer('a', 'd');
    await flush();
    await h.advance(600);
    assert.deepEqual(await pending, { status: 'accepted', stop_rounds: 2 });
    assert.deepEqual(actions(h), ['pause', 'pause', 'stop', 'pause', 'stop']);
  });
});

test('ordinary stop and URL replacement retain one immediate stop round', async () => {
  await harness(async h => {
    assert.equal(await h.service.stopPlay('a', 'd'), true);
    assert.equal(await h.service.playURL('a', 'd', 'http://example.test/song.mp3'), true);
    assert.deepEqual(actions(h), ['pause', 'stop', 'pause', 'stop', 'player_play_url']);
  });
});

test('registered endpoint waits for both real service rounds and accepts a byte-array body', async () => {
  await harness(async h => {
    const routes = new Map();
    registerDeviceHandlers({ get() { }, post: (path, handler) => routes.set(path, handler) }, h.service, {}, {}, {});
    let finished = false;
    const body = new TextEncoder().encode(JSON.stringify({ account_id: 'a', device_id: 'd' }));
    const pending = routes.get('/mina/interrupt')({ body }).then(result => { finished = true; return result; });
    await flush();
    assert.equal(finished, false);
    await h.advance(600);
    assert.equal((await pending).success, true);
    assert.deepEqual(actions(h), ['pause', 'stop', 'pause', 'stop']);
  });
});

test('handler validates IDs, exposes failures and cancellation, and never claims cached silence', async () => {
  const routes = new Map();
  const calls = [];
  let result = { status: 'accepted', stop_rounds: 2 };
  const service = { interruptAnswer: async (...args) => { calls.push(args); return result; } };
  registerDeviceHandlers({ get() { }, post: (path, handler) => routes.set(path, handler) }, service, {}, {}, {});
  const handler = routes.get('/mina/interrupt');
  const invoke = body => handler({ body: JSON.stringify(body) });
  cacheWrites.length = 0;
  for (const body of [{}, { account_id: 1 }, { account_id: ' ' }, { account_id: 'a' }, { account_id: 'a', device_id: {} }]) {
    assert.equal((await invoke(body)).success, false);
  }
  assert.equal((await handler({ body: '{invalid json' })).success, false);
  assert.equal(calls.length, 0);
  assert.deepEqual(await invoke({ account_id: 'a', device_id: 'd' }), {
    success: true, data: { message: 'interrupt commands accepted', stop_rounds: 2, cancelled: false },
  });
  assert.deepEqual(calls[0], ['a', 'd']);
  result = { status: 'failed', stop_rounds: 1 };
  assert.deepEqual(await invoke({ account_id: 'a', device_id: 'd' }), {
    success: false, error: 'failed to interrupt', data: { stop_rounds: 1, cancelled: false },
  });
  result = { status: 'cancelled', stop_rounds: 1 };
  assert.deepEqual(await invoke({ account_id: 'a', device_id: 'd' }), {
    success: false, error: 'interrupt superseded by a newer operation', data: { stop_rounds: 1, cancelled: true },
  });
  service.interruptAnswer = async () => { throw new Error('unexpected failure'); };
  assert.deepEqual(await invoke({ account_id: 'a', device_id: 'd' }), { success: false, error: 'unexpected failure' });
  assert.deepEqual(cacheWrites, []);
});

test('queued TTS rechecks interaction identity before dispatch', async () => {
  await harness(async h => {
    const slow = deferred();
    h.setFetch(r => r.method === 'player_set_volume' ? slow.promise : response());
    const volume = h.client.setVolume('d', 40); await flush();
    let current = true;
    const tts = h.client.textToSpeech('d', 'old answer', { isCurrent: () => current }); await flush();
    current = false; slow.resolve(response()); await volume;
    assert.equal(await tts, false);
    assert.deepEqual(actions(h), ['player_set_volume']);
  });
});
test('TTS identity cancelled during device preparation sends no answer', async () => {
  await harness(async h => {
    const preparation = deferred(); let current = true;
    h.service.getDeviceIdentity = () => preparation.promise;
    const tts = h.service.textToSpeech('a', 'd', 'old answer', () => current); await flush();
    current = false; preparation.resolve({ hardware: '', miotDID: '' });
    assert.equal(await tts, false); assert.equal(h.requests.length, 0);
  });
});

test('queued resume rechecks cancellation before the device play request', async () => {
  await harness(async h => {
    const slow = deferred();
    h.setFetch(r => r.method === 'player_set_volume' ? slow.promise : response());
    const volume = h.client.setVolume('d', 40); await flush();
    let current = true;
    const resume = h.client.playerResume('d', () => current); await flush();
    current = false; slow.resolve(response()); await volume;
    assert.equal(await resume, false);
    assert.deepEqual(actions(h), ['player_set_volume']);
  });
});

test('TTS endpoint reports unconfirmed delivery and does not repeat a 3012 command', async () => {
  await harness(async h => {
    h.setFetch(() => ({ response: { status: 200, text: () => JSON.stringify({ code: 101, data: { device_data: '{"code":3012}' } }) } }));
    const routes = new Map();
    registerDeviceHandlers({ get() { }, post: (path, handler) => routes.set(path, handler) }, h.service, {}, {}, {});
    const result = await routes.get('/mina/tts')({ body: JSON.stringify({ account_id: 'a', device_id: 'd', text: '回答' }) });
    assert.equal(result.status, 'unknown');
    assert.equal(result.success, false);
    assert.match(result.error, /unconfirmed/);
    assert.deepEqual(actions(h), ['text_to_speech']);
  });
});
