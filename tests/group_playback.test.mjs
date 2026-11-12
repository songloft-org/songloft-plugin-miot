import assert from 'node:assert/strict';
import test from 'node:test';
import { loader, flush, deferred } from './chat_loader.mjs';

const http = {
  getHostBaseUrl: () => 'http://host.test',
  callHostAPI: async () => ({}),
};
const load = loader({
  '../utils/http': http,
  '../utils/cookie': { CookieJar: class { } },
  '../utils/debug': { isDebugLog: () => false },
});
const { MinaHTTPClient } = load('../src/mina/client.ts');
const { MinaService } = load('../src/service/service.ts');
const { PlaylistManager } = load('../src/player/manager.ts');
const { GroupCoordinator } = load('../src/group/coordinator.ts');
const { OnlineSearcher } = load('../src/voicecmd/online_searcher.ts');
const { registerDeviceHandlers } = load('../src/handlers/device.ts');
const targets = [
  { account_id: 'account', device_id: 'LX06' },
  { account_id: 'account', device_id: 'OH2P' },
];
const url = 'http://host.test/song.mp3?seek=42&speed=2';
const metadata = { title: 'test song', artist: 'test artist' };
const isPlay = r => ['player_play_music', 'player_play_url'].includes(r.method);
const actions = rows => rows.map(r => r.action || r.method);
const response = (body = { code: 0, data: { code: 0 } }) => ({
  response: { status: 200, text: () => JSON.stringify(body) },
});

async function fixture(run, config = {}) {
  const original = { now: Date.now, songloft: globalThis.songloft, setTimeout, clearTimeout, fetch: http.fetchWithRedirects };
  let now = 100000, nextTimer = 0;
  const timers = new Map(), requests = [], logs = [];
  Date.now = () => now;
  globalThis.songloft = {
    log: Object.fromEntries(['info', 'warn', 'error'].map(level => [level, text => logs.push(text)])),
    plugin: { getToken: async () => 'fixture-token' },
  };
  globalThis.setTimeout = (fn, delay) => {
    timers.set(++nextTimer, { fn, at: now + delay });
    return nextTimer;
  };
  globalThis.clearTimeout = id => timers.delete(id);
  let fetcher = async () => response();
  http.fetchWithRedirects = async (_url, options) => {
    const params = new URLSearchParams(options.body);
    const message = JSON.parse(params.get('message'));
    const request = { device: params.get('deviceId'), method: params.get('method'), action: message.action, message, at: now };
    requests.push(request);
    return fetcher(request);
  };
  const client = new MinaHTTPClient({ user_id: 'fixture', device_id: 'fixture', services: { micoapi: { service_token: 'fixture' } } });
  const clients = new Map([['account', client]]);
  const configs = {
    getConfig: async () => config,
    findDeviceGroup: async () => ({ members: targets }),
    updateDevice: async () => { },
    savePlaylistProgress: async () => { },
  };
  const service = new MinaService({ getMinaClient: a => clients.get(a) }, configs);
  for (const t of targets) {
    service.deviceModelCache.set(t.device_id, t.device_id);
    service.deviceMiotDIDCache.set(t.device_id, 'fixture-did');
  }
  const group = new GroupCoordinator({}, service, configs);
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const advance = async ms => {
    const end = now + ms;
    while (true) {
      const next = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      const [id, timer] = next;
      timers.delete(id);
      now = timer.at;
      timer.fn();
      await flush();
    }
    now = end;
    await flush();
  };
  try {
    await run({ client, clients, service, group, configs, requests, logs, delay, advance, setFetch: fn => { fetcher = fn; } });
    assert.equal(client.ubusQueues.size, 0, 'all device queues drain');
    assert.equal(timers.size, 0, 'no unowned timers remain');
  } finally {
    Date.now = original.now;
    globalThis.songloft = original.songloft;
    globalThis.setTimeout = original.setTimeout;
    globalThis.clearTimeout = original.clearTimeout;
    http.fetchWithRedirects = original.fetch;
  }
}

for (const hardware of ['LX06', 'OH2P', 'L15A']) {
  test(`Music API replaces playback without pause, stop or status verification (${hardware})`, async () => {
    await fixture(async h => {
      h.service.getDeviceIdentity = async () => ({ hardware });
      assert.equal(await h.service.playURL('account', hardware, url, metadata), true);
      assert.deepEqual(actions(h.requests), ['player_play_music']);
      const music = JSON.parse(h.requests[0].message.music);
      assert.equal(music.play_behavior, 'REPLACE_ALL');
      assert.equal(music.payload.audio_items[0].stream.url, url);
    });
  });
}

