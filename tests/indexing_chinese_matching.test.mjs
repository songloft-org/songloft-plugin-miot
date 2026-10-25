import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const modules = new Map();

function loadSource(url) {
  if (modules.has(url.href)) return modules.get(url.href);
  const { outputText } = ts.transpileModule(readFileSync(url, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  });
  const exports = {};
  modules.set(url.href, exports);
  new Function('require', 'exports', outputText)(name => {
    assert.ok(name.startsWith('.'), `unexpected runtime dependency: ${name}`);
    return loadSource(new URL(`${name}.ts`, url));
  }, exports);
  return exports;
}

const { IndexingManager } = loadSource(new URL('../src/indexing/manager.ts', import.meta.url));

async function createIndex(songs, playlistSongs = new Map([[1, songs]])) {
  globalThis.songloft = {
    log: { info() { }, warn() { }, error() { } },
    songs: {
      list: async () => songs,
      getById: async id => songs.find(song => song.id === id),
    },
    playlists: {
      list: async () => [...playlistSongs].map(([id, tracks]) => ({ id, name: `歌单${id}`, song_count: tracks.length })),
      getSongs: async id => playlistSongs.get(id),
    },
  };
  const manager = new IndexingManager();
  assert.equal((await manager.refresh()).success, true);
  assert.equal(await manager.waitForPlaylistCache(), true);
  return manager;
}

for (const [artist, query] of [
  ['劉德華', '刘德华'],
  ['刘德华', '劉德華'],
  ['劉德华', '刘德華'],
  ['周杰倫', '周杰伦'],
  ['鄧紫棋', '邓紫棋'],
  ['張學友', '张学友'],
]) {
  test(`artist playback matches ${query} against ${artist} and deduplicates playlists`, async () => {
    const songs = [
      { id: 1, title: '第一首', artist },
      { id: 2, title: '第二首', artist },
      { id: 3, title: '其他歌曲', artist: '林俊杰' },
    ];
    const manager = await createIndex(songs, new Map([[1, songs], [2, [songs[0]]]]));
    const matches = manager.findSongsByArtist(query);
    assert.deepEqual(matches.map(song => song.songId), [1, 2]);
    assert.ok(matches.every(song => song.artist === artist));
    assert.deepEqual(manager.findSongsByArtist('刘得华'), []);
  });
}

for (const [title, artist, query] of [
  ['愛你一萬年', '劉德華', '爱你一万年'],
  ['爱你一万年', '刘德华', '愛你一萬年'],
  ['愛你一万年', '劉德華', '刘德华 爱你一萬年'],
  ['後來', '劉若英', '后来'],
  ['發如雪', '周杰倫', '发如雪'],
  ['紅豆', '王菲', '《红豆》'],
]) {
  test(`song search and playlist location match ${query} against ${title}`, async () => {
    const song = { id: 7, title, artist, album: '經典專輯' };
    const manager = await createIndex([song]);
    const matches = manager.searchSong(query);
    assert.equal(matches[0]?.id, song.id);
    assert.equal(matches[0].title, title);
    assert.equal(matches[0].artist, artist);
    assert.equal(matches[0].album, song.album);
    const location = await manager.findSongByName(query);
    assert.equal(location?.songId, song.id);
    assert.equal(location.songTitle, title);
  });
}

test('playlist-local song lookup keeps multi-term matching with traditional titles', async () => {
  const manager = await createIndex([
    { id: 1, title: '萬年', artist: '其他歌手' },
    { id: 2, title: '愛你一萬年', artist: '劉德華' },
  ]);
  assert.deepEqual(await manager.findSongInPlaylist(1, '爱你 万年'), { index: 1, found: true, songId: 2 });
  assert.deepEqual(await manager.findSongInPlaylist(1, '爱你一万年'), { index: 1, found: true, songId: 2 });
});

test('playlist cache fallback matches songs absent from the global index', async () => {
  const song = { id: 1, title: '愛你一萬年', artist: '劉德華' };
  const manager = await createIndex([], new Map([[1, [song]]]));
  assert.equal((await manager.findSongByName('爱你一万年'))?.songId, song.id);
});

