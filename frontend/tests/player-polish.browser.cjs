// Real Lynx Web UI, isolated HTTP fixtures; never touches a user's songs/devices.
const assert = require("node:assert/strict");
const puppeteer = require(process.env.BROWSER_PUPPETEER || "puppeteer");
const base = process.env.MIOT_TEST_BASE_URL || "http://127.0.0.1:30617";
const width = Number(process.env.MIOT_TEST_WIDTH || 390);
const height = Number(process.env.MIOT_TEST_HEIGHT || 740);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
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
  const page = await browser.newPage(),
    errors = [],
    commands = [];
  const songs = Array.from({ length: 150 }, (_, i) => ({
    id: i + 1,
    title: `Fixture ${i + 1}`,
    artist: "Test",
    duration: 400,
  }));
  const status = {
    current_song: songs[0],
    playlist_id: 1,
    is_playing: true,
    position: 100,
    duration: 400,
    volume: 40,
    play_mode: "order",
    speed: 1,
  };
  let timer = { active: false, mode: "time", remaining: 0, total: 0 },
    failMore = true,
    moreRequests = 0,
    releaseInitial;
  let holdTimerRead = false;
  let releaseTimerRead;
  let failTimerRead = false;
  await page.setViewport({ width, height, hasTouch: width < 600 });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.evaluateOnNewDocument(() => {
    window.WebSocket = class {
      constructor() {
        throw Error("fixture socket disabled");
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
              { device_id: "speaker", name: "Test speaker", managed: true },
            ],
          },
        ];
      if (path === "/mina/last-selection") data = {};
      if (path === "/playlists")
        data = [{ id: 1, name: "Fixture playlist", song_count: 150 }];
      if (path === "/playlists/1/progress") data = null;
      if (path === "/player/status") data = status;
      if (path === "/player/favorite/status") data = { is_favorited: false };
      if (path === "/lyric")
        data = {
          lyric: Array.from(
            { length: 80 },
            (_, i) =>
              `[${String(Math.floor((i * 5) / 60)).padStart(2, "0")}:${String((i * 5) % 60).padStart(2, "0")}.00]Lyric line ${i}`,
          ).join("\n"),
        };
      if (path === "/voice-commands/sleep-timer") {
        data = timer;
        if (method === "GET" && failTimerRead) {
          failTimerRead = false;
          void request.respond({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({ success: false, error: "fixture unavailable" }),
          });
          return;
        }
        if (method === "GET" && holdTimerRead) {
          releaseTimerRead = () =>
            request.respond({
              status: 200,
              contentType: "application/json",
              body: JSON.stringify({ success: true, data }),
            });
          return;
        }
      }
      if (path === "/playlists/1/songs") {
        const offset = Number(url.searchParams.get("offset") || 0),
          limit = Number(url.searchParams.get("limit") || 100);
        data = {
          songs: songs.slice(offset, offset + limit),
          total: 150,
          next_offset: Math.min(150, offset + limit),
          has_more: offset + limit < 150,
        };
        if (offset) {
          moreRequests++;
          if (failMore) {
            void request.respond({
              status: 503,
              contentType: "application/json",
              body: JSON.stringify({
                success: false,
                error: "fixture page unavailable",
              }),
            });
            return;
          }
        } else if (!releaseInitial) {
          releaseInitial = () =>
            request.respond({
              status: 200,
              contentType: "application/json",
              body: JSON.stringify({ success: true, data }),
            });
          return;
        }
      }
      if (
        method === "POST" &&
        (path.startsWith("/player/") ||
          path.startsWith("/voice-commands/sleep-timer"))
      ) {
        const body = JSON.parse(request.postData() || "{}");
        commands.push({ path, body });
        data = {};
        if (path === "/player/seek") status.position = body.position;
        if (path === "/voice-commands/sleep-timer") {
          timer = {
            active: true,
            mode: body.mode,
            remaining: body.value,
            total: body.value,
          };
          data = timer;
        }
        if (path.endsWith("/cancel")) {
          timer = { active: false, mode: "time", remaining: 0, total: 0 };
          data = timer;
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
  const inspect = (fn, ...args) => page.evaluate(fn, ...args);
  const wait = (fn, ...args) => page.waitForFunction(fn, {}, ...args);
  const click = async (selector, label) => {
    await wait(
      (selector, label) =>
        [
          ...document
            .getElementById("plugin-view")
            .shadowRoot.querySelectorAll(selector),
        ].some(
          (e) =>
            e.getBoundingClientRect().height > 0 &&
            (!label ||
              e.textContent.includes(label) ||
              e.getAttribute("accessibility-label") === label),
        ),
      selector,
      label,
    );
    const p = await inspect(
      (selector, label) => {
        const root = document.getElementById("plugin-view").shadowRoot;
        const el = [...root.querySelectorAll(selector)].find(
          (e) =>
            e.getBoundingClientRect().height > 0 &&
            (!label ||
              e.textContent.includes(label) ||
              e.getAttribute("accessibility-label") === label),
        );
        el.scrollIntoView({ block: "nearest" });
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      },
      selector,
      label,
    );
    await page.mouse.click(p.x, p.y);
    await pause(180);
  };
  const edit = async (selector, value) => {
    await wait(
      (selector) =>
        !!document
          .getElementById("plugin-view")
          .shadowRoot.querySelector(selector)
          ?.shadowRoot?.querySelector("input"),
      selector,
    );
    const h = await page.evaluateHandle(
      (selector) =>
        document
          .getElementById("plugin-view")
          .shadowRoot.querySelector(selector)
          .shadowRoot.querySelector("input"),
      selector,
    );
    await h
      .asElement()
      .evaluate((el) => el.scrollIntoView({ block: "center" }));
    await h.asElement().click();
    await page.keyboard.down("Control");
    await page.keyboard.press("a");
    await page.keyboard.up("Control");
    await page.keyboard.press("Backspace");
    await h.asElement().type(value);
    await page.keyboard.press("Tab");
    await pause(120);
  };
  const openSleep = async () => {
    await click(".player-tools .sl-button", "更多");
    await click(".modal-card .sl-button", "延迟停止");
    await wait(
      () =>
        !!document
          .getElementById("plugin-view")
          .shadowRoot.querySelector(".sleep-panel-content"),
    );
    await pause(300);
  };
  const sleepBounds = async (label) => {
    const g = await inspect(() => {
      const root = document.getElementById("plugin-view").shadowRoot,
        card = root.querySelector(".player-popup-sleep .modal-card"),
        s = root.querySelector(".sleep-popup-scroll"),
        c = root.querySelector(".sleep-panel-content"),
        r = card.getBoundingClientRect();
      return {
        x: r.x,
        y: r.y,
        w: r.width,
        h: r.height,
        bottom: r.bottom,
        scroll: s.clientHeight,
        content: c.getBoundingClientRect().height,
        scrollHeight: s.scrollHeight,
      };
    });
    assert.ok(
      g.x >= 15 &&
        g.y >= 15 &&
        g.x + g.w <= width - 15 &&
        g.bottom <= height - 15,
      `${label}: ${JSON.stringify(g)}`,
    );
    assert.ok(
      g.scroll > 0 && g.content > 50,
      `${label}: populated scroll area`,
    );
    assert.ok(
      g.h <= g.content + 82,
      `${label}: no oversized empty card ${JSON.stringify(g)}`,
    );
    return g;
  };
  try {
    await page.goto(
      base +
        "/api/v1/jsplugin/miot/static/index.html?access_token=" +
        auth.access_token,
    );
    await wait(
      () =>
        !!document
          .getElementById("plugin-view")
          ?.shadowRoot?.querySelector(".song-list-skeleton"),
    );
    assert.equal(
      await inspect(
        () =>
          document
            .getElementById("plugin-view")
            .shadowRoot.querySelectorAll(".song-skeleton-row").length,
      ),
      8,
    );
    for (let attempt = 0; !releaseInitial && attempt < 100; attempt++)
      await pause(50);
    assert.equal(typeof releaseInitial, "function");
    await releaseInitial();
    await wait(
      () =>
        !!document
          .getElementById("plugin-view")
          .shadowRoot.querySelector(".song-row"),
    );
    // Expanded hit boxes retain the compact icon appearance.
    if (width < 600)
      assert.ok(
        await inspect(() =>
          [
            ...document
              .getElementById("plugin-view")
              .shadowRoot.querySelectorAll(
                ".mini-inner .player-controls .sl-button",
              ),
          ].every((e) => e.getBoundingClientRect().height >= 44),
        ),
      );
    if (height >= 520) {
      // More menu closes without deleting; regular and permanent removal use distinct flags.
      for (const permanent of [false, true]) {
        await click(".song-row .sl-button", "歌曲操作");
        await click(
          ".song-action-sheet .sl-button",
          permanent ? "从曲库永久删除" : "从歌单移除",
        );
        await wait(
          () =>
            !!document
              .getElementById("plugin-view")
              .shadowRoot.querySelector(".confirm-overlay"),
        );
        if (!permanent) {
          await click(".confirm-overlay .sl-button", "关闭");
          assert.equal(
            commands.filter((c) => c.path === "/player/song/remove").length,
            0,
          );
          await click(".song-row .sl-button", "歌曲操作");
          await click(".song-action-sheet .sl-button", "从歌单移除");
        }
        await click(
          ".confirm-overlay .sl-button",
          permanent ? "永久删除" : "移除",
        );
        const last = commands
          .filter((c) => c.path === "/player/song/remove")
          .at(-1);
        assert.equal(last.body.from_library, permanent);
      }
      // A failed next page leaves existing rows and requires an explicit retry.
      await click(".songs-page-feedback .sl-button", "加载更多");
      await wait(
        () =>
          !!document
            .getElementById("plugin-view")
            .shadowRoot.querySelector(".songs-page-error"),
      );
      assert.ok(
        await inspect(
          () =>
            document
              .getElementById("plugin-view")
              .shadowRoot.querySelectorAll(".song-row").length > 0,
        ),
      );
      const requests = moreRequests;
      await pause(700);
      assert.equal(moreRequests, requests, "no automatic retry loop");
      failMore = false;
      await click(".songs-page-feedback .sl-button", "重试加载");
      await wait(
        () =>
          !document
            .getElementById("plugin-view")
            .shadowRoot.querySelector(".songs-page-error"),
      );
      assert.ok(moreRequests > requests);
    }
    await click(".player-mini .player-copy");
    if (height < 400) {
      await click(".player-tools .sl-button", "1×");
      await wait(() =>
        document
          .getElementById("plugin-view")
          .shadowRoot.querySelector(".player-popup-speed .popup-menu-scroll"),
      );
      const menu = await inspect(() => {
        const scroll = document
          .getElementById("plugin-view")
          .shadowRoot.querySelector(".player-popup-speed .popup-menu-scroll");
        const rect = scroll.getBoundingClientRect();
        return {
          x: rect.x + rect.width / 2,
          y: rect.y + rect.height / 2,
          height: rect.height,
          scrollHeight: scroll.scrollHeight,
        };
      });
      assert.ok(menu.scrollHeight > menu.height, "short speed menu scrolls");
      await page.mouse.move(menu.x, menu.y);
      await page.mouse.wheel({ deltaY: menu.scrollHeight });
      await wait(() => {
        const root = document.getElementById("plugin-view").shadowRoot;
        const scroll = root.querySelector(
          ".player-popup-speed .popup-menu-scroll",
        );
        const last = scroll?.querySelector('[accessibility-label="2×"]');
        return (
          last &&
          last.getBoundingClientRect().bottom <=
            scroll.getBoundingClientRect().bottom + 1
        );
      });
      await click(".player-popup-speed .popup-menu-item", "2×");
      await wait(
        () =>
          !document
            .getElementById("plugin-view")
            .shadowRoot.querySelector(".player-popup-speed"),
      );
      assert.ok(
        commands.some(
          (command) =>
            command.path === "/player/speed" && command.body.speed === 2,
        ),
        "last speed remains selectable in a short viewport",
      );
    }
    await openSleep();
    const initial = await sleepBounds("initial");
    await click(".sleep-timer-options .native-button", "自定义");
    await edit(".sleep-timer-custom x-input", "0");
    await click(".sleep-timer-custom .sl-button", "设定");
    assert.equal(
      commands.filter((c) => c.path === "/voice-commands/sleep-timer").length,
      0,
      "invalid timer does not submit",
    );
    await sleepBounds("invalid custom");
    await edit(".sleep-timer-custom x-input", "27");
    await click(".sleep-timer-custom .sl-button", "设定");
    await wait(
      () =>
        !document
          .getElementById("plugin-view")
          .shadowRoot.querySelector(".player-popup-sleep"),
    );
    assert.equal(
      commands.find((c) => c.path === "/voice-commands/sleep-timer").body.value,
      27,
    );
    holdTimerRead = true;
    await inspect(() => {
      const frames = (window.sleepPopupFrames = []);
      function sample() {
        const popup = document
          .getElementById("plugin-view")
          ?.shadowRoot?.querySelector(".player-popup-sleep");
        const card = popup?.querySelector(".modal-card");
        const rect = card?.getBoundingClientRect();
        if (rect?.height && Number(getComputedStyle(popup).opacity) > 0) {
          frames.push([rect.x, rect.y, rect.width, rect.height]);
        }
        if (window.sleepPopupFrames === frames) requestAnimationFrame(sample);
      }
      requestAnimationFrame(sample);
    });
    await openSleep();
    assert.ok(releaseTimerRead, "timer status request is still pending");
    const pending = await sleepBounds("pending active timer");
    holdTimerRead = false;
    await releaseTimerRead();
    await wait(() =>
      document
        .getElementById("plugin-view")
        .shadowRoot.querySelector(".sleep-timer-status")
        ?.textContent.includes("取消定时"),
    );
    await pause(180);
    const active = await sleepBounds("active");
    assert.equal(pending.h, initial.h, "reopening starts at the usual height");
    const frames = await inspect(() => {
      const frames = window.sleepPopupFrames;
      delete window.sleepPopupFrames;
      return frames;
    });
    assert.ok(frames.length > 2, "sampled visible popup frames");
    const visibleBounds = [
      ...new Set(frames.map((frame) => JSON.stringify(frame))),
    ];
    assert.deepEqual(
      visibleBounds,
      [JSON.stringify([active.x, active.y, active.w, active.h])],
      `the visible popup never moves or resizes while opening with an active timer: ${visibleBounds.join(" → ")}`,
    );
    await page.screenshot({ path: `/tmp/miot-sleep-${width}x${height}.png` });
    await click(".sleep-timer-status .native-button", "取消定时");
    await wait(
      () =>
        !document
          .getElementById("plugin-view")
          .shadowRoot.querySelector(".sleep-timer-status"),
    );
    await wait(
      () =>
        !document
          .getElementById("plugin-view")
          .shadowRoot.querySelector(".player-popup-sleep"),
    );
    failTimerRead = true;
    await openSleep();
    const failed = await sleepBounds("failed status read");
    await click(".sleep-timer-status .native-button", "重试");
    await wait(() =>
      document
        .getElementById("plugin-view")
        .shadowRoot.querySelector(".sleep-timer-status")
        ?.textContent.includes("未设置延迟停止"),
    );
    assert.equal(failed.h, initial.h, "status error fits the normal popup");
    assert.equal((await sleepBounds("retried timer status")).h, initial.h);
    await click(".sleep-popup-header .sl-button", "关闭延迟停止");
    // Manually browsing lyrics suspends following until explicitly resumed.
    if (width < 600) await click(".page-dot", "显示歌词");
    await wait(
      () =>
        document
          .getElementById("plugin-view")
          .shadowRoot.querySelectorAll(".lyric-line").length === 80,
    );
    await pause(600);
    const point = await inspect(() => {
      const r = document
        .getElementById("plugin-view")
        .shadowRoot.querySelector(".lyrics-scroll")
        .getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    await page.mouse.move(point.x, point.y);
    await page.mouse.wheel({ deltaY: 500 });
    await pause(400);
    await wait(
      () =>
        !!document
          .getElementById("plugin-view")
          .shadowRoot.querySelector(".lyrics-follow"),
    );
    const top = await inspect(
      () =>
        document
          .getElementById("plugin-view")
          .shadowRoot.querySelector(".lyrics-scroll").scrollTop,
    );
    status.position = 50;
    await wait(() =>
      document
        .getElementById("plugin-view")
        .shadowRoot.querySelector("#lyric-10")
        ?.classList.contains("active"),
    );
    assert.ok(
      Math.abs(
        (await inspect(
          () =>
            document
              .getElementById("plugin-view")
              .shadowRoot.querySelector(".lyrics-scroll").scrollTop,
        )) - top,
      ) < 2,
      "progress must not pull manual scroll back",
    );
    await click(".lyrics-follow");
    await pause(650);
    assert.ok(
      !(await inspect(
        () =>
          !!document
            .getElementById("plugin-view")
            .shadowRoot.querySelector(".lyrics-follow"),
      )),
    );
    assert.ok(
      Math.abs(
        (await inspect(
          () =>
            document
              .getElementById("plugin-view")
              .shadowRoot.querySelector(".lyrics-scroll").scrollTop,
        )) - top,
      ) > 100,
      "return to current lyric scrolls back",
    );
    await click(".fullscreen-topbar .sl-button", "收起播放器");
    await click(".library-heading .sl-button", "设置");
    await click(".category", "播放");
    // Settings number editors normalize on blur and expose signed values.
    await edit(".sl-number-field x-input", "999");
    const numberValue = () =>
      inspect(
        () =>
          document
            .getElementById("plugin-view")
            .shadowRoot.querySelector(".sl-number-field x-input")
            .shadowRoot.querySelector("input").value,
      );
    assert.equal(await numberValue(), "30");
    await edit(".sl-number-field x-input", "");
    assert.equal(await numberValue(), "30");
    await edit(".sl-number-field x-input", "5");
    await click(".number-sign");
    assert.equal(await numberValue(), "-5");
    const readback = await (
      await fetch(base + "/api/v1/jsplugin/miot/api/config", {
        headers: { Authorization: "Bearer " + auth.access_token },
      })
    ).json();
    assert.equal(
      readback.data.song_transition_offset,
      -5,
      "normalized number is persisted by the real backend",
    );
    // Live streams only offer time-based timers; the smaller popup follows its content.
    status.current_song = { ...songs[0], id: 2000, is_live: true };
    await page.goto(
      base +
        "/api/v1/jsplugin/miot/static/index.html?access_token=" +
        auth.access_token,
    );
    await wait(
      () =>
        !!document
          .getElementById("plugin-view")
          ?.shadowRoot?.querySelector(".player-mini .player-copy"),
    );
    await click(".player-mini .player-copy");
    await openSleep();
    const live = await sleepBounds("live");
    assert.equal(
      await inspect(
        () =>
          document
            .getElementById("plugin-view")
            .shadowRoot.querySelectorAll(".sleep-timer-section").length,
      ),
      1,
    );
    assert.ok(live.h < initial.h, "live timer shrinks to one section");
    assert.deepEqual(errors, []);
    console.log(
      JSON.stringify({
        passed: true,
        width,
        height,
        initial,
        active,
        live,
        moreRequests,
        commands,
        physicalAudio: false,
      }),
    );
  } catch (error) {
    console.error({ pageErrors: errors });
    await page.screenshot({
      path: `/tmp/miot-polish-failure-${width}x${height}.png`,
    });
    throw error;
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
