import assert from "node:assert/strict";
import test from "node:test";
import { controls } from "./native-controls-harness.mjs";
test("drag preview survives incoming status updates and commits once on release", () => {
  const h = controls(),
    updates = [],
    commits = [];
  const props = {
    modelValue: 20,
    max: 100,
    onUpdateModelValue: (v) => updates.push(v),
    onCommit: (v) => commits.push(v),
  };
  let tree = h.render("SlSlider", props);
  tree.props.onDragging(0.73);
  tree = h.render("SlSlider", { ...props, modelValue: 25 });
  assert.equal(tree.props.value, 0.73);
  assert.deepEqual(updates, []);
  tree.props.onValueCommit(0.73);
  assert.deepEqual(updates, [73]);
  assert.deepEqual(commits, [73]);
  tree = h.render("SlSlider", { ...props, modelValue: 73 });
  assert.equal(tree.props.value, 0.73);
});
test("input arriving before the focus callback still rejects a late parent echo", () => {
  const h = controls();
  let tree = h.render("SlTextArea", { modelValue: "before" });
  h.flushEffects();
  tree.props.children.props.onInput("first");
  tree.props.children.props.onInput("newer");
  h.render("SlTextArea", { modelValue: "first" });
  h.flushEffects();
  tree = h.render("SlTextArea", { modelValue: "first" });
  assert.equal(tree.props.children.props.defaultValue, "before");
});
test("input drafts update while typing and save only on blur or confirmation", () => {
  const h = controls(),
    updates = [],
    saved = [];
  let tree = h.render("SlInput", {
    modelValue: "before",
    onUpdateModelValue: (v) => updates.push(v),
    onChange: () => saved.push(true),
  });
  tree.props.onFocus();
  tree.props.onInput("draft");
  tree = h.render("SlInput", { modelValue: "draft" });
  assert.equal(tree.props.defaultValue, "before");
  assert.deepEqual(updates, ["draft"]);
  assert.equal(saved.length, 0);
});

test("changing a disabled fieldset preserves select and input hook order", () => {
  const h = controls();
  for (const disabled of [false, true, false]) {
    h.render("SlSelect", { disabled, options: [] });
  }
  const input = controls();
  for (const disabled of [false, true, false]) {
    input.render("SlInput", { disabled, modelValue: "draft" });
  }
});

test("unchanged blur and repeated confirmations do not resave configuration", () => {
  const h = controls(),
    saved = [];
  const props = { modelValue: "before", onChange: () => saved.push(true) };
  let tree = h.render("SlInput", props);
  tree.props.onFocus();
  tree.props.onBlur();
  assert.equal(saved.length, 0);
  tree.props.onFocus();
  tree.props.onInput("after");
  tree.props.onBlur();
  assert.equal(saved.length, 1);
  tree.props.onConfirm();
  assert.equal(saved.length, 1);
});

test("multiline editing does not echo stale background renders into native text", () => {
  const h = controls(),
    updates = [];
  const props = {
    modelValue: "before",
    onUpdateModelValue: (value) => updates.push(value),
  };
  let tree = h.render("SlTextArea", props).props.children;
  tree.props.onFocus();
  tree.props.onInput("first\nsecond");
  tree = h.render("SlTextArea", { ...props, modelValue: "first" }).props
    .children;
  assert.equal(tree.props.value, undefined);
  assert.equal(tree.props.defaultValue, "before");
  assert.deepEqual(updates, ["first\nsecond"]);
});

test("SVG icon boxes use explicit units on native and Web", () => {
  const tree = controls().render("SlIcon", { name: "info", size: 20 });
  assert.equal(tree.type, "svg");
  assert.equal(tree.props.style.width, "20px");
  assert.equal(tree.props.style.height, "20px");
});

test("native inputs preserve caller spacing and accessible labels", () => {
  const style = { marginTop: "12px" };
  const tree = controls().render("SlInput", {
    modelValue: "http://server",
    style,
    className: "custom-server-input",
    "aria-label": "自定义服务器地址",
  });
  assert.equal(tree.props.style, style);
  assert.ok(tree.props.className.includes("custom-server-input"));
  assert.equal(tree.props["accessibility-label"], "自定义服务器地址");
});
