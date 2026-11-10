import assert from 'node:assert/strict';
import test from 'node:test';
import { loader } from './chat_loader.mjs';

const load = loader({
  '@songloft/plugin-sdk': {
    jsonResponse: (value) => value,
    parseQuery: (query) => Object.fromEntries(new URLSearchParams(query)),
  },
  '../utils/http': {
    getHostBaseUrl: () => 'http://speaker.test',
    callHostAPI: async () => ({}),
  },
});
const library = load('../src/player/library_playlist.ts');
const { ALL_SONGS_PLAYLIST_ID: id } = library;
const { PlaylistManager, PlaylistManagerMap } = load(
  '../src/player/manager.ts',
);
const { registerPlaylistHandlers } = load('../src/handlers/playlist.ts');
const { IndexingManager } = load('../src/indexing/manager.ts');
const tracks = [
  {
    id: 1,
    title: '本地歌曲',
    type: 'local',
    duration: 300,
    url: '/api/v1/songs/1/play',
  },
  {
    id: 2,
    title: '电台',
    type: 'radio',
    duration: 300,
    is_live: false,
    url: 'https://radio.test/stream',
  },
  {
    id: 3,
    title: '网络歌曲',
    type: 'remote',
    duration: 300,
    url: '/api/v1/songs/3/play',
  },
];

async function fixture(run) {
  const original = {
    songloft: globalThis.songloft,
    setTimeout,
    clearTimeout,
    random: Math.random,
  };
  let rows = tracks.slice();
  const calls = [],
    pushes = [],
    writes = [],
    progress = [];
  let device = { device_id: 'speaker', playlist_id: 0 };
  const unexpected = async () => {
    throw new Error('Virtual playlist must not access stored playlist members');
  };
  globalThis.songloft = {
    log: { info() {}, warn() {}, error() {}, debug() {} },
    plugin: { getToken: async () => 'fixture-token' },
    songs: {
      list: async (options) => {
        calls.push(options);
        return rows.slice(
          options.offset || 0,
          (options.offset || 0) + options.limit,
        );
      },
      delete: async (songId) => writes.push(['delete', songId]),
    },
    playlists: {
      list: async () => [
        { id: 10, name: '普通歌单', song_count: 1 },
        { id: 11, name: '电台收藏', type: 'radio' },
      ],
      getById: unexpected,
      getSongs: unexpected,
      removeSongs: async (...args) => writes.push(args),
    },
  };
  let nextTimer = 0;
  globalThis.setTimeout = (callback, delay) => {
    if (delay === 500) queueMicrotask(callback);
    return ++nextTimer;
  };
  globalThis.clearTimeout = () => {};
  const config = {
    getConfig: async () => ({ server_host: 'http://speaker.test' }),
    getDevices: async () => [device],
    getDeviceGroups: async () => [],
    updateDevice: async (_account, _device, patch) => {
      device = { ...device, ...patch };
    },
    getPlaylistProgress: async () => progress.at(-1) || null,
    savePlaylistProgress: async (_scope, value) => progress.push(value),
  };
  const service = {
    getPlayState: async () => ({ status: 1, position: 12, duration: 300 }),
    playURL: async (_account, _device, url) => {
      pushes.push(url);
      return true;
    },
    stopPlay: async () => true,
    notifyControl() {},
  };
  const map = new PlaylistManagerMap(service, config);
  const routes = new Map();
  registerPlaylistHandlers(
    {
      get: (path, handler) => routes.set(`GET ${path}`, handler),
      post: (path, handler) => routes.set(`POST ${path}`, handler),
    },
    map,
    service,
    config,
  );
  const request = (route, body = {}, params = {}) =>
    routes.get(route)({ body: JSON.stringify(body), query: '' }, params);
  try {
    await run({
      calls,
      pushes,
      writes,
      progress,
      config,
      service,
      map,
      request,
      setRows: (value) => {
        rows = value;
      },
      device: () => device,
      setDevice: (value) => {
        device = value;
      },
    });
  } finally {
    globalThis.songloft = original.songloft;
    globalThis.setTimeout = original.setTimeout;
    globalThis.clearTimeout = original.clearTimeout;
    Math.random = original.random;
  }
}

test('playlist list exposes a fixed virtual entry and counts songs without radio', () =>
  fixture(async (h) => {
    const response = await h.request('GET /playlists');
    assert.equal(response.success, true);
    assert.deepEqual(response.data[0], {
      id,
      name: '全部歌曲',
      song_count: 2,
      type: 'normal',
      is_virtual: true,
    });
    assert.deepEqual(
      response.data.slice(1).map((p) => p.id),
      [10, 11],
    );
    const songs = await h.request(
      'GET /playlists/:id/songs',
      {},
      { id: String(id) },
    );
    assert.deepEqual(
      songs.data.map((s) => s.id),
      [1, 3],
    );
    h.setRows([...tracks, { ...tracks[0], id: 4 }]);
    assert.equal((await h.request('GET /playlists')).data[0].song_count, 3);
  }));

