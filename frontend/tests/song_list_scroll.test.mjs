import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

function harness() {
  const values = [],
    effects = [],
    calls = [];
  let cursor = 0,
    dirty = true,
    scroll;
  let props = { rowHeight: 64, playlistId: "1", search: "", ready: true };
  const hooks = {
    useState(initial) {
      const i = cursor++;
      if (!(i in values)) values[i] = initial;
      return [
        values[i],
        (value) => {
          if (!Object.is(value, values[i])) dirty = true;
          values[i] = value;
        },
      ];
    },
    useEffect(callback, deps) {
      const i = cursor++,
        old = values[i];
      if (!old || deps.some((value, j) => !Object.is(value, old[j]))) {
        values[i] = deps;
        effects.push(callback);
      }
    },
  };
  const source = readFileSync(
    new URL("../src/song-list-scroll.ts", import.meta.url),
    "utf8",
  );
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText;
  const exports = {};
  const lynx = {
    createSelectorQuery: () => ({
      select: (selector) => ({
        invoke: (command) => ({
          exec: () => calls.push({ selector, ...command }),
        }),
      }),
    }),
  };
  new Function("require", "exports", "lynx", js)(() => hooks, exports, lynx);
  function flush() {
    for (let round = 0; dirty && round < 10; round++) {
      dirty = false;
      cursor = 0;
      scroll = exports.useSongListScroll(props);
      for (const callback of effects.splice(0)) callback();
    }
    return scroll;
  }
  return {
    calls,
    get scroll() {
      return scroll;
    },
    flush,
    update(next) {
      props = { ...props, ...next };
      dirty = true;
      return flush();
    },
  };
}

test("repeated locate sends a new command after a manual scroll away from the same destination", () => {
  const h = harness();
  h.flush();
  h.scroll.locate(899);
  h.flush();
  assert.equal(h.scroll.start, 894);
  assert.equal(h.calls.at(-1).params.offset, 57416);
  const count = h.calls.length;
  h.scroll.onScroll(0);
  h.flush();
  assert.equal(h.scroll.start, 0);
  assert.equal(h.calls.length, count, "gestures must not echo scroll commands");
  h.scroll.locate(899);
  h.flush();
  assert.equal(h.calls.length, count + 1);
  assert.equal(h.calls.at(-1).params.offset, 57416);
  assert.equal(h.calls.at(-1).params.smooth, false);
});

test("a pending reset waits for the list to replace its loading skeleton", () => {
  const h = harness();
  h.update({ ready: false });
  assert.equal(h.calls.length, 0);
  h.update({ ready: true });
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].params.offset, 0);
  assert.equal(h.calls[0].selector, "#miot-song-list");
});

test("changing playlist or search resets the virtual window and pending destination", () => {
  const h = harness();
  h.flush();
  h.scroll.locate(899);
  h.flush();
  const count = h.calls.length;
  h.update({ playlistId: "2", ready: false });
  assert.equal(h.scroll.start, 0);
  assert.equal(h.calls.length, count);
  h.update({ ready: true });
  assert.equal(h.calls.at(-1).params.offset, 0);
  h.scroll.locate(20);
  h.flush();
  h.update({ search: "another song", ready: false });
  h.update({ ready: true });
  assert.equal(h.calls.at(-1).params.offset, 0);
});

test("desktop rows and a target at the start use the correct bounded offset", () => {
  const h = harness();
  h.update({ rowHeight: 56 });
  h.scroll.locate(899);
  h.flush();
  assert.equal(h.calls.at(-1).params.offset, 50224);
  h.scroll.locate(0);
  h.flush();
  assert.equal(h.scroll.start, 0);
  assert.equal(h.calls.at(-1).params.offset, 0);
});
