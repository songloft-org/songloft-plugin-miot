import assert from 'node:assert/strict';
import test from 'node:test';
import { loader, deferred, flush } from './chat_loader.mjs';
import { storageOf } from './chat_fixture.mjs';
const load = loader();
const { songMatchScore, normalizeSongMatchThreshold } = load('../src/indexing/song_match.ts');
const { IndexingManager } = load('../src/indexing/manager.ts');
const { MusicCommandService } = load('../src/music/service.ts');
const { ConfigManager } = load('../src/config/manager.ts');
const { registerConfigHandlers } = load('../src/handlers/config.ts');
const { createRouter } = load('../../../toolchain/packages/plugin-sdk/src/index.ts');

test('voice homophones and digits outrank a partial external title without AI', () => {
  for (const query of ['cctv九记录', 'cctv9纪录', 'CCTV9记录']) {
    assert.ok(songMatchScore(query, 'CCTV九纪录') >= 70, query);
    assert.ok(songMatchScore(query, '记录', '轻松频率') < 70, query);
  }
  assert.equal(songMatchScore('到香', '稻香'), 95);
  assert.equal(songMatchScore('红豆', '紅豆'), 100);
  assert.equal(songMatchScore('Love Story', 'Love Story'), 100);
  assert.equal(songMatchScore('周杰伦 稻香', '稻香', '周杰伦'), 100);
  assert.ok(songMatchScore('林俊杰 稻香', '稻香', '周杰伦') < 70);
  assert.ok(songMatchScore('完全不同歌曲', '记录') < 70);
  assert.equal(songMatchScore('', '记录'), 0);
  assert.equal(normalizeSongMatchThreshold(undefined), 70);
  assert.equal(normalizeSongMatchThreshold(NaN), 70);
  assert.equal(normalizeSongMatchThreshold(Infinity), 70);
  assert.equal(normalizeSongMatchThreshold(-1), 0);
  assert.equal(normalizeSongMatchThreshold(101), 100);
});

for (const inPlaylist of [true, false]) {
  test(`voice threshold reaches ${inPlaylist ? 'playlist' : 'standalone'} lookup without changing strict search`, async t => {
    const song = { id: 1933, title: 'CCTV九纪录', artist: '', type: 'radio', url: '/radio' };
    const previous = globalThis.songloft;
    t.after(() => { globalThis.songloft = previous; });
    globalThis.songloft = {
      log: { info() { }, warn() { }, error() { } },
      songs: { list: async () => [song], getById: async () => song },
      playlists: { list: async () => inPlaylist ? [{ id: 1, name: '电台', song_count: 1 }] : [], getSongs: async () => [song] },
    };
    const index = new IndexingManager();
    await index.refresh();
    await index.waitForPlaylistCache();
    assert.deepEqual(index.searchSong('cctv九记录'), []);
    assert.equal(index.searchSong('cctv九记录', 70)[0]?.id, 1933);
    assert.deepEqual(index.searchSong('cctv九记录', 100), []);
    if (inPlaylist) assert.equal((await index.findSongByName('cctv九记录', 70))?.songId, 1933);
    else assert.equal((await index.findStandaloneSongByName('cctv九记录', 70))?.id, 1933);
  });
}

function engine(t, threshold = 70) {
  const previous = globalThis.songloft;
  t.after(() => { globalThis.songloft = previous; });
  globalThis.songloft = { log: { info() { }, warn() { }, error() { } } };
  const service = Object.create(MusicCommandService.prototype);
  service.configManager = { getConfig: async () => ({ song_match_threshold: threshold }) };
  return service;
}

for (const priority of ['LocalFirst', 'ExternalFirst', 'Parallel']) {
  test(`${priority} rejects unrelated topone before importing or playing`, async t => {
    const service = engine(t);
    service.indexingManager = { waitForReady: async () => true, findSongByName: async () => null, findStandaloneSongByName: async () => null };
    service.onlineSearcher = { isExternalSearchConfigured: async () => true, search: async () => ({ title: '记录', artist: '轻松频率' }) };
    service.playSongCandidate = () => assert.fail('rejected result must have no playback/import side effects');
    assert.equal(await service[`executePlaySong${priority}`]('cctv九记录', 'cctv九记录', { title: 'cctv九记录' }, {}, 'a', 'd'), null);
  });
}

