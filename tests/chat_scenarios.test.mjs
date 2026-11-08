import assert from 'node:assert/strict';
import test from 'node:test';
import { flush, deferred } from './chat_loader.mjs';
import { load, configOf, turnOf, chatOf, storageOf, chatScope, ChatMemoryService } from './chat_fixture.mjs';
const { VoiceDispatcher } = load('../src/voicecmd/dispatcher.ts');
const { SpeechService } = load('../src/chat/speech.ts');
const scope = chatScope('a', 'd');
const tick = async (t, milliseconds = 0) => { t.mock.timers.tick(milliseconds); await flush(); };
const controls = ['set_play_mode', 'favorite', 'next', 'previous', 'resume', 'stop', 'sleep_timer', 'cancel_sleep_timer', 'query_sleep_timer', 'play_index'];
function dispatcherOf(t, { config = {}, active = {}, fixed, handled = false, throwing = false } = {}) {
  storageOf(t);
  const calls = [];
  const music = {
    cancelPendingResume() { }, fixedControlType: async () => fixed, hasFixedControl: async () => false, syncVolumeOnly: async () => calls.push('volume'), handleMessage: async (_message, options) => {
      calls.push('music');
      assert.ok(options.deferResume);
      if (throwing)
        throw new Error('music failed');
      return handled;
    }, resumeUnmatched: () => calls.push('resume-native')
  };
  const chat = { status: () => ({ phase: 'completed', followup_until: 0, ...active }), cancel: async (...args) => calls.push(['cancel', ...args]), interruptForRouting: async () => { calls.push('interrupt'); return async () => calls.push('release'); }, submit: async (_account, _device, text) => calls.push(['chat', text]) };
  const dispatcher = new VoiceDispatcher({ getChatConfig: async () => configOf(config) }, music, chat, { invalidate() { } });
  t.after(() => dispatcher.close());
  return { dispatcher, calls, send(text, device = 'd', id = text) { dispatcher.submit({ account_id: 'a', device_id: device, message: { request_id: id, timestamp_ms: 1, response: { answer: [{ question: text }] } } }); } };
}
for (const type of controls) {
  test(`fixed ${type} takes priority over explicit chat and music analysis`, async (t) => {
    const h = dispatcherOf(t, { fixed: type, active: { phase: 'speaking' } });
    h.send('请问下一首');
    await flush();
    assert.deepEqual(h.calls, [['cancel', 'a', 'd', true, false], 'music']);
  });
}
for (const phrase of ['停止回答', '退出对话。', '结束对话！']) {
  test(`${phrase} cancels, closes followup, and requests safe recovery`, async (t) => {
    const h = dispatcherOf(t);
    h.send(phrase);
    await flush();
    assert.deepEqual(h.calls, [['cancel', 'a', 'd', true, true]]);
  });
}
for (const phase of ['queued', 'preparing', 'generating', 'speaking', 'resuming']) {
  test(`volume keeps ${phase} chat alive without submitting music or chat`, async (t) => {
    const h = dispatcherOf(t, { fixed: 'set_volume', active: { phase } });
    h.send('大声一点');
    await flush();
    assert.deepEqual(h.calls, ['volume']);
  });
}
for (const [name, config, active, expected] of [
  ['window open', { followup_enabled: true }, { followup_until: Date.now() + 60000 }, true], ['window expired', {}, { followup_until: 1 }, false],
  ['window disabled', {}, { followup_until: Date.now() + 60000 }, false],
  ['zero window', { followup_enabled: true, followup_seconds: 0 }, { followup_until: Date.now() + 60000 }, false],
  ...['queued', 'preparing', 'generating', 'speaking', 'resuming'].map(phase => [`in progress ${phase}`, { followup_enabled: true }, { phase }, false]),
  ['fallback', { fallback_enabled: true }, {}, true], ['default no fallback', {}, {}, false],
  ['chat disabled', { enabled: false, fallback_enabled: true }, { phase: 'speaking' }, false], ['during answering', {}, { phase: 'speaking' }, false],
]) {
  test(`unmatched routing: ${name}`, async (t) => {
    const h = dispatcherOf(t, { config, active });
    h.send('地球有多大');
    await flush();
    assert.deepEqual(h.calls, ['interrupt', 'music', expected ? ['chat', '地球有多大'] : 'resume-native', 'release']);
  });
}
test('trigger punctuation is removed, empty trigger has no side effects, disabled chat preserves music', async (t) => {
  const h = dispatcherOf(t);
  h.send('请问， 地球大小');
  await flush();
  assert.deepEqual(h.calls, [['chat', '地球大小']]);
  h.calls.length = 0;
  h.send('问一下： ');
  await flush();
  assert.deepEqual(h.calls, []);
});
test('routing exceptions release retained playback ownership and never create a chat', async (t) => {
  const h = dispatcherOf(t, { throwing: true, config: { fallback_enabled: true } });
  h.send('音乐');
  await flush();
  assert.deepEqual(h.calls, ['interrupt', 'music', 'release']);
});
test('empty/duplicate requests are ignored per device, and closing stops future dispatch', async (t) => {
  const h = dispatcherOf(t);
  h.send(' ');
  h.send('请问问题', 'd', 'same');
  h.send('请问问题', 'd', 'same');
  await flush();
  h.send('请问问题', 'e', 'same');
  await flush();
  assert.equal(h.calls.filter(c => c[0] === 'chat').length, 2);
  h.dispatcher.close();
  h.send('请问新问题');
  await flush();
  assert.equal(h.calls.length, 2);
});
for (const [label, options, terminal, resumes] of [
  ['spoken answer', {}, 'completed', true], ['resume disabled', { config: { resume_music: false } }, 'completed', false],
  ['paused queue', { state: 'paused' }, 'completed', false], ['stopped queue', { state: 'stopped' }, 'completed', false],
  ['no playlist manager', { noManager: true }, 'completed', false], ['TTS unknown', { speechResult: 'unknown' }, 'unknown', false],
  ['TTS rejected', { speechResult: 'failed' }, 'failed', false], ['requester offline', { pauseResult: { d: 'failed' } }, 'failed', false],
  ['native interrupt rejected', { interruptResult: 'failed' }, 'failed', false], ['DLNA active', { external: true }, 'failed', false],
  ['restore rejected', { resumeResult: false }, 'failed', true], ['secondary offline', { group: true, pauseResult: { e: 'failed' } }, 'completed', true],
]) {
  test(`full task lifecycle: ${label}`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const h = chatOf(t, options);
    const id = await h.chat.submit('a', 'd', '问题');
    await tick(t);
    assert.equal(h.chat.status('a', 'd').phase, terminal);
    assert.equal(h.chat.busyReason(), '');
    assert.equal(h.calls.some(c => c[0] === 'resume'), resumes);
    const value = await h.chat.memory.load(scope);
    assert.equal(value.history[0].id, id);
    assert.equal(value.history[0].phase, terminal);
    if (terminal !== 'completed')
      assert.ok(!h.chat.memory.messages(value, configOf(), '新问题').some(m => m.role === 'assistant'));
    if (label === 'secondary offline') {
      assert.ok(h.logs.some(([, log]) => log.includes('member_pause_failed')));
      assert.equal(h.calls.filter(c => c[0] === 'speak').length, 1);
      assert.equal(h.calls.find(c => c[0] === 'speak')[1], 'd');
    }
  });
}
for (const checkpoint of ['queued', 'preparing', 'generating', 'speaking', 'resuming']) {
  test(`cancellation while ${checkpoint} cannot speak or restore late results`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const wait = deferred(), h = chatOf(t);
    if (checkpoint === 'preparing')
      h.devices.interruptAnswer = () => wait.promise;
    if (checkpoint === 'generating')
      h.chat.client.request = () => wait.promise;
    if (checkpoint === 'speaking')
      h.chat.speech.speak = async () => wait.promise;
    if (checkpoint === 'resuming')
      h.manager.replayCurrent = async (_position, current) => {
        await wait.promise;
        if (current())
          h.calls.push('late-resume');
        return false;
      };
    await h.chat.submit('a', 'd', '问题');
    if (checkpoint !== 'queued')
      await tick(t);
    assert.equal(h.chat.status('a', 'd').phase, checkpoint);
    await h.chat.cancel('a', 'd');
    const count = h.calls.length;
    wait.resolve(checkpoint === 'preparing' ? { status: 'accepted' } : checkpoint === 'speaking' ? 'completed' : '迟到答案');
    await tick(t);
    assert.equal(h.chat.status('a', 'd').phase, 'cancelled');
    assert.equal(h.chat.busyReason(), '');
    assert.equal(h.calls.length, count);
    assert.ok(!h.calls.includes('late-resume'));
  });
}
for (const action of ['configuration', 'close', 'external control']) {
  test(`${action} invalidates a pending model result and followup`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const wait = deferred(), h = chatOf(t, { request: () => wait.promise });
    await h.chat.submit('a', 'd', '问题');
    await tick(t);
    if (action === 'configuration')
      h.chat.configurationChanged();
    else if (action === 'close')
      h.chat.close();
    else
      h.control();
    wait.resolve('迟到答案');
    await flush();
    assert.equal(h.chat.status('a', 'd').phase, 'cancelled');
    assert.equal(h.chat.status('a', 'd').followup_until, 0);
    assert.equal(h.chat.busyReason(), '');
    assert.ok(!h.calls.some(c => c[0] === 'speak' || c[0] === 'resume'));
  });
}
for (const hint of ['completed', 'unknown', 'throws']) {
  test(`model failure with ${hint} spoken fallback remains failed and releases playback`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const h = chatOf(t, { request: async () => { throw new Error('模型不可用'); } });
    h.chat.speech.speak = async () => {
      if (hint === 'throws')
        throw new Error('TTS transport error');
      return hint;
    };
    await h.chat.submit('a', 'd', '问题');
    await tick(t);
    assert.equal(h.chat.status('a', 'd').phase, 'failed');
    assert.match(h.chat.status('a', 'd').error, /模型不可用/);
    assert.equal(h.chat.busyReason(), '');
    assert.equal(h.state(), hint === 'completed' ? 'playing' : 'paused');
  });
}
test('failed speech stop cannot restore music and routing failure releases its lease', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const wait = deferred(), h = chatOf(t, { stopError: true, request: () => wait.promise });
  await h.chat.submit('a', 'd', '问题');
  await tick(t);
  await assert.rejects(h.chat.interruptForRouting('a', 'd'), /停止失败/);
  assert.equal(h.state(), 'paused');
  assert.equal(h.chat.busyReason(), '');
  wait.resolve('迟到答案');
  await flush();
  assert.equal(h.chat.status('a', 'd').phase, 'cancelled');
});
test('storage failure does not poison later serial writes or send audio', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = chatOf(t);
  const set = songloft.storage.set;
  let fail = true;
  songloft.storage.set = async (...args) => {
    if (fail) {
      fail = false;
      throw new Error('磁盘错误');
    }
    return set(...args);
  };
  await h.chat.submit('a', 'd', '问题');
  await tick(t);
  assert.equal(h.chat.status('a', 'd').phase, 'failed');
  assert.ok(!h.calls.some(c => c[0] === 'speak'));
  await h.chat.submit('a', 'd', '新问题', false);
  await tick(t);
  assert.equal(h.chat.status('a', 'd').phase, 'completed');
});
test('fresh service after restart keeps history and preferences but never resumes queued work/window', async (t) => {
  const h = chatOf(t);
  await h.chat.memory.saveTurn(scope, turnOf('queued', { phase: 'queued' }), configOf());
  await h.chat.memory.editMemory(scope, '偏好');
  h.chat.close();
  const { AIChatService } = load('../src/chat/service.ts');
  const fresh = new AIChatService(h.config, h.playback, h.chat.speech);
  assert.equal((await fresh.memory.load(scope)).history.length, 1);
  assert.equal((await fresh.memory.load(scope)).memories.length, 1);
  assert.equal(fresh.status('a', 'd').followup_until, 0);
  assert.equal(fresh.busyReason(), '');
  assert.deepEqual(h.calls, []);
  fresh.close();
});
for (const status of [-1, 1, 3]) {
  test(`speech with status ${status} cannot be mistaken for idle completion`, async (t) => {
    storageOf(t);
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
    const speech = new SpeechService({ textToSpeech: async () => true, getPlayState: async () => ({ status, sampledAt: Date.now() }) });
    const pending = speech.speak('短回答', { account: 'a', device: 'd', isCurrent: () => true });
    await flush();
    for (let i = 0; i < 90; i++)
      await tick(t, 1000);
    assert.equal(await pending, 'unknown');
  });
}
test('speech resets idle count after playing sample and completes segments sequentially', async (t) => {
  storageOf(t);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  let sends = 0, queries = 0;
  const speech = new SpeechService({ textToSpeech: async () => { sends++; return true; }, getPlayState: async () => ({ status: ++queries === 4 ? 1 : 0, sampledAt: Date.now() }) });
  let result;
  const pending = speech.speak('答'.repeat(205), { account: 'a', device: 'd', isCurrent: () => true }).then(r => { result = r; });
  await flush();
  for (let i = 0; i < 50; i++)
    await tick(t, 1000);
  assert.equal(sends, 1);
  assert.equal(result, undefined);
  for (let i = 0; i < 7; i++)
    await tick(t, 1000);
  assert.equal(sends, 2);
  await pending;
  assert.equal(result, 'completed');
});
test('speech cannot send before cancellation; rejection and failed stop stay explicit', async (t) => {
  storageOf(t);
  let sends = 0;
  const speech = new SpeechService({ textToSpeech: async () => { sends++; return false; }, stopForInteraction: async () => 'failed' });
  assert.equal(await speech.speak('答案', { isCurrent: () => false }), 'cancelled');
  assert.equal(sends, 0);
  assert.equal(await speech.speak('答案', { isCurrent: () => true }), 'failed');
  assert.equal(sends, 1);
  await assert.rejects(speech.stop({ isCurrent: () => true }), /保持音乐暂停/);
  await speech.stop({ isCurrent: () => false });
});
test('context includes at most five relevant facts and respects disabled memory and context turns', async (t) => {
  storageOf(t);
  const memory = new ChatMemoryService();
  for (let i = 0; i < 8; i++) {
    await memory.editMemory('s', `喜欢摇滚 ${i}`);
    await memory.saveTurn('s', turnOf(String(i)), configOf());
  }
  const value = await memory.load('s'), messages = memory.messages(value, configOf({ memory_enabled: true, context_turns: 2 }), '摇滚');
  assert.equal(messages.filter(m => m.role === 'assistant').length, 2);
  assert.equal((messages[1].content.match(/喜欢摇滚/g) || []).length, 5);
  assert.ok(!memory.messages(value, configOf(), '摇滚').some(m => m.content.includes('喜欢摇滚')));
});
test('manual source edit wins over extraction; empty extraction is checkpointed', async (t) => {
  const h = chatOf(t), config = configOf({ memory_enabled: true });
  await h.chat.memory.saveTurn(scope, turnOf('source'), config);
  h.chat.client.request = async () => '["原偏好"]';
  await h.chat.maintain(scope, config);
  const entry = (await h.chat.memory.load(scope)).memories[0];
  await h.chat.memory.editMemory(scope, '手工修正', entry.id);
  await h.chat.maintain(scope, config);
  assert.deepEqual((await h.chat.memory.load(scope)).memories.map(m => m.content), ['手工修正']);
  await h.chat.memory.saveTurn(scope, turnOf('empty'), config);
  let requests = 0;
  h.chat.client.request = async () => { requests++; return '[]'; };
  await h.chat.maintain(scope, config);
  await h.chat.maintain(scope, config);
  assert.equal(requests, 1);
});
test('summary is triggered at eight new turns, and cancelled turns never contribute', async (t) => {
  const h = chatOf(t);
  let summaries = 0;
  h.chat.client.request = async (_config, messages, kind) => { assert.equal(kind, 'summary'); summaries++; assert.equal(JSON.parse(messages[1].content).turns.length, 8); return '摘要'; };
  for (let i = 0; i < 7; i++)
    await h.chat.memory.saveTurn(scope, turnOf(String(i)), configOf());
  await h.chat.memory.saveTurn(scope, turnOf('cancel', { phase: 'cancelled' }), configOf());
  await h.chat.maintain(scope, configOf());
  assert.equal(summaries, 0);
  await h.chat.memory.saveTurn(scope, turnOf('8'), configOf());
  await h.chat.maintain(scope, configOf());
  await h.chat.maintain(scope, configOf());
  assert.equal(summaries, 1);
});
test('summary failure does not block extracting preferences from the same turns', async (t) => {
  const h = chatOf(t), config = configOf({ memory_enabled: true });
  for (let i = 0; i < 8; i++)
    await h.chat.memory.saveTurn(scope, turnOf(String(i)), config);
  h.chat.client.request = async (_config, messages, kind) => {
    if (kind === 'summary')
      throw new Error('摘要模型失败');
    return JSON.stringify([messages[1].content]);
  };
  await h.chat.maintain(scope, config);
  const value = await h.chat.memory.load(scope);
  assert.equal(value.summary, '');
  assert.equal(value.memories.length, 8);
  assert.equal(value.extracted_sources.length, 8);
});
test('clearing while maintenance is coalesced cannot recreate past preferences', async (t) => {
  const h = chatOf(t), config = configOf({ memory_enabled: true }), wait = deferred();
  await h.chat.memory.saveTurn(scope, turnOf('old'), config);
  h.chat.client.request = () => wait.promise;
  const pending = h.chat.maintain(scope, config);
  await flush();
  await h.chat.maintain(scope, config);
  await h.chat.clear('a', 'd', 'memory');
  wait.resolve('["旧偏好"]');
  await pending;
  await flush();
  assert.deepEqual((await h.chat.memory.load(scope)).memories, []);
});
test('config changes discard old queued extraction, while future turns use the new config', async (t) => {
  const h = chatOf(t), config = configOf({ memory_enabled: true }), wait = deferred();
  let requests = 0;
  await h.chat.memory.saveTurn(scope, turnOf('old'), config);
  h.chat.client.request = async () => { requests++; return wait.promise; };
  const pending = h.chat.maintain(scope, config);
  await flush();
  await h.chat.maintain(scope, config);
  h.chat.configurationChanged();
  wait.resolve('["旧偏好"]');
  await pending;
  await flush();
  assert.equal(requests, 1);
  assert.deepEqual((await h.chat.memory.load(scope)).memories, []);
});
test('a delayed older submit cannot supersede a newer submit from the HTTP API', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = chatOf(t), wait = deferred();
  let reads = 0;
  h.config.getChatConfig = () => ++reads === 1 ? wait.promise : Promise.resolve(configOf());
  const older = h.chat.submit('a', 'd', '旧问题', false), rejected = assert.rejects(older, /取消/);
  const latest = await h.chat.submit('a', 'd', '新问题', false);
  await tick(t);
  wait.resolve(configOf());
  await rejected;
  assert.equal(h.chat.status('a', 'd').task_id, latest);
  assert.equal((await h.chat.memory.load(scope)).history.length, 1);
});
for (const operation of ['cancel', 'configuration']) {
  test(`${operation} cancels a submit still awaiting configuration, before queuing`, async (t) => {
    const h = chatOf(t), wait = deferred();
    h.config.getChatConfig = () => wait.promise;
    const pending = h.chat.submit('a', 'd', '问题', false), rejected = assert.rejects(pending, /取消/);
    if (operation === 'cancel')
      await h.chat.cancel('a', 'd');
    else
      h.chat.configurationChanged();
    wait.resolve(configOf());
    await rejected;
    assert.equal(h.chat.busyReason(), '');
    assert.equal((await h.chat.memory.load(scope)).history.length, 0);
  });
}
test('a text-only test safely stops a previous spoken answer and restores its music first', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const old = deferred(), h = chatOf(t);
  let requests = 0;
  h.chat.client.request = async () => ++requests === 1 ? old.promise : '文本答案';
  await h.chat.submit('a', 'd', '语音问题');
  await tick(t);
  await h.chat.submit('a', 'd', '文本测试', false);
  await tick(t);
  assert.ok(h.calls.some(c => c[0] === 'stop-answer'));
  assert.ok(h.calls.some(c => c[0] === 'resume'));
  assert.equal(h.state(), 'playing');
  assert.equal(h.chat.status('a', 'd').phase, 'completed');
  old.resolve('迟到语音答案');
  await flush();
  assert.ok(!h.calls.some(c => c[0] === 'speak'));
});
for (const phrase of ['停止', '暂停', '停止播放', '暂停播放', '暂停音乐']) {
  test(`native ${phrase} during chat never falls back into a new AI answer when music commands are disabled`, async (t) => {
    const h = dispatcherOf(t, { active: { phase: 'speaking' } });
    h.send(phrase);
    await flush();
    assert.deepEqual(h.calls, [['cancel', 'a', 'd', true, false], 'music']);
  });
}

