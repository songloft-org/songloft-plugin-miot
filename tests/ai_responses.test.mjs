import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { load, storageOf, chatOf } from './chat_fixture.mjs';
import { deferred, flush } from './chat_loader.mjs';
const { AIClient } = load('../src/ai/client.ts');
const { readResponsesStream, readResponsesText } = load('../src/ai/responses.ts');
const { ConfigManager } = load('../src/config/manager.ts');
const { validateChatConfig, chatConnection, readChatConfig } = load('../src/chat/types.ts');
const { aiResponsesUrl } = load('../src/utils/ai_url.ts');
const config = { enabled: true, api_protocol: 'responses', api_url: 'https://custom.test/v1', api_key: 'test-only', model: 'model', timeout: 5, custom_headers: { 'x-session': 'session-only' } };
const message = text => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
const response = (text = '回答') => ({ status: 'completed', output: [message(text)] });
const encode = s => new TextEncoder().encode(s);
const event = frame => 'data: ' + JSON.stringify(frame) + '\n\n';
const complete = text => event({ type: 'response.completed', response: response(text) });
const delta = text => event({ type: 'response.output_text.delta', delta: text });

for (const [base, expected] of [
  ['https://model.test', 'https://model.test/v1/responses'],
  [' https://model.test/v1/ ', 'https://model.test/v1/responses'],
  ['https://model.test/custom/v1', 'https://model.test/custom/v1/responses'],
  ['https://ark.cn-beijing.volces.com/api/v3', 'https://ark.cn-beijing.volces.com/api/v3/responses'],
  ['https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', 'https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/responses'],
]) test('Responses URL ' + base, () => assert.equal(aiResponsesUrl(base), expected));

test('protocol defaults and saved migration preserve existing connections', async t => {
  storageOf(t);
  const manager = new ConfigManager();
  assert.equal(readChatConfig({}).api_protocol, 'chat_completions');
  await manager.saveChatConfig({ api_protocol: 'responses' });
  await manager.saveChatConfig({ model: 'custom' });
  assert.equal((await new ConfigManager().getChatConfig()).api_protocol, 'responses');
  for (const api_protocol of [null, true, '', 'auto']) assert.throws(() => validateChatConfig({ api_protocol }));
});

for (const kind of ['chat', 'summary', 'memory']) test('Responses wire format, headers and search isolation: ' + kind, async t => {
  storageOf(t);
  let calls = 0;
  const messages = [{ role: 'system', content: '人设' }, { role: 'assistant', content: '以前回答' }, { role: 'user', content: '问题' }];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls++;
    assert.equal(url, 'https://custom.test/v1/responses');
    assert.equal(init.headers['x-session'], 'session-only');
    assert.equal(init.headers.Authorization, 'Bearer test-only');
    const body = JSON.parse(init.body);
    assert.deepEqual(body.input, messages);
    assert.equal(body.store, false);
    assert.equal(body.stream, false);
    assert.equal(body.max_output_tokens, kind === 'chat' ? 8192 : 4096);
    for (const key of ['enable_search', 'enable_thinking', 'messages', 'max_tokens', 'previous_response_id']) assert.ok(!Object.hasOwn(body, key));
    assert.deepEqual(body.tools, kind === 'chat' ? [{ type: 'web_search' }] : undefined);
    return Response.json(response());
  });
  assert.equal(await new AIClient().request(config, messages, kind, () => true, '', { webSearch: true }), '回答');
  assert.equal(calls, 1);
});

test('Responses search disabled adds no tools, including official DashScope', async t => {
  storageOf(t);
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.ok(!Object.hasOwn(body, 'tools'));
    assert.ok(!Object.hasOwn(body, 'enable_thinking'));
    return Response.json(response());
  });
  await new AIClient().request({ ...config, api_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen3.7-flash' }, [], 'chat');
});

for (const connection of ['analysis', 'independent']) test('saved protocol reaches actual chat request: ' + connection, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = chatOf(t, { config: { connection, ...config, web_search_enabled: true } });
  h.config.getAIConfig = async () => ({ ...config, api_protocol: undefined });
  assert.equal(chatConnection(await h.config.getChatConfig(), await h.config.getAIConfig()).api_protocol, 'responses');
  h.chat.client = new AIClient();
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.match(url, /\/responses$/);
    assert.deepEqual(JSON.parse(init.body).tools, [{ type: 'web_search' }]);
    return Response.json(response());
  });
  await h.chat.submit('a', 'd', '今天天气', false);
  t.mock.timers.tick(0); await flush();
  assert.equal(h.chat.status('a', 'd').phase, 'completed');
  assert.equal(h.chat.status('a', 'd').answer, '回答');
});

