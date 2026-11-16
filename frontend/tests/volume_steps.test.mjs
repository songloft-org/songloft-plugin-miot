import assert from "node:assert/strict";
import test from "node:test";
import { controls } from "./native-controls-harness.mjs";
test("volume uses the original vertical control, five-point steps and mute memory", () => {
  const h = controls(),
    changes = [];
  let tree = h.render("VolumeControl", {
    value: 50,
    onChange: (v) => changes.push(v),
  });
  tree.props.children[1].props.onClick();
  tree.props.children[3].props.onClick();
  tree.props.children[4].props.onClick();
  assert.deepEqual(changes, [55, 45, 0]);
  tree = h.render("VolumeControl", { value: 0 });
  assert.equal(tree.props.children[3].props.disabled, true);
  tree = h.render("VolumeControl", {
    value: 0,
    onChange: (v) => changes.push(v),
  });
  tree.props.children[4].props.onClick();
  assert.equal(changes.at(-1), 50);
  tree = h.render("VolumeControl", { value: 100 });
  assert.equal(tree.props.children[1].props.disabled, true);
});
