import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const ts = require('typescript');

function loadSource(path, dependencies) {
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

const aiUrl = loadSource('../src/utils/ai_url.ts', {});
const aiRequest = loadSource('../src/utils/ai_request.ts', {});
const { AIAnalyzer } = loadSource('../src/voicecmd/ai_analyzer.ts', {
  '../utils/ai_url': aiUrl,
  '../utils/ai_request': aiRequest,
  '../utils/ai_thinking': loadSource('../src/utils/ai_thinking.ts', { './ai_url': aiUrl }),
});

// Global songloft stub for logging in tests
globalThis.songloft = {
  log: {
    info: () => { },
    warn: () => { },
    error: () => { },
  },
};

const analyzer = new AIAnalyzer();

// Case 1: Pure JSON (standard)
{
  const raw = '{"action":"resume","params":{},"confidence":"high","rawText":"继续播放"}';
  const res = analyzer.parseResponse(raw);
  assert.equal(res.action, 'resume');
  assert.equal(res.confidence, 'high');
  assert.equal(res.rawText, '继续播放');
}

// Case 2: Wrapped in ```json ... ``` codeblock (Gemini / Claude / Antigravity proxy)
{
  const raw = '```json\n{"action":"unknown","params":{},"confidence":"high","rawText":"太吵了小点声"}\n```';
  const res = analyzer.parseResponse(raw);
  assert.equal(res.action, 'unknown');
  assert.equal(res.confidence, 'high');
  assert.equal(res.rawText, '太吵了小点声');
}

// Case 3: Codeblock with leading / trailing explanatory text
{
  const raw = 'Here is the analysis result:\n```json\n{"action":"set_play_mode","params":{"mode":"random"},"confidence":"high","rawText":"随机播放"}\n```\nHope it helps!';
  const res = analyzer.parseResponse(raw);
  assert.equal(res.action, 'set_play_mode');
  assert.equal(res.params.mode, 'random');
  assert.equal(res.confidence, 'high');
}

// Case 4: Output containing reasoning / thinking tags
{
  const raw = '<think>用户说太吵了，应该降低音量或者属于未分类指令</think>\n```json\n{"action":"unknown","params":{},"confidence":"medium","rawText":"太吵了"}\n```';
  const res = analyzer.parseResponse(raw);
  assert.equal(res.action, 'unknown');
  assert.equal(res.confidence, 'medium');
}

console.log('All AIAnalyzer parseResponse tests passed!');

const config = {
  enabled: true,
  api_url: 'https://api.example.com/v1',
  api_key: 'test-key',
  model: 'gpt-5',
  timeout: 6,
};
const analysis = { action: 'resume', params: {}, confidence: 'high', rawText: '继续播放' };

function successResponse() {
  return Response.json({ choices: [{ message: { content: JSON.stringify(analysis) }, finish_reason: 'stop' }] });
}

for (const model of ['gpt-5', 'gpt-5-mini', 'gpt-5-nano', 'gpt-5-2025-08-07', 'gpt-5.1', 'gpt-5.2', 'openai/gpt-5', 'GPT-5', 'gpt-6', 'gpt-6-astra', 'gpt-6.1-sol', 'openai/gpt-6', 'custom-reasoning-model']) {
  test(`${model}: sends a request accepted by a reasoning-model endpoint`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const requests = [];
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      const body = JSON.parse(options.body);
      requests.push({ url, options, body });
      if (Object.hasOwn(body, 'max_tokens')) {
        return Response.json({ error: { message: "Unsupported parameter: 'max_tokens'. Use 'max_completion_tokens' instead." } }, { status: 400 });
      }
      if (Object.hasOwn(body, 'temperature')) {
        return Response.json({ error: { message: "Unsupported parameter: 'temperature'" } }, { status: 400 });
      }
      return successResponse();
    });

    assert.deepEqual(await analyzer.strictAnalyze('继续播放', { ...config, model }), analysis);
    assert.equal(requests.length, 1);
    const { url, options, body } = requests[0];
    assert.equal(url, 'https://api.example.com/v1/chat/completions');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers.Authorization, 'Bearer test-key');
    assert.equal(options.headers['X-Fetch-Timeout-Ms'], '6000');
    assert.equal(body.model, model);
    assert.equal(Object.hasOwn(body, 'max_completion_tokens'), false);
    assert.equal(Object.hasOwn(body, 'max_tokens'), false);
    assert.equal(Object.hasOwn(body, 'temperature'), false);
    assert.deepEqual(body.response_format, { type: 'json_object' });
    assert.equal(body.messages[1].content, '用户指令：继续播放');
    assert.equal(Object.hasOwn(body, 'extra_body'), false);
    assert.equal(Object.hasOwn(body, 'enable_thinking'), false);
  });
}

