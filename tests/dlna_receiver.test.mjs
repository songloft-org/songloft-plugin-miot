import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const modules = new Map();
function load(url) {
  if (modules.has(url.href)) return modules.get(url.href);
  const exports = {};
  modules.set(url.href, exports);
  const { outputText } = ts.transpileModule(readFileSync(url, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  });
  new Function('require', 'exports', outputText)(name => load(new URL(name + '.ts', url)), exports);
  return exports;
}
const { DLNAReceiver, DEFAULT_CONFIG } = load(new URL('../src/receiver/receiver.ts', import.meta.url));
const { TYPES, DEVICE, SCHEMAS } = load(new URL('../src/receiver/protocol.ts', import.meta.url));
const { parseXML, escapeXML, child } = load(new URL('../src/receiver/xml.ts', import.meta.url));
const config = { ...DEFAULT_CONFIG, enabled: true, base_url: 'http://192.168.1.2:58091/music', account_id: 'a', device_id: 'd' };
const flush = async () => { for (let i = 0;i < 30;i++) await Promise.resolve(); };

async function harness(run) {
  const originals = { songloft: globalThis.songloft, fetch: globalThis.fetch, crypto: Object.getOwnPropertyDescriptor(globalThis, 'crypto'), now: Date.now, setTimeout, clearTimeout };
  let now = 100000, nextTimer = 0, nextSocket = 0, receive, released, external = false;
  const timers = new Map(), storage = new Map(), packets = [], calls = [], notifications = [], closed = [];
  const service = {
    stopPlay: async () => { calls.push(['stop']); return true; },
    playURL: async (...args) => { calls.push(['play', ...args]); return true; },
    pausePlayVerified: async () => { calls.push(['pause']); return 'paused'; },
    resumePlay: async () => { calls.push(['resume']); return true; },
    setVolume: async (...args) => { calls.push(['volume', ...args]); return true; },
    getVolume: async () => 40,
    getPlayState: async () => ({ status: 1, position: 12, duration: 100, hasPosition: true }),
  };
  const manager = {
    beginExternalPlayback: async callback => { external = true; released = callback; return true; },
    endExternalPlayback: () => { external = false; released?.(); },
    runExternalPlayback: async action => { assert.equal(external, true); return action(); },
  };
  const configs = { getDevices: async () => [{ device_id: 'd', managed: true }], getDeviceGroups: async () => [] };
  globalThis.songloft = {
    storage: { get: async k => storage.get(k), set: async (k, v) => storage.set(k, v) },
    net: {
      udpBind: async options => { assert.equal(options.reuseAddress, true); return { socketId: `s${++nextSocket}` }; },
      udpJoinMulticast: async () => { }, onData: (_id, handler) => { receive = handler; },
      udpSend: async (_id, data, address) => { packets.push({ data, address }); },
      udpClose: async id => { closed.push(id); },
    }, log: { warn() { }, info() { } },
  };
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { randomBytes } });
  globalThis.fetch = async (url, options) => { notifications.push({ url, ...options }); return { ok: true }; };
  Date.now = () => now;
  globalThis.setTimeout = (fn, delay) => { const id = ++nextTimer; timers.set(id, { at: now + delay, fn }); return id; };
  globalThis.clearTimeout = id => timers.delete(id);
  const receiver = new DLNAReceiver(configs, service, { getOrCreate: async () => manager });
  await receiver.init();
  const req = (method, path, headers = {}, body = '') => receiver.handle({ method, path, headers, body, query: '', remoteAddr: '192.168.1.3:12345' });
  const soap = (action, args = {}, serviceName = 'AVTransport') => req('POST', `/dlna/${serviceName}/control`, { SOAPACTION: `"${TYPES[serviceName]}#${action}"` }, `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:${action} xmlns:u="${TYPES[serviceName]}">${Object.entries(args).map(([k, v]) => `<${k}>${escapeXML(v)}</${k}>`).join('')}</u:${action}></s:Body></s:Envelope>`);
  const advance = async ms => {
    const end = now + ms;
    while (true) {
      const entry = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!entry) break;
      now = entry[1].at; timers.delete(entry[0]); entry[1].fn(); await flush();
    }
    now = end; await flush();
  };
  try { await run({ receiver, req, soap, advance, packets, calls, notifications, closed, timers, storage, service, configs, manager, search: message => receive({ data: btoa(message), remoteAddr: '192.168.1.3:54321' }) }); }
  finally {
    await receiver.close();
    globalThis.songloft = originals.songloft; globalThis.fetch = originals.fetch;
    if (originals.crypto) Object.defineProperty(globalThis, 'crypto', originals.crypto); else delete globalThis.crypto;
    Date.now = originals.now; globalThis.setTimeout = originals.setTimeout; globalThis.clearTimeout = originals.clearTimeout;
  }
}

