// Real Lynx Web rendering with deterministic HTTP device fixtures; no physical audio.
const assert = require("node:assert/strict");
const puppeteer = require(process.env.BROWSER_PUPPETEER || "puppeteer");
const base = process.env.MIOT_TEST_BASE_URL || "http://127.0.0.1:30617";
const width = Number(process.env.MIOT_TEST_WIDTH || 390);
const height = Number(process.env.MIOT_TEST_HEIGHT || 740);
(async () => {
  const auth = await (
    await fetch(base + "/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "admin" }),
    })
  ).json();
  const songs = Array.from({ length: 1000 }, (_, i) => ({
    id: i + 1,
    title: `Song ${i + 1} 很长的歌曲标题用来验证换行与边界`,
    artist: "Fixture artist",
    album: "Fixture album",
    duration: 240,
  }));
  const playlists = Array.from({ length: 1000 }, (_, i) => ({
    id: i + 1,
    name: `Playlist ${i + 1}`,
    song_count: 1000,
  }));
  const status = {
    current_song: songs[0],
    playlist_id: 1,
    is_playing: true,
    position: 20,
    duration: 240,
    volume: 40,
    play_mode: "order",
    speed: 1,
  };
  const commands = [];
  let favorite = false;
  let progressAvailable = true;
  let releaseSecond,
    holdSecond = true;
  const requestedPages = [];
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage(),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setViewport({ width, height, hasTouch: width < 600 });
  // Keep real empty-device socket snapshots from overwriting the HTTP fixture.
  await page.evaluateOnNewDocument(() => {
    window.WebSocket = class {
      constructor() {
        throw new Error("fixture: socket transport unavailable");
      }
    };
  });
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    const url = new URL(request.url()),
      prefix = "/api/v1/jsplugin/miot/api";
    let data;
    if (url.pathname.startsWith(prefix)) {
      const path = url.pathname.slice(prefix.length),
        method = request.method();
      if (path === "/auth/status")
        data = [{ id: "fixture", account: "fixture" }];
      if (path === "/mina/devices")
        data = [
          {
            account_id: "fixture",
            devices: [
              { device_id: "speaker", name: "Fixture speaker", managed: true },
            ],
          },
        ];
      if (path === "/playlists") data = playlists;
      if (/^\/playlists\/\d+\/songs$/.test(path)) {
        const offset = Number(url.searchParams.get("offset") || 0),
          limit = Number(url.searchParams.get("limit") || 100),
          keyword = url.searchParams.get("keyword") || "";
        const rows = songs.filter((song) => song.title.includes(keyword));
        data = {
          songs: rows.slice(offset, offset + limit),
          total: rows.length,
          next_offset: Math.min(offset + limit, rows.length),
          has_more: offset + limit < rows.length,
        };
        requestedPages.push({ offset, limit, keyword });
      }
      if (/^\/playlists\/\d+\/progress$/.test(path))
        data = progressAvailable ? { song_id: 1, position: 60 } : null;
      if (path === "/player/status") data = status;
      if (path === "/lyric")
        data = { lyric: "[00:00.00]Fixture lyric\n[00:30.00]Second line" };
      if (path === "/player/favorite/status") data = { is_favorited: favorite };
      if (path === "/voice-commands/sleep-timer")
        data = { active: false, mode: "time", remaining: 0, total: 0 };
      if (
        method === "POST" &&
        (path.startsWith("/player/") ||
          path === "/mina/volume" ||
          path === "/voice-commands/sleep-timer")
      ) {
        const body = JSON.parse(request.postData() || "{}");
        commands.push({ path, body });
        data = {};
        if (path === "/player/mode") status.play_mode = body.play_mode;
        if (path === "/player/speed") status.speed = body.speed;
        if (path === "/player/seek") status.position = body.position;
        if (path === "/mina/volume") status.volume = body.volume;
        if (path === "/player/favorite/toggle") {
          favorite = body.action === "add";
          data = { is_favorited: favorite };
        }
      }
    }
    if (data !== undefined) {
      const reply = () =>
        request.respond({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ success: true, data }),
        });
      if (
        url.pathname.endsWith("/songs") &&
        url.searchParams.get("offset") === "100" &&
        holdSecond
      ) {
        releaseSecond = () => {
          holdSecond = false;
          void reply();
        };
        return;
      }
      void reply();
    } else void request.continue();
  });
  const root = () => document.getElementById("plugin-view").shadowRoot;
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
          ?.shadowRoot?.querySelectorAll(".song-row").length === 100,
    );
    assert.deepEqual(requestedPages, [{ offset: 0, limit: 100, keyword: "" }]);
    const initialHeight = await page.evaluate(
      () =>
        document
          .getElementById("plugin-view")
          .shadowRoot.querySelector(".songs-scroll").scrollHeight,
    );
    assert.ok(initialHeight >= 5600 && initialHeight < 7000);
    await page.evaluate(() => {
      const root = document.getElementById("plugin-view").shadowRoot;
      window.menuPaint = [];
      new MutationObserver(() => {
        const card = root.querySelector(".select-overlay .modal-card");
        if (card)
          window.menuPaint.push({
            anchored: card.classList.contains("select-popup"),
            x: card.getBoundingClientRect().x,
          });
      }).observe(root, { subtree: true, childList: true, attributes: true });
    });
    await click(".library-filters .sl-select");
    await page.waitForFunction(() =>
      document
        .getElementById("plugin-view")
        .shadowRoot.querySelector(".select-popup"),
    );
    const paints = await page.evaluate(() => window.menuPaint);
    assert.ok(paints.length > 0);
    assert.ok(
      paints.every((p) => p.anchored),
      "selector flashed a centered card: " + JSON.stringify(paints),
    );
    const backdrop = await page.evaluate(() => {
      const r = document
        .getElementById("plugin-view")
        .shadowRoot.querySelector(".miot-app")
        .getBoundingClientRect();
      return { x: r.x + 4, y: r.y + 4 };
    });
    await page.mouse.click(backdrop.x, backdrop.y);
    await page.waitForFunction(
      () =>
        !document
          .getElementById("plugin-view")
          .shadowRoot.querySelector(".select-overlay"),
    );
    const list = await page.evaluate(() => {
      const r = document
        .getElementById("plugin-view")
        .shadowRoot.querySelector(".songs-scroll")
        .getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + Math.min(r.height / 2, 100) };
    });
    await page.mouse.move(list.x, list.y);
    await page.mouse.wheel({ deltaY: 6300 });
    for (let i = 0; i < 60 && !releaseSecond; i++)
      await new Promise((r) => setTimeout(r, 100));
    assert.ok(releaseSecond, "scroll should request the next page");
    assert.equal(requestedPages.filter((p) => p.offset === 100).length, 1);
    assert.ok(
      await page.evaluate(() =>
        document
          .getElementById("plugin-view")
          .shadowRoot.querySelector(".songs-scroll"),
      ),
      "slow next page must retain the first page",
    );
    releaseSecond();
    await page.waitForFunction(
      (initial) =>
        document
          .getElementById("plugin-view")
          .shadowRoot.querySelector(".songs-scroll").scrollHeight >
        initial * 1.8,
      {},
      initialHeight,
    );
    const input = await page.evaluateHandle(() =>
      document
        .getElementById("plugin-view")
        .shadowRoot.querySelector(".search-bar x-input")
        .shadowRoot.querySelector("input"),
    );
    await input.asElement().type("Song 999");
    await page.waitForFunction(
      () =>
        document
          .getElementById("plugin-view")
          .shadowRoot.querySelectorAll(".song-row").length === 1 &&
        document
          .getElementById("plugin-view")
          .shadowRoot.querySelector(".song-title")
          .textContent.includes("Song 999"),
    );
    assert.ok(
      requestedPages.some((p) => p.keyword === "Song 999" && p.offset === 0),
    );
    assert.deepEqual(errors, []);
    console.log(
      JSON.stringify({
        passed: true,
        width,
        height,
        firstPage: 100,
        slowSecondPage: true,
        serverSearch: true,
        noPopupJump: true,
        requestedPages,
      }),
    );
  } catch (error) {
    await page.screenshot({ path: "/tmp/miot-paging-failure.png" });
    throw error;
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
