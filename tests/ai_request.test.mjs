import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const ts = require('typescript');
function loadSource(path, dependencies = {}) {
  const { outputText } = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  });
  const exports = {};
  new Function('require', 'exports', outputText)(name => {
    assert.ok(Object.hasOwn(dependencies, name), `unexpected dependency: ${name}`);
    return dependencies[name];
  }, exports);
  return exports;
}
const aiRequest = loadSource('../src/utils/ai_request.ts');
const { requestAI } = aiRequest;

globalThis.songloft = { log: { info: () => { }, warn: () => { } } };
const endpoint = 'https://api.example.com/v1/models';
const options = { method: 'GET', headers: { Authorization: 'Bearer private-api-key' } };
const context = { kind: 'models' };
const read = response => response.json();

for (const [timeout, expected] of [[undefined, 6000], [0, 6000], [-1, 6000], [NaN, 6000], [Infinity, 6000], [0.1, 1000], [1, 1000], [6, 6000], [20, 20000], [30, 30000], [60, 30000]]) {
  test(`timeout ${timeout}: uses the same effective JS and HTTP deadline (${expected}ms)`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    t.mock.method(globalThis, 'fetch', (_url, init) => {
      assert.equal(init.headers['X-Fetch-Timeout-Ms'], String(expected));
      assert.equal(init.headers.Authorization, options.headers.Authorization);
      return new Promise(() => { });
    });
    const pending = requestAI(endpoint, options, timeout, context, read);
    const rejected = assert.rejects(pending, /AI API call timed out/);
    let done = false;
    pending.catch(() => { done = true; });
    t.mock.timers.tick(expected - 1);
    await Promise.resolve();
    assert.equal(done, false);
    t.mock.timers.tick(1);
    await rejected;
  });
}

for (const outcome of ['success', 'network error', 'parse error', 'timeout']) {
  test(`${outcome}: clears its timer exactly once`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const clear = t.mock.method(globalThis, 'clearTimeout');
    t.mock.method(globalThis, 'fetch', async () => {
      if (outcome === 'timeout') return new Promise(() => { });
      if (outcome === 'network error') throw new Error('network unavailable');
      if (outcome === 'parse error') return new Response('invalid JSON');
      return Response.json({ data: [] });
    });
    const pending = requestAI(endpoint, options, 6, context, read);
    if (outcome === 'success') {
      assert.deepEqual(await pending, { data: [] });
    } else {
      const rejected = assert.rejects(pending);
      if (outcome === 'timeout') t.mock.timers.tick(6000);
      await rejected;
    }
    assert.equal(clear.mock.callCount(), 1);
    assert.ok(clear.mock.calls[0].arguments[0] !== undefined);
  });
}

test('the deadline also bounds response parsing', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(globalThis, 'fetch', async () => Response.json({ data: [] }));
  const pending = requestAI(endpoint, options, 6, context, () => new Promise(() => { }));
  const rejected = assert.rejects(pending, /AI API call timed out/);
  await Promise.resolve();
  t.mock.timers.tick(6000);
  await rejected;
});

test('a late response after the deadline is not parsed or logged as a success', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let resolveFetch;
  t.mock.method(globalThis, 'fetch', () => new Promise(resolve => { resolveFetch = resolve; }));
  const logs = [];
  t.mock.method(songloft.log, 'info', line => logs.push(line));
  const pending = requestAI(endpoint, options, 6, context, () => assert.fail('late response must not be parsed'));
  const rejected = assert.rejects(pending, /AI API call timed out/);
  t.mock.timers.tick(6000);
  await rejected;
  resolveFetch(Response.json({ data: [] }));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(logs.length, 1);
  assert.match(logs[0], /start/);
});

test('host HTTP timeout errors have the same helpful message as JS timeout errors', async t => {
  const logs = [];
  t.mock.method(songloft.log, 'warn', line => logs.push(line));
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('context deadline exceeded'); });
  await assert.rejects(requestAI(endpoint, options, 20, { kind: 'analysis', model: 'qwen3.7-flash' }, read), /AI API call timed out \(20s，模型 qwen3\.7-flash\).*非思考模型/);
  assert.match(logs[0], /failed status=unavailable elapsed_ms=\d+/);
});

test('HTTP errors preserve status, redact credentials and correlate diagnostics', async t => {
  const url = 'https://user:password@api.example.com/v1/models?token=private-token#private-hash';
  const logs = [];
  t.mock.method(songloft.log, 'info', line => logs.push(line));
  t.mock.method(songloft.log, 'warn', line => logs.push(line));
  t.mock.method(globalThis, 'fetch', async () => new Response('denied', { status: 401 }));
  await assert.rejects(requestAI(url, options, 6, context, async response => {
    throw new Error(`API error: ${response.status} private-api-key ${url}`);
  }), error => {
    assert.match(error.message, /API error: 401/);
    for (const secret of ['private-api-key', 'password', 'private-token', 'private-hash']) {
      assert.ok(!error.message.includes(secret));
    }
    return true;
  });
  const diagnostic = logs.join('\n');
  assert.match(diagnostic, /response status=401 elapsed_ms=\d+/);
  assert.match(diagnostic, /failed status=401 elapsed_ms=\d+/);
  assert.ok(!diagnostic.includes('completed'));
  for (const secret of ['private-api-key', 'password', 'private-token', 'private-hash']) {
    assert.ok(!diagnostic.includes(secret));
  }
  const ids = logs.map(line => line.match(/\bid=(\d+)/)[1]);
  assert.equal(new Set(ids).size, 1);
});

