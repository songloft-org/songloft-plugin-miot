import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { ref } from 'vue';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const source = readFileSync(new URL('../src/views/settings/PlaybackSettings.vue', import.meta.url), 'utf8');
const script = source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1];
const { outputText } = ts.transpileModule(`${script}
export { clearPlaybackFailures, clearingFailures };
`, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
});

function settings(post) {
  const messages = [];
  const exports = {};
  new Function('require', 'exports', outputText)(name => {
    if (name === 'vue') return { ref, computed: () => {} };
    if (name === '../../api') return { post };
    if (name === '../../store') return {
      state: { config: {} },
      messageOf: error => error.message,
      notify: (...args) => messages.push(args),
    };
    throw new Error(`unexpected dependency: ${name}`);
  }, exports);
  return { ...exports, messages };
}

test('clear action disables repeated submissions until completion and shows the count', async () => {
  let resolve;
  let calls = 0;
  const s = settings(path => {
    assert.equal(path, '/player/failures/clear');
    calls++;
    return new Promise(res => { resolve = res; });
  });
  const pending = s.clearPlaybackFailures();
  assert.equal(s.clearingFailures.value, true);
  await s.clearPlaybackFailures();
  assert.equal(calls, 1);
  assert.deepEqual(s.messages, []);
  resolve({ cleared: 3 });
  await pending;
  assert.equal(s.clearingFailures.value, false);
  assert.deepEqual(s.messages, [['已清除 3 条播放失败标记，可重新播放', 'success']]);
});

test('clearing an empty cache gives an explicit result', async () => {
  const s = settings(async () => ({ cleared: 0 }));
  await s.clearPlaybackFailures();
  assert.equal(s.clearingFailures.value, false);
  assert.deepEqual(s.messages, [['没有需要清除的播放失败标记', 'success']]);
});

test('request failure is shown and the action can be retried', async () => {
  let calls = 0;
  const s = settings(async () => {
    if (++calls === 1) throw new Error('连接失败');
    return { cleared: 1 };
  });
  await s.clearPlaybackFailures();
  assert.equal(s.clearingFailures.value, false);
  assert.deepEqual(s.messages, [['连接失败', 'error']]);
  await s.clearPlaybackFailures();
  assert.equal(calls, 2);
  assert.equal(s.clearingFailures.value, false);
  assert.deepEqual(s.messages[1], ['已清除 1 条播放失败标记，可重新播放', 'success']);
});
