import assert from "node:assert/strict";
import test from "node:test";
import { controls } from "./native-controls-harness.mjs";
const tick = () => new Promise((resolve) => setImmediate(resolve));
const props = {
  modelValue: "1",
  options: [
    { value: "1", label: "One" },
    { value: "2", label: "Two" },
  ],
};
const position = { left: "12px", top: "160px", width: "320px", height: "96px" };
function open(measurePopover) {
  const navigation = { selectOpen: false };
  const h = controls({ measurePopover, navigation });
  let tree = h.render("SlSelect", props);
  h.flushEffects();
  tree.props.children[0].props.bindtap();
  tree = h.render("SlSelect", props);
  h.flushEffects();
  return { h, navigation, tree };
}
test("selector first paints at its measured anchor, never as a centered dialog", async () => {
  let resolve;
  const { h, tree } = open(
    () =>
      new Promise((yes) => {
        resolve = yes;
      }),
  );
  assert.ok(
    !tree.props.children[1],
    "pending geometry must not paint a fallback card",
  );
  resolve(position);
  await tick();
  const overlay = h.render("SlSelect", props).props.children[1];
  const card = overlay.props.children.props.children;
  assert.ok(card.props.className.includes("select-popup"));
  assert.deepEqual(card.props.style, position);
  assert.ok(
    !card.props.children[0],
    "no centered-dialog heading flashes before the options",
  );
});
test("failed selector measurement shows the fallback once instead of hanging", async () => {
  const { h, tree } = open(() => Promise.reject(Error("unavailable")));
  assert.ok(!tree.props.children[1]);
  await tick();
  const card = h.render("SlSelect", props).props.children[1].props.children
    .props.children;
  assert.ok(!card.props.className.includes("select-popup"));
  assert.ok(card.props.children[0]);
});
test("back during pending selector measurement prevents a late popup", async () => {
  let resolve;
  const { h, navigation } = open(
    () =>
      new Promise((yes) => {
        resolve = yes;
      }),
  );
  navigation.selectOpen = false;
  h.render("SlSelect", props);
  h.flushEffects();
  resolve(position);
  await tick();
  assert.ok(!h.render("SlSelect", props).props.children[1]);
});
