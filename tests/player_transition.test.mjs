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
    if (name === './library_playlist' || name === '../player/library_playlist') {
      return loadSource('../src/player/library_playlist.ts', {});
    }
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
  '../playback/device_state': loadSource('../src/playback/device_state.ts', {}),
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
  const clears = [];
  const logs = [];
  Date.now = () => now;
  globalThis.setTimeout = (fn, delay) => {
    timers.set(++timerId, { fn, at: now + delay });
    return timerId;
  };
  globalThis.clearTimeout = id => {
    clears.push(id);
    return timers.delete(id);
  };
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
    await run({ timers, clears, logs, advance });
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

for (const condition of ['current tail', 'idle at tail', 'mid-song', 'foreign duration', 'missing position', 'unknown status', 'stale', 'voice', 'timer reset', 'negative offset']) {
  test(`fast tail sampling requires current stream evidence: ${condition}`, async () => {
    await withClock(async h => {
      const options = [];
      const state = { status: 1, position: 134.838, duration: 135, hasPosition: true, sampledAt: Date.now() };
      const p = player(async (_account, _device, query) => { options.push(query); return state; }, { seek: 30, speed: 2 });
      p.manager.observeTailLoop(state);
      if (condition === 'idle at tail') p.manager.observeTailLoop({ ...state, status: 2, sampledAt: Date.now() + 1 });
      if (condition === 'mid-song') p.manager.observeTailLoop({ ...state, position: 100, sampledAt: Date.now() + 1 });
      if (condition === 'foreign duration') p.manager.observeTailLoop({ ...state, duration: 500, sampledAt: Date.now() + 1 });
      if (condition === 'missing position') p.manager.observeTailLoop({ ...state, hasPosition: false, sampledAt: Date.now() + 1 });
      if (condition === 'unknown status') p.manager.observeTailLoop({ ...state, status: -1, sampledAt: Date.now() + 1 });
      if (condition === 'stale') await h.advance(5001);
      if (condition === 'voice') p.manager.suspendForVoiceInteraction();
      if (condition === 'timer reset') p.manager.startCheckTimer(1);
      if (condition === 'negative offset') p.manager.transitionOffset = -1;
      await p.manager.getTailDeviceState();
      assert.equal(Boolean(options[0].tail), condition === 'current tail' || condition === 'idle at tail');
      assert.equal(options[0].verify, false, 'tail sampling must respect client backoff');
      assert.equal(p.finished(), 0, 'near the end is not itself proof of completion');
      p.manager.cleanup();
      assert.equal(h.timers.size, 0);
    });
  });
}

for (const status of [0, 2, 3]) {
  for (const speed of [0.5, 1, 2]) {
    test(`confirmed tail accepts two fresh idle samples without detail: status=${status}, speed=${speed}`, async () => {
      await withClock(async h => {
        const startedAt = Date.now();
        let ended = false;
        const p = player(async () => ended
          ? { status, position: 0, duration: 0, hasPosition: false, sampledAt: Date.now() }
          : {
            status: 1, position: (200 / speed) + (Date.now() - startedAt) / 1000,
            duration: 500 / speed, hasPosition: true, sampledAt: Date.now()
          },
          { duration: 300, seek: 100, speed });
        p.manager.startCheckTimer(0.1);
        await h.advance(45100);
        assert.equal(p.finished(), 0);
        assert.equal(p.manager.deadlineTailEvidence.confirmed, true);
        ended = true;
        await h.advance(5000);
        assert.equal(p.finished(), 0, 'one idle response can be a transient misreport');
        await h.advance(4999);
        assert.equal(p.finished(), 0);
        await h.advance(1);
        assert.equal(p.finished(), 1, 'two fresh idle responses must not wait for the full grace');
        assert.equal(h.timers.size, 0);
        assert.equal(p.manager.getCurrentSong().duration, 300);
      });
    });
  }
}

for (const interruption of ['cached', 'query failure', 'playing without detail', 'unknown status', 'advancing', 'foreign duration']) {
  test(`idle without detail cannot end confirmed playback after ${interruption}`, async () => {
    await withClock(async h => {
      const startedAt = Date.now();
      let mode = 'advancing';
      let idleSampleAt;
      const p = player(async () => {
        if (mode === 'query failure') throw new Error('cloud failure');
        if (mode === 'advancing') return {
          status: 1, position: 300 + (Date.now() - startedAt) / 1000,
          duration: 500, hasPosition: true, sampledAt: Date.now()
        };
        return {
          status: mode === 'unknown status' ? -1 : mode === 'playing without detail' ? 1 : 0,
          position: 0, duration: mode === 'foreign duration' ? 900 : 0, hasPosition: false,
          sampledAt: mode === 'cached' ? idleSampleAt : Date.now()
        };
      });
      p.manager.startCheckTimer(0.1);
      await h.advance(45100);
      mode = 'idle';
      idleSampleAt = Date.now() + 5000;
      await h.advance(5000);
      assert.equal(p.finished(), 0);
      mode = interruption;
      await h.advance(5000);
      assert.equal(p.finished(), 0);
      if (interruption !== 'cached') {
        mode = 'idle';
        await h.advance(5000);
        assert.equal(p.finished(), 0, 'idle confirmation must restart after interrupted or resumed evidence');
      }
      p.manager.cleanup();
      assert.equal(h.timers.size, 0);
    });
  });
}

test('idle without detail after unconfirmed mismatched progress retains bounded verification', async () => {
  await withClock(async h => {
    let ended = false;
    const p = player(async () => ended
      ? { status: 0, position: 0, duration: 0, hasPosition: false, sampledAt: Date.now() }
      : { status: 1, position: 300, duration: 500, hasPosition: true, sampledAt: Date.now() });
    p.manager.startCheckTimer(0.1);
    await h.advance(100);
    ended = true;
    await h.advance(29999);
    assert.equal(p.finished(), 0);
    await h.advance(1);
    assert.equal(p.finished(), 1);
    assert.equal(h.timers.size, 0);
  });
});