test('XML parser preserves nested escaped metadata and rejects DTD, malformed and oversized XML', () => {
  assert.equal(parseXML('<x a="&amp;">&#x4e2d;<![CDATA[<&]]></x>').text, '中<&');
  for (const xml of ['<!DOCTYPE x SYSTEM "file:///etc/passwd"><x/>', '<x>&unknown;</x>', '<x>&amp</x>', '<x><y></x>', '<x a="1" a="2"/>', '<x/>&', '<x/>'.repeat(20000)]) assert.throws(() => parseXML(xml));
});

test('discovery describes all services, answers M-SEARCH and closes sockets/timers', async () => harness(async h => {
  await h.receiver.configure(config);
  assert.equal(h.packets.length, 6);
  const doc = await h.req('GET', '/dlna/device.xml');
  assert.equal(doc.statusCode, 200);
  assert.match(doc.body, /http:\/\/192\.168\.1\.2:58091\/music\/api\/v1\/jsplugin\/miot\/dlna\/AVTransport\/control/);
  assert.match(doc.body, /MediaRenderer:1/);
  for (const name of Object.keys(TYPES)) {
    const scpd = parseXML((await h.req('GET', `/dlna/${name}.xml`)).body);
    const variables = child(scpd, 'serviceStateTable').children.map(v => child(v, 'name').text);
    for (const args of Object.values(SCHEMAS[name].actions)) for (const [, , related] of args) assert.ok(variables.includes(related));
  }
  h.search('M-SEARCH * HTTP/1.1\r\nMAN: "ssdp:discover"\r\nMX: 1\r\nST: ssdp:all\r\n\r\n');
  await h.advance(1000);
  assert.equal(h.packets.filter(p => p.data.startsWith('HTTP/1.1 200')).length, 6);
  assert.ok(h.packets.some(p => p.data.includes(DEVICE) && p.address.endsWith(':54321')));
  await h.receiver.close();
  assert.equal(h.timers.size, 0);
  assert.equal(h.closed.length, 1);
  assert.equal(h.packets.filter(p => p.data.includes('ssdp:byebye')).length, 6);
}));

test('SOAP routes actual MP3 URL and controls to the selected speaker without importing songs', async () => harness(async h => {
  await h.receiver.configure(config);
  const uri = 'http://192.168.1.3:8000/song.mp3?key=a&other=b';
  assert.equal((await h.soap('SetAVTransportURI', { InstanceID: '0', CurrentURI: uri, CurrentURIMetaData: '' })).statusCode, 200);
  assert.equal((await h.soap('Play', { InstanceID: '0', Speed: '1' })).statusCode, 200);
  assert.deepEqual(h.calls.find(c => c[0] === 'play').slice(1, 4), ['a', 'd', uri]);
  await h.advance(5000);
  const position = await h.soap('GetPositionInfo', { InstanceID: '0' });
  assert.match(position.body, /<RelTime>00:00:12<\/RelTime>/);
  assert.equal((await h.soap('Pause', { InstanceID: '0' })).statusCode, 200);
  assert.equal((await h.soap('Play', { InstanceID: '0', Speed: '1' })).statusCode, 200);
  assert.ok(h.calls.some(c => c[0] === 'resume'));
  await h.soap('SetVolume', { InstanceID: '0', Channel: 'Master', DesiredVolume: '55' }, 'RenderingControl');
  assert.ok(h.calls.some(c => c[0] === 'volume' && c[3] === 55));
  await h.soap('Stop', { InstanceID: '0' });
  assert.equal(h.receiver.status().state, 'STOPPED');
}));

