import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import * as reactivity from "@vue/reactivity";
function fixture() {
  const state = reactivity.reactive({ confirm: { open: false } }),
    calls = [];
  let receive;
  const source = readFileSync(
    new URL("../src/runtime.ts", import.meta.url),
    "utf8",
  );
  const code = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
  }).outputText;
  const exports = {};
  new Function("require", "exports", code)((name) => {
    if (name === "@vue/reactivity") return reactivity;
    if (name === "@songloft/lynx-plugin-sdk")
      return {
        getGlobalProps: () => ({}),
        onPush: (callback) => {
          receive = callback;
          return () => {
            receive = null;
          };
        },
        invokeHost: async (ns, method, params) => {
          calls.push({ ns, method, params });
          return { ok: true };
        },
      };
    if (name === "./store")
      return {
        state,
        resolveConfirm: () => {
          state.confirm.open = false;
        },
      };
    throw new Error(name);
  }, exports);
  return {
    ...exports,
    state,
    calls,
    push: (data) => receive?.("navigationBack", JSON.stringify(data)),
  };
}
test("back closes topmost layers before settings categories and pages", () => {
  const h = fixture();
  h.openPage("settings");
  h.navigation.settingsCategory = "device";
  h.navigation.editorOpen = true;
  h.navigation.playerPopup = "volume";
  h.navigation.devicePickerOpen = true;
  h.navigation.selectOpen = true;
  h.state.confirm.open = true;
  h.consumeBack();
  assert.equal(h.state.confirm.open, false);
  assert.equal(h.navigation.selectOpen, true);
  h.consumeBack();
  assert.equal(h.navigation.selectOpen, false);
  h.consumeBack();
  assert.equal(h.navigation.devicePickerOpen, false);
  h.consumeBack();
  assert.equal(h.navigation.playerPopup, "");
  h.consumeBack();
  assert.equal(h.navigation.editorOpen, false);
  h.consumeBack();
  assert.equal(h.navigation.settingsCategory, "");
  h.consumeBack();
  assert.equal(h.navigation.page, "main");
  assert.equal(h.consumeBack(), false);
});
test("wide settings back closes the page together with the active category", () => {
  const h = fixture();
  h.navigation.wideLayout = true;
  h.openPage("settings");
  h.navigation.settingsCategory = "device";
  assert.equal(h.consumeBack(), true);
  assert.equal(h.navigation.settingsCategory, "");
  assert.equal(h.navigation.page, "main");
  assert.equal(h.consumeBack(), false);
});
test("host sessions correlate replies and cleanup removes subscriptions", () => {
  const h = fixture();
  h.openPage("player");
  const dispose = h.installHostBack();
  h.push({ type: "songloft-back-connect", session: "session" });
  h.push({ type: "songloft-back-request", session: "stale", id: 1 });
  assert.equal(h.navigation.page, "player");
  h.push({ type: "songloft-back-request", session: "session", id: 2 });
  assert.equal(h.navigation.page, "main");
  const result = h.calls.find((call) => call.method === "navigationResult");
  assert.deepEqual(result.params, {
    session: "session",
    id: 2,
    consumed: true,
    canBack: false,
  });
  dispose();
  h.openPage("settings");
  const count = h.calls.length;
  h.push({ session: "session", id: 3 });
  assert.equal(h.calls.length, count);
});