for (const lateOutcome of ['success', 'failure']) {
  for (const completion of ['timeout', 'cancel']) {
    test(`issue 514 ${completion} ignores late ${lateOutcome} without clearing an expired handle`, async () => {
      await withClock(async h => {
        const slow = deferred();
        const p = player(() => slow.promise);
        const outcomes = [];
        const query = p.manager.getDeadlineDeviceState(100).then(
          state => outcomes.push(state.status),
          error => outcomes.push(error.message),
        );
        const [deadlineTimer] = h.timers.keys();
        const cancel = p.manager.cancelDeadlineQuery;
        if (completion === 'timeout') await h.advance(100);
        else {
          cancel();
          await flush();
        }
        assert.deepEqual(outcomes, completion === 'timeout' ? ['device query exceeded deadline budget'] : [-1]);
        assert.equal(p.manager.cancelDeadlineQuery, null);
        assert.deepEqual(h.clears, completion === 'timeout' ? [] : [deadlineTimer]);

        let listenerTicks = 0;
        const poll = () => {
          listenerTicks++;
          if (listenerTicks < 2) setTimeout(poll, 10);
        };
        setTimeout(poll, 10);
        cancel();
        if (lateOutcome === 'success') slow.resolve(playing(300));
        else slow.reject(new Error('late cloud failure'));
        await flush();
        await query;
        assert.deepEqual(h.clears, completion === 'timeout' ? [] : [deadlineTimer]);
        await h.advance(20);
        assert.equal(listenerTicks, 2);
        assert.equal(outcomes.length, 1);
        assert.equal(h.timers.size, 0);
      });
    });
  }
}

for (const outcome of ['success', 'failure']) {
  test(`issue 514 query ${outcome} clears its active timeout exactly once`, async () => {
    await withClock(async h => {
      const slow = deferred();
      const p = player(() => slow.promise);
      const query = p.manager.getDeadlineDeviceState(100);
      const [deadlineTimer] = h.timers.keys();
      const cancel = p.manager.cancelDeadlineQuery;
      if (outcome === 'success') {
        slow.resolve(playing(12));
        assert.equal((await query).position, 12);
      } else {
        const rejected = assert.rejects(query, /cloud failure/);
        slow.reject(new Error('cloud failure'));
        await rejected;
      }
      cancel();
      assert.deepEqual(h.clears, [deadlineTimer]);
      assert.equal(p.manager.cancelDeadlineQuery, null);
      assert.equal(h.timers.size, 0);
    });
  });
}

test('issue 495 waits for an episode with 2.6 seconds left despite a mismatched device duration', async () => {
  await withClock(async h => {
    const deadlineAt = Date.now() + 100;
    let looped = false;
    const p = player(async () => ({
      status: 1, position: looped ? 0 : Math.min(764, 761.385 + Math.max(0, Date.now() - deadlineAt) / 1000),
      duration: 900, hasPosition: true, sampledAt: Date.now(),
    }), { duration: 764 });
    p.manager.startCheckTimer(0.1);
    await h.advance(100);
    assert.equal(p.finished(), 0);
    assert.ok(h.logs.some(l => l.includes('Timer retry:') && l.includes('remaining=2.6s') && l.includes('streamMatch=foreign')));
    await h.advance(2615);
    assert.equal(p.finished(), 0);
    await h.advance(2385);
    assert.equal(p.finished(), 0, 'reaching metadata duration does not prove that the mismatched stream ended');
    looped = true;
    await h.advance(5000);
    assert.equal(p.finished(), 1);
    assert.equal(h.timers.size, 0);
    assert.equal(p.manager.getCurrentSong().duration, 764);
  });
});

for (const speed of [0.5, 1, 2]) {
  test(`continuous tail progress with a mismatched duration respects seek and speed ${speed}`, async () => {
    await withClock(async h => {
      let position = (761.385 - 500) / speed;
      const p = player(async () => ({
        status: 1, position, duration: 900 / speed, hasPosition: true, sampledAt: Date.now(),
      }), { duration: 764, seek: 500, speed });
      p.manager.startCheckTimer(0.1);
      await h.advance(100);
      assert.equal(p.finished(), 0);
      position += 1 / speed;
      await h.advance(5000);
      assert.equal(p.finished(), 0);
      assert.ok(h.logs.some(l => l.includes('Timer deferred:')));
      position = (764 - 500) / speed;
      await h.advance(Math.ceil(1615 / speed));
      assert.equal(p.finished(), 0);
      await h.advance(5000);
      assert.equal(p.finished(), 0, 'measured playback at metadata duration must retain ending verification');
      position = 0;
      await h.advance(5000);
      assert.equal(p.finished(), 1);
      assert.equal(h.timers.size, 0);
    });
  });
}

