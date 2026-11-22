import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { setImmediate as settle } from "node:timers/promises";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const vue = require("@vue/reactivity");
const source = readFileSync(
  new URL("../src/store.ts", import.meta.url),
  "utf8",
);
const { outputText } = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
  },
});

function statusStore({
  get = async () => ({ position: 42 }),
  post = async () => ({}),
  webSocket = true,
  paged = false,
  reactivity,
} = {}) {
  const document = new EventTarget();
  document.hidden = false;
  const window = new EventTarget();
  const sockets = [];
  const requests = [];
  const timers = new Map();
  let timerId = 0;
  let push = () => {};
  class Socket {
    OPEN = 1;
    CLOSED = 3;
    readyState = 0;
    constructor() {
      sockets.push(this);
    }
    close(code, reason) {
      this.closeArgs = [code, reason];
      this.readyState = this.CLOSED;
    }
    send() {}
    open() {
      this.readyState = this.OPEN;
      this.onopen();
    }
    status(position) {
      this.onmessage({
        data: JSON.stringify({ type: "status", data: { position } }),
      });
    }
  }
  const context = {
    exports: {},
    URLSearchParams,
    document,
    window,
    console,
    WebSocket: webSocket ? Socket : undefined,
    setTimeout: (fn, delay) => {
      const id = ++timerId;
      timers.set(id, { fn, delay, interval: false });
      return id;
    },
    setInterval: (fn, delay) => {
      const id = ++timerId;
      timers.set(id, { fn, delay, interval: true });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    clearInterval: (id) => timers.delete(id),
    require: (name) => {
      if (name === "@songloft/lynx-plugin-sdk")
        return {
          onPush: (callback) => {
            push = callback;
            return () => {
              push = () => {};
            };
          },
        };
      if (name === "./socket")
        return { PluginSocket: webSocket ? Socket : undefined };
      if (name === "@vue/reactivity")
        return (
          reactivity ?? {
            reactive: (value) => value,
            computed: (fn) => ({
              get value() {
                return fn();
              },
            }),
          }
        );
      if (name === "./api")
        return {
          get: (path) => {
            requests.push(path);
            return get(path);
          },
          post,
          query: (values) =>
            paged ? "?" + new URLSearchParams(values).toString() : "",
          pluginWebSocketUrl: (path) => path,
          messageOf: String,
        };
      throw new Error(`unexpected dependency: ${name}`);
    },
  };
  vm.runInNewContext(outputText, context);
  const store = context.exports;
  store.state.currentAccountId = "account";
  store.state.currentDeviceId = "device";
  const visible = () =>
    push(
      "lifecycle",
      JSON.stringify({ state: document.hidden ? "paused" : "resumed" }),
    );
  const online = visible;
  return { store, document, sockets, requests, timers, visible, online };
}

test("device loading restores only managed playback targets", async () => {
  const devices = [
    {
      account_id: "hidden-account",
      last_selected_device_id: "device",
      devices: [{ device_id: "device", managed: false }],
    },
    {
      account_id: "account",
      last_selected_device_id: "hidden",
      devices: [
        { device_id: "hidden", managed: false },
        { device_id: "device", managed: true },
        { device_id: "other", managed: true },
      ],
    },
  ];
  const { store, requests } = statusStore({
    paged: true,
    reactivity: vue,
    get: async (path) => (path === "/mina/devices" ? structuredClone(devices) : []),
  });
  store.state.currentAccountId = "hidden-account";
  await store.retryInitialDevices();
  assert.equal(store.state.currentAccountId, "account");
  assert.equal(store.currentDevice.value?.device_id, "device");
  assert.equal(store.state.devices[0].devices.length, 1);
  assert.ok(
    requests.includes("/player/status?account_id=account&device_id=device"),
  );
  await store.selectDevice("account", "hidden");
  assert.equal(store.currentDevice.value?.device_id, "device");

  devices[1].last_selected_device_id = "other";
  store.state.currentDeviceId = "";
  await store.loadAccountsAndDevices();
  assert.equal(store.currentDevice.value?.device_id, "other");
});

test("after a management change playback follows the remaining managed devices", async () => {
  const writes = [];
  let oldStatus, oldProgress;
  const { store, sockets } = statusStore({
    paged: true,
    reactivity: vue,
    get: (path) => {
      if (path.endsWith("device_id=device")) {
        return new Promise((resolve) => {
          if (path.startsWith("/player/status")) oldStatus = resolve;
          else oldProgress = resolve;
        });
      }
      return path.startsWith("/player/status")
        ? { position: 5 }
        : { song_id: 7 };
    },
    post: async (path, body) => writes.push({ path, body }),
  });
  store.state.devices = [
    {
      account_id: "account",
      last_selected_device_id: "device",
      devices: [
        { device_id: "device", managed: true },
        { device_id: "other", managed: true },
      ],
    },
  ];
  store.state.selectedPlaylistId = "1";
  store.connectStatusStream();
  const status = store.refreshPlayerStatus();
  const progress = store.refreshPlaylistProgress();
  await store.toggleManaged("account", "device", false);
  assert.equal(store.currentDevice.value?.device_id, "other");
  assert.equal(sockets[0].readyState, sockets[0].CLOSED);
  assert.equal(sockets.length, 2);
  oldStatus({ position: 90 });
  oldProgress({ song_id: 99 });
  await Promise.all([status, progress]);
  assert.equal(store.playerProgress.position, 5);
  assert.equal(store.state.playlistProgress?.song_id, 7);

  await store.toggleManaged("account", "other", false);
  assert.equal(store.currentDevice.value, null);
  assert.equal(store.state.currentAccountId, "");
  assert.equal(store.state.currentDeviceId, "");
  assert.equal(store.state.playlistProgress, null);
  assert.equal(store.playerProgress.position, undefined);
  assert.equal(sockets[1].readyState, sockets[1].CLOSED);
  assert.equal(sockets.length, 2);

  await store.toggleManaged("account", "device", true);
  assert.equal(store.currentDevice.value?.device_id, "device");
  assert.equal(sockets.length, 3);
  assert.deepEqual(
    writes.map(({ path }) => path),
    Array(3).fill("/mina/device/managed"),
  );
});

test("an older device refresh cannot undo a saved management change", async () => {
  let resolveOldDevices;
  let deviceReads = 0;
  const makeDevices = (managed) => [
    { account_id: "account", devices: [{ device_id: "device", managed }] },
  ];
  const { store } = statusStore({
    reactivity: vue,
    get: (path) => {
      if (path !== "/mina/devices") return [];
      if (++deviceReads === 1)
        return new Promise((resolve) => {
          resolveOldDevices = resolve;
        });
      return makeDevices(false);
    },
  });
  store.state.devices = makeDevices(true);
  const refresh = store.loadAccountsAndDevices();
  await store.toggleManaged("account", "device", false);
  resolveOldDevices(makeDevices(true));
  await refresh;
  assert.equal(store.state.devices[0].devices[0].managed, false);
  assert.equal(store.currentDevice.value, null);
});

test("clearing a playlist invalidates pending songs and progress", async () => {
  let songs, progress;
  const s = statusStore({
    get: (path) =>
      new Promise((resolve) => {
        if (path.endsWith("/songs")) songs = resolve;
        else progress = resolve;
      }),
  });
  const pending = s.store.selectPlaylist("1");
  await s.store.selectPlaylist("");
  songs([{ id: 1 }]);
  progress({ song_id: 1 });
  await pending;
  await settle();
  assert.equal(s.store.state.selectedPlaylistId, "");
  assert.equal(s.store.state.songs.length, 0);
  assert.equal(s.store.state.playlistProgress, null);
  assert.equal(s.store.state.songsLoading, false);
});
test("returning to a visible page replaces a silently dead OPEN socket and fetches a snapshot", async () => {
  const s = statusStore();
  s.store.connectStatusStream();
  s.sockets[0].open();
  s.sockets[0].status(1);
  assert.equal(s.timers.size, 0);
  s.visible();
  await settle();
  assert.equal(s.sockets.length, 2);
  assert.deepEqual(s.sockets[0].closeArgs, [1000, "client"]);
  assert.equal(s.store.state.statusConnected, false);
  assert.equal(s.requests.length, 1);
  assert.equal(s.store.playerProgress.position, 42);
  s.sockets[0].status(2);
  s.sockets[0].onopen();
  s.sockets[0].onerror();
  s.sockets[0].onclose();
  assert.equal(s.store.playerProgress.position, 42);
  assert.equal(s.store.state.statusConnected, false);
  s.sockets[1].open();
  s.sockets[1].status(43);
  assert.equal(s.store.playerProgress.position, 43);
  assert.equal(s.timers.size, 0);
});

test("hidden notifications do not restart the connection; coming online while visible does", async () => {
  const s = statusStore();
  s.store.connectStatusStream();
  s.document.hidden = true;
  s.visible();
  s.online();
  assert.equal(s.sockets.length, 1);
  assert.equal(s.requests.length, 0);
  s.document.hidden = false;
  s.online();
  await settle();
  assert.equal(s.sockets.length, 2);
  assert.equal(s.store.playerProgress.position, 42);
});

test("foreground recovery cancels pending backoff and ignores old error/close events", async () => {
  const s = statusStore();
  s.store.connectStatusStream();
  s.sockets[0].onerror();
  assert.equal(
    [...s.timers.values()].filter(
      (timer) => !timer.interval && timer.delay === 1000,
    ).length,
    1,
  );
  s.visible();
  await settle();
  s.sockets[0].onclose();
  assert.equal(
    [...s.timers.values()].filter(
      (timer) => !timer.interval && timer.delay === 1000,
    ).length,
    0,
  );
  s.sockets[1].open();
  assert.equal(s.timers.size, 0);
});

test("repeated connections do not accumulate recovery listeners", () => {
  const s = statusStore();
  s.store.connectStatusStream();
  s.store.connectStatusStream();
  s.visible();
  assert.equal(s.sockets.length, 3);
  assert.equal(s.requests.length, 1);
});

test("a suspended HTTP request cannot block recovery or overwrite the new snapshot", async () => {
  const pending = [];
  const s = statusStore({
    get: () => new Promise((resolve) => pending.push(resolve)),
  });
  s.store.connectStatusStream();
  const oldRequest = s.store.refreshPlayerStatus();
  s.visible();
  assert.equal(s.requests.length, 2);
  pending[0]({ position: 1 });
  await oldRequest;
  assert.equal(s.store.playerProgress.position, undefined);
  // The old finally must not release the new request's busy guard.
  await s.store.refreshPlayerStatus();
  assert.equal(s.requests.length, 2);
  pending[1]({ position: 42 });
  await settle();
  assert.equal(s.store.playerProgress.position, 42);
});

test("disposing removes listeners and timers and rejects late HTTP/socket updates", async () => {
  let resolve;
  const s = statusStore({
    get: () =>
      new Promise((res) => {
        resolve = res;
      }),
  });
  s.store.connectStatusStream();
  const request = s.store.refreshPlayerStatus();
  s.store.disposeStore();
  s.visible();
  s.online();
  s.sockets[0].onerror();
  s.sockets[0].status(1);
  resolve({ position: 2 });
  await request;
  assert.equal(s.sockets.length, 1);
  assert.equal(s.requests.length, 1);
  assert.equal(s.timers.size, 0);
  assert.equal(s.store.playerProgress.position, undefined);
});

test("recovery without an account or device makes no new connection or status request", () => {
  const s = statusStore();
  s.store.connectStatusStream();
  s.store.state.currentDeviceId = "";
  s.visible();
  s.online();
  assert.equal(s.sockets.length, 1);
  assert.equal(s.requests.length, 0);
});

test("environments without WebSocket retain HTTP polling and refresh on resume", async () => {
  const s = statusStore({ webSocket: false });
  s.store.connectStatusStream();
  await settle();
  s.visible();
  await settle();
  assert.equal(s.requests.length, 2);
  assert.equal(s.store.playerProgress.position, 42);
  assert.equal(
    [...s.timers.values()].filter((timer) => timer.interval).length,
    1,
  );
  s.store.disconnectStatusStream();
  assert.equal(s.timers.size, 0);
});

const songPage = (start, count, more) => ({
  songs: Array.from({ length: count }, (_, i) => ({
    id: start + i,
    title: "Paged song " + (start + i),
  })),
  next_offset: start - 1 + count,
  has_more: more,
});
test("first page is usable before later pages load, and duplicate scrolling shares one request", async () => {
  let second,
    calls = 0;
  const s = statusStore({
    paged: true,
    get: async (path) => {
      if (path.includes("/songs")) {
        calls++;
        const u = new URL(path, "http://fixture");
        if (u.searchParams.get("offset") === "0") return songPage(1, 100, true);
        return new Promise((resolve) => {
          second = resolve;
        });
      }
      return null;
    },
  });
  await s.store.selectPlaylist("1");
  assert.equal(s.store.state.songs.length, 100);
  assert.equal(s.store.state.songsLoading, false);
  const loading = s.store.loadMoreSongs(),
    duplicate = s.store.loadMoreSongs();
  assert.equal(calls, 2);
  assert.equal(s.store.state.songs.length, 100);
  second(songPage(101, 100, false));
  await Promise.all([loading, duplicate]);
  assert.equal(s.store.state.songs.length, 200);
  assert.equal(s.store.state.songs[100].id, 101);
  assert.equal(s.store.state.songsHasMore, false);
});
test("switching playlists rejects a late next-page response", async () => {
  let second;
  const s = statusStore({
    paged: true,
    get: async (path) => {
      if (!path.includes("/songs")) return null;
      const u = new URL(path, "http://fixture");
      if (u.pathname.includes("/2/")) return songPage(501, 2, false);
      if (u.searchParams.get("offset") === "0") return songPage(1, 100, true);
      return new Promise((resolve) => {
        second = resolve;
      });
    },
  });
  await s.store.selectPlaylist("1");
  const pending = s.store.loadMoreSongs();
  await s.store.selectPlaylist("2");
  second(songPage(101, 100, false));
  await pending;
  assert.deepEqual(
    Array.from(s.store.state.songs, (s) => s.id),
    [501, 502],
  );
});
test("debounced server search queries unloaded songs and invalidates a pending page", async () => {
  let second;
  const requested = [];
  const s = statusStore({
    paged: true,
    get: async (path) => {
      if (!path.includes("/songs")) return null;
      requested.push(path);
      const u = new URL(path, "http://fixture");
      if (u.searchParams.get("keyword")) return songPage(999, 1, false);
      if (u.searchParams.get("offset") === "0") return songPage(1, 100, true);
      return new Promise((resolve) => {
        second = resolve;
      });
    },
  });
  await s.store.selectPlaylist("1");
  const pending = s.store.loadMoreSongs();
  s.store.searchSongs("未加载");
  second(songPage(101, 100, false));
  await pending;
  const timer = [...s.timers.values()].find((t) => t.delay === 250);
  assert.ok(timer);
  timer.fn();
  await settle();
  assert.equal(s.store.state.songs[0].id, 999);
  assert.equal(
    new URL(requested.at(-1), "http://fixture").searchParams.get("keyword"),
    "未加载",
  );
});

test("locating a song shares an in-flight page and stops as soon as its row is loaded", async () => {
  let second,
    calls = 0;
  const s = statusStore({
    paged: true,
    get: async (path) => {
      if (!path.includes("/songs")) return null;
      calls++;
      const u = new URL(path, "http://fixture");
      if (u.searchParams.get("offset") === "0") return songPage(1, 100, true);
      return new Promise((resolve) => {
        second = resolve;
      });
    },
  });
  await s.store.selectPlaylist("1");
  const page = s.store.loadMoreSongs();
  const located = s.store.ensureSongLoaded(150);
  second(songPage(101, 100, true));
  await page;
  assert.equal(await located, 149);
  assert.equal(calls, 2);
});

test("failed configuration changes survive the next save and can be retried", async () => {
  const writes = [];
  let fail = true;
  const s = statusStore({
    post: async (path, body) => {
      writes.push(structuredClone(body));
      if (fail) throw Error("offline");
      return {};
    },
  }).store;
  await assert.rejects(s.saveConfig({ force_mp3: true }), /offline/);
  fail = false;
  await s.saveConfig({ volume_normalize: true });
  assert.deepEqual(writes[1], { force_mp3: true, volume_normalize: true });
  assert.equal(s.state.configSaveState, "saved");
  assert.equal(s.state.configSaveError, "");
  assert.equal(
    s.state.snackbar,
    null,
    "routine saves should not cover settings with a toast",
  );
});
test("retry sends a failed configuration patch even without another edit", async () => {
  let fail = true;
  const writes = [];
  const s = statusStore({
    post: async (path, body) => {
      writes.push(structuredClone(body));
      if (fail) throw Error("offline");
      return {};
    },
  }).store;
  await assert.rejects(s.saveConfig({ force_mp3: true }), /offline/);
  assert.equal(s.state.configSaveState, "error");
  assert.match(s.state.configSaveError, /offline/);
  fail = false;
  await s.retryConfigSave();
  assert.deepEqual(writes, [{ force_mp3: true }, { force_mp3: true }]);
  assert.equal(s.state.configSaveState, "saved");
});
test("queued configuration saves keep the latest value and snapshot nested fields", async () => {
  const writes = [],
    replies = [];
  const s = statusStore({
    post: (path, body) => {
      writes.push(body);
      return new Promise((resolve) => replies.push(resolve));
    },
  }).store;
  const ai = { model: "submitted" };
  const first = s.saveConfig({ ai_config: ai, force_mp3: true });
  ai.model = "new draft";
  const second = s.saveConfig({ force_mp3: false });
  assert.equal(writes[0].ai_config.model, "submitted");
  replies[0]({});
  await settle();
  assert.equal(writes[1].force_mp3, false);
  replies[1]({});
  await Promise.all([first, second]);
  assert.equal(s.state.configSaving, false);
  assert.equal(s.state.configSaveState, "saved");
});

test("retrying a server address updates its availability hint after persistence", async () => {
  let fail = true;
  const s = statusStore({
    post: async () => {
      if (fail) throw Error("offline");
      return {};
    },
  }).store;
  await assert.rejects(
    s.saveConfig({ server_host: "http://192.168.1.20:58091" }),
    /offline/,
  );
  assert.equal(s.state.config.server_host_status, "empty");
  fail = false;
  await s.retryConfigSave();
  assert.equal(s.state.config.server_host_status, "ok");
});

test("a failed next page keeps rows and cursor, stops automatic retries and supports explicit retry", async () => {
  let pageCalls = 0;
  const s = statusStore({
    paged: true,
    get: async (path) => {
      if (!path.includes("/songs")) return null;
      pageCalls++;
      if (pageCalls === 1) return { ...songPage(1, 100, true), total: 150 };
      if (pageCalls === 2) throw Error("next page offline");
      return { ...songPage(101, 50, false), total: 150 };
    },
  }).store;
  await s.selectPlaylist("1");
  assert.equal(s.state.songsTotal, 150);
  await s.loadMoreSongs();
  assert.equal(s.state.songs.length, 100);
  assert.equal(s.state.songsNextOffset, 100);
  assert.match(s.state.songsMoreError, /offline/);
  await s.loadMoreSongs();
  assert.equal(
    pageCalls,
    2,
    "scroll events must not repeatedly retry a failed page",
  );
  await s.loadMoreSongs(true);
  assert.equal(s.state.songs.length, 150);
  assert.equal(s.state.songsMoreError, "");
  assert.equal(s.state.songsHasMore, false);
});

test("removing the playing playlist updates pagination only when that playlist is displayed", async () => {
  const writes = [];
  const s = statusStore({
    get: async () => null,
    post: async (path, body) =>
      writes.push({ path, body: structuredClone(body) }),
  }).store;
  Object.assign(s.state, {
    selectedPlaylistId: "1",
    songs: [{ id: 7 }, { id: 8 }],
    songsPaged: true,
    songsNextOffset: 100,
    songsTotal: 150,
  });
  await s.removeSongFromPlaylist({ id: 7 }, { playlistId: 2 });
  assert.equal(writes[0].body.playlist_id, 2);
  assert.equal(
    s.state.songs.length,
    2,
    "removing from another playing playlist preserves the displayed list",
  );
  assert.equal(s.state.songsNextOffset, 100);
  await s.removeSongFromPlaylist({ id: 7 }, { playlistId: 1 });
  assert.equal(s.state.songs.length, 1);
  assert.equal(s.state.songsNextOffset, 99);
  assert.equal(s.state.songsTotal, 149);
});

test("position-only frames retain the same playback metadata snapshot", () => {
  const s = statusStore({ reactivity: vue });
  s.store.connectStatusStream();
  const socket = s.sockets[0];
  socket.open();
  const frame = (position, song = 12) =>
    socket.onmessage({
      data: JSON.stringify({
        type: "status",
        data: {
          position,
          playlist_id: 4,
          current_song: { id: song, title: "Fixture" },
        },
      }),
    });
  frame(1);
  const metadata = s.store.state.player;
  let metadataReads = 0;
  let progressReads = 0;
  const observeMetadata = vue.effect(() => {
    metadataReads++;
    return s.store.state.player.current_song?.id;
  });
  const observeProgress = vue.effect(() => {
    progressReads++;
    return s.store.playerProgress.position;
  });
  frame(2);
  assert.equal(metadataReads, 1);
  assert.equal(progressReads, 2);
  assert.equal(s.store.playerProgress.position, 2);
  assert.equal(s.store.state.player, metadata);
  frame(3, 13);
  assert.notEqual(s.store.state.player, metadata);
  assert.equal(s.store.state.player.current_song.id, 13);
  assert.equal(metadataReads, 2);
  vue.stop(observeMetadata);
  vue.stop(observeProgress);
});

test("startup exposes playlists before other resources and a manual clear wins", async () => {
  let config, devices, status;
  const s = statusStore({
    get: (path) => {
      if (path === "/config")
        return new Promise((resolve) => {
          config = resolve;
        });
      if (path === "/mina/devices")
        return new Promise((resolve) => {
          devices = resolve;
        });
      if (path === "/player/status")
        return new Promise((resolve) => {
          status = resolve;
        });
      if (path === "/playlists")
        return [
          { id: 3, name: "First" },
          { id: 4, name: "Current" },
        ];
      if (path.endsWith("/songs")) return [{ id: 12 }];
      return [];
    },
  });
  const startup = s.store.initialize();
  await settle();
  assert.equal(s.store.state.loading, false);
  assert.equal(s.store.state.configLoaded, false);
  assert.equal(s.store.state.deviceConnecting, true);
  assert.ok([...s.timers.values()].some((timer) => timer.delay === 3000));
  await s.store.selectPlaylist("3");
  assert.equal(s.store.state.songs[0].id, 12);
  await s.store.selectPlaylist("");
  devices([
    { account_id: "account", devices: [{ device_id: "device", managed: true }] },
  ]);
  config({});
  await startup;
  status({ playlist_id: 4, current_song: { id: 13 } });
  await settle();
  assert.equal(s.store.state.selectedPlaylistId, "");
  assert.equal(s.store.state.songs.length, 0);
});

test("startup prefers the first matching device snapshot and bounds the wait for it", async () => {
  for (const snapshotArrives of [true, false]) {
    let status;
    const s = statusStore({
      get: (path) => {
        if (path === "/mina/devices")
          return [
            {
              account_id: "account",
              devices: [{ device_id: "device", managed: true }],
            },
          ];
        if (path === "/player/status")
          return new Promise((resolve) => {
            status = resolve;
          });
        if (path === "/playlists")
          return [
            { id: 3, name: "First" },
            { id: 4, name: "Current" },
          ];
        return [];
      },
    });
    await s.store.initialize();
    assert.equal(s.store.state.selectedPlaylistId, "");
    if (!snapshotArrives) {
      [...s.timers.values()].find((timer) => timer.delay === 3000).fn();
      assert.equal(s.store.state.selectedPlaylistId, "3");
    }
    status({ playlist_id: 4, current_song: { id: 13 } });
    await settle();
    assert.equal(s.store.state.selectedPlaylistId, snapshotArrives ? "4" : "3");
  }
});

test("accepted commands unlock before the state snapshot and stale replies are ignored", async () => {
  const statuses = [];
  const submissions = [];
  const s = statusStore({
    post: (path) =>
      new Promise((resolve) => {
        submissions.push({ path, resolve });
      }),
    get: () => new Promise((resolve) => statuses.push(resolve)),
  });
  const first = s.store.playerCommand("/player/toggle");
  assert.equal(s.store.state.playerBusy, true);
  submissions[0].resolve();
  assert.equal(await first, true);
  assert.equal(s.store.state.playerBusy, false);
  assert.equal(s.store.state.playerSyncing, true);
  const second = s.store.playerCommand("/player/next");
  submissions[1].resolve();
  assert.equal(await second, true);
  statuses[1]({ position: 9 });
  await settle();
  statuses[0]({ position: 90 });
  await settle();
  assert.equal(s.store.playerProgress.position, 9);
  assert.equal(s.store.state.playerSyncing, false);
});

test("a command requests socket status first and falls back when no frame arrives", async () => {
  const s = statusStore();
  s.store.connectStatusStream();
  const socket = s.sockets[0];
  socket.open();
  const sent = [];
  socket.send = (message) => sent.push(JSON.parse(message));
  await s.store.playerCommand("/player/next");
  assert.deepEqual(sent, [{ type: "refresh" }]);
  assert.equal(s.requests.length, 0);
  socket.status(5);
  assert.equal(s.store.state.playerSyncing, false);
  assert.equal(s.timers.size, 0);
  await s.store.playerCommand("/player/next");
  [...s.timers.values()].find((timer) => timer.delay === 1500).fn();
  await settle();
  assert.equal(s.requests.length, 1);
  assert.equal(s.store.playerProgress.position, 42);
});
