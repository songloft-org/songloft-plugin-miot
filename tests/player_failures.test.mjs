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

const http = {
  getHostBaseUrl: () => 'http://speaker.test',
  callHostAPI: async () => ({}),
};
const urls = loadSource('../src/player/url_builder.ts', { '../utils/http': http });
const players = loadSource('../src/player/manager.ts', {
  '../config/manager': { playlistProgressScope: () => 'account:speaker' },
  './url_builder': urls,
  '../utils/http': http,
  '../utils/debug': { isDebugLog: () => false },
});
const { PlaylistManager, PlaylistManagerMap, UNPLAYABLE_SONG_TTL_MS } = players;
const { registerPlaylistHandlers } = loadSource('../src/handlers/playlist.ts', {
  '@songloft/plugin-sdk': { jsonResponse: value => value },
  '../player/manager': players,
  '../config/manager': {},
  '../utils/http': http,
  '../utils/favorites': {},
});
const defaults = loadSource('../src/voicecmd/defaults.ts', {});
const sleepTimer = loadSource('../src/sleep_timer/index.ts', {});
const { VoiceEngine } = loadSource('../src/voicecmd/engine.ts', {
  '../player/manager': players,
  './ai_analyzer': {},
  './online_searcher': {},
  '../handlers/playlist': {},
  '../utils/http': http,
  '../utils/favorites': {},
  '../memory': {},
  '../sleep_timer': sleepTimer,
  './defaults': defaults,
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function flush() {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}

async function withClock(run) {
  const original = {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    now: Date.now,
    random: Math.random,
    songloft: globalThis.songloft,
    callHostAPI: http.callHostAPI,
  };
  let now = 100000;
  let timerId = 0;
  const timers = new Map();
  const logs = [];
  const hostCalls = [];
  Date.now = () => now;
  Math.random = () => 0;
  globalThis.setTimeout = (fn, delay) => {
    timers.set(++timerId, { fn, at: now + delay });
    return timerId;
  };
  globalThis.clearTimeout = id => timers.delete(id);
  globalThis.songloft = {
    log: Object.fromEntries(['info', 'warn', 'error'].map(level => [level, message => logs.push(message)])),
    plugin: { getToken: async () => 'test-token' },
  };
  http.callHostAPI = async (...args) => { hostCalls.push(args); return {}; };
  const advance = async ms => {
    const target = now + ms;
    while (true) {
      const next = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      const [id, timer] = next;
      timers.delete(id);
      now = timer.at;
      timer.fn();
      await flush();
    }
    now = target;
    await flush();
  };
  try {
    await run({ timers, logs, hostCalls, advance });
  } finally {
    globalThis.setTimeout = original.setTimeout;
    globalThis.clearTimeout = original.clearTimeout;
    Date.now = original.now;
    Math.random = original.random;
    globalThis.songloft = original.songloft;
    http.callHostAPI = original.callHostAPI;
  }
}

const songs = [16, 17, 18].map(id => ({
  id, title: `song-${id}`, type: 'local', duration: 300, url: `/api/v1/songs/${id}/play`,
}));

function player({ mode = 'loop', config = {}, service = {} } = {}) {
  const pushes = [];
  const tts = [];
  const manager = new PlaylistManager('account', 'speaker', {
    getPlayState: async () => ({ status: 1, position: 12, duration: 300 }),
    playURL: async (_account, _device, url) => { pushes.push(url); return true; },
    stopPlay: async () => true,
    textToSpeech: async (_account, _device, text) => { tts.push(text); },
    ...service,
  }, {
    getConfig: async () => config,
    updateDevice: async () => {},
    savePlaylistProgress: async () => {},
  });
  manager.initWithSongs(songs, 0, mode, 1);
  manager.state = 'playing';
  return { manager, pushes, tts };
}

function resumeEngine(manager) {
  const engine = Object.create(VoiceEngine.prototype);
  engine.enabled = true;
  engine.resumeTimer = null;
  engine.configManager = {
    getVoiceCommands: async () => defaults.getDefaultVoiceCommands(),
    getConfig: async () => ({ voice_memory_enabled: false }),
    getAIConfig: async () => ({ enabled: false }),
    getDevices: async () => [{ device_id: 'speaker' }],
  };
  engine.accountManager = { getAccounts: async () => [{ id: 'account' }] };
  engine.memoryService = { setMaxRecords: async () => { } };
  engine.playlistManagerMap = { get: () => manager };
  engine.minaService = manager.minaService;
  return engine;
}

async function continuePlaying(engine) {
  await engine.handleMessage({
    device_id: 'speaker',
    message: { response: { answer: [{ question: '继续播放' }] } },
  });
}

test('DLNA ownership blocks timer/status-based playlist recovery until an explicit new playback', async () => {
  await withClock(async h => {
    const { manager, pushes } = player();
    manager.resetAutoNextTimer(0);
    let released = 0;
    assert.equal(await manager.beginExternalPlayback(() => { released++; }), true);
    manager.handleExternalResume(20);
    manager.resetAutoNextTimer(20);
    assert.equal(await manager.resumePlayback(), false);
    await h.advance(3600000);
    assert.equal(manager.getStatus().state, 'stopped');
    assert.equal(pushes.length, 0);
    assert.equal(h.timers.size, 0);
    assert.equal(await manager.playAtIndex(1), true);
    assert.equal(released, 1);
    assert.equal(manager.isExternalPlayback(), false);
    assert.equal(pushes.length, 1);
    manager.cleanup();
  });
});

test('DLNA acquisition drains an already in-flight playlist push before handing over', async () => {
  await withClock(async h => {
    const pending = deferred();
    const { manager } = player({ service: { playURL: () => pending.promise } });
    const oldPlay = manager.playAtIndex(0);
    await flush();
    let acquired = false;
    const takeover = manager.beginExternalPlayback(() => {}).then(result => { acquired = result; });
    await flush();
    assert.equal(acquired, false);
    pending.resolve(true);
    await oldPlay;
    await takeover;
    assert.equal(acquired, true);
    assert.equal(manager.getStatus().state, 'stopped');
    assert.equal(h.timers.size, 0);
  });
});

test('new playlist push waits for an in-flight DLNA operation before replacing its URL', async () => {
  await withClock(async () => {
    const { manager, pushes } = player();
    await manager.beginExternalPlayback(() => {});
    const pending = deferred();
    const external = manager.runExternalPlayback(() => pending.promise);
    const newPlay = manager.playAtIndex(1);
    await flush();
    assert.equal(pushes.length, 0);
    pending.resolve(true);
    await external;
    assert.equal(await newPlay, true);
    assert.equal(pushes.length, 1);
    manager.cleanup();
  });
});

for (const [method, serviceMethod, result] of [
  ['pause', 'pausePlayVerified', 'paused'],
  ['stop', 'stopPlay', true],
  ['resumePlayback', 'resumePlay', true],
]) {
  test(`DLNA acquisition drains an in-flight ${method} without restarting playlist timers`, async () => {
    await withClock(async h => {
      const pending = deferred();
      const { manager } = player({ service: { [serviceMethod]: () => pending.promise } });
      const control = manager[method]();
      await flush();
      let acquired = false;
      const takeover = manager.beginExternalPlayback(() => { }).then(ok => { acquired = ok; });
      await flush();
      assert.equal(acquired, false);
      pending.resolve(result);
      const controlResult = await control;
      await takeover;
      assert.equal(acquired, true);
      if (method === 'resumePlayback') assert.equal(controlResult, false);
      assert.equal(manager.getStatus().state, 'stopped');
      assert.equal(h.timers.size, 0);
    });
  });
}

for (const waitMs of [3600000, 12 * 3600000]) {
  test(`voice resume restores automatic next after stopping for ${waitMs / 3600000} hours`, async () => {
    await withClock(async h => {
      let playingSince = null;
      const pushed = [];
      const { manager } = player({
        service: {
          getPlayState: async () => ({
            status: playingSince === null ? 2 : 1,
            position: playingSince === null ? 0 : (Date.now() - playingSince) / 1000,
            duration: 300,
            hasPosition: true,
          }),
          playURL: async (_account, _device, url) => {
            pushed.push(url);
            playingSince = Date.now();
            return true;
          },
        }
      });
      const engine = resumeEngine(manager);
      await manager.stop();
      await h.advance(waitMs);
      assert.ok(h.logs.some(message => message.includes('Resume poll timed out')));
      assert.equal(h.timers.size, 0);
      await continuePlaying(engine);
      assert.equal(manager.getStatus().state, 'playing');
      assert.equal(manager.getCurrentSong().id, 16);
      assert.equal(pushed.length, 1);
      assert.ok(pushed[0].includes('/songs/16/play'));
      await h.advance(300000);
      assert.equal(manager.getCurrentSong().id, 17);
      assert.equal(pushed.length, 2);
      assert.ok(pushed[1].includes('/songs/17/play'));
      assert.ok(h.hostCalls.some(([method, path]) => method === 'POST' && path === '/api/v1/songs/16/played?source=miot'));
      manager.cleanup();
    });
  });
}

test('voice resume preserves paused position and restores automatic next', async () => {
  await withClock(async h => {
    let resumeSince = null;
    let resumes = 0;
    const { manager, pushes } = player({
      service: {
        pausePlayVerified: async () => 'paused',
        resumePlay: async () => { resumes++; resumeSince = Date.now(); return true; },
        getPlayState: async () => ({
          status: 1,
          position: 60 + (Date.now() - resumeSince) / 1000,
          duration: 300,
          hasPosition: true,
        }),
      }
    });
    const engine = resumeEngine(manager);
    manager.playStartTimeMs = Date.now() - 60000;
    await manager.pause();
    await h.advance(3600000);
    await continuePlaying(engine);
    assert.equal(manager.getStatus().state, 'playing');
    assert.equal(manager.getPosition(), 60);
    assert.equal(resumes, 1);
    assert.equal(pushes.length, 0);
    await h.advance(240000);
    assert.equal(manager.getCurrentSong().id, 17);
    assert.equal(pushes.length, 1);
    assert.ok(pushes[0].includes('/songs/17/play'));
    manager.cleanup();
  });
});

test('temporary failures expire exactly at five minutes and invalid ids are ignored', async () => {
  await withClock(async h => {
    const { manager } = player();
    for (const id of [0, -1]) manager.markSongUnplayable(id, 'prefetch');
    assert.equal(manager.clearPlaybackFailures(), 0);
    manager.markSongUnplayable(17, 'prefetch');
    assert.equal(UNPLAYABLE_SONG_TTL_MS, 300000);
    await h.advance(UNPLAYABLE_SONG_TTL_MS - 1);
    assert.equal(manager.isSongUnplayable(17), true);
    await h.advance(1);
    assert.equal(manager.isSongUnplayable(17), false);
    assert.equal(manager.unplayableSongs.size, 0);
  });
});

test('repeated failures refresh the TTL and recording a failure prunes expired songs', async () => {
  await withClock(async h => {
    const { manager } = player();
    manager.markSongUnplayable(16, 'prefetch');
    manager.markSongUnplayable(17, 'prefetch');
    await h.advance(1000);
    manager.markSongUnplayable(17, 'landing');
    await h.advance(UNPLAYABLE_SONG_TTL_MS - 1000);
    manager.markSongUnplayable(18, 'early-stop');
    assert.equal(manager.unplayableSongs.has(16), false);
    assert.equal(manager.isSongUnplayable(17), true);
    assert.equal(manager.unplayableSongs.get(17).reason, 'landing');
    await h.advance(1000);
    assert.equal(manager.isSongUnplayable(17), false);
  });
});

test('skip a cooling-down song, but try it again when its TTL has expired', async () => {
  await withClock(async h => {
    const { manager } = player();
    const played = [];
    manager.playCurrent = async () => { played.push(manager.getCurrentSong().id); return true; };
    manager.markSongUnplayable(17, 'prefetch');
    await manager.advanceToNext();
    assert.deepEqual(played, [18]);
    manager.initWithSongs(songs, 0, 'loop', 1);
    await h.advance(UNPLAYABLE_SONG_TTL_MS);
    await manager.advanceToNext();
    assert.deepEqual(played, [18, 17]);
  });
});

test('push acknowledgement retains a marker until actual landing is confirmed', async () => {
  await withClock(async h => {
    const { manager } = player();
    manager.markSongUnplayable(16, 'prefetch');
    manager.landingFailureCount = 2;
    assert.equal(await manager.playCurrent(), true);
    assert.equal(manager.isSongUnplayable(16), true);
    assert.equal(manager.landingFailureCount, 2);
    await h.advance(10000);
    assert.equal(manager.isSongUnplayable(16), false);
    assert.equal(manager.landingFailureCount, 0);
    manager.cleanup();
  });
});

test('verified false push failure clears the marker immediately', async () => {
  await withClock(async h => {
    const { manager } = player({ service: { playURL: async () => false } });
    manager.markSongUnplayable(16, 'landing');
    manager.landingFailureCount = 2;
    const pending = manager.playCurrent();
    await flush();
    await h.advance(1200);
    assert.equal(await pending, true);
    assert.equal(manager.isSongUnplayable(16), false);
    assert.equal(manager.landingFailureCount, 0);
    manager.cleanup();
  });
});

test('natural song completion clears its marker before loop advances', async () => {
  await withClock(async () => {
    const { manager } = player();
    songs.forEach(song => manager.markSongUnplayable(song.id, 'prefetch'));
    manager.playCurrent = async () => true;
    await manager.onSongFinished();
    assert.equal(manager.isSongUnplayable(16), false);
    assert.equal(manager.state, 'playing');
    assert.equal(manager.getCurrentSong().id, 16);
  });
});

test('metadata completion cannot reset consecutive failures without device confirmation', async () => {
  await withClock(async h => {
    const { manager } = player();
    manager.landingFailureCount = 2;
    manager.markSongUnplayable(16, 'prefetch');
    manager.playCurrent = async () => true;
    manager.startCheckTimer(5);
    await h.advance(5000);
    assert.equal(manager.isSongUnplayable(16), false);
    assert.equal(manager.landingFailureCount, 2);
    manager.cleanup();
  });
});

for (const change of ['same-song-restart', 'switch-song', 'pause', 'stop']) {
  test(`slow push verification cannot clear failures after ${change}`, async () => {
    await withClock(async h => {
      const slow = deferred();
      let queries = 0;
      const { manager } = player({ service: {
        playURL: async () => false,
        getPlayState: () => { queries++; return slow.promise; },
      } });
      manager.markSongUnplayable(16, 'landing');
      manager.landingFailureCount = 2;
      const pending = manager.playCurrent();
      await flush();
      await h.advance(1200);
      assert.equal(queries, 1);
      if (change === 'same-song-restart') manager.startCheckTimer(60);
      if (change === 'switch-song') manager.currentIndex = 1;
      if (change === 'pause') manager.state = 'paused';
      if (change === 'stop') manager.state = 'stopped';
      slow.resolve({ status: 1, position: 1, duration: 300 });
      await flush();
      assert.equal(await pending, false);
      assert.equal(manager.isSongUnplayable(16), true);
      assert.equal(manager.landingFailureCount, 2);
      if (change === 'pause') assert.equal(manager.state, 'paused');
      if (change === 'stop') assert.equal(manager.state, 'stopped');
      manager.cleanup();
    });
  });
}

for (const mode of ['order', 'loop', 'single', 'random']) {
  test(`${mode}: all next candidates marked still retries the original candidate once`, async () => {
    await withClock(async h => {
      const { manager } = player({ mode });
      songs.forEach(song => manager.markSongUnplayable(song.id, 'prefetch'));
      const expected = manager.reserveNextIndex();
      const randomPlayed = [...manager.randomPlayed];
      const played = [];
      manager.landingFailureCount = 1;
      manager.playCurrent = async () => { played.push(manager.currentIndex); return true; };
      await manager.advanceToNext();
      assert.deepEqual(played, [expected]);
      assert.equal(manager.state, 'playing');
      assert.equal(manager.landingFailureCount, 1);
      assert.deepEqual([...manager.randomPlayed], randomPlayed);
      assert.ok(h.logs.some(line => line.includes('retrying index=')));
      assert.ok(!h.logs.some(line => line.includes('playback complete')));
    });
  });
}

test('order: a true end of playlist still stops without replaying a marked last song', async () => {
  await withClock(async () => {
    const { manager } = player({ mode: 'order' });
    manager.currentIndex = 2;
    manager.markSongUnplayable(18, 'prefetch');
    manager.playCurrent = async () => assert.fail('must not restart a finished playlist');
    await manager.advanceToNext();
    assert.equal(manager.state, 'stopped');
  });
});

test('singlePlay: natural completion clears failure and pauses on the current song', async () => {
  await withClock(async () => {
    const { manager } = player({ mode: 'singlePlay' });
    manager.markSongUnplayable(16, 'prefetch');
    manager.playCurrent = async () => assert.fail('singlePlay must not advance');
    await manager.onSongFinished();
    assert.equal(manager.isSongUnplayable(16), false);
    assert.equal(manager.state, 'paused');
    assert.equal(manager.currentIndex, 0);
  });
});

test('bounded fallback keeps three consecutive landing failures and TTS circuit breaker', async () => {
  await withClock(async h => {
    const { manager, pushes, tts } = player({
      service: { getPlayState: async () => ({ status: 0, position: 0, duration: 300 }) },
    });
    songs.forEach(song => manager.markSongUnplayable(song.id, 'prefetch'));
    await manager.playCurrent();
    await h.advance(54000);
    assert.equal(pushes.length, 3);
    assert.equal(manager.state, 'stopped');
    assert.deepEqual(tts, ['当前多首歌曲无法播放，请稍后再试']);
    assert.equal(manager.unplayableSongs.get(18).reason, 'landing');
    manager.cleanup();
  });
});

test('early external stop records an expiring failure, not a permanent blacklist', async () => {
  await withClock(async h => {
    const { manager } = player({
      service: { getPlayState: async () => ({ status: 0, position: 0, duration: 300 }) },
    });
    manager.handleLandingFailure = async () => {};
    await manager.checkExternalStop();
    await manager.checkExternalStop();
    assert.equal(manager.unplayableSongs.get(16).reason, 'early-stop');
    await h.advance(UNPLAYABLE_SONG_TTL_MS);
    assert.equal(manager.isSongUnplayable(16), false);
    manager.cleanup();
  });
});

for (const action of ['manual-clear', 'landing-success', 'natural-completion', 'start-playback', 'cleanup']) {
  test(`late prefetch failure cannot undo ${action}`, async () => {
    await withClock(async () => {
      const slow = deferred();
      const { manager } = player({ config: { force_mp3: true } });
      http.callHostAPI = (method) => method === 'GET' ? slow.promise : Promise.resolve({});
      manager.prefetchNextSong();
      await flush();
      if (action === 'manual-clear') {
        assert.equal(manager.clearPlaybackFailures(), 0);
      } else if (action === 'cleanup') {
        manager.cleanup();
      } else {
        manager.currentIndex = 1;
        if (action === 'landing-success') await manager.verifyPlaybackLanded(1, 17, 0);
        if (action === 'natural-completion') {
          manager.advanceToNext = async () => {};
          await manager.onSongFinished();
        }
        if (action === 'start-playback') await manager.playCurrent();
      }
      slow.reject(new Error('old prefetch timed out'));
      await flush();
      assert.equal(manager.isSongUnplayable(17), false);
      manager.cleanup();
    });
  });
}

test('late prefetch success cannot erase a newer landing failure', async () => {
  await withClock(async () => {
    const slow = deferred();
    const { manager } = player({ config: { force_mp3: true } });
    http.callHostAPI = () => slow.promise;
    manager.prefetchNextSong();
    await flush();
    manager.markSongUnplayable(17, 'landing');
    slow.resolve({});
    await flush();
    assert.equal(manager.unplayableSongs.get(17).reason, 'landing');
  });
});

test('new prefetch failure after clearing still creates a fresh temporary marker', async () => {
  await withClock(async () => {
    const old = deferred();
    const fresh = deferred();
    const { manager } = player({ config: { force_mp3: true } });
    let requests = 0;
    http.callHostAPI = () => (++requests === 1 ? old.promise : fresh.promise);
    manager.prefetchNextSong();
    await flush();
    manager.clearPlaybackFailures();
    manager.prefetchNextSong();
    await flush();
    fresh.reject(new Error('fresh failure'));
    await flush();
    assert.equal(manager.isSongUnplayable(17), true);
    old.resolve({});
    await flush();
    assert.equal(manager.isSongUnplayable(17), true);
  });
});

test('current prefetch success clears a previous marker without resetting landing failures', async () => {
  await withClock(async () => {
    const { manager } = player({ config: { force_mp3: true } });
    manager.markSongUnplayable(17, 'prefetch');
    manager.landingFailureCount = 2;
    manager.prefetchNextSong();
    await flush();
    assert.equal(manager.isSongUnplayable(17), false);
    assert.equal(manager.landingFailureCount, 2);
  });
});

test('clear route visits each independent or shared manager once and returns the active count', async () => {
  await withClock(async h => {
    const first = player().manager;
    const group = player().manager;
    group.setTargets([{ account_id: 'account', device_id: 'a' }, { account_id: 'account', device_id: 'b' }]);
    first.markSongUnplayable(16, 'landing');
    await h.advance(UNPLAYABLE_SONG_TTL_MS);
    first.markSongUnplayable(17, 'prefetch');
    group.markSongUnplayable(17, 'landing');
    group.markSongUnplayable(18, 'early-stop');
    group.landingFailureCount = 2;
    const map = new PlaylistManagerMap({}, {});
    map.managers.set('account:speaker', first);
    map.managers.set('grp_test', group);
    const routes = new Map();
    const router = { post: (path, handler) => routes.set(path, handler), get: () => {} };
    registerPlaylistHandlers(router, map, {}, {});
    const clear = routes.get('/player/failures/clear');
    assert.deepEqual(await clear({}), { cleared: 3 });
    assert.equal(first.state, 'playing');
    assert.equal(group.state, 'playing');
    assert.equal(group.currentIndex, 0);
    assert.equal(group.landingFailureCount, 2);
    assert.equal(group.targets.length, 2);
    assert.equal(map.managers.size, 2);
    assert.deepEqual(await clear({}), { cleared: 0 });
  });
});
