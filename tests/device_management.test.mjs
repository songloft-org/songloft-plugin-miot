import assert from 'node:assert/strict';
import test from 'node:test';
import { loader } from './chat_loader.mjs';

const load = loader();
const { ConfigManager } = load('../src/config/manager.ts');
const { AccountManager } = load('../src/account/manager.ts');
const { MinaService } = load('../src/service/service.ts');

const device = (id, extra = {}) => ({ deviceID: id, name: id, hardware: 'LX06', presence: 'online', ...extra });

async function setup(t) {
  const previous = globalThis.songloft;
  const values = new Map();
  globalThis.songloft = {
    log: { info() {}, warn() {}, error() {} },
    storage: {
      get: async key => values.get(key) ?? null,
      set: async (key, value) => { values.set(key, value); },
    },
  };
  t.after(() => { globalThis.songloft = previous; });
  const config = new ConfigManager();
  const accounts = new AccountManager(config);
  await accounts.createAccount('a', 'Test account', 'token');
  return { values, config, accounts, service: new MinaService(accounts, config) };
}

test('all newly discovered devices are managed and remain selected after reloading storage', async t => {
  const { accounts, service, values } = await setup(t);
  accounts.setMinaClient('a', { getDeviceList: async () => [device('one'), device('two', { presence: 'offline' })] });
  assert.deepEqual((await service.getDevices('a')).map(d => d.managed), [true, true]);
  assert.deepEqual(JSON.parse(values.get('accounts'))[0].devices.map(d => d.managed), [true, true]);

  const restoredConfig = new ConfigManager();
  const restoredAccounts = new AccountManager(restoredConfig);
  assert.deepEqual((await restoredAccounts.getManagedDevices('a')).map(d => d.device_id), ['one', 'two']);
  const restoredService = new MinaService(restoredAccounts, restoredConfig);
  assert.deepEqual((await restoredService.getDevices('a')).map(d => d.managed), [true, true]);
});

test('refresh preserves saved choices and playback settings while selecting additional devices', async t => {
  const { accounts, config, service } = await setup(t);
  await accounts.updateDeviceList('a', [device('one'), device('two')]);
  await accounts.updateDeviceConfig('a', 'one', {
    managed: false, volume: 35, play_mode: 'random', play_speed: 1.5, playlist_id: 8, current_song_index: 4,
  });
  await accounts.updateDeviceConfig('a', 'two', { managed: true });
  accounts.setMinaClient('a', { getDeviceList: async () => [device('one', { name: 'Renamed' }), device('two'), device('three')] });

  const refreshed = await service.getDevices('a');
  assert.deepEqual(refreshed.map(d => d.managed), [false, true, true]);
  const saved = (await config.getDevices('a'))[0];
  assert.equal(saved.device_name, 'Renamed');
  assert.deepEqual([saved.volume, saved.play_mode, saved.play_speed, saved.playlist_id, saved.current_song_index], [35, 'random', 1.5, 8, 4]);
  const restored = new AccountManager(new ConfigManager());
  assert.deepEqual((await restored.getManagedDevices('a')).map(d => d.device_id), ['two', 'three']);

  accounts.setMinaClient('a', { getDeviceList: async () => { throw new Error('cloud unavailable'); } });
  assert.deepEqual((await service.getDevices('a')).map(d => d.managed), [false, true, true]);
});

test('management choices are isolated between accounts even for the same device ID', async t => {
  const { accounts } = await setup(t);
  await accounts.createAccount('b', 'Other account', 'token');
  await accounts.updateDeviceList('a', [device('shared')]);
  await accounts.updateDeviceConfig('a', 'shared', { managed: false });
  await accounts.updateDeviceList('b', [device('shared')]);
  assert.deepEqual(await accounts.getManagedDevices('a'), []);
  assert.deepEqual((await accounts.getManagedDevices('b')).map(d => d.device_id), ['shared']);
});

test('API device defaults stay selected when saving newly discovered devices fails', async t => {
  const { accounts, service } = await setup(t);
  accounts.setMinaClient('a', { getDeviceList: async () => [device('new')] });
  accounts.updateDeviceList = async () => { throw new Error('storage unavailable'); };
  assert.equal((await service.getDevices('a'))[0].managed, true);
});
