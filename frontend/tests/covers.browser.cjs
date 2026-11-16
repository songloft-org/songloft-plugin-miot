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
      ".song-row:nth-child(2) .cover-image, .song-row:nth-child(3) .cover-image, .song-row:nth-child(4) .cover-image",
    );
    await decoded(".mini-cover .cover-image");
    await page.waitForFunction(() =>
      document
        .getElementById("plugin-view")
        .shadowRoot.querySelectorAll(".song-row")[4]
        ?.querySelector(".cover-placeholder"),
    );
    for (
      let i = 0;
      i < 30 && requests.filter((r) => r.id === 5).length < 3;
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(
      requests.filter((r) => r.id === 5).length,
      3,
      "permanent 404 retries are bounded",
    );
    const sources = await page.evaluate(() =>
      [
        ...document
          .getElementById("plugin-view")
          .shadowRoot.querySelectorAll(".song-row"),
      ]
        .slice(0, 3)
        .map((row) => {
          const image = row.querySelector(".cover-image");
          return {
            src: image?.getAttribute("src"),
            decoded: image?.shadowRoot?.querySelector("img")?.naturalWidth,
          };
        }),
    );
    assert.deepEqual(
      sources.map((s) => s.decoded),
      [128, 128, 128],
    );
    assert.equal(sources[1].src, covers[1]);
    assert.equal(sources[2].src, covers[2]);
    await page.screenshot({ path: "/tmp/miot-covers-" + width + "-list.png" });
    recover = true;
    await page.evaluate(() =>
      document
        .getElementById("plugin-view")
        .sendGlobalEvent("SongloftPluginBridge.push", [
          { event: "lifecycle", data: '{"state":"resumed"}' },
        ]),
    );
    await page.waitForFunction(() => {
      const image = document
        .getElementById("plugin-view")
        .shadowRoot.querySelectorAll(".song-row")[4]
        ?.querySelector(".cover-image")
        ?.shadowRoot?.querySelector("img");
      return image?.naturalWidth === 128;
    });
    const point = await page.evaluate(() => {
      const r = document
        .getElementById("plugin-view")
        .shadowRoot.querySelector(".player-copy")
        .getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    if (width < 600) await page.touchscreen.tap(point.x, point.y);
    else await page.mouse.click(point.x, point.y);
    await decoded(".large-cover .cover-image");
    const geometry = await page.evaluate(() => {
      const root = document.getElementById("plugin-view").shadowRoot,
        frame = root.querySelector(".large-cover"),
        image = frame.querySelector(".cover-image"),
        a = frame.getBoundingClientRect(),
        b = image.getBoundingClientRect();
      return {
        frame: { x: a.x, y: a.y, w: a.width, h: a.height },
        image: { x: b.x, y: b.y, w: b.width, h: b.height },
        shadow: getComputedStyle(image).boxShadow,
      };
    });
    for (const k of ["x", "y", "w", "h"])
      assert.ok(
        Math.abs(geometry.frame[k] - geometry.image[k]) <= 1,
        JSON.stringify(geometry),
      );
    assert.equal(geometry.shadow, "none");
    assert.ok(requests.some((r) => r.id === 1 && r.width === "640" && r.auth));
    assert.deepEqual(errors, []);
    await page.screenshot({ path: "/tmp/miot-covers-" + width + "-full.png" });
    console.log(
      JSON.stringify({
        passed: true,
        width,
        local: true,
        inline: true,
        signed: true,
        noCover: true,
        bounded404: true,
        resumeRecovery: true,
        listAndMiniAndFull: true,
        geometry,
        requests,
      }),
    );
  } catch (error) {
    await page.screenshot({ path: "/tmp/miot-covers-failure.png" });
    throw error;
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
