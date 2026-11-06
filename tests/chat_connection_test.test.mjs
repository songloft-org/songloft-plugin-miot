import assert from 'node:assert/strict';
import test from 'node:test';
import { load, storageOf, chatOf, configOf } from './chat_fixture.mjs';
const { AIClient } = load('../src/ai/client.ts');
const { testChatConnection } = load('../src/chat/connection_test.ts');
const { registerChatHandlers } = load('../src/handlers/chat.ts');
const { createRouter } = load('../../../toolchain/packages/plugin-sdk/src/index.ts');
const draft = configOf({ enabled: false, api_protocol: 'responses', web_search_enabled: true, custom_headers: { 'x-session': 'test-session' } });
const reply = searched => ({
  status: 'completed', output: [
    ...(searched ? [{ type: 'web_search_call', status: 'completed' }] : []),
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '连接正常' }] },
  ]
});

for (const [search, searched, expected] of [[false, false, 'not_requested'], [true, false, 'unconfirmed'], [true, true, 'completed']]) {
  test(`draft connection probe distinguishes search evidence: ${search}/${searched}`, async t => {
    const h = chatOf(t);
    h.chat.client = new AIClient();
    const router = createRouter();
    registerChatHandlers(router, h.config, h.chat);
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async (url, init) => {
      calls++;
      assert.equal(url, 'https://example.test/v1/responses');
      assert.equal(init.headers['x-session'], 'test-session');
      const body = JSON.parse(init.body);
      assert.equal(body.stream, false);
      assert.deepEqual(body.tools, search ? [{ type: 'web_search' }] : undefined);
      return Response.json(reply(searched));
    });
    const before = await h.config.getChatConfig(), values = [...h.values];
    const result = await router.handle({ method: 'POST', path: '/chat/test-connection', query: '', body: JSON.stringify({ config: draft, search }) });
    assert.equal(result.statusCode, 200);
    assert.deepEqual(JSON.parse(result.body), { connected: true, search: expected });
    assert.deepEqual(await h.config.getChatConfig(), before);
    assert.deepEqual([...h.values], values);
    assert.deepEqual(h.calls, [], 'no playback, TTS, or device operations');
    assert.equal(calls, 1);
  });
}

test('shared probe uses default connection credentials and the draft model/protocol', async t => {
  storageOf(t);
  const analysis = { api_url: 'https://shared.test/v1', api_key: 'shared-test', model: 'default', custom_headers: { 'x-session': 'shared-session' } };
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, 'https://shared.test/v1/responses');
    assert.equal(init.headers.Authorization, 'Bearer shared-test');
    assert.equal(init.headers['x-session'], 'shared-session');
    assert.equal(JSON.parse(init.body).model, 'draft-model');
    return Response.json(reply(false));
  });
  assert.equal((await testChatConnection(new AIClient(), { ...draft, connection: 'analysis', model: 'draft-model' }, analysis, false)).connected, true);
});

for (const bad of [undefined, { config: null }, { config: [] }, { config: { api_protocol: 'unknown' } }, { config: draft, search: 'true' }, { config: { ...draft, custom_headers: { Authorization: 'forbidden' } } }]) {
  test('probe rejects invalid draft before sending HTTP: ' + JSON.stringify(bad), async t => {
    const h = chatOf(t), router = createRouter();
    registerChatHandlers(router, h.config, h.chat);
    t.mock.method(globalThis, 'fetch', () => assert.fail('invalid input must not send HTTP'));
    const result = await router.handle({ method: 'POST', path: '/chat/test-connection', query: '', body: JSON.stringify(bad) });
    assert.equal(result.statusCode, 400);
  });
}

for (const updates of [{ web_search_enabled: false }, { api_protocol: 'chat_completions' }, { api_key: '' }, { model: '' }]) {
  test('probe rejects unsupported search or incomplete credentials: ' + JSON.stringify(updates), async t => {
    storageOf(t);
    t.mock.method(globalThis, 'fetch', () => assert.fail('no HTTP expected'));
    await assert.rejects(testChatConnection(new AIClient(), { ...draft, ...updates }, {}, true));
  });
}

test('upstream refusal does not retry and redacts diagnostic headers', async t => {
  storageOf(t);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('network test-session test-only'); });
  await assert.rejects(testChatConnection(new AIClient(), draft, {}, true), error => !/test-session|test-only/.test(error.message));
  assert.equal(calls, 1);
});

test('Responses search completion hooks need a successful terminal response in JSON and SSE', async () => {
  const { readResponsesText, readResponsesStream } = load('../src/ai/responses.ts');
  let completed = 0;
  const done = () => { completed++; };
  readResponsesText(reply(false), done); assert.equal(completed, 0);
  readResponsesText(reply(true), done); assert.equal(completed, 1);
  assert.throws(() => readResponsesText({ ...reply(true), status: 'incomplete' }, done));
  assert.equal(completed, 1);
  const bytes = new TextEncoder().encode('data: ' + JSON.stringify({ type: 'response.completed', response: reply(true) }) + '\n\n');
  await readResponsesStream({ read: async () => bytes }, () => true, () => { }, done);
  assert.equal(completed, 2);
});
