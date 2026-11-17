import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

function harness({
  reply,
  globals = () => ({ serverUrl: "https://host.invalid" }),
} = {}) {
  let current;
  const calls = [],
    listeners = new Set(),
    timers = new Map();
  let timerId = 0;
  const hooks = {
    useRef(value) {
      const r = current,
        index = r.cursor++;
      return (r.values[index] ||= { current: value });
    },
    useState(value) {
      const r = current,
        index = r.cursor++;
      if (!(index in r.values)) r.values[index] = value;
      return [
        r.values[index],
        (next) => {
          next = typeof next === "function" ? next(r.values[index]) : next;
          if (!Object.is(next, r.values[index])) r.dirty = true;
          r.values[index] = next;
        },
      ];
    },
    useEffect(callback, deps) {
      const r = current,
        index = r.cursor++,
        old = r.values[index];
      if (!old || deps.some((value, i) => !Object.is(value, old.deps[i]))) {
        r.effects.push(() => {
          old?.cleanup?.();
          r.values[index] = { deps, cleanup: callback() };
        });
      }
    },
  };
  const source = readFileSync(
    new URL("../src/Cover.tsx", import.meta.url),
    "utf8",
  );
  const js = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      jsx: ts.JsxEmit.ReactJSX,
      jsxImportSource: "@lynx-js/react",
    },
  }).outputText;
  const exports = {};
  const jsx = (type, props, key) => ({ type, props, key });
  new Function("require", "exports", "setTimeout", "clearTimeout", js)(
    (name) => {
      if (name === "@lynx-js/react") return hooks;
      if (name === "@lynx-js/react/jsx-runtime") return { jsx, jsxs: jsx };
      if (name === "@songloft/lynx-plugin-sdk")
        return {
          invokeHost: async (ns, method, params) => {
            calls.push({ ns, method, params });
            if (reply) return reply(params);
            return {
              ok: true,
              data:
                "https://host.invalid" + params.path + "&access_token=fixture",
            };
          },
          onPush(callback) {
            listeners.add(callback);
            return () => listeners.delete(callback);
          },
          getGlobalProps: globals,
        };
      if (name === "./ui/native") return { SlIcon: "icon" };
      throw new Error(name);
    },
    exports,
    (callback, ms) => {
      const id = ++timerId;
      timers.set(id, { callback, ms });
      return id;
    },
    (id) => timers.delete(id),
  );
  const instances = [];
  return {
    calls,
    timers,
    mount(props) {
      const r = {
        props,
        values: [],
        cursor: 0,
        effects: [],
        dirty: true,
        tree: null,
      };
      instances.push(r);
      return r;
    },
    paint(r) {
      r.cursor = 0;
      current = r;
      return exports.Cover(r.props);
    },
    async flush() {
      for (let i = 0; i < 12; i++) {
        for (const r of instances)
          if (r.dirty) {
            r.dirty = false;
            r.cursor = 0;
            current = r;
            r.tree = exports.Cover(r.props);
            for (const effect of r.effects.splice(0)) effect();
          }
        await Promise.resolve();
      }
    },
    async commit() {
      for (const r of instances)
        if (r.dirty) {
          r.dirty = false;
          r.cursor = 0;
          current = r;
          r.tree = exports.Cover(r.props);
          for (const effect of r.effects.splice(0)) effect();
        }
      await Promise.resolve();
    },
    resume() {
      for (const callback of listeners)
        callback("lifecycle", '{"state":"resumed"}');
    },
  };
}
const song = {
  id: 1,
  title: "Cover fixture",
  cover_url: "/api/v1/songs/1/cover?v=123",
};
const image = (r) => (r.tree.type === "image" ? r.tree : r.tree.props.children);

test("a known cover resolving its URL does not briefly paint a no-cover icon", () => {
  const h = harness();
  const row = h.mount({ song });
  const initial = h.paint(row);
  assert.ok(
    !initial.props.children,
    "pending cover resolution is not a missing cover",
  );
});

test("missing covers use the synchronous SVG icon instead of a font glyph", () => {
  const h = harness();
  const row = h.mount({ song: { ...song, cover_url: "" } });
  const initial = h.paint(row);
  assert.equal(initial.props.children.type, "view");
  assert.equal(initial.props.children.props.children.type, "icon");
  assert.equal(initial.props.children.props.children.props.name, "music_note");
});