test('LX06 + OH2P playlist starts together after twenty minutes idle despite a slow pre-stop endpoint', async () => {
  await fixture(async h => {
    const manager = new PlaylistManager('account', 'LX06', h.service, h.configs);
    manager.setTargets(targets);
    manager.initWithSongs([{ id: 1, title: 'test', duration: 300, type: 'local', url: '/api/v1/songs/1/play' }], 0, 'loop', 1);
    h.setFetch(async r => {
      if (r.action && r.device === 'LX06') await h.delay(1800);
      return response();
    });
    try {
      for (const idle of [0, 20 * 60 * 1000]) {
        await h.advance(idle);
        const start = Date.now();
        const play = manager.playCurrent({ seekSeconds: 42, speed: 2, skipAnnouncement: true });
        await flush();
        const sent = h.requests.filter(isPlay).slice(-2);
        assert.deepEqual(sent.map(r => r.device), ['LX06', 'OH2P']);
        assert.deepEqual(sent.map(r => r.at), [start, start]);
        assert.ok(sent.every(r => JSON.parse(r.message.music).payload.audio_items[0].stream.url.includes('seek=42')));
        assert.equal(await play, true);
        assert.equal(manager.unplayableSongs.size, 0);
        assert.equal(manager.state, 'playing');
        manager.cleanup();
      }
      assert.deepEqual(actions(h.requests), Array(4).fill('player_play_music'));
    } finally { manager.cleanup(); }
  });
});

for (const kind of ['identity', 'lyrics', 'pre-stop', 'inflight status']) {
  test(`group waits for slow ${kind} before sending either member's playback`, async () => {
    await fixture(async h => {
      if (kind === 'identity') h.service.getDeviceIdentity = async (_client, device) => {
        if (device === 'LX06') await h.delay(1800);
        return { hardware: device };
      };
      if (kind === 'lyrics') {
        let searches = 0;
        h.client.searchAudioId = async () => {
          if (++searches === 1) await h.delay(1800);
          return 'matched-audio-id';
        };
      }
      h.setFetch(async r => {
        if (r.device === 'LX06' && ((kind === 'pre-stop' && r.action === 'stop') || (kind === 'inflight status' && r.method === 'player_get_play_status'))) await h.delay(1800);
        return response();
      });
      let status;
      if (kind === 'inflight status') {
        status = h.client.getPlayerStatus('LX06');
        await flush();
      }
      const pending = h.service.playURLs(targets, url, metadata);
      await flush();
      assert.equal(h.requests.filter(isPlay).length, 0, 'fast member must wait for preparation');
      await h.advance(1799);
      assert.equal(h.requests.filter(isPlay).length, 0);
      await h.advance(1);
      assert.deepEqual(await pending, [true, true]);
      await status;
      const plays = h.requests.filter(isPlay);
      assert.equal(plays.length, 2);
      assert.equal(plays[0].at, plays[1].at);
      assert.equal(plays[0].at, 101800);
      assert.equal(plays[0].method, kind === 'pre-stop' ? 'player_play_url' : 'player_play_music');
      assert.equal(plays[1].method, 'player_play_music');
      if (kind === 'pre-stop') assert.deepEqual(actions(h.requests), ['pause', 'stop', 'player_play_url', 'player_play_music']);
    }, { touchscreen_lyrics_enabled: kind === 'lyrics', music_api_model_disabled: kind === 'pre-stop' ? ['LX06'] : [] });
  });
}

test('temporary group URL is sent to followers before the leader acknowledges playback', async () => {
  await fixture(async h => {
    const ack = deferred();
    h.setFetch(r => r.device === 'LX06' ? ack.promise : response());
    const pending = h.group.playURL('account', 'LX06', url, metadata);
    await flush();
    assert.deepEqual(h.requests.filter(isPlay).map(r => r.device), ['LX06', 'OH2P']);
    ack.resolve(response());
    assert.equal(await pending, true);
  });
});

test('a status query started during preparation cannot put one member behind after group release', async () => {
  await fixture(async h => {
    h.service.getDeviceIdentity = async (_client, device) => {
      if (device === 'LX06') await h.delay(1800);
      return { hardware: device };
    };
    h.setFetch(async r => {
      if (r.method === 'player_get_play_status') await h.delay(1800);
      return response();
    });
    const pending = h.service.playURLs(targets, url);
    await flush();
    await h.advance(1000);
    const status = h.client.getPlayerStatus('OH2P');
    await flush();
    await h.advance(1799);
    assert.equal(h.requests.filter(isPlay).length, 0);
    await h.advance(1);
    assert.deepEqual(await pending, [true, true]);
    await status;
    assert.deepEqual(h.requests.filter(isPlay).map(r => r.at), [102800, 102800]);
  });
});

test('HTTP temporary URL handler uses one group playback operation', async () => {
  await fixture(async h => {
    const routes = new Map();
    registerDeviceHandlers({ get() { }, post: (path, handler) => routes.set(path, handler) }, h.service, {}, {}, h.group);
    const result = await routes.get('/mina/play-url')({ body: JSON.stringify({ account_id: 'account', device_id: 'LX06', url }) });
    assert.equal(JSON.parse(result.body).success, true);
    assert.deepEqual(h.requests.filter(isPlay).map(r => r.device), ['LX06', 'OH2P']);
  });
});

