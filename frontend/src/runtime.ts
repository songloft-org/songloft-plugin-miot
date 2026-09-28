import { reactive } from 'vue';
import { resolveConfirm, state } from './store';

export type AppPage = 'main' | 'settings' | 'player';

export const navigation = reactive({
  page: 'main' as AppPage,
  pageHistory: [] as AppPage[],
  settingsCategory: '',
  playerPopup: '',
  editorOpen: false,
  dialogOpen: false,
  devicePickerOpen: false,
});

export function openPage(page: AppPage): void {
  if (navigation.page === page) return;
  navigation.pageHistory.push(navigation.page);
  navigation.page = page;
  navigation.playerPopup = '';
  document.documentElement.scrollTop = 0;
  document.body.scrollTop = 0;
}

export function closePage(): void {
  navigation.playerPopup = '';
  navigation.page = navigation.pageHistory.pop() || 'main';
  document.documentElement.scrollTop = 0;
  document.body.scrollTop = 0;
}

/**
 * 宿主返回键回调：按「最上层浮层 → 编辑器 → 设置子分类 → 页面」的顺序收起，
 * 每层都真正关闭并吞掉这次返回；没有浮层时返回 false 交由宿主处理。
 * 之前 dialogOpen/editorOpen 从未被置位，导致弹窗/编辑器打开时返回键会直接退出页面。
 */
export function consumeBack(): boolean {
  if (state.confirm.open) {
    resolveConfirm(false);
    return true;
  }
  if (navigation.devicePickerOpen) {
    navigation.devicePickerOpen = false;
    return true;
  }
  if (navigation.playerPopup) {
    navigation.playerPopup = '';
    return true;
  }
  if (navigation.editorOpen) {
    navigation.editorOpen = false;
    return true;
  }
  if (navigation.page === 'settings' && navigation.settingsCategory && window.innerWidth < 600) {
    navigation.settingsCategory = '';
    return true;
  }
  if (navigation.page !== 'main') {
    if (navigation.page === 'settings') navigation.settingsCategory = '';
    closePage();
    return true;
  }
  return false;
}

/**
 * 通知宿主刷新收藏缓存（songloft-org/songloft-plugin-miot#86）。
 *
 * 我们只改了服务端数据，而 Flutter 侧曲库的红心读的是 `FavoriteNotifier` 的内存
 * 缓存，不推这一下就不会同步。
 *
 * ⚠️ **这个方法必须存在于 `common.js` 末尾那个 `window.SongloftPlugin` 字面量里。**
 * 上一版写的是 `SongloftPlugin?.invokeHost?.(...)`，而 `invokeHost` 当时只挂在
 * `window.__SongloftInternal`（内部句柄）、公开对象里并没有 —— 我们却在
 * `env.d.ts` 里自己声明了它，于是 TS 放行、运行时被可选调用**静默吞掉**，
 * 整个功能一个字节都没发出去。加宿主 API 前先去 `common.js` 核对那个字面量。
 *
 * 失败只吞掉：收藏本身已经成功了，不该因为缓存同步失败去打扰用户。
 */
export function notifyHostFavorite(songId: number, isFavorited: boolean): void {
  try {
    void window.SongloftPlugin?.favorite?.refresh?.(songId, isFavorited)?.catch(() => {});
  } catch {
    /* 老客户端没有 favorite 命名空间 */
  }
}

export const hostMode = reactive({ value: 'tab' as 'tab' | 'fullscreen' | 'browser' });

export function detectHostMode(): void {
  let available = false;
  try {
    available = !!window.SongloftPlugin?.host?.isAvailable?.();
  } catch {
    available = false;
  }
  if (!available) hostMode.value = 'browser';
  else if (document.documentElement.classList.contains('embed')) hostMode.value = 'fullscreen';
  else hostMode.value = 'tab';
  document.documentElement.classList.add(`miot-mode-${hostMode.value}`);
}