for (const interruption of ['query failure', 'missing position', 'missing duration', 'unknown status', 'cached', 'frozen', 'jumped', 'changed duration']) {
  test(`confirmed tail beyond metadata retains bounded grace after ${interruption}`, async () => {
    await withClock(async h => {
      const startedAt = Date.now();
      let mode = 'playing';
      let lastPosition = 0;
      let lastSampleAt = 0;
      const p = player(async () => {
        if (mode === 'query failure') throw new Error('cloud failure');
        if (mode === 'playing') {
          lastPosition = 300 + (Date.now() - startedAt) / 1000;
          lastSampleAt = Date.now();
        }
        return {
          status: mode === 'unknown status' ? -1 : 1,
          position: mode === 'missing position' ? 0 : lastPosition + (mode === 'jumped' ? 100 : 0),
          duration: mode === 'missing duration' ? 0 : mode === 'changed duration' ? 900 : 500,
          hasPosition: mode !== 'missing position',
          sampledAt: mode === 'cached' ? lastSampleAt : Date.now(),
        };
      });
      p.manager.startCheckTimer(0.1);
      await h.advance(45100);
      assert.equal(p.finished(), 0);
      assert.equal(p.manager.deadlineTailEvidence.confirmed, true);
      mode = interruption;
      await h.advance(29999);
      assert.equal(p.finished(), 0);
      await h.advance(1);
      assert.equal(p.finished(), 1);
      assert.equal(h.timers.size, 0);
    });
  });
}

for (const interruption of ['query failure', 'missing position', 'missing duration', 'unknown status']) {
  test(`tail continuity can recover beyond metadata after a short ${interruption}`, async () => {
    await withClock(async h => {
      const startedAt = Date.now();
      let mode = 'playing';
      const p = player(async () => {
        if (mode === 'query failure') throw new Error('cloud failure');
        return {
          status: mode === 'unknown status' ? -1 : 1,
          position: 300 + (Date.now() - startedAt) / 1000,
          duration: mode === 'missing duration' ? 0 : 500,
          hasPosition: mode !== 'missing position', sampledAt: Date.now(),
        };
      });
      p.manager.startCheckTimer(0.1);
      await h.advance(45100);
      mode = interruption;
      await h.advance(10000);
      assert.equal(p.finished(), 0);
      mode = 'playing';
      await h.advance(25000);
      assert.equal(p.finished(), 0, 'recovered measured progress must supersede the original grace deadline');
      p.manager.cleanup();
      assert.equal(h.timers.size, 0);
    });
  });
}

test('tail confirmation survives a stationary first sample after a short cloud failure', async () => {
  await withClock(async h => {
    const startedAt = Date.now();
    let mode = 'playing';
    let position = 0;
    let resumedAt = 0;
    let resumedPosition = 0;
    const p = player(async () => {
      if (mode === 'failed') throw new Error('temporary cloud failure');
      if (mode === 'playing') position = resumedAt
        ? resumedPosition + (Date.now() - resumedAt) / 1000
        : 300 + (Date.now() - startedAt) / 1000;
      return { status: 1, position, duration: 500, hasPosition: true, sampledAt: Date.now() };
    });
    p.manager.startCheckTimer(0.1);
    await h.advance(45100);
    assert.equal(p.finished(), 0);
    mode = 'failed';
    await h.advance(10000);
    mode = 'stationary';
    await h.advance(5000);
    assert.equal(p.finished(), 0);
    assert.equal(p.manager.deadlineTailEvidence?.confirmed, true);
    resumedAt = Date.now();
    resumedPosition = position;
    mode = 'playing';
    await h.advance(25000);
    assert.equal(p.finished(), 0, 'new measured progress beyond the metadata tail must keep postponing completion');
    p.manager.cleanup();
    assert.equal(h.timers.size, 0);
  });
});

for (const signal of ['cached', 'frozen', 'jumped', 'voice suspended', 'mid-song']) {
  test(`mismatched duration cannot establish current tail progress from ${signal} evidence`, async () => {
    await withClock(async h => {
      const startedAt = Date.now();
      const p = player(async () => ({
        status: 1,
        position: signal === 'mid-song' ? 100 + (Date.now() - startedAt) / 1000
          : signal === 'frozen' ? 297
            : signal === 'jumped' && Date.now() - startedAt > 100 ? 400
              : 297 + Math.min(3, (Date.now() - startedAt) / 1000),
        duration: 500, hasPosition: true,
        sampledAt: signal === 'cached' ? startedAt : Date.now(),
      }));
      p.manager.startCheckTimer(0.1);
      if (signal === 'voice suspended') p.manager.voiceSuspendedAt = Date.now();
      await h.advance(5100);
      assert.equal(p.finished(), 0);
      assert.equal(h.logs.filter(l => l.includes('Timer deferred:')).length, 0);
      await h.advance(25000);
      assert.equal(p.finished(), 1);
      assert.equal(h.timers.size, 0);
    });
  });
}

test('a three-second cloud response is consumed before considering fallback', async () => {
  await withClock(async h => {
    const slow = deferred();
    const p = player(() => slow.promise);
    p.manager.startCheckTimer(0.1);
    await h.advance(3100);
    assert.equal(p.finished(), 0);
    slow.resolve({ ...playing(280), sampledAt: Date.now() });
    await flush();
    assert.equal(p.finished(), 0);
    assert.ok(h.logs.some(l => l.includes('Timer deferred:')));
    p.manager.stopCheckTimer();
    assert.equal(h.timers.size, 0);
  });
});

for (const interruption of ['query failure', 'missing position', 'stopped']) {
  test(`unusable ${interruption} samples break mismatched-duration tail continuity`, async () => {
    await withClock(async h => {
      let phase = 0;
      const p = player(async () => {
        if (phase === 1 && interruption === 'query failure') throw new Error('cloud failure');
        return {
          ...playing(phase === 2 ? 300 : 297), duration: 500, sampledAt: Date.now(),
          hasPosition: !(phase === 1 && interruption === 'missing position'),
          status: phase === 1 && interruption === 'stopped' ? 2 : 1,
        };
      });
      p.manager.startCheckTimer(0.1);
      await h.advance(100);
      phase = 1;
      await h.advance(5000);
      phase = 2;
      await h.advance(5000);
      assert.equal(p.finished(), 0);
      assert.equal(h.logs.filter(l => l.includes('Timer deferred:')).length, 0);
      await h.advance(20000);
      assert.equal(p.finished(), 1);
      assert.equal(h.timers.size, 0);
    });
  });
}

