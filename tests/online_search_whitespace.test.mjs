import assert from 'node:assert/strict';
import test from 'node:test';
import { loader, flush, deferred } from './chat_loader.mjs';
const load = loader({
  '../service/service': {}, '../player/url_builder': {}, '../config/manager': {},
  '../indexing/manager': {}, '../group/coordinator': {}, '../utils/http': {},
});
const { OnlineSearcher } = load('../src/voicecmd/online_searcher.ts');
const song = { title: '山峰山峰 等等我', artist: '小甜甜', url: 'https://music.test/song.mp3' };
const response = (code = 0, data = song) => ({ status: 200, text: async () => JSON.stringify({ code, data }) });
function fixture(t, respond, sources = ['primary'], noImport = false) {
  const previous = globalThis.songloft;
  globalThis.songloft = { log: { info() { }, warn() { }, error() { } } };
  t.after(() => { globalThis.songloft = previous; });
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const request = { url, body: JSON.parse(init.body), headers: init.headers };
    requests.push(request);
    return respond(request, requests.length);
  });
  const searcher = new OnlineSearcher({
    getConfig: async () => ({
      external_search_enabled: true, external_search_timeout: 1, external_search_no_import: noImport,
      external_search_sources: sources.map(name => ({ name, enabled: true, url: `https://${name}.test/search`, token: 'fixture' })),
    })
  });
  return { searcher, requests };
}

test('voice searches request deferred resolution only when results can be imported', async t => {
  const importing = fixture(t, () => response());
  await importing.searcher.search('单车', null);
  assert.equal(importing.requests[0].headers['X-Songloft-Resolve-Url'], 'false');
});

test('voice search in no-import mode keeps requesting direct URLs', async t => {
  const direct = fixture(t, () => response(), ['primary'], true);
  await direct.searcher.search('单车', null);
  assert.equal(direct.requests[0].headers['X-Songloft-Resolve-Url'], undefined);
});

for (const gap of [' ', '  ', '\t', '\n', '\u3000', '\u00a0']) {
  test(`topone miss retries the keyword and hints without whitespace: ${JSON.stringify(gap)}`, async t => {
    const f = fixture(t, ({ body }) => body.keyword === '山峰山峰等等我男生合唱版' ? response() : response(404, null));
    const hint = { title: `山峰山峰等等我${gap}男生合唱版`, artist: `小${gap}甜甜`, duration: 180 };
    assert.deepEqual(await f.searcher.search(hint.title, hint), song);
    assert.equal(f.requests.length, 2);
    assert.deepEqual(f.requests[0].body.hint, { title: '山峰山峰等等我 男生合唱版', artist: '小 甜甜', duration: 180 });
    assert.deepEqual(f.requests[1].body, { keyword: '山峰山峰等等我男生合唱版', hint: { title: '山峰山峰等等我男生合唱版', artist: '小甜甜', duration: 180 }, quality: '320k' });
    assert.equal(hint.title, `山峰山峰等等我${gap}男生合唱版`, 'do not mutate the caller hint');
  });
}

test('English titles and artists retain word boundaries on the first successful request', async t => {
  const f = fixture(t, () => response());
  await f.searcher.search('  Take\t Me  Home  ', { title: 'Take  Me Home', artist: 'John\nDenver' });
  assert.deepEqual(f.requests.map(r => r.body), [{ keyword: 'Take Me Home', hint: { title: 'Take Me Home', artist: 'John Denver' }, quality: '320k' }]);
});

test('artist and playlist keywords retry without inventing title hints', async t => {
  const f = fixture(t, (_r, count) => count % 2 ? response(0, null) : response());
  for (const keyword of ['刘 德华', '抖音 热门榜']) assert.deepEqual(await f.searcher.search(keyword, null), song);
  assert.deepEqual(f.requests.map(r => r.body), ['刘 德华', '刘德华', '抖音 热门榜', '抖音热门榜'].map(keyword => ({ keyword, quality: '320k' })));
});

for (const mode of ['miss', 'network', 'server error', 'parse error']) {
  test(`bounded retry on ${mode}`, async t => {
    const f = fixture(t, () => {
      if (mode === 'network') throw new Error('unavailable');
      if (mode === 'parse error') return { status: 200, text: async () => 'invalid' };
      return response(mode === 'miss' ? 404 : 500, null);
    });
    assert.equal(await f.searcher.search('山峰 等等我', null), null);
    assert.equal(f.requests.length, mode === 'miss' ? 2 : 1);
  });
}

test('unchanged compact keyword is never requested twice', async t => {
  const f = fixture(t, () => response(404, null));
  assert.equal(await f.searcher.search('山峰等等我', null), null);
  assert.equal(f.requests.length, 1);
});

test('blank input does not send external requests', async t => {
  const f = fixture(t, () => response());
  assert.equal(await f.searcher.search(' \t\u3000', null), null);
  assert.deepEqual(f.requests, []);
});

test('sources remain concurrent and retain configured priority through retry', async t => {
  const first = deferred();
  const f = fixture(t, ({ url, body }) => url.includes('primary')
    ? body.keyword.includes(' ') ? first.promise : response()
    : response(0, { ...song, artist: 'backup' }), ['primary', 'backup']);
  const pending = f.searcher.search('山峰 等等我', null);
  await flush();
  assert.equal(f.requests.length, 2);
  first.resolve(response(404, null));
  assert.deepEqual(await pending, song);
  assert.equal(f.requests.length, 3);
});

test('retry shares the original deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const first = deferred();
  const f = fixture(t, (_r, count) => count === 1 ? first.promise : new Promise(() => { }));
  let settled = false;
  const pending = f.searcher.search('山峰 等等我', null).then(result => { settled = true; return result; });
  await flush();
  t.mock.timers.tick(700);
  first.resolve(response(404, null));
  await flush();
  assert.equal(f.requests.length, 2);
  t.mock.timers.tick(300);
  await flush();
  assert.equal(settled, true, 'the retry must not get another full timeout');
  assert.equal(await pending, null);
});

test('successful search clears its deadline timer', async t => {
  const f = fixture(t, () => response());
  const create = globalThis.setTimeout, clear = globalThis.clearTimeout;
  const created = [], cleared = [];
  t.mock.method(globalThis, 'setTimeout', (...args) => { const timer = create(...args); created.push(timer); return timer; });
  t.mock.method(globalThis, 'clearTimeout', timer => { cleared.push(timer); clear(timer); });
  await f.searcher.search('Take Me Home', null);
  assert.equal(created.length, 1);
  assert.deepEqual(cleared, created);
});

test('late miss after timeout cannot launch a retry', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const first = deferred();
  const f = fixture(t, () => first.promise);
  const pending = f.searcher.search('山峰 等等我', null);
  await flush();
  t.mock.timers.tick(1000);
  assert.equal(await pending, null);
  first.resolve(response(404, null));
  await flush();
  assert.equal(f.requests.length, 1);
});
