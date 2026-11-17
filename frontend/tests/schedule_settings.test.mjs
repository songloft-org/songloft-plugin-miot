import assert from 'node:assert/strict';
import test from 'node:test';
import ts from 'typescript';
import { computed, ref } from '@vue/reactivity';
import { readSetup } from './setup-source.mjs';

function settings(intl, timezone = 'Asia/Shanghai') {
  const source = readSetup('views/settings/ScheduleSettings.tsx').replace(
    /^import[\s\S]*?;\n/gm,
    '',
  );
  const hooks = [];
  let loads = 0;
  const env = {
    Intl: intl,
    computed,
    ref,
    watch() {},
    onMounted: (callback) => hooks.push(callback),
    state: {
      config: { timezone },
      playlists: [],
      schedules: [],
      scheduleLogs: [],
    },
    managedDevices: { value: [] },
    navigation: {},
    loadSchedules: async () => {
      loads++;
    },
    loadScheduleLogs: async () => {},
  };
  const js = ts.transpileModule(
    source + '\nreturn {logTimeFormatter, formatLogTime};',
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2020,
        module: ts.ModuleKind.CommonJS,
      },
    },
  ).outputText;
  const page = new Function(...Object.keys(env), js)(...Object.values(env));
  return {
    ...page,
    async mount() {
      // usePageState traverses computed bindings before running mount callbacks.
      assert.ok(page.logTimeFormatter.value);
      hooks.forEach((callback) => callback());
      await Promise.resolve();
      assert.equal(loads, 1);
    },
  };
}

test('schedule initialization still loads tasks when the runtime has no Intl', async () => {
  const page = settings(undefined);
  await page.mount();
  assert.equal(
    page.formatLogTime('2026-11-17T01:02:03Z'),
    '2026-11-17 01:02:03 UTC',
  );
});
test('a partial Intl implementation cannot break the task page', async () => {
  const page = settings({});
  await page.mount();
  assert.equal(
    page.formatLogTime('2026-11-17T01:02:03Z'),
    '2026-11-17 01:02:03 UTC',
  );
});
test('an unsupported timezone falls back to explicitly labelled UTC', async () => {
  const page = settings(Intl, 'Invalid/Zone');
  await page.mount();
  assert.equal(
    page.formatLogTime('2026-11-17T01:02:03Z'),
    '2026-11-17 01:02:03 UTC',
  );
});
test('supported runtimes retain configured timezone and handle absent or invalid dates', async () => {
  const page = settings(Intl);
  await page.mount();
  assert.match(page.formatLogTime('2026-11-17T01:02:03Z'), /09:02:03/);
  assert.equal(page.formatLogTime(undefined), '时间未知');
  assert.equal(page.formatLogTime('invalid'), '时间未知');
});