test('cloud recovery during grace resumes progress checks without cutting the episode', async () => {
  await withClock(async h => {
    let unavailable = true;
    const startedAt = Date.now();
    const p = player(async () => {
      if (unavailable) throw new Error('temporary cloud failure');
      return { ...playing(Math.min(300, 290 + (Date.now() - startedAt) / 1000)), sampledAt: Date.now() };
    });
    p.manager.startCheckTimer(0.1);
    await h.advance(100);
    assert.equal(p.finished(), 0);
    unavailable = false;
    await h.advance(5000);
    assert.equal(p.finished(), 0);
    await h.advance(4900);
    assert.equal(p.finished(), 1);
    assert.equal(h.timers.size, 0);
  });
});

for (const reset of ['pause', 'same-song restart']) {
  test(`a scheduled deadline retry cannot affect playback after ${reset}`, async () => {
    await withClock(async h => {
      const p = player(async () => ({ ...playing(297), duration: 500 }));
      p.manager.startCheckTimer(0.1);
      await h.advance(100);
      assert.ok(p.manager.deadlineGraceDeadlineMs > 0);
      p.manager.stopCheckTimer();
      if (reset === 'pause') p.manager.state = 'paused';
      else p.manager.startCheckTimer(60);
      assert.equal(p.manager.deadlineSamplePosition, -1);
      assert.equal(p.manager.deadlineGraceDeadlineMs, 0);
      await h.advance(30000);
      assert.equal(p.finished(), 0);
      p.manager.stopCheckTimer();
      assert.equal(h.timers.size, 0);
    });
  });
}

test('a hung cloud query gets a bounded grace period and late results cannot advance twice', async () => {
  await withClock(async h => {
    const slow = deferred();
    const p = player(() => slow.promise);
    p.manager.startCheckTimer(0.1);
    await h.advance(35099);
    assert.equal(p.finished(), 0);
    await h.advance(1);
    assert.equal(p.finished(), 1);
    assert.equal(h.timers.size, 0);
    slow.resolve(playing(280));
    await flush();
    assert.equal(p.finished(), 1);
    assert.equal(h.timers.size, 0);
  });
});

test('timed-out early calibration cannot bypass the metadata deadline and its grace period', async () => {
  await withClock(async h => {
    const slow = deferred();
    const p = player(() => slow.promise);
    p.manager.startCheckTimer(5);
    p.manager.scheduleDeadlineCheck(100);
    await h.advance(4999);
    assert.equal(p.finished(), 0);
    await h.advance(1001);
    assert.equal(p.finished(), 0);
    await h.advance(29099);
    assert.equal(p.finished(), 0);
    await h.advance(1);
    assert.equal(p.finished(), 1);
    slow.resolve(playing(300));
    await flush();
    assert.equal(p.finished(), 1);
  });
});

test('stopping during a deadline wait cancels its local timeout and ignores the late response', async () => {
  await withClock(async h => {
    const slow = deferred();
    const p = player(() => slow.promise);
    p.manager.startCheckTimer(0.1);
    await h.advance(100);
    p.manager.stopCheckTimer();
    p.manager.state = 'paused';
    assert.equal(h.timers.size, 0);
    await h.advance(1000);
    assert.equal(p.finished(), 0);
    slow.resolve(playing(300));
    await flush();
    assert.equal(p.finished(), 0);
  });
});

test('repeated cached stopped samples cannot count as two confirmations', async () => {
  await withClock(async h => {
    let sampledAt = Date.now();
    const p = player(async () => ({ ...playing(298), status: 0, sampledAt }));
    p.manager.scheduleTailProbe(0);
    await h.advance(4001);
    assert.equal(p.finished(), 0);
    assert.equal(p.manager.tailProbeStopMisses, 1);
    sampledAt = Date.now();
    await h.advance(1000);
    assert.equal(p.finished(), 1);
    assert.equal(h.timers.size, 0);
  });
});

test('cached samples cannot accumulate six seconds of tail stall without fresh device evidence', async () => {
  await withClock(async h => {
    let sampledAt = Date.now();
    const p = player(async () => ({ ...playing(298), sampledAt }));
    p.manager.scheduleTailProbe(0);
    await h.advance(6001);
    assert.equal(p.finished(), 0);
    sampledAt = Date.now();
    await h.advance(1000);
    assert.equal(p.finished(), 1);
  });
});

test('delayed consumption of a cached sample cannot lengthen its observed stall', async () => {
  await withClock(async h => {
    const firstSampleAt = Date.now();
    let sampledAt = firstSampleAt;
    const p = player(async () => ({ ...playing(298), sampledAt }));
    p.manager.scheduleTailProbe(0);
    await h.advance(6001);
    sampledAt = firstSampleAt + 5000;
    await h.advance(1000);
    assert.equal(p.finished(), 0);
    sampledAt = Date.now();
    await h.advance(1000);
    assert.equal(p.finished(), 1);
  });
});

test('unknown-duration playback never invents a metadata deadline during cloud failure', async () => {
  await withClock(async h => {
    const p = player(async () => ({ status: -1, position: 0, duration: 0, hasPosition: false }), { duration: 0 });
    p.manager.scheduleDurationProbe();
    await h.advance(60000);
    assert.equal(p.finished(), 0);
    assert.equal(p.manager.checkTimer, null);
    p.manager.stopCheckTimer();
    assert.equal(h.timers.size, 0);
  });
});

