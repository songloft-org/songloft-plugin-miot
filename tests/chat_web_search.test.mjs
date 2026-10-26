import assert from 'node:assert/strict';
import test from 'node:test';
import { load, storageOf, chatOf } from './chat_fixture.mjs';
import { flush } from './chat_loader.mjs';
const { AIClient } = load('../src/ai/client.ts');
const { ConfigManager } = load('../src/config/manager.ts');
const { isDashScopeEndpoint } = load('../src/utils/ai_url.ts');
const { validateChatConfig, readChatConfig } = load('../src/chat/types.ts');
const official = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const config = { enabled: true, api_url: official, api_key: 'test-only', model: 'qwen-plus', timeout: 30 };

test('search defaults off for fresh and existing configurations; partial saves preserve it', async t => {
  const { values } = storageOf(t), manager = new ConfigManager();
  assert.equal((await manager.getChatConfig()).web_search_enabled, false);
  values.set('chat_config:v1', JSON.stringify({ model: 'old' }));
  assert.equal((await manager.getChatConfig()).web_search_enabled, false);
  assert.equal(readChatConfig({}).web_search_enabled, false);
  await manager.saveChatConfig({ web_search_enabled: true });
  await manager.saveChatConfig({ model: 'new' });
  assert.equal((await new ConfigManager().getChatConfig()).web_search_enabled, true);
  await manager.saveChatConfig({ web_search_enabled: false });
  assert.equal((await manager.getChatConfig()).web_search_enabled, false);
  for (const value of [null, 'true', 0, 1]) assert.throws(() => validateChatConfig({ web_search_enabled: value }));
});

for (const [url, supported] of [
  [official, true], ['https://dashscope-intl.aliyuncs.com/compatible-mode/v1', true],
  ['https://dashscope-us.aliyuncs.com/compatible-mode/v1', true],
  ['https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', true],
  [' https://dashscope.aliyuncs.com ', true],
  ['https://api.deepseek.com/v1', false], ['https://proxy.test/dashscope.aliyuncs.com/v1', false],
  ['https://dashscope.aliyuncs.com.evil.test/v1', false],
  ['https://dashscope.aliyuncs.com@evil.test/v1', false], ['', false],
]) test('official endpoint recognition: ' + url, () => assert.equal(isDashScopeEndpoint(url), supported));

for (const [api_url, kind, webSearch, expected] of [
  [official, 'chat', true, true], [official, 'chat', false, false], [official, 'chat', undefined, false],
  [official, 'summary', true, false], [official, 'memory', true, false],
  ['https://api.deepseek.com/v1', 'chat', true, false],
  ['https://dashscope.aliyuncs.com.evil.test/v1', 'chat', true, false],
  ['https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', 'chat', true, true],
]) test('search request isolation: ' + [api_url, kind, webSearch].join(' '), async t => {
  storageOf(t);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    calls++;
    const body = JSON.parse(init.body);
    assert.equal(Object.hasOwn(body, 'enable_search'), expected);
    if (expected) assert.equal(body.enable_search, true);
    assert.equal(Object.hasOwn(body, 'search_options'), false);
    assert.equal(Object.hasOwn(body, 'extra_body'), false);
    return Response.json({ choices: [{ message: { content: '回答' } }] });
  });
  assert.equal(await new AIClient().request({ ...config, api_url }, [], kind, () => true, '', { webSearch }), '回答');
  assert.equal(calls, 1);
});

for (const connection of ['analysis', 'independent']) test('saved search option reaches chat request via ' + connection, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = chatOf(t, { config: { connection, api_url: official, web_search_enabled: true } });
  h.config.getAIConfig = async () => config;
  h.chat.client = new AIClient();
  let body;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    body = JSON.parse(init.body);
    return Response.json({ choices: [{ message: { content: '搜索后的回答' } }] });
  });
  await h.chat.submit('a', 'd', '今天的新闻', false);
  t.mock.timers.tick(0); await flush();
  assert.equal(body.enable_search, true);
  assert.equal(h.chat.status('a', 'd').phase, 'completed');
  assert.equal(h.chat.status('a', 'd').answer, '搜索后的回答');
});

test('streaming search uses existing SSE progress and cancellation', async t => {
  storageOf(t);
  let reads = 0, cancelled = false, rejectRead;
  const wait = new Promise((_resolve, reject) => { rejectRead = reject; });
  songloft.net = {
    httpStream(_url, init) {
      const body = JSON.parse(init.body);
      assert.equal(body.enable_search, true);
      assert.equal(body.stream, true);
      return {
        response: Promise.resolve({ status: 200, headers: { 'Content-Type': ['text/event-stream'] } }),
        read: async () => ++reads === 1 ? new TextEncoder().encode('data: {"choices":[{"delta":{"content":"部分回答"}}]}\n\n') : wait,
        cancel: async () => { cancelled = true; rejectRead(new Error('cancelled')); }
      };
    }
  };
  const client = new AIClient(), progress = [];
  const pending = client.request(config, [], 'chat', () => true, 'device', { webSearch: true, onProgress: text => progress.push(text) });
  const rejected = assert.rejects(pending, /cancelled/);
  await flush();
  assert.deepEqual(progress, ['部分回答']);
  client.cancelScope('device'); await rejected;
  assert.equal(cancelled, true);
});
