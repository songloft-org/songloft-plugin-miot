// Run in the repository's Docker Chromium environment against an isolated backend.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const puppeteer = require(process.env.BROWSER_PUPPETEER || "puppeteer");
const base = process.env.MIOT_TEST_BASE_URL || "http://127.0.0.1:30617";
const output = process.env.MIOT_TEST_OUTPUT || "/tmp/miot-settings-review";
const categories = {
  设备: "服务器配置",
  播放: "音频格式",
  语音: "语音中枢",
  "语音/口令": "语音中枢",
  "语音/记忆": "语音中枢",
  "语音/搜索": "语音中枢",
  "AI 设置": "模型连接",
  定时: "时区设置",
  工具箱: "当前操作目标",
};
(async () => {
  fs.mkdirSync(output, { recursive: true });
  const auth = await (
    await fetch(base + "/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "admin" }),
    })
  ).json();
  const api = async (path, method = "GET", body) => {
    const response = await fetch(base + "/api/v1/jsplugin/miot/api" + path, {
      method,
      headers: {
        Authorization: "Bearer " + auth.access_token,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result = await response.json();
    assert.ok(response.ok && result.success !== false, JSON.stringify(result));
    return result.data;
  };
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const report = [];
  const fixtureConfig = {
    ...(await api("/config")),
    server_host: "http://192.168.1.20:58091/music",
    server_host_status: "ok",
    suggested_addresses: ["http://192.168.1.10:58091"],
    voice_command_enabled: true,
    conversation_monitor_enabled: true,
  };
  const receivers = {
    enabled: true,
    name: "Songloft",
    base_url: fixtureConfig.server_host,
    enabled_ids: ["one", "group"],
    running: true,
    host_supported: true,
    error: "",
    receivers: [
      {
        id: "one",
        name: "客厅音箱：这是一个用于检查换行和开关对齐的较长设备名称",
        enabled: true,
        available: true,
        running: true,
        state: "PLAYING",
        error: "",
        group_id: "",
        members: [],
      },
      {
        id: "group",
        name: "家庭分组接收器",
        enabled: true,
        available: true,
        running: true,
        state: "STOPPED",
        error: "",
        group_id: "group",
        members: [{}, {}],
      },
      {
        id: "offline",
        name: "暂时离线的卧室音箱",
        enabled: false,
        available: false,
        running: false,
        state: "STOPPED",
        error: "此设备暂时无法连接，请检查网络状态后重试。",
        group_id: "",
        members: [],
      },
    ],
  };
  try {
    for (const width of [320, 390, 1100])
      for (const theme of ["light", "dark"]) {
        const page = await browser.newPage(),
          errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.setViewport({
          width,
          height: width === 320 ? 520 : 740,
          hasTouch: width < 600,
        });
        let failConfigSave = false;
        await page.setRequestInterception(true);
        page.on("request", (request) => {
          const u = new URL(request.url()),
            prefix = "/api/v1/jsplugin/miot/api";
          if (
            failConfigSave &&
            request.method() === "POST" &&
            u.pathname === "/api/v1/jsplugin/miot/api/config"
          ) {
            void request.respond({
              status: 503,
              contentType: "application/json",
              body: JSON.stringify({
                success: false,
                error: "验证保存失败重试",
              }),
            });
            return;
          }
          let data;
          if (request.method() === "GET" && u.pathname.startsWith(prefix)) {
            const path = u.pathname.slice(prefix.length);
            if (path === "/config") data = fixtureConfig;
            if (path === "/receiver/config") data = receivers;
            if (path === "/memory/entities")
              data = {
                entities: [
                  {
                    canonicalKey: "fixture",
                    songName: "一首名称较长的歌曲用于检查语音记忆列表",
                    artist: "测试歌手",
                    aliases: [
                      {
                        id: "one",
                        query: "用一个比较长的说法播放这首歌曲，以检查手机换行",
                      },
                    ],
                  },
                ],
                unclassified: [],
              };
          }
          if (data !== undefined)
            void request.respond({
              status: 200,
              contentType: "application/json",
              body: JSON.stringify({ success: true, data }),
            });
          else void request.continue();
        });
        await page.goto(
          base +
            "/api/v1/jsplugin/miot/static/index.html?access_token=" +
            auth.access_token,
        );
        await page.waitForFunction(() =>
          document
            .getElementById("plugin-view")
            ?.shadowRoot?.querySelector(".library-heading"),
        );
        await page.waitForFunction(() =>
          document
            .getElementById("plugin-view")
            ?.shadowRoot?.querySelector(
              '.library-heading .sl-button[accessibility-label="设置"]:not(.disabled)',
            ),
        );
        await page.evaluate(
          (theme) =>
            document
              .getElementById("plugin-view")
              .sendGlobalEvent("SongloftPluginBridge.push", [
                { event: "theme", data: JSON.stringify({ theme }) },
              ]),
          theme,
        );
        await page.waitForFunction(
          (theme) =>
            document
              .getElementById("plugin-view")
              .shadowRoot.querySelector(".miot-app")
              .classList.contains("dark") ===
            (theme === "dark"),
          {},
          theme,
        );
        const click = async (selector, text, index) => {
          await page.waitForFunction(
            ({ selector, text }) =>
              [
                ...document
                  .getElementById("plugin-view")
                  .shadowRoot.querySelectorAll(selector),
              ].some(
                (e) =>
                  e.getBoundingClientRect().height > 0 &&
                  (!text || e.textContent.includes(text)),
              ),
            {},
            { selector, text },
          );
          const target = await page.evaluateHandle(
            ({ selector, text, index }) => {
              const root = document.getElementById("plugin-view").shadowRoot;
              const candidates = [...root.querySelectorAll(selector)].filter(
                (el) =>
                  el.getBoundingClientRect().width &&
                  el.getBoundingClientRect().height,
              );
              return text
                ? candidates.find(
                    (el) =>
                      el.textContent.trim() === text ||
                      el.textContent.includes(text),
                  )
                : candidates[index ?? candidates.length - 1];
            },
            { selector, text, index },
          );
          await target
            .asElement()
            .evaluate((el) => el.scrollIntoView({ block: "center" }));
          // Scrolling also schedules Lynx layout; measure again after it settles.
          await new Promise((r) => setTimeout(r, 100));
          const rect = await target.asElement().evaluate((el) => {
            const r = el.getBoundingClientRect();
            return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
          });
          await target.dispose();
          if (width < 600) await page.touchscreen.tap(rect.x, rect.y);
          else await page.mouse.click(rect.x, rect.y);
          await new Promise((resolve) => setTimeout(resolve, 100));
        };
        await page.waitForFunction(() =>
          document
            .getElementById("plugin-view")
            ?.shadowRoot?.querySelector(
              '.sl-button[accessibility-label="设置"]:not(.disabled)',
            ),
        );
        await click('.library-heading .sl-button[accessibility-label="设置"]');
        for (const [category, expected] of Object.entries(categories)) {
          console.log("checking", width, theme, category);
          await click(".category", category.split("/")[0]);
          if (category.startsWith("语音")) {
            await click(
              ".voice-section-nav-item",
              category.split("/")[1] || "监听",
            );
          }
          await page.waitForFunction(
            (expected) =>
              [
                ...document
                  .getElementById("plugin-view")
                  .shadowRoot.querySelectorAll(".settings-panel"),
              ].some(
                (panel) =>
                  panel.getBoundingClientRect().width > 0 &&
                  panel.textContent.includes(expected),
              ),
            {},
            expected,
          );
          await new Promise((resolve) => setTimeout(resolve, 250));
          for (let attempt = 0; attempt < 12; attempt++) {
            const label = await page.evaluate(() => {
              const root = document.getElementById("plugin-view").shadowRoot;
              const panel = [...root.querySelectorAll(".settings-panel")].find(
                (p) => p.getBoundingClientRect().width > 0,
              );
              const closed = [...panel.querySelectorAll(".sl-disclosure")].find(
                (el) => !el.querySelector(".sl-disclosure-content"),
              );
              return closed?.querySelector(".disclosure-heading .section-title")
                ?.textContent;
            });
            if (!label) break;
            await click(".disclosure-heading", label);
          }
          for (let attempt = 0; attempt < 8; attempt++) {
            const label = await page.evaluate(() => {
              const root = document.getElementById("plugin-view").shadowRoot;
              const panel = [...root.querySelectorAll(".settings-panel")].find(
                (p) => p.getBoundingClientRect().width > 0,
              );
              return [...panel.querySelectorAll(".advanced-toggle")].find(
                (el) => !el.textContent.includes("收起"),
              )?.textContent;
            });
            if (!label) break;
            await click(".advanced-toggle", label.trim());
            await page.waitForFunction(
              (label) =>
                ![
                  ...document
                    .getElementById("plugin-view")
                    .shadowRoot.querySelectorAll(".advanced-toggle"),
                ].some((el) => el.textContent.trim() === label),
              {},
              label.trim(),
            );
          }
          assert.equal(
            await page.evaluate(
              () =>
                [
                  ...document
                    .getElementById("plugin-view")
                    .shadowRoot.querySelectorAll(".advanced-toggle"),
                ].filter((el) => !el.textContent.includes("收起")).length,
            ),
            0,
            "advanced sections must actually expand: " + category,
          );
          if (category === "语音/口令")
            assert.ok(
              (await page.evaluate(
                () =>
                  document
                    .getElementById("plugin-view")
                    .shadowRoot.querySelectorAll(".voice-command-group").length,
              )) > 0,
              "voice commands must be visible",
            );
          if (category === "语音/记忆") {
            await click(
              '.memory-list .sl-button[accessibility-label="展开记忆"]',
            );
            await page.waitForFunction(() =>
              document
                .getElementById("plugin-view")
                .shadowRoot.querySelector(".memory-alias-row"),
            );
          }
          await new Promise((resolve) => setTimeout(resolve, 150));
          let fieldLayout;
          if (category === "设备") {
            assert.ok(
              await page.evaluate(
                () =>
                  [
                    ...document
                      .getElementById("plugin-view")
                      .shadowRoot.querySelectorAll(".section-save-mode"),
                  ].filter((el) => el.textContent === "手动保存").length >= 2,
              ),
              "server/DLNA manual save areas must be labeled",
            );
            if (width < 600) {
              await click(
                '.section-description-toggle[accessibility-label="展开DLNA 接收器说明"]',
              );
              await page.waitForFunction(() =>
                document
                  .getElementById("plugin-view")
                  .shadowRoot.querySelector(
                    '.section-description-toggle[accessibility-label="收起DLNA 接收器说明"]',
                  ),
              );
              const expandedHeight = await page.evaluate(
                () =>
                  document
                    .getElementById("plugin-view")
                    .shadowRoot.querySelector(
                      '.section-description-toggle[accessibility-label="收起DLNA 接收器说明"]',
                    )
                    .closest(".section-heading-copy")
                    .querySelector(".section-description")
                    .getBoundingClientRect().height,
              );
              assert.ok(
                width === 320 ? expandedHeight > 36 : expandedHeight >= 36,
                "full instructions must be readable",
              );
              await click(
                '.section-description-toggle[accessibility-label="收起DLNA 接收器说明"]',
              );
              await page.waitForFunction(() =>
                document
                  .getElementById("plugin-view")
                  .shadowRoot.querySelector(
                    '.section-description-toggle[accessibility-label="展开DLNA 接收器说明"]',
                  ),
              );
            }
            // Inspect the native editor in its shadow root; x-input itself uses display:contents.
            await page.evaluate(() => {
              const root = document.getElementById("plugin-view").shadowRoot;
              const section = [...root.querySelectorAll(".miot-section")].find(
                (s) =>
                  s.querySelector(".section-title")?.textContent ===
                  "DLNA 接收器",
              );
              section
                .querySelectorAll(".setting-row")[1]
                .scrollIntoView({ block: "start" });
            });
            await new Promise((r) => setTimeout(r, 200));
            const rows = await page.evaluate(() => {
              const root = document.getElementById("plugin-view").shadowRoot;
              const section = [...root.querySelectorAll(".miot-section")].find(
                (s) =>
                  s.querySelector(".section-title")?.textContent ===
                  "DLNA 接收器",
              );
              return [...section.querySelectorAll(".setting-row")]
                .filter((row) => row.querySelector(".sl-input"))
                .map((row) => ({
                  row: row.getBoundingClientRect().width,
                  input: row
                    .querySelector(".sl-input")
                    .shadowRoot.querySelector("input")
                    .getBoundingClientRect().width,
                }));
            });
            await page.screenshot({
              path: `${output}/${width}-${theme}-dlna.png`,
            });
            assert.equal(rows.length, 2);
            assert.ok(
              rows.every((r) => r.input >= r.row - 40),
              "DLNA text fields are squeezed: " + JSON.stringify(rows),
            );
            await page.evaluate(() => {
              const root = document.getElementById("plugin-view").shadowRoot;
              const section = [...root.querySelectorAll(".miot-section")].find(
                (s) =>
                  s.querySelector(".section-title")?.textContent ===
                  "服务器配置",
              );
              section.scrollIntoView({ block: "start" });
            });
            await new Promise((r) => setTimeout(r, 200));
            const gap = await page.evaluate(() => {
              const root = document.getElementById("plugin-view").shadowRoot;
              const section = [...root.querySelectorAll(".miot-section")].find(
                (s) =>
                  s.querySelector(".section-title")?.textContent ===
                  "服务器配置",
              );
              return (
                section
                  .querySelector(".sl-input")
                  .shadowRoot.querySelector("input")
                  .getBoundingClientRect().top -
                section.querySelector(".sl-select-wrap").getBoundingClientRect()
                  .bottom
              );
            });
            fieldLayout = { dlna: rows, serverAddressGap: gap };
            await page.screenshot({
              path: `${output}/${width}-${theme}-server.png`,
            });
            assert.ok(
              gap >= 11,
              "server address controls need separation: " + gap,
            );
          }
          const geometry = await page.evaluate(() => {
            const root = document.getElementById("plugin-view").shadowRoot;
            const panel = [...root.querySelectorAll(".settings-panel")].find(
              (panel) => panel.getBoundingClientRect().width > 0,
            );
            const scroll = panel.querySelector(".settings-scroll");
            const viewport = root
              .querySelector(".miot-app")
              .getBoundingClientRect();
            const elements = [...panel.querySelectorAll("*")];
            const inputs = [
              ...panel.querySelectorAll("x-input, x-textarea"),
            ].flatMap((element) => [
              ...(element.shadowRoot?.querySelectorAll("input, textarea") ||
                []),
            ]);
            const overflow = [...elements, ...inputs]
              .filter((element) => {
                const rect = element.getBoundingClientRect();
                return (
                  rect.width > 0 &&
                  rect.height > 0 &&
                  (rect.right > viewport.right + 2 ||
                    rect.left < viewport.left - 2)
                );
              })
              .map((element) => ({
                className: element.className,
                text: element.textContent.slice(0, 50),
                width: element.getBoundingClientRect().width,
              }));
            return {
              dark: root.querySelector(".miot-app").classList.contains("dark"),
              width: scroll.clientWidth,
              height: scroll.clientHeight,
              contentHeight: scroll.scrollHeight,
              overflow,
              smallInputs: inputs
                .filter((el) => {
                  const r = el.getBoundingClientRect();
                  return r.width < 80 || r.height < 32;
                })
                .map((el) => ({
                  width: el.getBoundingClientRect().width,
                  height: el.getBoundingClientRect().height,
                  placeholder: el.placeholder,
                })),
              menuWidth:
                root
                  .querySelector(".settings-menu-panel")
                  ?.getBoundingClientRect().width || 0,
            };
          });
          assert.equal(
            geometry.dark,
            theme === "dark",
            "theme remains applied",
          );
          assert.deepEqual(
            geometry.smallInputs,
            [],
            category + " usable input dimensions at " + width,
          );
          assert.ok(geometry.height > 150, category + " bounded scroll area");
          if (width < 600)
            assert.equal(
              geometry.menuWidth,
              0,
              "category menu must leave room for mobile detail",
            );
          assert.deepEqual(
            geometry.overflow,
            [],
            category + " horizontal overflow at " + width,
          );
          if (category === "播放") {
            const before = (await api("/config")).force_mp3;
            await page.evaluate(() => {
              const root = document.getElementById("plugin-view").shadowRoot;
              [...root.querySelectorAll(".setting-row")]
                .find((row) => row.textContent.includes("统一转为 MP3"))
                .scrollIntoView({ block: "center" });
            });
            await new Promise((r) => setTimeout(r, 100));
            const rect = await page.evaluate(() => {
              const root = document.getElementById("plugin-view").shadowRoot;
              const row = [...root.querySelectorAll(".setting-row")].find(
                (row) => row.textContent.includes("统一转为 MP3"),
              );
              const rect = row
                .querySelector(".sl-switch")
                .getBoundingClientRect();
              return {
                x: rect.x + rect.width / 2,
                y: rect.y + rect.height / 2,
              };
            });
            if (width === 320 && theme === "light") {
              failConfigSave = true;
              const failedSaved = page.waitForResponse(
                (response) =>
                  response.url().endsWith("/api/config") &&
                  response.request().method() === "POST",
              );
              await page.mouse.click(rect.x, rect.y);
              await failedSaved;
              await page.waitForFunction(() =>
                document
                  .getElementById("plugin-view")
                  .shadowRoot.querySelector(".config-save-error")
                  ?.textContent.includes("验证保存失败重试"),
              );
              assert.equal(
                (await api("/config")).force_mp3,
                before,
                "failed saves must not claim persistence",
              );
              failConfigSave = false;
              await click(".config-save-error .sl-button", "重试保存");
              await page.waitForFunction(
                () =>
                  !document
                    .getElementById("plugin-view")
                    .shadowRoot.querySelector(".config-save-error"),
              );
              assert.equal(
                (await api("/config")).force_mp3,
                !before,
                "retry must persist the retained change",
              );
              assert.equal(
                await page.evaluate(
                  () =>
                    document
                      .getElementById("plugin-view")
                      .shadowRoot.querySelector(".snackbar")?.textContent || "",
                ),
                "",
                "ordinary save feedback stays inline",
              );
              // Restore the value before running the normal save/restore assertions.
              const restoredAfterRetry = page.waitForResponse(
                (response) =>
                  response.url().endsWith("/api/config") &&
                  response.request().method() === "POST",
              );
              await page.mouse.click(rect.x, rect.y);
              await restoredAfterRetry;
              await page.waitForFunction(
                () =>
                  document
                    .getElementById("plugin-view")
                    .shadowRoot.querySelector(".config-save-status")
                    ?.textContent === "更改已保存",
              );
              assert.equal((await api("/config")).force_mp3, before);
            }
            const saved = page.waitForResponse(
              (response) =>
                response.url().endsWith("/api/config") &&
                response.request().method() === "POST",
            );
            await page.mouse.click(rect.x, rect.y);
            await saved;
            assert.equal((await api("/config")).force_mp3, !before);
            const restored = page.waitForResponse(
              (response) =>
                response.url().endsWith("/api/config") &&
                response.request().method() === "POST",
            );
            await page.mouse.click(rect.x, rect.y);
            await restored;
            assert.equal((await api("/config")).force_mp3, before);
          }
          if (geometry.contentHeight > geometry.height + 50) {
            const rect = await page.evaluate(() => {
              const panel = [
                ...document
                  .getElementById("plugin-view")
                  .shadowRoot.querySelectorAll(".settings-panel"),
              ].find((panel) => panel.getBoundingClientRect().width > 0);
              const rect = panel.getBoundingClientRect();
              return {
                x: rect.x + rect.width / 2,
                y: rect.y + Math.min(120, rect.height / 3),
              };
            });
            await page.mouse.move(rect.x, rect.y);
            await page.mouse.wheel({ deltaY: 400 });
            await page
              .waitForFunction(
                () =>
                  [
                    ...document
                      .getElementById("plugin-view")
                      .shadowRoot.querySelectorAll(".settings-panel"),
                  ].some(
                    (panel) =>
                      panel.getBoundingClientRect().width > 0 &&
                      panel.querySelector(".settings-scroll").scrollTop > 0,
                  ),
                { timeout: 3000 },
              )
              .catch(async (error) => {
                console.log(
                  "scroll diagnostic",
                  await page.evaluate(() =>
                    [
                      ...document
                        .getElementById("plugin-view")
                        .shadowRoot.querySelectorAll(".settings-scroll"),
                    ].map((element) => ({
                      height: element.clientHeight,
                      total: element.scrollHeight,
                      top: element.scrollTop,
                    })),
                  ),
                );
                throw error;
              });
          }
          await page.screenshot({
            path: `${output}/${width}-${theme}-${category.replace("/", "-")}.png`,
          });
          report.push({
            viewportWidth: width,
            theme,
            category,
            fieldLayout,
            ...geometry,
            saved: category === "播放",
          });
          if (width < 600)
            await click(".page-toolbar .sl-button", undefined, 0);
        }
        assert.deepEqual(errors, []);
        await page.close();
      }
    fs.writeFileSync(output + "/report.json", JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ passed: report.length, report }));
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