test('standalone songs match simplified queries without refreshing again', async () => {
  const song = { id: 1, title: '愛你一萬年', artist: '劉德華', type: 'remote', url: 'https://example.com/song.mp3' };
  const manager = await createIndex([song], new Map());
  globalThis.songloft.songs.list = async () => { assert.fail('matching an indexed song must not refresh'); };
  assert.equal(await manager.findSongByName('爱你一万年'), null);
  assert.deepEqual(await manager.findStandaloneSongByName('爱你一万年'), song);
});

test('imported songs use the same normalization in both index and playlist cache', async () => {
  const manager = await createIndex([]);
  const song = { id: 9, title: '練習', artist: '劉德華', album: '經典' };
  manager.addImportedSong(song, 1);
  assert.equal(manager.searchSong('练习')[0]?.id, song.id);
  assert.equal((await manager.findSongByName('练习'))?.songId, song.id);
  assert.equal(manager.findSongsByArtist('刘德华')[0]?.songId, song.id);
  assert.deepEqual(await manager.findSongInPlaylist(1, '练习'), { index: 0, found: true, songId: 9 });
});

test('literal guard still rejects homophones while preserving Latin and emoji queries', async () => {
  const manager = await createIndex([
    { id: 1, title: '稻香', artist: '周杰倫' },
    { id: 2, title: 'Hello 😀', artist: 'Adele' },
  ]);
  assert.deepEqual(manager.searchSong('到香'), []);
  assert.equal(await manager.findSongByName('到香'), null);
  assert.deepEqual(manager.searchSong('林俊杰 稻香'), []);
  assert.equal(manager.searchSong('HELLO 😀')[0]?.id, 2);
  assert.deepEqual(manager.searchSong(''), []);
  assert.deepEqual(manager.findSongsByArtist('   '), []);
});

test('chained character variants share one search key', async () => {
  const manager = await createIndex([{ id: 1, title: '薴花', artist: '测试歌手' }]);
  for (const query of ['薴花', '苧花', '苎花']) {
    assert.equal(manager.searchSong(query)[0]?.id, 1, query);
    assert.equal((await manager.findSongByName(query))?.songId, 1, query);
  }
});

test('standalone continuation loads exact artists from the library including songs outside playlists', async () => {
  const songs = [
    { id: 1, title: '点播歌曲', artist: '劉德華', type: 'remote', url: '/songs/1', duration: 300 },
    { id: 2, title: '未加入歌单', artist: '刘德华', type: 'local', url: '/songs/2', duration: 250 },
    { id: 3, title: '近似歌手', artist: '刘德华翻唱', url: '/songs/3' },
    { id: 4, title: '电台', artist: '刘德华', type: 'radio', url: '/radio' },
    { id: 5, title: '失效记录', artist: '刘德华', url: '' },
    { id: 6, title: '已删除', artist: '刘德华', url: '/songs/6' },
  ];
  const manager = await createIndex(
    songs,
    new Map([
      [1, [songs[0]]],
      [2, [songs[0]]],
    ]),
  );
  const read = [];
  globalThis.songloft.songs.getById = async (id) => {
    read.push(id);
    if (id === 6) throw new Error('deleted');
    return songs.find((song) => song.id === id);
  };
  assert.deepEqual(
    (await manager.loadLibrarySongsByArtist('刘德华')).map((song) => song.id),
    [1, 2],
  );
  assert.equal(read.filter((id) => id === 1).length, 1);
  assert.ok(!read.includes(3), 'automatic continuation must not use fuzzy artist matches');
  assert.deepEqual(await manager.loadLibrarySongsByArtist(''), []);
});

test('artist queue loading stops after cancellation and limits concurrent detail reads', async () => {
  const songs = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, title: `歌曲${i}`, artist: '歌手', url: '/song' }));
  const manager = await createIndex(songs, new Map());
  let current = true,
    active = 0,
    peak = 0;
  const pending = [];
  globalThis.songloft.songs.getById = async (id) => {
    peak = Math.max(peak, ++active);
    await new Promise((resolve) => pending.push(resolve));
    active--;
    return songs.find((song) => song.id === id);
  };
  const loading = manager.loadLibrarySongsByArtist('歌手', () => current);
  assert.equal(peak, 4);
  current = false;
  pending.forEach((resolve) => resolve());
  assert.deepEqual(await loading, []);
  assert.equal(pending.length, 4, 'cancelled work must not start more bridge requests');
});