for (const observedPlaying of [true, false]) {
  test(`unconfirmed TTS requires fresh playing then idle evidence (playing=${observedPlaying})`, async t => {
    storageOf(t);
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
    let sends = 0, queries = 0;
    const speech = new SpeechService({
      textToSpeech: async () => { sends++; return null; },
      getPlayState: async () => ({ status: observedPlaying && ++queries <= 2 ? 1 : 0, sampledAt: Date.now() }),
    });
    const pending = speech.speak('回答', { account: 'a', device: 'd', isCurrent: () => true });
    await flush();
    for (let i = 0; i < 90; i++) await tick(t, 1000);
    assert.equal(await pending, observedPlaying ? 'completed' : 'unknown');
    assert.equal(sends, 1);
  });
}

test('unconfirmed TTS cancellation stops probing and prevents the next segment', async t => {
  storageOf(t);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  let current = true, sends = 0;
  const speech = new SpeechService({
    textToSpeech: async () => { sends++; return null; },
    getPlayState: async () => ({ status: 1, sampledAt: Date.now() }),
  });
  const pending = speech.speak('答'.repeat(205), { account: 'a', device: 'd', isCurrent: () => current });
  await flush();
  current = false;
  await tick(t, 1000);
  assert.equal(await pending, 'cancelled');
  assert.equal(sends, 1);
});