test('device state preserves millisecond position and stream duration', async () => {
  await withClock(async () => {
    const service = new MinaService({}, {});
    service.getPlayerStatus = async () => ({
      data: {
        info: JSON.stringify({
          status: 1, play_song_detail: { position: 202375, duration: 203760 },
        })
      }
    });
    assert.deepEqual(await service.getPlayState('account', 'speaker'), {
      status: 1, position: 202.375, duration: 203.76, hasPosition: true,
    });
  });
});

test('tail progress calibrates the deadline before a fractional song loops', async () => {
  await withClock(async h => {
    const start = Date.now();
    const duration = 203.76;
    const p = player(async () => ({
      status: 1, hasPosition: true, duration,
      position: Math.min(duration, 202 + (Date.now() - start - 1) / 1000),
    }), { duration });
    p.manager.startCheckTimer(10);
    await h.advance(1001);
    assert.equal(p.finished(), 0);
    assert.ok(h.logs.some(l => l.includes('Tail timer calibrated')));
    await h.advance(758);
    assert.equal(p.finished(), 0);
    await h.advance(2);
    assert.equal(p.finished(), 1);
    assert.equal(h.timers.size, 0);
  });
});

test('slow tail queries bring the check forward but cannot prove the song finished', async () => {
  await withClock(async h => {
    let calls = 0;
    const slow = deferred();
    const p = player(() => {
      calls++;
      if (calls === 1) return Promise.resolve({ ...playing(200), duration: 203.76 });
      if (calls === 2) return slow.promise;
      return Promise.resolve({ ...playing(203), duration: 203.76 });
    }, { duration: 203.76 });
    p.manager.startCheckTimer(10);
    await h.advance(1001);
    await h.advance(400);
    slow.resolve({ ...playing(201.4), duration: 203.76 });
    await flush();
    assert.ok(Math.abs(p.manager.checkTimerDeadlineMs - (100000 + 3361)) <= 1);
    await h.advance(1961);
    assert.equal(p.finished(), 0);
    assert.ok(h.logs.some(l => l.includes('Timer deferred:')));
    p.manager.stopCheckTimer();
  });
});

for (const signal of ['query failed', 'status unknown', 'position missing', 'foreign media', 'frozen']) {
  test(`early calibrated checks retain the metadata deadline and bounded grace when ${signal}`, async () => {
    await withClock(async h => {
      let position = 295;
      let useFailure = false;
      const p = player(async () => {
        if (!useFailure) return playing(position);
        if (signal === 'query failed') throw new Error('timeout');
        if (signal === 'status unknown') return { ...playing(0), status: -1 };
        if (signal === 'position missing') return { ...playing(0), hasPosition: false };
        if (signal === 'foreign media') return { ...playing(300), duration: 500 };
        return playing(position);
      });
      p.manager.startCheckTimer(15);
      const fallback = p.manager.checkTimerFallbackDeadlineMs;
      await h.advance(1);
      position = 296;
      await h.advance(1000);
      assert.ok(p.manager.checkTimerDeadlineMs < fallback);
      useFailure = true;
      await h.advance(8000);
      assert.equal(p.finished(), 0);
      assert.equal(p.manager.checkTimerFallbackDeadlineMs, fallback);
      assert.equal(p.manager.checkTimerDeadlineMs, fallback);
      await h.advance(5999);
      assert.equal(p.finished(), 0);
      await h.advance(30000);
      assert.equal(p.finished(), 1);
      assert.equal(h.timers.size, 0);
    });
  });
}

test('a calibrated deadline defers during a short tail buffer and resumes without truncation', async () => {
  await withClock(async h => {
    const start = Date.now();
    const p = player(async () => playing(295 + (Math.min(1001, Date.now() - start) +
      Math.max(0, Date.now() - start - 3501)) / 1000));
    p.manager.startCheckTimer(15);
    await h.advance(1001);
    assert.ok(p.manager.checkTimerDeadlineMs < start + 15000);
    await h.advance(4999);
    assert.equal(p.finished(), 0);
    await h.advance(1500);
    assert.equal(p.finished(), 1);
    assert.equal(h.timers.size, 0);
  });
});

for (const speed of [0.5, 1, 2]) {
  test(`tail calibration converts seek and stream time at speed ${speed}`, async () => {
    await withClock(async h => {
      const start = Date.now();
      const p = player(async () => ({
        status: 1, hasPosition: true, duration: 10 / speed,
        position: 5 / speed + (Date.now() - start - 15000) / 1000,
      }), { duration: 300, seek: 290, speed });
      p.manager.startCheckTimer(30);
      await h.advance(16001);
      assert.equal(p.finished(), 0);
      assert.ok(h.logs.some(l => l.includes('Tail timer calibrated')));
      assert.ok(Math.abs(p.manager.checkTimerDeadlineMs - (115000 + 5000 / speed)) <= 1);
      p.manager.stopCheckTimer();
    });
  });
}

for (const sample of [
  { ...playing(290.5), hasPosition: false },
  { ...playing(290.5), duration: 500 },
  playing(290), playing(280), playing(299),
]) {
  test(`tail calibration rejects unusable or discontinuous progress ${JSON.stringify(sample)}`, async () => {
    await withClock(async h => {
      let state = playing(290);
      const p = player(async () => state);
      p.manager.startCheckTimer(15);
      await h.advance(1);
      const deadline = p.manager.checkTimerDeadlineMs;
      state = sample;
      await h.advance(1000);
      assert.equal(p.manager.checkTimerDeadlineMs, deadline);
      assert.equal(p.finished(), 0);
      p.manager.stopCheckTimer();
    });
  });
}

test('a frozen fractional position cannot look like advancing audio', async () => {
  await withClock(async h => {
    const p = player(async () => playing(298.375));
    p.manager.scheduleTailProbe(0);
    await h.advance(6000);
    assert.equal(p.finished(), 0);
    await h.advance(1);
    assert.equal(p.finished(), 1);
  });
});

