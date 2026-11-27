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
    is_playing: false,
    position: 20,
    duration: 240,
    volume: 40,
    play_mode: "random",
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
      if (path === "/config" && method === "GET")
        data = {
          server_host: "http://192.168.1.10:58091",
          server_host_status: "ok",
        };
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
  const click = async (selector, label) => {
    await page.waitForFunction(
      ({ selector, label }) =>
        [
          ...document
            .getElementById("plugin-view")
            .shadowRoot.querySelectorAll(selector),
        ].some(
          (e) =>
            e.getBoundingClientRect().height > 0 &&
            !e.classList.contains("disabled") &&
            (!label ||
              e.textContent.includes(label) ||
              e.getAttribute("accessibility-label") === label),
        ),
      {},
      { selector, label },
    );
    const rect = await page.evaluate(
      ({ selector, label }) => {
        const root = document.getElementById("plugin-view").shadowRoot;
        const el = [...root.querySelectorAll(selector)].find(
          (e) =>
            e.getBoundingClientRect().height > 0 &&
            !e.classList.contains("disabled") &&
            (!label ||
              e.textContent.includes(label) ||
              e.getAttribute("accessibility-label") === label),
        );
        if (!el) throw new Error("missing " + selector + " " + label);
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      },
      { selector, label },
    );
    if (width < 600) await page.touchscreen.tap(rect.x, rect.y);
    else await page.mouse.click(rect.x, rect.y);
    await new Promise((r) => setTimeout(r, 150));
  };
  const waitCommand = async (path, count = 1) => {
    await page.waitForFunction(() => true);
    const received = () => commands.filter((c) => c.path === path).length;
    for (let i = 0; i < 30 && received() < count; i++)
      await new Promise((r) => setTimeout(r, 100));
    assert.ok(received() >= count, path);
  };
  const assertOverlay = async (selector) => {
    await page.waitForFunction(
      (selector) =>
        !!document
          .getElementById("plugin-view")
          ?.shadowRoot?.querySelector(selector)
          ?.querySelector(".modal-card"),
      {},
      selector,
    );
    const geometry = await page.evaluate((selector) => {
      const root = document.getElementById("plugin-view").shadowRoot;
      const mask = root.querySelector(selector),
        card = mask.querySelector(".modal-card");
      const r = card.getBoundingClientRect();
      const hit = root.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return {
        atRoot: mask.parentElement.id === "miot-app",
        onTop: card === hit || card.contains(hit),
        x: r.x,
        y: r.y,
        right: r.right,
        bottom: r.bottom,
        height: r.height,
        isMenu: mask.matches(
          ".player-popup-more,.player-popup-mode,.player-popup-speed",
        ),
        menuRows: card.querySelectorAll(".popup-menu-item").length,
        glass: Boolean(card.querySelector(".popup-tint")),
        backdropFilter: card.querySelector(".popup-blur")
          ? getComputedStyle(card.querySelector(".popup-blur")).backdropFilter
          : "",
      };
    }, selector);
    assert.ok(
      geometry.atRoot,
      "overlay must escape scroll/player stacking contexts",
    );
    assert.ok(geometry.onTop, "overlay must receive hits above the player");
    if (geometry.isMenu) {
      assert.ok(geometry.menuRows > 0, "popup menu has actionable rows");
      assert.ok(geometry.glass, "popup menu has a glass material layer");
      assert.equal(geometry.backdropFilter, "blur(20px)");
      assert.ok(
        geometry.height <= geometry.menuRows * 44 + 19,
        JSON.stringify(geometry),
      );
    }
    assert.ok(
      geometry.x >= 0 &&
        geometry.y >= 0 &&
        geometry.right <= width + 1 &&
        geometry.bottom <= height + 1,
      JSON.stringify(geometry),
    );
  };
  try {
    await page.goto(
      base +
        "/api/v1/jsplugin/miot/static/index.html?access_token=" +
        auth.access_token,
    );
    await page.waitForFunction(() =>
      document
        .getElementById("plugin-view")
        ?.shadowRoot?.querySelector(".player-mini"),
    );
    await page.waitForFunction(() => {
      const root = document.getElementById("plugin-view")?.shadowRoot;
      const track = root?.querySelector(".mini-progress");
      const fill = track?.querySelector(".mini-progress-fill");
      if (!fill || root.querySelector(".player-mini .sl-slider")) return false;
      const ratio =
        fill.getBoundingClientRect().width /
        track.getBoundingClientRect().width;
      // 20 seconds into the 240-second fixture, rounded like the Lynx client.
      return Math.abs(ratio - 0.08) < 0.01;
    });
    await page.waitForFunction(() =>
      document
        .getElementById("plugin-view")
        .shadowRoot.querySelector(".library-heading .device-play-state"),
    );
    const header = await page.evaluate(() => {
      const root = document.getElementById("plugin-view").shadowRoot;
      const bounds = (selector) =>
        root.querySelector(selector).getBoundingClientRect().toJSON();
      return {
        row: bounds(".library-heading"),
        playlist: bounds(".library-tools"),
        device: bounds(".device-target"),
        status: bounds(".device-play-state-slot"),
        actions: [...root.querySelectorAll(".appbar-actions .sl-button")].map(
          (button) => button.getBoundingClientRect().toJSON(),
        ),
      };
    });
    const headerItems = [header.device, header.status, ...header.actions];
    for (const [i, item] of headerItems.entries()) {
      assert.ok(
        item.width > 0 &&
          item.height > 0 &&
          item.top >= header.row.top &&
          item.bottom <= header.row.bottom &&
          item.left >= header.row.left &&
          item.right <= header.row.right &&
          item.bottom <= header.playlist.top &&
          (!i || item.left >= headerItems[i - 1].right - 1),
        JSON.stringify(header),
      );
    }
    if (width >= 600) {
      const shortcuts = await page.evaluate(() => {
        const root = document.getElementById("plugin-view").shadowRoot;
        return [...root.querySelectorAll(".player-mini .sl-button")]
          .filter((button) => button.getBoundingClientRect().width > 0)
          .map((button) => button.getAttribute("accessibility-label"));
      });
      for (const label of [
        "定位当前播放",
        "收藏",
        "播放模式",
        "音量",
        "延迟停止",
        "歌词",
        "停止播放",
      ]) {
        assert.ok(
          shortcuts.includes(label),
          `desktop mini-player shortcut: ${label}`,
        );
      }
      await click(".player-mini .sl-button", "音量");
      await assertOverlay(".player-popup-volume");
      await page.mouse.click(4, 4);
      await page.waitForFunction(
        () =>
          !document
            .getElementById("plugin-view")
            .shadowRoot.querySelector(".player-popup-volume"),
      );
    }
    await page.waitForFunction(() =>
      document
        .getElementById("plugin-view")
        .shadowRoot.querySelector(".playlist-context"),
    );
    const toolbarGeometry = () =>
      page.evaluate(() => {
        const root = document.getElementById("plugin-view").shadowRoot;
        const select = root
            .querySelector(".library-filters .sl-select")
            .getBoundingClientRect(),
          resume = root
            .querySelector(".resume-playlist")
            ?.getBoundingClientRect();
        return {
          width: select.width,
          x: select.x,
          y: select.y,
          resumeY: resume?.y ?? null,
          resumeHeight: resume?.height ?? null,
        };
      });
    await page.waitForFunction(
      (width) =>
        document
          .getElementById("plugin-view")
          .shadowRoot.querySelector(".miot-app")
          .classList.contains("compact") ===
        width < 360,
      {},
      width,
    );
    await new Promise((resolve) => setTimeout(resolve, 250));
    const beforeToolbar = await toolbarGeometry();
    status.is_playing = false;
    await click(".song-play-target", "Song 1 ");
    await waitCommand("/player/play");
    const pointPlay = commands.find((c) => c.path === "/player/play");
    assert.equal(pointPlay.body.song_id, 1);
    assert.equal(Object.hasOwn(pointPlay.body, "play_mode"), false);
    await click(".resume-playlist");
    await waitCommand("/player/play", 2);
    const resumePlay = commands.filter((c) => c.path === "/player/play")[1];
    assert.equal(resumePlay.body.start_position, "resume");
    assert.equal(Object.hasOwn(resumePlay.body, "play_mode"), false);
    progressAvailable = false;
    assert.equal(
      await page.evaluate(() =>
        document
          .getElementById("plugin-view")
          .shadowRoot.querySelector(".library-heading .page-title"),
      ),
      null,
      "the host title and playlist picker identify the page",
    );
    assert.deepEqual(
      await page.evaluate(() =>
        [
          ...document
            .getElementById("plugin-view")
            .shadowRoot.querySelectorAll(".appbar-actions .sl-button"),
        ].map((button) => button.getAttribute("accessibility-label")),
      ),
      width < 600 ? ["定位当前播放", "设置"] : ["设置"],
    );
    await click('.library-heading .sl-button[accessibility-label="设置"]');
    await click(".category", "工具箱");
    await click(".sl-button", "刷新内容");
    await page.waitForFunction(() =>
      document
        .getElementById("plugin-view")
        .shadowRoot.querySelector(
          '.sl-button[accessibility-label="刷新内容"]:not(.disabled)',
        ),
    );
    await click('.page-toolbar .sl-button[accessibility-label="返回"]');
    if (width < 600)
      await click('.page-toolbar .sl-button[accessibility-label="返回"]');
    await page.waitForFunction(
      () =>
        document
          .getElementById("plugin-view")
          .shadowRoot.querySelector(".playlist-context") === null,
    );
    const afterToolbar = await toolbarGeometry();
    assert.equal(
      afterToolbar.resumeHeight,
      null,
      "hide the resume row without progress",
    );
    for (const key of ["width", "x", "y"])
      assert.ok(
        Math.abs(afterToolbar[key] - beforeToolbar[key]) <= 1,
        "toolbar changed: " + JSON.stringify({ beforeToolbar, afterToolbar }),
      );
    status.is_playing = true;
    progressAvailable = true;
    await page.waitForFunction(
      () =>
        !document
          .getElementById("plugin-view")
          .shadowRoot.querySelector(".settings-shell"),
    );
    await click(".library-filters .sl-select");
    await page.waitForFunction(() =>
      document
        .getElementById("plugin-view")
        .shadowRoot.querySelector(".modal-card x-input")
        ?.shadowRoot?.querySelector("input"),
    );
    await assertOverlay(".modal-mask");
    assert.equal(
      await page.evaluate(() =>
        document
          .getElementById("plugin-view")
          .shadowRoot.querySelector(".select-popup .section-title"),
      ),
      null,
      "anchored selector must unmount its hidden heading",
    );
    assert.ok(
      await page.evaluate(
        () =>
          document
            .getElementById("plugin-view")
            .shadowRoot.querySelectorAll(".select-option").length <= 40,
      ),
    );
    const search = await page.evaluateHandle(() =>
      document
        .getElementById("plugin-view")
        .shadowRoot.querySelector(".modal-card x-input")
        .shadowRoot.querySelector("input"),
    );
    const searchGeometry = await search.asElement().evaluate((input) => {
      const box = input.getBoundingClientRect();
      const root = document.getElementById("plugin-view").shadowRoot;
      const row = root.querySelector(".select-search").getBoundingClientRect();
      const popup = root.querySelector(".select-popup").getBoundingClientRect();
      return {
        x: box.x,
        y: box.y,
        w: box.width,
        h: box.height,
        row: { x: row.x, y: row.y, w: row.width, h: row.height },
        popup: { x: popup.x, y: popup.y, w: popup.width, h: popup.height },
      };
    });
    assert.ok(
      searchGeometry.w > 120 && searchGeometry.h >= 36,
      "usable playlist search: " + JSON.stringify(searchGeometry),
    );
    assert.ok(
      searchGeometry.x >= searchGeometry.popup.x &&
        searchGeometry.x + searchGeometry.w <=
          searchGeometry.popup.x + searchGeometry.popup.w + 1,
      "playlist search fits popup",
    );
    await page.screenshot({ path: `/tmp/miot-playlist-search-${width}.png` });
    await search.asElement().type("Playlist 1000");
    await page.waitForFunction(
      () =>
        document
          .getElementById("plugin-view")
          .shadowRoot.querySelectorAll(".select-option").length === 1,
    );
    await click(".select-option", "Playlist 1000");
    await page.waitForFunction(
      () =>
        !document
          .getElementById("plugin-view")
          .shadowRoot.querySelector(".modal-mask"),
    );
    await page.waitForFunction(
      () =>
        document
          .getElementById("plugin-view")
          .shadowRoot.querySelectorAll(".song-row").length === 1000 &&
        document
          .getElementById("plugin-view")
          .shadowRoot.querySelector(".song-row .song-title")
          ?.textContent.includes("playlist 1000"),
    );
    assert.ok(
      await page.evaluate(
        () =>
          document
            .getElementById("plugin-view")
            .shadowRoot.querySelector(".songs-scroll").scrollHeight >= 55000,
      ),
    );
    const listPoint = await page.evaluate(() => {
      const r = document
        .getElementById("plugin-view")
        .shadowRoot.querySelector(".songs-scroll")
        .getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + Math.min(100, r.height / 3) };
    });
    await page.mouse.move(listPoint.x, listPoint.y);
    await page.mouse.wheel({ deltaY: 4000 });
    await page.waitForFunction(
      () =>
        document
          .getElementById("plugin-view")
          .shadowRoot.querySelector(".songs-scroll").scrollTop > 1000,
    );
    await page.waitForFunction(
      ({ x, y }) => {
        const root = document.getElementById("plugin-view").shadowRoot;
        const row = root.elementFromPoint(x, y)?.closest(".song-row");
        const title = row?.querySelector(".song-title")?.textContent;
        return Number(title?.match(/^Song (\d+)/)?.[1]) > 20;
      },
      {},
      listPoint,
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
          .shadowRoot.querySelectorAll(".song-row").length === 1,
    );
    await click(".player-mini .player-copy");
    await page.waitForFunction(() =>
      document
        .getElementById("plugin-view")
        .shadowRoot.querySelector(".player-full"),
    );
    await click(".player-full .sl-button", "播放模式");
    await assertOverlay(".player-popup");
    await click(".modal-card .sl-button", "随机播放");
    await waitCommand("/player/mode");
    await page.waitForFunction(
      () =>
        !document
          .getElementById("plugin-view")
          .shadowRoot.querySelector(".modal-mask"),
    );
    assert.equal(
      commands.find((c) => c.path === "/player/mode").body.play_mode,
      "random",
    );
    await click(".player-tools .sl-button", "更多");
    await click(".modal-card .sl-button", "倍速");
    await click(".modal-card .sl-button", "1.5×");
    await waitCommand("/player/speed");
    await page.waitForFunction(
      () =>
        !document
          .getElementById("plugin-view")
          .shadowRoot.querySelector(".modal-mask"),
    );
    await click(".player-full .sl-button", "收藏");
    await waitCommand("/player/favorite/toggle");
    assert.equal(favorite, true);
    await page.waitForFunction(() =>
      document
        .getElementById("plugin-view")
        .shadowRoot.querySelector('.player-full .sl-icon[content*="#f44336"]'),
    );
    const heart = await page.evaluate(async () => {
      const button = document
        .getElementById("plugin-view")
        .shadowRoot.querySelector(
          '.player-full .sl-icon[content*="#f44336"]',
        ).parentElement;
      const svg = button.querySelector(".sl-icon").getAttribute("content");
      const bitmap = new Image();
      bitmap.src = "data:image/svg+xml;base64," + btoa(svg);
      await bitmap.decode();
      const canvas = document.createElement("canvas");
      canvas.width = 96;
      canvas.height = 96;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(bitmap, 0, 0, 96, 96);
      return [...ctx.getImageData(48, 48, 1, 1).data];
    });
    assert.ok(
      heart[0] > 180 && heart[1] < 110 && heart[2] < 110 && heart[3] > 240,
      "favorite center must be solid red: " + JSON.stringify(heart),
    );

    await page.screenshot({ path: "/tmp/miot-favorite-" + width + ".png" });
    await click(".player-full .sl-button", "取消收藏");
    for (let i = 0; i < 30 && favorite; i++)
      await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(favorite, false);
    await page.waitForFunction(
      () =>
        !document
          .getElementById("plugin-view")
          .shadowRoot.querySelector(
            '.player-full .sl-icon[content*="#f44336"]',
          ),
    );
    if (width < 600) await click(".player-mobile-tabs .page-dot", "显示歌词");
    await page.waitForFunction(
      () =>
        document
          .getElementById("plugin-view")
          .shadowRoot.querySelectorAll(".lyric-line").length === 2,
    );
    await click(".lyric-line", "Second line");
    await waitCommand("/player/seek");
    assert.equal(
      commands.find((c) => c.path === "/player/seek").body.position,
      30,
    );
    await click(".player-tools .sl-button", "更多");
    await click(".modal-card .sl-button", "音量");
    await page.waitForFunction(() =>
      document
        .getElementById("plugin-view")
        .shadowRoot.querySelector(".volume-vertical"),
    );
    const vertical = await page.evaluate(() => {
      const r = document
        .getElementById("plugin-view")
        .shadowRoot.querySelector(".volume-vertical")
        .getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
    assert.ok(
      vertical.height > vertical.width * 2,
      "volume is a vertical slider",
    );
    await click(".modal-card .sl-button", "+");
    await waitCommand("/mina/volume");
    assert.equal(
      commands.find((c) => c.path === "/mina/volume").body.volume,
      45,
    );
    const volumeCommands = () =>
      commands.filter((c) => c.path === "/mina/volume");
    const beforeDrag = volumeCommands().length;
    await page.mouse.move(
      vertical.x + vertical.width / 2,
      vertical.y + vertical.height * 0.55,
    );
    await page.mouse.down();
    await page.mouse.move(
      vertical.x + vertical.width / 2,
      vertical.y + vertical.height * 0.2,
      { steps: 8 },
    );
    assert.equal(volumeCommands().length, beforeDrag, "dragging only previews");
    await page.mouse.up();
    for (
      let attempt = 0;
      attempt < 30 && volumeCommands().length === beforeDrag;
      attempt++
    )
      await new Promise((r) => setTimeout(r, 100));
    assert.equal(
      volumeCommands().length,
      beforeDrag + 1,
      "release commits exactly once",
    );
    assert.ok(
      Math.abs(volumeCommands().at(-1).body.volume - 80) <= 1,
      "pointer position matches volume",
    );
    await page.mouse.click(4, 4);
    await page.waitForFunction(
      () =>
        !document
          .getElementById("plugin-view")
          .shadowRoot.querySelector(".modal-mask"),
    );
    await click(".player-tools .sl-button", "更多");
    await click(".modal-card .sl-button", "延迟停止");
    await assertOverlay(".player-popup");
    await click(".sleep-timer-options .native-button", "15 分钟");
    await waitCommand("/voice-commands/sleep-timer");
    await click(".player-tools .sl-button", "更多");
    await click(".modal-card .sl-button", "从当前歌单移除");
    await assertOverlay(".confirm-overlay");
    await click(".confirm-overlay .sl-button", "关闭");
    await page.waitForFunction(
      () =>
        !document
          .getElementById("plugin-view")
          .shadowRoot.querySelector(".confirm-overlay"),
    );
    await assertOverlay(".player-popup");
    assert.ok(
      !commands.some((command) => command.path === "/player/song/remove"),
      "cancelled confirmation must not delete",
    );
    await page.mouse.click(4, 4);
    assert.deepEqual(errors, []);
    await page.waitForFunction(() =>
      document
        .getElementById("plugin-view")
        .shadowRoot.querySelector(".player-full .song-title")
        ?.textContent.includes("Song 1 "),
    );
    await page.screenshot({ path: "/tmp/miot-player-fixture.png" });
    console.log(
      JSON.stringify({
        passed: true,
        fixture: true,
        songs: 1000,
        playlists: 1000,
        loadedSongRows: 1000,
        width,
        height,
        commands,
      }),
    );
  } catch (error) {
    await page.screenshot({ path: "/tmp/miot-player-failure.png" });
    throw error;
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
