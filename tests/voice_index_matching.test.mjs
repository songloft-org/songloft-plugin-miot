import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const ts = require('typescript');

function loadSource(path, dependencies = {}) {
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

const defaults = loadSource('../src/voicecmd/defaults.ts');
const sleepTimer = loadSource('../src/sleep_timer/index.ts');
const { VoiceEngine } = loadSource('../src/voicecmd/engine.ts', {
  '../config/manager': {},
  '../account/manager': {},
  '../service/service': {},
  '../player/manager': {},
  '../indexing/manager': {},
  '../group/coordinator': {},
  '../player/url_builder': {},
  './ai_analyzer': {},
  './online_searcher': {},
  '../handlers/playlist': {},
  '../utils/http': {},
  '../utils/favorites': {},
  '../memory': {},
  '../sleep_timer': sleepTimer,
  './defaults': defaults,
});

globalThis.songloft = { log: { info() { }, warn() { }, error() { } } };

function createEngine(commands = defaults.getDefaultVoiceCommands()) {
  const actions = [];
  const engine = Object.create(VoiceEngine.prototype);
  engine.enabled = true;
  engine.configManager = {
    getVoiceCommands: async () => commands,
    getConfig: async () => ({ voice_memory_enabled: false }),
    getAIConfig: async () => ({ enabled: false }),
    getDevices: async () => [{ device_id: 'speaker' }],
  };
  engine.accountManager = { getAccounts: async () => [{ id: 'account' }] };
  engine.memoryService = { setMaxRecords: async () => { } };
  engine.playlistManagerMap = { get: () => undefined, cancelHourlyResumes: () => { } };
  engine.indexingManager = {
    waitForReady: async () => true,
    findPlaylistByNameWithRefresh: async name => ({ name, songCount: 3 }),
    findSongByName: async () => null,
  };
  engine.executePlayPlaylist = async name => { actions.push({ type: 'play_playlist', name }); };
  engine.executePlaySong = async name => { actions.push({ type: 'play_song', name }); return null; };
  engine.executePlayIndexNumber = async index => { actions.push({ type: 'play_index', index }); };
  engine.executeNext = async () => { actions.push({ type: 'next' }); };
  engine.executeStop = async () => { actions.push({ type: 'stop' }); };
  engine.executeResume = async () => { actions.push({ type: 'resume' }); };
  engine.executeSetVolume = async () => { actions.push({ type: 'set_volume' }); };
  engine.executeSetPlayMode = async () => { actions.push({ type: 'set_play_mode' }); };
  engine.executeSleepTimer = async () => { actions.push({ type: 'sleep_timer' }); };
  return { engine, actions };
}

async function handleQuery(engine, query) {
  await engine.handleMessage({
    device_id: 'speaker',
    message: { response: { answer: [{ question: query }] } },
  });
}

for (const keyword of ['播放歌单', '播放列表', '放歌单']) {
  for (const name of ['第一周', '启蒙第一周', 'sss第二周', '第3周', '第三首', '第三']) {
    test(`playlist voice and test commands preserve the name: ${keyword}${name}`, async () => {
      const { engine, actions } = createEngine();
      await handleQuery(engine, `${keyword}${name}`);
      assert.deepEqual(actions, [{ type: 'play_playlist', name }]);
      const result = await engine.testCommand(`${keyword}${name}`, 'speaker');
      assert.equal(result.commandType, 'play_playlist');
      assert.equal(result.argument, name);
      assert.equal(result.search.found, true);
      assert.deepEqual(actions[1], { type: 'play_playlist', name });
    });
  }
}

test('song names containing ordinals reach song search', async () => {
  const { engine, actions } = createEngine();
  await handleQuery(engine, '播放歌曲第一天');
  assert.deepEqual(actions, [{ type: 'play_song', name: '第一天' }]);
});

test('invalid ordinal names fall through to a configured song keyword', async () => {
  const commands = defaults.getDefaultVoiceCommands();
  commands.find(command => command.type === 'play_song').keywords.push('播放');
  const { engine, actions } = createEngine(commands);
  await handleQuery(engine, '播放第一周');
  assert.deepEqual(actions, [{ type: 'play_song', name: '第一周' }]);
});

for (const [query, index] of [
  ['播放第三首', 3],
  ['播放第300首', 300],
  ['请播放第一百二十首歌。', 120],
  ['跳到第 50 首', 50],
  ['切到第1首', 1],
  ['跳转到第500', 500],
  ['跳到第三百', 300],
]) {
  test(`valid index commands still execute through both entries: ${query}`, async () => {
    const { engine, actions } = createEngine();
    await handleQuery(engine, query);
    assert.deepEqual(actions, [{ type: 'play_index', index }]);
    const result = await engine.testCommand(query, 'speaker');
    assert.equal(result.commandType, 'play_index');
    assert.deepEqual(actions[1], { type: 'play_index', index });
  });
}

test('custom contiguous index keywords remain supported', async () => {
  const commands = defaults.getDefaultVoiceCommands();
  commands.find(command => command.type === 'play_index').keywords = ['定位到第'];
  const { engine, actions } = createEngine(commands);
  await handleQuery(engine, '定位到第五首');
  assert.deepEqual(actions, [{ type: 'play_index', index: 5 }]);
});

test('index execution uses the matched command instead of an earlier ordinal', async () => {
  const { engine, actions } = createEngine();
  await handleQuery(engine, '第一周听过了，请播放第三首');
  assert.deepEqual(actions, [{ type: 'play_index', index: 3 }]);
});

for (const query of ['播放第几首', '播放第0首', '播放第1.5首', '播放第几首然后第三首']) {
  test(`invalid index commands do not execute: ${query}`, async () => {
    const { engine, actions } = createEngine();
    await handleQuery(engine, query);
    assert.deepEqual(actions, []);
    const result = await engine.testCommand(query, 'speaker');
    assert.equal(result.matched, false);
  });
}

test('disabled index commands do not execute', async () => {
  const commands = defaults.getDefaultVoiceCommands();
  commands.find(command => command.type === 'play_index').enabled = false;
  const { engine, actions } = createEngine(commands);
  await handleQuery(engine, '播放第三首');
  assert.deepEqual(actions, []);
});

test('search commands retain fuzzy matching', async () => {
  const { engine, actions } = createEngine();
  await handleQuery(engine, '我今天想听晴天');
  assert.deepEqual(actions, [{ type: 'play_song', name: '晴天' }]);
});

for (const query of ['继续播放', '恢复播放', '继续', '接着播', '接着放', 'resume']) {
  test(`resume commands execute through the voice and test entries: ${query}`, async () => {
    const { engine, actions } = createEngine();
    await handleQuery(engine, query);
    assert.deepEqual(actions, [{ type: 'resume' }]);
    const result = await engine.testCommand(query, 'speaker');
    assert.equal(result.commandType, 'resume');
    assert.deepEqual(actions[1], { type: 'resume' });
  });
}

test('custom resume keywords remain supported', async () => {
  const commands = defaults.getDefaultVoiceCommands();
  commands.find(command => command.type === 'resume').keywords = ['接着听音乐'];
  const { engine, actions } = createEngine(commands);
  await handleQuery(engine, '接着听音乐');
  await handleQuery(engine, '继续播放');
  assert.deepEqual(actions, [{ type: 'resume' }]);
});

test('disabled resume commands do not execute', async () => {
  const commands = defaults.getDefaultVoiceCommands();
  commands.find(command => command.type === 'resume').enabled = false;
  const { engine, actions } = createEngine(commands);
  await handleQuery(engine, '继续播放');
  assert.deepEqual(actions, []);
  assert.equal((await engine.testCommand('继续播放', 'speaker')).matched, false);
});

test('resume is handled before memory and AI fallback', async () => {
  const { engine, actions } = createEngine();
  const fallbacks = [];
  engine.configManager.getConfig = async () => { fallbacks.push('memory'); return { voice_memory_enabled: false }; };
  engine.configManager.getAIConfig = async () => { fallbacks.push('AI'); return { enabled: false }; };
  await handleQuery(engine, '继续播放');
  assert.deepEqual(actions, [{ type: 'resume' }]);
  assert.deepEqual(fallbacks, []);
});

for (const [query, type] of [
  ['下一首', 'next'],
  ['停止播放', 'stop'],
  ['音量调到30', 'set_volume'],
  ['随机播放', 'set_play_mode'],
  ['30分钟后停止播放', 'sleep_timer'],
]) {
  test(`other fixed controls remain effective: ${query}`, async () => {
    const { engine, actions } = createEngine();
    await handleQuery(engine, query);
    assert.deepEqual(actions, [{ type }]);
  });
}
