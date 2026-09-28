import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  base: './',
  plugins: [
    vue(),
    {
      name: 'songloft-html-transform',
      apply: 'build',
      transformIndexHtml(html) {
        let output = html.replace(/"\.\//g, '"static/');
        output = output.replace(/\s+crossorigin(?==|\s|>)/g, '');
        const script = output.match(
          /<script\b[^>]*\bsrc="static\/js\/app\.js"[^>]*><\/script>/,
        );
        if (!script) {
          throw new Error('没有生成 builder 要求的 static/js/app.js 引用');
        }
        output = output.replace(script[0], '');
        return output
          .replace(/[ \t]+$/gm, '')
          .replace('</body>', `${script[0]}\n  </body>`);
      },
    },
  ],
  build: {
    outDir: '../static',
    emptyOutDir: true,
    cssTarget: 'chrome61',
    // 把两个图标字体（4.1KB + 10.5KB）内联成 base64 data URI 打进 CSS：
    // 省掉两次跨公网 HTTPS 往返，把字体就绪窗口从秒级压到一两帧
    // （songloft-org/songloft-plugin-miot#81）。
    // 改这个值前先确认不会顺手把别的资源也内联了（src/assets 下目前只有这两个字体）。
    assetsInlineLimit: 16 * 1024,
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
        entryFileNames: 'js/app.js',
        assetFileNames: (assetInfo) =>
          assetInfo.name?.endsWith('.css')
            ? 'css/style.css'
            : 'assets/[name].[ext]',
      },
    },
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:58091',
        changeOrigin: true,
      },
    },
  },
});
