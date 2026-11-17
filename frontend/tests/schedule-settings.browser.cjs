// Read-only task-list regression, including Lynx runtimes without Intl.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const puppeteer = require(process.env.BROWSER_PUPPETEER || 'puppeteer');
(async () => {
  const session = process.env.MIOT_TEST_SESSION
    ? JSON.parse(fs.readFileSync(process.env.MIOT_TEST_SESSION, 'utf8'))
    : null;
  const base =
    session?.host || process.env.MIOT_TEST_BASE_URL || 'http://127.0.0.1:30617';
  const token =
    session?.token ||
    (
      await (
        await fetch(base + '/api/v1/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'admin', password: 'admin' }),
        })
      ).json()
    ).access_token;
  const response = await fetch(base + '/api/v1/jsplugin/miot/api/schedules', {
    headers: { Authorization: 'Bearer ' + token },
  });
  const payload = await response.json();
  assert.equal(payload.success, true);
  const tasks = payload.data.tasks;
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 390, height: 740 });
    if (process.env.MIOT_TEST_BUNDLE_FILE) {
      const bundle = fs.readFileSync(process.env.MIOT_TEST_BUNDLE_FILE);
      await page.setRequestInterception(true);
      page.on('request', (request) => {
        if (new URL(request.url()).pathname.endsWith('/static/main.web.bundle'))
          void request.respond({
            status: 200,
            contentType: 'application/octet-stream',
            body: bundle,
          });
        else void request.continue();
      });
    }
    await page.goto(
      base + '/api/v1/jsplugin/miot/static/index.html?access_token=' + token,
    );
    await page.waitForFunction(() =>
      document
        .getElementById('plugin-view')
        ?.shadowRoot?.querySelector(
          '.library-heading .sl-button[accessibility-label="设置"]:not(.disabled)',
        ),
    );
    const workers = page.workers();
    assert.ok(workers.length > 0, 'exercise the actual Lynx background worker');
    for (const worker of workers)
      assert.equal(
        await worker.evaluate(() => {
          globalThis.Intl = undefined;
          return typeof Intl;
        }),
        'undefined',
      );
    const click = async (selector, text) => {
      await page.waitForFunction(
        ({ selector, text }) =>
          [
            ...document
              .getElementById('plugin-view')
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
        ({ selector, text }) => {
          const e = [
            ...document
              .getElementById('plugin-view')
              .shadowRoot.querySelectorAll(selector),
          ].find(
            (e) =>
              e.getBoundingClientRect().height > 0 &&
              (!text || e.textContent.includes(text)),
          );
          const r = e.getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        },
        { selector, text },
      );
      await page.mouse.click(rect.x, rect.y);
    };
    await click('.library-heading .sl-button[accessibility-label="设置"]');
    await click('.category', '定时');
    await page.waitForFunction(
      (tasks) => {
        const root = document.getElementById('plugin-view').shadowRoot;
        const rows = [...root.querySelectorAll('.schedule-task-row')];
        return (
          rows.length === tasks.length &&
          tasks.every((task) =>
            rows.some((row) => row.textContent.includes(task.name)),
          ) &&
          !!root.querySelector('.settings-panel .section-title')
        );
      },
      { timeout: 10000 },
      tasks,
    );
    console.log(
      JSON.stringify({
        noIntl: true,
        expectedTasks: tasks.length,
        visibleTasks: tasks.length,
      }),
    );
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error.name + ': ' + error.message);
  process.exitCode = 1;
});
