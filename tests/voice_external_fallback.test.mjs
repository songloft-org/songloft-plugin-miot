import assert from 'node:assert/strict';
import test from 'node:test';
import { loader } from './chat_loader.mjs';

const load = loader({
  '../playback/voice_resume': {},
  '../playback/sleep_timer': {},
  '../config/manager': {},
  '../account/manager': {},
  '../service/service': {},
  '../player/manager': { resolvePlaylistResumeStart: async () => null },
  '../indexing/manager': {},
  '../group/coordinator': {},
  '../player/url_builder': {
    playbackOptionsOf: config => ({ forceMP3: config.force_mp3 }),
    URLBuilder: { buildSongURL: async song => `http://host${song.url}` },
  },
  '../voicecmd/ai_analyzer': {},
  '../handlers/playlist': {},
  '../utils/http': {
    getHostAPIBaseUrl: async () => 'http://host',
    getHostBaseUrl: async () => 'http://host',
  },
  '../utils/favorites': {},
  '../memory': {},
  '../sleep_timer': {},
});
const { MusicCommandService } = load('../src/music/service.ts');
const { OnlineSearcher } = load('../src/voicecmd/online_searcher.ts');
const song = { title: '忘情水', artist: '刘德华', url: 'https://source/song.mp3', duration: 240 };

function fixture(t, options = {}) {
  const previous = { songloft: globalThis.songloft, fetch: globalThis.fetch };
  t.after(() => { Object.assign(globalThis, previous); });
  const requests = [], pushes = [], speech = [], localPlays = [], queuePlays = [], events = [];
  const config = {
    search_priority: options.priority || 'parallel',
    external_search_enabled: options.enabled ?? true,
    external_search_sources: [
      { name: 'topone', enabled: true, url: 'https://topone/search', token: 'fixture-token' },
      { name: 'backup', enabled: true, url: 'https://backup/search', token: 'fixture-token' },
    ],
    external_search_timeout: 0.01,
    external_search_no_import: options.noImport || false,
    external_search_playlist_id: options.append || '',
    interrupt_tts_hint_enabled: false,
  };
  globalThis.songloft = {
    log: { info() { }, warn() { }, error() { } },
    plugin: { getToken: async () => 'fixture-token' },
    playlists: { getSongs: async () => options.localSongs || [] },
  };
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push({ url, body });
    if (url.endsWith('/search')) {
      if (options.searchError) throw new Error('source unavailable');
      if (options.whitespaceMiss && /\s/.test(body.keyword)) return { status: 200, text: async () => JSON.stringify({ code: 404, data: null }) };
      return { status: 200, text: async () => JSON.stringify({ code: 0, data: options.miss || (options.firstMiss && url.includes('topone')) ? null : song }) };
    }
    if (url === 'http://host/api/v1/songs/remote') {
      events.push('import');
      if (options.importError) throw new Error('import unavailable');
      return { text: async () => JSON.stringify({ songs: [{ id: 42, url: '/api/v1/songs/42/play' }] }) };
    }
    if (url === 'http://host/api/v1/playlists/7/songs') return {};
    assert.fail(`unexpected URL ${url}`);
  };
  const pm = {
    isPlaying: () => false,
    hasPlaylist: () => options.active || false,
    next: async () => { localPlays.push('next'); return true; },
    prepareForNewPlayback: () => events.push('prepare'),
    setAnnounceOnSongChange() { },
    getPrimary: () => ({ account_id: 'account', device_id: 'speaker' }),
    play: async (...args) => { localPlays.push(args); return true; },
    playPlaylistFromSong: async (...args) => { localPlays.push(args); return true; },
    playWithSongs: async (...args) => { localPlays.push(args); return true; },
    playStandaloneSong: async (track, index) => {
      assert.equal(index, engine.indexingManager);
      queuePlays.push(track); events.push('queue'); return options.playOK ?? true;
    },
    getCurrentSong: () => options.localSongs?.[0],
  };
  const engine = Object.create(MusicCommandService.prototype);
  engine.cancelPendingResume = () => events.push('cancel');
  engine.configManager = { getConfig: async () => config, getDevices: async () => [] };
  engine.playlistManagerMap = { get: () => pm, getOrCreate: async () => pm };
  engine.minaService = {
    stopPlay: async () => { events.push('stop'); return true; },
    textToSpeech: async (_account, _device, text) => speech.push(text),
    playURL: async (...args) => { events.push('push'); pushes.push(args); return options.playOK ?? true; },
  };
  engine.indexingManager = {
    isIndexReady: () => options.ready ?? true,
    waitForReady: async () => options.ready ?? true,
    refresh: async () => ({ success: options.ready ?? true }),
    waitForPlaylistCache: async () => true,
    isPlaylistCacheReady: () => true,
    findSongsByArtist: () => options.artistLocs || [],
    findSongByName: async () => null,
    findStandaloneSongByName: async () => null,
    findPlaylistByNameWithRefresh: async () => options.playlist || null,
    searchPlaylist: () => options.defaults || [],
    getStatus: () => ({ ready: true, playlist_count: 0, is_refreshing: false }),
    addImportedSong: (...args) => events.push(['index', ...args]),
  };
  engine.onlineSearcher = new OnlineSearcher(engine.configManager);
  return { engine, requests, pushes, speech, localPlays, queuePlays, events };
}

