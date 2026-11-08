import assert from 'node:assert/strict';
import test from 'node:test';
import { load, storageOf, chatOf } from './chat_fixture.mjs';
const { ConfigManager } = load('../src/config/manager.ts');
const { readChatConfig, validateChatConfig } = load('../src/chat/types.ts');

test('new defaults require triggers; legacy windows migrate and explicit choices survive reload', async t => {
  const { values } = storageOf(t);
  const manager = new ConfigManager();
  assert.equal((await manager.getChatConfig()).followup_enabled, false);
  for (const [seconds, enabled] of [[undefined, true], [60, true], [0, false]]) {
    values.set('chat_config:v1', JSON.stringify({ enabled: true, ...(seconds === undefined ? {} : { followup_seconds: seconds }) }));
    assert.equal((await manager.getChatConfig()).followup_enabled, enabled);
  }
  await manager.saveChatConfig({ followup_enabled: true, followup_seconds: 90 });
  assert.equal((await new ConfigManager().getChatConfig()).followup_enabled, true);
  await manager.saveChatConfig({ followup_enabled: false });
  await manager.saveChatConfig({ model: 'changed' });
  const saved = await new ConfigManager().getChatConfig();
  assert.equal(saved.followup_enabled, false);
  assert.equal(saved.followup_seconds, 90);
  assert.equal(readChatConfig({ followup_enabled: false, followup_seconds: 60 }).followup_enabled, false);
  for (const value of [null, 'true', 0, 1]) assert.throws(() => validateChatConfig({ followup_enabled: value }));
});

for (const [enabled, seconds, expected] of [[false, 60, 0], [true, 0, 0], [true, 60, 61000]]) {
  test(`only completed answers open an enabled positive window: ${enabled}/${seconds}`, t => {
    const h = chatOf(t, { config: { followup_enabled: enabled, followup_seconds: seconds } });
    t.mock.timers.enable({ apis: ['Date'], now: 1000 });
    const task = { scope: 'scope', config: { followup_enabled: enabled, followup_seconds: seconds }, turn: { id: 'test' } };
    h.chat.statuses.set('scope', { task_id: 'test' });
    for (const phase of ['queued', 'preparing', 'generating', 'speaking', 'resuming', 'cancelled', 'failed', 'unknown']) {
      h.chat.publish(task, phase);
      assert.equal(h.chat.statuses.get('scope').followup_until, 0);
    }
    h.chat.publish(task, 'completed');
    assert.equal(h.chat.statuses.get('scope').followup_until, expected);
  });
}
