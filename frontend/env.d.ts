/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<Record<string, never>, Record<string, never>, unknown>;
  export default component;
}

interface Window {
  flutter_inappwebview?: unknown;
  // ⚠️ 这份声明必须与主程序 `internal/jsplugin/assets/common.js` 末尾那个
  // `window.SongloftPlugin = { … }` 字面量对齐——**它才是公开成员的唯一真实来源**。
  // 手写声明的代价已经现实发生过一次：这里曾声明 `invokeHost?`，而它当时只存在于
  // `window.__SongloftInternal`（标注「插件请勿依赖」的内部句柄）、公开对象里并没有，
  // 于是 `SongloftPlugin?.invokeHost?.(...)` 通过了 TS 编译、运行时被可选调用**静默
  // 吞掉**，收藏同步整个功能一个字节都没发出去（songloft-org/songloft-plugin-miot#86）。
  // 加新成员前先去 common.js 核对那个字面量。
  SongloftPlugin?: {
    apiGet(path: string): Promise<unknown>;
    apiPost(path: string, body?: unknown): Promise<unknown>;
    apiDelete(path: string): Promise<unknown>;
    getAuthToken?(): string;
    host?: {
      isAvailable?(): boolean;
      openUrl?(params: { url: string }): Promise<unknown>;
    };
    favorite?: {
      refresh?(songId?: number, isFavorited?: boolean): Promise<void>;
    };
  };
}
