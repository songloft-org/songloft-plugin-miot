import assert from 'node:assert/strict';
import test from 'node:test';
import { loader } from './chat_loader.mjs';

function urlBuilder(t, probe) {
  const original = globalThis.songloft;
  globalThis.songloft = {
    plugin: { getToken: async () => 'test-token' },
    log: { info: t.mock.fn(), warn() {} },
  };
  t.after(() => { globalThis.songloft = original; });
  return loader({
    '../utils/http': {
      getHostBaseUrl: () => 'https://speaker.test/music',
      getHostAPIBaseUrl: async () => 'http://127.0.0.1:58091/music',
      httpFetch: probe,
    },
  })('../src/player/url_builder.ts').URLBuilder;
}

test('forced radio MP3 sends the speaker one query parameter for every radio path', async t => {
  const probe = t.mock.fn(async () => ({ ok: true, status: 200, headers: new Headers({ 'Content-Type': 'audio/mpeg' }) }));
  const URLBuilder = urlBuilder(t, probe);
  for (const suffix of ['', '.flv', '.m3u8']) {
    const song = { id: 7, url: '/api/v1/songs/7/play' + suffix, type: 'radio' };
    const url = await URLBuilder.buildSongURL(song, {
      radioForceMp3: true, forceMp3: true, normalize: true, seekSeconds: 7, speed: 1.5,
    });
    assert.equal(url, 'https://speaker.test/music/api/v1/songs/7/play.mp3?access_token=test-token');
  }
  assert.equal(probe.mock.callCount(), 3);
  assert.equal(probe.mock.calls[0].arguments[0], 'http://127.0.0.1:58091/music/api/v1/songs/7/play.mp3');
  assert.equal(probe.mock.calls[0].arguments[1].method, 'HEAD');
  assert.equal(probe.mock.calls[0].arguments[1].headers.Authorization, 'Bearer test-token');
  for (const call of songloft.log.info.mock.calls) {
    assert.ok(!call.arguments[0].includes('test-token'));
  }
  assert.ok(songloft.log.info.mock.calls.some(call => call.arguments[0].includes('transport=path probeStatus=200')));
});

test('older hosts retain query transcoding and other playback skips the probe', async t => {
  const probe = t.mock.fn(async () => ({ ok: false, status: 404, headers: new Headers() }));
  const URLBuilder = urlBuilder(t, probe);
  const radio = { id: 7, url: '/api/v1/songs/7/play.flv', type: 'radio' };
  const local = { id: 8, url: '/api/v1/songs/8/play', type: 'local' };
  assert.equal(await URLBuilder.buildSongURL(radio, { radioForceMp3: true }),
    'https://speaker.test/music/api/v1/songs/7/play.flv?access_token=test-token&radio_transcode=mp3');
  assert.equal(await URLBuilder.buildSongURL(radio), 'https://speaker.test/music/api/v1/songs/7/play.flv?access_token=test-token');
  assert.equal(await URLBuilder.buildSongURL(local, { radioForceMp3: true, forceMp3: true, normalize: true, seekSeconds: 7, speed: 1.5 }),
    'https://speaker.test/music/api/v1/songs/8/play?access_token=test-token&format=mp3&normalize=1&seek=7&speed=1.5');
  assert.equal(probe.mock.callCount(), 1);
  assert.ok(songloft.log.info.mock.calls.some(call => call.arguments[0].includes('transport=query probeStatus=404')));
});