test('online search without a playlist starts the whole group before the leader acknowledges', async () => {
  await fixture(async h => {
    const ack = deferred();
    h.setFetch(r => r.device === 'LX06' ? ack.promise : response());
    const searcher = new OnlineSearcher(h.configs, h.group);
    const pending = searcher.playSearchResult({ ...metadata, url, duration: 300 }, 'account', 'LX06', h.service);
    await flush();
    assert.deepEqual(h.requests.filter(isPlay).map(r => r.device), ['LX06', 'OH2P']);
    ack.resolve(response());
    assert.equal(await pending, true);
  }, { external_search_no_import: true });
});

for (const reason of ['caller cancelled', 'client replaced']) {
  test(`prepared group does not start after ${reason}`, async () => {
    await fixture(async h => {
      let current = true;
      const identity = deferred();
      h.service.getDeviceIdentity = async (_client, device) => device === 'LX06' ? identity.promise : { hardware: device };
      const pending = h.service.playURLs(targets, url, metadata, () => current);
      await flush();
      if (reason === 'caller cancelled') current = false;
      else h.clients.delete('account');
      identity.resolve({ hardware: 'LX06' });
      assert.deepEqual(await pending, [false, false]);
      assert.deepEqual(h.requests, []);
    });
  });
}

test('playlist stop during preparation cancels both members before playback dispatch', async () => {
  await fixture(async h => {
    const identity = deferred();
    h.service.getDeviceIdentity = async (_client, device) => device === 'LX06' ? identity.promise : { hardware: device };
    const manager = new PlaylistManager('account', 'LX06', h.service, h.configs);
    manager.setTargets(targets);
    manager.initWithSongs([{ id: 1, title: 'test', duration: 300, type: 'local', url: '/api/v1/songs/1/play' }], 0, 'loop', 1);
    try {
      const pending = manager.playCurrent({ skipAnnouncement: true });
      await flush();
      const stopped = manager.stop();
      identity.resolve({ hardware: 'LX06' });
      await stopped;
      assert.equal(await pending, false);
      assert.equal(h.requests.filter(isPlay).length, 0);
      assert.equal(manager.state, 'stopped');
    } finally { manager.cleanup(); }
  });
});

for (const failure of ['preparation', 'dispatch', 'no client']) {
  test(`one member's ${failure} failure preserves the healthy member's playback and result order`, async () => {
    await fixture(async h => {
      if (failure === 'preparation') h.service.getDeviceIdentity = async (_client, device) => {
        if (device === 'LX06') throw new Error('offline');
        return { hardware: device };
      };
      if (failure === 'dispatch') h.setFetch(r => r.device === 'LX06' ? response({ code: 0, data: { code: 1 } }) : response());
      const members = targets.map(t => ({ ...t }));
      if (failure === 'no client') members[0].account_id = 'missing';
      assert.deepEqual(await h.service.playURLs(members, url), [false, true]);
      assert.ok(h.requests.some(r => isPlay(r) && r.device === 'OH2P'));
    });
  });
}

test('lyrics fallback stops only immediately before the direct URL attempt', async () => {
  await fixture(async h => {
    h.client.searchAudioId = async () => 'matched-audio-id';
    h.setFetch(r => r.method === 'player_play_music' ? response({ code: 0, data: { code: 1 } }) : response());
    assert.equal(await h.service.playURL('account', 'LX06', url, metadata), true);
    assert.deepEqual(actions(h.requests), ['player_play_music', 'player_play_music', 'player_play_music', 'pause', 'stop', 'player_play_url']);
    assert.equal(h.requests.at(-1).message.url, url);
  }, { touchscreen_lyrics_enabled: true });
});

test('explicit pause still verifies status and escalates to stop when ignored', async () => {
  await fixture(async h => {
    h.setFetch(r => response(r.method === 'player_get_play_status'
      ? { code: 0, data: { info: JSON.stringify({ status: 1 }) } } : undefined));
    const pending = h.service.pausePlayVerified('account', 'LX06');
    await flush();
    await h.advance(1400);
    assert.equal(await pending, 'stopped');
    assert.deepEqual(actions(h.requests), ['pause', 'player_get_play_status', 'player_get_play_status', 'stop']);
  });
});

test('duplicate members occupy the device queue once and retain result positions', async () => {
  await fixture(async h => {
    assert.deepEqual(await h.service.playURLs([targets[0], targets[0], targets[1]], url), [true, true, true]);
    assert.deepEqual(h.requests.filter(isPlay).map(r => r.device), ['LX06', 'OH2P']);
  });
});