for (const [name, value, expected] of [
  ['assistant only', { status: 'completed', output: [{ type: 'reasoning', content: [{ type: 'output_text', text: '秘密' }] }, { ...message('用户'), role: 'user' }, { type: 'web_search_call', status: 'completed' }, message('正文')] }, '正文'],
  ['multiple messages', { output: [message('甲'), message('乙')] }, '甲乙'],
  ['top-level compatibility', { output_text: '正文' }, '正文'],
  ['bounded', response('字'.repeat(17000)), '字'.repeat(16000)],
]) test('Responses JSON ' + name, () => assert.equal(readResponsesText(value), expected));
for (const value of [null, {}, response(' '), { status: 'failed', output_text: '部分' }, { status: 'incomplete', output_text: '部分' }, { error: { message: 'secret' }, output_text: '文本' }, { output: [{ type: 'function_call' }, message('部分')] }, { output: [{ type: 'message', content: [{ type: 'refusal', refusal: '拒绝' }] }] }])
  test('Responses invalid or unfinished output is rejected: ' + JSON.stringify(value), () => assert.throws(() => readResponsesText(value)));

test('Responses SSE handles byte-split UTF-8, tool/reasoning events and terminal snapshot without duplicating text', async () => {
  const wire = encode(event({ type: 'response.reasoning_text.delta', delta: '秘密' }) + event({ type: 'response.web_search_call.completed' }) + delta('中文') + delta('回答') + complete('中文回答'));
  let i = 0;
  const progress = [];
  const result = await readResponsesStream({ read: async () => i < wire.length ? wire.slice(i, ++i) : null }, () => true, text => progress.push(text));
  assert.equal(result, '中文回答');
  assert.deepEqual(progress, ['中文', '中文回答']);
});
for (const [name, wire] of [
  ['EOF after delta', delta('部分')],
  ['done text is not terminal', delta('部分') + event({ type: 'response.output_text.done', text: '部分' })],
  ['incomplete', delta('部分') + event({ type: 'response.incomplete', response: { status: 'incomplete' } })],
  ['failed', delta('部分') + event({ type: 'response.failed', response: { status: 'failed' } })],
  ['error', event({ type: 'error', message: 'secret' })],
  ['invalid delta', event({ type: 'response.output_text.delta', delta: {} })],
  ['invalid JSON', 'data: broken\n\n'],
  ['DONE is not Responses completion', delta('部分') + 'data: [DONE]\n\n'],
]) test('Responses SSE rejects ' + name, async () => {
  let sent = false;
  await assert.rejects(readResponsesStream({ read: async () => sent ? null : (sent = true, encode(wire)) }, () => true, () => { }));
});

test('Responses final snapshot works without deltas and stops reading immediately', async () => {
  const progress = [];
  const result = await readResponsesStream({ read: async () => encode(complete('完整回答')) }, () => true, text => progress.push(text));
  assert.equal(result, '完整回答'); assert.deepEqual(progress, ['完整回答']);
});

test('Responses cancellation releases the stream, preserves progress and redacts secrets', async t => {
  storageOf(t);
  const wait = deferred(), progress = [];
  let reads = 0, cancelled = 0;
  songloft.net = {
    httpStream(_url, init) {
      assert.equal(JSON.parse(init.body).stream, true);
      assert.equal(init.headers['x-session'], 'session-only');
      return {
        response: Promise.resolve({ status: 200, headers: { 'Content-Type': ['text/event-stream'] } }),
        read: async () => ++reads === 1 ? encode(delta('部分')) : wait.promise,
        cancel: async () => { cancelled++; wait.reject(new Error('cancelled test-only session-only')); }
      };
    }
  };
  const client = new AIClient();
  const pending = client.request(config, [], 'chat', () => true, 'device', { onProgress: text => progress.push(text) });
  const rejected = assert.rejects(pending, error => /cancelled/.test(error.message) && !/test-only|session-only/.test(error.message));
  await flush();
  assert.deepEqual(progress, ['部分']);
  client.cancelScope('device'); await rejected;
  assert.ok(cancelled > 0);
});

test('Responses stream interrupted by cancellation never reads a late answer', async () => {
  let current = true;
  await assert.rejects(readResponsesStream({ read: async () => { current = false; return encode(complete('迟到')); } }, () => current, () => assert.fail()), /取消/);
});

