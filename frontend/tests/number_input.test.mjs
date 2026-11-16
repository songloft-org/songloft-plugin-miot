import assert from "node:assert/strict";
import test from "node:test";
import { controls } from "./native-controls-harness.mjs";

function find(node, predicate) {
  if (!node || typeof node !== "object") return;
  if (predicate(node)) return node;
  for (const child of [node.props?.children].flat(Infinity)) {
    const result = find(child, predicate);
    if (result) return result;
  }
}
const input = (tree) => find(tree, (node) => node.type === "input");

test("number fields use numeric keyboards and show units", () => {
  const tree = controls().render("SlInput", {
    type: "number",
    modelValue: "6",
    min: 1,
    max: 30,
    step: 1,
    unit: "秒",
  });
  assert.equal(input(tree).props.type, "number");
  assert.ok(find(tree, (node) => node.props?.className === "number-unit"));
});

test("numeric normalization rejects malformed values and respects bounds and precision", () => {
  const h = controls();
  for (const [raw, expected] of [
    ["", "6"],
    ["Infinity", "6"],
    ["2abc", "6"],
    ["0", "1"],
    ["999", "30"],
  ])
    assert.equal(
      h.render("normalizeNumericValue", {
        raw,
        previous: "6",
        min: 1,
        max: 30,
      }),
      expected,
    );
  assert.equal(
    h.render("normalizeNumericValue", {
      raw: "-80",
      previous: "0",
      min: -30,
      max: 30,
    }),
    "-30",
  );
  assert.equal(
    h.render("normalizeNumericValue", { raw: "1.2", step: 0.1 }),
    "1.2",
  );
});

test("clearing a number restores the prior value and remounts the uncontrolled editor", () => {
  const h = controls(),
    updates = [];
  let commits = 0;
  const props = {
    type: "number",
    modelValue: "6",
    min: 1,
    max: 30,
    onUpdateModelValue: (value) => updates.push(value),
    onChange: () => commits++,
  };
  const before = input(h.render("SlInput", props));
  before.props.onInput("");
  before.props.onBlur();
  const after = input(h.render("SlInput", props));
  assert.equal(updates.at(-1), "6");
  assert.equal(after.props.defaultValue, "6");
  assert.notEqual(after.key, before.key);
  assert.equal(commits, 0);
});

test("strict timer fields keep invalid entries visible without submitting", () => {
  const h = controls();
  let submitted = 0;
  const props = {
    type: "number",
    modelValue: "5",
    min: 1,
    max: 999,
    strictNumber: true,
    onSubmit: () => submitted++,
  };
  const editor = input(h.render("SlInput", props));
  editor.props.onInput("0");
  editor.props.onConfirm();
  assert.equal(submitted, 0);
  const notice = find(
    h.render("SlInput", props),
    (node) => node.props?.className === "number-notice",
  );
  assert.match(notice.props.children, /1–999/);
});

test("signed numeric settings provide an explicit sign control", () => {
  const h = controls(),
    updates = [];
  const tree = h.render("SlInput", {
    type: "number",
    modelValue: "5",
    min: -30,
    max: 30,
    onUpdateModelValue: (value) => updates.push(value),
  });
  find(tree, (node) => node.props?.className === "number-sign").props.onClick();
  assert.equal(updates.at(-1), "-5");
});
