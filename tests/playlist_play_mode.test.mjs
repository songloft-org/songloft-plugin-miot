import assert from 'node:assert/strict';
import test from 'node:test';
import { deferred, loader } from './chat_loader.mjs';

const load = loader({
  '@songloft/plugin-sdk': {
    jsonResponse: value => value,
    parseQuery: query => Object.fromEntries(new URLSearchParams(query)),
  },
  '../utils/http': {
    getHostBaseUrl: () => 'http://speaker.test',
    callHostAPI: async () => ({}),
  },
});
const { ConfigManager } = load('../src/config/manager.ts');
const { PlaylistManagerMap } = load('../src/player/manager.ts');
const { registerPlaylistHandlers } = load('../src/handlers/playlist.ts');
const { MusicCommandService } = load('../src/music/service.ts');
const { TaskExecutor } = load('../src/schedule/executor.ts');

const account = 'account';
const speaker = 'speaker';
const peer = 'peer';
const scope = 'account:speaker';
const book = { id: 10, name: '有声书', labels: ['audiobook'], sort_by: 'title', sort_order: 'desc', songCount: 2 };
const music = { id: 11, name: '音乐', labels: [], songCount: 2 };

async function fixture(run) {
  const original = { songloft: globalThis.songloft, setTimeout, clearTimeout };
  const storage = new Map(Object.entries({
    config: JSON.stringify({ server_host: 'http://speaker.test' }),
    accounts: JSON.stringify([{ id: account, devices: [
      { device_id: speaker, play_mode: 'random' },
      { device_id: peer, play_mode: 'loop' },
    ] }]),
  }));
  const routes = new Map();
  const pushes = [];
  const sorts = [];
  const track = id => ({ id, type: 'local', title: String(id), duration: 300, url: '/api/v1/songs/' + id + '/play' });
  globalThis.songloft = {
    log: { info() {}, warn() {}, error() {}, debug() {} },
    plugin: { getToken: async () => 'fixture-token' },
    storage: {
      get: async key => storage.get(key),
      set: async (key, value) => { storage.set(key, value); },
    },
    playlists: {
      getById: async id => id === book.id ? book : music,
      getSongs: async (id, options) => {
        sorts.push(options);
        return (id === book.id ? [32, 21] : [41, 42]).map(track);
      },
    },
  };
  globalThis.setTimeout = () => 1;
  globalThis.clearTimeout = () => {};
  const service = {
    getPlayState: async () => ({ status: 1, position: 12, duration: 300 }),
    playURLs: async (targets, url) => {
      pushes.push({ targets, url });
      return targets.map(() => true);
    },
    stopPlay: async () => true,
    notifyControl() {},
  };
  const config = new ConfigManager();
  const map = new PlaylistManagerMap(service, config);
  registerPlaylistHandlers({
    get: (path, handler) => routes.set('GET ' + path, handler),
    post: (path, handler) => routes.set('POST ' + path, handler),
  }, map, service, config);
  const request = (route, body = {}) => routes.get(route)({
    body: JSON.stringify({ account_id: account, device_id: speaker, ...body }),
    query: '',
  });
  try {
    await run({ storage, sorts, pushes, config, map, service, request });
  } finally {
    map.cleanup();
    Object.assign(globalThis, original);
  }
}

test('web defaults an audiobook to its configured order and stops after its last episode', () =>
  fixture(async ({ map, pushes, request, sorts }) => {
    const result = await request('POST /player/play', { playlist_id: book.id });
    assert.equal(result.success, true);
    assert.equal(result.data.play_mode, 'order');
    assert.equal(result.data.current_song.id, 32);
    assert.equal(sorts[0].sort, 'title');
    assert.equal(sorts[0].order, 'desc');

    const manager = await map.getOrCreate(account, speaker);
    await manager.advanceToNext();
    assert.match(pushes.at(-1).url, /\/songs\/21\/play/);
    await manager.advanceToNext();
    assert.equal(manager.getStatus().state, 'stopped');
    assert.equal(pushes.length, 2);
  }));