test('parallel waits for slower stronger local candidate, ties prefer local, playback failure reuses search results', async t => {
  for (const externalTitle of ['CCTV九记录频道', 'CCTV九纪录']) {
    const service = engine(t), local = deferred(), played = [];
    let searches = 0;
    service.findLocalSongCandidate = () => { searches++; return local.promise; };
    service.findExternalSongCandidate = async () => { searches++; return { source: 'external_search', song: { title: externalTitle, artist: '' } }; };
    service.isCandidateUrlHealthy = async () => true;
    service.playSongCandidate = async candidate => { played.push(candidate.source); return played.length === 1 ? null : { songName: externalTitle }; };
    const result = service.executePlaySongParallel('CCTV九纪录', 'CCTV九纪录', null, {}, 'a', 'd');
    await flush();
    assert.deepEqual(played, []);
    local.resolve({ source: 'local_index', loc: { songTitle: 'CCTV九纪录', artist: '' } });
    assert.ok(await result);
    assert.deepEqual(played, ['local_index', 'external_search']);
    assert.equal(searches, 2);
  }
});

test('parallel higher external score wins even when local returns first', async t => {
  const service = engine(t), played = [];
  service.findLocalSongCandidate = async () => ({ source: 'local_index', loc: { songTitle: 'CCTV九记录频道', artist: '' } });
  service.findExternalSongCandidate = async () => ({ source: 'external_search', song: { title: 'CCTV九纪录', artist: '' } });
  service.isCandidateUrlHealthy = async () => true;
  service.playSongCandidate = async candidate => { played.push(candidate.source); return {}; };
  await service.executePlaySongParallel('CCTV九纪录', 'CCTV九纪录', null, {}, 'a', 'd');
  assert.deepEqual(played, ['external_search']);
});

test('config handler persists and reloads the threshold, including zero and limits', async t => {
  storageOf(t);
  const manager = new ConfigManager(), router = createRouter();
  registerConfigHandlers(router, manager, {}, {}, {}, {});
  const request = async (method, body) => {
    const response = await router.handle({ method, path: '/config', body: body === undefined ? undefined : JSON.stringify(body) });
    assert.equal(response.statusCode, 200);
    return JSON.parse(response.body);
  };
  assert.equal((await new ConfigManager().getConfig()).song_match_threshold, 70);
  assert.equal((await request('GET')).data.song_match_threshold, 70);
  for (const [value, expected] of [[85, 85], [0, 0], [-10, 0], [101, 100], ['bad', 70], [null, 70]]) {
    assert.equal((await request('POST', { song_match_threshold: value })).success, true);
    assert.equal((await new ConfigManager().getConfig()).song_match_threshold, expected);
    assert.equal((await request('GET')).data.song_match_threshold, expected);
  }
});

for (const priority of ['LocalFirst', 'ExternalFirst', 'Parallel']) {
  test(`${priority} forwards voice threshold and falls back from bad external result to local radio`, async t => {
    const service = engine(t), played = [];
    service.indexingManager = {
      waitForReady: async () => true,
      findSongByName: async (query, threshold) => {
        assert.equal(query, 'cctv9记录'); assert.equal(threshold, 70);
        return { songId: 1933, songTitle: 'CCTV九纪录', artist: '' };
      },
    };
    service.onlineSearcher = { isExternalSearchConfigured: async () => true, search: async () => ({ title: '记录', artist: '轻松频率' }) };
    service.isCandidateUrlHealthy = async () => true;
    service.playSongCandidate = async candidate => { played.push(candidate); return { songId: candidate.loc.songId }; };
    const result = await service[`executePlaySong${priority}`]('cctv9记录', 'cctv9记录', { title: 'cctv9记录' }, {}, 'a', 'd');
    assert.equal(result.songId, 1933);
    assert.equal(played.length, 1);
    assert.equal(played[0].source, 'local_index');
  });
}

test('tightening external threshold prevents a formerly accepted homophone from playing', async t => {
  const service = engine(t, 100);
  service.onlineSearcher = { isExternalSearchConfigured: async () => true, search: async () => ({ title: 'CCTV九纪录', artist: '' }) };
  assert.equal(await service.findExternalSongCandidate('cctv九记录', { title: 'cctv九记录' }), null);
  service.configManager.getConfig = async () => ({ song_match_threshold: 70 });
  assert.equal((await service.findExternalSongCandidate('cctv九记录', { title: 'cctv九记录' })).source, 'external_search');
});

test('command preview uses the same voice threshold as actual playback', async t => {
  const service = engine(t, 85);
  service.indexingManager = {
    waitForReady: async () => true,
    findSongByName: async (query, threshold) => {
      assert.equal(query, 'cctv九记录'); assert.equal(threshold, 85);
      return { songTitle: 'CCTV九纪录', playlistName: '电台' };
    },
  };
  assert.equal((await service.previewSearch('play_song', 'cctv九记录')).found, true);
});
