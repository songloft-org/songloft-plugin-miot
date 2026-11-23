import assert from 'node:assert/strict';
import test from 'node:test';
import { loader } from './chat_loader.mjs';
import { storageOf } from './chat_fixture.mjs';
function fixture(t, fetchResponse) {
  storageOf(t);
  const previous = globalThis.fetch;
  globalThis.fetch = fetchResponse;
  t.after(() => {
    globalThis.fetch = previous;
  });
  const load = loader({
    '../utils/http': {
      getHostAPIBaseUrl: async () => 'http://host.test',
      setHostBaseUrl() {},
      callHostAPI() {},
    },
  });
  const { registerConfigHandlers } = load('../src/handlers/config.ts');
  const { ConfigManager } = load('../src/config/manager.ts');
  const { createRouter } = load(
    '../../../toolchain/packages/plugin-sdk/src/index.ts',
  );
  const manager = new ConfigManager(),
    router = createRouter();
  registerConfigHandlers(router, manager, {}, {}, {}, {});
  return {
    manager,
    request: async (body) => {
      const response = await router.handle({
        method: 'POST',
        path: '/search-providers/test',
        body: JSON.stringify(body),
      });
      return { status: response.statusCode, body: JSON.parse(response.body) };
    },
  };
}
test('saved source test uses server credentials and returns provider JSON without playback', async (t) => {
  const calls = [];
  const h = fixture(t, async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      json: async () => ({ code: 200, data: { title: '测试歌曲' } }),
    };
  });
  const config = await h.manager.getConfig();
  await h.manager.saveConfig({
    ...config,
    external_search_sources: [
      {
        id: 'saved',
        name: '测试源',
        enabled: true,
        url: '/api/v1/jsplugin/source/api/search',
        token: 'test-only',
      },
    ],
  });
  const result = await h.request({
    keyword: '  测试  ',
    source_id: 'saved',
    url: 'https://ignored.test',
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.data.data.title, '测试歌曲');
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    'http://host.test/api/v1/jsplugin/source/api/search',
  );
  assert.equal(calls[0].options.headers.Authorization, 'Bearer test-only');
  assert.equal(calls[0].options.headers['X-Songloft-Resolve-Url'], 'false');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    keyword: '测试',
    quality: '320k',
  });
});
test('saved source test requests a direct URL when no-import playback is enabled', async (t) => {
  const h = fixture(t, async (_url, options) => ({
    ok: true,
    json: async () => options.headers,
  }));
  await h.manager.saveConfig({
    ...(await h.manager.getConfig()),
    external_search_no_import: true,
    external_search_sources: [{ id: 'saved', enabled: true, url: 'https://provider.test', token: 'test-only' }],
  });
  const result = await h.request({ keyword: '测试', source_id: 'saved' });
  assert.equal(result.status, 200);
  assert.equal(result.body.data['X-Songloft-Resolve-Url'], undefined);
});
test('unknown or disabled sources and empty queries never issue a request', async (t) => {
  let count = 0;
  const h = fixture(t, async () => {
    count++;
  });
  assert.equal(
    (await h.request({ keyword: '测试', source_id: 'missing' })).status,
    400,
  );
  assert.equal(
    (await h.request({ keyword: '', source_id: 'missing' })).status,
    400,
  );
  assert.equal(count, 0);
});
test('provider failures remain errors instead of displaying a successful test', async (t) => {
  const h = fixture(t, async () => ({ ok: false, status: 503 }));
  const config = await h.manager.getConfig();
  await h.manager.saveConfig({
    ...config,
    external_search_sources: [
      {
        id: 'saved',
        name: '源',
        enabled: true,
        url: 'https://provider.test',
        token: 'test-only',
      },
    ],
  });
  const result = await h.request({ keyword: '测试', source_id: 'saved' });
  assert.equal(result.status, 502);
  assert.equal(result.body.success, false);
  assert.match(result.body.error, /503/);
});
