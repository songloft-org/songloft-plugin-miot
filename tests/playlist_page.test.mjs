import assert from "node:assert/strict";
import test from "node:test";
import { loader } from "./chat_loader.mjs";
function fixture(t, api) {
  const previous = globalThis.songloft;
  globalThis.songloft = {
    playlists: {
      getById: async () => ({ sort_by: "title", sort_order: "desc" }),
      list: async () => [],
      getSongs: async () => {
        throw Error("unbounded load must not run");
      },
    },
    log: { warn() {} },
  };
  t.after(() => {
    globalThis.songloft = previous;
  });
  const load = loader({
    "../utils/http": { callHostAPI: api },
    "../player/manager": { isTempPlaylistId: (id) => id < 0 },
    "../service/service": {},
    "../config/manager": {},
    "../utils/favorites": {},
  });
  const { registerPlaylistHandlers } = load("../src/handlers/playlist.ts");
  const { playlistPage } = load("../src/handlers/playlist_page.ts");
  const routes = new Map(),
    managers = {
      getTempPlaylists: () => [],
      findByPlaylistId: () => undefined,
    };
  registerPlaylistHandlers(
    { get: (path, handler) => routes.set(path, handler), post() {} },
    managers,
    {},
    { getConfig: async () => ({ server_host: "http://speaker.test" }) },
  );
  return {
    page: (id, query) => playlistPage(id, query, managers),
    request: async (path, query = "", id = "1") =>
      JSON.parse((await routes.get(path)({ query }, { id })).body),
  };
}
test("paged playlist route uses a bounded host query and preserves sorting/search before pagination", async (t) => {
  const h = fixture(t, async (method, path) => {
    assert.equal(method, "GET");
    const u = new URL(path, "http://fixture");
    assert.equal(u.pathname, "/api/v1/playlists/1/songs");
    assert.equal(u.searchParams.get("limit"), "100");
    assert.equal(u.searchParams.get("offset"), "100");
    assert.equal(u.searchParams.get("sort"), "title");
    assert.equal(u.searchParams.get("order"), "desc");
    assert.equal(u.searchParams.get("keyword"), "未加载");
    return {
      songs: [
        {
          id: 101,
          title: "Match",
          cover_url: "/api/v1/songs/101/cover",
          file_path: "/private/path",
        },
      ],
      total: 300,
    };
  });
  const result = await h.request(
    "/playlists/:id/songs",
    "limit=100&offset=100&keyword=" + encodeURIComponent("未加载"),
  );
  assert.equal(result.success, true);
  assert.equal(result.data.songs.length, 1);
  assert.equal(result.data.next_offset, 101);
  assert.equal(result.data.has_more, true);
  assert.ok(!("file_path" in result.data.songs[0]));
});
test("virtual library page advances through a radio-only page without treating it as EOF", async (t) => {
  const h = fixture(t, async (_method, path) => {
    const u = new URL(path, "http://fixture");
    assert.equal(u.searchParams.get("exclude_playlist_labels"), "none");
    assert.equal(u.searchParams.get("sort"), "id");
    return {
      songs: [
        { id: 1, type: "radio" },
        { id: 2, type: "radio" },
      ],
      total: 3,
    };
  });
  const result = await h.page(Number.MAX_SAFE_INTEGER, {
    limit: "2",
    offset: "0",
  });
  assert.deepEqual(result.songs, []);
  assert.equal(result.next_offset, 2);
  assert.equal(result.has_more, true);
});
test("playlist metadata reads aggregate counts instead of loading the full library", async (t) => {
  let calls = 0;
  const h = fixture(t, async (_method, path) => {
    calls++;
    assert.equal(path, "/api/v1/songs/stats");
    return { local_songs: 10000, remote_songs: 100, radio_songs: 4 };
  });
  const result = await h.request("/playlists");
  assert.equal(result.data[0].song_count, 10100);
  assert.equal(calls, 1);
});
test("page size is capped for large requests", async (t) => {
  const h = fixture(t, async (_method, path) => {
    assert.equal(
      new URL(path, "http://fixture").searchParams.get("limit"),
      "200",
    );
    return { songs: [], total: 0 };
  });
  assert.equal(
    (await h.page(1, { limit: "100000", offset: "0" })).has_more,
    false,
  );
});
