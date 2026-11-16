import { readSetup } from "./setup-source.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const read = (file) =>
  readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
const compile = (source) =>
  ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
  }).outputText;
const apiSource = compile(read("api.ts"));
const storeSource = compile(read("store.ts"));
const pageSource = compile(
  readSetup("views/settings/ToolboxSettings.vue") +
    "\nexport { text, sendText, repeatText };",
);

function toolbox({
  response = async () => ({ success: true, data: {} }),
  webSocket,
} = {}) {
  const calls = [];
  const statusRequests = [];
  let clock = Date.now();
  class Clock extends Date {
    constructor(...args) {
      super(...(args.length ? args : [clock]));
    }
  }
  const vue = {
    reactive: (value) => value,
    ref: (value) => ({ value }),
    computed: (fn) => ({
      get value() {
        return fn();
      },
    }),
  };
  const context = {
    console,
    Error,
    Date: Clock,
    WebSocket: webSocket,
    document: new EventTarget(),
    setTimeout: () => 1,
    clearTimeout() {},
    setInterval: () => 1,
    clearInterval() {},
    window: Object.assign(new EventTarget(), {
      location: {
        pathname: "/api/v1/jsplugin/miot",
        protocol: "http:",
        host: "localhost",
      },
      SongloftPlugin: {
        apiPost: async (path, body) => {
          calls.push([path, JSON.parse(JSON.stringify(body))]);
          return response(path, body);
        },
        apiGet: async (path) => {
          statusRequests.push(path);
          return { success: true, data: { position: 0 } };
        },
      },
    }),
  };
  const api = {};
  const sdk = {
    onPush: () => () => {},
    invokeHost: async (_ns, _method, params) => {
      const path = params.path.slice(4);
      if (params.method === "GET") {
        statusRequests.push(path);
        return { ok: true, data: { success: true, data: { position: 0 } } };
      }
      calls.push([path, JSON.parse(JSON.stringify(params.body))]);
      return { ok: true, data: await response(path, params.body) };
    },
  };
  for (const [method, name] of Object.entries({
    GET: "apiGet",
    POST: "apiPost",
    PUT: "apiPut",
    DELETE: "apiDelete",
  })) {
    sdk[name] = async (path, body) =>
      (await sdk.invokeHost("plugin", "apiRequest", { method, path, body }))
        .data;
  }
  vm.runInNewContext(apiSource, {
    ...context,
    exports: api,
    require: (name) => {
      if (name === "@songloft/lynx-plugin-sdk") return sdk;
      throw new Error(name);
    },
  });
  const store = {};
  vm.runInNewContext(storeSource, {
    ...context,
    exports: store,
    require: (name) => {
      if (name === "@vue/reactivity" || name === "../../page-state") return vue;
      if (name === "@songloft/lynx-plugin-sdk") return sdk;
      if (name === "./socket") return { PluginSocket: webSocket };
      if (name === "./api") return api;
      throw new Error(`unexpected dependency: ${name}`);
    },
  });
  store.state.currentAccountId = "account";
  store.state.currentDeviceId = "device";
  store.state.devices = [
    { account_id: "account", devices: [{ device_id: "device", name: "音箱" }] },
  ];
  const page = {};
  vm.runInNewContext(pageSource, {
    ...context,
    exports: page,
    require: (name) => {
      if (name === "@vue/reactivity" || name === "../../page-state") return vue;
      if (name === "@songloft/lynx-plugin-sdk") return sdk;
      if (name === "./socket") return { PluginSocket: webSocket };
      if (name === "../../store") return store;
      throw new Error(`unexpected dependency: ${name}`);
    },
  });
  return {
    ...store,
    ...page,
    calls,
    statusRequests,
    tick: () => {
      clock += 60000;
    },
  };
}

test("successful TTS records the trimmed original text and clears the submitted input", async () => {
  const t = toolbox();
  t.text.value = "  吃饭了  ";
  await t.sendText();
  assert.deepEqual(t.calls, [
    [
      "/mina/tts",
      { account_id: "account", device_id: "device", text: "吃饭了" },
    ],
  ]);
  assert.equal(t.text.value, "");
  assert.equal(t.state.operationLog.length, 1);
  assert.equal(t.state.operationLog[0].ttsText, "吃饭了");
  assert.equal(t.state.operationLog[0].success, true);
});

test("equal text updates one record and moves it to the top; different text remains distinct", async () => {
  const t = toolbox();
  t.text.value = "吃饭了";
  await t.sendText();
  const first = { ...t.state.operationLog[0] };
  t.text.value = "开会了";
  await t.sendText();
  t.tick();
  t.text.value = "  吃饭了\n";
  await t.sendText();
  assert.equal(t.state.operationLog.length, 2);
  assert.equal(t.state.operationLog[0].ttsText, "吃饭了");
  assert.equal(t.state.operationLog[0].id, first.id);
  assert.notEqual(t.state.operationLog[0].time, first.time);
  assert.equal(t.state.operationLog[1].ttsText, "开会了");
});

test("replay sends saved text to the currently selected device and updates the existing record", async () => {
  const t = toolbox();
  t.text.value = "吃饭了";
  await t.sendText();
  const record = { ...t.state.operationLog[0] };
  t.state.currentDeviceId = "new-device";
  t.text.value = "尚未发送的草稿";
  t.tick();
  await t.repeatText(record.ttsText);
  assert.deepEqual(t.calls[1], [
    "/mina/tts",
    { account_id: "account", device_id: "new-device", text: "吃饭了" },
  ]);
  assert.equal(t.state.operationLog.length, 1);
  assert.equal(t.state.operationLog[0].id, record.id);
  assert.notEqual(t.state.operationLog[0].time, record.time);
  assert.equal(t.text.value, "尚未发送的草稿");
});

