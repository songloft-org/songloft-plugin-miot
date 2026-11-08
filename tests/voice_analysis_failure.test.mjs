import assert from 'node:assert/strict';
import test from 'node:test';
import { loader, flush, deferred } from './chat_loader.mjs';

const load = loader({
  '../config/manager': {}, '../account/manager': {}, '../service/service': {},
  '../player/manager': {}, '../indexing/manager': {}, '../group/coordinator': {},
  '../player/url_builder': {}, '../handlers/playlist': {}, '../utils/http': {},
  '../utils/favorites': {}, '../memory': {},
});
const { MusicCommandService } = load('../src/music/service.ts');
const { AIAnalyzer } = load('../src/voicecmd/ai_analyzer.ts');
const { VoiceDispatcher } = load('../src/voicecmd/dispatcher.ts');
const { DEFAULT_CHAT_CONFIG } = load('../src/chat/types.ts');
const { getDefaultVoiceCommands } = load('../src/voicecmd/defaults.ts');
const message = {
  account_id: 'account', device_id: 'speaker',
  message: { response: { answer: [{ question: '来点适合现在听的音乐' }] } },
};

function fixture(t, { chat = {}, active = {}, ttsError = false, playing = false, ai = {} } = {}) {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('network unavailable'); });
  const previous = globalThis.songloft;
  globalThis.songloft = { log: { info() { }, warn() { }, error() { } } };
  t.after(() => { globalThis.songloft = previous; });
  const speech = [], events = [];
  const engine = Object.create(MusicCommandService.prototype);
  engine.enabled = true;
  engine.voiceResume = { cancel() { }, schedule: () => events.push('resume') };
  engine.sleepTimerService = {};
  engine.memoryService = { setMaxRecords: async () => { } };
  const config = { ...DEFAULT_CHAT_CONFIG, ...chat };
  engine.configManager = {
    getConfig: async () => ({ voice_memory_enabled: false }),
    getAIConfig: async () => ({ enabled: true, api_url: 'https://model.test/v1', api_key: 'fixture', model: 'fixture', timeout: 15, ...ai }),
    getChatConfig: async () => config,
    getVoiceCommands: async () => [],
  };
  engine.playlistManagerMap = {
    cancelHourlyResumes() { },
    get: () => ({ isPlaying: () => playing, suspendForVoiceInteraction: () => events.push('suspend') }),
  };
  engine.minaService = {
    textToSpeech: async (_account, _device, text, current) => {
      assert.notEqual(current?.(), false);
      speech.push(text);
      if (ttsError) throw new Error('TTS unavailable');
    }
  };
  engine.aiAnalyzer = new AIAnalyzer();
  const dispatcher = new VoiceDispatcher(engine.configManager, engine, {
    status: () => ({ phase: 'idle', followup_until: 0, ...active }),
    cancel: async () => { },
    submit: async () => events.push('chat'),
  }, { invalidate() { } });
  return { engine, dispatcher, speech, events };
}

for (const [question, intent] of [
  ['播放歌曲请问你是谁', '请问你是谁'],
  ['  ', '播放歌曲请问你是谁'],
]) {
  test(`dispatcher and music rules use the same query for local song requests: ${JSON.stringify(question)}`, async t => {
    const f = fixture(t, { chat: { enabled: true } });
    f.engine.configManager.getVoiceCommands = async () => getDefaultVoiceCommands();
    f.engine.executePlaySong = async (name, account, device) => { f.events.push(['play', name, account, device]); };
    f.dispatcher.submit({ ...message, message: {
      response: { answer: [{ question, intention: { query: intent } }] },
    } });
    await flush();
    assert.deepEqual(f.events, [['play', '请问你是谁', 'account', 'speaker']]);
    assert.deepEqual(f.speech, []);
  });
}

