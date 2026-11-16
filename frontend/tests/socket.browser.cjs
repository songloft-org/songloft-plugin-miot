// Exercise the installed SDK through the real host and plugin WebSocket route.
// HTTP account/device fixtures avoid requiring Xiaomi credentials or hardware.
const assert = require("node:assert/strict");
const puppeteer = require(process.env.BROWSER_PUPPETEER || "puppeteer");
const base = process.env.MIOT_TEST_BASE_URL || "http://127.0.0.1:30617";
const waitFor = async (condition) => {
  const deadline = Date.now() + 15000;
  while (!condition() && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(condition(), "socket lifecycle completed before the deadline");
};
(async () => {
  const auth = await (
    await fetch(base + "/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "admin" }),
    })
  ).json();
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    const page = await browser.newPage(),
      sockets = [],
      errors = [];
    await page.setViewport({ width: 390, height: 740 });
    page.on("pageerror", (error) => errors.push(error.message));
    const network = await page.target().createCDPSession();
    await network.send("Network.enable");
    const connections = new Map();
    network.on("Network.webSocketCreated", ({ requestId, url }) => {
      if (new URL(url).pathname !== "/api/v1/jsplugin/miot/status/ws") return;
      const record = { frames: 0, closed: false };
      sockets.push(record);
      connections.set(requestId, record);
    });
    network.on("Network.webSocketFrameReceived", ({ requestId, response }) => {
      const record = connections.get(requestId);
      if (!record) return;
      try {
        if (JSON.parse(response.payloadData).type === "status") record.frames++;
      } catch {}
    });
    network.on("Network.webSocketClosed", ({ requestId }) => {
      const record = connections.get(requestId);
      if (record) record.closed = true;
    });
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      let data;
      if (path === "/api/v1/jsplugin/miot/api/auth/status")
        data = [{ id: "sdk-fixture", account: "sdk-fixture" }];
      if (path === "/api/v1/jsplugin/miot/api/mina/devices")
        data = [
          {
            account_id: "sdk-fixture",
            devices: [
              { device_id: "sdk-speaker", name: "SDK fixture", managed: true },
            ],
          },
        ];
      if (data !== undefined)
        void request.respond({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ success: true, data }),
        });
      else void request.continue();
    });
    await page.goto(
      base +
        "/api/v1/jsplugin/miot/static/index.html?access_token=" +
        auth.access_token,
    );
    await waitFor(() => sockets.length === 1 && sockets[0].frames > 0);
    const lifecycle = (state) =>
      page.evaluate(
        (state) =>
          document
            .getElementById("plugin-view")
            .sendGlobalEvent("SongloftPluginBridge.push", [
              { event: "lifecycle", data: JSON.stringify({ state }) },
            ]),
        state,
      );
    await lifecycle("paused");
    await waitFor(() => sockets[0].closed);
    await lifecycle("resumed");
    await waitFor(() => sockets.length === 2 && sockets[1].frames > 0);
    assert.deepEqual(errors, []);
    console.log(
      JSON.stringify({
        passed: true,
        realSocket: true,
        pausedConnectionClosed: true,
        resumedStatusReceived: true,
        connections: sockets.length,
      }),
    );
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
