// static/ is generated output and overlays the builder's Lynx fallback.
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const output = root + 'static';
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
const webBundle = readFileSync(root + 'frontend/dist/web/main.web.bundle');
const version = createHash('sha256').update(webBundle).digest('hex').slice(0, 16);
const fallback = readFileSync(root + 'frontend/lynx-fallback.html', 'utf8');
writeFileSync(output + '/index.html', fallback.replace('__MIOT_WEB_BUNDLE_VERSION__', version));
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