for (const observedPlaying of [true, false]) {
  test(`chat records TTS uncertainty and restores music only after playback evidence (playing=${observedPlaying})`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
    const h = chatOf(t);
    let queries = 0;
    h.devices.textToSpeech = async () => null;
    h.devices.getPlayState = async () => ({ status: observedPlaying && ++queries <= 2 ? 1 : 0, sampledAt: Date.now() });
    h.chat.speech = new SpeechService(h.devices);
    await h.chat.submit('a', 'd', '问题');
    await tick(t, 0);
    for (let i = 0; i < 90; i++) await tick(t, 1000);
    assert.equal(h.chat.status('a', 'd').phase, observedPlaying ? 'completed' : 'unknown');
    assert.equal(h.calls.some(c => Array.isArray(c) && c[0] === 'resume'), observedPlaying);
    assert.equal(h.calls.some(c => Array.isArray(c) && c[0] === 'hold'), !observedPlaying);
    const history = (await h.chat.memory.load(scope)).history;
    assert.equal(history.at(-1).phase, observedPlaying ? 'completed' : 'unknown');
    assert.equal(history.at(-1).assistant, '测试答案');
  });
}

test('cached playing before TTS and repeated idle samples cannot confirm an unacknowledged segment', async t => {
  storageOf(t);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  let sends = 0, queries = 0;
  const speech = new SpeechService({
    textToSpeech: async () => { sends++; return null; },
    getPlayState: async () => ++queries === 1 ? { status: 1, sampledAt: 100000 } : { status: 0, sampledAt: 101000 },
  });
  const pending = speech.speak('答'.repeat(205), { account: 'a', device: 'd', isCurrent: () => true });
  await flush();
  for (let i = 0; i < 90; i++) await tick(t, 1000);
  assert.equal(await pending, 'unknown');
  assert.equal(sends, 1);
});