for (const failure of ['timeout', 'network', 'malformed', 'empty']) {
  test(`AI ${failure} gives one retry hint through the real dispatcher`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture(t, { playing: true });
    if (failure === 'timeout') t.mock.method(globalThis, 'fetch', () => new Promise(() => { }));
    if (failure === 'malformed') t.mock.method(globalThis, 'fetch', async () => Response.json({ choices: [{ message: { content: 'invalid' } }] }));
    if (failure === 'empty') t.mock.method(globalThis, 'fetch', async () => Response.json({ choices: [] }));
    const pending = f.dispatcher.dispatch(message, '来点适合现在听的音乐', () => true);
    await flush();
    if (failure === 'timeout') {
      assert.deepEqual(f.speech, []);
      t.mock.timers.tick(15000);
    }
    await pending;
    assert.equal(f.speech.length, 1);
    assert.match(f.speech[0], /再说|重试|换个说法/);
    assert.deepEqual(f.events, ['suspend', 'resume']);
  });
}

test('legacy direct message path also hints and preserves smart resume', async t => {
  const f = fixture(t, { playing: true });
  assert.equal(await f.engine.handleMessage(message), false);
  assert.equal(f.speech.length, 1);
  assert.deepEqual(f.events, ['suspend', 'resume']);
});

for (const [name, chat, active] of [
  ['fallback', { enabled: true, fallback_enabled: true }, {}],
  ['followup', { enabled: true, followup_enabled: true }, { followup_until: Date.now() + 60000 }],
  ['answer in progress with fallback', { enabled: true, fallback_enabled: true }, { phase: 'speaking' }],
]) {
  test(`AI failure hands off to chat without a duplicate hint: ${name}`, async t => {
    const f = fixture(t, { chat, active });
    await f.dispatcher.dispatch(message, '来点适合现在听的音乐', () => true);
    assert.deepEqual(f.speech, []);
    assert.deepEqual(f.events, ['chat']);
  });
}

test('TTS failure still reaches smart resume', async t => {
  const f = fixture(t, { playing: true, ttsError: true });
  await f.dispatcher.dispatch(message, '来点适合现在听的音乐', () => true);
  assert.equal(f.speech.length, 1);
  assert.deepEqual(f.events, ['suspend', 'resume']);
});

test('cancelled AI failure sends no stale hint or resume', async t => {
  const f = fixture(t, { playing: true });
  const response = deferred();
  t.mock.method(globalThis, 'fetch', () => response.promise);
  let current = true;
  const pending = f.dispatcher.dispatch(message, '来点适合现在听的音乐', () => current);
  await flush();
  current = false;
  response.reject(new Error('late failure'));
  await pending;
  assert.deepEqual(f.speech, []);
  assert.deepEqual(f.events, []);
});

test('followup expiry during analysis still produces a failure hint', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10000 });
  const f = fixture(t, { chat: { enabled: true, followup_enabled: true }, active: { followup_until: 11000 } });
  const response = deferred();
  t.mock.method(globalThis, 'fetch', () => response.promise);
  const pending = f.dispatcher.dispatch(message, '来点适合现在听的音乐', () => true);
  await flush();
  t.mock.timers.tick(2000);
  response.reject(new Error('late failure'));
  await pending;
  assert.equal(f.speech.length, 1);
  assert.deepEqual(f.events, []);
});

test('cancellation during failure speech cannot schedule stale recovery', async t => {
  const f = fixture(t, { playing: true });
  const speechDone = deferred();
  f.engine.minaService.textToSpeech = async () => { f.speech.push('hint'); return speechDone.promise; };
  let current = true;
  const pending = f.dispatcher.dispatch(message, '来点适合现在听的音乐', () => current);
  await flush();
  assert.equal(f.speech.length, 1);
  current = false;
  speechDone.resolve(true);
  await pending;
  assert.deepEqual(f.events, []);
});

for (const analysis of [null, { action: 'unknown', confidence: 'low', params: {} }]) {
  test(`disabled analysis or unknown intent keeps passive unmatched behavior: ${JSON.stringify(analysis)}`, async t => {
    const f = fixture(t);
    if (analysis) f.engine.aiAnalyzer.analyze = async () => analysis;
    else f.engine.configManager.getAIConfig = async () => ({ enabled: false });
    await f.dispatcher.dispatch(message, '来点适合现在听的音乐', () => true);
    assert.deepEqual(f.speech, []);
  });
}

function conversation(question) {
  return { ...message, message: { response: { answer: [{ question }] } } };
}