test("cloud rejection records the original text and error, preserves input, and permits retry", async () => {
  let failed = true;
  const t = toolbox({
    response: async () =>
      failed
        ? { success: false, error: "failed to play tts" }
        : { success: true, data: {} },
  });
  t.text.value = "吃饭了";
  await t.sendText();
  assert.equal(t.state.operationLog.length, 1);
  assert.equal(t.state.operationLog[0].ttsText, "吃饭了");
  assert.equal(t.state.operationLog[0].message, "failed to play tts");
  assert.equal(t.state.operationLog[0].success, false);
  assert.equal(t.text.value, "吃饭了");
  assert.equal(t.state.playerBusy, false);
  const id = t.state.operationLog[0].id;
  failed = false;
  await t.repeatText(t.state.operationLog[0].ttsText);
  assert.equal(t.state.operationLog.length, 1);
  assert.equal(t.state.operationLog[0].id, id);
  assert.equal(t.state.operationLog[0].success, true);
});

test("network failure during replay updates the original record instead of adding a generic error", async () => {
  let failed = false;
  const t = toolbox({
    response: async () => {
      if (failed) throw new Error("网络断开");
      return { success: true, data: {} };
    },
  });
  t.text.value = "吃饭了";
  await t.sendText();
  const id = t.state.operationLog[0].id;
  failed = true;
  await t.repeatText("吃饭了");
  assert.equal(t.state.operationLog.length, 1);
  assert.equal(t.state.operationLog[0].id, id);
  assert.equal(t.state.operationLog[0].success, false);
  assert.equal(t.state.operationLog[0].message, "网络断开");
  assert.equal(t.state.playerBusy, false);
});

test("busy commands do not send requests, create records, or clear text", async () => {
  const t = toolbox();
  t.state.playerBusy = true;
  t.text.value = "吃饭了";
  await t.sendText();
  assert.equal(t.text.value, "吃饭了");
  await t.repeatText("吃饭了");
  assert.equal(t.calls.length, 0);
  assert.equal(t.state.operationLog.length, 0);
});

test("in-flight TTS blocks duplicates and cannot clear a newly edited draft", async () => {
  let resolve;
  const t = toolbox({
    response: () =>
      new Promise((res) => {
        resolve = res;
      }),
  });
  t.text.value = "吃饭了";
  const pending = t.sendText();
  assert.equal(t.state.playerBusy, true);
  await t.sendText();
  assert.equal(t.text.value, "吃饭了");
  t.text.value = "新草稿";
  await t.repeatText("另一条记录");
  assert.equal(t.calls.length, 1);
  resolve({ success: true, data: {} });
  await pending;
  assert.equal(t.text.value, "新草稿");
  assert.equal(t.state.operationLog.length, 1);
  assert.equal(t.state.operationLog[0].ttsText, "吃饭了");
  assert.equal(t.state.playerBusy, false);
});

test("empty text is ignored and missing target preserves input without a cloud request", async () => {
  const t = toolbox();
  t.text.value = "  \n";
  await t.sendText();
  assert.equal(t.calls.length, 0);
  assert.equal(t.state.operationLog.length, 0);
  t.state.currentDeviceId = "";
  t.text.value = "吃饭了";
  await t.sendText();
  assert.equal(t.calls.length, 0);
  assert.equal(t.text.value, "吃饭了");
  assert.equal(t.state.playerBusy, false);
});

test("history stays within 30 entries, same-second keys are unique, and clearing allows a fresh record", async () => {
  const t = toolbox();
  for (let i = 0; i < 31; i++) {
    t.text.value = `播报 ${i}`;
    await t.sendText();
  }
  assert.equal(t.state.operationLog.length, 30);
  assert.equal(t.state.operationLog.at(-1).ttsText, "播报 1");
  assert.equal(new Set(t.state.operationLog.map((item) => item.id)).size, 30);
  const lastId = t.state.operationLog[0].id;
  t.state.operationLog = [];
  await t.repeatText("播报 30");
  assert.equal(t.state.operationLog.length, 1);
  assert.notEqual(t.state.operationLog[0].id, lastId);
});

test("ordinary player commands keep their existing success and failure logging behavior", async () => {
  let failed = false;
  const t = toolbox({
    response: async () =>
      failed
        ? { success: false, error: "暂停失败" }
        : { success: true, data: {} },
  });
  await t.playerCommand("/mina/pause");
  assert.equal(t.state.operationLog.length, 0);
  failed = true;
  await assert.rejects(t.playerCommand("/mina/pause"), /暂停失败/);
  assert.equal(t.state.operationLog.length, 1);
  assert.equal(t.state.operationLog[0].ttsText, undefined);
  assert.equal(t.state.operationLog[0].message, "暂停失败");
});

test("a broken status socket cannot mark an accepted TTS as failed and still permits an HTTP refresh", async () => {
  class BrokenSocket {
    OPEN = 1;
    CLOSED = 3;
    readyState = this.OPEN;
    send() {
      throw new Error("状态连接已断开");
    }
    close() {}
  }
  const t = toolbox({ webSocket: BrokenSocket });
  t.connectStatusStream();
  t.text.value = "吃饭了";
  await t.sendText();
  assert.equal(t.calls.length, 1);
  assert.equal(t.state.operationLog.length, 1);
  assert.equal(t.state.operationLog[0].success, true);
  assert.equal(t.text.value, "");
  assert.equal(t.statusRequests.length, 1);
  assert.equal(t.state.playerBusy, false);
  assert.equal(t.state.snackbar, null);
  t.disposeStore();
});
