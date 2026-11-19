// Repeated current-song location with real Lynx rendering and paged HTTP fixtures.
const assert = require("node:assert/strict");
const puppeteer = require(process.env.BROWSER_PUPPETEER || "puppeteer");
const base = process.env.MIOT_TEST_BASE_URL || "http://127.0.0.1:30618";
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
    current_song: songs[899],
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
        Number(url.searchParams.get("offset")) > 0
      )
        setTimeout(reply, 100);
      else void reply();
    } else void request.continue();
  });
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
    const snapshot = () =>
      page.evaluate(() => {
        const root = document.getElementById("plugin-view").shadowRoot,
          list = root.querySelector(".songs-scroll"),
          row = root.querySelector(".song-row.selected");
        const l = list.getBoundingClientRect(),
          r = row?.getBoundingClientRect();
        return {
          top: list.scrollTop,
          scrollHeight: list.scrollHeight,
          rowText: row?.textContent,
          first: root.querySelector(".song-row .song-title")?.textContent,
          selectedVisible: !!r && r.bottom > l.top && r.top < l.bottom,
          rowTop: r?.top,
          listTop: l.top,
        };
      });
    const result = { initial: await snapshot() };
    let start = Date.now();
    await click(".current-song-locate");
    await page.waitForFunction(() => {
      const root = document.getElementById("plugin-view").shadowRoot,
        list = root.querySelector(".songs-scroll"),
        row = root.querySelector(".song-row.selected");
      if (!row) return false;
      const a = list.getBoundingClientRect(),
        b = row.getBoundingClientRect();
      return b.bottom > a.top && b.top < a.bottom;
    });
    result.first = {
      elapsedMs: Date.now() - start,
      state: await snapshot(),
      requests: [...requestedPages],
    };
    const point = await page.evaluate(() => {
      const r = document
        .getElementById("plugin-view")
        .shadowRoot.querySelector(".songs-scroll")
        .getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    await page.mouse.move(point.x, point.y);
    await page.mouse.wheel({ deltaY: -100000 });
    await page.waitForFunction(
      () =>
        document
          .getElementById("plugin-view")
          .shadowRoot.querySelector(".songs-scroll").scrollTop < 10,
    );
    result.manualTop = await snapshot();
    start = Date.now();
    await click(".current-song-locate");
    await page.waitForFunction(
      () => {
        const root = document.getElementById("plugin-view").shadowRoot,
          list = root.querySelector(".songs-scroll"),
          row = root.querySelector(".song-row.selected");
        if (!row) return false;
        const a = list.getBoundingClientRect(),
          b = row.getBoundingClientRect();
        return b.bottom > a.top && b.top < a.bottom;
      },
      { timeout: 3000 },
    );
    result.second = {
      elapsedMs: Date.now() - start,
      state: await snapshot(),
      requests: [...requestedPages],
    };
    assert.equal(
      result.second.state.selectedVisible,
      true,
      "a repeated locate must scroll to the prepared virtual rows",
    );
    const loadedLocateMs = [result.second.elapsedMs],
      requestCount = requestedPages.length;
    for (let cycle = 0; cycle < 10; cycle++) {
      await page.mouse.move(point.x, point.y);
      await page.mouse.wheel({ deltaY: -100000 });
      await page.waitForFunction(() => {
        const root = document.getElementById("plugin-view").shadowRoot;
        return (
          root.querySelector(".songs-scroll").scrollTop < 10 &&
          root
            .querySelector(".song-row .song-title")
            ?.textContent.startsWith("Song 1 ")
        );
      });
      const t = Date.now();
      await click(".current-song-locate");
      await page.waitForFunction(
        () => {
          const root = document.getElementById("plugin-view").shadowRoot,
            list = root.querySelector(".songs-scroll"),
            row = root.querySelector(".song-row.selected");
          if (!row) return false;
          const a = list.getBoundingClientRect(),
            b = row.getBoundingClientRect();
          return b.bottom > a.top && b.top < a.bottom;
        },
        { timeout: 3000 },
      );
      loadedLocateMs.push(Date.now() - t);
    }
    assert.equal(
      requestedPages.length,
      requestCount,
      "loaded locate must not request another song page",
    );
    result.loadedLocateMs = loadedLocateMs;
    result.width = width;
    result.requestOffsets = requestedPages.map((p) => p.offset);
    result.first.requests = result.first.requests.map((p) => p.offset);
    result.second.requests = result.second.requests.map((p) => p.offset);
    await page.screenshot({
      path: "/tmp/miot-locate-" + width + "-result.png",
    });
    assert.deepEqual(errors, []);
    result.errors = errors;
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    await page.screenshot({ path: `/tmp/miot-locate-${width}-failure.png` });
    throw error;
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