test('SOAP validates actions, instance, metadata and format before touching playback', async () => harness(async h => {
  await h.receiver.configure(config);
  for (const [action, args, code] of [
    ['Play', { InstanceID: '1', Speed: '1' }, 718],
    ['Play', { InstanceID: '0' }, 402],
    ['Seek', { InstanceID: '0' }, 401],
    ['SetAVTransportURI', { InstanceID: '0', CurrentURI: 'http://source/music.flac', CurrentURIMetaData: '' }, 714],
    ['SetAVTransportURI', { InstanceID: '0', CurrentURI: 'file:///a.mp3', CurrentURIMetaData: '' }, 716],
    ['SetAVTransportURI', { InstanceID: '0', CurrentURI: 'http://source/a.mp3', CurrentURIMetaData: '<x>' }, 402],
  ]) {
    const result = await h.soap(action, args);
    assert.equal(result.statusCode, 500);
    assert.match(result.body, new RegExp(`<errorCode>${code}</errorCode>`));
  }
  assert.equal(h.calls.length, 0);
  const uri = 'http://source/stream';
  const metadata = `<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/"><item><title>中文 &amp; 曲名</title><res protocolInfo="http-get:*:audio/mpeg:*" duration="00:03:00">${uri}</res></item></DIDL-Lite>`;
  await h.soap('SetAVTransportURI', { InstanceID: '0', CurrentURI: uri, CurrentURIMetaData: metadata });
  await h.soap('Play', { InstanceID: '0', Speed: '1' });
  assert.equal(h.calls.find(c => c[0] === 'play')[4], '中文 & 曲名');
  assert.match((await h.soap('GetMediaInfo', { InstanceID: '0' })).body, /00:03:00/);
}));

test('GENA enforces peer callbacks, sends initial/change events and handles renewal/expiry', async () => harness(async h => {
  await h.receiver.configure(config);
  const path = '/dlna/AVTransport/event';
  assert.equal((await h.req('SUBSCRIBE', path, { NT: 'upnp:event', CALLBACK: '<http://192.168.1.99:8080/event>' })).statusCode, 412);
  const sub = await h.req('SUBSCRIBE', path, { NT: 'upnp:event', CALLBACK: '<http://192.168.1.3:8080/event>', TIMEOUT: 'Second-60' });
  assert.equal(sub.statusCode, 200);
  assert.equal(h.notifications.length, 0);
  await h.advance(100);
  assert.equal(h.notifications.length, 1);
  assert.equal(h.notifications[0].headers.SEQ, '0');
  assert.equal(h.notifications[0].headers['X-Fetch-No-Redirect'], '1');
  parseXML(h.notifications[0].body);
  await h.soap('SetAVTransportURI', { InstanceID: '0', CurrentURI: 'http://source/a.mp3', CurrentURIMetaData: '' });
  await flush();
  assert.equal(h.notifications.at(-1).headers.SEQ, '1');
  assert.equal((await h.req('SUBSCRIBE', path, { SID: sub.headers.SID, TIMEOUT: 'Second-60' })).statusCode, 200);
  assert.equal((await h.req('UNSUBSCRIBE', path, { SID: sub.headers.SID })).statusCode, 200);
  const expired = await h.req('SUBSCRIBE', path, { NT: 'upnp:event', CALLBACK: '<http://192.168.1.3:8080/event>', TIMEOUT: 'Second-60' });
  await h.advance(61000);
  assert.equal((await h.req('SUBSCRIBE', path, { SID: expired.headers.SID })).statusCode, 412);
}));

