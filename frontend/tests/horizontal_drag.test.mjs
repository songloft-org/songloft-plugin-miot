import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const source = readFileSync(
  new URL("../src/ui/horizontal-drag.ts", import.meta.url),
  "utf8",
);
const { outputText } = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
  },
});
const exports = {};
new Function("exports", outputText)(exports);

test("native slider bounds use plugin-relative coordinates", () => {
  assert.deepEqual(
    exports.horizontalSliderBounds(
      { left: 118, width: 300 },
      { left: 100 },
      false,
    ),
    { left: 18, width: 300 },
  );
  assert.deepEqual(
    exports.horizontalSliderBounds(
      { left: 118, width: 300 },
      { left: 100 },
      true,
    ),
    { left: 118, width: 300 },
  );
});

test("horizontal slider values clamp to the measured track", () => {
  assert.equal(exports.horizontalSliderValue(18, 18, 300, 0, 240), 0);
  assert.equal(exports.horizontalSliderValue(168, 18, 300, 0, 240), 120);
  assert.equal(exports.horizontalSliderValue(400, 18, 300, 0, 240), 240);
});

test("release before measurement commits the last native touch once", async () => {
  let resolveMeasure;
  const previews = [];
  const commits = [];
  const drag = exports.createHorizontalDrag(
    () => new Promise((resolve) => (resolveMeasure = resolve)),
    (x, bounds) => exports.horizontalSliderValue(x, bounds.left, bounds.width, 0, 100),
    (value) => previews.push(value),
    (value) => commits.push(value),
  );
  drag.start(80);
  drag.end(220);
  resolveMeasure({ left: 20, width: 200 });
  await Promise.resolve();
  assert.deepEqual(previews, [100]);
  assert.deepEqual(commits, [100]);
  drag.end(120);
  assert.deepEqual(commits, [100]);
});

test("cancelled native slider measurement ignores a late result", async () => {
  let resolveMeasure;
  const commits = [];
  const drag = exports.createHorizontalDrag(
    () => new Promise((resolve) => (resolveMeasure = resolve)),
    (x, bounds) => exports.horizontalSliderValue(x, bounds.left, bounds.width, 0, 100),
    () => {},
    (value) => commits.push(value),
  );
  drag.start(100);
  drag.cancel();
  resolveMeasure({ left: 0, width: 200 });
  await Promise.resolve();
  assert.deepEqual(commits, []);
});
