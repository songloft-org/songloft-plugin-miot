import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import { loader } from '../../tests/chat_loader.mjs';
const { parseAIHeaders } = loader()('../src/utils/ai_headers.ts');
const flush = async () => {
  for (let i = 0; i < 30; i++)
    await Promise.resolve();
};
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function harness(options = {}) {
  const state = { config: { voice_command_enabled: false, ai_config: { enabled: false, api_url: 'https://old.test/v1', api_key: 'test-only', model: 'old', timeout: 6 } } };
  const calls = [], notifications = [], watchers = [];
  let mounted, unmounted;
  const source = fs.readFileSync(new URL('../src/views/settings/AIModelSettings.vue', import.meta.url), 'utf8').match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1].replace(/^import .*;\n/gm, '');
  const env = {
    parseAIHeaders, state, navigation: { settingsCategory: '' }, AI_PRESET_PROVIDERS: [{ id: 'preset', name: '测试模型服务商', baseUrl: 'https://preset.test/v1', defaultModel: 'preset-model', apiKeyUrl: 'https://preset.test/key' }],
    ref: value => ({ value }), computed: fn => ({ get value() { return fn(); } }), watch: (_get, callback) => watchers.push(callback), onMounted: fn => { mounted = fn; }, onUnmounted: fn => { unmounted = fn; },
    notify: (...args) => notifications.push(args), messageOf: e => e.message,
    saveConfig: options.save || (async (patch) => { calls.push(['save', structuredClone(patch)]); Object.assign(state.config, patch); }),
    get: options.get || (async (path) => { calls.push(['get', path]); return { models: [{ id: 'old' }, { id: 'new' }] }; }),
    post: options.post || (async (path, body) => { calls.push(['post', path, body]); return { action: 'play_song', confidence: 'high' }; }),
  };
  const js = ts.transpileModule(source + '\nreturn {applyPreset, selectModel, refreshModels, enableAnalysis, testAnalysis, selectedPreset, customModel, models, loading, modelError, connectionState, testQuery, testResult, testBusy, customHeaders};', { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText;
  const page = new Function(...Object.keys(env), js)(...Object.values(env));
  return { ...page, state, calls, notifications, watchers, mount: () => mounted(), unmount: () => unmounted() };
}
test('default connection can be edited with analysis disabled; preset preserves API key and enable flag', async () => {
  const h = harness();
  await h.applyPreset('preset');
  assert.equal(h.state.config.ai_config.api_url, 'https://preset.test/v1');
  assert.equal(h.state.config.ai_config.model, 'preset-model');
  assert.equal(h.state.config.ai_config.api_key, 'test-only');
  assert.equal(h.state.config.ai_config.enabled, false);
  assert.deepEqual(Object.keys(h.calls[0][1]), ['ai_config']);
  await h.applyPreset('custom');
  assert.equal(h.selectedPreset.value, 'custom');
  assert.equal(h.state.config.ai_config.model, 'preset-model');
});
test('analysis switch preserves the shared connection and requires voice commands only for enabling analysis', async () => {
  const h = harness();
  await h.enableAnalysis(true);
  assert.equal(h.state.config.ai_config.enabled, false);
  assert.equal(h.calls.length, 0);
  assert.ok(h.notifications.some(n => n[1] === 'warning'));
  h.state.config.voice_command_enabled = true;
  await h.enableAnalysis(true);
  assert.equal(h.state.config.ai_config.enabled, true);
  await h.enableAnalysis(false);
  assert.equal(h.state.config.ai_config.api_key, 'test-only');
  assert.equal(h.state.config.ai_config.model, 'old');
});
test('selecting a custom model does not overwrite the existing model; selecting a model saves it', async () => {
  const h = harness();
  h.selectModel('__custom_model__');
  assert.equal(h.customModel.value, true);
  assert.equal(h.state.config.ai_config.model, 'old');
  assert.equal(h.calls.length, 0);
  h.selectModel('new');
  await flush();
  assert.equal(h.state.config.ai_config.model, 'new');
  assert.equal(h.calls[0][1].ai_config.model, 'new');
});
test('automatic connection check never writes config; manual refresh saves before fetching models', async () => {
  const h = harness();
  h.mount();
  await flush();
  assert.deepEqual(h.calls, [['get', '/voice-commands/models']]);
  assert.equal(h.connectionState.value, 'ok');
  h.calls.length = 0;
  await h.refreshModels();
  assert.equal(h.calls[0][0], 'save');
  assert.deepEqual(h.calls[1], ['get', '/voice-commands/models']);
  assert.equal(h.models.value.length, 2);
});
test('changing connection ignores stale results and resets error/latency before the next request', async () => {
  const old = deferred(), current = deferred();
  let requests = 0;
  const h = harness({ get: () => ++requests === 1 ? old.promise : current.promise });
  const first = h.refreshModels(true);
  h.state.config.ai_config.api_url = 'https://new.test/v1';
  h.watchers[0]();
  const second = h.refreshModels(true);
  current.resolve({ models: [{ id: 'new' }] });
  await second;
  old.resolve({ models: [{ id: 'old' }] });
  await first;
  assert.deepEqual(h.models.value, [{ id: 'new' }]);
  assert.equal(h.loading.value, false);
  assert.equal(h.connectionState.value, 'ok');
});
test('failed model list allows manual model entry; unmounted component ignores late responses', async () => {
  const h = harness({ get: async () => { throw new Error('不支持 models'); } });
  await h.refreshModels(true);
  assert.equal(h.customModel.value, true);
  assert.equal(h.loading.value, false);
  assert.equal(h.modelError.value, '不支持 models');
  assert.equal(h.state.config.ai_config.model, 'old');
  const wait = deferred(), other = harness({ get: () => wait.promise });
  const pending = other.refreshModels(true);
  other.unmount();
  wait.resolve({ models: [{ id: 'late' }] });
  await pending;
  assert.deepEqual(other.models.value, []);
});
test('strict analysis test saves connection and remains available without enabling analysis or executing music', async () => {
  const wait = deferred(), h = harness({ post: async () => wait.promise });
  h.testQuery.value = ' 放一首歌 ';
  const pending = h.testAnalysis();
  assert.equal(h.testBusy.value, true);
  await h.testAnalysis();
  wait.resolve({ action: 'play_song', confidence: 'high' });
  await pending;
  assert.equal(h.state.config.ai_config.enabled, false);
  assert.ok(h.testResult.value.includes('play_song'));
  assert.equal(h.testBusy.value, false);
  assert.equal(h.calls.length, 1);
});
test('failed save prevents model and analysis requests and reports errors', async () => {
  let networkCalls = 0;
  const h = harness({ save: async () => { throw new Error('保存失败'); }, get: async () => { networkCalls++; }, post: async () => { networkCalls++; } });
  await h.refreshModels();
  h.testQuery.value = '问题';
  await h.testAnalysis();
  assert.equal(networkCalls, 0);
  assert.equal(h.testBusy.value, false);
  assert.equal(h.loading.value, false);
  assert.equal(h.testResult.value, '保存失败');
});
test('all AI configuration has one settings entry; voice page retains the shortcut and search', () => {
  const root = fs.readFileSync(new URL('../src/views/SettingsPage.vue', import.meta.url), 'utf8');
  const page = fs.readFileSync(new URL('../src/views/settings/AISettings.vue', import.meta.url), 'utf8');
  const voice = fs.readFileSync(new URL('../src/views/settings/VoiceSettings.vue', import.meta.url), 'utf8');
  assert.match(root, /id: 'ai', title: 'AI 设置'/);
  assert.doesNotMatch(root, /id: 'chat',/);
  assert.match(page, /<AIModelSettings/);
  assert.match(page, /<ChatSettings/);
  assert.doesNotMatch(voice, /\/voice-commands\/models|AI_PRESET_PROVIDERS/);
  assert.match(voice, /打开 AI 设置/);
  assert.match(voice, /external_search_playlist_id/);
});
test('analysis result is ignored after changing the model during the request', async () => {
  const wait = deferred(), h = harness({ post: () => wait.promise });
  h.testQuery.value = '问题';
  const pending = h.testAnalysis();
  await flush();
  h.state.config.ai_config.model = 'new-model';
  wait.resolve({ action: 'old-model-result' });
  await pending;
  assert.equal(h.testResult.value, '');
  assert.equal(h.testBusy.value, false);
});
test('unmount during connection save prevents a subsequent analysis network request', async () => {
  const wait = deferred();
  let posts = 0;
  const h = harness({ save: () => wait.promise, post: async () => { posts++; return {}; } });
  h.testQuery.value = '问题';
  const pending = h.testAnalysis();
  h.unmount();
  wait.resolve();
  await pending;
  assert.equal(posts, 0);
  assert.equal(h.testResult.value, '');
});
test('model detection saves custom headers and invalid JSON blocks the request', async () => {
  const h = harness();
  h.customHeaders.value = '{"X-Opencode-Session":"stable-session"}';
  await h.refreshModels();
  assert.deepEqual(h.calls[0][1].ai_config.custom_headers, { 'x-opencode-session': 'stable-session' });
  assert.equal(h.connectionState.value, 'ok');
  const count = h.calls.length;
  h.customHeaders.value = '{bad';
  await h.refreshModels();
  assert.equal(h.calls.length, count);
  assert.equal(h.connectionState.value, 'error');
  assert.match(h.modelError.value, /JSON/);
});
test('changing custom headers invalidates a pending model-list result', async () => {
  const wait = deferred(), h = harness({ get: () => wait.promise });
  const pending = h.refreshModels();
  await flush();
  h.customHeaders.value = '{"x-session":"new-session"}';
  h.watchers[0]();
  wait.resolve({ models: [{ id: 'old-session-model' }] });
  await pending;
  assert.deepEqual(h.models.value, []);
  assert.equal(h.connectionState.value, 'idle');
});
