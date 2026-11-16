import { defineConfig } from '@lynx-js/rspeedy';
import { pluginReactLynx } from '@lynx-js/react-rsbuild-plugin';

export default defineConfig({
  source: { entry: { main: './src/index.tsx' } },
  plugins: [pluginReactLynx()],
  environments: {
    lynx: { output: { distPath: { root: 'dist/lynx' } } },
    web: { output: { distPath: { root: 'dist/web' } } },
  },
});