test('disabled/old-host/public access fails closed; failed reconfiguration restores previous receiver', async () => harness(async h => {
  assert.equal((await h.req('GET', '/dlna/device.xml')).statusCode, 503);
  const outside = await h.receiver.handle({ method: 'GET', path: '/dlna/device.xml', remoteAddr: '8.8.8.8:80', headers: { 'X-Forwarded-For': '192.168.1.3' } });
  assert.equal(outside.statusCode, 403);
  const oldHost = await h.receiver.handle({ method: 'PUT', path: '/receiver/config', headers: {}, body: JSON.stringify(config) });
  assert.equal(oldHost.statusCode, 400);
  await h.receiver.configure(config);
  const originalJoin = songloft.net.udpJoinMulticast;
  let failed = false;
  songloft.net.udpJoinMulticast = async () => { if (!failed) { failed = true; throw new Error('Multicast unavailable'); } return originalJoin(); };
  await assert.rejects(h.receiver.configure({ ...config, name: 'Changed' }), /Multicast/);
  assert.equal(h.receiver.status().name, config.name);
  assert.equal(h.receiver.status().running, true);
  assert.equal(h.closed.length, 2);
  await h.receiver.configure({ ...config, enabled: false });
  assert.equal(h.receiver.status().running, false);
}));

test('speaker errors return SOAP faults and playlist takeover prevents stale DLNA success/stop', async () => harness(async h => {
  await h.receiver.configure(config);
  await h.soap('SetAVTransportURI', { InstanceID: '0', CurrentURI: 'http://source/a.mp3', CurrentURIMetaData: '' });
  h.service.playURL = async () => false;
  assert.equal((await h.soap('Play', { InstanceID: '0', Speed: '1' })).statusCode, 500);
  h.service.playURL = async () => { h.manager.endExternalPlayback(); return true; };
  assert.equal((await h.soap('Play', { InstanceID: '0', Speed: '1' })).statusCode, 500);
  assert.equal(h.receiver.status().state, 'STOPPED');
  const stops = h.calls.filter(c => c[0] === 'stop').length;
  await h.soap('Stop', { InstanceID: '0' });
  assert.equal(h.calls.filter(c => c[0] === 'stop').length, stops);
}));

test('setting a new URI while playing immediately replaces the stream and retains PLAYING', async () => harness(async h => {
  await h.receiver.configure(config);
  await h.soap('SetAVTransportURI', { InstanceID: '0', CurrentURI: 'http://source/first.mp3', CurrentURIMetaData: '' });
  await h.soap('Play', { InstanceID: '0', Speed: '1' });
  const next = await h.soap('SetAVTransportURI', { InstanceID: '0', CurrentURI: 'http://source/next.mp3', CurrentURIMetaData: '' });
  assert.equal(next.statusCode, 200);
  assert.equal(h.receiver.status().state, 'PLAYING');
  assert.equal(h.calls.filter(c => c[0] === 'play').at(-1)[3], 'http://source/next.mp3');
}));

test('failed speaker stop still releases receiver resources and reports the failure', async () => harness(async h => {
  await h.receiver.configure(config);
  await h.soap('SetAVTransportURI', { InstanceID: '0', CurrentURI: 'http://source/a.mp3', CurrentURIMetaData: '' });
  await h.soap('Play', { InstanceID: '0', Speed: '1' });
  h.service.stopPlay = async () => false;
  await h.receiver.configure({ ...config, enabled: false });
  assert.equal(h.receiver.status().running, false);
  assert.match(h.receiver.status().error, /拒绝停止/);
  assert.equal(h.closed.length, 1);
  assert.equal(h.timers.size, 0);
}));
