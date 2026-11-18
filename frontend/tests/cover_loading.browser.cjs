// Deterministic image bytes, real Lynx rendering; isolated backend only.
const assert = require("node:assert/strict");
const puppeteer = require(process.env.BROWSER_PUPPETEER || "puppeteer");
const base = process.env.MIOT_TEST_BASE_URL || "http://127.0.0.1:30617";
const width = Number(process.env.MIOT_TEST_WIDTH || 390);
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAIAAABMXPacAAABSklEQVR4nO3TUQ2DUBREQWgQhIQroZIqoZKQghREvI9J0zMKNjnZ/Z739stmvnrCkpce8O8KgBUAKwBWAKwAWAGwAmAFwAqAFQArAFYArABYAbACYAXACoAVACsAVgCsAFgBsAJgBcAKgBUAKwBWAKwAWAGwAmAFwAqAFQArAFYArABYAbACYAXACoAVACsAVgCsAFgBsAJgBcAKgBUAKwBWAKwAWAGwAmAFwAqAFQArAFYArABYAbBjPqfesOTaRk9Y0gOwAmAFwAqAFQArAFYArABYAbACYAXACoAVACsAVgCsAFgBsAJgBcAKgBUAKwBWAKwAWAGwAmAFwAqAFQArAFYArABYAbACYAXACoAVACsAVgCsAFgBsAJgBcAKgBUAKwBWAKwAWAGwAmAFwAqAFQArAFYArABYAbACYAXACoAVACsAVgDsARW0BXJQrI1nAAAAAElFTkSuQmCC",
  "base64",
);
(async () => {
  const auth = await (
    await fetch(base + "/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "admin" }),
    })
  ).json();
  const songs = Array.from({ length: 100 }, (_, i) => ({
    id: i + 1,
    title: "Cover fixture " + (i + 1),
    artist: "Fixture artist",
    duration: 240,
    cover_url: i === 3 ? "" : "/api/v1/songs/" + (i + 1) + "/cover?v=fixture",
  }));
  const fixtures = {
    "/auth/status": [{ id: "fixture", account: "fixture" }],
    "/mina/devices": [
      {
        account_id: "fixture",
        devices: [
          { device_id: "speaker", name: "Fixture speaker", managed: true },
        ],
      },
    ],
    "/playlists": [{ id: 1, name: "Cover fixtures", song_count: songs.length }],
    "/playlists/1/songs": songs,
    "/playlists/1/progress": { song_id: 1, position: 60 },
    "/player/status": {
      current_song: songs[0],
      playlist_id: 1,
      is_playing: true,
      position: 20,
      duration: 240,
      volume: 40,
      play_mode: "order",
      speed: 1,
    },
    "/lyric": { lyric: "[00:00.00]Cover fixture lyric" },
    "/player/favorite/status": { is_favorited: false },
    "/voice-commands/sleep-timer": {
      active: false,
      mode: "time",
      remaining: 0,
      total: 0,
    },
  };
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage(),
    errors = [];
  let failLargeOnce = true;
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewport({ width, height: 800, hasTouch: width < 600 });
  await page.evaluateOnNewDocument(() => {
    window.WebSocket = class {
      constructor() {
        throw Error("fixture socket unavailable");
      }
    };
  });
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    const url = new URL(request.url()),
      prefix = "/api/v1/jsplugin/miot/api";
    if (/^\/api\/v1\/songs\/\d+\/cover$/.test(url.pathname)) {
      const id = Number(url.pathname.split("/")[4]);
      const transientFailure =
        id === 1 && url.searchParams.get("w") === "640" && failLargeOnce;
      if (transientFailure) failLargeOnce = false;
      const ok = !!url.searchParams.get("access_token") && !transientFailure;
      void request.respond({
        status: ok ? 200 : 404,
        contentType: ok ? "image/png" : "text/plain",
        body: ok ? png : "missing",
      });
      return;
    }
    const data = url.pathname.startsWith(prefix)
      ? fixtures[url.pathname.slice(prefix.length)]
      : undefined;
    if (data !== undefined)
      void request.respond({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, data }),
      });
    else void request.continue();
  });
  const decoded = async (selector) =>
    page.waitForFunction(
      (selector) => {
        const nodes = [
          ...document
            .getElementById("plugin-view")
            .shadowRoot.querySelectorAll(selector),
        ];
        return (
          nodes.length > 0 &&
          nodes.every((node) => {
            const img = node.shadowRoot?.querySelector("img");
            return img?.complete && img.naturalWidth === 128;
          })
        );
      },
      {},
      selector,
    );
  const click = async (selector) => {
    const p = await page.evaluate((selector) => {
      const r = document
        .getElementById("plugin-view")
        .shadowRoot.querySelector(selector)
        .getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }, selector);
    if (width < 600) await page.touchscreen.tap(p.x, p.y);
    else await page.mouse.click(p.x, p.y);
  };
  try {
    await page.goto(
      base +
        "/api/v1/jsplugin/miot/static/index.html?access_token=" +
        auth.access_token,
    );
    await page.waitForFunction(
      () =>
        document
          .getElementById("plugin-view")
          ?.shadowRoot?.querySelectorAll(".song-row").length === 30,
    );
    await decoded(".mini-cover .cover-image");
    await page.evaluate(() => {
      const root = document.getElementById("plugin-view").shadowRoot;
      window.falseDefaults = [];
      const seen = new WeakSet();
      const inspect = (node, target) => {
        if (!(node instanceof Element)) return;
        for (const placeholder of [
          node,
          ...node.querySelectorAll(".cover-placeholder"),
        ]) {
          if (
            !placeholder.matches(".cover-placeholder") ||
            seen.has(placeholder)
          )
            continue;
          const cover =
            placeholder.closest(".cover-frame") ||
            target.closest?.(".cover-frame");
          if (!cover) continue;
          const row = cover.closest(".song-row");
          const id = Number(row?.querySelector(".song-index")?.textContent);
          if (row && id === 4) continue;
          if (
            row ||
            cover.matches(".mini-cover,.large-cover,.player-ambient-cover")
          ) {
            seen.add(placeholder);
            window.falseDefaults.push({
              scope: cover.className,
              id,
              time: performance.now(),
            });
          }
        }
      };
      window.placeholderObserver = new MutationObserver((records) => {
        for (const r of records) {
          if (r.type === "attributes") inspect(r.target, r.target);
          for (const n of r.addedNodes) inspect(n, r.target);
        }
      });
      window.placeholderObserver.observe(root, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ["class"],
      });
    });
    await click(".mini-stage");
    await decoded(".large-cover .cover-image");
    await click(".fullscreen-topbar .sl-button");
    await decoded(".mini-cover .cover-image");
    await click('.appbar-actions [accessibility-label="设置"]');
    await page.waitForFunction(() =>
      document
        .getElementById("plugin-view")
        .shadowRoot.querySelector(".settings-shell"),
    );
    await click(".settings-shell .page-toolbar .sl-button");
    await page.waitForFunction(
      () =>
        !document
          .getElementById("plugin-view")
          .shadowRoot.querySelector(".settings-shell"),
    );
    await decoded(".mini-cover .cover-image");
    const point = await page.evaluate(() => {
      const r = document
        .getElementById("plugin-view")
        .shadowRoot.querySelector(".songs-scroll")
        .getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    await page.mouse.move(point.x, point.y);
    await page.mouse.wheel({ deltaY: 100000 });
    await page.waitForFunction(
      () =>
        Number(
          document
            .getElementById("plugin-view")
            .shadowRoot.querySelector(".song-row .song-index")?.textContent,
        ) > 50,
    );
    await decoded(".song-row .cover-image");
    await page.mouse.wheel({ deltaY: -100000 });
    await page.waitForFunction(
      () =>
        document
          .getElementById("plugin-view")
          .shadowRoot.querySelector(".song-row .song-index")?.textContent ===
        "1",
    );
    await decoded(".song-row .cover-image");
    for (let cycle = 0; cycle < 5; cycle++) {
      await page.evaluate(() => {
        const f = document.getElementById("plugin-view");
        f.sendGlobalEvent("SongloftPluginBridge.push", [
          { event: "lifecycle", data: '{"state":"paused"}' },
        ]);
        f.style.display = "none";
      });
      await page.evaluate(
        () => new Promise((resolve) => setTimeout(resolve, 60)),
      );
      await page.evaluate(() => {
        const f = document.getElementById("plugin-view");
        f.style.display = "";
        f.sendGlobalEvent("SongloftPluginBridge.push", [
          { event: "lifecycle", data: '{"state":"resumed"}' },
        ]);
      });
      await decoded(".mini-cover .cover-image");
    }
    const falseDefaults = await page.evaluate(() => window.falseDefaults);
    const fallback = await page.evaluate(() => {
      const p = [
        ...document
          .getElementById("plugin-view")
          .shadowRoot.querySelectorAll(".song-row"),
      ]
        .find((r) => r.querySelector(".song-index")?.textContent === "4")
        ?.querySelector(".cover-placeholder");
      return { hasSvg: !!p?.querySelector("x-svg,svg"), text: p?.textContent };
    });
    console.log(
      JSON.stringify(
        { width, falseDefaults, fallback, errors, largeRetry: !failLargeOnce },
        null,
        2,
      ),
    );
    assert.deepEqual(
      falseDefaults,
      [],
      "known covers must not flash the no-cover icon, even briefly",
    );
    assert.equal(fallback.hasSvg, true);
    assert.equal(
      failLargeOnce,
      false,
      "the full-cover retry must be exercised",
    );
    assert.deepEqual(errors, []);
  } catch (error) {
    await page.screenshot({
      path: "/tmp/miot-cover-loading-" + width + "-failure.png",
    });
    throw error;
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