for (const [model, api_url] of [
  ['gpt-4o', config.api_url],
  ['deepseek-chat', 'https://api.deepseek.com/v1'],
  ['Qwen/Qwen3-32B', 'https://api.siliconflow.cn/v1'],
  ['gpt-50', config.api_url],
]) {
  test(`${model}: uses compatible-provider defaults and preserves provider-specific options`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let body;
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
      body = JSON.parse(options.body);
      return successResponse();
    });
    assert.deepEqual(await analyzer.analyze('继续播放', { ...config, model, api_url }), analysis);
    assert.equal(Object.hasOwn(body, 'max_tokens'), false);
    assert.equal(Object.hasOwn(body, 'temperature'), false);
    assert.equal(Object.hasOwn(body, 'max_completion_tokens'), false);
    assert.equal(Object.hasOwn(body, 'enable_thinking'), false);
    if (api_url === 'https://api.siliconflow.cn/v1') {
      assert.deepEqual(body.extra_body, { reasoning_split: true });
    } else {
      assert.equal(Object.hasOwn(body, 'extra_body'), false);
    }
  });
}

for (const status of [400, 401, 429, 500]) {
  test(`HTTP ${status}: strict mode reports the error and silent mode returns null`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    t.mock.method(globalThis, 'fetch', async () => Response.json({ error: { message: 'upstream error' } }, { status }));
    await assert.rejects(analyzer.strictAnalyze('继续播放', config), new RegExp(`API error: ${status}.*upstream error`));
    assert.equal(await analyzer.analyze('继续播放', config), null);
  });
}

test('network failures retain strict and silent error handling', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('network unavailable'); });
  await assert.rejects(analyzer.strictAnalyze('继续播放', config), /network unavailable/);
  assert.equal(await analyzer.analyze('继续播放', config), null);
});

test('configured timeout still bounds the GPT-5 request', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(globalThis, 'fetch', () => new Promise(() => { }));
  const pending = analyzer.strictAnalyze('继续播放', config);
  const rejected = assert.rejects(pending, /AI API call timed out/);
  t.mock.timers.tick(config.timeout * 1000);
  await rejected;
});

test('disabled or incomplete configuration skips the request', async t => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { assert.fail('must not call the API'); });
  for (const overrides of [{ enabled: false }, { api_url: '' }, { api_key: '' }]) {
    assert.equal(await analyzer.strictAnalyze('继续播放', { ...config, ...overrides }), null);
    assert.equal(await analyzer.analyze('继续播放', { ...config, ...overrides }), null);
  }
  assert.equal(fetchMock.mock.callCount(), 0);
});

for (const api_url of [
  'https://dashscope.aliyuncs.com/compatible-mode/v1',
  'https://dashscope.aliyuncs.com/compatible-mode/v1/',
  'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
  'https://dashscope-us.aliyuncs.com/compatible-mode/v1',
  'https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
]) {
  test(`issue 122: ${api_url} disables thinking in the raw JSON request`, async t => {
    let request;
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      request = { url, headers: options.headers, body: JSON.parse(options.body) };
      // 模拟百炼默认思考需要长于预算；只有正确透传开关才能及时返回。
      if (request.body.enable_thinking !== false) return new Promise(() => { });
      return successResponse();
    });
    assert.deepEqual(await analyzer.strictAnalyze('继续播放', {
      ...config, api_url, model: 'qwen3.7-flash-2026-07-15', timeout: 20,
    }), analysis);
    assert.equal(request.url, `${api_url.replace(/\/+$/, '')}/chat/completions`);
    assert.equal(request.headers['X-Fetch-Timeout-Ms'], '20000');
    assert.equal(Object.hasOwn(request.body, 'extra_body'), false);
  });
}

