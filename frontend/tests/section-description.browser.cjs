// Read-only rendering checks against a local server; no settings are saved.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const puppeteer = require(process.env.BROWSER_PUPPETEER || 'puppeteer');
(async () => {
  const session = JSON.parse(
    fs.readFileSync(process.env.MIOT_TEST_SESSION, 'utf8'),
  );
  const output =
    process.env.MIOT_TEST_OUTPUT || '/tmp/miot-section-descriptions';
  fs.mkdirSync(output, { recursive: true });
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const report = [];
  try {
    for (const width of [320, 390, 1100])
      for (const theme of ['light', 'dark']) {
        const page = await browser.newPage();
        await page.setViewport({ width, height: 740 });
        if (process.env.MIOT_TEST_BUNDLE_FILE) {
          const bundle = fs.readFileSync(process.env.MIOT_TEST_BUNDLE_FILE);
          await page.setRequestInterception(true);
          page.on('request', (request) => {
            if (
              new URL(request.url()).pathname.endsWith(
                '/static/main.web.bundle',
              )
            )
              void request.respond({
                status: 200,
                contentType: 'application/octet-stream',
                body: bundle,
              });
            else void request.continue();
          });
        }
        await page.goto(
          session.host +
            '/api/v1/jsplugin/miot/static/index.html?access_token=' +
            session.token,
        );
        await page.waitForFunction(() =>
          document
            .getElementById('plugin-view')
            ?.shadowRoot?.querySelector(
              '.library-heading .sl-button[accessibility-label="设置"]:not(.disabled)',
            ),
        );
        await page.evaluate(
          (theme) =>
            document
              .getElementById('plugin-view')
              .sendGlobalEvent('SongloftPluginBridge.push', [
                { event: 'theme', data: JSON.stringify({ theme }) },
              ]),
          theme,
        );
        await page.waitForFunction(
          (theme) =>
            document
              .getElementById('plugin-view')
              .shadowRoot.querySelector('.miot-app')
              .classList.contains('dark') ===
            (theme === 'dark'),
          {},
          theme,
        );
        const click = async (selector, label) => {
          const handle = await page.evaluateHandle(
            ({ selector, label }) =>
              [
                ...document
                  .getElementById('plugin-view')
                  .shadowRoot.querySelectorAll(selector),
              ].find(
                (e) =>
                  e.getBoundingClientRect().height > 0 &&
                  (!label || e.textContent.includes(label)),
              ),
            { selector, label },
          );
          await handle.evaluate((e) => e.scrollIntoView({ block: 'center' }));
          await new Promise((resolve) => setTimeout(resolve, 100));
          const r = await handle.evaluate((e) => {
            const r = e.getBoundingClientRect();
            return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
          });
          await page.mouse.click(r.x, r.y);
          await handle.dispose();
        };
        await click('.library-heading .sl-button[accessibility-label="设置"]');
        await page.waitForFunction(() =>
          document
            .getElementById('plugin-view')
            .shadowRoot.querySelector('.category'),
        );
        await click('.category', '播放');
        await page.waitForFunction(() =>
          [
            ...document
              .getElementById('plugin-view')
              .shadowRoot.querySelectorAll('.section-title'),
          ].some((e) => e.textContent === '播放恢复'),
        );
        const measure = (title) =>
          page.evaluate((title) => {
            const root = document.getElementById('plugin-view').shadowRoot;
            const section = [...root.querySelectorAll('.miot-section')].find(
              (e) => e.querySelector('.section-title')?.textContent === title,
            );
            const rect = (e) => {
              if (!e) return null;
              const r = e.getBoundingClientRect();
              return {
                x: r.x,
                y: r.y,
                width: r.width,
                height: r.height,
                bottom: r.bottom,
                right: r.right,
              };
            };
            const description = section.querySelector('.section-description'),
              button = section.querySelector('.section-description-toggle');
            return {
              description: rect(description),
              button: rect(button),
              buttonLabel: button?.textContent,
              title: rect(section.querySelector('.section-title-row')),
              heading: rect(section.querySelector('.section-heading')),
              card: rect(section.querySelector('.miot-card')),
              overflow: getComputedStyle(description).textOverflow,
            };
          }, title);
        const settle = async (title) =>
          page.waitForFunction(
            (title) => {
              const root = document.getElementById('plugin-view').shadowRoot;
              const section = [...root.querySelectorAll('.miot-section')].find(
                (e) => e.querySelector('.section-title')?.textContent === title,
              );
              if (!section) return false;
              const probe = section.querySelector(
                '.section-description-measure',
              );
              const fullHeight = probe?.getBoundingClientRect().height;
              return (
                fullHeight > 0 &&
                fullHeight > 36.5 ===
                  !!section.querySelector('.section-description-toggle') &&
                section
                  .querySelector(
                    '.section-description:not(.section-description-measure)',
                  )
                  .getBoundingClientRect().height <= 36.5
              );
            },
            {},
            title,
          );
        const checks = [];
        for (const title of ['播放恢复', '触屏歌词与封面']) {
          if (width < 600) await settle(title);
          let collapsed = await measure(title);
          if (width >= 600) {
            assert.equal(collapsed.button, null);
            assert.ok(collapsed.description.height >= 18);
            assert.ok(collapsed.heading.bottom >= collapsed.description.bottom);
            checks.push({ title, full: true });
            continue;
          }
          assert.ok(
            collapsed.description.height <= 36.5,
            'folded preview is at most two lines',
          );
          assert.ok(
            collapsed.button.y >= collapsed.description.bottom + 3,
            'description control must sit below the text',
          );
          assert.ok(
            collapsed.button.height >= 44,
            'touch target must be at least 44px',
          );
          assert.equal(collapsed.overflow, 'ellipsis');
          assert.ok(collapsed.buttonLabel.includes('展开说明'));
          await click(
            `.section-description-toggle[accessibility-label="展开${title}说明"]`,
          );
          await page.waitForFunction(
            (title) =>
              !!document
                .getElementById('plugin-view')
                .shadowRoot.querySelector(
                  `.section-description-toggle[accessibility-label="收起${title}说明"]`,
                ),
            {},
            title,
          );
          const expanded = await measure(title);
          assert.ok(
            expanded.description.height > collapsed.description.height,
            'expanding reveals the full explanation',
          );
          assert.ok(expanded.button.y >= expanded.description.bottom + 3);
          assert.ok(
            expanded.card.y >= expanded.button.bottom,
            'card must follow both explanation and control',
          );
          await page.screenshot({
            path: `${output}/${width}-${theme}-${title}.png`,
          });
          await click(
            `.section-description-toggle[accessibility-label="收起${title}说明"]`,
          );
          await page.waitForFunction(
            (title) =>
              !!document
                .getElementById('plugin-view')
                .shadowRoot.querySelector(
                  `.section-description-toggle[accessibility-label="展开${title}说明"]`,
                ),
            {},
            title,
          );
          const restored = await measure(title);
          assert.equal(
            restored.description.height,
            collapsed.description.height,
          );
          checks.push({
            title,
            collapsedHeight: collapsed.description.height,
            expandedHeight: expanded.description.height,
            touchHeight: collapsed.button.height,
          });
        }
        if (width < 600) await click('.page-toolbar .sl-button');
        await page.waitForFunction(() =>
          document
            .getElementById('plugin-view')
            .shadowRoot.querySelector('.category'),
        );
        await click('.category', '工具箱');
        await page.waitForFunction(() =>
          [
            ...document
              .getElementById('plugin-view')
              .shadowRoot.querySelectorAll('.section-title'),
          ].some((e) => e.textContent === 'URL 播放'),
        );
        if (width < 600) await settle('URL 播放');
        const urlDescription = await measure('URL 播放');
        if (width >= 390)
          assert.equal(
            urlDescription.button,
            null,
            'URL explanation already fits; no redundant expand button',
          );
        if (width === 390) {
          for (const nextWidth of [320, 390, 580, 390]) {
            await page.setViewport({ width: nextWidth, height: 740 });
            await settle('URL 播放');
          }
          assert.equal(
            (await measure('URL 播放')).button,
            null,
            'resizing back removes obsolete expansion controls',
          );
        }
        checks.push({
          title: 'URL 播放',
          visibleHeight: urlDescription.description.height,
          foldable: !!urlDescription.button,
        });
        report.push({ width, theme, checks });
        await page.close();
      }
    console.log(JSON.stringify(report));
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e.name + ': ' + e.message);
  process.exitCode = 1;
});