test('subsecond progress prevents a false six-second stall', async () => {
  await withClock(async h => {
    const start = Date.now();
    const p = player(async () => playing(298 + (Date.now() - start) / 10000));
    p.manager.scheduleTailProbe(0);
    await h.advance(7001);
    assert.equal(p.finished(), 0);
    p.manager.stopCheckTimer();
  });
});

for (const mode of ['negative offset', 'voice suspended']) {
  test(`tail calibration preserves ${mode}`, async () => {
    await withClock(async h => {
      let position = 295;
      const p = player(async () => playing(position));
      p.manager.startCheckTimer(15);
      if (mode === 'negative offset') p.manager.transitionOffset = -2;
      else p.manager.voiceSuspendedAt = Date.now();
      await h.advance(1);
      const deadline = p.manager.checkTimerDeadlineMs;
      position++;
      await h.advance(1000);
      assert.equal(p.manager.checkTimerDeadlineMs, deadline);
      p.manager.stopCheckTimer();
    });
  });
}

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
    const p = player(async () => ({ ...playing(position), duration: 50 }), { seek: 200, speed: 2 });
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
    let state = { ...playing(0), duration: 10 };
    const p = player(async () => state, { seek: 290 });
    p.manager.scheduleTailProbe(0);
    await h.advance(1);
    state = { status: 0, position: 0, duration: 10, hasPosition: true };
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
    const p = player(async () => ({ ...playing(position++), duration: 30 }), { seek: 285, speed: 0.5 });
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

test('missing device evidence retries for thirty seconds after the metadata deadline', async () => {
  await withClock(async h => {
    const p = player(async () => ({ status: -1, position: 0, duration: 0 }));
    p.manager.startCheckTimer(10);
    await h.advance(9999);
    assert.equal(p.finished(), 0);
    await h.advance(1);
    assert.equal(p.finished(), 0);
    await h.advance(29999);
    assert.equal(p.finished(), 0);
    await h.advance(1);
    assert.equal(p.finished(), 1);
    p.manager.stopCheckTimer();
    assert.equal(h.timers.size, 0);
  });
});

for (const status of [0, 1, 2]) {
  test(`issue 124 status-only device switches at the metadata deadline with status=${status}`, async () => {
    await withClock(async h => {
      const deadlineAt = Date.now() + 240000;
      const service = new MinaService({}, {});
      service.getPlayerStatus = async () => ({
        data: { info: JSON.stringify({ status: Date.now() < deadlineAt ? 1 : status, volume: 30 }) },
        sampledAt: Date.now(),
      });
      const p = player(() => service.getPlayState('account', 'speaker'), { duration: 240 });
      p.manager.startCheckTimer(240);
      await h.advance(239999);
      assert.equal(p.finished(), 0);
      await h.advance(1);
      assert.equal(p.finished(), 1);
      assert.ok(h.logs.some(l => l.includes('device has no position, using metadata deadline')));
      assert.equal(h.logs.some(l => l.includes('Timer retry:')), false);
      assert.equal(h.timers.size, 0);
    });
  });
}

for (const { seek, speed, offset } of [
  { seek: 0, speed: 1, offset: 3 },
  { seek: 216, speed: 1, offset: 0 },
  { seek: 200, speed: 2, offset: 2 },
]) {
  test(`issue 124 metadata fallback preserves seek=${seek} speed=${speed} offset=${offset}`, async () => {
    await withClock(async h => {
      const p = player(async () => ({ status: 1, position: 0, duration: 0, hasPosition: false }), {
        duration: 240, seek, speed,
      });
      p.manager.transitionOffset = offset;
      const delayMs = (240 + offset - seek) / speed * 1000;
      p.manager.startCheckTimer(delayMs / 1000);
      await h.advance(delayMs - 1);
      assert.equal(p.finished(), 0);
      await h.advance(1);
      assert.equal(p.finished(), 1);
      await h.advance(30000);
      assert.equal(p.finished(), 1);
      assert.equal(h.timers.size, 0);
    });
  });
}

test('status-only fallback never advances before the original metadata deadline', async () => {
  await withClock(async h => {
    const p = player(async () => ({ status: 1, position: 0, duration: 0, hasPosition: false }));
    p.manager.startCheckTimer(10);
    p.manager.scheduleDeadlineCheck(100);
    await h.advance(9999);
    assert.equal(p.finished(), 0);
    await h.advance(1);
    assert.equal(p.finished(), 1);
    assert.equal(h.timers.size, 0);
  });
});

for (const probe of ['tailProbe', 'checkExternalStop', 'verifyPlaybackLanded']) {
  test(`progress seen by ${probe} keeps grace when position later disappears`, async () => {
    await withClock(async h => {
      let state = playing(280);
      const p = player(async () => state);
      p.manager.startCheckTimer(10);
      if (probe === 'tailProbe') await h.advance(1);
      else if (probe === 'verifyPlaybackLanded') await p.manager.verifyPlaybackLanded(0, 1, 0);
      else await p.manager[probe]();
      // Recalibration must keep earlier progress history when the latest sample disappears.
      p.manager.resetAutoNextTimer(290);
      state = { status: 1, position: 0, duration: 0, hasPosition: false };
      await h.advance(10000);
      assert.equal(p.finished(), 0);
      await h.advance(29999);
      assert.equal(p.finished(), 0);
      await h.advance(1);
      assert.equal(p.finished(), 1);
      assert.equal(h.logs.some(l => l.includes('device has no position, using metadata deadline')), false);
      assert.equal(h.timers.size, 0);
    });
  });
}

