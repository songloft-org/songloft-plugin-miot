import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import * as vue from 'vue';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const { parse, compileScript } = require('@vue/compiler-sfc');
const { descriptor } = parse(readFileSync(new URL('../src/views/PlayerVolumePopup.vue', import.meta.url), 'utf8'));
const { outputText } = ts.transpileModule(compileScript(descriptor, { id: 'volume-steps' }).content, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
});

function fixture(modelValue = 50, disabled = false) {
  const exports = {};
  new Function('require', 'exports', outputText)((name) => {
    if (name === 'vue') return { ...vue, onBeforeUnmount() {} };
    if (name === '../runtime') return { navigation: vue.reactive({ playerPopup: '' }) };
    return {};
  }, exports);
  const props = vue.reactive({ modelValue, popupId: 'test-volume', disabled });
  const changes = [];
  const scope = vue.effectScope();
  const popup = scope.run(() =>
    exports.default.setup(props, {
      expose() {},
      emit: (name, value) => changes.push([name, value]),
    }),
  );
  return { popup, props, changes, close: () => scope.stop() };
}

test('rapid steps accumulate from the displayed volume before the parent updates', () => {
  const f = fixture(47);
  try {
    f.popup.adjustVolume(5);
    f.popup.adjustVolume(5);
    f.popup.adjustVolume(-5);
    assert.equal(f.popup.localVolume.value, 52);
    assert.deepEqual(f.changes, [
      ['change', 52],
      ['change', 57],
      ['change', 52],
    ]);
  } finally {
    f.close();
  }
});

test('steps clamp at 0 and 100 without sending redundant boundary commands', () => {
  for (const [start, delta, end] of [
    [98, 5, 100],
    [2, -5, 0],
  ]) {
    const f = fixture(start);
    try {
      f.popup.adjustVolume(delta);
      f.popup.adjustVolume(delta);
      assert.equal(f.popup.localVolume.value, end);
      assert.deepEqual(f.changes, [['change', end]]);
    } finally {
      f.close();
    }
  }
});

test('disabled volume controls do not emit step commands', () => {
  const f = fixture(50, true);
  try {
    f.popup.adjustVolume(5);
    f.popup.adjustVolume(-5);
    assert.equal(f.popup.localVolume.value, 50);
    assert.deepEqual(f.changes, []);
  } finally {
    f.close();
  }
});

test('steps use updated device volume and preserve mute restoration', async () => {
  const f = fixture();
  try {
    f.props.modelValue = 33;
    await vue.nextTick();
    f.popup.adjustVolume(-5);
    f.popup.toggleMute();
    f.popup.toggleMute();
    assert.deepEqual(f.changes, [
      ['change', 28],
      ['change', 0],
      ['change', 28],
    ]);
  } finally {
    f.close();
  }
});
