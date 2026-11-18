// Deterministic image bytes, real Lynx rendering; isolated backend only.
const assert = require("node:assert/strict");
const puppeteer = require(process.env.BROWSER_PUPPETEER || "puppeteer");
const base = process.env.MIOT_TEST_BASE_URL || "http://127.0.0.1:30617";
const width = Number(process.env.MIOT_TEST_WIDTH || 390);
const height = Number(process.env.MIOT_TEST_HEIGHT || 800);
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
  const covers = [
    "/api/v1/songs/1/cover?v=123",
    "data:image/png;base64," + png.toString("base64"),
    base + "/cover-fixture.png?signature=opaque%2Fvalue",
    "",
    "/api/v1/songs/5/cover",
  ];
  const songs = covers.map((cover_url, i) => ({
    id: i + 1,
    title: "Cover fixture " + (i + 1),
    artist: "Fixture artist",
    duration: 240,
    cover_url,
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
    errors = [],
    requests = [];
  let recover = false;
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewport({ width, height, hasTouch: width < 600 });
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
    if (/^\/api\/v1\/songs\/(1|5)\/cover$/.test(url.pathname)) {
      const id = Number(url.pathname.split("/")[4]);
      requests.push({
        id,
        width: url.searchParams.get("w"),
        auth: !!url.searchParams.get("access_token"),
      });
      const ok =
        !!url.searchParams.get("access_token") && (id === 1 || recover);
      void request.respond({
        status: ok ? 200 : 404,
        contentType: ok ? "image/png" : "text/plain",
        body: ok ? png : "missing",
      });
      return;
    }
    if (url.pathname === "/cover-fixture.png") {
      const ok = url.search === "?signature=opaque%2Fvalue";
      void request.respond({
        status: ok ? 200 : 403,
        contentType: ok ? "image/png" : "text/plain",
        body: ok ? png : "invalid signature",
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
  const decoded = async (selector, minimum = 1) =>
    page.waitForFunction(
      (selector, minimum) => {
        const nodes = [
          ...document
            .getElementById("plugin-view")
            .shadowRoot.querySelectorAll(selector),
        ];
        return (
          nodes.length >= minimum &&
          nodes.every((node) => {
            const img = node.shadowRoot?.querySelector("img");
            return img?.complete && img.naturalWidth === 128;
          })
        );
      },
      {},
      selector,
      minimum,
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
  const snapshot = () =>
    page.evaluate(() => {
      const root = document.getElementById("plugin-view").shadowRoot,
        list = root.querySelector(".songs-scroll");
      const covers = [...root.querySelectorAll(".song-row .cover-frame")].slice(
        0,
        4,
      );
      return {
        height: list?.getBoundingClientRect().height,
        top: list?.scrollTop,
        sameList: list === window.originalSongList,
        sameCovers:
          covers.every((node, i) => node === window.originalCovers[i]) &&
          covers.length === 4,
        sameDefault:
          root
            .querySelectorAll(".song-row")[3]
            ?.querySelector(".cover-placeholder") === window.originalDefault,
        removals: window.coverRemovals,
      };
    });
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
          ?.shadowRoot?.querySelectorAll(".song-row").length === 5,
    );
    await decoded(
      ".song-row:nth-child(1) .cover-image, .song-row:nth-child(2) .cover-image, .song-row:nth-child(3) .cover-image",
      3,
    );
    if (height < 600) {
      const point = await page.evaluate(() => {
        const rect = document
          .getElementById("plugin-view")
          .shadowRoot.querySelector(".songs-scroll")
          .getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      });
      await page.mouse.move(point.x, point.y);
      await page.mouse.wheel({ deltaY: 1000 });
      await page.waitForFunction(
        () =>
          document
            .getElementById("plugin-view")
            .shadowRoot.querySelector(".songs-scroll").scrollTop > 0,
      );
    }
    await page.evaluate(() => {
      const root = document.getElementById("plugin-view").shadowRoot;
      window.originalSongList = root.querySelector(".songs-scroll");
      window.originalCovers = [
        ...root.querySelectorAll(".song-row .cover-frame"),
      ].slice(0, 4);
      window.originalDefault = root
        .querySelectorAll(".song-row")[3]
        .querySelector(".cover-placeholder");
      window.coverRemovals = 0;
      window.observer = new MutationObserver((records) => {
        for (const r of records)
          for (const node of r.removedNodes)
            if (
              window.originalCovers.some((c) => node === c || node.contains(c))
            )
              window.coverRemovals++;
      });
      window.observer.observe(root, { subtree: true, childList: true });
    });
    const before = await snapshot();
    await click(".mini-stage");
    await page.waitForFunction(() =>
      document
        .getElementById("plugin-view")
        .shadowRoot.querySelector(".player-full"),
    );
    const full = await snapshot();
    await click(".fullscreen-topbar .sl-button");
    await page.waitForFunction(() =>
      document
        .getElementById("plugin-view")
        .shadowRoot.querySelector(".player-mini"),
    );
    const afterPlayer = await snapshot();
    await click('.appbar-actions [accessibility-label="设置"]');
    await page.waitForFunction(() =>
      document
        .getElementById("plugin-view")
        .shadowRoot.querySelector(".settings-shell"),
    );
    const settings = await snapshot();
    await click(".settings-shell .page-toolbar .sl-button");
    await page.waitForFunction(
      () =>
        !document
          .getElementById("plugin-view")
          .shadowRoot.querySelector(".settings-shell"),
    );
    await decoded(
      ".song-row:nth-child(1) .cover-image, .song-row:nth-child(2) .cover-image, .song-row:nth-child(3) .cover-image",
    );
    const afterSettings = await snapshot();
    console.log(
      JSON.stringify(
        { width, before, full, afterPlayer, settings, afterSettings, errors },
        null,
        2,
      ),
    );
    assert.ok(full.sameList && full.sameCovers && full.sameDefault);
    assert.equal(
      full.height,
      before.height,
      "full player must not resize the retained list",
    );
    assert.ok(
      settings.sameList && settings.sameCovers && settings.sameDefault,
      "settings must retain the actual list and default cover",
    );
    assert.equal(
      settings.height,
      before.height,
      "settings must not resize the retained list",
    );
    assert.equal(
      full.top,
      before.top,
      "full player must preserve the list scroll offset",
    );
    assert.equal(
      afterSettings.top,
      before.top,
      "settings must preserve the list scroll offset",
    );
    assert.ok(
      afterSettings.sameList &&
        afterSettings.sameCovers &&
        afterSettings.sameDefault,
    );
    assert.equal(
      afterSettings.removals,
      0,
      "navigation must not remove healthy or default covers",
    );
    for (let cycle = 0; cycle < 5; cycle++) {
      await click('.appbar-actions [accessibility-label="设置"]');
      await page.waitForFunction(() =>
        document
          .getElementById("plugin-view")
          .shadowRoot.querySelector(".settings-shell"),
      );
      const hidden = await snapshot();
      assert.ok(hidden.sameList && hidden.sameCovers && hidden.sameDefault);
      assert.equal(hidden.height, before.height);
      await click(".settings-shell .page-toolbar .sl-button");
      await page.waitForFunction(
        () =>
          !document
            .getElementById("plugin-view")
            .shadowRoot.querySelector(".settings-shell"),
      );
      await click(".mini-stage");
      await page.waitForFunction(() =>
        document
          .getElementById("plugin-view")
          .shadowRoot.querySelector(".player-full"),
      );
      assert.equal((await snapshot()).height, before.height);
      await click(".fullscreen-topbar .sl-button");
      await page.waitForFunction(() =>
        document
          .getElementById("plugin-view")
          .shadowRoot.querySelector(".player-mini"),
      );
      const restored = await snapshot();
      assert.ok(
        restored.sameList && restored.sameCovers && restored.sameDefault,
      );
      assert.equal(restored.removals, 0);
    }
    console.log(
      JSON.stringify({
        repeatedNavigation: true,
        width,
        cycles: 6,
        final: await snapshot(),
      }),
    );
    assert.deepEqual(errors, []);
    await page.screenshot({
      path: "/tmp/miot-navigation-covers-" + width + ".png",
    });
  } catch (error) {
    await page.screenshot({
      path: "/tmp/miot-navigation-covers-" + width + "-failure.png",
    });
    throw error;
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