test('an explicit zero position still counts as reported progress before it disappears', async () => {
  await withClock(async h => {
    let state = playing(0);
    const p = player(async () => state);
    p.manager.startCheckTimer(10);
    await h.advance(1);
    state = { status: 1, position: 0, duration: 0, hasPosition: false };
    await h.advance(10000);
    assert.equal(p.finished(), 0);
    await h.advance(30000);
    assert.equal(p.finished(), 1);
  });
});

test('issue 129: a long blind idle stream advances at the metadata deadline without extra grace', async () => {
  await withClock(async h => {
    const p = player(async () => ({ status: 0, position: 0, duration: 0, hasPosition: true }));
    p.manager.streamStartedAtMs = Date.now() - 90000;
    p.manager.startCheckTimer(0.1);
    await h.advance(99);
    assert.equal(p.finished(), 0);
    await h.advance(1);
    assert.equal(p.finished(), 1);
    assert.ok(h.logs.some(line => line.includes('device has no position, using metadata deadline')));
    assert.equal(h.timers.size, 0);
  });
});

test('issue 129: a freshly started blind idle stream keeps the grace period', async () => {
  await withClock(async h => {
    const p = player(async () => ({ status: 0, position: 0, duration: 0, hasPosition: true }));
    p.manager.streamStartedAtMs = Date.now() - 10000;
    p.manager.startCheckTimer(0.1);
    await h.advance(100);
    assert.equal(p.finished(), 0);
    await h.advance(29999);
    assert.equal(p.finished(), 0);
    await h.advance(1);
    assert.equal(p.finished(), 1);
    assert.equal(h.logs.some(line => line.includes('device has no position, using metadata deadline')), false);
    assert.equal(h.timers.size, 0);
  });
});

for (const measured of [false, true]) {
  test(`${measured ? 'measured' : 'estimated'} calibration distinguishes temporary progress loss from a status-only device`, async () => {
    await withClock(async h => {
      const p = player(async () => ({ status: 1, position: 0, duration: 0, hasPosition: false }));
      p.manager.resetAutoNextTimer(290, measured);
      await h.advance(10000);
      assert.equal(p.finished(), measured ? 0 : 1);
      await h.advance(30000);
      assert.equal(p.finished(), 1);
      assert.equal(h.timers.size, 0);
    });
  });
}

test('voice suspension and soft resumption retain the current stream progress history', async () => {
  await withClock(async h => {
    let state = playing(280);
    const p = player(async () => state);
    p.manager.startCheckTimer(10);
    await h.advance(1);
    p.manager.suspendForVoiceInteraction();
    state = { status: 1, position: 0, duration: 0, hasPosition: false };
    p.manager.resetAutoNextTimer(290, false);
    await h.advance(10000);
    assert.equal(p.finished(), 0);
    await h.advance(30000);
    assert.equal(p.finished(), 1);
    assert.equal(h.timers.size, 0);
  });
});

test('deadline progress history survives repeated missing samples after deferral', async () => {
  await withClock(async h => {
    let state = playing(290);
    const p = player(async () => state);
    p.manager.startCheckTimer(0.1);
    await h.advance(100);
    state = { status: 1, position: 0, duration: 0, hasPosition: false };
    await h.advance(10000);
    assert.equal(p.finished(), 0);
    await h.advance(29999);
    assert.equal(p.finished(), 0);
    await h.advance(1);
    assert.equal(p.finished(), 1);
    assert.equal(h.timers.size, 0);
  });
});

test('a new playback does not inherit progress support from the previous stream', async () => {
  await withClock(async h => {
    let state = playing(280);
    const p = player(async () => state);
    p.manager.startCheckTimer(10);
    await h.advance(1);
    p.manager.prepareForNewPlayback();
    p.manager.state = 'playing';
    state = { status: 1, position: 0, duration: 0, hasPosition: false };
    p.manager.startCheckTimer(10);
    await h.advance(10000);
    assert.equal(p.finished(), 1);
    assert.equal(h.timers.size, 0);
  });
});

test('a duration-only device can switch after discovering an unknown song duration', async () => {
  await withClock(async h => {
    const p = player(async () => ({ status: 1, position: 0, duration: 20, hasPosition: false }), { duration: 0 });
    p.manager.scheduleDurationProbe();
    await h.advance(5000);
    assert.equal(p.manager.getCurrentSong().duration, 20);
    await h.advance(19999);
    assert.equal(p.finished(), 0);
    await h.advance(1);
    assert.equal(p.finished(), 1);
    assert.equal(h.timers.size, 0);
  });
});

test('issues 437 and 124: status-only playback with unknown duration waits for real duration evidence', async () => {
  await withClock(async h => {
    let duration = 0;
    const p = player(async () => ({ status: 1, position: 0, duration, hasPosition: false }), { duration: 0 });
    p.manager.scheduleDurationProbe();
    await h.advance(600000);
    assert.equal(p.finished(), 0);
    assert.equal(p.manager.checkTimer, null);
    duration = 20;
    await h.advance(5000);
    await h.advance(19999);
    assert.equal(p.finished(), 0);
    await h.advance(1);
    assert.equal(p.finished(), 1);
    assert.equal(h.timers.size, 0);
  });
});

