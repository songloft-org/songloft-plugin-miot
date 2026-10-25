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
const deviceState = loadSource('../src/playback/device_state.ts', {});
const minaConstants = loadSource('../src/mina/constants.ts', { '../data/tts-commands.json': {} });
const { MinaHTTPClient } = loadSource('../src/mina/client.ts', {
  '../utils/cookie': {}, '../utils/http': {}, '../utils/crypto': {},
  '../utils/debug': { isDebugLog: () => false }, './constants': minaConstants, '../miio/client': {},
});
const { MinaService } = loadSource('../src/service/service.ts', {
  '../mina/auth': {}, '../mina/constants': minaConstants,
});
const players = loadSource('../src/player/manager.ts', {
  '../playback/device_state': deviceState,
  '../config/manager': { playlistProgressScope: () => 'account:speaker' },
  './url_builder': urls,
  '../utils/http': http,
  '../utils/debug': { isDebugLog: () => false },
});
const { PlaylistManager, PlaylistManagerMap, UNPLAYABLE_SONG_TTL_MS } = players;
const { registerPlaylistHandlers, resolvePlayerStatus, updateDeviceStatusCache } = loadSource('../src/handlers/playlist.ts', {
  '@songloft/plugin-sdk': {
    jsonResponse: value => value,
    parseQuery: query => Object.fromEntries(new URLSearchParams(query)),
  },
  '../player/manager': players,
  '../config/manager': {},
  '../utils/http': http,
  '../utils/favorites': {},
});
const defaults = loadSource('../src/voicecmd/defaults.ts', {});
const sleepTimer = loadSource('../src/sleep_timer/index.ts', {});
const conversation = loadSource('../src/conversation/query.ts', {});
const { MusicCommandService: VoiceEngine } = loadSource('../src/music/service.ts', {
  '../conversation/query': conversation,
  '../group/coordinator': {},
  './guards': loadSource('../src/music/guards.ts'),
  '../playback/voice_resume': loadSource('../src/playback/voice_resume.ts', { './device_state': deviceState }),
  '../playback/sleep_timer': loadSource('../src/playback/sleep_timer.ts', { '../sleep_timer': sleepTimer }),
  '../player/manager': players,
  '../voicecmd/ai_analyzer': {},
  '../voicecmd/online_searcher': { OnlineSearcher: class { } },
  '../handlers/playlist': {},
  '../utils/http': http,
  '../utils/favorites': {},
  '../memory': {},
  '../sleep_timer': sleepTimer,
  '../voicecmd/defaults': defaults,
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

async function withClock(run, { recycleTimerIds = false } = {}) {
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
  const freeTimerIds = [];
  const timers = new Map();
  const logs = [];
  const hostCalls = [];
  Date.now = () => now;
  Math.random = () => 0;
  globalThis.setTimeout = (fn, delay) => {
    const id = recycleTimerIds && freeTimerIds.length ? freeTimerIds.pop() : ++timerId;
    timers.set(id, { fn, at: now + delay });
    return id;
  };
  globalThis.clearTimeout = id => {
    timers.delete(id);
    if (recycleTimerIds) freeTimerIds.push(id);
  };
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
      if (recycleTimerIds) freeTimerIds.push(id);
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

function player({ mode = 'loop', config = {}, service = {}, initialSongs = songs } = {}) {
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
    updateDevice: async () => { },
    savePlaylistProgress: async () => { },
  });
  manager.initWithSongs(initialSongs, 0, mode, 1);
  manager.state = 'playing';
  return { manager, pushes, tts };
}

for (const sample of [
  { date: '20261015', metadata: [174, 184, 189], streams: [174.322, 184.052, 189.532], seek: 30, queryMs: 500, maxDelayMs: 10000 },
  // The October 21 log froze 162ms short of the end, then replayed for 5–6s before detection.
  { date: '20261021', metadata: [224, 243, 221], streams: [224.782, 243.547, 221.022], seek: 0, queryMs: 250, maxDelayMs: 2500 },
  { date: '20261021-seek', metadata: [224, 243, 221], streams: [224.782, 243.547, 221.022], seek: 30, queryMs: 250, maxDelayMs: 2500 },
]) {
  for (const api of ['music', 'url']) {
    for (const withStatusPage of [false, true]) {
      for (const speed of [0.5, 1, 2]) {
        test(`log ${sample.date}: consecutive fractional tails advance with real ${api} commands, speed=${speed}, statusPage=${withStatusPage}`, async () => {
          await withClock(async h => {
            const metadata = sample.metadata;
            const streamDurations = sample.streams.map(value => value / speed);
            const client = new MinaHTTPClient({ user_id: 'test', device_id: 'test', services: {} });
            const service = new MinaService({ getMinaClient: () => client }, {
              getConfig: async () => ({ music_api_model_disabled: api === 'url' ? ['LX05'] : [] }),
            });
            service.getDeviceIdentity = async () => ({ hardware: 'LX05' });
            const pushed = [];
            let streamStartedAt = Date.now();
            let seek = sample.seek;
            const { manager, tts } = player({
              mode: 'order', initialSongs: songs.map((song, i) => ({ ...song, duration: metadata[i] })),
              service: {
                playURL: (...args) => service.playURL(...args),
                getPlayState: (...args) => service.getPlayState(...args),
                getPlayerStatus: (...args) => service.getPlayerStatus(...args),
              },
            });
            client.doUbusRequest = async (_device, method, _path, message) => {
              if (method === 'player_get_play_status') {
                const duration = streamDurations[manager.currentIndex] - seek / speed;
                const elapsed = (Date.now() - streamStartedAt) / 1000;
                // Like the log, freeze just short of the fractional end, then loop before the next shared sample.
                const position = elapsed >= duration + 1 ? elapsed - duration - 1 : Math.min(elapsed, duration - 0.162);
                await new Promise(resolve => setTimeout(resolve, sample.queryMs));
                return { code: 0, data: { info: JSON.stringify({
                  status: 1, volume: 30, play_song_detail: { position: position * 1000, duration: duration * 1000 },
                }) } };
              }
              if (method === 'player_play_music' || method === 'player_play_url') {
                assert.equal(method, api === 'music' ? 'player_play_music' : 'player_play_url');
                const url = method === 'player_play_music' ? JSON.parse(message.music).payload.audio_items[0].stream.url : message.url;
                pushed.push(url);
                seek = Number(new URL(url).searchParams.get('seek') || 0);
                streamStartedAt = Date.now();
              }
              return { code: 0, data: { code: 0 } };
            };
            let statusTimer;
            let statusActive = withStatusPage;
            const pollStatus = async () => {
              await resolvePlayerStatus({ getOrCreate: async () => manager }, manager.minaService, 'account', 'speaker');
              if (statusActive) statusTimer = setTimeout(pollStatus, 1000);
            };
            updateDeviceStatusCache('account', 'speaker', { timestamp: 0 });
            assert.equal(await manager.playCurrent({ seekSeconds: seek, speed }), true);
            if (withStatusPage) await pollStatus();
            for (let index = 0; index < 2; index++) {
              const endAt = streamStartedAt + (streamDurations[index] - seek / speed + 1) * 1000;
              await h.advance(endAt - Date.now() - 1);
              assert.equal(manager.currentIndex, index, 'do not cut the original audio before its end');
              await h.advance(sample.maxDelayMs + 1);
              assert.equal(manager.currentIndex, index + 1, 'advance after the first fresh replay sample instead of the grace timeout');
              assert.equal(pushed.length, index + 2);
              assert.ok(pushed[index + 1].includes(`/songs/${songs[index + 1].id}/play`));
              assert.ok(manager.checkTimer !== null);
              assert.equal(manager.state, 'playing');
              assert.equal(manager.unplayableSongs.size, 0);
              assert.deepEqual(tts, []);
            }
            statusActive = false;
            if (statusTimer !== undefined) clearTimeout(statusTimer);
            manager.cleanup();
            assert.equal(h.timers.size, 0);
          });
        });
      }
    }
  }
}

for (const position of [0, 60]) {
  for (const speed of [0.5, 1, 2]) {
    for (const paused of [false, true]) {
      for (const probe of ['deadline', 'tail']) {
        test(`manual seek to ${position}s at speed=${speed}, paused=${paused} ignores old ${probe} loop evidence`, async () => {
          await withClock(async h => {
            let slow;
            let soughtAt;
            const { manager, pushes, tts } = player({
              mode: 'order',
              service: {
                pausePlayVerified: async () => 'paused',
                getPlayState: async () => slow ? slow.promise : {
                  status: 1, hasPosition: true,
                  duration: (300 - (soughtAt === undefined ? 0 : position)) / speed,
                  position: soughtAt === undefined ? 299.8 / speed : (Date.now() - soughtAt) / 1000,
                  sampledAt: Date.now(),
                },
              },
            });
            assert.equal(await manager.playCurrent({ speed }), true);
            clearTimeout(manager.tailProbeTimer);
            manager.tailProbeTimer = null;
            await manager.tailProbe();
            assert.ok(manager.tailLoopSample, 'the old stream has sampled near its end');
            slow = deferred();
            if (probe === 'tail') {
              clearTimeout(manager.tailProbeTimer);
              manager.tailProbeTimer = null;
            }
            const pending = probe === 'deadline' ? manager.verifyTimerDeadline() : manager.tailProbe();
            await flush();
            const late = slow;
            slow = undefined;
            soughtAt = Date.now();
            if (paused) manager.state = 'paused';
            const map = new PlaylistManagerMap({}, {});
            map.managers.set('account:speaker', manager);
            const routes = new Map();
            registerPlaylistHandlers({ post: (path, handler) => routes.set(path, handler), get() { } }, map, {}, {});
            const result = await routes.get('/player/seek')({
              body: JSON.stringify({ account_id: 'account', device_id: 'speaker', position }),
            });
            assert.equal(result.success, true, result.error);
            assert.equal(result.data.position, position);
            assert.equal(manager.tailLoopSample, null, 'manual seek starts a new stream without old tail evidence');
            late.resolve({ status: 1, position: 7, duration: 300 / speed, hasPosition: true, sampledAt: Date.now() });
            await pending;
            await flush();
            assert.equal(manager.tailLoopSample, null, 'late old-stream result cannot restore its loop evidence');
            assert.equal(pushes.length, 2);
            assert.ok(pushes[1].includes('/songs/16/play'));
            assert.equal(Number(new URL(pushes[1]).searchParams.get('seek') || 0), position);
            assert.equal(manager.currentIndex, 0);
            assert.equal(manager.state, paused ? 'paused' : 'playing');
            await h.advance(10000);
            assert.equal(pushes.length, 2, 'dragging backward must not be mistaken for a natural loop');
            if (!paused) {
              const endAt = soughtAt + (300 - position) / speed * 1000;
              await h.advance(endAt - Date.now() - 1);
              assert.equal(manager.currentIndex, 0);
              await h.advance(1001);
              assert.equal(manager.currentIndex, 1, 'the sought stream still advances after its own natural end');
              assert.equal(pushes.length, 3);
              assert.ok(pushes[2].includes('/songs/17/play'));
              assert.ok(manager.checkTimer !== null);
            } else {
              assert.equal(manager.checkTimer, null);
            }
            assert.equal(manager.unplayableSongs.size, 0);
            assert.deepEqual(tts, []);
            manager.cleanup();
            assert.equal(h.timers.size, 0);
          });
        });
      }
    }
  }
}

// Log samples from songloft-org/songloft#495, including the stream resumed at seek=112.
for (const [duration, seek, position, streamDuration] of [
  [631, 112, 518.995, 3090.081],
  [519, 0, 519.178, 577.345],
  [736, 0, 736.275, 803.559],
  [611, 0, 611.725, 743.936],
  [593, 0, 593.3, 649.173],
  [651, 0, 651.054, 723.289],
]) {
  for (const ending of ['loop', 'stopped', 'stalled', 'idle without detail']) {
    test(`issue 495: ${duration}s episode seek=${seek} waits for ${ending} after sixty seconds of tail progress`, async () => {
      await withClock(async h => {
        const startedAt = Date.now();
        const { manager, pushes, tts } = player({
          mode: 'order',
          initialSongs: songs.map(song => ({ ...song, duration })),
          service: {
            getPlayState: async () => {
              if (manager.currentIndex !== 0) return { status: 1, position: 0, duration, hasPosition: true, sampledAt: Date.now() };
              const elapsed = (Date.now() - startedAt) / 1000;
              if (ending === 'idle without detail' && elapsed >= 60) {
                return { status: 0, position: 0, duration: 0, hasPosition: false, sampledAt: Date.now() };
              }
              return {
                status: ending === 'stopped' && elapsed >= 60 ? 0 : 1,
                position: ending === 'loop' && elapsed >= 60 ? 0 : position + Math.min(60, elapsed),
                duration: streamDuration, hasPosition: true, sampledAt: Date.now(),
              };
            },
          },
        });
        assert.equal(await manager.playCurrent({ seekSeconds: seek }), true);
        assert.equal(manager.getStreamSeekOffsetSec(), seek);
        assert.equal(pushes.length, 1);
        assert.equal(pushes[0].includes('seek='), seek > 0);
        if (seek > 0) assert.ok(pushes[0].includes(`seek=${seek}`));
        manager.startCheckTimer(0.1);
        await h.advance(60099);
        assert.equal(pushes.length, 1, 'continuous measured playback must not be cut at metadata or thirty seconds');
        assert.equal(manager.currentIndex, 0);
        assert.equal(manager.state, 'playing');
        if (ending === 'stalled') {
          await h.advance(20000);
          assert.equal(pushes.length, 1, 'a frozen playing report can be buffering and retains the grace period');
        }
        await h.advance(ending === 'loop' ? 1 : 10001);
        assert.equal(pushes.length, 2);
        assert.ok(pushes[1].includes('/songs/17/play'));
        assert.equal(manager.currentIndex, 1);
        assert.equal(manager.state, 'playing');
        assert.equal(manager.unplayableSongs.size, 0);
        assert.deepEqual(tts, []);
        assert.ok(manager.checkTimer !== null);
        assert.equal(manager.getStreamSeekOffsetSec(), 0);
        manager.cleanup();
        assert.equal(h.timers.size, 0);
      });
    });
  }
}

test('issue 495: successive episodes ending without detail advance promptly and preserve the following timer', async () => {
  await withClock(async h => {
    const metadata = [593, 651, 496];
    const streamDurations = [649.173, 723.289, 496];
    const actualDurations = [667, 735, 496];
    const urls = [];
    let streamStartedAt = Date.now();
    const { manager, tts } = player({
      mode: 'order', initialSongs: songs.map((song, i) => ({ ...song, duration: metadata[i] })),
      service: {
        playURL: async (_account, _device, url) => {
          urls.push(url);
          streamStartedAt = Date.now();
          return true;
        },
        getPlayState: async () => {
          const elapsed = (Date.now() - streamStartedAt) / 1000;
          return elapsed >= actualDurations[manager.currentIndex]
            ? { status: 0, position: 0, duration: 0, hasPosition: false, sampledAt: Date.now() }
            : {
              status: 1, position: elapsed, duration: streamDurations[manager.currentIndex],
              hasPosition: true, sampledAt: Date.now()
            };
        },
      },
    });
    assert.equal(await manager.playCurrent(), true);
    for (let index = 0; index < 2; index++) {
      await h.advance(streamStartedAt + actualDurations[index] * 1000 - Date.now() - 1);
      assert.equal(manager.currentIndex, index, 'the episode must play through its actual end');
      assert.equal(urls.length, index + 1);
      await h.advance(10001);
      assert.equal(manager.currentIndex, index + 1, 'the next episode must start within two fresh samples');
      assert.equal(urls.length, index + 2);
      assert.ok(urls[index + 1].includes(`/songs/${songs[index + 1].id}/play`));
      assert.ok(manager.checkTimer !== null);
      assert.equal(manager.state, 'playing');
      assert.equal(manager.unplayableSongs.size, 0);
      assert.deepEqual(tts, []);
    }
    manager.cleanup();
    assert.equal(h.timers.size, 0);
  });
});

for (const operation of ['pause', 'voice suspension', 'same-song restart', 'next', 'new playlist', 'new artist playlist', 'external takeover', 'stop', 'cleanup']) {
  test(`issue 495: ${operation} clears confirmed tail evidence and ignores an old deadline response`, async () => {
    await withClock(async h => {
      const startedAt = Date.now();
      let slow;
      const { manager, pushes } = player({
        service: {
          pausePlayVerified: async () => 'paused',
          getPlayState: async () => slow ? slow.promise : {
            status: 1, position: 300 + (Date.now() - startedAt) / 1000,
            duration: 500, hasPosition: true, sampledAt: Date.now(),
          },
        },
      });
      await manager.playCurrent();
      manager.startCheckTimer(0.1);
      await h.advance(5100);
      assert.equal(manager.deadlineTailEvidence.confirmed, true);
      slow = deferred();
      const timersBeforeQuery = new Set(h.timers.keys());
      const pending = manager.verifyTimerDeadline();
      await flush();
      const queryTimers = new Set([...h.timers.keys()].filter(id => !timersBeforeQuery.has(id)));
      manager.tailLoopSample = { position: 299.8, duration: 300, sampledAt: Date.now() };
      if (operation === 'pause') await manager.pause();
      else if (operation === 'voice suspension') manager.suspendForVoiceInteraction();
      else if (operation === 'same-song restart') await manager.replayCurrent();
      else if (operation === 'next') await manager.next();
      else if (operation === 'new playlist') manager.initWithSongs(songs, 0, 'order', 2);
      else if (operation === 'new artist playlist') manager.initWithTempArtist(songs, 'artist');
      else if (operation === 'external takeover') await manager.beginExternalPlayback(() => { });
      else if (operation === 'stop') await manager.stop(false);
      else manager.cleanup();
      assert.equal(manager.deadlineTailEvidence, null);
      assert.equal(manager.tailLoopSample, null);
      assert.equal(manager.matchResumeDeviceStream({ status: 1, duration: 500 }),
        ['pause', 'voice suspension'].includes(operation) ? 'ours' : 'foreign');
      const timers = [...h.timers.keys()];
      const pushCount = pushes.length;
      slow.resolve({ status: 1, position: 0, duration: 500, hasPosition: true, sampledAt: Date.now() });
      await pending;
      await flush();
      assert.equal(manager.deadlineTailEvidence, null);
      assert.equal(manager.tailLoopSample, null);
      assert.equal(pushes.length, pushCount);
      assert.deepEqual([...h.timers.keys()], timers.filter(id => !queryTimers.has(id)));
      manager.cleanup();
      assert.equal(h.timers.size, 0);
    });
  });
}

// 2026-10-14 log: metadata=571, device duration=928.318, position=611.5 before voice.
for (const [seek, speed] of [[0, 1], [100, 0.5], [80, 2]]) {
  for (const recovery of ['voice', 'resume command', 'hourly']) {
    test(`issue 495: ${recovery} keeps a confirmed mismatched tail stream seek=${seek} speed=${speed}`, async () => {
      await withClock(async h => {
        let baseAt = Date.now();
        let interrupted = false;
        let afterRecovery = false;
        const metadata = 571;
        const streamDuration = (928.318 - seek) / speed;
        let startPosition = (570.974 - seek) / speed;
        const s = player({
          config: { hourly_chime_resume_enabled: true, smart_resume_timeout: 30 },
          initialSongs: [{ ...songs[0], duration: metadata }, ...songs.slice(1)],
          service: {
            resumePlay: async () => true,
            getPlayState: async () => {
              const elapsed = (Date.now() - baseAt) / 1000;
              if (s.manager.currentIndex > 0) return {
                status: 1, position: 0, duration: 300, hasPosition: true, sampledAt: Date.now(),
              };
              if (interrupted && elapsed < 1) return {
                status: 1, position: 0, duration: 0, hasPosition: false, sampledAt: Date.now(),
              };
              return {
                status: 1, position: afterRecovery && elapsed >= 70 ? 2.707 : startPosition + elapsed,
                duration: streamDuration, hasPosition: true, sampledAt: Date.now(),
              };
            },
          },
        });
        assert.equal(await s.manager.playCurrent({ seekSeconds: seek, speed }), true);
        s.manager.playStartTimeMs = Date.now() - 570.974 / speed * 1000;
        s.manager.startCheckTimer(0.1);
        await h.advance(41000);
        assert.equal(s.manager.deadlineTailEvidence.confirmed, true);
        assert.equal(s.pushes.length, 1);
        if (recovery === 'voice') {
          interrupted = true;
          startPosition += (Date.now() - baseAt) / 1000;
          baseAt = Date.now();
          const engine = resumeEngine(s.manager);
          s.manager.suspendForVoiceInteraction();
          engine.scheduleSmartResume(s.manager, 'account', 'speaker');
          await h.advance(31000);
          engine.setEnabled(false);
        } else if (recovery === 'resume command') {
          assert.equal(await s.manager.resumePlayback(), true);
          await h.advance(31000);
        } else {
          // Use the real hourly recovery entry at the next hour, with a new near-tail baseline.
          const hour = new Date(Date.now());
          hour.setHours(hour.getHours() + 1, 0, 10, 0);
          s.manager.stopCheckTimer();
          await h.advance(hour.getTime() - Date.now());
          baseAt = Date.now();
          s.manager.startCheckTimer(0.1);
          await h.advance(5100);
          assert.equal(s.manager.deadlineTailEvidence.confirmed, true);
          s.manager.playbackConfirmed = true;
          assert.equal(await s.manager.tryHourlyResume(metadata - 20, () => true), true);
          await flush();
          await h.advance(31000);
        }
        assert.equal(s.pushes.length, 1, 'advancing original audio must not be repushed at a truncated metadata seek');
        assert.equal(s.manager.isVoiceSuspended(), false);
        assert.equal(s.manager.isHourlyResumePending(), false);
        assert.equal(s.manager.currentIndex, 0, 'timer rebuild beyond metadata must still protect continuous playback');
        // Keep playing for more than the 30-second grace, then verify real next URLs twice.
        afterRecovery = true;
        startPosition += (Date.now() - baseAt) / 1000;
        baseAt = Date.now();
        await h.advance(69999);
        assert.equal(s.pushes.length, 1);
        await h.advance(10001);
        assert.equal(s.pushes.length, 2, h.logs.slice(-12).join('\n'));
        assert.match(s.pushes[1], /\/songs\/17\/play/);
        assert.equal(s.manager.unplayableSongs.size, 0);
        assert.deepEqual(s.tts, []);
        assert.ok(s.manager.checkTimer !== null);
        s.manager.minaService.getPlayState = async () => ({
          status: 1, position: 0, duration: 0, hasPosition: false, sampledAt: Date.now(),
        });
        await h.advance(300000 / speed);
        assert.equal(s.pushes.length, 3);
        assert.match(s.pushes[2], /\/songs\/18\/play/);
        s.manager.cleanup();
        assert.equal(h.timers.size, 0);
      });
    });
  }
}

for (const evidence of ['different stream', 'duplicate sample', 'query failure']) {
  test(`issue 495: remembered tail identity does not authorize recovery from ${evidence}`, async () => {
    await withClock(async h => {
      const startedAt = Date.now();
      const s = player({
        service: { getPlayState: async () => ({
          status: 1, position: 300 + (Date.now() - startedAt) / 1000,
          duration: 500, hasPosition: true, sampledAt: Date.now(),
        }) },
      });
      await s.manager.playCurrent();
      s.manager.playStartTimeMs = Date.now() - 300000;
      s.manager.startCheckTimer(0.1);
      await h.advance(5100);
      assert.equal(s.manager.deadlineTailEvidence.confirmed, true);
      const sampleAt = Date.now();
      s.manager.minaService.getPlayState = async () => ({
        status: evidence === 'query failure' ? -1 : 1,
        position: 305 + (Date.now() - sampleAt) / 1000,
        duration: evidence === 'different stream' ? 800 : 500,
        hasPosition: true,
        sampledAt: evidence === 'duplicate sample' ? sampleAt : Date.now(),
      });
      const engine = resumeEngine(s.manager);
      s.manager.suspendForVoiceInteraction();
      engine.scheduleSmartResume(s.manager, 'account', 'speaker');
      await h.advance(29999);
      assert.equal(s.manager.isVoiceSuspended(), true, 'only two fresh advancing samples of the same stream prove auto-resume');
      assert.equal(s.pushes.length, 1);
      await h.advance(1);
      assert.equal(s.pushes.length, evidence === 'different stream' ? 2 : 1);
      if (evidence === 'different stream') assert.match(s.pushes[1], /seek=296/);
      assert.equal(s.manager.currentIndex, 0);
      assert.equal(s.manager.unplayableSongs.size, 0);
      assert.deepEqual(s.tts, []);
      engine.setEnabled(false);
      s.manager.cleanup();
      assert.equal(h.timers.size, 0);
    });
  });
}

for (const firstReportsProgress of [false, true]) {
  test(`issue 124 the queue advances without extra grace when the first stream reports progress=${firstReportsProgress}`, async () => {
    await withClock(async h => {
      const startedAt = Date.now();
      const { manager, pushes } = player({
        mode: 'order',
        initialSongs: songs.map(song => ({ ...song, duration: 20 })),
        service: {
          getPlayState: async () => {
            const measured = firstReportsProgress && manager.currentIndex === 0;
            return {
              status: 1, position: measured ? (Date.now() - startedAt) / 1000 : 0,
              duration: measured ? 20 : 0, hasPosition: measured
            };
          }
        },
      });
      assert.equal(await manager.playCurrent(), true);
      assert.equal(pushes.length, 1);
      for (const id of [17, 18]) {
        await h.advance(19999);
        assert.equal(manager.getCurrentSong().id, id - 1);
        await h.advance(1);
        assert.equal(manager.getCurrentSong().id, id);
        assert.ok(pushes.at(-1).includes(`/songs/${id}/play`));
        assert.equal(manager.state, 'playing');
      }
      await h.advance(20000);
      assert.equal(manager.state, 'stopped');
      assert.equal(pushes.length, 3);
      assert.equal(h.logs.some(l => l.includes('Timer retry:')), false);
      manager.cleanup();
      assert.equal(h.timers.size, 0);
    });
  });
}

test('resume verification progress protects the deadline when later samples have no position', async () => {
  await withClock(async h => {
    let missing = false;
    const { manager, pushes } = player({
      service: {
        resumePlay: async () => true,
        getPlayState: async () => ({
          status: 1, position: missing ? 0 : 288 + (Date.now() - 100000) / 1000,
          duration: missing ? 0 : 300, hasPosition: !missing, sampledAt: Date.now()
        }),
      }
    });
    manager.state = 'paused';
    manager.pausedPositionSec = 290;
    assert.equal(await manager.resumePlayback(), true);
    // Isolate the resume verifier from the independent tail probe.
    clearTimeout(manager.tailProbeTimer);
    manager.tailProbeTimer = null;
    await h.advance(2000);
    missing = true;
    await h.advance(8000);
    assert.equal(pushes.length, 0);
    await h.advance(30000);
    assert.equal(pushes.length, 1);
    assert.equal(manager.getCurrentSong().id, 17);
    manager.cleanup();
    assert.equal(h.timers.size, 0);
  });
});

for (const mode of ['order', 'loop', 'random', 'single', 'singlePlay']) {
  for (const targetCount of [1, 2]) {
    test(`issues 124 and 494: status-only completion preserves ${mode} with ${targetCount} targets`, async () => {
      await withClock(async h => {
        const { manager, pushes, tts } = player({
          mode,
          initialSongs: songs.map(song => ({ ...song, duration: 20 })),
          service: { getPlayState: async () => ({ status: 1, position: 0, duration: 0, hasPosition: false }) },
        });
        manager.setTargets(Array.from({ length: targetCount }, (_, i) => ({ account_id: 'account', device_id: `speaker-${i}` })));
        assert.equal(await manager.playCurrent(), true);
        await h.advance(20000);
        assert.equal(manager.getCurrentSong().id, mode === 'single' || mode === 'singlePlay' ? 16 : 17);
        assert.equal(manager.state, mode === 'singlePlay' ? 'paused' : 'playing');
        assert.equal(pushes.length, targetCount * (mode === 'singlePlay' ? 1 : 2));
        assert.equal(manager.isSongUnplayable(16), false);
        assert.deepEqual(tts, []);
        manager.cleanup();
        assert.equal(h.timers.size, 0);
      });
    });
  }
}

for (const probe of ['tailProbe', 'checkExternalStop', 'verifyPlaybackLanded', 'verifyTimerDeadline']) {
  test(`issues 124 and 514: late ${probe} progress cannot add grace to a replacement stream`, async () => {
    await withClock(async h => {
      const slow = deferred();
      let firstQuery = true;
      const { manager, pushes } = player({
        service: {
          getPlayState: () => {
            if (firstQuery) { firstQuery = false; return slow.promise; }
            return Promise.resolve({ status: 1, position: 0, duration: 0, hasPosition: false });
          },
        }
      });
      manager.startCheckTimer(60);
      const pending = probe === 'verifyPlaybackLanded' ? manager.verifyPlaybackLanded(0, 16, 0) : manager[probe]();
      await flush();
      manager.prepareForNewPlayback();
      manager.state = 'playing';
      manager.startCheckTimer(10);
      slow.resolve({ status: 1, position: 280, duration: 300, hasPosition: true, sampledAt: Date.now() });
      await pending;
      await h.advance(10000);
      assert.equal(manager.getCurrentSong().id, 17);
      assert.equal(pushes.length, 1);
      manager.cleanup();
      assert.equal(h.timers.size, 0);
    });
  });
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
  engine.playlistManagerMap = { get: () => manager, cancelHourlyResumes: device => manager.cancelHourlyResume(device) };
  engine.minaService = manager.minaService;
  return engine;
}

function timerMessage(question, content = '') {
  return {
    account_id: 'account', device_id: 'speaker',
    message: { timestamp_ms: Date.now(), response: { answer: [{ question, content }] } },
  };
}

for (const api of ['music', 'url']) {
  for (const statusPage of [false, true]) {
    for (const speed of [0.5, 1, 2]) {
      for (const idleStatus of [0, 3]) {
        test(`issue 533 integrated: monitor to dispatcher to ${api}, statusPage=${statusPage}, speed=${speed}, idle=${idleStatus}`, async () => {
          await withClock(async h => {
            const chatTypes = loadSource('../src/chat/types.ts', {});
            const { VoiceDispatcher } = loadSource('../src/voicecmd/dispatcher.ts', { '../chat/types': chatTypes, '../conversation/query': conversation });
            const { PlaybackCoordinator } = loadSource('../src/playback/coordinator.ts', { '../chat/types': chatTypes });
            const { ConversationMonitor } = loadSource('../src/conversation/monitor.ts', { '../utils/debug': { isDebugLog: () => false } });
            const config = {
              getConfig: async () => ({ conversation_poll_interval: 2, smart_resume_timeout: 30, music_api_model_disabled: api === 'url' ? ['L15A'] : [] }),
              getChatConfig: async () => chatTypes.DEFAULT_CHAT_CONFIG,
              getWebhooks: async () => [],
              findDeviceGroup: async () => null,
            };
            const client = new MinaHTTPClient({ user_id: 'test', device_id: 'test', services: {} });
            const accounts = {
              getMinaClient: () => client,
              getAccounts: async () => [{ id: 'account' }],
              getManagedDevices: async () => [{ device_id: 'speaker', device_name: 'fixture', hardware: 'L15A' }],
            };
            const service = new MinaService(accounts, config);
            service.getDeviceIdentity = async () => ({ hardware: 'L15A' });
            const pushed = [], spoken = [], queries = [];
            let wakeAt = Infinity;
            let streamAt = Date.now() - 20000;
            let seek = 60;
            let interrupted = false;
            client.getLatestAskFromXiaoai = async () => {
              const available = Date.now() >= wakeAt + 4500;
              await new Promise(resolve => setTimeout(resolve, 500));
              return available ? [{ ...timerMessage('半小时后停止播放', '好的，30分钟后我会停止播放').message, timestamp_ms: wakeAt, request_id: 'sleep-533' }] : [];
            };
            client.doUbusRequest = async (_device, method, _path, message) => {
              if (method === 'player_get_play_status') {
                queries.push(Date.now());
                const speaking = interrupted && Date.now() < wakeAt + 8000;
                const info = interrupted
                  ? { status: speaking ? 1 : idleStatus }
                  : { status: 1, play_song_detail: { position: Math.min(Date.now() - streamAt, (300 - seek) / speed * 1000), duration: (300 - seek) / speed * 1000 } };
                await new Promise(resolve => setTimeout(resolve, 500));
                return { code: 0, data: { info: JSON.stringify(info) } };
              }
              await new Promise(resolve => setTimeout(resolve, 500));
              if (method === 'player_play_music' || method === 'player_play_url') {
                assert.equal(method, api === 'music' ? 'player_play_music' : 'player_play_url');
                const url = method === 'player_play_music' ? JSON.parse(message.music).payload.audio_items[0].stream.url : message.url;
                pushed.push({ url, at: Date.now() });
                seek = Number(new URL(url).searchParams.get('seek') || 0);
                streamAt = Date.now();
                interrupted = false;
              }
              if (method === 'text_to_speech' || method === 'player_play_tts') spoken.push(message.text);
              return { code: 0, data: { code: 0 } };
            };
            const { manager } = player({ mode: 'order' });
            manager.minaService = service;
            manager.streamSeekOffsetSec = seek;
            manager.playbackSpeed = speed;
            manager.playStartTimeMs = streamAt - seek / speed * 1000;
            manager.streamStartedAtMs = streamAt;
            manager.playbackConfirmed = true;
            manager.resetAutoNextTimer(manager.getPosition(), false);
            const engine = resumeEngine(manager);
            engine.configManager.getConfig = config.getConfig;
            engine.configManager.getChatConfig = config.getChatConfig;
            const players = engine.playlistManagerMap;
            const playback = new PlaybackCoordinator(players, service, config);
            const dispatcher = new VoiceDispatcher(config, engine, {
              status: () => ({ phase: 'completed', followup_until: 0 }),
              cancel: async () => { },
            }, playback);
            const monitor = new ConversationMonitor(accounts, config);
            monitor.registerCallback('voice', message => dispatcher.submit(message));
            const starting = monitor.start();
            await flush();
            await h.advance(1000);
            await starting;
            let polling = statusPage;
            let statusTimer;
            const poll = async () => {
              await resolvePlayerStatus({ getOrCreate: async () => manager }, service, 'account', 'speaker');
              if (polling) statusTimer = setTimeout(poll, 1000);
            };
            updateDeviceStatusCache('account', 'speaker', { timestamp: 0 });
            if (polling) void poll();
            // Prime both monitor idle backoff and the real device-status cache before waking the speaker.
            await h.advance(10000);
            wakeAt = Date.now();
            interrupted = true;
            await h.advance(7999);
            assert.equal(pushed.length, 0, 'do not interrupt the native answer');
            await h.advance(16001);
            assert.equal(monitor.getMessages().length, 1, 'the real monitor must deliver and deduplicate the cloud record');
            assert.equal(pushed.length, 1, 'the full guarded dispatch/cache chain must actually send recovery audio');
            assert.match(pushed[0].url, /\/songs\/16\/play/);
            assert.ok(Number(new URL(pushed[0].url).searchParams.get('seek')) >= 60 + 31 * speed, 'preserve the pre-wakeup position');
            assert.equal(manager.getPlaybackSpeed(), speed);
            assert.equal(manager.isVoiceSuspended(), false);
            assert.deepEqual(spoken, [], 'the real client must receive no duplicate native confirmation');
            assert.equal(engine.getSleepTimerState('account', 'speaker').total, 1800000);
            monitor.stop();
            for (let index = 0; index < 2; index++) {
              const endAt = streamAt + (300 - seek) / speed * 1000;
              await h.advance(endAt - Date.now() - 1);
              assert.equal(manager.currentIndex, index, 'preserve each track through its actual end');
              await h.advance(7001);
              assert.equal(manager.currentIndex, index + 1);
              assert.equal(pushed.length, index + 2);
              assert.ok(pushed.at(-1).url.includes(`/songs/${songs[index + 1].id}/play`));
            }
            assert.equal(manager.unplayableSongs.size, 0);
            assert.ok(manager.checkTimer !== null);
            assert.ok(queries.length > 0);
            assert.deepEqual(spoken, []);
            assert.ok(!h.logs.some(line => /Smart resume failed|VoiceDispatcher.*failed=|External stop confirmed/.test(line)));
            polling = false;
            clearTimeout(statusTimer);
            dispatcher.close();
            engine.close();
            playback.close();
            manager.cleanup();
            assert.equal(h.timers.size, 0);
          });
        });
      }
    }
  }
}

for (const withStatusPage of [false, true]) {
  for (const [seek, speed] of [[0, 1], [100, 0.5], [60, 2]]) {
    test(`issue 533: timer confirmation restores saved audio and natural next, statusPage=${withStatusPage}, seek=${seek}, speed=${speed}`, async () => {
      await withClock(async h => {
        let interrupted = false;
        let streamStartedAt = Date.now();
        let streamSeek = seek;
        const s = player({
          service: {
            getPlayState: async () => interrupted
              ? { status: 0, position: 0, duration: 0, hasPosition: true, sampledAt: Date.now() }
              : { status: 1, position: Math.min((Date.now() - streamStartedAt) / 1000, (300 - streamSeek) / speed), duration: (300 - streamSeek) / speed, hasPosition: true, sampledAt: Date.now() },
            playURL: async (_account, _device, url) => {
              s.pushes.push(url);
              streamSeek = Number(new URL(url).searchParams.get('seek') || 0);
              streamStartedAt = Date.now();
              interrupted = false;
              return true;
            },
          },
        });
        await s.manager.playCurrent({ seekSeconds: seek, speed });
        await h.advance(20000);
        const savedPosition = s.manager.getPosition();
        const engine = resumeEngine(s.manager);
        interrupted = true;
        await engine.handleMessage(timerMessage('半小时后停止播放', '好的，30分钟后我会停止播放'), { current: () => true });
        assert.equal(s.manager.isVoiceSuspended(), true, 'timer controls must own recovery after the wakeup');
        assert.deepEqual(s.tts, [], 'reuse the matching native confirmation');
        let pollTimer;
        let polling = withStatusPage;
        const poll = async () => {
          await resolvePlayerStatus({ getOrCreate: async () => s.manager }, s.manager.minaService, 'account', 'speaker');
          if (polling) pollTimer = setTimeout(poll, 1000);
        };
        updateDeviceStatusCache('account', 'speaker', { timestamp: 0 });
        if (polling) await poll();
        await h.advance(10000);
        assert.equal(s.pushes.length, 2, 'recovery must actually push the saved song URL');
        assert.equal(Number(new URL(s.pushes[1]).searchParams.get('seek')), savedPosition);
        assert.equal(s.manager.getPlaybackSpeed(), speed);
        assert.equal(s.manager.state, 'playing');
        assert.equal(s.manager.isVoiceSuspended(), false);
        const endAt = streamStartedAt + (300 - streamSeek) / speed * 1000;
        await h.advance(endAt - Date.now() - 1);
        assert.equal(s.manager.currentIndex, 0, 'do not cut the recovered song early');
        await h.advance(7001);
        assert.equal(s.manager.currentIndex, 1);
        assert.match(s.pushes.at(-1), /\/songs\/17\/play/);
        assert.equal(s.manager.unplayableSongs.size, 0);
        assert.ok(s.manager.checkTimer !== null);
        polling = false;
        clearTimeout(pollTimer);
        engine.close();
        s.manager.cleanup();
        assert.equal(h.timers.size, 0);
      });
    });
  }
}

for (const [question, ai] of [
  ['30分钟后停止播放', null],
  ['再听3首后停止', null],
  ['还有多久停', null],
  ['取消定时', null],
  ['等会儿帮我停下', { action: 'sleep_timer', params: { duration: 30 } }],
  ['听够三首就歇会', { action: 'sleep_timer', params: { songs_count: 3 } }],
  ['撤掉那个安排', { action: 'cancel_sleep_timer', params: {} }],
  ['告诉我剩余时间', { action: 'query_sleep_timer', params: {} }],
]) {
  test(`issue 533: ${ai ? 'AI' : 'rule'} timer control suspends before a slow confirmation: ${question}`, async () => {
    await withClock(async h => {
      const pendingSpeech = deferred();
      const s = player({ service: { textToSpeech: () => pendingSpeech.promise } });
      const engine = resumeEngine(s.manager);
      if (ai) {
        engine.configManager.getAIConfig = async () => ({ enabled: true });
        engine.aiAnalyzer = { analyze: async () => ({ ...ai, confidence: 'high' }) };
      }
      s.manager.playStartTimeMs = Date.now() - 60000;
      s.manager.startCheckTimer(240);
      const pending = engine.handleMessage(timerMessage(question), { current: () => true });
      await flush();
      assert.equal(s.manager.isVoiceSuspended(), true);
      assert.equal(s.manager.checkTimer, null);
      await h.advance(12000);
      assert.equal(s.manager.getPosition(), 60, 'TTS wait must not advance the resume anchor');
      pendingSpeech.resolve();
      assert.equal(await pending, true);
      assert.equal(engine.voiceResume.tasks.size, 1);
      engine.close();
      s.manager.cleanup();
      assert.equal(h.timers.size, 0);
    });
  });
}

for (const content of ['', '好的', '抱歉，无法设置30分钟后停止播放', '好的，40分钟后我会停止播放', '好的，1小时30分钟后我会停止播放']) {
  test(`issue 533: keep plugin confirmation for absent or different native answer: ${content}`, async () => {
    await withClock(async h => {
      const s = player();
      const engine = resumeEngine(s.manager);
      await engine.handleMessage(timerMessage('半小时后停止播放', content));
      assert.deepEqual(s.tts, ['好的，30分钟后将停止播放']);
      assert.equal(engine.getSleepTimerState('account', 'speaker').total, 1800000);
      engine.close();
      s.manager.cleanup();
      assert.equal(h.timers.size, 0);
    });
  });
}

for (const ai of [false, true]) {
  for (const content of ['好的，30分钟后我会停止播放', '好的，半小时后将停止播放', '没问题，三十分钟后会自动停止播放。']) {
    test(`issue 533: ${ai ? 'AI' : 'rule'} reuses explicit native confirmation: ${content}`, async () => {
      await withClock(async h => {
        const s = player();
        s.manager.state = 'paused';
        const engine = resumeEngine(s.manager);
        if (ai) {
          engine.configManager.getVoiceCommands = async () => [];
          engine.configManager.getAIConfig = async () => ({ enabled: true });
          engine.aiAnalyzer = { analyze: async () => ({ action: 'sleep_timer', params: { duration: 30 }, confidence: 'high' }) };
        }
        await engine.handleMessage(timerMessage(ai ? '等会儿帮我停下' : '半小时后停止播放', content));
        assert.deepEqual(s.tts, []);
        assert.equal(engine.getSleepTimerState('account', 'speaker').total, 1800000);
        assert.equal(s.manager.state, 'paused');
        assert.equal(s.manager.isVoiceSuspended(), false);
        assert.equal(engine.voiceResume.tasks.size, 0, 'setting a timer must not start paused audio');
        engine.close();
        s.manager.cleanup();
        assert.equal(h.timers.size, 0);
      });
    });
  }
}

test('issue 533: 30-minute timer stops exactly on expiry and an in-flight recovery cannot restart audio', async () => {
  await withClock(async h => {
    const state = deferred();
    const s = player({ initialSongs: songs.map(song => ({ ...song, duration: 3600 })), service: { getPlayState: () => state.promise } });
    const engine = resumeEngine(s.manager);
    await engine.handleMessage(timerMessage('半小时后停止播放', '好的，30分钟后我会停止播放'));
    await h.advance(1799999);
    assert.equal(s.manager.isPlaying(), true);
    assert.equal(engine.getSleepTimerState('account', 'speaker').remaining, 1);
    await h.advance(1);
    assert.equal(s.manager.isPlaying(), false);
    assert.equal(engine.getSleepTimerState('account', 'speaker').active, false);
    state.resolve({ status: 0, position: 0, duration: 0, hasPosition: true, sampledAt: Date.now() });
    await h.advance(10000);
    assert.deepEqual(s.pushes, []);
    engine.close();
    s.manager.cleanup();
    assert.equal(h.timers.size, 0);
  });
});

test('issue 533: song-count timer survives recovery and stops after the requested songs', async () => {
  await withClock(async h => {
    const s = player({
      service: {
        getPlayState: async () => s.pushes.length
          ? { status: 1, position: 12, duration: 300, hasPosition: true, sampledAt: Date.now() }
          : { status: 0, position: 0, duration: 0, hasPosition: true, sampledAt: Date.now() }
      }
    });
    const engine = resumeEngine(s.manager);
    await engine.handleMessage(timerMessage('再听2首后停止'));
    await h.advance(3000);
    assert.equal(s.manager.isVoiceSuspended(), false);
    assert.match(s.pushes.at(-1), /\/songs\/16\/play/);
    assert.equal(engine.getSleepTimerState('account', 'speaker').remaining, 2);
    await s.manager.onSongFinished();
    assert.equal(s.manager.currentIndex, 1);
    assert.match(s.pushes.at(-1), /\/songs\/17\/play/);
    assert.equal(engine.getSleepTimerState('account', 'speaker').remaining, 1);
    await s.manager.onSongFinished();
    assert.equal(s.manager.isPlaying(), false);
    assert.equal(engine.getSleepTimerState('account', 'speaker').active, false);
    await h.advance(10000);
    assert.equal(s.pushes.length, 2);
    engine.close();
    s.manager.cleanup();
    assert.equal(h.timers.size, 0);
  });
});

for (const action of ['pause', 'next', 'new voice', 'TTS failure']) {
  test(`issue 533: ${action} during confirmation cannot revive stale audio`, async () => {
    await withClock(async h => {
      const speech = deferred();
      const s = player({ service: { textToSpeech: () => speech.promise, pausePlayVerified: async () => 'paused' } });
      const engine = resumeEngine(s.manager);
      let current = true;
      const pending = engine.handleMessage(timerMessage('30分钟后停止播放'), { current: () => current });
      await flush();
      if (action === 'pause') await s.manager.pause();
      if (action === 'next') await s.manager.next();
      if (action === 'new voice') current = false;
      if (action === 'TTS failure') speech.reject(new Error('speech unavailable'));
      else speech.resolve();
      if (action === 'TTS failure') {
        await assert.rejects(pending, /speech unavailable/);
        assert.equal(engine.voiceResume.tasks.size, 1, 'confirmation failure still needs recovery');
      } else {
        await pending;
        assert.equal(engine.voiceResume.tasks.size, 0);
      }
      engine.close();
      s.manager.cleanup();
      assert.equal(h.timers.size, 0);
    });
  });
}

async function continuePlaying(engine) {
  await engine.handleMessage({
    device_id: 'speaker',
    message: { response: { answer: [{ question: '继续播放' }] } },
  });
}

function voiceSession({ readState, timeout = 30, resumeResult = true, duration = 300, position = 60, seekOffset = 0, speed = 1, unmatched = false } = {}) {
  const queries = [];
  const resumes = [];
  const { manager, pushes } = player({
    initialSongs: [{ ...songs[0], duration }, ...songs.slice(1)],
    service: {
      getPlayState: async (_account, _device, options) => {
        queries.push({ at: Date.now(), options });
        return readState
          ? readState(queries.length)
          : { status: resumes.length ? 1 : 2, position: resumes.length ? 60 + (Date.now() - resumes[0]) / 1000 : 60, duration: 300, hasPosition: true, sampledAt: Date.now() };
      },
      resumePlay: async () => { resumes.push(Date.now()); return resumeResult; },
      pausePlayVerified: async () => 'paused',
    }
  });
  manager.streamSeekOffsetSec = seekOffset;
  manager.playbackSpeed = speed;
  manager.playStartTimeMs = Date.now() - position / speed * 1000;
  const engine = resumeEngine(manager);
  engine.configManager.getConfig = async () => ({ smart_resume_timeout: timeout, voice_memory_enabled: false });
  if (unmatched) engine.resumeUnmatched('account', 'speaker');
  else {
    manager.suspendForVoiceInteraction();
    engine.scheduleSmartResume(manager, 'account', 'speaker');
  }
  return { manager, engine, pushes, queries, resumes };
}

for (const [position, seekOffset, speed] of [[60, 0, 1], [160, 100, 0.5], [120, 60, 2]]) {
  for (const snapshot of [
    { status: 1, volume: 40 },
    { status: 3, volume: 40 },
    { status: 1, play_song_detail: { position: 60000, duration: 300000 } },
  ]) {
    test(`issue 481: status fusion cannot cancel unmatched voice recovery seek=${seekOffset} speed=${speed} ${JSON.stringify(snapshot)}`, async () => {
      await withClock(async h => {
        let landedAt = 0;
        const s = voiceSession({ position, seekOffset, speed, unmatched: true, readState: () => landedAt ? {
          status: 1, position: (Date.now() - landedAt) / 1000,
          duration: (300 - s.manager.getStreamSeekOffsetSec()) / speed, hasPosition: true, sampledAt: Date.now(),
        } : { status: 3, position: 0, duration: 0, hasPosition: false, sampledAt: Date.now() } });
        const push = s.manager.minaService.playURL;
        s.manager.minaService.playURL = async (...args) => { landedAt = Date.now(); return push(...args); };
        const info = snapshot.play_song_detail ? { ...snapshot, play_song_detail: {
          position: (position - seekOffset) / speed * 1000, duration: (300 - seekOffset) / speed * 1000,
        } } : snapshot;
        s.manager.minaService.getPlayerStatus = async () => ({ sampledAt: Date.now(), data: { info: JSON.stringify(info) } });
        updateDeviceStatusCache('account', 'speaker', { timestamp: 0 });
        const revision = s.manager.getPlaybackRevision();
        await resolvePlayerStatus({ getOrCreate: async () => s.manager }, s.manager.minaService, 'account', 'speaker');
        await flush();
        assert.equal(s.manager.getPlaybackRevision(), revision);
        assert.equal(s.manager.isVoiceSuspended(), true);
        assert.equal(s.manager.getPosition(), position);
        await h.advance(4000);
        assert.equal(s.pushes.length, 1, 'a lost media context requires a real seek URL');
        assert.ok(s.pushes[0].includes(`seek=${position}`));
        if (speed !== 1) assert.ok(s.pushes[0].includes(`speed=${speed}`));
        const endAt = landedAt + (300 - position) / speed * 1000;
        await h.advance(endAt - Date.now() - 1);
        assert.equal(s.pushes.length, 1);
        assert.equal(s.manager.currentIndex, 0);
        await h.advance(1);
        assert.equal(s.pushes.length, 2);
        assert.ok(s.pushes[1].includes('/songs/17/play'));
        assert.equal(s.manager.currentIndex, 1);
        assert.equal(s.manager.state, 'playing');
        assert.equal(s.manager.unplayableSongs.size, 0);
        await h.advance(300000 / speed - 1);
        assert.equal(s.pushes.length, 2);
        await h.advance(1);
        assert.equal(s.pushes.length, 3);
        assert.ok(s.pushes[2].includes('/songs/18/play'));
        s.engine.setEnabled(false);
        s.manager.cleanup();
        assert.equal(h.timers.size, 0);
      });
    });
  }
}

test('issues 481, 124 and 516: status-only smart resume actually restores audio without inventing measured progress', async () => {
  await withClock(async h => {
    const s = voiceSession({
      timeout: 5, position: 290,
      readState: () => ({ status: 1, position: 0, duration: 0, hasPosition: false, sampledAt: Date.now() }),
    });
    await h.advance(5000);
    assert.equal(s.manager.isVoiceSuspended(), false);
    assert.equal(s.manager.getPosition(), 290);
    assert.equal(s.resumes.length, 0);
    assert.equal(s.pushes.length, 1);
    assert.ok(s.pushes[0].includes('seek=290'));
    assert.equal(s.manager.devicePositionObserved, false);
    await h.advance(9999);
    assert.equal(s.pushes.length, 1);
    await h.advance(1);
    assert.equal(s.manager.getCurrentSong().id, 17);
    assert.equal(s.pushes.length, 2);
    s.manager.cleanup();
    assert.equal(h.timers.size, 0);
  });
});

test('issues 124 and 171: a status-only HTTP snapshot during suspension keeps metadata fallback', async () => {
  await withClock(async h => {
    const { manager, pushes } = player({
      initialSongs: songs.map(song => ({ ...song, duration: 20 })),
      service: {
        getPlayerStatus: async () => ({ data: { info: JSON.stringify({ status: 1, volume: 30 }) }, sampledAt: Date.now() }),
        getPlayState: async () => ({ status: 1, position: 0, duration: 0, hasPosition: false }),
      },
    });
    manager.playStartTimeMs = Date.now();
    manager.startCheckTimer(20);
    manager.suspendForVoiceInteraction();
    const engine = resumeEngine(manager);
    engine.configManager.getConfig = async () => ({ smart_resume_timeout: 5 });
    engine.scheduleSmartResume(manager, 'account', 'speaker');
    updateDeviceStatusCache('account', 'speaker', { timestamp: 0 });
    await resolvePlayerStatus({ getOrCreate: async () => manager }, manager.minaService, 'account', 'speaker');
    await flush();
    assert.equal(manager.isVoiceSuspended(), true);
    assert.equal(manager.devicePositionObserved, false);
    await h.advance(4999);
    assert.equal(pushes.length, 0);
    await h.advance(1);
    assert.equal(pushes.length, 1);
    assert.equal(manager.getCurrentSong().id, 16);
    assert.equal(manager.devicePositionObserved, false);
    await h.advance(19999);
    assert.equal(pushes.length, 1);
    await h.advance(1);
    assert.equal(manager.getCurrentSong().id, 17);
    assert.equal(pushes.length, 2);
    engine.setEnabled(false);
    manager.cleanup();
    assert.equal(h.timers.size, 0);
  });
});

test('issues 495 and 516: genuine smart-resume progress survives a later cloud failure', async () => {
  await withClock(async h => {
    const s = voiceSession({
      timeout: 5, position: 290,
      readState: n => n === 1
        ? { status: 1, position: 290, duration: 300, hasPosition: true, sampledAt: Date.now() }
        : { status: Date.now() < 105000 ? -1 : 1, position: 0, duration: 0, hasPosition: false, sampledAt: Date.now() },
    });
    await h.advance(15000);
    assert.equal(s.pushes.length, 0);
    await h.advance(29999);
    assert.equal(s.pushes.length, 0);
    await h.advance(1);
    assert.equal(s.manager.getCurrentSong().id, 17);
    assert.equal(s.pushes.length, 1);
    s.manager.cleanup();
    assert.equal(h.timers.size, 0);
  });
});

test('a short voice reply resumes promptly with fresh samples and keeps the interrupted position', async () => {
  await withClock(async h => {
    const s = voiceSession();
    await h.advance(4000);
    assert.equal(s.resumes.length, 1);
    assert.ok(s.resumes[0] <= 102000, 'resume should not wait for the old three-second guard or five-second cache');
    assert.ok(s.queries.every(q => q.options.verify));
    assert.equal(s.pushes.length, 0);
    assert.equal(s.manager.getPosition(), 62);
    assert.equal(s.manager.isVoiceSuspended(), false);
    s.manager.cleanup();
  });
});

test('assistant media is allowed to finish and the first idle sample gets a prompt confirmation', async () => {
  await withClock(async h => {
    const s = voiceSession({
      readState: () => ({
        status: Date.now() < 104000 ? 1 : 2,
        duration: 6, position: 1, hasPosition: true, sampledAt: Date.now(),
      })
    });
    await h.advance(3999);
    assert.equal(s.pushes.length, 0);
    assert.equal(s.resumes.length, 0);
    await h.advance(1001);
    assert.equal(s.resumes.length, 0, 'a replaced media context needs the song URL');
    assert.equal(s.pushes.length, 1);
    assert.ok(s.pushes[0].includes('seek=60'), 'waiting for speech must not skip music');
    s.manager.cleanup();
  });
});

test('confirmed automatic recovery only recalibrates the song timer, including seek and speed', async () => {
  await withClock(async h => {
    const s = voiceSession({ position: 100, seekOffset: 100, speed: 0.5,
      readState: () => ({ status: 1, duration: 400, position: (Date.now() - 100000) / 1000, hasPosition: true, sampledAt: Date.now() }) });
    await h.advance(2000);
    assert.equal(s.resumes.length, 0);
    assert.equal(s.pushes.length, 0);
    assert.equal(s.manager.getPosition(), 101);
    assert.equal(s.manager.isVoiceSuspended(), false);
    s.manager.cleanup();
  });
});

test('idle progress reset cannot replace the interrupted position before a URL repush', async () => {
  await withClock(async h => {
    const s = voiceSession({ resumeResult: false, readState: () => ({
      status: 2, position: 0, duration: 300, hasPosition: true, sampledAt: Date.now(),
    }) });
    await h.advance(2000);
    assert.equal(s.resumes.length, 1);
    assert.equal(s.pushes.length, 1);
    assert.ok(s.pushes[0].includes('seek=60'), 'a reset device counter must not restart the song');
    s.manager.cleanup();
  });
});

for (const status of [0, 1, 2, 3]) {
  test(`advancing restarted audio is restored at the interrupted position despite status=${status}`, async () => {
    await withClock(async h => {
      const s = voiceSession({ readState: () => ({
        status, position: (Date.now() - 100000) / 1000, duration: 300, hasPosition: true, sampledAt: Date.now(),
      }) });
      await h.advance(2000);
      assert.equal(s.resumes.length, 0, 'restarted audio needs a seek URL, not a bare resume');
      assert.equal(s.pushes.length, 1);
      assert.ok(s.pushes[0].includes('seek=60'));
      assert.equal(s.manager.getPosition(), 60);
      s.manager.cleanup();
    });
  });
}

test('restart detection compares absolute song positions for seeked audio at another speed', async () => {
  await withClock(async h => {
    const s = voiceSession({ position: 160, seekOffset: 100, speed: 0.5,
      readState: () => ({ status: 1, position: (Date.now() - 100000) / 1000, duration: 400, hasPosition: true, sampledAt: Date.now() }),
    });
    await h.advance(2000);
    assert.equal(s.pushes.length, 1);
    assert.ok(s.pushes[0].includes('seek=160'));
    assert.equal(s.manager.getPosition(), 160);
    s.manager.cleanup();
  });
});

test('small device position drift still permits automatic voice recovery', async () => {
  await withClock(async h => {
    const s = voiceSession({ readState: () => ({
      status: 1, position: 56 + (Date.now() - 100000) / 1000, duration: 300, hasPosition: true, sampledAt: Date.now(),
    }) });
    await h.advance(2000);
    assert.equal(s.pushes.length, 0);
    assert.equal(s.resumes.length, 0);
    assert.equal(s.manager.getPosition(), 58);
    s.manager.cleanup();
  });
});

test('status calibration cannot erase the interrupted position before smart resume observes a restart', async () => {
  await withClock(async h => {
    const s = voiceSession({ readState: () => ({
      status: 1, position: (Date.now() - 100000) / 1000, duration: 300, hasPosition: true, sampledAt: Date.now(),
    }) });
    s.manager.resetAutoNextTimer(1);
    assert.equal(s.manager.getPosition(), 60);
    assert.equal(s.manager.isVoiceSuspended(), true);
    await h.advance(2000);
    assert.equal(s.pushes.length, 1);
    assert.ok(s.pushes[0].includes('seek=60'));
    s.manager.cleanup();
  });
});

test('issue 171 HTTP and WebSocket status fusion cannot cancel voice recovery after a device counter reset', async () => {
  await withClock(async h => {
    const s = voiceSession({ readState: () => ({
      status: 1, position: (Date.now() - 100000) / 1000, duration: 300, hasPosition: true, sampledAt: Date.now(),
    }) });
    s.manager.minaService.getPlayerStatus = async () => ({ sampledAt: Date.now(), data: { info: JSON.stringify({
      status: 1, volume: 40, play_song_detail: { position: 1000, duration: 300000 },
    }) } });
    updateDeviceStatusCache('account', 'speaker', { timestamp: 0 });
    const revision = s.manager.getPlaybackRevision();
    await resolvePlayerStatus({ getOrCreate: async () => s.manager }, s.manager.minaService, 'account', 'speaker');
    await flush();
    assert.equal(s.manager.getPosition(), 60);
    assert.equal(s.manager.getPlaybackRevision(), revision);
    assert.equal(s.manager.isVoiceSuspended(), true);
    await h.advance(2000);
    assert.equal(s.pushes.length, 1);
    assert.ok(s.pushes[0].includes('seek=60'));
    s.manager.cleanup();
  });
});

for (const status of [0, 1, 2, 3]) {
  test(`issues 171 and 449: advancing buffered music at status=${status} must not be re-pushed for clock drift`, async () => {
    await withClock(async h => {
      const s = voiceSession({ readState: () => ({ status, position: 48 + (Date.now() - 100000) / 1000,
        duration: 300, hasPosition: true, sampledAt: Date.now() }),
      });
      await h.advance(2000);
      assert.equal(s.resumes.length, 0);
      assert.equal(s.pushes.length, 0, 'a lagging local clock does not prove a media restart');
      assert.equal(s.manager.getPosition(), 50);
      assert.equal(s.manager.isVoiceSuspended(), false);
      s.manager.cleanup();
    });
  });

  test(`resume verification accepts buffered music at status=${status} without repeating the URL`, async () => {
    await withClock(async h => {
      const { manager, pushes } = player({ service: {
        resumePlay: async () => true,
        getPlayState: async () => ({ status, position: 48 + (Date.now() - 100000) / 1000,
          duration: 300, hasPosition: true, sampledAt: Date.now() }),
      } });
      manager.playStartTimeMs = Date.now() - 60000;
      await manager.resumePlayback();
      await h.advance(3000);
      assert.equal(pushes.length, 0, 'advancing audio away from the stream start is not a reset');
      manager.cleanup();
    });
  });
}

for (const sample of ['duplicate', 'pre-interaction']) {
  test(`issue 503: ${sample} low progress cannot trigger a restart repush`, async () => {
    await withClock(async h => {
      const s = voiceSession({ timeout: 5, readState: () => ({
        status: 1, position: (Date.now() - 100000) / 1000, duration: 300, hasPosition: true,
        sampledAt: sample === 'duplicate' ? 101000 : 99999,
      }) });
      await h.advance(5000);
      assert.equal(s.pushes.length, 0);
      assert.equal(s.resumes.length, 0);
      assert.equal(s.manager.getPosition(), 60);
      assert.equal(s.manager.isVoiceSuspended(), false);
      s.manager.cleanup();
    });
  });
}

test('a confirmed reset remains detectable when the next cloud query returns beyond the first three seconds', async () => {
  await withClock(async h => {
    const s = voiceSession({ readState: count => ({ status: 1, position: count === 1 ? 1 : 8,
      duration: 300, hasPosition: true, sampledAt: Date.now() }),
    });
    await h.advance(2000);
    assert.equal(s.pushes.length, 1);
    assert.ok(s.pushes[0].includes('seek=60'));
    s.manager.cleanup();
  });
});

for (const action of ['pause', 'stop', 'next', 'DLNA takeover']) {
  test(`issues 408 and 494: ${action} invalidates an in-flight reset confirmation`, async () => {
    await withClock(async h => {
      const pending = deferred();
      const s = voiceSession({ readState: count => count === 1
        ? ({ status: 1, position: 0, duration: 300, hasPosition: true, sampledAt: Date.now() }) : pending.promise,
      });
      await h.advance(2000);
      if (action === 'pause') await s.manager.pause();
      else if (action === 'stop') await s.manager.stop();
      else if (action === 'next') await s.manager.next();
      else await s.manager.beginExternalPlayback(() => {});
      const state = s.manager.getStatus().state;
      const pushes = s.pushes.length;
      pending.resolve({ status: 1, position: 1, duration: 300, hasPosition: true, sampledAt: Date.now() });
      await flush();
      await h.advance(3000);
      assert.equal(s.pushes.length, pushes);
      assert.equal(s.manager.getStatus().state, state);
      assert.equal(s.resumes.length, 0);
      s.manager.cleanup();
    });
  });
}

test('issues 60 and 61: group restart recovery keeps normalization, speed, absolute seek and one stable URL', async () => {
  await withClock(async h => {
    const s = voiceSession({ position: 120, seekOffset: 60, speed: 2,
      readState: () => ({ status: 1, position: (Date.now() - 100000) / 1000,
        duration: 120, hasPosition: true, sampledAt: Date.now() }),
    });
    const targets = [];
    s.manager.setTargets([{ account_id: 'account', device_id: 'speaker' }, { account_id: 'account', device_id: 'second' }]);
    s.manager.configManager.getConfig = async () => ({ volume_normalize: true });
    s.manager.minaService.playURL = async (_account, device, url) => { targets.push({ device, url }); return true; };
    await h.advance(2000);
    assert.deepEqual(targets.map(t => t.device), ['speaker', 'second']);
    assert.equal(targets[0].url, targets[1].url);
    const url = new URL(targets[0].url);
    assert.equal(url.pathname, '/api/v1/songs/16/play');
    assert.equal(url.searchParams.get('seek'), '120');
    assert.equal(url.searchParams.get('speed'), '2');
    assert.equal(url.searchParams.get('normalize'), '1');
    assert.equal(url.searchParams.get('format'), 'mp3');
    assert.equal([...url.searchParams.keys()][0], 'access_token');
    assert.equal(url.searchParams.size, 5, 'no per-device timestamps or playback parameters may change the URL');
    assert.equal(s.manager.getPosition(), 120);
    s.manager.cleanup();
  });
});

test('voice restart recovery near the song tail uses the last safe seek instead of restarting the whole song', async () => {
  await withClock(async h => {
    const s = voiceSession({ position: 299, readState: () => ({
      status: 1, position: (Date.now() - 100000) / 1000, duration: 300, hasPosition: true, sampledAt: Date.now(),
    }) });
    await h.advance(2000);
    assert.equal(s.pushes.length, 1);
    assert.ok(s.pushes[0].includes('seek=296'));
    s.manager.cleanup();
  });
});

test('a low advancing counter without media identity cannot prove a restart or reset the song timer', async () => {
  await withClock(async h => {
    const s = voiceSession({ timeout: 5, readState: () => ({
      status: 1, position: (Date.now() - 100000) / 1000, duration: 0, hasPosition: true, sampledAt: Date.now(),
    }) });
    await h.advance(5000);
    assert.equal(s.pushes.length, 0);
    assert.equal(s.resumes.length, 0);
    assert.equal(s.manager.getPosition(), 60);
    assert.equal(s.manager.isVoiceSuspended(), false);
    s.manager.cleanup();
  });
});

for (const scenario of ['query failure', 'cached idle', 'cached playing', 'cached status-only', 'pre-interaction sample']) {
  test(`${scenario} cannot prove that speech ended or trigger a URL repush`, async () => {
    await withClock(async h => {
      const s = voiceSession({
        timeout: 5, readState: () => ({
          status: scenario === 'query failure' ? -1 : scenario === 'cached idle' ? 2 : 1,
          position: 60, duration: 300,
          hasPosition: scenario !== 'cached status-only',
          sampledAt: scenario === 'pre-interaction sample' ? 99999
            : scenario.startsWith('cached') ? 101000 : Date.now(),
        })
      });
      await h.advance(5000);
      assert.equal(s.resumes.length, 0);
      assert.equal(s.pushes.length, 0);
      assert.equal(s.manager.isVoiceSuspended(), false);
      assert.equal(s.manager.getPosition(), 60, 'missing evidence must not reset progress to zero');
      assert.ok(h.logs.some(message => message.includes('without playback evidence')));
      if (scenario === 'query failure') assert.equal(s.queries.length, 1, 'failure should leave fast polling and honor backoff');
      s.manager.cleanup();
    });
  });
}

test('a transient query failure requires new idle evidence before resuming', async () => {
  await withClock(async h => {
    const s = voiceSession({ readState: count => ({ status: count === 1 ? -1 : 2, position: 60, duration: 300, hasPosition: true, sampledAt: Date.now() }) });
    await h.advance(6999);
    assert.equal(s.resumes.length, 0);
    await h.advance(1);
    assert.equal(s.resumes.length, 1);
    assert.equal(s.pushes.length, 0);
    assert.equal(s.queries[1].options.verify, undefined, 'recovery should first respect ordinary query backoff');
    s.engine.setEnabled(false);
    s.manager.cleanup();
  });
});

test('idle then unknown is not two confirmations of speech completion', async () => {
  await withClock(async h => {
    const s = voiceSession({ timeout: 5, readState: count => ({ status: count === 1 ? 2 : -1, position: 60, duration: 300, hasPosition: true, sampledAt: Date.now() }) });
    await h.advance(5000);
    assert.equal(s.resumes.length, 0);
    assert.equal(s.pushes.length, 0);
    s.manager.cleanup();
  });
});

test('fast polling is bounded while the assistant continues speaking', async () => {
  await withClock(async h => {
    const s = voiceSession({ readState: () => ({ status: 1, position: 1, duration: 8, hasPosition: true, sampledAt: Date.now() }) });
    await h.advance(29000);
    assert.ok(s.queries.filter(q => q.options.verify).length <= 5);
    assert.ok(s.queries.length < 12);
    assert.equal(s.pushes.length, 0);
    assert.equal(s.resumes.length, 0);
    s.engine.setEnabled(false);
    s.manager.cleanup();
  });
});

test('frozen own-media progress is replayed only after the configured speech timeout', async () => {
  await withClock(async h => {
    const s = voiceSession({ timeout: 5, readState: () => ({ status: 1, position: 60, duration: 300, hasPosition: true, sampledAt: Date.now() }) });
    await h.advance(4999);
    assert.equal(s.pushes.length, 0);
    await h.advance(1);
    assert.equal(s.pushes.length, 1);
    assert.ok(s.pushes[0].includes('seek=60'));
    s.manager.cleanup();
  });
});

for (const action of ['pause', 'stop', 'same-song restart', 'next']) {
  test(`an old voice query cannot restore playback after ${action}`, async () => {
    await withClock(async h => {
      const pending = deferred();
      const s = voiceSession({ readState: () => pending.promise });
      await h.advance(1000);
      if (action === 'pause') await s.manager.pause();
      else if (action === 'stop') await s.manager.stop();
      else if (action === 'next') await s.manager.next();
      else await s.manager.playAtIndex(0);
      const pushesAfterAction = s.pushes.length;
      const stateAfterAction = s.manager.getStatus().state;
      pending.resolve({ status: 2, position: 60, duration: 300, hasPosition: true, sampledAt: Date.now() });
      await flush();
      await h.advance(3000);
      assert.equal(s.resumes.length, 0);
      assert.equal(s.pushes.length, pushesAfterAction);
      assert.equal(s.manager.getStatus().state, stateAfterAction);
      s.manager.cleanup();
    });
  });
}

for (const phase of ['account lookup', 'AI analysis']) {
  test(`a new dialogue invalidates the old task before ${phase} completes`, async () => {
    await withClock(async h => {
      const pending = deferred();
      const processing = deferred();
      const s = voiceSession({ readState: () => pending.promise });
      await h.advance(1000);
      if (phase === 'account lookup') s.engine.accountManager.getAccounts = () => processing.promise;
      else s.engine.configManager.getAIConfig = () => processing.promise;
      const message = s.engine.handleMessage({ device_id: 'speaker', message: { response: { answer: [{ question: '今天天气怎么样' }] } } });
      await flush();
      pending.resolve({ status: 2, position: 60, duration: 300, hasPosition: true, sampledAt: Date.now() });
      await flush();
      await h.advance(1000);
      assert.equal(s.resumes.length, 0);
      assert.equal(s.pushes.length, 0);
      processing.resolve(phase === 'account lookup' ? [{ id: 'account' }] : { enabled: false });
      await message;
      s.engine.setEnabled(false);
      s.manager.cleanup();
    });
  });
}

test('a superseded task cannot mistake a later task for its own permission to resume', async () => {
  await withClock(async h => {
    const pending = deferred();
    const s = voiceSession({ readState: count => count === 1 ? pending.promise : ({ status: 2, position: 60, duration: 300, hasPosition: true, sampledAt: Date.now() }) });
    await h.advance(1000);
    s.manager.suspendForVoiceInteraction();
    s.engine.scheduleSmartResume(s.manager, 'account', 'speaker');
    pending.resolve({ status: 2, position: 60, duration: 300, hasPosition: true, sampledAt: Date.now() });
    await flush();
    await h.advance(1999);
    assert.equal(s.resumes.length, 0);
    await h.advance(1);
    assert.equal(s.resumes.length, 1);
    s.engine.setEnabled(false);
    s.manager.cleanup();
  });
});

for (const phase of ['initial delay', 'configuration read', 'status query']) {
  test(`disabling voice control cancels recovery during ${phase}`, async () => {
    await withClock(async h => {
      const pending = deferred();
      const s = voiceSession({ readState: () => pending.promise });
      if (phase === 'configuration read') s.engine.configManager.getConfig = () => pending.promise;
      if (phase !== 'initial delay') await h.advance(1000);
      s.engine.setEnabled(false);
      pending.resolve(phase === 'configuration read' ? { smart_resume_timeout: 5 }
        : { status: 2, position: 60, duration: 300, hasPosition: true, sampledAt: Date.now() });
      await flush();
      await h.advance(5000);
      assert.equal(s.resumes.length, 0);
      assert.equal(s.pushes.length, 0);
      s.manager.cleanup();
    });
  });
}

for (const result of [true, false]) {
  test(`pause wins over an in-flight resume whose response is ${result}`, async () => {
    await withClock(async h => {
      const pending = deferred();
      const s = voiceSession();
      s.manager.minaService.resumePlay = () => pending.promise;
      await h.advance(2000);
      await s.manager.pause();
      pending.resolve(result);
      await flush();
      await h.advance(3000);
      assert.equal(s.manager.getStatus().state, 'paused');
      assert.equal(s.pushes.length, 0);
      s.manager.cleanup();
    });
  });
}

for (const scenario of ['advancing', 'frozen', 'unavailable', 'missing progress', 'old foreign sample', 'duplicate sample']) {
  test(`resume verification handles ${scenario} device progress without trusting the command acknowledgment`, async () => {
    await withClock(async h => {
      const { manager, pushes } = player({
        service: {
          resumePlay: async () => true,
          getPlayState: async () => ({
            status: scenario === 'unavailable' ? -1 : 1,
            position: scenario === 'advancing' ? 60 + (Date.now() - 100000) / 1000 : 60,
            duration: scenario === 'old foreign sample' ? 5 : 300,
            hasPosition: scenario !== 'missing progress',
            sampledAt: scenario === 'old foreign sample' ? 99999
              : scenario === 'duplicate sample' ? 101000 : Date.now(),
          }),
        }
      });
      manager.playStartTimeMs = Date.now() - 60000;
      assert.equal(await manager.resumePlayback(), true);
      await h.advance(3000);
      assert.equal(pushes.length, scenario === 'frozen' ? 1 : 0);
      if (scenario === 'frozen') assert.ok(pushes[0].includes('seek=60'));
      if (scenario === 'unavailable') assert.ok(h.logs.some(message => message.includes('playback not verified')));
      manager.cleanup();
    });
  });
}

test('a resume verifier cannot repush an old same-song instance after a restart', async () => {
  await withClock(async h => {
    const pending = deferred();
    const { manager, pushes } = player({ service: { resumePlay: async () => true, getPlayState: () => pending.promise } });
    manager.playStartTimeMs = Date.now() - 60000;
    await manager.resumePlayback();
    await h.advance(1000);
    await manager.playAtIndex(0);
    pending.resolve({ status: 1, position: 1, duration: 5, hasPosition: true, sampledAt: Date.now() });
    await flush();
    await h.advance(3000);
    assert.equal(pushes.length, 1);
    assert.equal(manager.getStreamSeekOffsetSec(), 0);
    manager.cleanup();
  });
});

for (const scenario of [
  { name: 'known media', duration: 300, seekOffset: 0, speed: 1, position: 60, repush: true },
  { name: 'seeked slow media', duration: 400, seekOffset: 100, speed: 0.5, position: 160, repush: true },
  { name: 'unknown media', duration: 0, seekOffset: 0, speed: 1, position: 60, repush: false },
]) {
  test(`resume verification detects advancing restarted ${scenario.name}`, async () => {
    await withClock(async h => {
      const { manager, pushes } = player({ service: {
        resumePlay: async () => true,
        getPlayState: async () => ({ status: 1, position: (Date.now() - 100000) / 1000,
          duration: scenario.duration, hasPosition: true, sampledAt: Date.now() }),
      } });
      manager.streamSeekOffsetSec = scenario.seekOffset;
      manager.playbackSpeed = scenario.speed;
      manager.playStartTimeMs = Date.now() - scenario.position / scenario.speed * 1000;
      await manager.resumePlayback();
      await h.advance(3000);
      assert.equal(pushes.length, scenario.repush ? 1 : 0);
      if (scenario.repush) assert.ok(pushes[0].includes(`seek=${scenario.position}`));
      manager.cleanup();
    });
  });
}

test('a new dialogue cancels background resume verification before it can repush', async () => {
  await withClock(async h => {
    const s = voiceSession({ readState: () => ({ status: 2, position: 60, duration: 300, hasPosition: true, sampledAt: Date.now() }) });
    await h.advance(2000);
    assert.equal(s.resumes.length, 1);
    s.engine.cancelPendingResume('account', 'speaker');
    await h.advance(3000);
    assert.equal(s.pushes.length, 0);
    s.manager.cleanup();
  });
});

test('a canceled replay cannot stop a pending user restart of the same song', async () => {
  await withClock(async h => {
    const oldPush = deferred();
    const newPush = deferred();
    const s = voiceSession({ timeout: 5, readState: () => ({ status: 1, position: 60, duration: 300, hasPosition: true, sampledAt: Date.now() }) });
    let pushes = 0;
    s.manager.minaService.playURL = () => (++pushes === 1 ? oldPush : newPush).promise;
    await h.advance(5000);
    assert.equal(pushes, 1);
    const restarted = s.manager.replayCurrent(0);
    await flush();
    assert.equal(pushes, 2);
    oldPush.resolve(false);
    await flush();
    assert.equal(s.manager.getStatus().state, 'playing');
    newPush.resolve(true);
    assert.equal(await restarted, true);
    assert.equal(s.manager.getStreamSeekOffsetSec(), 0);
    s.manager.cleanup();
  });
});

for (const status of [0, 2]) {
  test(`voice recovery recognizes advancing music despite status=${status} misreports`, async () => {
    await withClock(async h => {
      const s = voiceSession({ readState: count => ({ status, position: count === 1 ? 62.3 : 62.4, duration: 300, hasPosition: true, sampledAt: Date.now() }) });
      await h.advance(2000);
      assert.equal(s.resumes.length, 0);
      assert.equal(s.pushes.length, 0);
      assert.ok(Math.abs(s.manager.getPosition() - 62.4) < 1e-9);
      assert.equal(s.manager.isVoiceSuspended(), false);
      s.manager.cleanup();
    });
  });

  test(`resume verification accepts advancing music despite status=${status} misreports`, async () => {
    await withClock(async h => {
      let reads = 0;
      const { manager, pushes } = player({
        service: {
          resumePlay: async () => true,
          getPlayState: async () => ({ status, position: ++reads === 1 ? 62.3 : 62.4, duration: 300, hasPosition: true, sampledAt: Date.now() }),
        }
      });
      manager.playStartTimeMs = Date.now() - 60000;
      await manager.resumePlayback();
      await h.advance(3000);
      assert.equal(pushes.length, 0);
      manager.cleanup();
    });
  });
}

test('brief buffering during resume can recover on the final sample without a URL repush', async () => {
  await withClock(async h => {
    let reads = 0;
    const { manager, pushes } = player({
      service: {
        resumePlay: async () => true,
        getPlayState: async () => ({ status: 1, position: ++reads <= 2 ? 60 : 61, duration: 300, hasPosition: true, sampledAt: Date.now() }),
      }
    });
    manager.playStartTimeMs = Date.now() - 60000;
    await manager.resumePlayback();
    await h.advance(3000);
    assert.equal(pushes.length, 0);
    manager.cleanup();
  });
});

test('a duplicate final sample cannot turn brief buffering into confirmed resume failure', async () => {
  await withClock(async h => {
    let reads = 0;
    const { manager, pushes } = player({
      service: {
        resumePlay: async () => true,
        getPlayState: async () => ({ status: 1, position: 60, duration: 300, hasPosition: true, sampledAt: ++reads <= 2 ? Date.now() : 102000 }),
      }
    });
    manager.playStartTimeMs = Date.now() - 60000;
    await manager.resumePlayback();
    await h.advance(3000);
    assert.equal(pushes.length, 0);
    manager.cleanup();
  });
});

test('automatic voice recovery preserves duration probing for a song with unknown metadata duration', async () => {
  await withClock(async h => {
    const s = voiceSession({
      duration: 0, readState: count => ({
        status: 1, position: 60 + (Date.now() - 100000) / 1000,
        duration: count <= 2 ? 0 : 70, hasPosition: true, sampledAt: Date.now(),
      })
    });
    await h.advance(2000);
    assert.equal(s.manager.isVoiceSuspended(), false);
    assert.equal(s.resumes.length, 0);
    assert.equal(s.pushes.length, 0);
    await h.advance(8000);
    assert.equal(s.manager.getCurrentSong().id, 17);
    assert.equal(s.pushes.length, 1);
    s.manager.cleanup();
  });
});

test('unknown-duration playback also continues probing when voice status was unavailable', async () => {
  await withClock(async h => {
    const s = voiceSession({
      duration: 0, timeout: 5, readState: () => ({
        status: Date.now() < 110000 ? -1 : 1,
        position: 60 + (Date.now() - 105000) / 1000,
        duration: 70, hasPosition: true, sampledAt: Date.now(),
      })
    });
    await h.advance(5000);
    assert.equal(s.resumes.length, 0);
    assert.equal(s.pushes.length, 0);
    assert.equal(s.manager.getPosition(), 60);
    await h.advance(10000);
    assert.equal(s.manager.getCurrentSong().id, 17);
    assert.equal(s.pushes.length, 1);
    s.manager.cleanup();
  });
});

test('unknown-duration resume excludes a long pause from progress and retains automatic next', async () => {
  await withClock(async h => {
    let resumedAt;
    let reads = 0;
    const { manager, pushes } = player({
      initialSongs: [{ ...songs[0], duration: 0 }, ...songs.slice(1)], service: {
        pausePlayVerified: async () => 'paused',
        resumePlay: async () => { resumedAt = Date.now(); return true; },
        getPlayState: async () => ({
          status: 1, position: 60 + (Date.now() - resumedAt) / 1000,
          duration: ++reads <= 2 ? 0 : 70, hasPosition: true, sampledAt: Date.now(),
        }),
      }
    });
    manager.playStartTimeMs = Date.now() - 60000;
    await manager.pause();
    await h.advance(3600000);
    await manager.resumePlayback();
    assert.equal(manager.getPosition(), 60);
    await h.advance(10000);
    assert.equal(manager.getCurrentSong().id, 17);
    assert.equal(pushes.length, 1);
    manager.cleanup();
  });
});

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
    const takeover = manager.beginExternalPlayback(() => { }).then(result => { acquired = result; });
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
    await manager.beginExternalPlayback(() => { });
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
    assert.equal(manager.isSongUnplayable(16), true);
    assert.equal(manager.landingFailureCount, 2);
    await h.advance(30000);
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
      const { manager } = player({
        service: {
          playURL: async () => false,
          getPlayState: () => { queries++; return slow.promise; },
        }
      });
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
      service: { getPlayState: async () => ({ status: 0, position: 0, duration: 300, hasPosition: true, sampledAt: Date.now() }) },
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

test('unavailable landing samples never skip or blacklist the playing song', async () => {
  await withClock(async h => {
    let status = -1;
    const { manager } = player({ service: { getPlayState: async () => ({ status, position: 0, duration: 300 }) } });
    let failures = 0;
    manager.handleLandingFailure = async () => { failures++; };
    manager.scheduleLandingVerify();
    await h.advance(60000);
    assert.equal(failures, 0);
    assert.equal(manager.isSongUnplayable(16), false);
    assert.equal(manager.currentIndex, 0);
    assert.equal(manager.state, 'playing');
    status = 0;
    await h.advance(16000);
    assert.equal(failures, 1);
    assert.equal(manager.isSongUnplayable(16), true);
    manager.cleanup();
  });
});

const oh2BlindState = () => ({ status: 0, position: 0, duration: 0, hasPosition: true, sampledAt: Date.now() });

test('issue 129: blind idle landing with a playable stream keeps the song playing', async () => {
  await withClock(async h => {
    const { manager, pushes } = player({
      service: { getPlayState: async () => oh2BlindState() },
    });
    let failures = 0;
    manager.handleLandingFailure = async () => { failures++; };
    manager.streamStartedAtMs = Date.now();
    manager.scheduleLandingVerify();
    await h.advance(60000);
    assert.equal(failures, 0);
    assert.equal(pushes.length, 0);
    assert.equal(manager.currentIndex, 0);
    assert.equal(manager.state, 'playing');
    assert.equal(manager.playbackConfirmed, true);
    assert.equal(manager.isSongUnplayable(16), false);
    assert.ok(h.hostCalls.some(([method, url]) => method === 'HEAD' && url === '/api/v1/songs/16/play'));
    assert.ok(h.logs.some(line => line.includes('device reports no usable state')));
    manager.cleanup();
    assert.equal(h.timers.size, 0);
  });
});

test('issue 129: blind idle landing still advances when the stream probe returns a server error', async () => {
  await withClock(async h => {
    const { manager, pushes } = player({
      service: { getPlayState: async () => oh2BlindState() },
    });
    http.callHostAPI = async method => {
      if (method === 'HEAD') throw new Error('Host API error 502: bad gateway');
      return {};
    };
    let failures = 0;
    manager.handleLandingFailure = async () => { failures++; };
    manager.streamStartedAtMs = Date.now();
    manager.scheduleLandingVerify();
    await h.advance(20000);
    assert.equal(failures, 1);
    assert.equal(pushes.length, 0);
    assert.equal(manager.isSongUnplayable(16), true);
    assert.ok(h.logs.some(line => line.includes('stream probe failed')));
    manager.cleanup();
  });
});

test('issue 129: blind idle landing with an inconclusive probe is kept after two bounded attempts', async () => {
  await withClock(async h => {
    const { manager } = player({
      service: { getPlayState: async () => oh2BlindState() },
    });
    http.callHostAPI = async method => {
      if (method === 'HEAD') throw new Error('timeout');
      return {};
    };
    let failures = 0;
    manager.handleLandingFailure = async () => { failures++; };
    manager.streamStartedAtMs = Date.now();
    manager.scheduleLandingVerify();
    await h.advance(17000);
    assert.equal(failures, 0);
    assert.equal(manager.playbackConfirmed, false);
    await h.advance(3000);
    assert.equal(failures, 0);
    assert.equal(manager.playbackConfirmed, true);
    manager.cleanup();
  });
});

test('issue 129: a blind all-zero device advances through two natural transitions without blacklisting', async () => {
  await withClock(async h => {
    const blindSongs = songs.map(song => ({ ...song, duration: 60 }));
    const { manager, pushes, tts } = player({
      mode: 'order',
      initialSongs: blindSongs,
      service: { getPlayState: async () => oh2BlindState() },
    });
    let failures = 0;
    manager.handleLandingFailure = async () => { failures++; };
    assert.equal(await manager.playCurrent(), true);
    await h.advance(10000);
    assert.equal(manager.currentIndex, 0, 'the first song must not be treated as unplayable');
    assert.equal(manager.playbackConfirmed, true);
    await h.advance(50000);
    assert.equal(manager.currentIndex, 1, 'the metadata deadline must advance the queue');
    assert.equal(pushes.length, 2);
    assert.ok(pushes[1].includes('/songs/17/play'));
    await h.advance(10000);
    assert.equal(manager.currentIndex, 1, 'the second song must land through the same blind path');
    assert.equal(manager.playbackConfirmed, true);
    assert.equal(failures, 0);
    assert.equal(manager.unplayableSongs.size, 0);
    assert.deepEqual(tts, []);
    assert.equal(manager.state, 'playing');
    manager.cleanup();
    assert.equal(h.timers.size, 0);
  });
});

test('issue 129: OH2 Music API playback with all-zero status lands and advances twice', async () => {
  await withClock(async h => {
    const blindSongs = songs.map(song => ({ ...song, duration: 60 }));
    const client = new MinaHTTPClient({ user_id: 'test', device_id: 'test', services: {} });
    const service = new MinaService({ getMinaClient: () => client }, {
      getConfig: async () => ({ music_api_model_disabled: [] }),
    });
    service.getDeviceIdentity = async () => ({ hardware: 'OH2' });
    const pushed = [];
    client.doUbusRequest = async (_device, method, _path, message) => {
      if (method === 'player_get_play_status') {
        return { code: 0, data: { info: JSON.stringify({
          status: 0, play_song_detail: { position: 0, duration: 0 },
        }) } };
      }
      if (method === 'player_play_music') {
        pushed.push(JSON.parse(message.music).payload.audio_items[0].stream.url);
      } else if (method === 'player_play_url') {
        pushed.push(message.url);
      }
      return { code: 0, data: { code: 0 } };
    };
    const { manager, tts } = player({
      mode: 'order',
      initialSongs: blindSongs,
      service: {
        playURL: (...args) => service.playURL(...args),
        getPlayState: (...args) => service.getPlayState(...args),
        getPlayerStatus: (...args) => service.getPlayerStatus(...args),
      },
    });
    let failures = 0;
    manager.handleLandingFailure = async () => { failures++; };
    assert.equal(await manager.playCurrent(), true);
    assert.equal(pushed.length, 1);
    await h.advance(10000);
    assert.equal(manager.currentIndex, 0, 'the first Music API track must not be skipped');
    assert.equal(manager.playbackConfirmed, true);
    await h.advance(50000);
    assert.equal(manager.currentIndex, 1);
    assert.equal(pushed.length, 2);
    assert.ok(pushed[1].includes('/songs/17/play'));
    await h.advance(10000);
    assert.equal(manager.currentIndex, 1, 'the second Music API track must land through the blind path');
    assert.equal(manager.playbackConfirmed, true);
    assert.equal(failures, 0);
    assert.equal(manager.unplayableSongs.size, 0);
    assert.deepEqual(tts, []);
    manager.cleanup();
    assert.equal(h.timers.size, 0);
  });
});

test('issue 129: blind idle samples never confirm an external stop until the stream reports progress', async () => {
  await withClock(async h => {
    let state = { status: 0, position: 0, duration: 0, hasPosition: true };
    const { manager } = player({ service: { getPlayState: async () => ({ ...state, sampledAt: Date.now() }) } });
    manager.streamStartedAtMs = Date.now();
    await manager.checkExternalStop();
    await h.advance(20000);
    await manager.checkExternalStop();
    assert.equal(manager.state, 'playing');
    assert.equal(manager.stopPollMisses, 0);
    assert.ok(h.logs.some(line => line.includes('External stop ignored: device reports no usable state')));

    // 本条流重新上报正进度后不再是状态盲区，之后的全零 idle 才按外部停止处理。
    await h.advance(1);
    state = { status: 1, position: 120, duration: 300, hasPosition: true };
    await manager.checkExternalStop();
    assert.equal(manager.streamEvidenceObserved, true);
    assert.equal(manager.streamPositionObserved, true);
    state = { status: 0, position: 0, duration: 0, hasPosition: true };
    await h.advance(20000);
    await manager.checkExternalStop();
    await h.advance(20000);
    await manager.checkExternalStop();
    assert.equal(manager.state, 'stopped');
    manager.cleanup();
  });
});

test('early external stop records an expiring failure, not a permanent blacklist', async () => {
  await withClock(async h => {
    const { manager } = player({
      service: { getPlayState: async () => ({ status: 0, position: 0, duration: 300, hasPosition: true, sampledAt: Date.now() }) },
    });
    manager.streamStartedAtMs = Date.now();
    manager.handleLandingFailure = async () => { };
    await manager.checkExternalStop();
    await h.advance(20000);
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
          manager.advanceToNext = async () => { };
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
    const router = { post: (path, handler) => routes.set(path, handler), get: () => { } };
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

for (const hasPosition of [false, true]) {
  for (const confirmed of [false, true]) {
    test(`mid-song stop never marks a song unplayable (position=${hasPosition}, confirmed=${confirmed})`, async () => {
      await withClock(async h => {
        await h.advance(130000);
        const { manager, pushes, tts } = player({
          service: { getPlayState: async () => ({ status: 0, position: 0, duration: 0, hasPosition, sampledAt: Date.now() }) },
        });
        manager.playStartTimeMs = Date.now() - 130000;
        manager.streamStartedAtMs = Date.now() - 130000;
        // 本条流此前正常上报过进度，当前的全零 idle 才能证明是外部停止（#129）。
        manager.streamEvidenceObserved = true;
        manager.streamPositionObserved = true;
        manager.playbackConfirmed = confirmed;
        await manager.checkExternalStop();
        await h.advance(20000);
        await manager.checkExternalStop();
        assert.equal(manager.state, 'stopped');
        assert.equal(manager.isSongUnplayable(16), false);
        assert.equal(pushes.length, 0);
        assert.equal(tts.length, 0);
        manager.cleanup();
      });
    });
  }
}

test('a mid-song reset after observed progress is an interruption, not a natural ending', async () => {
  await withClock(async h => {
    const { manager, pushes } = player({
      service: { getPlayState: async () => ({ status: 0, position: 0, duration: 300, hasPosition: true, sampledAt: Date.now() }) },
    });
    manager.playStartTimeMs = Date.now() - 130000;
    manager.stopPollMaxPosition = 110;
    await manager.checkExternalStop();
    await h.advance(20000);
    await manager.checkExternalStop();
    assert.equal(manager.state, 'stopped');
    assert.equal(manager.currentIndex, 0);
    assert.equal(pushes.length, 0);
    manager.cleanup();
  });
});

test('an observed reset at the actual tail still advances normally', async () => {
  await withClock(async h => {
    const { manager, pushes, tts } = player({
      service: { getPlayState: async () => ({ status: 0, position: 0, duration: 300, hasPosition: true, sampledAt: Date.now() }) },
    });
    manager.playStartTimeMs = Date.now() - 285000;
    manager.stopPollMaxPosition = 285;
    await manager.checkExternalStop();
    await h.advance(1000);
    await manager.checkExternalStop();
    await flush();
    assert.equal(manager.currentIndex, 1);
    assert.equal(pushes.length, 1);
    assert.equal(manager.isSongUnplayable(16), false);
    assert.equal(tts.length, 0);
    manager.cleanup();
  });
});

test('cached idle samples and failed queries cannot confirm an external stop', async () => {
  await withClock(async h => {
    let state = { status: 0, position: 0, hasPosition: false, duration: 0, sampledAt: Date.now() };
    const { manager } = player({ service: { getPlayState: async () => state } });
    manager.playbackConfirmed = true;
    // 外部停止的测试对象是「曾上报过进度、之后掉回全零」的真实停止，不是 #129 的状态盲区。
    manager.streamEvidenceObserved = true;
    manager.streamPositionObserved = true;
    await manager.checkExternalStop();
    await h.advance(1000);
    await manager.checkExternalStop();
    assert.equal(manager.stopPollMisses, 1);
    state = { ...state, status: -1 };
    await manager.checkExternalStop();
    assert.equal(manager.stopPollMisses, 0);
    state = { ...state, status: 0, sampledAt: Date.now() };
    await manager.checkExternalStop();
    assert.equal(manager.state, 'playing');
    assert.equal(manager.stopPollMisses, 1);
    manager.cleanup();
  });
});

// Use the real shared cache: a three-second timer alone would still reuse five-second samples.
for (const statusPage of [false, true]) {
  test(`hourly three-second cadence obtains fresh shared samples, statusPage=${statusPage}`, async () => {
    await withClock(async h => {
      const hour = new Date(Date.now());
      hour.setMinutes(0, 0, 0);
      hour.setHours(hour.getHours() + 1);
      await h.advance(hour.getTime() - Date.now());
      const client = new MinaHTTPClient({ user_id: 'test', device_id: 'test', services: {} });
      const service = new MinaService({ getMinaClient: () => client }, {});
      const queries = [];
      client.doUbusRequest = async () => {
        queries.push(Date.now() - hour.getTime());
        return { code: 0, data: { info: JSON.stringify({
          status: 1, play_song_detail: { position: 120000 + Date.now() - hour.getTime(), duration: 300000 },
        }) } };
      };
      const { manager, pushes, tts } = player({
        config: { hourly_chime_resume_enabled: true }, service: {
          getPlayState: (...args) => service.getPlayState(...args),
        },
      });
      manager.playbackConfirmed = true;
      manager.playStartTimeMs = Date.now() - 120000;
      manager.resetAutoNextTimer(120, false);
      await flush();
      let polling = statusPage;
      let timer;
      const ui = async () => {
        await service.getPlayerStatus('account', 'speaker');
        if (polling) timer = setTimeout(ui, 1000);
      };
      if (statusPage) void ui();
      await flush();
      await h.advance(9000);
      assert.deepEqual(queries, statusPage ? [0, 3000, 6000, 9000] : [3000, 6000, 9000]);
      assert.equal(manager.isHourlyResumePending(), false);
      assert.equal(pushes.length, 0);
      assert.equal(manager.unplayableSongs.size, 0);
      assert.deepEqual(tts, []);
      polling = false;
      if (timer !== undefined) clearTimeout(timer);
      manager.cleanup();
      assert.equal(h.timers.size, 0);
    });
  });
}

// Exercise the entire hourly detection delay, including real Mina caching and cloud latency.
for (const api of ['music', 'url']) {
  for (const statusPage of [false, true]) {
    for (const speed of [0.5, 1, 2]) {
      test(`issue 481 hourly detection: prompt recovery with ${api}, statusPage=${statusPage}, speed=${speed}`, async t => {
        await withClock(async h => {
          const hour = new Date(Date.now());
          hour.setMinutes(0, 0, 0);
          hour.setHours(hour.getHours() + 1);
          const hourAt = hour.getTime();
          await h.advance(hourAt - Date.now() - 7310);
          const config = { hourly_chime_resume_enabled: true, smart_resume_timeout: 30 };
          const client = new MinaHTTPClient({ user_id: 'test', device_id: 'test', services: {} });
          const service = new MinaService({ getMinaClient: () => client }, {
            getConfig: async () => ({ music_api_model_disabled: api === 'url' ? ['L15A'] : [] }),
          });
          service.getDeviceIdentity = async () => ({ hardware: 'L15A' });
          const pushed = [];
          const queries = [];
          const operations = [];
          let streamAt = Date.now() - 100000;
          let seek = 30;
          let recovered = false;
          const { manager, tts } = player({
            config, mode: 'order', service: {
              playURL: (...args) => service.playURL(...args),
              resumePlay: (...args) => service.resumePlay(...args),
              getPlayState: (...args) => service.getPlayState(...args),
              getPlayerStatus: (...args) => service.getPlayerStatus(...args),
            }
          });
          client.doUbusRequest = async (_device, method, _path, message) => {
            if (method === 'player_get_play_status') {
              queries.push(Date.now());
              const chime = !recovered && Date.now() >= hourAt;
              const speaking = chime && Date.now() < hourAt + 8000;
              const info = chime
                ? { status: speaking ? 1 : 3 }
                : {
                  status: 1, play_song_detail: {
                    position: (Date.now() - streamAt), duration: (300 - seek) / speed * 1000,
                  }
                };
              await new Promise(resolve => setTimeout(resolve, 500));
              return { code: 0, data: { info: JSON.stringify(info) } };
            }
            await new Promise(resolve => setTimeout(resolve, 500));
            if (method === 'player_play_operation') operations.push(message.action);
            if (method === 'player_play_music' || method === 'player_play_url') {
              assert.equal(method, api === 'music' ? 'player_play_music' : 'player_play_url');
              const url = method === 'player_play_music' ? JSON.parse(message.music).payload.audio_items[0].stream.url : message.url;
              pushed.push({ url, at: Date.now() });
              seek = Number(new URL(url).searchParams.get('seek') || 0);
              streamAt = Date.now();
              recovered = true;
            }
            return { code: 0, data: { code: 0 } };
          };
          manager.streamSeekOffsetSec = seek;
          manager.playbackSpeed = speed;
          manager.playStartTimeMs = streamAt - seek / speed * 1000;
          manager.streamStartedAtMs = streamAt;
          manager.playbackConfirmed = true;
          manager.resetAutoNextTimer(manager.getPosition(), false);
          let statusTimer;
          let polling = statusPage;
          const pollStatus = async () => {
            await resolvePlayerStatus({ getOrCreate: async () => manager }, manager.minaService, 'account', 'speaker');
            if (polling) statusTimer = setTimeout(pollStatus, 1000);
          };
          updateDeviceStatusCache('account', 'speaker', { timestamp: 0 });
          if (statusPage) void pollStatus();
          await flush();
          await h.advance(hourAt + 8000 - Date.now() - 1);
          assert.equal(pushed.length, 0, 'do not interrupt the hourly announcement');
          await h.advance(8001);
          assert.equal(pushed.length, 1, 'recover within eight seconds of idle, including shared cache and cloud latency');
          t.diagnostic(`simulated repush ${pushed[0].at - hourAt - 8000}ms after announcement ended`);
          assert.equal(manager.currentIndex, 0);
          assert.ok(pushed[0].url.includes('/songs/16/play'));
          const expectedPosition = 30 + (hourAt - (hourAt - 7310 - 100000)) / 1000 * speed;
          assert.equal(Number(new URL(pushed[0].url).searchParams.get('seek')), Math.floor(expectedPosition));
          assert.ok(!operations.includes('play'), 'missing media should be repushed without a bare resume');
          assert.equal(queries.filter(at => at >= hourAt && at <= pushed[0].at).length <= 9, true);
          assert.ok(manager.checkTimer !== null);
          // Complete two natural transitions after recovery; no skipped song, failure marker, or TTS.
          for (let index = 0; index < 2; index++) {
            const endAt = streamAt + (300 - seek) / speed * 1000;
            await h.advance(endAt - Date.now() - 1);
            assert.equal(manager.currentIndex, index);
            await h.advance(5001);
            assert.equal(manager.currentIndex, index + 1);
            assert.equal(pushed.length, index + 2);
            assert.ok(pushed[index + 1].url.includes(`/songs/${songs[index + 1].id}/play`));
          }
          assert.equal(manager.unplayableSongs.size, 0);
          assert.deepEqual(tts, []);
          polling = false;
          if (statusTimer !== undefined) clearTimeout(statusTimer);
          manager.cleanup();
          assert.equal(h.timers.size, 0);
        });
      });
    }
  }
}

for (const scenario of ['playing', 'misreported idle with progress', 'long announcement', 'cloud failure', 'cached idle']) {
  test(`issue 481 hourly detection: no false repush during ${scenario}`, async () => {
    await withClock(async h => {
      const hour = new Date(Date.now());
      hour.setMinutes(0, 0, 0);
      hour.setHours(hour.getHours() + 1);
      await h.advance(hour.getTime() - Date.now());
      const queries = [];
      const config = { hourly_chime_resume_enabled: true };
      const { manager, pushes, tts } = player({
        config, service: {
          getPlayState: async (_account, _device, options) => {
            queries.push({ at: Date.now(), verify: options?.verify });
            const moving = scenario === 'playing' || scenario === 'misreported idle with progress';
            return {
              status: scenario === 'cloud failure' ? -1 : moving ? scenario === 'playing' ? 1 : 2 : scenario === 'long announcement' ? 1 : 3,
              position: moving ? 120 + (Date.now() - hour.getTime()) / 1000 : 0,
              duration: moving ? 300 : 0, hasPosition: moving,
              sampledAt: scenario === 'cached idle' ? hour.getTime() : Date.now(),
            };
          },
        }
      });
      manager.playbackConfirmed = true;
      manager.playStartTimeMs = Date.now() - 120000;
      manager.resetAutoNextTimer(120, false);
      await flush();
      await h.advance(100000);
      assert.equal(pushes.length, 0);
      assert.equal(manager.currentIndex, 0);
      assert.equal(manager.unplayableSongs.size, 0);
      assert.deepEqual(tts, []);
      if (scenario === 'misreported idle with progress') assert.equal(manager.isHourlyResumePending(), false);
      if (scenario === 'cloud failure') assert.equal(queries.filter(q => q.verify).length, 0, 'failures must never bypass Mina backoff');
      if (scenario === 'cached idle') assert.ok(queries.filter(q => q.verify).length <= 1, 'one stale confirmation cannot start a repeated fast-query loop');
      manager.cleanup();
      assert.equal(h.timers.size, 0);
    });
  });
}

test('issue 481 hourly detection: real Mina backoff survives a failed fast confirmation', async () => {
  await withClock(async h => {
    const hour = new Date(Date.now());
    hour.setMinutes(0, 0, 0);
    hour.setHours(hour.getHours() + 1);
    await h.advance(hour.getTime() - Date.now());
    const client = new MinaHTTPClient({ user_id: 'test', device_id: 'test', services: {} });
    const service = new MinaService({ getMinaClient: () => client }, {});
    const queries = [];
    client.doUbusRequest = async () => {
      queries.push(Date.now());
      return queries.length === 1 ? { code: 0, data: { info: JSON.stringify({ status: 3 }) } } : null;
    };
    const { manager, pushes } = player({
      config: { hourly_chime_resume_enabled: true }, service: {
        getPlayState: (...args) => service.getPlayState(...args),
      }
    });
    manager.playbackConfirmed = true;
    manager.playStartTimeMs = Date.now() - 120000;
    manager.resetAutoNextTimer(120, false);
    await flush();
    await h.advance(80000);
    assert.equal(queries.length, 4);
    assert.deepEqual(queries.map(at => at - hour.getTime()), [3000, 4000, 10000, 70000]);
    assert.equal(manager.isHourlyResumePending(), false);
    assert.equal(pushes.length, 0);
    manager.cleanup();
    assert.equal(h.timers.size, 0);
  });
});

for (const [enabled, second] of [[false, 0], [true, 100]]) {
  test(`issue 481 hourly detection: ordinary stop cadence with enabled=${enabled}, second=${second}`, async () => {
    await withClock(async h => {
      const hour = new Date(Date.now());
      hour.setMinutes(0, 0, 0);
      hour.setHours(hour.getHours() + 1);
      await h.advance(hour.getTime() + second * 1000 - Date.now());
      const queries = [];
      const { manager, pushes } = player({
        config: { hourly_chime_resume_enabled: enabled }, service: {
          getPlayState: async (_account, _device, options) => {
            queries.push({ at: Date.now(), verify: options?.verify });
            return { status: 3, hasPosition: false, position: 0, duration: 0, sampledAt: Date.now() };
          },
        }
      });
      manager.playbackConfirmed = true;
      manager.playStartTimeMs = Date.now() - 120000;
      manager.resetAutoNextTimer(120, false);
      await flush();
      await h.advance(19999);
      assert.equal(queries.length, 0);
      await h.advance(1);
      assert.equal(queries.length, 1);
      assert.equal(manager.state, 'playing');
      await h.advance(20000);
      assert.equal(queries.length, 2);
      assert.equal(queries.some(q => q.verify), false);
      assert.equal(manager.state, 'stopped');
      assert.equal(pushes.length, 0);
      manager.cleanup();
      assert.equal(h.timers.size, 0);
    });
  });
}

for (const action of ['pause', 'stop', 'new song', 'cleanup']) {
  test(`issue 481 hourly detection: delayed config cannot schedule an old probe after ${action}`, async () => {
    await withClock(async h => {
      const pending = deferred();
      const { manager } = player();
      manager.playbackConfirmed = true;
      manager.playStartTimeMs = Date.now() - 120000;
      manager.configManager.getConfig = () => pending.promise;
      manager.resetAutoNextTimer(120, false);
      if (action === 'pause') await manager.pause();
      else if (action === 'stop') await manager.stop();
      else if (action === 'new song') manager.initWithSongs(songs, 1, 'order', 2);
      else manager.cleanup();
      const count = h.timers.size;
      pending.resolve({ hourly_chime_resume_enabled: true });
      await flush();
      assert.equal(h.timers.size, count);
      assert.equal(manager.stopPollTimer, null);
      manager.cleanup();
      assert.equal(h.timers.size, 0);
    });
  });
}

async function hourlySession(h, { enabled = true, readState, readConfig, resumeResult = true, duration = 300, second = 10, seek = 0, speed = 1 } = {}) {
  const hour = new Date(Date.now());
  hour.setMinutes(0, 0, 0);
  hour.setHours(hour.getHours() + 1);
  await h.advance(hour.getTime() + second * 1000 - Date.now());
  const config = { hourly_chime_resume_enabled: enabled, smart_resume_timeout: 30 };
  const resumes = [];
  const s = player({
    config, initialSongs: songs.map(song => ({ ...song, duration })),
    service: {
      resumePlay: async () => { resumes.push(Date.now()); return resumeResult; },
      pausePlayVerified: async () => 'paused',
      getPlayState: async (_account, _device, options) => readState
        ? readState({ resumes, options })
        : {
          status: resumes.length ? 1 : 2, position: resumes.length ? 120 + (Date.now() - resumes[0]) / 1000 : 120,
          duration, hasPosition: true, sampledAt: Date.now()
        },
    },
  });
  if (readConfig) s.manager.configManager.getConfig = () => readConfig(config);
  s.manager.streamSeekOffsetSec = seek;
  s.manager.playbackSpeed = speed;
  s.manager.playStartTimeMs = Date.now() - (seek / speed + 120 + second) * 1000;
  s.manager.streamStartedAtMs = Date.now() - (120 + second) * 1000;
  s.manager.playbackConfirmed = true;
  s.manager.stopPollDeadlineMs = Date.now() + 120000;
  await s.manager.checkExternalStop();
  await flush();
  // These tests isolate recovery after detection; full poll timing is tested above.
  clearTimeout(s.manager.stopPollTimer);
  s.manager.stopPollTimer = null;
  await h.advance(20000);
  void s.manager.checkExternalStop();
  await flush();
  return { ...s, config, resumes };
}

test('hourly recovery is opt-in and does not mark the interrupted song', async () => {
  await withClock(async h => {
    const s = await hourlySession(h, { enabled: false });
    assert.equal(s.manager.state, 'stopped');
    assert.equal(s.manager.currentIndex, 0);
    assert.equal(s.manager.isSongUnplayable(16), false);
    assert.equal(s.resumes.length, 0);
    assert.equal(s.pushes.length, 0);
    s.manager.cleanup();
  });
});

test('idle after a chime resumes the current song and excludes detection/wait time', async () => {
  await withClock(async h => {
    const s = await hourlySession(h);
    assert.equal(s.manager.isHourlyResumePending(), true);
    assert.equal(s.manager.getPosition(), 120);
    await h.advance(999);
    assert.equal(s.manager.getPosition(), 120);
    assert.equal(s.resumes.length, 0);
    await h.advance(1);
    assert.equal(s.resumes.length, 1);
    await h.advance(3000);
    assert.equal(s.pushes.length, 0);
    assert.equal(s.manager.currentIndex, 0);
    assert.equal(s.manager.isSongUnplayable(16), false);
    assert.ok(Math.abs(s.manager.getPosition() - 123) < 0.01);
    assert.ok(s.manager.checkTimer !== null);
    s.manager.cleanup();
  });
});

for (const [seek, speed] of [[0, 1], [60, 0.5], [40, 2]]) {
  test(`issue 481: status 3 after an hourly chime restores seek=${seek} speed=${speed} and the next transition`, async () => {
    await withClock(async h => {
      let landedAt = 0;
      const s = await hourlySession(h, { seek, speed, readState: () => landedAt ? {
        status: 1, position: (Date.now() - landedAt) / 1000,
        duration: (300 - s.manager.getStreamSeekOffsetSec()) / speed, hasPosition: true, sampledAt: Date.now(),
      } : { status: 3, position: 0, duration: 0, hasPosition: false, sampledAt: Date.now() } });
      assert.equal(s.manager.isHourlyResumePending(), true);
      const position = seek + 120 * speed;
      assert.equal(s.manager.getPosition(), position);
      const push = s.manager.minaService.playURL;
      s.manager.minaService.playURL = async (...args) => { landedAt = Date.now(); return push(...args); };
      await h.advance(8000);
      assert.equal(s.pushes.length, 1);
      assert.ok(s.pushes[0].includes(`seek=${position}`));
      if (speed !== 1) assert.ok(s.pushes[0].includes(`speed=${speed}`));
      const endAt = landedAt + (300 - position) / speed * 1000;
      await h.advance(endAt - Date.now() - 1);
      assert.equal(s.pushes.length, 1);
      assert.equal(s.manager.currentIndex, 0);
      await h.advance(1);
      assert.equal(s.pushes.length, 2);
      assert.ok(s.pushes[1].includes('/songs/17/play'));
      assert.equal(s.manager.state, 'playing');
      assert.equal(s.manager.unplayableSongs.size, 0);
      await h.advance(300000 / speed - 1);
      assert.equal(s.pushes.length, 2);
      await h.advance(1);
      assert.equal(s.pushes.length, 3);
      assert.ok(s.pushes[2].includes('/songs/18/play'));
      s.manager.cleanup();
      assert.equal(h.timers.size, 0);
    });
  });
}

test('a successful resume response without progress falls back to seek on the same song', async () => {
  await withClock(async h => {
    const s = await hourlySession(h, { readState: () => ({ status: 2, position: 0, duration: 0, hasPosition: false, sampledAt: Date.now() }) });
    await h.advance(8000);
    assert.equal(s.resumes.length, 1);
    assert.equal(s.pushes.length, 1);
    assert.match(s.pushes[0], /seek=120/);
    assert.equal(s.manager.currentIndex, 0);
    assert.equal(s.manager.isSongUnplayable(16), false);
    s.manager.cleanup();
  });
});

test('a rejected resume falls back immediately to the saved position', async () => {
  await withClock(async h => {
    const s = await hourlySession(h, { resumeResult: false });
    await h.advance(5000);
    assert.equal(s.resumes.length, 1);
    assert.equal(s.pushes.length, 1);
    assert.match(s.pushes[0], /seek=120/);
    s.manager.cleanup();
  });
});

for (const status of [-1, 1]) {
  test(`hourly recovery never pushes while device is ${status === -1 ? 'unavailable' : 'broadcasting'}`, async () => {
    await withClock(async h => {
      let reading = 0;
      const s = await hourlySession(h, {
        readState: () => {
          reading++;
          return {
            status: reading <= 2 ? 0 : status, position: 0, duration: status === 1 ? 8 : 0,
            hasPosition: false, sampledAt: Date.now()
          };
        }
      });
      await h.advance(30000);
      assert.equal(s.resumes.length, 0);
      assert.equal(s.pushes.length, 0);
      assert.equal(s.manager.state, 'stopped');
      assert.equal(s.manager.currentIndex, 0);
      assert.equal(s.manager.isSongUnplayable(16), false);
      s.manager.cleanup();
    });
  });
}

test('cached idle cannot trigger hourly resume', async () => {
  await withClock(async h => {
    let reading = 0;
    let frozenAt;
    const s = await hourlySession(h, {
      readState: () => {
        reading++;
        if (reading === 3) frozenAt = Date.now();
        return { status: 0, position: 0, duration: 0, hasPosition: false, sampledAt: frozenAt ?? Date.now() };
      }
    });
    await h.advance(30000);
    assert.equal(s.resumes.length, 0);
    assert.equal(s.pushes.length, 0);
    s.manager.cleanup();
  });
});

test('device progress after a chime only rebuilds the timer without sending play', async () => {
  await withClock(async h => {
    let reading = 0;
    const s = await hourlySession(h, {
      readState: () => {
        reading++;
        return {
          status: reading <= 2 ? 0 : 1, position: reading <= 2 ? 0 : 120 + reading,
          duration: 300, hasPosition: reading > 2, sampledAt: Date.now()
        };
      }
    });
    await h.advance(1000);
    assert.equal(s.manager.isHourlyResumePending(), false);
    assert.equal(s.resumes.length, 0);
    assert.equal(s.pushes.length, 0);
    assert.equal(s.manager.getPosition(), 124);
    assert.ok(s.manager.checkTimer !== null);
    s.manager.cleanup();
  });
});

for (const action of ['pause', 'stop', 'next', 'same-song restart', 'new dialogue', 'disable', 'cleanup']) {
  test(`an hourly status query cannot restore playback after ${action}`, async () => {
    await withClock(async h => {
      const pending = deferred();
      let reading = 0;
      const s = await hourlySession(h, {
        readState: () => ++reading <= 2
          ? { status: 0, position: 0, duration: 0, hasPosition: false, sampledAt: Date.now() }
          : pending.promise
      });
      assert.equal(s.manager.isHourlyResumePending(), true);
      if (action === 'pause') await s.manager.pause();
      else if (action === 'stop') await s.manager.stop();
      else if (action === 'next') await s.manager.next();
      else if (action === 'same-song restart') await s.manager.playAtIndex(0);
      else if (action === 'disable') { s.config.hourly_chime_resume_enabled = false; s.manager.cancelHourlyResume(); }
      else if (action === 'new dialogue') s.manager.cancelHourlyResume('speaker');
      else s.manager.cleanup();
      const state = s.manager.state;
      const pushes = s.pushes.length;
      pending.resolve({ status: 0, position: 0, duration: 0, hasPosition: false, sampledAt: Date.now() });
      await flush();
      await h.advance(10000);
      assert.equal(s.resumes.length, 0);
      assert.equal(s.pushes.length, pushes);
      assert.equal(s.manager.state, state);
      if (action === 'pause') assert.equal(s.manager.pausedPositionSec, 120);
      s.manager.cleanup();
    });
  });
}

for (const action of ['stop', 'disable']) {
  test(`cancel during an in-flight hourly resume prevents verification and repush (${action})`, async () => {
    await withClock(async h => {
      const s = await hourlySession(h);
      const pending = deferred();
      s.manager.minaService.resumePlay = async () => { s.resumes.push(Date.now()); return pending.promise; };
      await h.advance(5000);
      assert.equal(s.resumes.length, 1);
      if (action === 'stop') await s.manager.stop();
      else { s.config.hourly_chime_resume_enabled = false; s.manager.cancelHourlyResume(); }
      pending.resolve(true);
      await flush();
      await h.advance(5000);
      assert.equal(s.pushes.length, 0);
      assert.equal(s.resumes.length, 1);
      assert.equal(s.manager.state, action === 'stop' ? 'stopped' : 'playing');
      if (action === 'disable') assert.ok(s.manager.checkTimer !== null);
      s.manager.cleanup();
    });
  });
}

test('outside the 90-second window and at the song tail there is no hourly recovery', async () => {
  for (const options of [{ second: 100 }, { second: -10 }, { duration: 130 }]) {
    await withClock(async h => {
      const s = await hourlySession(h, options);
      await h.advance(10000);
      assert.equal(s.resumes.length, 0);
      assert.equal(s.pushes.length, 0);
      s.manager.cleanup();
    });
  }
});

for (const enabled of [true, false]) {
  test(`new dialogue cancels hourly recovery before account lookup (voice enabled=${enabled})`, async () => {
    await withClock(async h => {
      const pending = deferred();
      const lookup = deferred();
      let reads = 0;
      const s = await hourlySession(h, {
        readState: () => ++reads <= 2
          ? { status: 0, position: 0, duration: 0, hasPosition: false, sampledAt: Date.now() } : pending.promise
      });
      const engine = resumeEngine(s.manager);
      engine.enabled = enabled;
      engine.sleepTimers = new Map();
      engine.playlistManagerMap.getOrCreate = async () => s.manager;
      engine.accountManager.getAccounts = () => lookup.promise;
      const message = engine.handleMessage({ device_id: 'speaker', message: { response: { answer: [{ question: '停止播放' }] } } });
      await flush();
      assert.equal(s.manager.isHourlyResumePending(), false);
      pending.resolve({ status: 0, position: 0, duration: 0, hasPosition: false, sampledAt: Date.now() });
      await flush();
      await h.advance(5000);
      assert.equal(s.resumes.length, 0);
      assert.equal(s.pushes.length, 0);
      lookup.resolve([{ id: 'account' }]);
      await message;
      assert.equal(s.manager.state, enabled ? 'stopped' : 'playing');
      engine.setEnabled(false);
      s.manager.cleanup();
    });
  });
}

test('another device cannot cancel a shared group recovery, but any group member can', async () => {
  await withClock(async h => {
    const s = await hourlySession(h);
    s.manager.setTargets([{ account_id: 'account', device_id: 'speaker' }, { account_id: 'account', device_id: 'secondary' }]);
    const map = new PlaylistManagerMap({}, {});
    map.managers.set('grp:living', s.manager);
    map.cancelHourlyResumes('elsewhere');
    assert.equal(s.manager.isHourlyResumePending(), true);
    map.cancelHourlyResumes('secondary');
    assert.equal(s.manager.isHourlyResumePending(), false);
    await h.advance(5000);
    assert.equal(s.resumes.length, 0);
    map.cleanup();
  });
});

test('only one recovery is attempted per manager in the same hourly window', async () => {
  await withClock(async h => {
    const s = await hourlySession(h);
    await h.advance(8000);
    assert.equal(s.resumes.length, 1);
    s.manager.minaService.getPlayState = async () => ({ status: 0, position: 0, duration: 0, hasPosition: false, sampledAt: Date.now() });
    await s.manager.checkExternalStop();
    await h.advance(20000);
    assert.equal(s.resumes.length, 1);
    assert.equal(s.pushes.length, 0);
    assert.equal(s.manager.state, 'stopped');
    s.manager.cleanup();
  });
});

const { registerConfigHandlers } = loadSource('../src/handlers/config.ts', {
  '@songloft/plugin-sdk': { jsonResponse: (value, status = 200) => ({ ...value, status }) },
  '../config/manager': {}, '../conversation/monitor': {}, '../schedule/scheduler': {},
  '../voicecmd/engine': {}, '../memory': { normalizeMemoryMaxRecords: Number },
  '../utils/http': {}, '../utils/debug': {}, '../mina/constants': { DEFAULT_MUSIC_API_MODELS: [] },
});

function hourlyConfig() {
  const routes = new Map();
  let config = {};
  let cancellations = 0;
  const manager = { getConfig: async () => ({ ...config }), getAIConfig: async () => ({}), saveConfig: async value => { config = value; } };
  registerConfigHandlers({ get: (path, fn) => routes.set('GET ' + path, fn), post: (path, fn) => routes.set('POST ' + path, fn) },
    manager, {}, {}, { cancelHourlyResumes: () => cancellations++ }, {});
  return {
    get: () => routes.get('GET /config')({}), set: value => routes.get('POST /config')({ body: JSON.stringify(value) }),
    cancellations: () => cancellations
  };
}

test('the hourly config endpoint defaults to false, persists opt-in, and cancels immediately on disable', async () => {
  await withClock(async () => {
    const config = hourlyConfig();
    assert.equal((await config.get()).data.hourly_chime_resume_enabled, false);
    assert.equal((await config.set({ hourly_chime_resume_enabled: true })).status, 200);
    assert.equal((await config.get()).data.hourly_chime_resume_enabled, true);
    assert.equal(config.cancellations(), 0);
    assert.equal((await config.set({ hourly_chime_resume_enabled: false })).status, 200);
    assert.equal(config.cancellations(), 1);
    assert.equal((await config.get()).data.hourly_chime_resume_enabled, false);
  });
});

for (const value of ['false', 1, null]) {
  test(`invalid hourly config ${JSON.stringify(value)} cannot silently alter playback`, async () => {
    await withClock(async () => {
      const config = hourlyConfig();
      await config.set({ hourly_chime_resume_enabled: true });
      assert.equal((await config.set({ hourly_chime_resume_enabled: value })).status, 400);
      assert.equal((await config.get()).data.hourly_chime_resume_enabled, true);
      assert.equal(config.cancellations(), 0);
    });
  });
}

test('hourly repush preserves the song position after seek and speed conversion', async () => {
  await withClock(async h => {
    const s = await hourlySession(h, {
      seek: 30, speed: 1.5,
      readState: () => ({ status: 0, position: 0, duration: 0, hasPosition: false, sampledAt: Date.now() })
    });
    assert.equal(s.manager.getPosition(), 210);
    await h.advance(8000);
    assert.equal(s.pushes.length, 1);
    assert.match(s.pushes[0], /seek=210/);
    assert.match(s.pushes[0], /speed=1\.5/);
    s.manager.cleanup();
  });
});

test('unknown-length broadcast progress near zero cannot masquerade as the saved song', async () => {
  await withClock(async h => {
    let reading = 0;
    const s = await hourlySession(h, {
      readState: () => {
        reading++;
        return {
          status: reading <= 2 ? 0 : 1, position: reading <= 2 ? 0 : reading,
          duration: 0, hasPosition: reading > 2, sampledAt: Date.now()
        };
      }
    });
    await h.advance(30000);
    assert.equal(s.resumes.length, 0);
    assert.equal(s.pushes.length, 0);
    assert.equal(s.manager.state, 'stopped');
    s.manager.cleanup();
  });
});

for (const phase of ['config lookup', 'status lookup']) {
  test(`new dialogue invalidates an hourly recovery before task creation (${phase})`, async () => {
    await withClock(async h => {
      const pending = deferred();
      let reading = 0;
      const s = await hourlySession(h, phase === 'config lookup'
        ? { readConfig: () => pending.promise }
        : {
          readState: () => ++reading === 1
            ? { status: 0, position: 0, duration: 0, hasPosition: false, sampledAt: Date.now() } : pending.promise
        });
      assert.equal(s.manager.isHourlyResumePending(), false);
      s.manager.cancelHourlyResume('speaker');
      pending.resolve(phase === 'config lookup' ? s.config
        : { status: 0, position: 0, duration: 0, hasPosition: false, sampledAt: Date.now() });
      await flush();
      await h.advance(10000);
      assert.equal(s.manager.isHourlyResumePending(), false);
      assert.equal(s.resumes.length, 0);
      assert.equal(s.pushes.length, 0);
      s.manager.cleanup();
    });
  });
}

for (const reloadStatus of [-1, 1]) {
  test(`a reloaded mid-song stream is not an unconfirmed new start (status=${reloadStatus})`, async () => {
    await withClock(async h => {
      const s = await hourlySession(h);
      s.manager.cleanup();
      let reading = 0;
      const { manager, pushes, tts } = player({
        config: s.config,
        service: {
          getPlayState: async () => ({
            status: ++reading === 1 ? reloadStatus : 0, position: 0, duration: 0,
            hasPosition: reading > 1, sampledAt: Date.now()
          }),
        },
      });
      await manager.resumeAfterReload({
        state: 'playing', positionSec: 150, atMs: Date.now(), songId: 16, seekOffsetSec: 0,
      });
      // Inspect the detection stage before recovery is sent (the enabled window now polls sooner).
      await h.advance(reloadStatus === 1 ? 4000 : 40000);
      assert.equal(manager.isSongUnplayable(16), false);
      assert.equal(pushes.length, 0);
      assert.equal(tts.length, 0);
      assert.equal(manager.currentIndex, 0);
      if (reloadStatus === 1) assert.equal(manager.isHourlyResumePending(), true);
      else assert.equal(manager.state, 'stopped');
      manager.cleanup();
    });
  });
}

test('guarded resume reaches the service without invalidating its own voice task', async () => {
  await withClock(async () => {
    let valid = true;
    const { manager } = player({ service: { resumePlay: async (_a, _d, current) => { if (!current) valid = false; return current?.() ?? true; } } });
    manager.state = 'paused';
    assert.equal(await manager.resumePlayback({ isCurrent: () => valid }), true);
    assert.equal(valid, true); manager.cleanup();
  });
});

test('suspending chat prevents an unguarded in-flight URL build from pushing music', async () => {
  await withClock(async () => {
    const wait = deferred(), original = urls.URLBuilder.buildSongURL;
    urls.URLBuilder.buildSongURL = () => wait.promise;
    const { manager, pushes } = player();
    try {
      const pending = manager.replayCurrent(20); await flush();
      manager.suspendForVoiceInteraction(); wait.resolve('http://speaker.test/old-song');
      assert.equal(await pending, false); assert.equal(pushes.length, 0);
    } finally { urls.URLBuilder.buildSongURL = original; manager.cleanup(); }
  });
});

test('holding after TTS replays the original URL on manual resume', async () => {
  await withClock(async () => {
    let resumes = 0;
    const { manager, pushes } = player({ service: { resumePlay: async () => { resumes++; return true; } } });
    await manager.holdAfterInteraction(37);
    assert.equal(await manager.resumePlayback(), true);
    assert.equal(resumes, 0); assert.equal(pushes.length, 1);
    assert.ok(pushes[0].includes('seek=37')); manager.cleanup();
  });
});

test('chat reservation cancels a delayed playlist load even before music has started', async () => {
  await withClock(async () => {
    const wait = deferred();
    songloft.playlists = { getById: async () => ({}), getSongs: () => wait.promise };
    const { manager, pushes } = player();
    const pending = manager.play(99); await flush();
    manager.reserveForVoiceInteraction(); wait.resolve([{ ...songs[0], id: 999 }]);
    assert.equal(await pending, false); assert.equal(pushes.length, 0);
    assert.equal(manager.getCurrentSong().id, songs[0].id); manager.cleanup();
  });
});

test('chat holds an originally paused song at its saved position', async () => {
  await withClock(async () => {
    const { manager } = player(); manager.state = 'paused'; manager.pausedPositionSec = 67;
    assert.equal(manager.getInteractionPosition(), 67);
    await manager.holdAfterInteraction(manager.getInteractionPosition());
    assert.equal(manager.pausedPositionSec, 67); manager.cleanup();
  });
});

test('dispatcher-style guarded music resume preserves both playback timer and task identity', async () => {
  await withClock(async h => {
    let current = true;
    const { manager } = player({ service: { resumePlay: async (_a, _d, guard) => { if (!guard) current = false; return guard?.() ?? true; } } });
    manager.state = 'paused'; manager.pausedPositionSec = 43;
    const engine = resumeEngine(manager);
    const handled = await engine.handleMessage({ account_id: 'account', device_id: 'speaker', message: { response: { answer: [{ question: '继续播放' }] } } }, { current: () => current, deferResume: true });
    assert.equal(handled, true); assert.equal(current, true); assert.equal(manager.isPlaying(), true); assert.ok(h.timers.size > 0); manager.cleanup();
  });
});

test('active chat detects volume controls without enabling the music engine', async () => {
  await withClock(async () => {
    const { manager } = player(), engine = resumeEngine(manager); engine.enabled = false;
    assert.equal(await engine.fixedControlType('大声一点'), undefined);
    assert.equal(await engine.fixedControlType('大声一点', true), 'set_volume');
    assert.equal(engine.isEnabled(), false); manager.cleanup();
  });
});

test('DLNA takeover invalidates pending voice analysis before it can replace the cast', async () => {
  await withClock(async () => {
    const chatTypes = loadSource('../src/chat/types.ts', {});
    const { VoiceDispatcher } = loadSource('../src/voicecmd/dispatcher.ts', { '../chat/types': chatTypes, '../conversation/query': conversation });
    const { PlaybackCoordinator } = loadSource('../src/playback/coordinator.ts', { '../chat/types': chatTypes });
    const { manager } = player(), wait = deferred(), calls = [];
    manager.minaService.setOnControl = callback => { manager.minaService.notifyControl = callback; };
    const config = { getChatConfig: async () => chatTypes.DEFAULT_CHAT_CONFIG, findDeviceGroup: async () => null };
    const playback = new PlaybackCoordinator({ get: () => manager }, manager.minaService, config);
    const music = { cancelPendingResume() { }, hasFixedControl: async () => false, handleMessage: async (_message, options) => { await wait.promise; if (options.current()) calls.push('stale music'); return true; } };
    const chat = { status: () => ({ phase: 'completed', followup_until: 0 }), interruptForRouting: async () => undefined };
    const dispatcher = new VoiceDispatcher(config, music, chat, playback);
    dispatcher.submit({ account_id: 'account', device_id: 'speaker', message: { request_id: 'old', response: { answer: [{ question: '播放歌曲' }] } } });
    await flush(); await manager.beginExternalPlayback(() => { }); wait.resolve(); await flush();
    assert.deepEqual(calls, []); assert.equal(manager.isExternalPlayback(), true); dispatcher.close(); manager.cleanup();
  });
});

// Reproduce the released host's pre-32ff4ca timer pool, including stale cancellation.
test('issue 481: cancelling a completed voice task cannot erase the next songs on a recycling host', async () => {
  await withClock(async h => {
    let startedAt;
    const s = voiceSession({
      position: 98, readState: () => ({
        status: 1, position: 98 + (Date.now() - startedAt) / 1000,
        duration: 300, hasPosition: true, sampledAt: Date.now(),
      })
    });
    startedAt = Date.now();
    await h.advance(2000);
    assert.equal(s.manager.isVoiceSuspended(), false);
    s.engine.cancelPendingResume('account', 'speaker');
    await h.advance(199999);
    assert.equal(s.manager.currentIndex, 0);
    await h.advance(1);
    assert.equal(s.manager.currentIndex, 1);
    assert.match(s.pushes[0], /songs\/17\/play/);
    // The new stream does not report position, like the L15A in the report.
    s.manager.minaService.getPlayState = async () => ({ status: 1, position: 0, duration: 0, hasPosition: false, sampledAt: Date.now() });
    await h.advance(299999);
    assert.equal(s.manager.currentIndex, 1);
    await h.advance(1);
    assert.equal(s.manager.currentIndex, 2);
    assert.match(s.pushes[1], /songs\/18\/play/);
    assert.equal(s.manager.unplayableSongs.size, 0);
    assert.equal(s.manager.state, 'playing');
    s.manager.cleanup();
    assert.equal(h.timers.size, 0);
  }, { recycleTimerIds: true });
});

for (const status of [0, 3]) {
  test(`issue 481: voice recovery repushes missing media promptly after fresh idle ${status}`, async () => {
    await withClock(async h => {
      const s = voiceSession({ position: 98.5, readState: () => ({ status, position: 0, duration: 0, hasPosition: false, sampledAt: Date.now() }) });
      await h.advance(1999);
      assert.equal(s.pushes.length, 0);
      await h.advance(1);
      assert.equal(s.pushes.length, 1);
      assert.match(s.pushes[0], /seek=98/);
      assert.equal(s.resumes.length, 0, 'an empty stopped media context needs a seek URL');
      assert.equal(s.manager.devicePositionObserved, false);
      s.engine.setEnabled(false);
      s.manager.cleanup();
      assert.equal(h.timers.size, 0);
    });
  });
  test(`issue 481: hourly recovery promptly repushes missing media after fresh idle ${status}`, async () => {
    await withClock(async h => {
      const s = await hourlySession(h, { readState: () => ({ status, position: 0, duration: 0, hasPosition: false, sampledAt: Date.now() }) });
      await h.advance(999);
      assert.equal(s.pushes.length, 0);
      await h.advance(1);
      assert.equal(s.pushes.length, 1);
      assert.match(s.pushes[0], /seek=120/);
      assert.equal(s.resumes.length, 0);
      assert.equal(s.manager.devicePositionObserved, false);
      s.manager.cleanup();
      assert.equal(h.timers.size, 0);
    });
  });
}

// Model Mina's shared five-second cache and cloud latency rather than always returning a fresh stub.
test('issue 481: hourly idle verification bypasses the shared cache in a bounded fast window', async () => {
  await withClock(async h => {
    const queries = [];
    let cachedAt;
    const s = await hourlySession(h, {
      readState: ({ options }) => {
        queries.push({ at: Date.now(), verify: options?.verify });
        if (cachedAt === undefined || Date.now() - cachedAt >= 5000) cachedAt = Date.now();
        return {
          status: 0, position: 0, duration: 0, hasPosition: false,
          sampledAt: options?.verify ? Date.now() : cachedAt
        };
      }
    });
    const detectedAt = Date.now();
    await h.advance(1000);
    assert.equal(s.pushes.length, 1, 'two fresh idle responses should not wait for a five-second cache rollover');
    assert.match(s.pushes[0], /seek=120/);
    assert.equal(s.resumes.length, 0);
    assert.equal(queries.filter(q => q.at >= detectedAt && q.verify).length, 2);
    s.manager.cleanup();
    assert.equal(h.timers.size, 0);
  });
});

test('issue 481: hourly cloud failure ends fast verification and preserves retry backoff', async () => {
  await withClock(async h => {
    const queries = [];
    const s = await hourlySession(h);
    s.manager.minaService.getPlayState = async (_account, _device, options) => {
      queries.push({ at: Date.now(), verify: options?.verify });
      return { status: -1, position: 0, duration: 0, hasPosition: false, sampledAt: Date.now() };
    };
    await h.advance(1000);
    assert.equal(queries.length, 1);
    assert.equal(queries[0].verify, true);
    await h.advance(2999);
    assert.equal(queries.length, 1);
    await h.advance(1);
    assert.equal(queries.length, 2);
    assert.equal(queries[1].verify, false);
    assert.equal(s.pushes.length, 0);
    assert.equal(s.resumes.length, 0);
    s.manager.cleanup();
    assert.equal(h.timers.size, 0);
  });
});

test('issue 481: hourly speech is not interrupted when the fast verification budget runs out', async () => {
  await withClock(async h => {
    let speaking = true;
    const queries = [];
    const s = await hourlySession(h, {
      readState: ({ options }) => {
        queries.push({ at: Date.now(), verify: options?.verify });
        return { status: queries.length <= 2 ? 0 : speaking ? 1 : 3, position: 0, duration: 0, hasPosition: false, sampledAt: Date.now() };
      }
    });
    await h.advance(5999);
    assert.equal(s.pushes.length, 0);
    assert.equal(s.resumes.length, 0);
    assert.equal(queries.filter(q => q.verify).length, 4);
    speaking = false;
    await h.advance(1000);
    assert.equal(s.pushes.length, 0, 'one idle sample cannot interrupt a delayed reply');
    await h.advance(1);
    assert.equal(s.pushes.length, 1);
    assert.equal(queries.filter(q => q.verify).length, 5, 'only one extra prompt idle confirmation is allowed');
    assert.equal(s.resumes.length, 0);
    s.manager.cleanup();
    assert.equal(h.timers.size, 0);
  });
});

for (const kind of ['voice', 'hourly']) {
  test(`issue 481: ${kind} recovery avoids a second verification round with half-second cloud responses`, async () => {
    await withClock(async h => {
      let reads = 0;
      const readState = () => {
        if (kind === 'hourly' && ++reads <= 2)
          return { status: 3, position: 0, duration: 0, hasPosition: false, sampledAt: Date.now() };
        return new Promise(resolve => setTimeout(() => resolve({
          status: 3, position: 0, duration: 0, hasPosition: false, sampledAt: Date.now(),
        }), 500));
      };
      const s = kind === 'voice' ? voiceSession({ position: 98.5, readState }) : await hourlySession(h, { readState });
      const delay = kind === 'voice' ? 3000 : 2000;
      await h.advance(delay - 1);
      assert.equal(s.pushes.length, 0);
      await h.advance(1);
      assert.equal(s.pushes.length, 1);
      assert.match(s.pushes[0], kind === 'voice' ? /seek=98/ : /seek=120/);
      assert.equal(s.resumes.length, 0);
      s.engine?.setEnabled(false);
      s.manager.cleanup();
      assert.equal(h.timers.size, 0);
    });
  });
}

for (const mode of ['order', 'random', 'loop', 'single', 'singlePlay']) {
  test(`standalone artist queue: matched song starts first and ${mode} controls natural completion`, async () => {
    await withClock(async (h) => {
      const tracks = songs.map((song) => ({ ...song, artist: '周杰伦', album: '', type: 'remote' }));
      const { manager, pushes, tts } = player({
        service: {
          getPlayState: async () => ({
            status: 1,
            position: 0,
            duration: 0,
            hasPosition: false,
            sampledAt: Date.now(),
          }),
        },
      });
      const saved = {};
      manager.configManager.getDevices = async () => [{ device_id: 'speaker', play_mode: mode }];
      manager.configManager.updateDevice = async (_account, _device, patch) => Object.assign(saved, patch);
      const indexingManager = {
        loadLibrarySongsByArtist: async (artist) => {
          assert.equal(artist, '周杰伦');
          return [tracks[0], tracks[1], tracks[2], tracks[1]];
        },
      };
      assert.equal(await VoiceEngine.prototype.playStandaloneSong.call({ indexingManager }, tracks[1], manager), true);
      assert.deepEqual(
        manager.getSongs().map((song) => song.id),
        [17, 16, 18],
      );
      assert.equal(manager.getStatus().playlist_name, '歌手: 周杰伦');
      assert.equal(manager.getStatus().current_song.id, 17);
      assert.equal(manager.getStatus().play_mode, mode);
      assert.ok(pushes[0].includes('/songs/17/play'));
      assert.equal(saved.temp_artist, '周杰伦');
      assert.equal(saved.temp_artist_exact, true);
      assert.equal(saved.temp_song_id, 17);
      await h.advance(299999);
      assert.equal(pushes.length, 1, 'must not cut the requested song short');
      await h.advance(1);
      if (mode === 'singlePlay') {
        assert.equal(pushes.length, 1);
        assert.equal(manager.state, 'paused');
      } else {
        assert.equal(pushes.length, 2);
        assert.ok(pushes[1].includes(`/songs/${mode === 'single' ? 17 : 16}/play`));
        assert.ok(manager.checkTimer !== null);
      }
      assert.equal(manager.unplayableSongs.size, 0);
      assert.deepEqual(tts, []);
      manager.cleanup();
    });
  });
}

for (const reason of ['empty', 'error', 'no-artist']) {
  test(`standalone artist queue: ${reason} keeps requested song playable`, async () => {
    await withClock(async () => {
      const { manager, pushes } = player();
      const song = { ...songs[0], artist: reason === 'no-artist' ? '' : '歌手' };
      const indexing = {
        loadLibrarySongsByArtist: async () => {
          assert.notEqual(reason, 'no-artist');
          if (reason === 'error') throw new Error('unavailable');
          return [];
        },
      };
      assert.equal(await manager.playStandaloneSong(song, indexing), true);
      assert.equal(manager.getSongs().length, 1);
      assert.ok(pushes[0].includes('/songs/16/play'));
      manager.cleanup();
    });
  });
}

test('standalone artist queue: stopping or a newer playback cancels delayed artist loading', async () => {
  await withClock(async () => {
    for (const change of ['stop', 'new-playback', 'task']) {
      const { manager, pushes } = player();
      const gate = deferred();
      let current = true;
      const playing = manager.playStandaloneSong(
        { ...songs[0], artist: '歌手' },
        {
          loadLibrarySongsByArtist: () => gate.promise,
        },
        () => current,
      );
      await flush();
      if (change === 'stop') await manager.stop(false);
      if (change === 'new-playback') manager.prepareForNewPlayback();
      if (change === 'task') current = false;
      gate.resolve(songs);
      assert.equal(await playing, false);
      assert.deepEqual(pushes, []);
      manager.cleanup();
    }
  });
});

test('standalone artist queue: reload restores the selected song by ID without pushing or restoring an old playlist', async () => {
  await withClock(async () => {
    const saved = {
      device_id: 'speaker',
      playlist_id: 42,
      temp_artist: '周杰伦',
      temp_artist_exact: true,
      temp_song_id: 16,
      temp_start_song_id: 17,
      play_mode: 'loop',
    };
    const map = new PlaylistManagerMap(
      {},
      {
        getDevices: async () => [saved],
      },
    );
    const manager = await map.getOrCreate('account', 'speaker');
    assert.equal(manager.getSongs().length, 0);
    await map.restoreTempPlaylists({ loadLibrarySongsByArtist: async () => songs });
    assert.deepEqual(
      manager.getSongs().map((song) => song.id),
      [17, 16, 18],
    );
    assert.equal(manager.getStatus().current_song.id, 16);
    assert.equal(manager.getStatus().playlist_name, '歌手: 周杰伦');
    assert.equal(manager.getStatus().play_mode, 'loop');
    assert.equal(manager.state, 'idle');
    manager.cleanup();
  });
});

test('standalone artist queue: selecting another song in the temporary playlist preserves its library restore metadata', async () => {
  await withClock(async () => {
    const { manager } = player();
    const saved = {};
    manager.configManager.updateDevice = async (_account, _device, patch) => Object.assign(saved, patch);
    await manager.playStandaloneSong({ ...songs[1], artist: '歌手' }, { loadLibrarySongsByArtist: async () => songs });
    await manager.playWithSongs(manager.getSongs(), 2, 'order', manager.getStatus().playlist_name);
    assert.equal(saved.temp_artist, '歌手');
    assert.equal(saved.temp_artist_exact, true);
    assert.equal(saved.temp_start_song_id, 17);
    assert.equal(saved.temp_song_id, 18);
    manager.cleanup();
  });
});

test('standalone artist queue: no-import seed stays in memory and its natural end advances to an indexed song', async () => {
  await withClock(async (h) => {
    const { manager, pushes } = player({
      service: {
        getPlayState: async () => ({ status: 1, position: 0, duration: 0, hasPosition: false, sampledAt: Date.now() }),
      },
    });
    const saved = {};
    manager.configManager.updateDevice = async (_account, _device, patch) => Object.assign(saved, patch);
    const direct = { ...songs[0], id: 0, artist: '歌手', url: 'https://audio.example/test.mp3' };
    assert.equal(await manager.playStandaloneSong(direct, { loadLibrarySongsByArtist: async () => songs }), true);
    assert.deepEqual(
      manager.getSongs().map((song) => song.id),
      [0, 16, 17, 18],
    );
    assert.equal(saved.temp_artist, '');
    assert.equal(pushes[0], direct.url);
    await h.advance(299999);
    assert.equal(pushes.length, 1);
    await h.advance(1);
    assert.equal(pushes.length, 2);
    assert.ok(pushes[1].includes('/songs/16/play'));
    assert.ok(!h.hostCalls.some((args) => String(args[1]).includes('/songs/0/')));
    manager.cleanup();
  });
});
