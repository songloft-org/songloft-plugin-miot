// Run in the repository's Docker Chromium environment against an isolated backend.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const puppeteer = require(process.env.BROWSER_PUPPETEER || "puppeteer");
const base = process.env.MIOT_TEST_BASE_URL || "http://127.0.0.1:30617";
const output = process.env.MIOT_TEST_OUTPUT || "/tmp/miot-lynx-browser";
const categories = {
  设备: "服务器配置",
  播放: "音频格式",
  语音: "语音中枢",
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
        await page.evaluate(
          (theme) =>
            document
              .getElementById("plugin-view")
              .sendGlobalEvent("SongloftPluginBridge.push", [
                { event: "theme", data: JSON.stringify({ theme }) },
              ]),
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
          const rect = await page.evaluate(
            ({ selector, text, index }) => {
              const root = document.getElementById("plugin-view").shadowRoot;
              const candidates = [...root.querySelectorAll(selector)].filter(
                (element) =>
                  element.getBoundingClientRect().width &&
                  element.getBoundingClientRect().height,
              );
              const element = text
                ? candidates.find(
                    (element) =>
                      element.textContent.trim() === text ||
                      element.textContent.includes(text),
                  )
                : candidates[index ?? candidates.length - 1];
              if (!element)
                throw new Error("Missing control: " + selector + " " + text);
              element.scrollIntoView({ block: "center" });
              const rect = element.getBoundingClientRect();
              return {
                x: rect.x + rect.width / 2,
                y: rect.y + rect.height / 2,
              };
            },
            { selector, text, index },
          );
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
          await click(".category", category);
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
              width: scroll.clientWidth,
              height: scroll.clientHeight,
              contentHeight: scroll.scrollHeight,
              overflow,
              menuWidth:
                root
                  .querySelector(".settings-menu-panel")
                  ?.getBoundingClientRect().width || 0,
            };
          });
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
            path: `${output}/${width}-${theme}-${category}.png`,
          });
          report.push({
            viewportWidth: width,
            theme,
            category,
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
