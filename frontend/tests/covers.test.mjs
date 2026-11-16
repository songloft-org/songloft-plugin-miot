import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

function harness() {
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
        };
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