for (const model of ['qwen-flash', 'qwen-plus', 'qwen-plus-latest', 'qwen-plus-2025-04-28', 'qwen-flash-2025-07-28', 'qwen3.5-flash', 'qwen3.6-plus-2026-04-02', 'qwen3.7-plus', 'qwen3.7-max-2026-06-08', 'qwen3.8-max']) {
  test(`${model}: known DashScope hybrid models disable thinking`, async t => {
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
      assert.equal(JSON.parse(options.body).enable_thinking, false);
      return successResponse();
    });
    assert.deepEqual(await analyzer.strictAnalyze('继续播放', {
      ...config, api_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model,
    }), analysis);
  });
}

for (const [model, api_url] of [
  ['qwen3.7-flash-2026-07-15', config.api_url],
  ['qwen3.7-flash', 'https://dashscope.aliyuncs.com.example.org/v1'],
  ['qwen3.7-flash', 'https://proxy.example.com/dashscope.aliyuncs.com/v1'],
  ['qwen3.7-flash', 'https://dashscope.aliyuncs.com@proxy.example.com/v1'],
  ['qwen3.7-max-preview', 'https://dashscope.aliyuncs.com/compatible-mode/v1'],
  ['qwen3.7-max-2026-05-17', 'https://dashscope.aliyuncs.com/compatible-mode/v1'],
  ['qwen3-235b-a22b-thinking-2507', 'https://dashscope.aliyuncs.com/compatible-mode/v1'],
  ['deepseek-r1', 'https://dashscope.aliyuncs.com/compatible-mode/v1'],
  ['qwen-plus-2025-01-25', 'https://dashscope.aliyuncs.com/compatible-mode/v1'],
  ['qwen-max', 'https://dashscope.aliyuncs.com/compatible-mode/v1'],
]) {
  test(`${model} at ${api_url}: preserves defaults for other providers and thinking-only models`, async t => {
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
      assert.equal(Object.hasOwn(JSON.parse(options.body), 'enable_thinking'), false);
      return successResponse();
    });
    assert.deepEqual(await analyzer.strictAnalyze('继续播放', { ...config, api_url, model }), analysis);
  });
}

test('analysis diagnostics include timing, status and usage without request or response text', async t => {
  const logs = [];
  t.mock.method(songloft.log, 'info', line => logs.push(line));
  t.mock.method(globalThis, 'fetch', async () => Response.json({
    choices: [{ message: { content: JSON.stringify(analysis), reasoning_content: 'private reasoning' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 12, completion_tokens: 34, completion_tokens_details: { reasoning_tokens: 5 } },
  }));
  await analyzer.strictAnalyze('private voice query', config);
  const diagnostic = logs.join('\n');
  assert.match(diagnostic, /kind=analysis.*start.*timeout_ms=6000.*model=gpt-5.*thinking_disabled=false/);
  assert.match(diagnostic, /response status=200 elapsed_ms=\d+/);
  assert.match(diagnostic, /finish_reason=stop.*reasoning_chars=17.*prompt_tokens=12.*completion_tokens=34.*reasoning_tokens=5/);
  assert.match(diagnostic, /completed status=200 elapsed_ms=\d+/);
  for (const privateValue of ['test-key', 'private voice query', 'private reasoning', '继续播放']) {
    assert.ok(!diagnostic.includes(privateValue));
  }
  const ids = logs.map(line => line.match(/\bid=(\d+)/)?.[1]).filter(Boolean);
  assert.equal(new Set(ids).size, 1);
});

test('fallback parse failures report lengths without logging model text', async t => {
  const logs = [];
  t.mock.method(songloft.log, 'warn', line => logs.push(line));
  assert.throws(() => analyzer.parseResponse('{private response}'), /Failed to parse AI response/);
  assert.match(logs.join('\n'), /content_chars=18/);
  assert.ok(!logs.join('\n').includes('private response'));
});
