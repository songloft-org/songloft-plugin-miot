import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import * as reactive from "@vue/reactivity";
const require = createRequire(import.meta.url);
const cache = new Map();
function load(name) {
  if (cache.has(name)) return cache.get(name);
  const source = readFileSync(
    new URL("../src/" + name + ".ts", import.meta.url),
    "utf8",
  );
  const js = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
  }).outputText;
  const exports = {};
  new Function("require", "exports", js)(
    (path) => (path === "@vue/reactivity" ? reactive : load(path.slice(2))),
    exports,
  );
  cache.set(name, exports);
  return exports;
}
const { parseLrc } = load("lyrics"),
  { createPlayerDetails } = load("player-details");
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { resolve, reject, promise };
};
test("LRC retains multiple timestamps, fractional seconds and plain lyrics", () => {
  assert.deepEqual(parseLrc("[01:02.3][00:12.45]歌曲\n[00:15.001]下一句"), [
    { time: 12.45, text: "歌曲" },
    { time: 15.001, text: "下一句" },
    { time: 62.3, text: "歌曲" },
  ]);
  assert.deepEqual(parseLrc("纯文本"), [{ time: Infinity, text: "纯文本" }]);
});
test("lyrics complete independently of a slow favorite request", async () => {
  const requests = [];
  const details = createPlayerDetails(
    (path) => {
      const request = deferred();
      requests.push({ path, ...request });
      return request.promise;
    },
    () => 1,
  );
  const pending = details.loadSongDetails();
  requests[0].resolve({ lyric: "[00:01]歌词" });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(details.lyrics.value[0].text, "歌词");
  assert.equal(details.lyricLoading.value, false);
  requests[1].resolve({ is_favorited: true });
  await pending;
  assert.equal(details.isFavorite.value, true);
});
test("old song results cannot overwrite a replacement or a disposed player", async () => {
  let id = 1;
  const requests = [];
  const details = createPlayerDetails(
    (path) => {
      const request = deferred();
      requests.push(request);
      return request.promise;
    },
    () => id,
  );
  const old = details.loadSongDetails();
  id = 2;
  const current = details.loadSongDetails();
  requests[2].resolve({ lyric: "[00:00]新歌曲" });
  requests[3].resolve({ is_favorited: true });
  await current;
  requests[0].resolve({ lyric: "[00:00]旧歌曲" });
  requests[1].resolve({ is_favorited: false });
  await old;
  assert.equal(details.lyrics.value[0].text, "新歌曲");
  assert.equal(details.isFavorite.value, true);
  id = 3;
  const late = details.loadSongDetails();
  details.dispose();
  requests[4].resolve({ lyric: "[00:00]卸载后" });
  requests[5].resolve({ is_favorited: true });
  await late;
  assert.equal(details.lyrics.value.length, 0);
});
test("retry uses refresh=1, clears errors and prevents duplicate requests", async () => {
  const paths = [];
  let fail = true;
  const details = createPlayerDetails(
    async (path) => {
      paths.push(path);
      if (path.startsWith("/lyric")) {
        if (fail) throw new Error("offline");
        return { lyric: "[00:00]恢复" };
      }
      return { is_favorited: false };
    },
    () => 1,
  );
  await details.loadSongDetails();
  assert.match(details.lyricError.value, /失败/);
  fail = false;
  await details.retryLyrics();
  assert.equal(paths.at(-1), "/lyric?song_id=1&refresh=1");
  assert.equal(details.lyricError.value, "");
  assert.equal(details.lyrics.value[0].text, "恢复");
});

test("a late favorite query cannot undo a local add or remove", async () => {
  for (const value of [true, false]) {
    let resolve;
    const details = createPlayerDetails(
      (path) =>
        path.startsWith("/lyric")
          ? Promise.resolve({ lyric: "" })
          : new Promise((yes) => {
              resolve = yes;
            }),
      () => 1,
    );
    const pending = details.loadSongDetails();
    if (details.setFavorite) details.setFavorite(value);
    else details.isFavorite.value = value;
    resolve({ is_favorited: !value });
    await pending;
    assert.equal(
      details.isFavorite.value,
      value,
      "a newer user action owns favorite state",
    );
  }
});

test("mini player loads only favorite state and lyric views reuse successful responses", async () => {
  const paths = [];
  const cache = new Map();
  const get = async (path) => {
    paths.push(path);
    return path.startsWith("/lyric")
      ? { lyric: "[00:00]缓存" }
      : { is_favorited: true };
  };
  const details = createPlayerDetails(get, () => 1, cache);
  await details.loadSongDetails(false);
  assert.deepEqual(paths, ["/player/favorite/status?song_id=1"]);
  await details.ensureLyrics();
  await createPlayerDetails(get, () => 1, cache).ensureLyrics();
  assert.equal(paths.filter((path) => path.startsWith("/lyric")).length, 1);
  assert.equal(details.lyrics.value[0].text, "缓存");
});
