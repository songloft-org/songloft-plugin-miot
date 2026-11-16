// Real Lynx Web rendering with deterministic HTTP device fixtures; no physical audio.
const assert = require("node:assert/strict");
const puppeteer = require(process.env.BROWSER_PUPPETEER || "puppeteer");
const base = process.env.MIOT_TEST_BASE_URL || "http://127.0.0.1:30617";
const width = Number(process.env.MIOT_TEST_WIDTH || 390);
const deviceCount = Number(process.env.MIOT_DEVICE_COUNT || 1);
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
        data = deviceCount
          ? [
              {
                account_id: "fixture",
                account_name: "测试账号",
                devices: Array.from({ length: deviceCount }, (_, i) => ({
                  device_id: i ? "speaker-" + i : "speaker",
                  name: "测试播放设备 " + (i + 1),
                  managed: true,
                })),
              },
            ]
          : [];
      if (path === "/playlists") data = playlists;
      if (/^\/playlists\/\d+\/songs$/.test(path))
        data = songs.map((song) => ({
          ...song,
          title: song.title + " · playlist " + path.split("/")[2],
        }));
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
    if (data !== undefined)
      void request.respond({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, data }),
      });
    else void request.continue();
  });
  try {
    await page.goto(
      base +
        "/api/v1/jsplugin/miot/static/index.html?access_token=" +
        auth.access_token,
    );
    await page.waitForFunction(() =>
      document
        .getElementById("plugin-view")
        ?.shadowRoot?.querySelector(
          '.library-heading .sl-button[accessibility-label="设置"]:not(.disabled)',
        ),
    );
    await new Promise((r) => setTimeout(r, 400));
    const p = await page.evaluate(() => {
      const r = document
        .getElementById("plugin-view")
        .shadowRoot.querySelector(
          '.library-heading .sl-button[accessibility-label="选择设备"]',
        )
        .getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    if (width < 600) await page.touchscreen.tap(p.x, p.y);
    else await page.mouse.click(p.x, p.y);
    await page.waitForFunction(() =>
      document
        .getElementById("plugin-view")
        .shadowRoot.querySelector(".modal-card"),
    );
    const geometry = await page.evaluate(() => {
      const root = document.getElementById("plugin-view").shadowRoot,
        card = root.querySelector(".modal-card"),
        list = card.querySelector(".device-picker-options,.select-options"),
        r = card.getBoundingClientRect();
      return {
        x: r.x,
        y: r.y,
        w: r.width,
        h: r.height,
        bottom: r.bottom,
        listHeight: list.getBoundingClientRect().height,
        scrollHeight: list.scrollHeight,
        choices: card.querySelectorAll(".device-picker-choice").length,
      };
    });
    assert.ok(
      geometry.y >= 0 && geometry.bottom <= height + 1,
      JSON.stringify(geometry),
    );
    if (deviceCount <= 1)
      assert.ok(
        geometry.h < 280,
        "few devices should not reserve a 300px list: " +
          JSON.stringify(geometry),
      );
    else
      assert.ok(
        geometry.scrollHeight > geometry.listHeight + 100,
        "many devices should scroll",
      );
    await page.screenshot({
      path: "/tmp/miot-device-picker-" + width + "-" + deviceCount + ".png",
    });
    console.log(
      JSON.stringify({ passed: true, width, height, deviceCount, geometry }),
    );
  } catch (error) {
    await page.screenshot({ path: "/tmp/miot-picker-failure.png" });
    throw error;
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