// Observed tuples from songloft-org/songloft#495 on 2026-10-12; metadata and stream duration disagree.
for (const [duration, seek, position, streamDuration] of [[631, 112, 518.995, 3090.081], [736, 0, 736.275, 803.559]]) {
  test(`issues 495 and 124: measured ${position}s/${streamDuration}s seek=${seek} retains confirmation after progress disappears`, async () => {
    await withClock(async h => {
      let state = { status: 1, position, duration: streamDuration, hasPosition: true, sampledAt: Date.now() };
      const p = player(async () => state, { duration, seek });
      p.manager.startCheckTimer(0.1);
      await h.advance(100);
      assert.equal(p.finished(), 0);
      state = { status: 1, position: 0, duration: 0, hasPosition: false, sampledAt: Date.now() + 5000 };
      await h.advance(5000);
      assert.equal(p.finished(), 0);
      p.manager.stopCheckTimer();
      assert.equal(h.timers.size, 0);
    });
  });
}

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
    assert.equal(p.finished(), 0);
    await h.advance(30000);
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
  { status: -1, position: 0, duration: 0, hasPosition: false },
  { status: 1, position: 0, duration: 500, hasPosition: false },
  { status: 1, position: NaN, duration: 300, hasPosition: true },
  { status: 1, position: 100, duration: 500, hasPosition: true },
]) {
  test(`deadline retries before falling back for unusable evidence ${JSON.stringify(state)}`, async () => {
    await withClock(async h => {
      const p = player(async () => state);
      p.manager.startCheckTimer(0.1);
      await h.advance(100);
      assert.equal(p.finished(), 0);
      await h.advance(30000);
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
        assert.equal(p.manager.devicePositionObserved, false);
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

test('deadline query failure retries every five seconds then clears all pending probes', async () => {
  await withClock(async h => {
    const p = player(async () => { throw new Error('cloud unavailable'); });
    p.manager.startCheckTimer(0.1);
    await h.advance(100);
    const checksAtDeadline = h.logs.filter(l => l.includes('Timer fired')).length;
    assert.equal(p.finished(), 0);
    await h.advance(4999);
    assert.equal(h.logs.filter(l => l.includes('Timer fired')).length, checksAtDeadline);
    await h.advance(25001);
    assert.equal(p.finished(), 1);
    assert.equal(h.timers.size, 0);
    assert.ok(h.logs.some(l => l.includes('Timer retry:') && l.includes('cloud unavailable')));
    assert.ok(h.logs.some(l => l.includes('Timer advancing: device end verification grace expired')));
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

for (const probe of ['deadline', 'tail']) {
  for (const speed of [0.5, 1, 2]) {
    test(`sampled loop past three seconds is detected by ${probe} after fractional deferral at speed ${speed}`, async () => {
      await withClock(async h => {
        const seek = 30;
        const duration = 174.322;
        let state = { status: 1, position: duration - 0.162, duration, hasPosition: true, sampledAt: Date.now() };
        const p = player(async () => state, { duration: duration * speed + seek, seek, speed });
        p.manager.startCheckTimer(0.1);
        await h.advance(100);
        assert.equal(p.finished(), 0);
        await h.advance(162);
        assert.equal(p.finished(), 0, 'a frozen fractional tail is not evidence of completion');
        await h.advance(5000);
        state = { ...state, position: 7.501, sampledAt: Date.now() };
        if (probe === 'deadline') await p.manager.verifyTimerDeadline();
        else await p.manager.tailProbe();
        assert.equal(p.finished(), 1, 'fresh tail-to-start rewind must not wait thirty seconds');
        assert.equal(h.timers.size, 0);
      });
    });
  }
}

for (const signal of ['cached', 'foreign', 'missing position', 'unknown status', 'mid-song', 'implausible rewind', 'long gap']) {
  test(`sampled loop rejects ${signal} evidence`, async () => {
    await withClock(async h => {
      let state = { ...playing(signal === 'mid-song' ? 280 : 299.8), sampledAt: Date.now() };
      const p = player(async () => state);
      p.manager.startCheckTimer(0.1);
      await h.advance(100);
      await h.advance(200);
      // Cancel scheduled probes to isolate the next observation without changing its generation.
      for (const id of h.timers.keys()) clearTimeout(id);
      await h.advance(signal === 'long gap' ? 20000 : 6000);
      state = {
        ...state, position: signal === 'implausible rewind' ? 80 : 7,
        duration: signal === 'foreign' ? 900 : 300,
        status: signal === 'unknown status' ? -1 : 1,
        hasPosition: signal !== 'missing position',
        sampledAt: signal === 'cached' ? state.sampledAt : Date.now(),
      };
      await p.manager.verifyTimerDeadline();
      assert.equal(p.finished(), 0);
      p.manager.cleanup();
      assert.equal(h.timers.size, 0);
    });
  });
}

for (const probe of ['deadline', 'tail']) {
  test(`a tail idle report does not discard loop evidence for the following ${probe} rewind`, async () => {
    await withClock(async h => {
      let state = { status: 1, position: 299.8, duration: 300, hasPosition: true, sampledAt: Date.now() };
      const p = player(async () => state);
      const sample = () => probe === 'deadline' ? p.manager.verifyTimerDeadline() : p.manager.tailProbe();

      await sample();
      assert.equal(p.finished(), 0);
      assert.ok(p.manager.tailLoopSample, 'the near-tail playing sample establishes the loop baseline');
      for (const id of h.timers.keys()) clearTimeout(id);

      // 自然播完时设备常在尾部先报一次 idle，随后重拉同一 URL 从流开头续播。
      await h.advance(2000);
      state = { status: 2, position: 299.8, duration: 300, hasPosition: true, sampledAt: Date.now() };
      await sample();
      assert.equal(p.finished(), 0, 'a single idle report at the tail is not ending evidence');
      const baselineKept = !!p.manager.tailLoopSample;
      for (const id of h.timers.keys()) clearTimeout(id);

      await h.advance(5000);
      state = { status: 1, position: 6.99, duration: 300, hasPosition: true, sampledAt: Date.now() };
      await sample();
      assert.equal(p.finished(), 1, 'the re-pulled stream must be recognized without the thirty-second grace');
      assert.ok(baselineKept, 'an idle report must not discard the near-tail baseline');
      p.manager.stopCheckTimer();
    });
  });
}

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
