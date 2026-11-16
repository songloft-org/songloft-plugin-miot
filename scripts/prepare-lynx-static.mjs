// static/ is generated output. Never let an old Vue entry overwrite the Lynx fallback.
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const output = root + 'static';
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
cpSync(root + 'frontend/public/icon.svg', output + '/icon.svg');
cpSync(
  root + 'frontend/src/ui/material-icons.LICENSE',
  output + '/material-icons.LICENSE',
);
for (const target of ['lynx', 'web']) {
  const assets = root + `frontend/dist/${target}/static`;
  if (existsSync(assets))
    cpSync(assets, output + '/static', { recursive: true });
}