for (const failure of ['timeout', 'network', 'malformed', 'empty']) {
  for (const query of ['打开客厅灯', '关灯', '现在几点啦', '今天天气怎么样', '准备睡觉', '把空调调到二十六度']) {
    for (const entry of ['dispatcher', 'legacy']) {
      test(`${entry}: AI ${failure} leaves XiaoAI request silent: ${query}`, async t => {
        t.mock.timers.enable({ apis: ['setTimeout'] });
        const f = fixture(t, { playing: true });
        if (failure === 'timeout') t.mock.method(globalThis, 'fetch', () => new Promise(() => { }));
        if (failure === 'malformed') t.mock.method(globalThis, 'fetch', async () => Response.json({ choices: [{ message: { content: 'invalid' } }] }));
        if (failure === 'empty') t.mock.method(globalThis, 'fetch', async () => Response.json({ choices: [] }));
        const msg = conversation(query);
        const pending = entry === 'dispatcher'
          ? f.dispatcher.dispatch(msg, query, () => true)
          : f.engine.handleMessage(msg);
        await flush();
        if (failure === 'timeout') t.mock.timers.tick(15000);
        await pending;
        assert.deepEqual(f.speech, []);
        assert.deepEqual(f.events, ['suspend', 'resume']);
      });
    }
  }
}

for (const query of ['来点适合现在听的音乐', '来一首晴天', '放几首周杰伦的歌', '听两首轻松的歌', '播放周杰伦的歌曲', '放个轻松的歌单', '播放刘德华', '播放山峰山峰等等我男生合唱版']) {
  test(`explicit music request keeps the AI failure hint: ${query}`, async t => {
    const f = fixture(t);
    await f.dispatcher.dispatch(conversation(query), query, () => true);
    assert.equal(f.speech.length, 1);
    assert.deepEqual(f.events, []);
  });
}

for (const ai of [{ api_url: '' }, { api_key: '' }]) {
  test(`incomplete AI connection does not claim recognition failure: ${JSON.stringify(ai)}`, async t => {
    const f = fixture(t, { ai, playing: true });
    const requests = [];
    t.mock.method(globalThis, 'fetch', async (...args) => { requests.push(args); throw new Error('unexpected request'); });
    await f.dispatcher.dispatch(message, '来点适合现在听的音乐', () => true);
    assert.deepEqual(requests, []);
    assert.deepEqual(f.speech, []);
    assert.deepEqual(f.events, ['suspend', 'resume']);
  });
}

test('unmatched XiaoAI request without music playing stays silent and idle', async t => {
  const f = fixture(t);
  await f.dispatcher.dispatch(conversation('几点啦'), '几点啦', () => true);
  assert.deepEqual(f.speech, []);
  assert.deepEqual(f.events, []);
});

test('ambiguous input stays silent on AI failure but still permits successful AI music analysis', async t => {
  const f = fixture(t);
  const msg = conversation('晴天');
  await f.dispatcher.dispatch(msg, '晴天', () => true);
  assert.deepEqual(f.speech, []);
  const executed = [];
  f.engine.executeAIResult = async result => { executed.push(result); };
  const result = { action: 'play_song', params: { name: '晴天' }, confidence: 'high' };
  t.mock.method(globalThis, 'fetch', async () => Response.json({ choices: [{ message: { content: JSON.stringify(result) } }] }));
  await f.dispatcher.dispatch(msg, '晴天', () => true);
  assert.equal(executed.length, 1);
  assert.equal(executed[0].action, 'play_song');
  assert.deepEqual(executed[0].params, { name: '晴天' });
  assert.deepEqual(f.speech, []);
});

for (const [name, chat, active] of [
  ['fallback', { enabled: true, fallback_enabled: true }, {}],
  ['followup', { enabled: true, followup_enabled: true }, { followup_until: Date.now() + 60000 }],
  ['answer in progress with fallback', { enabled: true, fallback_enabled: true }, { phase: 'speaking' }],
]) {
  test(`non-music request still reaches configured chat: ${name}`, async t => {
    const f = fixture(t, { chat, active });
    await f.dispatcher.dispatch(conversation('现在几点啦'), '现在几点啦', () => true);
    assert.deepEqual(f.speech, []);
    assert.deepEqual(f.events, ['chat']);
  });
}
