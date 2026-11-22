import assert from 'node:assert/strict';
import test from 'node:test';
import { loader } from './chat_loader.mjs';

function urlBuilder(t, request) {
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
      httpFetch: request,
    },
  })('../src/player/url_builder.ts').URLBuilder;
}

test('forced radio MP3 builds the same speaker URL without probing the host', async t => {
  const request = t.mock.fn(async () => ({ ok: false, status: 404, headers: new Headers() }));
  const URLBuilder = urlBuilder(t, request);
  for (const suffix of ['', '.flv', '.m3u8', '.mp3']) {
    const song = { id: 7, url: '/api/v1/songs/7/play' + suffix, type: 'radio' };
    const url = await URLBuilder.buildSongURL(song, {
      radioForceMp3: true, forceMp3: true, normalize: true, seekSeconds: 7, speed: 1.5,
    });
    assert.equal(url, 'https://speaker.test/music/api/v1/songs/7/play.mp3?access_token=test-token');
  }
  assert.equal(request.mock.callCount(), 0);
  for (const call of songloft.log.info.mock.calls) {
    assert.ok(!call.arguments[0].includes('test-token'));
  }
});

test('other playback keeps its own path and options', async t => {
  const request = t.mock.fn();
  const URLBuilder = urlBuilder(t, request);
  const radio = { id: 7, url: '/api/v1/songs/7/play.flv', type: 'radio' };
  const local = { id: 8, url: '/api/v1/songs/8/play', type: 'local' };
  const externalURL = 'https://source.test/live.flv?a=1&sig=abc';
  assert.equal(await URLBuilder.buildSongURL(radio), 'https://speaker.test/music/api/v1/songs/7/play.flv?access_token=test-token');
  assert.equal(await URLBuilder.buildSongURL(local, { radioForceMp3: true, forceMp3: true, normalize: true, seekSeconds: 7, speed: 1.5 }),
    'https://speaker.test/music/api/v1/songs/8/play?access_token=test-token&format=mp3&normalize=1&seek=7&speed=1.5');
  assert.equal(await URLBuilder.buildSongURL({ ...radio, url: externalURL }, { radioForceMp3: true }), externalURL);
  assert.equal(request.mock.callCount(), 0);
});