test('an HTTP error mentioning a timeout parameter keeps its actual status and reason', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('unsupported timeout parameter', { status: 400 }));
  await assert.rejects(requestAI(endpoint, options, 6, context, async response => {
    throw new Error(`API error: ${response.status} ${await response.text()}`);
  }), /API error: 400 unsupported timeout parameter/);
});

test('network diagnostics redact URLs normalized by the host or containing redirect targets', async t => {
  const logs = [];
  t.mock.method(songloft.log, 'info', line => logs.push(line));
  t.mock.method(songloft.log, 'warn', line => logs.push(line));
  const url = 'https://user:password@api.example.com/v1/models?token=private-token#private-hash';
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Get "https://api.example.com/v1/models?token=private-token": redirect to https://other:redirect-password@gateway.example.com/models?secret=redirect-secret#redirect-hash failed: connection refused');
  });
  await assert.rejects(requestAI(url, options, 6, context, read), error => {
    assert.match(error.message, /api\.example\.com\/v1\/models/);
    assert.match(error.message, /gateway\.example\.com\/models/);
    assert.match(error.message, /connection refused/);
    logs.push(error.message);
    return true;
  });
  const diagnostic = logs.join('\n');
  for (const secret of ['private-token', 'private-hash', 'password', 'redirect-secret', 'redirect-hash']) {
    assert.ok(!diagnostic.includes(secret));
  }
});

const aiUrl = loadSource('../src/utils/ai_url.ts');
const aiThinking = loadSource('../src/utils/ai_thinking.ts', { './ai_url': aiUrl });
const aiAnalyzer = loadSource('../src/voicecmd/ai_analyzer.ts', {
  '../utils/ai_url': aiUrl, '../utils/ai_request': aiRequest, '../utils/ai_thinking': aiThinking,
});
const { registerVoiceCommandHandlers } = loadSource('../src/handlers/voice_command.ts', {
  '@songloft/plugin-sdk': { jsonResponse: data => data },
  '../utils/ai_url': aiUrl,
  '../utils/ai_request': aiRequest,
  '../voicecmd/ai_analyzer': aiAnalyzer,
});

function registerRoutes() {
  const routes = new Map();
  const router = {
    get: (path, handler) => routes.set(`GET ${path}`, handler),
    post: (path, handler) => routes.set(`POST ${path}`, handler),
  };
  registerVoiceCommandHandlers(router, {
    getAIConfig: async () => ({
      enabled: false, api_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      api_key: 'private-api-key', model: 'qwen3.7-flash-2026-07-15', timeout: 20,
    }),
  }, {}, {});
  return routes;
}

test('model-list and analysis routes use the shared deadline and preserve their response shape', async t => {
  const routes = registerRoutes();
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requests.push({ url, init });
    const body = init.method === 'GET'
      ? { data: [{ id: 'qwen3.7-flash-2026-07-15', owned_by: 'system' }] }
      : { choices: [{ message: { content: '{"action":"resume","params":{},"confidence":"high","rawText":"继续"}' }, finish_reason: 'stop' }] };
    // 使用与 QuickJS 相同的普通响应对象，避免不小心依赖 Response 类。
    return { ok: true, status: 200, json: async () => body };
  });
  assert.deepEqual(await routes.get('GET /voice-commands/models')({}), {
    success: true, data: { models: [{ id: 'qwen3.7-flash-2026-07-15', ownedBy: 'system' }], modelCount: 1 },
  });
  const result = await routes.get('POST /voice-commands/ai-test')({ body: '{"query":"继续"}' });
  assert.equal(result.success, true);
  assert.equal(result.data.action, 'resume');
  assert.equal(typeof result.elapsed_ms, 'number');
  assert.equal(JSON.parse(requests[1].init.body).enable_thinking, false);
  assert.equal(requests[0].url, 'https://dashscope.aliyuncs.com/compatible-mode/v1/models');
  assert.equal(requests[1].url, 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions');
  assert.ok(requests.every(request => request.init.headers['X-Fetch-Timeout-Ms'] === '20000'));
});

for (const route of ['GET /voice-commands/models', 'POST /voice-commands/ai-test']) {
  test(`${route}: HTTP deadline failures become an actionable route error`, async t => {
    const routes = registerRoutes();
    t.mock.method(globalThis, 'fetch', async () => { throw new Error('context deadline exceeded'); });
    const result = await routes.get(route)({ body: '{"query":"继续"}' });
    assert.equal(result.success, false);
    assert.match(result.error, route.startsWith('GET') ? /请求超时/ : /AI API call timed out \(20s，模型 qwen3\.7-flash-2026-07-15\)/);
  });
}

test('model-list route retains its 404 endpoint hint', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('not found', { status: 404 }));
  const result = await registerRoutes().get('GET /voice-commands/models')({});
  assert.equal(result.success, false);
  assert.match(result.error, /未找到模型列表端点.*dashscope\.aliyuncs\.com\/compatible-mode\/v1\/models/);
});
