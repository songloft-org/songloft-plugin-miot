import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { computed, shallowRef } from 'vue';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const { outputText } = ts.transpileModule(readFileSync(new URL('../src/playerMaterial.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
});
function fixture({ legacy = false, supports = true } = {}) {
  const attributes = new Map([['data-theme', 'light']]);
  let fill = 'rgba(255, 255, 255, 0.55)';
  const events = new Map();
  const mounted = [], unmounted = [];
  const media = [false, false].map(matches => {
    const listeners = new Set();
    return {
      matches, listeners,
      ...(legacy ? { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) }
        : { addEventListener: (_, fn) => listeners.add(fn), removeEventListener: (_, fn) => listeners.delete(fn) }),
    };
  });
  let observer, disconnected = false;
  const exports = {};
  new Function('require', 'exports', 'window', 'document', 'CSS', 'MutationObserver', 'getComputedStyle', outputText)(
    () => ({ computed, shallowRef, onMounted: fn => mounted.push(fn), onUnmounted: fn => unmounted.push(fn) }), exports,
    { matchMedia: query => media[query.includes('transparency') ? 0 : 1] },
    {
      documentElement: { getAttribute: key => attributes.get(key) ?? null },
      addEventListener: (name, fn) => { events.set(name, fn); },
      removeEventListener: name => events.delete(name),
    },
    { supports: () => supports },
    class { constructor(fn) { observer = fn; } observe() {} disconnect() { disconnected = true; } },
    () => ({ getPropertyValue: () => fill }),
  );
  return {
    ...exports, attributes, media, events,
    setFill: value => { fill = value; },
    mount: () => mounted.forEach(fn => fn()), unmount: () => unmounted.forEach(fn => fn()),
    mutate: () => observer(), disconnected: () => disconnected,
  };
}
const input = { fill: 'rgba(255, 255, 255, .55)', dark: false, reduceTransparency: false, increaseContrast: false, blurSupported: true };

function rgba(value) { return value.match(/[\d.]+/g).map(Number); }
function over(fg, bg) { return fg.slice(0, 3).map((v, i) => v * fg[3] + bg[i] * (1 - fg[3])); }
function luminance(color) {
  return color.map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
    .reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
}
function ratio(a, b) { const [lo, hi] = [luminance(a), luminance(b)].sort((a, b) => a - b); return (hi + .05) / (lo + .05); }
function hex(value) { return value.match(/../g).map(v => parseInt(v, 16)); }

test('host tint and opacity are preserved above the floor; unknown inputs fail to solid surface', () => {
  const { resolvePlayerMaterial: resolve } = fixture();
  assert.equal(resolve({ ...input, fill: 'rgba(10, 20, 30, .99)' }).fill, 'rgba(10, 20, 30, 0.99)');
  for (const fill of ['', 'var(--md-surface-container)', 'rgba(256, 1, 2, .5)', 'rgba(1, 2, 3, 2)', 'rgba(1, 2, 3, ..5)', '#fff']) {
    assert.deepEqual(resolve({ ...input, fill }), { fill: 'var(--md-surface)', blur: false });
  }
  assert.equal(resolve({ ...input, fill: 'rgba(10, 20, 30, 1)' }).blur, false);
});

test('Flutter and Lynx baseline text and active icons remain readable over cover extremes', () => {
  const { resolvePlayerMaterial: resolve } = fixture();
  for (const [dark, rgb, subtitle, accent] of [
    [false, [255, 255, 255], '44474e', '6750a4'], [false, [255, 255, 255], '666670', '0088ff'],
    [true, [28, 28, 30], 'c4c6d0', 'd0bcff'], [true, [23, 23, 27], '98989f', '0091ff'],
  ]) {
    const material = rgba(resolve({ ...input, dark, fill: `rgba(${rgb.join(',')}, .5)` }).fill);
    for (const bg of [[0, 0, 0], [255, 255, 255]]) {
      const surface = over(material, bg);
      assert.ok(ratio(hex(subtitle), surface) >= 4.5, `${subtitle}: ${ratio(hex(subtitle), surface)}`);
      assert.ok(ratio(hex(accent), surface) >= 3, `${accent}: ${ratio(hex(accent), surface)}`);
    }
  }
  const old = over([28, 28, 30, 173 / 255], [255, 255, 255]);
  assert.ok(ratio(hex('c4c6d0'), old) < 4.5, 'the old dark fill must fail this gate');
});

test('unsupported blur, host accessibility and opacity-one all avoid the blur work', () => {
  const { resolvePlayerMaterial: resolve } = fixture();
  for (const override of [{ blurSupported: false }, { reduceTransparency: true }, { increaseContrast: true }]) {
    assert.deepEqual(resolve({ ...input, ...override }), { fill: 'rgba(255, 255, 255, 1)', blur: false });
  }
});

for (const legacy of [false, true]) {
  test(`live host/media changes use OR and release observers (legacy media=${legacy})`, () => {
    const f = fixture({ legacy });
    const style = f.usePlayerMaterial();
    f.mount();
    assert.equal(style.value['--miot-player-blur'], 'blur(20px)');
    f.attributes.set('data-theme', 'dark');
    f.setFill('rgba(23, 23, 27, .5)');
    f.events.get('songloft-theme-change')();
    assert.equal(style.value['--miot-player-fill'], 'rgba(23, 23, 27, 0.92)');
    assert.equal(style.value['--miot-player-highlight'], 'rgba(255, 255, 255, .15)');
    f.attributes.set('data-reduce-transparency', 'false');
    f.media[0].matches = true;
    f.media[0].listeners.forEach(fn => fn());
    assert.equal(style.value['--miot-player-blur'], 'none');
    f.media[0].matches = false;
    f.attributes.set('data-increase-contrast', 'true');
    f.mutate();
    assert.equal(style.value['--miot-player-blur'], 'none');
    f.attributes.delete('data-increase-contrast');
    f.mutate();
    assert.equal(style.value['--miot-player-blur'], 'blur(20px)');
    f.unmount();
    assert.equal(f.events.size, 0);
    assert.equal(f.media.reduce((count, m) => count + m.listeners.size, 0), 0);
    assert.ok(f.disconnected());
  });
}
