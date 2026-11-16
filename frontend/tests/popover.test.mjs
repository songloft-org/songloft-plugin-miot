import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
async function load(name) {
  const source = readFileSync(
    new URL("../src/ui/" + name + ".ts", import.meta.url),
    "utf8",
  );
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext },
  }).outputText;
  return import(
    "data:text/javascript;base64," + Buffer.from(js).toString("base64")
  );
}
const { placePopover } = await load("position");
const { volumeFromY, volumeBounds, createVerticalDrag } =
  await load("vertical-drag");
test("native plugin volume normalizes the nested host and status-bar offset", () => {
  const bounds = volumeBounds(
    { top: 345.09, height: 148.36 },
    { top: 78.18 },
    false,
  );
  assert.equal(volumeFromY(296.727, bounds.top, bounds.height), 80);
  assert.equal(volumeFromY(296.727, 345.09, 148.36), 100);
  assert.deepEqual(
    volumeBounds({ top: 345.09, height: 148.36 }, { top: 78.18 }, true),
    { top: 345.09, height: 148.36 },
  );
});
for (const [name, root, trigger, width, height] of [
  [
    "left mobile",
    { left: 0, top: 0, width: 320, height: 520 },
    { left: 4, top: 450, width: 40, height: 40 },
    76,
    292,
  ],
  [
    "right desktop",
    { left: 0, top: 0, width: 1100, height: 800 },
    { left: 1050, top: 700, width: 40, height: 40 },
    240,
    236,
  ],
  [
    "below trigger",
    { left: 0, top: 0, width: 390, height: 740 },
    { left: 80, top: 16, width: 40, height: 40 },
    160,
    296,
  ],
  [
    "nested frame",
    { left: 20, top: 54, width: 390, height: 600 },
    { left: 120, top: 500, width: 40, height: 40 },
    160,
    236,
  ],
])
  test("popover stays anchored and in bounds: " + name, () => {
    const p = Object.fromEntries(
      Object.entries(placePopover(root, trigger, width, height)).map(
        ([k, v]) => [k, parseFloat(v)],
      ),
    );
    assert.ok(p.left >= 8 && p.top >= 8);
    assert.ok(
      p.left + p.width <= root.width - 8 && p.top + p.height <= root.height - 8,
    );
    const top = trigger.top - root.top;
    assert.ok(p.top + p.height <= top - 6 || p.top >= top + trigger.height + 6);
  });
test("vertical volume grows upwards, clamps and rejects invalid geometry", () => {
  assert.equal(volumeFromY(100, 100, 200), 100);
  assert.equal(volumeFromY(250, 100, 200), 25);
  assert.equal(volumeFromY(999, 100, 200), 0);
  assert.equal(volumeFromY(0, 100, 200), 100);
  assert.equal(volumeFromY(0, 0, 0), null);
});
test("release before asynchronous measurement commits the last pointer exactly once", async () => {
  let ready;
  const previews = [],
    commits = [];
  const d = createVerticalDrag(
    () =>
      new Promise((resolve) => {
        ready = resolve;
      }),
    (v) => previews.push(v),
    (v) => commits.push(v),
  );
  d.start(280);
  d.move(150);
  d.end(140);
  d.end(120);
  assert.deepEqual(commits, []);
  ready({ top: 100, height: 200 });
  await Promise.resolve();
  assert.deepEqual(previews, [80]);
  assert.deepEqual(commits, [80]);
});
test("cancelled or unmounted drags ignore a late measurement", async () => {
  let ready;
  const commits = [];
  const d = createVerticalDrag(
    () =>
      new Promise((resolve) => {
        ready = resolve;
      }),
    () => {},
    (v) => commits.push(v),
  );
  d.start(100);
  d.end(120);
  d.cancel();
  ready({ top: 0, height: 200 });
  await Promise.resolve();
  assert.deepEqual(commits, []);
});
