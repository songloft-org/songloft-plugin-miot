// Run against an isolated Songloft instance. A held config request must not hide the shell.
const assert = require("node:assert/strict");
const puppeteer = require(process.env.BROWSER_PUPPETEER || "puppeteer");
const base = process.env.MIOT_TEST_BASE_URL || "http://127.0.0.1:30617";
(async () => {
  const response = await fetch(base + "/api/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "admin" }),
  });
  assert.equal(response.status, 200);
  const auth = await response.json();
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  let config;
  let receivedConfig;
  const configRequested = new Promise((resolve) => {
    receivedConfig = resolve;
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 390, height: 800 });
    await page.setCacheEnabled(false);
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      if (
        new URL(request.url()).pathname === "/api/v1/jsplugin/miot/api/config"
      ) {
        config = request;
        receivedConfig();
      } else void request.continue();
    });
    await page.goto(
      base +
        "/api/v1/jsplugin/miot/static/index.html?access_token=" +
        auth.access_token,
    );
    await Promise.all([
      page.waitForFunction(() =>
        document
          .getElementById("plugin-view")
          ?.shadowRoot?.querySelector(".library-heading"),
      ),
      configRequested,
    ]);
    assert.ok(config, "config is still pending when the shell appears");
    assert.equal(
      await page.evaluate(() => {
        const root = document.getElementById("plugin-view").shadowRoot;
        return root
          .querySelector(
            '.library-heading .sl-button[accessibility-label="设置"]',
          )
          .classList.contains("disabled");
      }),
      true,
      "settings waits for its configuration",
    );
    const shellMs = Math.round(await page.evaluate(() => performance.now()));
    await config.continue();
    config = null;
    await page.waitForFunction(() =>
      document
        .getElementById("plugin-view")
        ?.shadowRoot?.querySelector(
          '.library-heading .sl-button[accessibility-label="设置"]:not(.disabled)',
        ),
    );
    console.log(
      JSON.stringify({ passed: true, shellBeforeConfig: true, shellMs }),
    );
  } finally {
    if (config) await config.abort().catch(() => {});
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