test("inline data covers can paint immediately without an address cache or bridge call", () => {
  const h = harness(),
    url = "data:image/png;base64,QUJDRA==";
  const tree = h.paint(h.mount({ song: { ...song, cover_url: url } }));
  assert.equal(tree.props.children.type, "image");
  assert.equal(tree.props.children.props.src, url);
  assert.equal(h.calls.length, 0);
});

test("a recycled row paints its already-loaded cover before effects and without another bridge request", async () => {
  const h = harness();
  const first = h.mount({ song });
  await h.flush();
  image(first).props.bindload();
  const loaded = image(first).props.src;
  const second = h.mount({ song });
  const initial = h.paint(second);
  assert.equal(initial.props.children.type, "image");
  assert.equal(initial.props.children.props.src, loaded);
  await h.flush();
  assert.equal(h.calls.length, 1);
});

test("an automatic retry never inserts the default icon between image attempts", async () => {
  const h = harness(),
    row = h.mount({ song });
  await h.flush();
  image(row).props.binderror();
  await h.commit();
  assert.ok(
    !row.tree.props.children,
    "an in-flight retry must not paint a default icon",
  );
  await h.flush();
  assert.equal(image(row).type, "image");
});

test("an old cache entry cannot show the wrong song on a reused component", async () => {
  const h = harness(),
    row = h.mount({ song });
  await h.flush();
  image(row).props.bindload();
  row.props = { song: { ...song, id: 2, cover_url: "/api/v1/songs/2/cover" } };
  const first = h.paint(row);
  assert.ok(
    !first.props.children,
    "the previous song is not a loading placeholder",
  );
});

test("cover size and content versions have separate cache entries", async () => {
  const h = harness(),
    row = h.mount({ song, width: 96 });
  await h.flush();
  image(row).props.bindload();
  for (const props of [
    { song, width: 640 },
    { song: { ...song, cover_url: "/api/v1/songs/1/cover?v=next" }, width: 96 },
  ])
    assert.ok(!h.paint(h.mount(props)).props.children);
});

test("server changes do not reuse a credential-bearing cached address", async () => {
  let serverUrl = "https://first.invalid";
  const h = harness({ globals: () => ({ serverUrl }) }),
    row = h.mount({ song });
  await h.flush();
  image(row).props.bindload();
  serverUrl = "https://second.invalid";
  assert.ok(!h.paint(h.mount({ song })).props.children);
});

test("a failed cached image is invalidated without showing a transient default", async () => {
  const h = harness(),
    row = h.mount({ song });
  await h.flush();
  image(row).props.bindload();
  image(row).props.binderror();
  assert.ok(!h.paint(h.mount({ song })).props.children);
  await h.commit();
  assert.ok(!row.tree.props.children);
  await h.flush();
  assert.equal(image(row).type, "image");
});