test('pagination continues through an entire radio page and is independent of voice index limit', () =>
  fixture(async (h) => {
    h.setRows([
      ...Array.from({ length: 1000 }, (_, index) => ({
        ...tracks[1],
        id: index + 1,
      })),
      { ...tracks[0], id: 1001 },
      { ...tracks[2], id: 1002 },
    ]);
    assert.deepEqual(
      (await library.loadAllSongs()).map((s) => s.id),
      [1001, 1002],
    );
    assert.deepEqual(
      h.calls.map((c) => c.offset),
      [0, 1000],
    );
    assert.ok(h.calls.every((c) => c.orderBy === 'id' && c.order === 'asc'));
  }));

test('empty and radio-only libraries remain a valid empty virtual playlist', () =>
  fixture(async (h) => {
    for (const rows of [[], [tracks[1]]]) {
      h.setRows(rows);
      assert.deepEqual(await library.loadAllSongs(), []);
      assert.equal((await h.request('GET /playlists')).data[0].song_count, 0);
      assert.equal(
        (
          await h.request('POST /player/play', {
            account_id: 'account',
            device_id: 'speaker',
            playlist_id: id,
          })
        ).success,
        false,
      );
      assert.equal(h.pushes.length, 0);
    }
  }));

test('web play selects by song ID, persists progress and advances only within songs', () =>
  fixture(async (h) => {
    const result = await h.request('POST /player/play', {
      account_id: 'account',
      device_id: 'speaker',
      playlist_id: id,
      song_id: 3,
      start_index: 0,
      play_mode: 'loop',
    });
    assert.equal(result.success, true);
    const manager = await h.map.getOrCreate('account', 'speaker');
    assert.equal(manager.getStatus().current_song.id, 3);
    assert.equal(manager.getStatus().playlist_name, '全部歌曲');
    assert.equal(h.device().playlist_id, id);
    assert.equal(h.progress.at(-1).playlist_id, id);
    assert.equal(await manager.next(), true);
    assert.equal(manager.getStatus().current_song.id, 1);
    assert.ok(h.pushes.at(-1).includes('/songs/1/play'));
    assert.ok(
      h.pushes.every(
        (url) => !url.includes('/songs/2/') && !url.includes('radio.test'),
      ),
    );
    manager.cleanup();
  }));

test('random start and random next select from the complete music queue', () =>
  fixture(async (h) => {
    Math.random = () => 0.99;
    const result = await h.request('POST /player/play', {
      account_id: 'account',
      device_id: 'speaker',
      playlist_id: id,
      start_position: 'random',
      play_mode: 'random',
    });
    assert.equal(result.success, true);
    const manager = await h.map.getOrCreate('account', 'speaker');
    assert.deepEqual(
      manager.getSongs().map((s) => s.id),
      [1, 3],
    );
    assert.equal(manager.getStatus().current_song.id, 3);
    assert.equal(await manager.next(), true);
    assert.equal(manager.getStatus().current_song.id, 1);
    manager.cleanup();
  }));

test('reload restores the virtual queue and song identity after library membership changes', () =>
  fixture(async (h) => {
    h.setDevice({
      device_id: 'speaker',
      playlist_id: id,
      current_song_index: 0,
      resume_song_id: 3,
      play_mode: 'random',
      play_speed: 1.5,
    });
    const manager = await h.map.getOrCreate('account', 'speaker');
    assert.deepEqual(
      manager.getSongs().map((s) => s.id),
      [1, 3],
    );
    assert.equal(manager.getStatus().current_song.id, 3);
    assert.equal(manager.getStatus().play_mode, 'random');
    assert.equal(manager.getPlaybackSpeed(), 1.5);
    assert.equal(h.pushes.length, 0);
    manager.cleanup();
  }));

test('virtual playlist refuses member removal before any persistent write', () =>
  fixture(async (h) => {
    for (const from_library of [false, true]) {
      const result = await h.request('POST /player/song/remove', {
        playlist_id: id,
        song_id: 1,
        from_library,
      });
      assert.equal(result.success, false);
      assert.match(result.error, /只读/);
    }
    assert.deepEqual(h.writes, []);
  }));

test('schedule and voice lookup resolve the virtual identity and selected starting song', () =>
  fixture(async () => {
    const index = new IndexingManager();
    assert.equal((await index.getPlaylistByIdWithRefresh(id)).songCount, 2);
    assert.equal(
      (await index.findPlaylistByNameWithRefresh('全部歌曲')).id,
      id,
    );
    assert.deepEqual(await index.findSongInPlaylist(id, '网络歌曲'), {
      found: true,
      index: 1,
      songId: 3,
    });
    assert.deepEqual(await index.findSongIndexInPlaylistById(id, 3), {
      found: true,
      index: 1,
    });
    assert.deepEqual(await index.findSongIndexInPlaylistById(id, 2), {
      found: false,
      index: 0,
    });
  }));

test('superseded library loads do not replace the current queue', () =>
  fixture(async (h) => {
    const manager = new PlaylistManager(
      'account',
      'speaker',
      h.service,
      h.config,
    );
    manager.initWithSongs([tracks[0]], 0, 'order', 10);
    let current = true;
    globalThis.songloft.songs.list = async () => {
      current = false;
      return tracks;
    };
    assert.equal(
      await manager.play(id, 0, 'order', { isCurrent: () => current }),
      false,
    );
    assert.deepEqual(
      manager.getSongs().map((s) => s.id),
      [1],
    );
    assert.deepEqual(h.pushes, []);
    manager.cleanup();
  }));
