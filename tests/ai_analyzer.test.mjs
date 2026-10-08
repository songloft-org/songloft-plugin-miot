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
const { AIAnalyzer } = loadSource('../src/voicecmd/ai_analyzer.ts', { '../utils/ai_url': aiUrl });

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
    assert.equal(body.model, model);
    assert.equal(Object.hasOwn(body, 'max_completion_tokens'), false);
    assert.equal(Object.hasOwn(body, 'max_tokens'), false);
    assert.equal(Object.hasOwn(body, 'temperature'), false);
    assert.deepEqual(body.response_format, { type: 'json_object' });
    assert.equal(body.messages[1].content, '用户指令：继续播放');
    assert.equal(Object.hasOwn(body, 'extra_body'), false);
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
