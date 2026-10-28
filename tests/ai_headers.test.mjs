import assert from 'node:assert/strict';
import test from 'node:test';
import { loader } from './chat_loader.mjs';
import { storageOf } from './chat_fixture.mjs';

const load = loader();
const { AIClient } = load('../src/ai/client.ts');
const { ConfigManager } = load('../src/config/manager.ts');
const { chatConnection, validateChatConfig } = load('../src/chat/types.ts');
const { registerChatHandlers } = load('../src/handlers/chat.ts');
const { registerConfigHandlers } = load('../src/handlers/config.ts');
const { registerVoiceCommandHandlers } = load('../src/handlers/voice_command.ts');
const { createRouter } = load('../../../toolchain/packages/plugin-sdk/src/index.ts');
const config = { enabled: true, api_url: 'https://gateway.test/v1', api_key: 'test-only', model: 'test', timeout: 6 };
const custom_headers = { 'x-opencode-session': '11111111-2222-4333-8444-555555555555', 'x-api-key': 'private-header-key' };
const answer = { choices: [{ message: { content: '回答' } }] };
function routes() {
  const manager = new ConfigManager(), router = createRouter();
  registerConfigHandlers(router, manager, {}, {}, {}, {});
  registerVoiceCommandHandlers(router, manager, {}, {});
  registerChatHandlers(router, manager, { cancelAll: async () => { }, configurationChanged() { } });
  return {
    manager, request: async (method, path, body) => {
      const result = await router.handle({ method, path, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: result.statusCode, body: JSON.parse(result.body) };
    }
  };
}
test('default and independent headers persist, clear and follow the effective chat connection', async t => {
  storageOf(t);
  const h = routes();
  assert.equal((await h.request('POST', '/config', { ai_config: { ...config, custom_headers } })).body.success, true);
  assert.deepEqual((await new ConfigManager().getAIConfig()).custom_headers, custom_headers);
  await h.request('PUT', '/chat/config', { custom_headers: { 'x-session': 'independent' }, api_url: 'https://other.test/v1', api_key: 'other' });
  let chat = await new ConfigManager().getChatConfig();
  assert.deepEqual(chatConnection(chat, await h.manager.getAIConfig()).custom_headers, custom_headers);
  await h.request('PUT', '/chat/config', { connection: 'independent' });
  chat = await new ConfigManager().getChatConfig();
  assert.deepEqual(chatConnection(chat, await h.manager.getAIConfig()).custom_headers, { 'x-session': 'independent' });
  await h.request('POST', '/config', { ai_config: { custom_headers: {} } });
  await h.request('PUT', '/chat/config', { custom_headers: {} });
  assert.deepEqual((await new ConfigManager().getAIConfig()).custom_headers, {});
  assert.deepEqual((await new ConfigManager().getChatConfig()).custom_headers, {});
});
for (const custom_headers of [null, [], 'bad', { bad: 1 }, { 'bad name': 'x' }, { 'x-key': 'private\r\nInjected: value' }, { 'x-key': 'bad\0value' }, { 'x-key': 'a', 'X-Key': 'b' }, ...['authorization', 'CONTENT-TYPE', 'Host', 'Content-Length', 'Transfer-Encoding', 'Connection', 'x-fetch-timeout-ms'].map(key => ({ [key]: 'override' }))]) {
  test(`invalid headers rejected without replacing persisted config: ${JSON.stringify(custom_headers)}`, async t => {
    storageOf(t);
    const h = routes();
    await h.request('POST', '/config', { ai_config: { ...config, custom_headers: { 'x-good': 'keep' } } });
    await h.request('PUT', '/chat/config', { custom_headers: { 'x-good': 'keep' } });
    assert.equal((await h.request('POST', '/config', { ai_config: { custom_headers } })).body.success, false);
    assert.equal((await h.request('PUT', '/chat/config', { custom_headers })).status, 400);
    assert.deepEqual((await h.manager.getAIConfig()).custom_headers, { 'x-good': 'keep' });
    assert.deepEqual((await h.manager.getChatConfig()).custom_headers, { 'x-good': 'keep' });
  });
}
for (const kind of ['chat', 'summary', 'memory']) {
  test(`${kind} sends configured headers in the ordinary HTTP transport`, async t => {
    storageOf(t);
    t.mock.method(globalThis, 'fetch', async (_url, init) => {
      for (const [key, value] of Object.entries(custom_headers)) assert.equal(init.headers[key], value);
      assert.equal(init.headers.Authorization, 'Bearer test-only');
      assert.equal(init.headers['Content-Type'], 'application/json');
      return Response.json(answer);
    });
    assert.equal(await new AIClient().request({ ...config, custom_headers }, [{ role: 'user', content: '问' }], kind), '回答');
  });
}
test('streaming chat sends the same configured headers', async t => {
  storageOf(t);
  songloft.net = {
    httpStream: (_url, init) => {
      assert.equal(init.headers['x-opencode-session'], custom_headers['x-opencode-session']);
      assert.equal(init.headers['x-api-key'], custom_headers['x-api-key']);
      assert.equal(init.headers.Authorization, 'Bearer test-only');
      let read = false;
      return { response: Promise.resolve({ status: 200, headers: { 'Content-Type': ['application/json'] } }), read: async () => read ? null : (read = true, new TextEncoder().encode(JSON.stringify(answer))), cancel: async () => { } };
    }
  };
  assert.equal(await new AIClient().request({ ...config, custom_headers }, [{ role: 'user', content: '问' }], 'chat'), '回答');
});
test('both model-list routes and command analysis use their configured connection headers', async t => {
  storageOf(t);
  const h = routes(), requests = [];
  await h.manager.saveAIConfig({ ...config, custom_headers });
  await h.manager.saveChatConfig({ connection: 'independent', ...config, custom_headers: { 'x-opencode-session': 'independent-session' } });
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requests.push({ url, init });
    return Response.json(init.method === 'GET' ? { data: [{ id: 'test' }] } : { choices: [{ message: { content: '{"action":"resume","params":{},"confidence":"high"}' } }] });
  });
  assert.equal((await h.request('GET', '/voice-commands/models')).body.success, true);
  assert.equal((await h.request('GET', '/chat/models')).body.models[0].id, 'test');
  assert.equal((await h.request('POST', '/voice-commands/ai-test', { query: '继续' })).body.success, true);
  assert.equal(requests[0].init.headers['x-opencode-session'], custom_headers['x-opencode-session']);
  assert.equal(requests[1].init.headers['x-opencode-session'], 'independent-session');
  assert.equal(requests[1].init.headers['x-api-key'], undefined);
  assert.equal(requests[2].init.headers['x-opencode-session'], custom_headers['x-opencode-session']);
});
test('custom header credentials are redacted from upstream errors and logs', async t => {
  const { logs } = storageOf(t);
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('rejected private-header-key'); });
  await assert.rejects(new AIClient().request({ ...config, custom_headers }, [], 'chat'), error => !error.message.includes('private-header-key'));
  assert.ok(!JSON.stringify(logs).includes('private-header-key'));
});
test('old configurations without headers remain valid', async t => {
  storageOf(t);
  assert.deepEqual(validateChatConfig({}).custom_headers, {});
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    assert.equal(init.headers['x-opencode-session'], undefined);
    return Response.json(answer);
  });
  assert.equal(await new AIClient().request(config, [], 'chat'), '回答');
});