for (const contentType of ['application/json', 'text/event-stream']) test('real HTTP transport ' + contentType + ' keeps one request and does not fall back', async t => {
  storageOf(t);
  let calls = 0, mode = 'ok';
  const server = createServer(async (req, res) => {
    calls++;
    assert.equal(req.url, '/custom/v1/responses');
    let raw = ''; for await (const chunk of req) raw += chunk;
    assert.deepEqual(JSON.parse(raw).tools, [{ type: 'web_search' }]);
    res.setHeader('Content-Type', contentType);
    if (mode === '404') { res.statusCode = 404; res.end('{}'); return; }
    res.end(contentType === 'application/json' ? JSON.stringify(response()) : delta('回答') + complete('回答'));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const local = { ...config, api_url: `http://127.0.0.1:${server.address().port}/custom/v1` };
  // Adapt Node's real streaming fetch to the host HTTPStream contract.
  songloft.net = {
    httpStream(url, init) {
      const abort = new AbortController();
      let reader;
      const response = fetch(url, { ...init, signal: abort.signal }).then(res => {
        reader = res.body.getReader();
        return { status: res.status, headers: Object.fromEntries([...res.headers].map(([key, value]) => [key, [value]])) };
      });
      return { response, read: async () => { const result = await reader.read(); return result.done ? null : result.value; }, cancel: async () => abort.abort() };
    }
  };
  const client = new AIClient();
  assert.equal(await client.request(local, [], 'chat', () => true, '', { webSearch: true }), '回答');
  assert.equal(calls, 1);
  mode = '404';
  await assert.rejects(client.request(local, [], 'chat', () => true, '', { webSearch: true }), /404/);
  assert.equal(calls, 2);
});

for (const terminal of ['completed', 'incomplete', 'failed']) test('Responses chat lifecycle and TTS: ' + terminal, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = chatOf(t, { config: { ...config, web_search_enabled: true } });
  const wait = deferred();
  let reads = 0, cancelled = false;
  songloft.net = {
    httpStream() {
      return {
        response: Promise.resolve({ status: 200, headers: { 'Content-Type': ['text/event-stream'] } }),
        read: async () => ++reads === 1 ? encode(delta('部分回答')) : wait.promise,
        cancel: async () => { cancelled = true; }
      };
    }
  };
  h.chat.client = new AIClient();
  await h.chat.submit('a', 'd', '测试');
  t.mock.timers.tick(0); await flush();
  assert.equal(h.chat.status('a', 'd').answer, '部分回答');
  assert.ok(!h.calls.some(call => call[0] === 'speak'));
  wait.resolve(encode(terminal === 'completed' ? complete('完整回答') : event({ type: 'response.' + terminal, response: { status: terminal } })));
  await flush();
  assert.equal(h.chat.status('a', 'd').phase, terminal === 'completed' ? 'completed' : 'failed');
  assert.equal(h.chat.status('a', 'd').answer, terminal === 'completed' ? '完整回答' : '部分回答');
  assert.deepEqual(h.calls.filter(call => call[0] === 'speak').map(call => call[2]), [terminal === 'completed' ? '完整回答' : '抱歉，暂时无法回答，请稍后再试。']);
  assert.equal(cancelled, true);
});

test('Responses timeout cancels the active upstream without retrying', async t => {
  storageOf(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0, cancelled = false;
  songloft.net = {
    httpStream() {
      calls++;
      return { response: new Promise(() => { }), read: async () => null, cancel: async () => { cancelled = true; } };
    }
  };
  const client = new AIClient();
  const pending = client.request(config, [], 'chat');
  const rejected = assert.rejects(pending, /timed out/);
  await flush(); t.mock.timers.tick(5000); await rejected;
  assert.equal(cancelled, true); assert.equal(calls, 1);
});

for (const item of [
  { type: 'web_search_call', status: 'failed' },
  { ...message('未完'), status: 'incomplete' },
]) test('completed response rejects unfinished output: ' + item.type, () => {
  assert.throws(() => readResponsesText({ status: 'completed', output: [item, message('回答')] }), /未正常完成/);
});

test('Responses terminal snapshots allow bounded reasoning records larger than chat delta events', async () => {
  const final = response();
  final.output.unshift({ type: 'reasoning', summary: [{ type: 'summary_text', text: '思考'.repeat(18000) }] });
  const wire = encode(event({ type: 'response.completed', response: final }));
  assert.ok(wire.length > 65536);
  assert.equal(await readResponsesStream({ read: async () => wire }, () => true, () => { }), '回答');
  const oversized = encode(event({ type: 'response.reasoning_text.delta', delta: 'x'.repeat(262145) }));
  await assert.rejects(readResponsesStream({ read: async () => oversized }, () => true, () => { }), /长度限制/);
});
