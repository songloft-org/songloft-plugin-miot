import assert from 'node:assert/strict';
import test from 'node:test';
import { loader, flush, deferred } from './chat_loader.mjs';
const load = loader();
const { DEFAULT_CHAT_CONFIG, validateChatConfig, chatConnection, chatScope } = load('../src/chat/types.ts');
const { ChatMemoryService } = load('../src/chat/memory.ts');
const { SpeechService, speechSegments } = load('../src/chat/speech.ts');
const { PlaybackCoordinator } = load('../src/playback/coordinator.ts');
const { AIChatService } = load('../src/chat/service.ts');
const { VoiceDispatcher } = load('../src/voicecmd/dispatcher.ts');
const { AIClient } = load('../src/ai/client.ts');
const { ConfigManager } = load('../src/config/manager.ts');
const originalSongloft = globalThis.songloft;
globalThis.songloft = { log: { info() { }, warn() { }, error() { } } };
test.after(() => { globalThis.songloft = originalSongloft; });
function storageHarness(t) {
  const previous = songloft.storage;
  const values = new Map();
  songloft.storage = { get: async (key) => values.get(key) ?? null, set: async (key, value) => { values.set(key, value); } };
  t.after(() => { songloft.storage = previous; });
  return values;
}
const cfg = { ...DEFAULT_CHAT_CONFIG, enabled: true, waiting_feedback: false, memory_enabled: false, context_turns: 12, summary_enabled: true };
const turn = (id, user = '你好', phase = 'completed') => ({ id, user, assistant: '你好！', phase, created_at: Date.now() });
test('chat defaults preserve old feature flags and analysis connection remains independent', () => {
  assert.equal(DEFAULT_CHAT_CONFIG.enabled, false);
  assert.deepEqual(chatConnection(cfg, { enabled: false, api_url: 'https://a/v1', api_key: 'secret', model: 'analysis', timeout: 6 }), { enabled: true, api_protocol: 'chat_completions', api_url: 'https://a/v1', api_key: 'secret', model: 'analysis', timeout: 30 });
  assert.equal(chatConnection({ ...cfg, model: 'chat' }, { model: 'analysis' }).model, 'chat');
  for (const bad of [{ timeout: 31 }, { timeout: NaN }, { followup_seconds: -1 }, { enabled: 'true' }, { trigger_words: [''] }, { connection: 'bad' }, { api_url: 'file:///tmp/a' }, { system_prompt: '' }])
    assert.throws(() => validateChatConfig(bad));
});
test('chat config concurrent partial writes are serialized and corrupt data is preserved', async (t) => {
  const values = storageHarness(t), manager = new ConfigManager();
  await Promise.all([manager.saveChatConfig({ enabled: true }), manager.saveChatConfig({ model: 'separate' })]);
  const value = await manager.getChatConfig();
  assert.equal(value.enabled, true);
  assert.equal(value.model, 'separate');
  values.set('chat_config:v1', '{broken');
  await assert.rejects(manager.getChatConfig(), /损坏/);
  assert.equal(values.get('chat_config:v1'), '{broken');
});
test('memory keeps device scopes separate and serializes concurrent mutations', async (t) => {
  storageHarness(t);
  const memory = new ChatMemoryService();
  await Promise.all([memory.editMemory('a', '喜欢摇滚'), memory.editMemory('a', '住在上海'), memory.editMemory('b', '喜欢爵士')]);
  assert.equal((await memory.load('a')).memories.length, 2);
  assert.equal((await memory.load('b')).memories.length, 1);
});
test('clear, delete and manual edit reject stale background writes', async (t) => {
  storageHarness(t);
  const memory = new ChatMemoryService();
  await memory.saveTurn('a', turn('t1'), cfg);
  const old = await memory.load('a');
  await memory.clear('a', 'all');
  assert.equal(await memory.mutate('a', value => value.memories.push({ content: '旧偏好' }), old.revision), null);
  assert.equal((await memory.load('a')).history.length, 0);
  await memory.saveTurn('a', turn('t2'), cfg);
  await memory.mutate('a', value => { value.summary = '旧摘要'; value.summary_sources = ['t2']; value.memories = [{ id: 'm1', content: '喜欢摇滚', source_ids: ['t2'], manual: false, created_at: 1, updated_at: 1 }, { id: 'm2', content: '喜欢爵士', source_ids: ['t2'], manual: true, created_at: 1, updated_at: 1 }]; });
  await memory.removeTurn('a', 't2');
  const value = await memory.load('a');
  assert.equal(value.summary, '');
  assert.deepEqual(value.memories.map(m => m.id), ['m2']);
  await memory.updateTurn('a', turn('t2'));
  assert.equal((await memory.load('a')).history.length, 0);
});
test('context excludes cancelled turns, honors reset, and retrieves relevant preferences', async (t) => {
  storageHarness(t);
  const memory = new ChatMemoryService();
  await memory.saveTurn('a', turn('old'), cfg);
  await memory.saveTurn('a', turn('cancel', '不该进入上下文', 'cancelled'), cfg);
  await memory.editMemory('a', '我喜欢摇滚乐');
  let messages = memory.messages(await memory.load('a'), { ...cfg, memory_enabled: true }, '推荐摇滚');
  assert.ok(messages.some(m => m.content.includes('喜欢摇滚')));
  assert.ok(!messages.some(m => m.content.includes('不该进入上下文')));
  await memory.reset('a');
  messages = memory.messages(await memory.load('a'), cfg, '新问题');
  assert.deepEqual(messages.map(m => m.content), [cfg.system_prompt, '新问题']);
});
test('corrupt storage never gets overwritten', async (t) => {
  const values = storageHarness(t);
  values.set('chat:v1:a', 'broken');
  await assert.rejects(new ChatMemoryService().clear('a', 'all'), /损坏/);
  assert.equal(values.get('chat:v1:a'), 'broken');
});
test('history retention and request character budget stay bounded', async (t) => {
  storageHarness(t);
  const memory = new ChatMemoryService();
  for (let i = 0; i < 20; i++)
    await memory.saveTurn('a', { ...turn(String(i)), user: '问'.repeat(1000), assistant: '答'.repeat(1500) }, { ...cfg, history_limit: 12 });
  const value = await memory.load('a');
  assert.equal(value.history.length, 12);
  const messages = memory.messages(value, cfg, '现在');
  assert.ok(messages.slice(1, -1).reduce((sum, m) => sum + m.content.length, 0) <= 12000);
});
test('speech cleans formatting and uses bounded complete-answer segments', () => {
  assert.ok(speechSegments('# 标题\n[参考](https://a) ```js\nsecret()```').join('').includes('代码请查看'));
  const segments = speechSegments('答'.repeat(4000));
  assert.ok(segments.every(s => s.length <= 200));
  assert.ok(segments.join('').length <= 1200);
  assert.ok(segments.join('').includes('完整回答'));
});
test('speech requires protection interval and two fresh idle samples', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10000 });
  const sends = [], token = { account: 'a', device: 'd', isCurrent: () => true };
  const speech = new SpeechService({ textToSpeech: async (...args) => { sends.push(args); return true; }, getPlayState: async () => ({ status: 0, sampledAt: Date.now() }) });
  let result;
  const pending = speech.speak('你好', token).then(value => { result = value; });
  await flush();
  for (let i = 0; i < 3; i++) {
    t.mock.timers.tick(1000);
    await flush();
  }
  assert.equal(result, undefined);
  t.mock.timers.tick(1000);
  await flush();
  await pending;
  assert.equal(result, 'completed');
  assert.equal(sends.length, 1);
});
test('speech timeout on cached or unknown state never reports completed', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10000 });
  const speech = new SpeechService({ textToSpeech: async () => true, getPlayState: async () => ({ status: 0, sampledAt: 10000 }) });
  const pending = speech.speak('你好', { account: 'a', device: 'd', isCurrent: () => true });
  await flush();
  for (let i = 0; i < 90; i++) {
    t.mock.timers.tick(1000);
    await flush();
  }
  assert.equal(await pending, 'unknown');
});
test('cancelled speech does not send subsequent segments', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10000 });
  let current = true, count = 0;
  const speech = new SpeechService({ textToSpeech: async () => { count++; return true; }, getPlayState: async () => ({ status: 0, sampledAt: Date.now() }) });
  const pending = speech.speak('答'.repeat(400), { account: 'a', device: 'd', isCurrent: () => current });
  await flush();
  current = false;
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(await pending, 'cancelled');
  assert.equal(count, 1);
});
function playbackHarness(group = false) {
  const calls = [];
  let revision = 1, guard;
  const manager = {
    getPosition: () => 37, getPlaybackRevision: () => revision, isPlaying: () => true, isExternalPlayback: () => false,
    setInteractionGuard: value => {
      guard = value;
      return () => {
        if (guard === value)
          guard = undefined;
      };
    }, cancelHourlyResume() { }, suspendForVoiceInteraction() { revision++; },
    replayCurrent: async (position, current) => { revision++; calls.push(['resume', position]); assert.equal(current(), true); return true; },
    holdAfterInteraction: async (position) => { calls.push(['hold', position]); }
  };
  let onControl;
  const devices = { setOnControl: fn => { onControl = fn; }, stopForInteraction: async (account, device) => { calls.push(['stop', device]); return 'stopped'; }, interruptAnswer: async (account, device) => { calls.push(['interrupt', device]); return { status: 'accepted' }; } };
  const config = { findDeviceGroup: async () => group ? { members: [{ account_id: 'a', device_id: 'd' }, { account_id: 'a', device_id: 'e' }] } : null };
  const playback = new PlaybackCoordinator({ get: () => manager }, devices, config);
  return { calls, manager, playback, control: (device = 'd') => onControl('a', device), invalidate: () => guard?.() };
}
test('group pauses each member once and restores shared queue at original position', async () => {
  const h = playbackHarness(true), token = h.playback.token('t', 'a', 'd');
  await h.playback.prepare(token);
  assert.equal(token.isCurrent(), true);
  await h.playback.finish(token, true);
  assert.deepEqual(h.calls, [['interrupt', 'd'], ['stop', 'e'], ['resume', 37]]);
});
test('group member new operation and DLNA invalidation prevent old recovery', async () => {
  for (const method of ['control', 'invalidate']) {
    const h = playbackHarness(true), token = h.playback.token('t', 'a', 'd');
    await h.playback.prepare(token);
    h[method]('e');
    await h.playback.finish(token, true);
    assert.ok(!h.calls.some(c => c[0] === 'resume'));
    assert.equal(token.isCurrent(), false);
  }
});
test('unknown speech preserves music pause and DLNA rejects chat takeover', async () => {
  const h = playbackHarness(), token = h.playback.token('t', 'a', 'd');
  await h.playback.prepare(token);
  await h.playback.finish(token, false);
  assert.ok(h.calls.some(c => c[0] === 'hold'));
  h.manager.isExternalPlayback = () => true;
  await assert.rejects(h.playback.prepare(h.playback.token('new', 'a', 'd')), /DLNA/);
});
function chatHarness() {
  const tokens = new Set();
  const playback = {
    token(id, account, device) { this.invalidate(account, device); const token = { id, account, device, active: true, isCurrent: () => token.active }; tokens.add(token); return token; },
    invalidate(account, device) {
      for (const token of tokens)
        if (!account || (token.account === account && token.device === device)) {
          token.active = false;
          token.onCancel?.();
          tokens.delete(token);
        }
    },
    prepare: async () => { }, release(token) { token.active = false; tokens.delete(token); }, finish: async (token) => { token.active = false; tokens.delete(token); }, close() { this.invalidate(); }
  };
  const chat = new AIChatService({ getChatConfig: async () => cfg, getAIConfig: async () => ({ api_url: 'https://a/v1', api_key: 'secret', model: 'm' }) }, playback, { speak: async () => 'completed', stop: async () => { } });
  return { chat, playback };
}
test('async chat stores successful answer and includes it in next question', async (t) => {
  storageHarness(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { chat } = chatHarness(), contexts = [];
  chat.client.request = async (_config, messages) => { contexts.push(messages); return '第一轮答案'; };
  await chat.submit('a', 'd', '问题一', false);
  t.mock.timers.tick(0);
  await flush();
  assert.equal(chat.status('a', 'd').phase, 'completed');
  await chat.submit('a', 'd', '问题二', false);
  t.mock.timers.tick(0);
  await flush();
  assert.ok(contexts[1].some(m => m.role === 'assistant' && m.content === '第一轮答案'));
  chat.close();
});
test('late answer after new question or clear cannot overwrite current task/history', async (t) => {
  storageHarness(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { chat } = chatHarness(), old = deferred();
  let requests = 0;
  chat.client.request = async () => ++requests === 1 ? old.promise : '新答案';
  await chat.submit('a', 'd', '旧问题', false);
  t.mock.timers.tick(0);
  await flush();
  await chat.submit('a', 'd', '新问题', false);
  t.mock.timers.tick(0);
  await flush();
  old.resolve('迟到答案');
  await flush();
  assert.equal(chat.status('a', 'd').phase, 'completed');
  const value = await chat.memory.load(chatScope('a', 'd'));
  assert.equal(value.history.find(t => t.user === '旧问题').phase, 'cancelled');
  assert.equal(value.history.find(t => t.user === '新问题').assistant, '新答案');
  await chat.clear('a', 'd', 'all');
  assert.equal((await chat.memory.load(chatScope('a', 'd'))).history.length, 0);
  chat.close();
});
test('explicit chat bypasses music analysis, unmatched music fails without becoming chat', async () => {
  const calls = [], music = { cancelPendingResume() { }, hasFixedControl: async () => false, handleMessage: async () => { calls.push('music'); return true; }, resumeUnmatched() { } };
  const chat = { status: () => ({ phase: 'completed', followup_until: 0 }), cancel: async () => { }, submit: async (_a, _d, text) => { calls.push(text); } };
  const dispatcher = new VoiceDispatcher({ getChatConfig: async () => ({ ...cfg, fallback_enabled: true }) }, music, chat, { invalidate() { } });
  const message = text => ({ account_id: 'a', device_id: 'd', message: { request_id: text, timestamp_ms: 1, response: { answer: [{ question: text }] } } });
  dispatcher.submit(message('请问地球为什么是圆的'));
  await flush();
  assert.deepEqual(calls, ['地球为什么是圆的']);
  calls.length = 0;
  dispatcher.submit(message('播放找不到的歌'));
  await flush();
  assert.deepEqual(calls, ['music']);
  dispatcher.close();
});
test('message submission remains responsive, de-duplicates, and rejects stale music analysis', async () => {
  const wait = deferred(), calls = [];
  const music = {
    cancelPendingResume() { }, hasFixedControl: async () => false, handleMessage: async (_m, options) => {
      await wait.promise;
      if (options.current())
        calls.push('music');
      return false;
    }, resumeUnmatched() { }
  };
  const chat = { status: () => ({ phase: 'completed', followup_until: 0 }), cancel: async () => { }, submit: async (_a, _d, text) => calls.push(text) };
  const dispatcher = new VoiceDispatcher({ getChatConfig: async () => cfg }, music, chat, { invalidate() { } });
  const message = (id, text) => ({ account_id: 'a', device_id: 'd', message: { request_id: id, timestamp_ms: 1, response: { answer: [{ question: text }] } } });
  dispatcher.submit(message('old', '普通问题'));
  await flush();
  dispatcher.submit(message('new', '请问新问题'));
  dispatcher.submit(message('new', '请问新问题'));
  await flush();
  wait.resolve();
  await flush();
  assert.deepEqual(calls, ['新问题']);
  dispatcher.close();
});
test('AI queue keeps latest question per scope and permits another device', async (t) => {
  const first = deferred(), calls = [];
  let oldCurrent = true;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const text = JSON.parse(options.body).messages[0].content;
    calls.push(text);
    if (text === 'first')
      await first.promise;
    return Response.json({ choices: [{ message: { content: text } }] });
  });
  const client = new AIClient(), config = { api_url: 'https://a/v1', api_key: 'secret', model: 'm', timeout: 30 };
  const ask = (text, scope, current = () => true) => client.request(config, [{ role: 'user', content: text }], 'chat', current, scope);
  const pending = ask('first', 'a');
  await flush();
  const stale = ask('stale', 'a', () => oldCurrent);
  const rejected = assert.rejects(stale, /取消/);
  const latest = ask('latest', 'a');
  oldCurrent = false;
  const other = ask('other', 'b');
  await flush();
  assert.ok(calls.includes('other'));
  assert.ok(!calls.includes('latest'));
  first.resolve();
  await Promise.all([pending, latest, other, rejected]);
  assert.ok(!calls.includes('stale'));
});
test('summary survives extraction failure and clearing rejects delayed extraction', async (t) => {
  storageHarness(t);
  const { chat } = chatHarness();
  const scope = chatScope('a', 'd');
  for (let i = 0; i < 8; i++)
    await chat.memory.saveTurn(scope, turn(String(i)), cfg);
  chat.client.request = async (_config, _messages, kind) => {
    if (kind === 'summary')
      return '可靠摘要';
    throw new Error('extraction unavailable');
  };
  await chat.maintain(scope, { ...cfg, memory_enabled: true });
  assert.equal((await chat.memory.load(scope)).summary, '可靠摘要');
  const late = deferred();
  chat.client.request = async () => late.promise;
  const pending = chat.maintain(scope, { ...cfg, memory_enabled: true });
  await flush();
  await chat.clear('a', 'd', 'all');
  late.resolve('["旧偏好"]');
  await pending;
  assert.equal((await chat.memory.load(scope)).memories.length, 0);
  chat.close();
});
test('recovery failure becomes a terminal failure instead of remaining resuming', async (t) => {
  storageHarness(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { chat, playback } = chatHarness();
  chat.client.request = async () => '回答';
  playback.finish = async (token) => { token.active = false; throw new Error('恢复失败'); };
  await chat.submit('a', 'd', '问题', false);
  t.mock.timers.tick(0);
  await flush();
  assert.equal(chat.status('a', 'd').phase, 'failed');
  assert.match(chat.status('a', 'd').error, /恢复失败/);
  chat.close();
});
test('guarded music cannot push a stale search result or overwrite manager state', async () => {
  const { guardedPlayers, guardedDevices } = load('../src/music/guards.ts');
  let current = true, pushes = 0;
  const manager = { state: 0, playWithSongs: async function() { this.state++; pushes++; return true; } };
  const players = guardedPlayers({ get: () => manager, getOrCreate: async () => manager }, () => current);
  const guarded = await players.getOrCreate('a', 'd');
  await guarded.playWithSongs([], 0, 'order');
  assert.equal(manager.state, 1);
  current = false;
  assert.throws(() => guarded.playWithSongs([], 0, 'order'), /取消/);
  assert.equal(pushes, 1);
  const devices = guardedDevices({ textToSpeech: async () => { pushes++; } }, () => current);
  assert.throws(() => devices.textToSpeech('a', 'd', '旧答案'), /取消/);
  assert.equal(pushes, 1);
});
test('delayed old group resolution cannot cancel a newer question', async () => {
  const h = playbackHarness(true), oldGroup = deferred(), newGroup = deferred();
  h.playback.config.findDeviceGroup = async (_account, device) => device === 'd' ? oldGroup.promise : newGroup.promise;
  const older = h.playback.token('older', 'a', 'd'), newer = h.playback.token('newer', 'a', 'e');
  const first = h.playback.prepare(older), second = h.playback.prepare(newer);
  const group = { members: [{ account_id: 'a', device_id: 'd' }, { account_id: 'a', device_id: 'e' }] };
  oldGroup.resolve(group);
  await first;
  assert.equal(older.isCurrent(), false);
  assert.equal(newer.isCurrent(), true);
  newGroup.resolve(group);
  await second;
  assert.equal(newer.isCurrent(), true);
  await h.playback.finish(newer, false);
});
test('old recovery completion cannot remove the next interaction guard', async () => {
  const h = playbackHarness(), wait = deferred();
  h.manager.replayCurrent = async () => { await wait.promise; return true; };
  const older = h.playback.token('old', 'a', 'd');
  await h.playback.prepare(older);
  const finishing = h.playback.finish(older, true);
  const newer = h.playback.token('new', 'a', 'd');
  await h.playback.prepare(newer);
  wait.resolve();
  await finishing;
  h.invalidate();
  assert.equal(newer.isCurrent(), false);
  assert.equal(h.playback.busyReason(), '');
});
test('same-millisecond reset retains the first new completed turn in context', async (t) => {
  storageHarness(t);
  t.mock.method(Date, 'now', () => 100000);
  const memory = new ChatMemoryService();
  await memory.reset('s');
  const next = turn('new', '新会话问题', 'queued');
  await memory.saveTurn('s', next, cfg);
  await memory.updateTurn('s', { ...next, phase: 'completed' });
  assert.ok(memory.messages(await memory.load('s'), cfg, '追问').some(m => m.content === '新会话问题'));
});
test('clear and manual deletion are respected by subsequent memory maintenance', async (t) => {
  storageHarness(t);
  const { chat } = chatHarness(), scope = chatScope('a', 'd');
  const config = { ...cfg, memory_enabled: true };
  await chat.memory.saveTurn(scope, turn('old', '我喜欢摇滚'), cfg);
  chat.client.request = async () => '["喜欢摇滚"]';
  await chat.maintain(scope, config);
  let value = await chat.memory.load(scope);
  await chat.memory.removeMemory(scope, value.memories[0].id);
  await chat.maintain(scope, config);
  assert.equal((await chat.memory.load(scope)).memories.length, 0);
  await chat.memory.saveTurn(scope, turn('new', '我喜欢爵士'), cfg);
  await chat.memory.clear(scope, 'memory');
  await chat.maintain(scope, config);
  assert.equal((await chat.memory.load(scope)).memories.length, 0);
  chat.close();
});
test('memory maintenance processes every completed turn once, including coalesced turns', async (t) => {
  storageHarness(t);
  const { chat } = chatHarness(), scope = chatScope('a', 'd'), calls = [];
  await chat.memory.saveTurn(scope, turn('one', '喜欢摇滚'), cfg);
  await chat.memory.saveTurn(scope, turn('two', '住在上海'), cfg);
  chat.client.request = async (_config, messages) => { calls.push(messages[1].content); return JSON.stringify([messages[1].content]); };
  await chat.maintain(scope, { ...cfg, memory_enabled: true });
  await chat.maintain(scope, { ...cfg, memory_enabled: true });
  assert.deepEqual(calls, ['喜欢摇滚', '住在上海']);
  assert.deepEqual((await chat.memory.load(scope)).memories.map(m => m.source_ids), [['one'], ['two']]);
  chat.close();
});
test('revision change during generation terminates and releases the interaction', async (t) => {
  storageHarness(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = playbackHarness(), wait = deferred();
  const chat = new AIChatService({ getChatConfig: async () => cfg, getAIConfig: async () => ({ api_url: 'https://a', api_key: 'k', model: 'm' }) }, h.playback, { speak: async () => 'completed', stop: async () => { } });
  chat.client.request = async () => wait.promise;
  await chat.submit('a', 'd', '问题');
  t.mock.timers.tick(0);
  await flush();
  h.manager.suspendForVoiceInteraction();
  wait.resolve('旧回答');
  await flush();
  assert.equal(chat.status('a', 'd').phase, 'cancelled');
  assert.equal(chat.busyReason(), '');
  chat.close();
});
test('routing into a non-playback music command releases the old chat lease', async (t) => {
  storageHarness(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = playbackHarness(), wait = deferred();
  const chat = new AIChatService({ getChatConfig: async () => cfg, getAIConfig: async () => ({ api_url: 'https://a', api_key: 'k', model: 'm' }) }, h.playback, { speak: async () => 'completed', stop: async () => { } });
  chat.client.request = async () => wait.promise;
  await chat.submit('a', 'd', '旧问题');
  t.mock.timers.tick(0);
  await flush();
  const music = { cancelPendingResume() { }, hasFixedControl: async () => false, handleMessage: async () => true, resumeUnmatched() { } };
  const dispatcher = new VoiceDispatcher({ getChatConfig: async () => cfg }, music, chat, h.playback);
  dispatcher.submit({ account_id: 'a', device_id: 'd', message: { request_id: 'next', response: { answer: [{ question: '收藏歌曲' }] } } });
  await flush();
  assert.equal(chat.busyReason(), '');
  assert.ok(h.calls.some(c => c[0] === 'hold'));
  wait.resolve('旧回答');
  await flush();
  dispatcher.close();
  chat.close();
});
test('corrupt optional chat configuration does not disable existing music commands', async () => {
  const calls = [];
  const music = { cancelPendingResume() { }, hasFixedControl: async () => false, handleMessage: async () => { calls.push('music'); return true; }, resumeUnmatched() { } };
  const chat = { status: () => ({ phase: 'completed' }), cancel: async () => { }, interruptForRouting: async () => { } };
  const dispatcher = new VoiceDispatcher({ getChatConfig: async () => { throw new Error('损坏'); } }, music, chat, { invalidate() { } });
  dispatcher.submit({ account_id: 'a', device_id: 'd', message: { request_id: 'm', response: { answer: [{ question: '播放音乐' }] } } });
  await flush();
  assert.deepEqual(calls, ['music']);
  dispatcher.close();
});
test('a group member can cancel and release the other speaker chat', async (t) => {
  storageHarness(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = playbackHarness(true), wait = deferred();
  const chat = new AIChatService({ getChatConfig: async () => cfg, getAIConfig: async () => ({ api_url: 'https://a', api_key: 'k', model: 'm' }) }, h.playback, { speak: async () => 'completed', stop: async () => { } });
  chat.client.request = async () => wait.promise;
  await chat.submit('a', 'd', '问题');
  t.mock.timers.tick(0);
  await flush();
  await chat.cancel('a', 'e');
  assert.equal(chat.status('a', 'd').phase, 'cancelled');
  assert.equal(chat.busyReason(), '');
  assert.ok(h.calls.some(c => c[0] === 'hold'));
  wait.resolve('迟到回答');
  await flush();
  chat.close();
});
test('paused music remains paused after speech but manual resume must replace the TTS context', async () => {
  const h = playbackHarness();
  h.manager.isPlaying = () => false;
  h.manager.getStatus = () => ({ state: 'paused' });
  const token = h.playback.token('paused', 'a', 'd');
  await h.playback.prepare(token);
  await h.playback.finish(token, true);
  assert.deepEqual(h.calls, [['interrupt', 'd'], ['hold', 37]]);
});
test('sleep expiry uses the shared primary and never stops a replacement group manager', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { SleepTimerService } = load('../src/playback/sleep_timer.ts');
  let stops = 0;
  const original = { getPrimary: () => ({ account_id: 'a', device_id: 'd' }), setOnAdvanceHook() { }, stop: async () => { stops++; } };
  let manager = original;
  const timers = new SleepTimerService({ get: () => manager }, {});
  timers.set('a', 'e', 'time', 1);
  manager = { ...original };
  t.mock.timers.tick(60000);
  await flush();
  assert.equal(stops, 0);
  timers.set('a', 'e', 'time', 1);
  t.mock.timers.tick(60000);
  await flush();
  assert.equal(stops, 1);
  timers.close();
});
