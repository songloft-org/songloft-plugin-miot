import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import { loader } from '../../tests/chat_loader.mjs';
const { parseAIHeaders } = loader()('../src/utils/ai_headers.ts');
const { isDashScopeEndpoint } = loader()('../src/utils/ai_url.ts');
const deferred = () => { let resolve, reject; const promise = new Promise((r, e) => { resolve = r; reject = e; }); return { promise, resolve, reject }; };
const flush = async () => {
  for (let i = 0; i < 30; i++)
    await Promise.resolve();
};
test('incremental answer updates do not reload all history on every status push', async t => {
  const vue = await import('vue'), stops = [], requests = [];
  const state = vue.reactive({ currentAccountId: 'a', currentDeviceId: 'd', chatStatus: null });
  script('views/settings/ChatSettings.vue', {
    DEFAULT_CHAT_CONFIG: { trigger_words: ['请问'], context_turns: 3 }, state,
    reactive: vue.reactive, ref: vue.ref, computed: vue.computed,
    watch: (...args) => { stops.push(vue.watch(...args)); }, onMounted() {}, onUnmounted() {},
    query: JSON.stringify, managedDevices: { value: [] }, messageOf: String,
    get: async path => { requests.push(path); return path.startsWith('/chat/history') ? { history: [], total: 0, summary: '' } : { memories: [] }; },
  }, 'config');
  t.after(() => stops.forEach(stop => stop()));
  state.chatStatus = { task_id: 't', phase: 'generating', memory_revision: 1, answer: 'first' };
  await vue.nextTick(); await flush();
  assert.equal(requests.length, 2);
  for (let i = 0; i < 10; i++) {
    state.chatStatus = { ...state.chatStatus, answer: 'chunk ' + i };
    await vue.nextTick(); await flush();
  }
  assert.equal(requests.length, 2);
  state.chatStatus = { ...state.chatStatus, phase: 'completed' };
  await vue.nextTick(); await flush();
  assert.equal(requests.length, 4);
});
test('history switch restores the selected turn count and one save persists independent memory controls', async () => {
  let mount;
  const stored = { trigger_words: ['请问'], context_turns: 6, memory_enabled: false, summary_enabled: true, streaming_enabled: true };
  const writes = [];
  const page = script('views/settings/ChatSettings.vue', {
    DEFAULT_CHAT_CONFIG: { ...stored }, state: { currentAccountId: '', currentDeviceId: '', chatStatus: null },
    reactive: x => x, ref: value => ({ value }), computed: fn => ({ get value() { return fn(); } }),
    query: JSON.stringify, managedDevices: { value: [] }, watch() {}, onMounted: fn => { mount = fn; }, onUnmounted() {},
    get: async path => path === '/chat/config' ? { ...stored } : { streaming: true },
    put: async (_path, body) => { writes.push(structuredClone(body)); return body; }, notify() {}, messageOf: String,
  }, 'config, dirty, contextEnabled, setContextEnabled, save');
  mount(); await flush();
  assert.equal(page.dirty.value, false);
  page.setContextEnabled(false);
  assert.equal(page.config.context_turns, 0);
  assert.equal(page.dirty.value, true);
  page.setContextEnabled(true);
  assert.equal(page.config.context_turns, 6);
  assert.equal(page.dirty.value, false);
  page.setContextEnabled(false);
  await page.save();
  assert.equal(writes[0].context_turns, 0);
  assert.equal(writes[0].memory_enabled, false);
  assert.equal(writes[0].summary_enabled, true); // retained but inactive while history is off
  assert.equal(page.dirty.value, false);
});
function script(file, env, exports) {
  const source = fs.readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8').match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1].replace(/^import .*;\n/gm, '');
  const js = ts.transpileModule(source + `\nreturn { ${exports} };`, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText;
  return new Function('isDashScopeEndpoint', 'parseAIHeaders', ...Object.keys(env), js)(isDashScopeEndpoint, parseAIHeaders, ...Object.values(env));
}
test('late HTTP chat status cannot overwrite a newer WebSocket status; old devices are ignored', async () => {
  const requests = [], sockets = [], timers = new Map();
  let timer = 0;
  const state = { currentAccountId: 'a', currentDeviceId: 'd', chatStatus: null };
  class Socket {
    constructor() { sockets.push(this); }
    close(code) { assert.equal(code, 1000); }
  }
  const app = script('App.vue', {
    state, get: () => { const wait = deferred(); requests.push(wait); return wait.promise; }, WebSocket: Socket,
    pluginWebSocketUrl: x => x, query: () => '', watch() { }, onMounted() { }, onUnmounted() { },
    setTimeout: fn => { timers.set(++timer, fn); return timer; }, clearTimeout: id => timers.delete(id),
  }, 'connectChatSocket, stopChatSocket');
  app.connectChatSocket();
  const send = (socket, phase) => socket.onmessage({ data: JSON.stringify({ type: 'chat_status', data: { phase } }) });
  send(sockets[0], 'completed');
  requests[0].resolve({ phase: 'generating' });
  await flush();
  assert.equal(state.chatStatus.phase, 'completed');
  state.currentDeviceId = 'new';
  app.connectChatSocket();
  send(sockets[0], 'speaking');
  assert.equal(state.chatStatus, null);
  requests[1].resolve({ phase: 'preparing' });
  await flush();
  assert.equal(state.chatStatus.phase, 'preparing');
  const closed = sockets[1].onerror;
  closed();
  assert.ok([...timers.values()].length);
  closed();
  app.stopChatSocket();
});
test('history refresh accepts only the newest response, including switching away and back', async () => {
  const requests = [], watches = [], state = { currentAccountId: 'a', currentDeviceId: 'd', chatStatus: null };
  const env = {
    state, DEFAULT_CHAT_CONFIG: { trigger_words: ['请问'] },
    reactive: x => x, ref: value => ({ value }), computed: fn => ({ get value() { return fn(); } }),
    query: x => JSON.stringify(x), get: () => { const wait = deferred(); requests.push(wait); return wait.promise; },
    managedDevices: { value: [] }, watch: (_get, fn) => watches.push(fn), onMounted() { }, onUnmounted() { }, messageOf: String,
  };
  const page = script('views/settings/ChatSettings.vue', env, 'refresh, history, memories, summary');
  const old = page.refresh();
  const latest = page.refresh();
  requests[2].resolve({ history: [{ id: 'latest' }], total: 1, summary: 'new' });
  requests[3].resolve({ memories: [] });
  await latest;
  requests[0].resolve({ history: [{ id: 'old' }], total: 1, summary: 'old' });
  requests[1].resolve({ memories: [] });
  await old;
  assert.equal(page.history.value[0].id, 'latest');
  const earlier = page.refresh();
  state.currentDeviceId = 'other';
  watches[0]();
  state.currentDeviceId = 'd';
  watches[0]();
  assert.deepEqual(page.history.value, []);
  requests[8].resolve({ history: [{ id: 'back' }], total: 1, summary: 'back' });
  requests[9].resolve({ memories: [] });
  await flush();
  requests[4].resolve({ history: [{ id: 'stale' }], total: 1, summary: 'old' });
  requests[5].resolve({ memories: [] });
  await earlier;
  assert.equal(page.history.value[0].id, 'back');
  requests[6].resolve({ history: [], total: 0, summary: '' });
  requests[7].resolve({ memories: [] });
  await flush();
  assert.equal(page.history.value[0].id, 'back');
});
function appOf({ failingConstructor = false, failingClose = false } = {}) {
  const state = { currentAccountId: 'a', currentDeviceId: 'd', chatStatus: null }, requests = [], sockets = [], timers = new Map();
  let id = 0;
  class Socket {
    constructor() {
      if (failingConstructor)
        throw new Error('WebSocket unavailable');
      sockets.push(this);
    }
    close(code) {
      assert.equal(code, 1000);
      if (failingClose)
        throw new Error('already closed');
    }
  }
  const app = script('App.vue', {
    state, get: () => { const request = deferred(); requests.push(request); return request.promise; }, WebSocket: Socket,
    pluginWebSocketUrl: x => x, query: () => '', watch() { }, onMounted() { }, onUnmounted() { },
    setTimeout: (fn, ms) => { timers.set(++id, { fn, ms }); return id; }, clearTimeout: key => timers.delete(key),
  }, 'connectChatSocket, stopChatSocket');
  return { ...app, state, requests, sockets, timers, fire(ms) { const found = [...timers.entries()].find(([, value]) => value.ms === ms); assert.ok(found); timers.delete(found[0]); found[1].fn(); } };
}
test('WebSocket construction failure still polls HTTP status and stops retry on device removal', async () => {
  const h = appOf({ failingConstructor: true });
  h.connectChatSocket();
  h.requests[0].resolve({ phase: 'speaking' });
  await flush();
  assert.equal(h.state.chatStatus.phase, 'speaking');
  h.fire(3000);
  h.requests[1].resolve({ phase: 'completed' });
  await flush();
  assert.equal(h.state.chatStatus.phase, 'completed');
  h.state.currentDeviceId = '';
  h.connectChatSocket();
  assert.equal(h.timers.size, 0);
  assert.equal(h.state.chatStatus, null);
});
test('WebSocket error and close cannot double-retry; stale sockets and snapshots are ignored', async () => {
  const h = appOf({ failingClose: true });
  h.connectChatSocket();
  const oldMessage = h.sockets[0].onmessage, error = h.sockets[0].onerror, close = h.sockets[0].onclose;
  error();
  close();
  assert.equal(h.timers.size, 1);
  h.fire(3000);
  oldMessage({ data: JSON.stringify({ type: 'chat_status', data: { phase: 'old' } }) });
  assert.equal(h.state.chatStatus, null);
  h.requests[0].resolve({ phase: 'old' });
  h.requests[1].resolve({ phase: 'new' });
  await flush();
  assert.equal(h.state.chatStatus.phase, 'new');
  h.stopChatSocket();
  assert.equal(h.timers.size, 0);
});
test('WebSocket open deadline retries a hung connection, malformed messages do not suppress HTTP', async () => {
  const h = appOf();
  h.connectChatSocket();
  h.sockets[0].onmessage({ data: '{broken' });
  h.requests[0].resolve({ phase: 'completed' });
  await flush();
  assert.equal(h.state.chatStatus.phase, 'completed');
  h.fire(10000);
  h.fire(3000);
  assert.equal(h.sockets.length, 2);
  h.sockets[1].onopen();
  assert.equal(h.timers.size, 0);
  h.stopChatSocket();
});
function pageOf(options = {}) {
  const state = { currentAccountId: 'a', currentDeviceId: 'd', chatStatus: null }, calls = [], notifications = [], watches = [];
  let unmount;
  const env = {
    state, DEFAULT_CHAT_CONFIG: { trigger_words: ['请问'], system_prompt: '角色' },
    reactive: value => value, ref: value => ({ value }), computed: fn => ({ get value() { return fn(); } }),
    query: value => JSON.stringify(value), managedDevices: { value: [] },
    watch: (_get, fn) => watches.push(fn), onMounted() { }, onUnmounted: fn => { unmount = fn; }, messageOf: error => error.message,
    get: options.get || (async (path) => path.includes('/chat/history') ? { history: [], total: 0, summary: '' } : { memories: [{ id: 'm', content: '来自服务器' }] }),
    put: async (path, value) => { calls.push([path, structuredClone(value)]); return value; }, post: async (...args) => calls.push(args), del: async (path) => calls.push(path),
    notify: (...args) => notifications.push(args), confirmAction: options.confirm || (async () => ({ confirmed: true })),
  };
  const page = script('views/settings/ChatSettings.vue', env, 'action, safeAction, refresh, refreshSafely, clear, removeTurn, save, submit, config, triggers, history, memories, memoryDrafts, busy, error, refreshError, loaded, question, speak, webSearchAvailable, customHeaders, dirty');
  return { ...page, state, calls, notifications, watches, unmount: () => unmount() };
}
test('independent chat saves and clears custom headers, rejecting invalid JSON before HTTP', async () => {
  const h = pageOf();
  h.loaded.value = true;
  h.config.connection = 'independent';
  h.customHeaders.value = '{"x-opencode-session":"independent"}';
  assert.equal(h.dirty.value, true);
  await h.save();
  assert.deepEqual(h.calls[0][1].custom_headers, { 'x-opencode-session': 'independent' });
  assert.equal(h.dirty.value, false);
  h.customHeaders.value = '{bad';
  await h.action(h.save);
  assert.match(h.error.value, /JSON/);
  assert.equal(h.calls.length, 1);
  h.customHeaders.value = '';
  await h.save();
  assert.deepEqual(h.calls[1][1].custom_headers, {});
  assert.equal(h.dirty.value, false);
});
test('save sends normalized triggers and action blocks duplicate submissions, reporting errors', async () => {
  const h = pageOf(), wait = deferred();
  h.triggers.value = ' 问一下，问一问、请问\n问题';
  await h.action(h.save);
  assert.deepEqual(h.calls[0][1].trigger_words, ['问一下', '问一问', '请问', '问题']);
  const pending = h.action(async () => { await wait.promise; });
  assert.equal(h.busy.value, true);
  let duplicate = false;
  await h.action(async () => { duplicate = true; });
  assert.equal(duplicate, false);
  wait.resolve();
  await pending;
  assert.equal(h.busy.value, false);
  await h.action(async () => { throw new Error('保存失败'); });
  assert.equal(h.error.value, '保存失败');
  assert.equal(h.busy.value, false);
  assert.ok(h.notifications.some(value => value[1] === 'error'));
});
test('memory edit drafts survive status-triggered refresh; device change clears drafts and data', async () => {
  const h = pageOf();
  h.memoryDrafts.m = '尚未保存的编辑';
  await h.refresh();
  assert.equal(h.memories.value[0].content, '来自服务器');
  assert.equal(h.memoryDrafts.m, '尚未保存的编辑');
  h.state.currentDeviceId = '';
  h.watches[0]();
  assert.deepEqual(h.memoryDrafts, {});
  assert.deepEqual(h.memories.value, []);
});
test('text submission uses selected device and speak flag, then clears the question', async () => {
  const h = pageOf();
  h.question.value = '测试问题';
  h.speak.value = false;
  await h.submit();
  assert.deepEqual(h.calls[0], ['/chat/messages', { account_id: 'a', device_id: 'd', text: '测试问题', speak: false }]);
  assert.equal(h.question.value, '');
});
test('accepted question remains successful when history refresh fails', async () => {
  const h = pageOf({ get: async () => { throw new Error('历史读取失败'); } });
  h.question.value = '测试问题';
  await h.action(h.submit);
  assert.equal(h.question.value, '');
  assert.equal(h.error.value, '');
  assert.ok(h.notifications.some(n => n[1] === 'success' && n[0].includes('已提交')));
  assert.ok(h.notifications.some(n => n[1] === 'warning' && n[0].includes('历史读取失败')));
  assert.ok(!h.notifications.some(n => n[1] === 'error'));
});
test('stale history errors cannot overwrite a newer successful refresh', async () => {
  const requests = [];
  const h = pageOf({ get: () => { const wait = deferred(); requests.push(wait); return wait.promise; } });
  const old = h.refreshSafely(), latest = h.refreshSafely();
  requests[2].resolve({ history: [], total: 0, summary: '' });
  requests[3].resolve({ memories: [] });
  await latest;
  requests[0].reject(new Error('旧请求失败')); requests[1].resolve({ memories: [] });
  await old;
  assert.equal(h.refreshError.value, '');
  assert.deepEqual(h.notifications, []);
});
for (const operation of ['clear', 'delete']) {
  test(`${operation} confirmation cannot act on a newly selected device`, async () => {
    const wait = deferred(), h = pageOf({ confirm: () => wait.promise });
    const pending = operation === 'clear' ? h.clear('all') : h.removeTurn('old-id');
    h.state.currentDeviceId = 'new-device';
    wait.resolve({ confirmed: true });
    await pending;
    assert.deepEqual(h.calls, []);
  });
}
test('dismissed confirmation and unmounted page produce no writes or stale data', async () => {
  const h = pageOf({ confirm: async () => ({ confirmed: false }) });
  await h.clear('all');
  await h.removeTurn('id');
  assert.deepEqual(h.calls, []);
  const wait = deferred(), other = pageOf({ get: () => wait.promise });
  const pending = other.refresh();
  other.unmount();
  wait.resolve({ history: [{ id: 'late' }], total: 1, summary: '', memories: [{ id: 'late' }] });
  await pending;
  assert.deepEqual(other.history.value, []);
  let ran = false;
  other.safeAction(async () => { ran = true; });
  assert.equal(ran, false);
});

test('search availability follows effective chat connection and preserves saved preference', async () => {
  const h = pageOf();
  h.state.config = { ai_config: { api_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1' } };
  h.config.connection = 'analysis';
  h.config.api_url = 'https://api.deepseek.com/v1';
  h.config.web_search_enabled = true;
  assert.equal(h.webSearchAvailable.value, true);
  h.config.connection = 'independent';
  assert.equal(h.webSearchAvailable.value, false);
  await h.save();
  assert.equal(h.calls[0][1].web_search_enabled, true);
  h.config.api_url = 'https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1';
  assert.equal(h.webSearchAvailable.value, true);
  h.config.web_search_enabled = false;
  await h.save();
  assert.equal(h.calls[1][1].web_search_enabled, false);
});