test('web remembers all five modes by playlist and restores the chapter ID on continue', () =>
  fixture(async ({ config, pushes, request }) => {
    const play = (fields) => request('POST /player/play', fields);
    const first = await play({ playlist_id: music.id });
    assert.equal(first.data.play_mode, 'random');
    for (const mode of ['order', 'loop', 'single', 'random', 'singlePlay']) {
      await play({ playlist_id: book.id, song_id: 21, start_index: 0 });
      const before = await config.getPlaylistProgress(scope, book.id);
      const playCount = pushes.length;
      assert.equal((await request('POST /player/mode', { play_mode: mode })).success, true);
      assert.equal(pushes.length, playCount);
      assert.deepEqual(await config.getPlaylistProgress(scope, book.id), { ...before, play_mode: mode });
      assert.equal((await play({ playlist_id: music.id })).data.play_mode, 'random');
      const resumed = await play({ playlist_id: book.id, start_position: 'resume' });
      assert.equal(resumed.data.play_mode, mode);
      assert.equal(resumed.data.current_song.id, 21);
    }
  }));

test('natural completion honors options restored from progress', () =>
  fixture(async ({ config, map, pushes }) => {
    const manager = await map.getOrCreate(account, speaker);
    const cases = [
      { mode: 'loop', from: 1, next: 32 },
      { mode: 'single', from: 0, next: 32 },
      { mode: 'random', from: 0, next: 21 },
      { mode: 'singlePlay', from: 0, next: null },
    ];
    for (const { mode, from, next } of cases) {
      await config.savePlaylistProgress(scope, {
        playlist_id: book.id, song_id: 32, song_index: 0, position_sec: 0, updated_at: Date.now(), play_mode: mode,
      });
      assert.equal(await manager.play(book.id, from), true);
      const playCount = pushes.length;
      await manager.advanceToNext();
      if (next === null) {
        assert.equal(pushes.length, playCount);
        assert.equal(manager.getStatus().state, 'paused');
      } else {
        assert.equal(pushes.length, playCount + 1);
        assert.match(pushes.at(-1).url, new RegExp('/songs/' + next + '/play'));
      }
    }
  }));

test('legacy progress keeps its chapter, and reload prefers saved modes with a device fallback', () =>
  fixture(async ({ config, request, service }) => {
    await config.savePlaylistProgress(scope, {
      playlist_id: book.id, song_id: 21, song_index: 0, position_sec: 75, updated_at: Date.now(),
    });
    const resumed = await request('POST /player/play', { playlist_id: book.id, start_position: 'resume' });
    assert.equal(resumed.data.play_mode, 'order');
    assert.equal(resumed.data.current_song.id, 21);
    await config.updateDevice(account, speaker, { play_mode: 'random', resume_state: '' });

    const reloaded = new PlaylistManagerMap(service, new ConfigManager());
    try {
      assert.equal((await reloaded.getOrCreate(account, speaker)).getStatus().play_mode, 'order');
    } finally {
      reloaded.cleanup();
    }

    await config.removePlaylistProgress(scope, book.id);
    const legacy = new PlaylistManagerMap(service, new ConfigManager());
    try {
      assert.equal((await legacy.getOrCreate(account, speaker)).getStatus().play_mode, 'random');
    } finally {
      legacy.cleanup();
    }
  }));

test('devices remember modes separately and a group uses its primary record', () =>
  fixture(async ({ config, map, request, storage }) => {
    await request('POST /player/play', { playlist_id: book.id, play_mode: 'single' });
    await request('POST /player/play', { playlist_id: book.id, play_mode: 'loop', device_id: peer });
    storage.set('device_groups', JSON.stringify([{ id: 'group', members: [
      { account_id: account, device_id: speaker },
      { account_id: account, device_id: peer },
    ] }]));
    await map.refreshGroups();
    const result = await request('POST /player/play', { playlist_id: book.id, device_id: peer });
    assert.equal(result.data.play_mode, 'single');
    await request('POST /player/mode', { device_id: peer, play_mode: 'singlePlay' });
    assert.equal((await config.getPlaylistProgress(scope, book.id)).play_mode, 'singlePlay');
    assert.equal((await config.getPlaylistProgress('account:peer', book.id)).play_mode, 'loop');
  }));