test("large cover keeps native image painting separate from shadow, radius and inline size", async () => {
  const h = harness(),
    style = { width: "212px", height: "212px" };
  const r = h.mount({ song, className: "large-cover", width: 640, style });
  await h.flush();
  assert.equal(
    r.tree.type,
    "view",
    "shadows on Android image nodes suppress the bitmap",
  );
  assert.equal(r.tree.props.style, style);
  assert.ok(r.tree.props.className.includes("large-cover"));
  assert.equal(image(r).type, "image");
  assert.equal(image(r).props.className, "cover-image");
  assert.equal(image(r).props.style, undefined);
  assert.equal(h.calls[0].params.path, "/api/v1/songs/1/cover?v=123&w=640");
});
for (const url of [
  "data:image/png;base64,QUJDRA==",
  "https://cdn.invalid/cover.png?signature=abc%2F123",
]) {
  test("preserves opaque cover source: " + url.split(":")[0], async () => {
    const h = harness(),
      r = h.mount({ song: { ...song, cover_url: url } });
    await h.flush();
    assert.equal(image(r).props.src, url);
    assert.equal(
      h.calls.length,
      0,
      "external sources never receive host credentials",
    );
  });
}
test("failed covers retry twice, recover on resume and remount signed sources without rewriting them", async () => {
  const h = harness(),
    url = "https://cdn.invalid/cover?signature=abc";
  const r = h.mount({ song: { ...song, cover_url: url } });
  await h.flush();
  const keys = new Set();
  for (let i = 0; i < 3; i++) {
    assert.equal(image(r).type, "image");
    assert.equal(image(r).props.src, url);
    keys.add(image(r).key);
    image(r).props.binderror();
    await h.flush();
  }
  assert.equal(keys.size, 3);
  assert.notEqual(image(r).type, "image", "permanent failures stop retrying");
  h.resume();
  await h.flush();
  assert.equal(image(r).type, "image");
  image(r).props.binderror();
  await h.flush();
  assert.equal(
    image(r).type,
    "image",
    "a new visible session gets a fresh retry budget",
  );
});
test("queued covers keep their chance to load when the first requests stall", async () => {
  const h = harness();
  const rows = Array.from({ length: 8 }, (_, i) =>
    h.mount({ song: { ...song, id: i + 1 } }),
  );
  await h.flush();
  assert.equal(h.calls.length, 6);
  assert.equal(
    h.timers.size,
    6,
    "watchdogs start only when a queued cover gets its slot",
  );
  for (const [id, timer] of [...h.timers]) {
    h.timers.delete(id);
    timer.callback();
  }
  await h.flush();
  assert.equal(h.calls.length, 8);
  assert.equal(image(rows[7]).type, "image");
});

test("resume preserves loaded cover sources and image keys across repeated tab visits", async () => {
  const h = harness();
  const rows = [song.cover_url, "https://cdn.invalid/cover?signature=abc"].map(
    (cover_url) => h.mount({ song: { ...song, cover_url } }),
  );
  await h.flush();
  for (const r of rows) image(r).props.bindload();
  await h.flush();
  const before = rows.map((r) => ({
    src: image(r).props.src,
    key: image(r).key,
  }));
  for (let visit = 0; visit < 20; visit++) {
    h.resume();
    await h.flush();
    assert.deepEqual(
      rows.map((r) => ({ src: image(r).props.src, key: image(r).key })),
      before,
      "healthy images must not be cleared or remounted on resume",
    );
  }
  assert.equal(h.calls.length, 1, "resume must not resolve healthy URLs again");
});

test("resume keeps in-flight and queued covers instead of restarting the whole list", async () => {
  const h = harness();
  const rows = Array.from({ length: 8 }, (_, i) =>
    h.mount({ song: { ...song, id: i + 1 } }),
  );
  await h.flush();
  const before = image(rows[0]);
  h.resume();
  await h.flush();
  assert.equal(h.calls.length, 6);
  assert.equal(image(rows[0]).key, before.key);
  assert.equal(image(rows[0]).props.src, before.props.src);
  image(rows[0]).props.bindload();
  await h.flush();
  assert.equal(h.calls.length, 7);
});

test("a timed-out cover retries on resume and stays intact once it has loaded", async () => {
  const h = harness(),
    r = h.mount({ song });
  await h.flush();
  const first = image(r).key;
  for (const timer of [...h.timers.values()]) timer.callback();
  h.resume();
  await h.flush();
  assert.notEqual(image(r).key, first);
  image(r).props.bindload();
  const loaded = image(r).key;
  h.resume();
  await h.flush();
  assert.equal(image(r).key, loaded);
  assert.equal(h.calls.length, 2);
});

for (const failure of ["rejected", "unavailable"]) {
  test(
    "resource URL " +
      failure +
      " recovers on resume without reloading healthy covers",
    async () => {
      let available = false;
      const h = harness({
        reply: () => {
          if (available)
            return { ok: true, data: "https://host.invalid/recovered.png" };
          if (failure === "rejected") throw Error("temporary host failure");
          return { ok: false };
        },
      });
      const r = h.mount({ song });
      await h.flush();
      assert.notEqual(image(r).type, "image");
      available = true;
      h.resume();
      await h.flush();
      assert.equal(image(r).props.src, "https://host.invalid/recovered.png");
      image(r).props.bindload();
      h.resume();
      await h.flush();
      assert.equal(h.calls.length, 2);
    },
  );
}
