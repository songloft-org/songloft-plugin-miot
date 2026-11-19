// Exercise browser wheel input against a fully loaded song list.
const assert = require("node:assert/strict");
const puppeteer = require(process.env.BROWSER_PUPPETEER || "puppeteer");
const base = process.env.MIOT_TEST_BASE_URL || "http://127.0.0.1:30617";
const width = Number(process.env.MIOT_TEST_WIDTH || 390);
const embedded = process.env.MIOT_TEST_EMBEDDED_URL;
const songs = Array.from({ length: 1000 }, (_, index) => ({
  id: index + 1,
  title: `Song ${index + 1}`,
  artist: "Fixture artist",
  duration: 240,
}));
const fixtures = {
  "/config": {
    server_host: "http://192.168.1.10:58091",
    server_host_status: "ok",
  },
  "/auth/status": [{ id: "fixture" }],
  "/mina/devices": [
    {
      account_id: "fixture",
      devices: [{ device_id: "speaker", name: "Fixture", managed: true }],
    },
  ],
  "/playlists": [{ id: 1, name: "Scroll fixtures" }],
  "/playlists/1/songs": songs,
  "/playlists/1/progress": null,
  "/player/status": { position: 0, duration: 0, is_playing: false },
};

(async () => {
  const host = embedded || base;
  const auth = await fetch(host + "/api/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "admin" }),
  });
  assert.equal(auth.status, 200);
  const { access_token: token } = await auth.json();
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    const page = await browser.newPage();
    const errors = [];
    let songRequests = 0;
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewport({ width: embedded ? 390 : width, height: 740 });
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname.split(
        "/jsplugin/miot/api",
      )[1];
      if (!Object.hasOwn(fixtures, path)) return void request.continue();
      if (path.endsWith("/songs")) songRequests++;
      void request.respond({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, data: fixtures[path] }),
      });
    });
    await page.evaluateOnNewDocument(() => {
      window.miotTestRoot = () =>
        document.getElementById("plugin-view")?.shadowRoot ||
        document.getElementById("app")?.shadowRoot?.querySelector("lynx-view")
          ?.shadowRoot;
    });
    if (embedded) {
      await page.goto(embedded);
      await page.evaluate(
        ({ embedded, token }) =>
          new Promise((resolve, reject) => {
            const open = indexedDB.open("songloft", 1);
            open.onupgradeneeded = () => open.result.createObjectStore("kv");
            open.onerror = () => reject(open.error);
            open.onsuccess = () => {
              const db = open.result;
              const tx = db.transaction("kv", "readwrite");
              const kv = tx.objectStore("kv");
              kv.put(token, "secure.access_token");
              kv.put(embedded, "prefs.server_url");
              kv.put("zh", "prefs.language");
              tx.oncomplete = () => {
                db.close();
                resolve();
              };
            };
          }),
        { embedded, token },
      );
      await page.reload();
      const pluginTile = await page.waitForFunction(() =>
        [
          ...(document
            .getElementById("app")
            ?.shadowRoot?.querySelectorAll("x-text") || []),
        ].find((node) => node.textContent === "智能音箱"),
      );
      await pluginTile.asElement().click();
      await page.waitForFunction(() =>
        window.miotTestRoot()?.querySelector(".library-heading"),
      );
      await page.setViewport({ width, height: 740 });
    } else {
      await page.goto(
        base + "/api/v1/jsplugin/miot/static/index.html?access_token=" + token,
      );
    }

    const point = await page.waitForFunction(() => {
      const list = window.miotTestRoot()?.querySelector(".songs-scroll");
      if (list?.scrollHeight < 64000) return false;
      const rect = list?.getBoundingClientRect();
      return rect?.height > 200
        ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
        : false;
    });
    const { x, y } = await point.jsonValue();
    await page.mouse.move(x, y);
    const reports = [];
    for (const { delta, count } of [
      { delta: 1750, count: 19 },
      { delta: -650, count: 23 },
    ]) {
      await page.evaluate(
        ({ x, y }) => {
          const root = window.miotTestRoot();
          const list = root.querySelector(".songs-scroll");
          const result = { start: list.scrollTop, samples: [] };
          window.miotScrollProbe = result;
          const sample = () => {
            if (window.miotScrollProbe !== result) return;
            const top = list.scrollTop;
            const title = root
              .elementFromPoint(x, y)
              ?.closest(".song-row")
              ?.querySelector(".song-title")?.textContent;
            const index = Number(title?.match(/^Song (\d+)$/)?.[1]);
            result.samples.push({ top, index });
            requestAnimationFrame(sample);
          };
          requestAnimationFrame(sample);
        },
        { x, y },
      );
      for (let i = 0; i < count; i++) {
        await page.mouse.wheel({ deltaY: delta });
        await new Promise((resolve) => setTimeout(resolve, 12));
      }
      const result = await page.evaluate(async () => {
        await new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        );
        const probe = window.miotScrollProbe;
        delete window.miotScrollProbe;
        return probe;
      });
      const moved = result.samples.filter(
        (sample) => sample.top !== result.start,
      );
      assert.ok(moved.length > 0, "wheel input must move the list");
      const distance = moved.at(-1).top - result.start;
      assert.ok(
        Math.sign(distance) === Math.sign(delta) && Math.abs(distance) > 5000,
      );
      const empty = moved.filter(({ index }) => !index);
      const indices = moved.map(({ index }) => index).filter(Boolean);
      reports.push({
        delta,
        distance,
        samples: moved.length,
        empty: empty.length,
        first: indices[0],
        last: indices.at(-1),
      });
    }
    console.log(
      JSON.stringify({
        width,
        embedded: Boolean(embedded),
        reports,
        songRequests,
      }),
    );
    assert.deepEqual(
      reports.map(({ empty }) => empty),
      [0, 0],
      "every scrolled viewport sample must hit a song row",
    );
    assert.equal(
      songRequests,
      1,
      "all 1,000 fixture songs were loaded before scrolling",
    );
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