test('voice and scheduled playback use the stored mode, while a scheduled override wins', () =>
  fixture(async ({ config, map, request, service }) => {
    const index = {
      isIndexReady: () => true,
      getPlaylistByIdWithRefresh: async () => book,
      findPlaylistByNameWithRefresh: async () => book,
    };
    await request('POST /player/play', { playlist_id: book.id, song_id: 21, play_mode: 'single' });
    await request('POST /player/play', { playlist_id: music.id, play_mode: 'random' });
    const manager = await map.getOrCreate(account, speaker);
    const voice = Object.assign(Object.create(MusicCommandService.prototype), {
      configManager: config, playlistManagerMap: map, indexingManager: index, interruptBroadcast: async () => {},
    });
    await voice.executePlayPlaylist(book.name, account, speaker);
    assert.equal(manager.getStatus().play_mode, 'single');
    assert.equal(manager.getCurrentSong().id, 21);

    const executor = new TaskExecutor(config, {}, service, map, index, {});
    const target = { accountId: account, deviceId: speaker, deviceName: speaker };
    await executor.executePlayPlaylist(target, { playlist_id: book.id, start_position: 'resume', play_mode: '' }, false);
    assert.equal(manager.getStatus().play_mode, 'single');
    assert.equal(manager.getCurrentSong().id, 21);
    await executor.executePlayPlaylist(target, { playlist_id: book.id, play_mode: 'repeat_one' }, false);
    assert.equal(manager.getStatus().play_mode, 'single');
    await executor.executePlayPlaylist(target, { playlist_id: book.id, play_mode: 'loop' }, false);
    assert.equal(manager.getStatus().play_mode, 'loop');
    assert.equal(manager.getCurrentSong().id, 32);
  }));

test('an older start awaiting mode storage cannot replace a newer queue', () =>
  fixture(async ({ config, map, pushes }) => {
    const manager = await map.getOrCreate(account, speaker);
    const pausedRead = deferred();
    const enteredRead = deferred();
    const get = config.getPlaylistProgress.bind(config);
    config.getPlaylistProgress = (key, id) => {
      if (id !== book.id) return get(key, id);
      enteredRead.resolve();
      return pausedRead.promise;
    };
    const older = manager.play(book.id);
    await Promise.race([
      enteredRead.promise,
      older.then(() => assert.fail('Book playback did not wait for its mode')),
    ]);
    assert.equal(await manager.play(music.id), true);
    pausedRead.resolve(null);
    assert.equal(await older, false);
    assert.equal(manager.getStatus().playlist_id, music.id);
    assert.equal(pushes.length, 1);
  }));

test('overlapping position and mode saves merge and survive a new config instance', () =>
  fixture(async ({ config }) => {
    const blocked = deferred();
    const entered = deferred();
    const set = songloft.storage.set;
    const original = { playlist_id: book.id, song_id: 32, song_index: 0, position_sec: 7, updated_at: 1, play_mode: 'order' };
    await config.savePlaylistProgress(scope, original);
    songloft.storage.set = async (key, value) => {
      if (key === 'playlist_progress' && JSON.parse(value)[scope][0].position_sec === 15) {
        entered.resolve();
        await blocked.promise;
      }
      await set(key, value);
    };
    const savePosition = config.savePlaylistProgress(scope, { ...original, position_sec: 15, updated_at: 2, play_mode: undefined });
    await entered.promise;
    const saveMode = config.savePlaylistProgress(scope, { ...original, play_mode: 'loop' }, true);
    blocked.resolve();
    await Promise.all([savePosition, saveMode]);
    const reloaded = new ConfigManager();
    assert.deepEqual(await reloaded.getPlaylistProgress(scope, book.id), {
      ...original, position_sec: 15, updated_at: 2, play_mode: 'loop',
    });
  }));