async function execute(engine, action, name, entry = 'ai') {
  if (entry === 'rule') {
    return engine.executeCommand({ command: { type: action }, keyword: '播放', argument: name }, 'account', 'speaker');
  }
  return engine.executeAIResult({ action, params: { [action === 'play_artist' ? 'artist' : 'playlist']: name }, confidence: 'high' }, 'account', 'speaker');
}

for (const [action, name] of [['play_artist', '刘德华'], ['play_playlist', '抖音热门榜']]) {
  for (const entry of ['ai', 'rule']) {
    for (const priority of ['local_first', 'external_first', 'parallel']) {
      test(`${entry} ${action} falls back to import and push (${priority})`, async t => {
        const f = fixture(t, { priority, firstMiss: true });
        const played = await execute(f.engine, action, name, entry);
        const searches = f.requests.filter(r => r.url.endsWith('/search'));
        assert.equal(searches.length, 2);
        for (const r of searches) assert.deepEqual(r.body, { keyword: name, quality: '320k' });
        assert.equal(f.requests.filter(r => r.url.endsWith('/songs/remote')).length, 1);
        assert.deepEqual(f.pushes, []);
        assert.deepEqual(f.queuePlays, [{ ...song, id: 42, url: '/api/v1/songs/42/play', type: 'remote' }]);
        assert.deepEqual(f.speech, []);
        assert.equal(f.events.filter(e => e === 'prepare').length, 1);
        assert.equal(f.events.filter(e => e === 'stop').length, 1);
        assert.ok(f.events.indexOf('import') < f.events.indexOf('queue'));
        assert.equal(f.events.filter(e => Array.isArray(e) && e[0] === 'index').length, 1);
        if (action === 'play_artist') assert.deepEqual(played, { songName: song.title, artist: song.artist });
      });
    }
  }
  for (const failure of ['disabled', 'miss', 'searchError', 'importError', 'playError']) {
    test(`${action} reports failure: ${failure}`, async t => {
      const f = fixture(t, { enabled: failure !== 'disabled', [failure]: true, playOK: failure !== 'playError' });
      await execute(f.engine, action, name);
      assert.equal(f.speech.length, 1);
      assert.ok(f.speech[0].includes(name));
      if (failure === 'disabled') assert.deepEqual(f.requests, []);
      if (['disabled', 'miss', 'searchError', 'importError'].includes(failure)) assert.deepEqual(f.pushes, []);
    });
  }
  test(`${action} keeps no-import playback in a temporary queue without importing`, async t => {
    const f = fixture(t, { noImport: true });
    await execute(f.engine, action, name);
    assert.equal(f.requests.filter(r => !r.url.endsWith('/search')).length, 0);
    assert.deepEqual(f.pushes, []);
    assert.equal(f.queuePlays[0].id, 0);
    assert.equal(f.queuePlays[0].url, song.url);
    assert.deepEqual(f.speech, []);
  });
  test(`${action} passes the player for configured playlist continuation`, async t => {
    const f = fixture(t, { append: '7' });
    await execute(f.engine, action, name);
    assert.ok(f.requests.some(r => r.url.endsWith('/playlists/7/songs')));
    assert.deepEqual(f.localPlays, [[7, 42, 'order']]);
    assert.deepEqual(f.pushes, []);
    assert.deepEqual(f.speech, []);
  });
  test(`${action} still searches externally when the index is unavailable`, async t => {
    const f = fixture(t, { ready: false });
    await execute(f.engine, action, name);
    assert.equal(f.queuePlays.length, 1);
    assert.deepEqual(f.speech, []);
  });
}

