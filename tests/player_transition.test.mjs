import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const ts = require('typescript');

function loadSource(path, dependencies) {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  });
  const exports = {};
  new Function('require', 'exports', outputText)(name => {
    assert.ok(Object.hasOwn(dependencies, name), `unexpected dependency: ${name}`);
    return dependencies[name];
  }, exports);
  return exports;
}

const constants = loadSource('../src/mina/constants.ts', {
  '../data/tts-commands.json': {},
});
const debug = { isDebugLog: () => false };
const { MinaHTTPClient } = loadSource('../src/mina/client.ts', {
  '../utils/cookie': {},
  '../utils/http': {},
  '../utils/crypto': {},
  '../utils/debug': debug,
  './constants': constants,
  '../miio/client': {},
});
const { MinaService } = loadSource('../src/service/service.ts', {
  '../mina/auth': {},
  '../mina/constants': constants,
});
const { PlaylistManager } = loadSource('../src/player/manager.ts', {
  '../config/manager': { playlistProgressScope: () => 'account:speaker' },
  './url_builder': {},
  '../utils/http': {},
  '../utils/debug': debug,
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function flush() {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

async function withClock(run) {
  const original = {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    now: Date.now,
    songloft: globalThis.songloft,
  };
  let now = 100000;
  let timerId = 0;
  const timers = new Map();
  const logs = [];
  Date.now = () => now;
  globalThis.setTimeout = (fn, delay) => {
    timers.set(++timerId, { fn, at: now + delay });
    return timerId;
  };
  globalThis.clearTimeout = id => timers.delete(id);
  globalThis.songloft = {
    log: Object.fromEntries(['info', 'warn', 'error'].map(level => [level, message => logs.push(message)])),
  };
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
    await run({ timers, logs, advance });
  } finally {
    globalThis.setTimeout = original.setTimeout;
    globalThis.clearTimeout = original.clearTimeout;
    Date.now = original.now;
    globalThis.songloft = original.songloft;
  }
}

function player(readState, { duration = 300, seek = 0, speed = 1 } = {}) {
  const manager = new PlaylistManager('account', 'speaker', { getPlayState: readState }, {});
  manager.initWithSongs([{ id: 1, title: 'song', duration, type: 'local' }], 0, 'order', 1);
  manager.state = 'playing';
  manager.streamSeekOffsetSec = seek;
  manager.playbackSpeed = speed;
  let finished = 0;
  manager.onSongFinished = async () => { finished++; };
  return { manager, finished: () => finished };
}

const playing = position => ({ status: 1, position, duration: 300, hasPosition: true });

for (const hardware of ['L15A', 'unlisted-model']) {
  test(`replacement waits for pause and stop before pushing URL (${hardware})`, async () => {
    await withClock(async () => {
      const client = new MinaHTTPClient({ device_id: 'test-device' });
      const calls = [];
      const stopped = deferred();
      client.ubusRequest = async (deviceId, method, path, message) => {
        calls.push(message.action || method);
        if (message.action === 'stop') await stopped.promise;
        // Simulate a firmware that accepts pause but keeps the old track playing.
        return { code: 0, data: { code: 0 } };
      };
      const service = new MinaService({ getMinaClient: () => client }, { getConfig: async () => ({}) });
      service.deviceModelCache.set('speaker', hardware);
      service.deviceMiotDIDCache.set('speaker', 'test-did');
      const pending = service.playURL('account', 'speaker', 'http://example.test/song.mp3');
      await flush();
      assert.deepEqual(calls, ['pause', 'stop']);
      stopped.resolve();
      assert.equal(await pending, true);
      assert.deepEqual(calls, ['pause', 'stop', hardware === 'L15A' ? 'player_play_music' : 'player_play_url']);
    });
  });
}

for (const failure of ['rejected', 'throws']) {
  test(`failed pre-stop still attempts replacement URL (${failure})`, async () => {
    await withClock(async h => {
      const calls = [];
      const service = new MinaService({
        getMinaClient: () => ({
          playerStop: async () => {
            calls.push('stop');
            if (failure === 'throws') throw new Error('timeout');
            return false;
          },
          playByUrl: async () => { calls.push('play'); return true; },
        })
      }, { getConfig: async () => ({}) });
      service.deviceModelCache.set('speaker', 'L15A');
      service.deviceMiotDIDCache.set('speaker', 'test-did');
      assert.equal(await service.playURL('account', 'speaker', 'http://example.test/song.mp3'), true);
      assert.deepEqual(calls, ['stop', 'play']);
      assert.ok(h.logs.some(l => l.includes('continuing')));
    });
  });
}

test('tail polling starts in the last 15 seconds and repeats after one second', async () => {
  await withClock(async h => {
    let queries = 0;
    const p = player(async () => { queries++; return playing(285 + queries); });
    p.manager.startCheckTimer(30);
    await h.advance(14999);
    assert.equal(queries, 0);
    await h.advance(1);
    assert.equal(queries, 1);
    await h.advance(999);
    assert.equal(queries, 1);
    await h.advance(1);
    assert.equal(queries, 2);
    assert.equal(p.finished(), 0);
    p.manager.stopCheckTimer();
  });
});

test('loop detection uses stream position after seek and speed conversion', async () => {
  await withClock(async h => {
    let position = 40;
    const p = player(async () => playing(position), { seek: 200, speed: 2 });
    p.manager.scheduleTailProbe(0);
    await h.advance(1);
    position = 1;
    await h.advance(1000);
    assert.equal(p.finished(), 1);
    assert.equal(h.timers.size, 0);
    assert.ok(h.logs.some(l => l.includes('seek=200s')));
  });
});

test('seek near the end does not count the seek offset as observed progress', async () => {
  await withClock(async h => {
    let state = playing(0);
    const p = player(async () => state, { seek: 290 });
    p.manager.scheduleTailProbe(0);
    await h.advance(1);
    state = { status: 0, position: 0, duration: 300 };
    await h.advance(1000);
    assert.equal(p.finished(), 0);
    p.manager.stopCheckTimer();
  });
});

test('one-second polling requires six seconds of continuous tail stall', async () => {
  await withClock(async h => {
    const p = player(async () => playing(298));
    p.manager.scheduleTailProbe(0);
    await h.advance(1);
    await h.advance(5999);
    assert.equal(p.finished(), 0);
    await h.advance(1);
    assert.equal(p.finished(), 1);
    assert.equal(h.timers.size, 0);
  });
});

test('normal half-speed playback never accumulates a tail stall', async () => {
  await withClock(async h => {
    let position = 0;
    const p = player(async () => playing(position++), { seek: 285, speed: 0.5 });
    p.manager.scheduleTailProbe(0);
    await h.advance(8001);
    assert.equal(p.finished(), 0);
    assert.equal(p.manager.tailProbeStallStartedAtMs, null);
    p.manager.stopCheckTimer();
  });
});

test('unknown status and failed queries break the continuous stall window', async () => {
  await withClock(async h => {
    let mode = 'playing';
    const p = player(async () => {
      if (mode === 'failed') throw new Error('timeout');
      return mode === 'unknown' ? { status: -1, position: 0, duration: 0 } : playing(298);
    });
    p.manager.scheduleTailProbe(0);
    await h.advance(5001);
    for (const failure of ['unknown', 'failed']) {
      mode = failure;
      await h.advance(1000);
      mode = 'playing';
      await h.advance(6000);
      assert.equal(p.finished(), 0);
    }
    await h.advance(1000);
    assert.equal(p.finished(), 1);
  });
});

test('brief buffering at the tail and stalls outside the tail do not advance', async () => {
  await withClock(async h => {
    let position = 100;
    const p = player(async () => playing(position));
    p.manager.scheduleTailProbe(0);
    await h.advance(8001);
    assert.equal(p.finished(), 0);
    position = 285;
    await h.advance(1000);
    await h.advance(3000);
    position = 286;
    await h.advance(1000);
    assert.equal(p.finished(), 0);
    assert.equal(p.manager.tailProbeStallStartedAtMs, null);
    p.manager.stopCheckTimer();
  });
});

for (const probe of ['tailProbe', 'probeDeviceDuration']) {
  for (const reset of ['same-song restart', 'pause and resume', 'timer calibration']) {
    test(`${probe} discards a slow result after ${reset}`, async () => {
      await withClock(async h => {
        const slow = deferred();
        const p = player(() => slow.promise, { duration: probe === 'tailProbe' ? 300 : 0 });
        p.manager.tailProbeMaxPosition = 285;
        p.manager.maxProbePosition = 285;
        const pending = p.manager[probe]();
        await flush();
        if (reset === 'pause and resume') p.manager.state = 'paused';
        if (reset === 'timer calibration') p.manager.startCheckTimer(30);
        else p.manager.stopCheckTimer();
        p.manager.state = 'playing';
        const currentTimers = [...h.timers.keys()];
        slow.resolve(playing(0));
        await pending;
        assert.equal(p.finished(), 0);
        assert.deepEqual([...h.timers.keys()], currentTimers);
        assert.equal(p.manager.tailProbeLastPosition, -1);
        if (probe === 'probeDeviceDuration') assert.equal(p.manager.getCurrentSong().duration, 0);
        p.manager.stopCheckTimer();
      });
    });
  }
}

test('a rejected stale tail query cannot change the new probe baseline', async () => {
  await withClock(async h => {
    const slow = deferred();
    const p = player(() => slow.promise);
    const pending = p.manager.tailProbe();
    p.manager.startCheckTimer(30);
    p.manager.tailProbeLastPosition = 290;
    const timers = [...h.timers.keys()];
    slow.reject(new Error('old query timed out'));
    await pending;
    assert.equal(p.manager.tailProbeLastPosition, 290);
    assert.deepEqual([...h.timers.keys()], timers);
    p.manager.stopCheckTimer();
  });
});

test('slow tail queries never overlap and schedule only one next poll', async () => {
  await withClock(async h => {
    const slow = deferred();
    let queries = 0;
    const p = player(() => { queries++; return slow.promise; });
    p.manager.scheduleTailProbe(0);
    await h.advance(5000);
    assert.equal(queries, 1);
    assert.equal(h.timers.size, 0);
    slow.resolve(playing(285));
    await flush();
    assert.equal(h.timers.size, 1);
    await h.advance(999);
    assert.equal(queries, 1);
    await h.advance(1);
    assert.equal(queries, 2);
    p.manager.stopCheckTimer();
  });
});

test('missing device evidence leaves the metadata timer as the upper bound', async () => {
  await withClock(async h => {
    const p = player(async () => ({ status: -1, position: 0, duration: 0 }));
    p.manager.startCheckTimer(10);
    await h.advance(9999);
    assert.equal(p.finished(), 0);
    await h.advance(1);
    assert.equal(p.finished(), 1);
    p.manager.stopCheckTimer();
    assert.equal(h.timers.size, 0);
  });
});

test('a missing position field is not a stream reset, while an explicit zero is', async () => {
  await withClock(async h => {
    let info = { status: 1, play_song_detail: { position: 80000, duration: 100000 } };
    const service = new MinaService({}, {});
    service.getPlayerStatus = async () => ({ data: { info: JSON.stringify(info) } });
    const p = player(() => service.getPlayState('account', 'speaker'), { seek: 200 });
    p.manager.scheduleTailProbe(0);
    await h.advance(1);
    info = { status: 1, play_song_detail: { duration: 100000 } };
    await h.advance(1000);
    assert.equal(p.finished(), 0);
    info = { status: 1, play_song_detail: { position: 0, duration: 100000 } };
    await h.advance(1000);
    assert.equal(p.finished(), 1);
  });
});

for (const probe of ['checkExternalStop', 'verifyPlaybackLanded']) {
  for (const status of [0, 1]) {
    test(`${probe} cannot affect same-song restart with a stale status=${status}`, async () => {
      await withClock(async h => {
        const slow = deferred();
        const p = player(() => slow.promise);
        const pending = probe === 'verifyPlaybackLanded'
          ? p.manager.verifyPlaybackLanded(0, 1, 0)
          : p.manager.checkExternalStop();
        p.manager.startCheckTimer(60);
        p.manager.landingFailureCount = 1;
        const timers = [...h.timers.keys()];
        slow.resolve({ status, position: 285, duration: 300 });
        await pending;
        assert.deepEqual([...h.timers.keys()], timers);
        assert.equal(p.manager.stopPollMisses, 0);
        assert.equal(p.manager.stopPollMaxPosition, 0);
        assert.equal(p.manager.landingFailureCount, 1);
        p.manager.stopCheckTimer();
      });
    });
  }
}

test('metadata deadline waits for an episode that is still twenty seconds behind', async () => {
  await withClock(async h => {
    const startedAt = Date.now();
    const p = player(async () => ({
      status: 1, position: Math.max(0, (Date.now() - startedAt) / 1000 - 20),
      duration: 726, hasPosition: true,
    }), { duration: 726 });
    p.manager.startCheckTimer(726);
    await h.advance(726000);
    assert.equal(p.finished(), 0);
    assert.ok(h.logs.some(l => l.includes('Timer deferred:') && l.includes('remaining=20.0s')));
    await h.advance(19999);
    assert.equal(p.finished(), 0);
    await h.advance(1);
    assert.equal(p.finished(), 1);
    assert.equal(h.timers.size, 0);
  });
});

for (const speed of [0.5, 1, 2]) {
  test(`deadline uses stream position and seek at speed ${speed}`, async () => {
    await withClock(async h => {
      const deadlineAt = Date.now() + 100;
      const p = player(async () => ({
        status: 1, position: 5 + Math.max(0, Date.now() - deadlineAt) / 1000,
        duration: 20 / speed, hasPosition: true,
      }),
        { seek: 280, speed });
      p.manager.startCheckTimer(0.1);
      await h.advance(100);
      assert.equal(p.finished(), 0);
      const remainingMs = (20 / speed - 5) * 1000;
      await h.advance(remainingMs - 1);
      assert.equal(p.finished(), 0);
      await h.advance(1);
      assert.equal(p.finished(), 1);
      assert.equal(h.timers.size, 0);
    });
  });
}

test('a slightly longer device stream is allowed to finish without changing song metadata', async () => {
  await withClock(async h => {
    let position = 300;
    const p = player(async () => ({ ...playing(position), duration: 305 }));
    p.manager.startCheckTimer(0.1);
    await h.advance(100);
    assert.equal(p.finished(), 0);
    assert.equal(p.manager.getCurrentSong().duration, 300);
    position = 305;
    await h.advance(5000);
    assert.equal(p.finished(), 1);
  });
});

test('tail buffering fifteen seconds before the end does not trigger early advance', async () => {
  await withClock(async h => {
    const p = player(async () => playing(285));
    p.manager.scheduleTailProbe(0);
    await h.advance(12001);
    assert.equal(p.finished(), 0);
    p.manager.stopCheckTimer();
  });
});

test('a single stopped report at the tail does not cut an advancing stream', async () => {
  await withClock(async h => {
    let state = playing(298);
    const p = player(async () => state);
    p.manager.scheduleTailProbe(0);
    await h.advance(1);
    state = { ...playing(298), status: 2 };
    await h.advance(1000);
    assert.equal(p.finished(), 0);
    state = playing(299);
    await h.advance(1000);
    assert.equal(p.finished(), 0);
    assert.equal(p.manager.tailProbeStopMisses, 0);
    p.manager.stopCheckTimer();
  });
});

test('repeated stopped reports with advancing positions are not an ending', async () => {
  await withClock(async h => {
    let position = 296;
    const p = player(async () => ({ ...playing(position++), status: 2 }));
    p.manager.scheduleTailProbe(0);
    await h.advance(3001);
    assert.equal(p.finished(), 0);
    p.manager.stopCheckTimer();
  });
});

test('two stopped reports at a frozen end confirm natural completion', async () => {
  await withClock(async h => {
    let status = 1;
    const p = player(async () => ({ ...playing(299), status }));
    p.manager.scheduleTailProbe(0);
    await h.advance(1);
    status = 0;
    await h.advance(1000);
    assert.equal(p.finished(), 0);
    await h.advance(1000);
    assert.equal(p.finished(), 1);
    assert.equal(h.timers.size, 0);
  });
});

test('deadline recognizes a loop without postponing a whole episode', async () => {
  await withClock(async h => {
    const p = player(async () => playing(1));
    p.manager.startCheckTimer(0.1);
    p.manager.tailProbeMaxPosition = 299;
    await h.advance(100);
    assert.equal(p.finished(), 1);
    assert.equal(h.timers.size, 0);
  });
});

test('a frozen mid-tail position cannot defer the metadata deadline indefinitely', async () => {
  await withClock(async h => {
    const p = player(async () => playing(280));
    p.manager.startCheckTimer(0.1);
    await h.advance(100);
    assert.equal(p.finished(), 0);
    await h.advance(20000);
    assert.equal(p.finished(), 1);
    assert.equal(h.timers.size, 0);
  });
});

test('negative transition offset preserves intentional early switching', async () => {
  await withClock(async h => {
    let queries = 0;
    const p = player(async () => { queries++; return playing(290); });
    p.manager.transitionOffset = -10;
    p.manager.startCheckTimer(0.1);
    await h.advance(1);
    const queriesBeforeDeadline = queries;
    await h.advance(99);
    assert.equal(queries, queriesBeforeDeadline);
    assert.equal(p.finished(), 1);
  });
});

for (const state of [
  { status: 1, position: 0, duration: 300, hasPosition: false },
  { status: 1, position: NaN, duration: 300, hasPosition: true },
  { status: 1, position: 100, duration: 500, hasPosition: true },
]) {
  test(`deadline falls back for unusable evidence ${JSON.stringify(state)}`, async () => {
    await withClock(async h => {
      const p = player(async () => state);
      p.manager.startCheckTimer(0.1);
      await h.advance(100);
      assert.equal(p.finished(), 1);
      assert.equal(h.timers.size, 0);
    });
  });
}

for (const reset of ['pause', 'same-song restart', 'timer calibration']) {
  for (const rejected of [false, true]) {
    test(`deadline ignores a stale ${rejected ? 'failed' : 'successful'} query after ${reset}`, async () => {
      await withClock(async h => {
        const slow = deferred();
        const p = player(() => slow.promise);
        const pending = p.manager.verifyTimerDeadline();
        await flush();
        if (reset === 'timer calibration') p.manager.startCheckTimer(30);
        else p.manager.stopCheckTimer();
        p.manager.state = reset === 'pause' ? 'paused' : 'playing';
        const timers = [...h.timers.keys()];
        if (rejected) slow.reject(new Error('old timeout'));
        else slow.resolve(playing(280));
        await pending;
        assert.equal(p.finished(), 0);
        assert.deepEqual([...h.timers.keys()], timers);
        p.manager.stopCheckTimer();
      });
    });
  }
}

test('tail and deadline share a slow query and advance only once', async () => {
  await withClock(async h => {
    const slow = deferred();
    let queries = 0;
    const p = player(() => { queries++; return slow.promise; });
    p.manager.startCheckTimer(0.1);
    await h.advance(100);
    assert.equal(queries, 1);
    slow.resolve(playing(300));
    await flush();
    assert.equal(p.finished(), 1);
    assert.equal(h.timers.size, 0);
  });
});

test('deadline query failure uses metadata and clears all pending probes', async () => {
  await withClock(async h => {
    const p = player(async () => { throw new Error('cloud unavailable'); });
    p.manager.startCheckTimer(0.1);
    await h.advance(100);
    assert.equal(p.finished(), 1);
    assert.equal(h.timers.size, 0);
    assert.ok(h.logs.some(l => l.includes('Timer advancing: device query failed')));
  });
});

test('deadline defers when a stopped report still advances in the same stream', async () => {
  await withClock(async h => {
    let state = playing(270);
    const p = player(async () => state);
    p.manager.startCheckTimer(0.1);
    await h.advance(1);
    state = { ...playing(271), status: 2 };
    await h.advance(99);
    assert.equal(p.finished(), 0);
    assert.ok(h.logs.some(l => l.includes('Timer deferred:')));
    p.manager.stopCheckTimer();
  });
});

test('a positive transition offset is retained when postponing the deadline', async () => {
  await withClock(async h => {
    const p = player(async () => playing(280));
    p.manager.transitionOffset = 5;
    p.manager.startCheckTimer(0.1);
    await h.advance(100);
    assert.equal(p.finished(), 0);
    assert.ok(h.logs.some(l => l.includes('Timer deferred:') && l.includes('remaining=25.0s')));
    p.manager.stopCheckTimer();
  });
});

test('a missing stream duration still allows measured position to postpone the deadline', async () => {
  await withClock(async h => {
    const p = player(async () => ({ ...playing(280), duration: 0 }));
    p.manager.startCheckTimer(0.1);
    await h.advance(100);
    assert.equal(p.finished(), 0);
    assert.ok(h.logs.some(l => l.includes('Timer deferred:')));
    p.manager.stopCheckTimer();
  });
});

test('a loop immediately after postponement retains the previous progress evidence', async () => {
  await withClock(async h => {
    let position = 280;
    const p = player(async () => playing(position));
    p.manager.startCheckTimer(0.1);
    await h.advance(100);
    assert.equal(p.finished(), 0);
    position = 1;
    await h.advance(5000);
    assert.equal(p.finished(), 1);
    assert.equal(h.timers.size, 0);
  });
});

test('a slightly shorter stream that stops at its end advances promptly', async () => {
  await withClock(async h => {
    let status = 1;
    const p = player(async () => ({ status, position: 289, duration: 290, hasPosition: true }));
    p.manager.startCheckTimer(15);
    await h.advance(1);
    status = 0;
    await h.advance(1000);
    assert.equal(p.finished(), 0);
    await h.advance(1000);
    assert.equal(p.finished(), 1);
    assert.equal(h.timers.size, 0);
  });
});

test('a device that underestimates its stream length does not truncate advancing audio', async () => {
  await withClock(async h => {
    const p = player(async () => ({ ...playing(290), duration: 290 }));
    p.manager.startCheckTimer(0.1);
    await h.advance(100);
    assert.equal(p.finished(), 0);
    assert.ok(h.logs.some(l => l.includes('Timer deferred:') && l.includes('remaining=10.0s')));
    p.manager.stopCheckTimer();
  });
});

test('positive transition offset is not applied again after audio has already ended', async () => {
  await withClock(async h => {
    const p = player(async () => playing(300));
    p.manager.transitionOffset = 5;
    p.manager.startCheckTimer(0.1);
    await h.advance(100);
    assert.equal(p.finished(), 1);
    assert.equal(h.timers.size, 0);
  });
});
