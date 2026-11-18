// Held HTTP snapshots exercise cold startup without commanding any real speaker.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const puppeteer = require(process.env.BROWSER_PUPPETEER || 'puppeteer');
(async () => {
  const session = JSON.parse(
    fs.readFileSync(process.env.MIOT_TEST_SESSION, 'utf8'),
  );
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const report = [];
  try {
    await Promise.all(
      [320, 390, 1100].map(async (width) => {
        const page = await browser.newPage();
        await page.setViewport({ width, height: 740 });
        await page.setCacheEnabled(false);
        await page.evaluateOnNewDocument(() => {
          window.WebSocket = class {
            constructor() {
              throw new Error('fixture: no socket transport');
            }
          };
        });
        const held = new Map(),
          waiting = new Map();
        let phase = 'paused',
          firstStatus = true;
        const requested = (path) =>
          held.has(path)
            ? Promise.resolve(held.get(path))
            : new Promise((resolve) => waiting.set(path, resolve));
        const respond = (request, data, success = true) =>
          request.respond({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(
              success
                ? { success: true, data }
                : { success: false, error: 'Fixture status unavailable' },
            ),
          });
        await page.setRequestInterception(true);
        page.on('request', (request) => {
          const path = new URL(request.url()).pathname,
            prefix = '/api/v1/jsplugin/miot/api';
          if (
            process.env.MIOT_TEST_BUNDLE_FILE &&
            path.endsWith('/static/main.web.bundle')
          ) {
            void request.respond({
              status: 200,
              contentType: 'application/octet-stream',
              body: fs.readFileSync(process.env.MIOT_TEST_BUNDLE_FILE),
            });
            return;
          }
          if (!path.startsWith(prefix)) {
            void request.continue();
            return;
          }
          const key = path.slice(prefix.length);
          if (
            key === '/config' ||
            key === '/mina/devices' ||
            (key === '/player/status' &&
              (firstStatus || phase === 'syncing')) ||
            (key === '/player/toggle' && request.method() === 'POST')
          ) {
            if (key === '/player/status') firstStatus = false;
            held.set(key, request);
            waiting.get(key)?.(request);
            waiting.delete(key);
            return;
          }
          let data = [];
          if (key === '/auth/status')
            data = [{ id: 'fixture', account: 'fixture' }];
          if (key === '/player/status')
            data = {
              current_song: { id: 1, title: 'Fixture', duration: 240 },
              is_playing: phase === 'playing',
              position: 10,
              duration: 240,
              volume: 40,
              play_mode: 'order',
              speed: 1,
            };
          if (key === '/player/favorite/status') data = { is_favorited: false };
          if (key === '/lyric') data = { lyric: '' };
          if (key === '/voice-commands/sleep-timer') data = { active: false };
          void respond(
            request,
            data,
            !(key === '/player/status' && phase === 'error'),
          );
        });
        await page.goto(
          session.host +
            '/api/v1/jsplugin/miot/static/index.html?access_token=' +
            session.token,
        );
        await Promise.all([
          requested('/config'),
          page.waitForFunction(
            (width) => {
              const root = document.getElementById('plugin-view')?.shadowRoot;
              return (
                !!root?.querySelector('.library-heading') &&
                root.querySelector('.miot-app').classList.contains('narrow') ===
                  width < 600
              );
            },
            {},
            width,
          ),
        ]);
        const geometry = () =>
          page.evaluate(() => {
            const root = document.getElementById('plugin-view').shadowRoot;
            const rect = (e) => {
              if (!e) return null;
              const r = e.getBoundingClientRect();
              return {
                x: r.x,
                y: r.y,
                width: r.width,
                height: r.height,
                right: r.right,
                bottom: r.bottom,
              };
            };
            const status = root.querySelector('.device-play-state');
            const range = status && document.createRange();
            if (range) range.selectNodeContents(status);
            return {
              target: rect(root.querySelector('.device-target')),
              name: rect(root.querySelector('.device-target-name')),
              slot: rect(root.querySelector('.device-play-state-slot')),
              text: rect(range),
              status: status?.textContent || '',
            };
          });
        const snapshots = [await geometry()];
        await respond(held.get('/config'), {
          server_host: 'http://192.168.1.20:58091',
          server_host_status: 'ok',
          timezone: 'Asia/Shanghai',
        });
        await requested('/mina/devices');
        snapshots.push(await geometry());
        await respond(held.get('/mina/devices'), [
          {
            account_id: 'fixture',
            devices: [
              { device_id: 'speaker', name: '客厅智能音箱', managed: true },
            ],
          },
        ]);
        await requested('/player/status');
        const waitStatus = (...labels) =>
          page.waitForFunction(
            (labels) =>
              labels.includes(
                document
                  .getElementById('plugin-view')
                  .shadowRoot.querySelector('.device-play-state')?.textContent,
              ),
            { timeout: 15000 },
            labels,
          );
        await waitStatus('连接中', '同步中');
        snapshots.push(await geometry());
        await respond(held.get('/player/status'), {
          current_song: { id: 1, title: 'Fixture', duration: 240 },
          is_playing: false,
          position: 10,
          duration: 240,
          volume: 40,
          play_mode: 'order',
          speed: 1,
        });
        await waitStatus('已暂停');
        snapshots.push(await geometry());
        const toggle = await page.evaluate(() => {
          const button = document
            .getElementById('plugin-view')
            .shadowRoot.querySelector(
              '.player-mini [accessibility-label="播放/暂停"]',
            );
          const r = button.getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        });
        await page.mouse.click(toggle.x, toggle.y);
        await requested('/player/toggle');
        await waitStatus(width < 600 ? '发送中' : '正在发送指令…');
        snapshots.push(await geometry());
        held.delete('/player/status');
        phase = 'syncing';
        await respond(held.get('/player/toggle'), {});
        await requested('/player/status');
        await waitStatus(width < 600 ? '同步中' : '正在同步状态…');
        snapshots.push(await geometry());
        phase = 'playing';
        await respond(held.get('/player/status'), {
          current_song: { id: 1, title: 'Fixture', duration: 240 },
          is_playing: true,
          position: 10,
          duration: 240,
          volume: 40,
          play_mode: 'order',
          speed: 1,
        });
        for (const sample of snapshots)
          for (const key of ['x', 'width'])
            assert.ok(
              Math.abs(sample.target[key] - snapshots[0].target[key]) <= 1,
              'device selector must not shift during cold startup: ' +
                JSON.stringify(snapshots),
            );
        phase = 'playing';
        await waitStatus('播放中');
        snapshots.push(await geometry());
        phase = 'error';
        await waitStatus(width < 600 ? '不可用' : '状态暂不可用');
        snapshots.push(await geometry());
        for (const sample of snapshots) {
          for (const key of ['x', 'width'])
            assert.ok(
              Math.abs(sample.target[key] - snapshots[0].target[key]) <= 1,
            );
          assert.equal(sample.slot.width, width < 600 ? 44 : 88);
          assert.ok(sample.target.right <= sample.slot.x + 1);
          assert.equal(
            sample.slot.y + sample.slot.height / 2,
            sample.target.y + sample.target.height / 2,
          );
          assert.equal(sample.name.width, snapshots[0].name.width);
          if (sample.status) {
            assert.ok(
              sample.text.y >= sample.slot.y - 1 &&
                sample.text.bottom <= sample.slot.bottom + 1 &&
                sample.text.right <= sample.slot.right,
              JSON.stringify(sample),
            );
          }
        }
        report.push({
          width,
          targetWidth: snapshots[0].target.width,
          reservedWidth: snapshots[0].slot.width,
          states: snapshots.map((x) => x.status || 'initial'),
        });
        await page.close();
      }),
    );
    console.log(JSON.stringify(report));
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e.name + ': ' + e.message);
  process.exitCode = 1;
});