test('artist suffix is removed before external search', async t => {
  const f = fixture(t);
  await execute(f.engine, 'play_artist', '刘德华的歌曲');
  assert.equal(f.requests[0].body.keyword, '刘德华');
});

test('artist cache hit with no loadable songs falls back externally', async t => {
  const f = fixture(t, { artistLocs: [{ playlistId: 7, songId: 9 }] });
  await execute(f.engine, 'play_artist', '刘德华');
  assert.equal(f.queuePlays.length, 1);
});

test('local artist songs keep random playback without external requests', async t => {
  const localSongs = [{ id: 9, title: '本地歌曲', artist: '刘德华' }];
  const f = fixture(t, { artistLocs: [{ playlistId: 7, songId: 9 }], localSongs });
  await execute(f.engine, 'play_artist', '刘德华');
  assert.deepEqual(f.requests, []);
  assert.deepEqual(f.localPlays, [[localSongs, 0, 'random', '歌手: 刘德华', '刘德华']]);
});

test('local playlist hit keeps playlist playback without external requests', async t => {
  const f = fixture(t, { playlist: { id: 7, name: '抖音热门榜', songCount: 2 } });
  await execute(f.engine, 'play_playlist', '抖音热门榜');
  assert.deepEqual(f.requests, []);
  assert.deepEqual(f.localPlays, [[7, 0, 'order']]);
});

test('empty named playlist falls back externally', async t => {
  const f = fixture(t, { playlist: { id: 7, name: '抖音热门榜', songCount: 0 } });
  await execute(f.engine, 'play_playlist', '抖音热门榜');
  assert.equal(f.queuePlays.length, 1);
  assert.deepEqual(f.localPlays, []);
});

test('empty playlist argument resumes the active playlist without searching', async t => {
  const f = fixture(t, { active: true });
  await f.engine.executePlayPlaylist('', 'account', 'speaker');
  assert.deepEqual(f.requests, []);
  assert.deepEqual(f.localPlays, ['next']);
});

test('empty playlist argument with no defaults does not search an empty keyword', async t => {
  const f = fixture(t);
  await f.engine.executePlayPlaylist('', 'account', 'speaker');
  assert.deepEqual(f.requests, []);
});

test('empty artist argument does not trigger external search', async t => {
  const f = fixture(t);
  await f.engine.executePlayArtist('的歌曲', 'account', 'speaker');
  assert.deepEqual(f.requests, []);
});

test('search preview explains the external fallback without executing it', async t => {
  const f = fixture(t);
  for (const [type, name] of [['play_artist', '刘德华'], ['play_playlist', '抖音热门榜']]) {
    const preview = await f.engine.previewSearch(type, name);
    assert.equal(preview.found, false);
    assert.ok(preview.detail.includes('外部搜索'));
  }
  assert.deepEqual(f.requests, []);
});

for (const priority of ['local_first', 'external_first', 'parallel']) {
  for (const entry of ['ai', 'rule']) {
    test(`${entry} play_song imports and pushes after whitespace retry (${priority})`, async t => {
      const f = fixture(t, { priority, whitespaceMiss: true });
      const name = '山峰山峰等等我 男生合唱版';
      if (entry === 'ai') {
        await f.engine.executeAIResult({ action: 'play_song', params: { name }, confidence: 'high' }, 'account', 'speaker');
      } else {
        await f.engine.executeCommand({ command: { type: 'play_song' }, keyword: '播放', argument: name }, 'account', 'speaker');
      }
      const searches = f.requests.filter(r => r.url.endsWith('/search'));
      assert.equal(searches.length, 4);
      assert.deepEqual(searches.slice(2).map(r => r.body), [0, 1].map(() => ({ keyword: name.replace(/\s/g, ''), hint: { title: name.replace(/\s/g, '') }, quality: '320k' })));
      assert.equal(f.requests.filter(r => r.url.endsWith('/songs/remote')).length, 1);
      assert.equal(f.queuePlays[0].url, '/api/v1/songs/42/play');
      assert.deepEqual(f.speech, []);
      assert.equal(f.events.filter(e => e === 'prepare').length, 1);
      assert.equal(f.events.filter(e => e === 'stop').length, 1);
    });
  }
}
