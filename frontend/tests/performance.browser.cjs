// Run against an isolated server containing the production plugin package.
const assert = require("node:assert/strict");
const puppeteer = require(process.env.BROWSER_PUPPETEER || "puppeteer");
const base = process.env.MIOT_TEST_BASE_URL || "http://127.0.0.1:30723";
const baseline = process.env.MIOT_PERF_BASELINE === "1";
const width = Number(process.env.MIOT_TEST_WIDTH || 390);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  const login = await fetch(base + "/api/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "admin" }),
  });
  assert.equal(login.status, 200);
  const { access_token } = await login.json();
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewport({ width, height: 800 });
    await page.setCacheEnabled(false);
    await page.evaluateOnNewDocument(() => {
      window.WebSocket = class {
        constructor() {
          throw new Error("Status is supplied by an HTTP fixture");
        }
      };
    });
    await page.setRequestInterception(true);
    const songs = Array.from({ length: 1000 }, (_, index) => ({
      id: index + 1,
      title: `歌曲 ${index + 1}`,
      artist: "测试音乐人",
      duration: 240,
    }));
    const counts = {};
    let statusPosition = 20;
    let submissions = 0;
    let releaseCommand;
    let releaseStatus;
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname.split(
        "/jsplugin/miot/api",
      )[1];
      if (!path) return void request.continue();
      counts[path] = (counts[path] || 0) + 1;
      const fixtures = {
        "/config": {
          server_host: "http://192.168.1.10:58091",
          server_host_status: "ok",
        },
        "/auth/status": [{ id: "fixture" }],
        "/mina/devices": [
          {
            account_id: "fixture",
            devices: [
              { device_id: "speaker", name: "Fixture speaker", managed: true },
            ],
          },
        ],
        "/playlists": [{ id: 1, name: "测试歌单" }],
        "/playlists/1/songs": songs,
        "/playlists/1/progress": null,
        "/player/status": {
          position: statusPosition++,
          duration: 240,
          current_song: songs[0],
          playlist_id: 1,
          is_playing: true,
        },
        "/player/favorite/status": { is_favorited: false },
        "/lyric": { lyric: "[00:00]测试歌词" },
        "/voice-commands/sleep-timer": {
          active: false,
          mode: "time",
          remaining: 0,
          total: 0,
        },
        "/chat/status": {},
      };
      const respond = (data) =>
        request
          .respond({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ success: true, data }),
          })
          .catch(() => {});
      if (path === "/config")
        return void wait(1200).then(() => respond(fixtures[path]));
      if (path === "/mina/devices")
        return void wait(600).then(() => respond(fixtures[path]));
      if (path === "/player/play") {
        submissions++;
        releaseCommand = () => respond({});
        return;
      }
      if (path === "/player/status" && submissions && !releaseStatus) {
        releaseStatus = () => respond(fixtures[path]);
        return;
      }
      if (Object.hasOwn(fixtures, path)) return void respond(fixtures[path]);
      void request.continue();
    });

    const visible = (selector) =>
      page.waitForFunction(
        (selector) => {
          const root = document.getElementById("plugin-view")?.shadowRoot;
          return [...(root?.querySelectorAll(selector) ?? [])].some((node) => {
            return (
              node.getBoundingClientRect().height > 0 &&
              !node.classList.contains("disabled")
            );
          });
        },
        {},
        selector,
      );
    const elapsed = () => page.evaluate(() => Math.round(performance.now()));
    const click = async (selector) => {
      await visible(selector);
      const point = await page.evaluate((selector) => {
        const root = document.getElementById("plugin-view").shadowRoot;
        const node = [...root.querySelectorAll(selector)].find((item) => {
          const rect = item.getBoundingClientRect();
          if (!rect.height || item.classList.contains("disabled")) return false;
          const hit = root.elementFromPoint(
            rect.x + rect.width / 2,
            rect.y + rect.height / 2,
          );
          return hit && (item === hit || item.contains(hit));
        });
        function nodeContains(item, hit) {
          return item === hit || item.contains(hit);
        }
        if (!node) return null;
        const rect = node.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      }, selector);
      assert.ok(point, selector);
      await page.mouse.click(point.x, point.y);
    };
    await page.goto(
      base +
        "/api/v1/jsplugin/miot/static/index.html?access_token=" +
        access_token,
      { waitUntil: "domcontentloaded" },
    );
    await visible(".library-heading");
    const shellMs = await elapsed();
    await visible(".library-filters .sl-select:not(.disabled)");
    const selectorMs = await elapsed();
    if (!baseline) {
      assert.equal(
        await page.evaluate(() =>
          document
            .getElementById("plugin-view")
            .shadowRoot.querySelector('[accessibility-label="设置"]')
            .classList.contains("disabled"),
        ),
        true,
      );
    }
    await visible(".song-play-target");
    const firstSongMs = await elapsed();
    await visible(
      '.library-heading [accessibility-label="设置"]:not(.disabled)',
    );
    await visible(".player-mini");
    const firstPlayableMs = await elapsed();
    const rows = await page.evaluate(
      () =>
        document
          .getElementById("plugin-view")
          .shadowRoot.querySelectorAll(".song-row").length,
    );
    assert.equal(rows, 30);
    if (!baseline)
      for (const path of [
        "/lyric",
        "/chat/status",
        "/voice-commands/sleep-timer",
      ])
        assert.equal(counts[path] || 0, 0, path);
    const clickMs = await elapsed();
    await click(".song-play-target");
    const commandDeadline = Date.now() + 3000;
    while (!releaseCommand && Date.now() < commandDeadline) await wait(20);
    assert.equal(submissions, 1);
    let feedbackMs = null;
    if (!baseline) {
      await visible(".device-play-state-slot");
      await page.waitForFunction(() =>
        document
          .getElementById("plugin-view")
          .shadowRoot.querySelector(".device-play-state-slot")
          .textContent.includes("正在发送指令"),
      );
      feedbackMs = (await elapsed()) - clickMs;
    }
    await releaseCommand();
    const statusDeadline = Date.now() + 3000;
    while (!releaseStatus && Date.now() < statusDeadline) await wait(20);
    assert.ok(releaseStatus, "accepted command must request a status refresh");
    if (!baseline)
      await visible(
        '.player-controls [accessibility-label="下一首"]:not(.disabled)',
      );
    const scrolling = page.evaluate(async () => {
      const root = document.getElementById("plugin-view").shadowRoot;
      const list = root.querySelector(".songs-scroll");
      let last = 0;
      const samples = [];
      window.miotPerformanceScrolling = true;
      for (let index = 0; index <= 120; index++) {
        const now = await new Promise(requestAnimationFrame);
        if (index) samples.push(now - last);
        last = now;
        list.scrollTop = index * 75;
      }
      samples.sort((a, b) => a - b);
      return {
        p95Ms: samples[Math.floor((samples.length - 1) * 0.95)],
        maxMs: samples.at(-1),
      };
    });

    await page.waitForFunction(() => window.miotPerformanceScrolling);
    await releaseStatus();
    const frameTimes = await scrolling;
    if (!baseline) {
      await click(".mini-stage");
      if (width < 600) await click('[accessibility-label="显示歌词"]');
      await visible(".lyric-line");
      assert.equal(counts["/lyric"], 1);
      await click(
        '[accessibility-label="延迟停止"], [accessibility-label="更多"]',
      );
      if (width < 600 && !counts["/voice-commands/sleep-timer"])
        await click('.sl-button[accessibility-label="延迟停止"]');
      await visible(".sleep-popup-header");
      assert.equal(counts["/voice-commands/sleep-timer"], 1);
    }
    assert.deepEqual(errors, []);
    console.log(
      JSON.stringify({
        width,
        shellMs,
        selectorMs,
        firstSongMs,
        firstPlayableMs,
        frameTimes,
        feedbackMs,
        counts,
      }),
    );
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
