import { reactive, watch } from "@vue/reactivity";
import { getGlobalProps, invokeHost, onPush } from "@songloft/lynx-plugin-sdk";
import { resolveConfirm, state } from "./store";
export type AppPage = "main" | "settings" | "player";
export const navigation = reactive({
  page: "main" as AppPage,
  pageHistory: [] as AppPage[],
  playerPage: 0,
  settingsCategory: "",
  playerPopup: "",
  playerPopupAnchor: "",
  editorOpen: false,
  dialogOpen: false,
  devicePickerOpen: false,
  selectOpen: false,
  wideLayout: false,
});
export function openPage(page: AppPage) {
  if (navigation.page === page) return;
  navigation.pageHistory.push(navigation.page);
  navigation.page = page;
  navigation.playerPopup = "";
}
export function closePage() {
  navigation.playerPopup = "";
  navigation.page = navigation.pageHistory.pop() || "main";
}
export function canGoBack() {
  return (
    state.confirm.open ||
    navigation.selectOpen ||
    navigation.devicePickerOpen ||
    !!navigation.playerPopup ||
    navigation.editorOpen ||
    !!navigation.settingsCategory ||
    navigation.page !== "main"
  );
}
export function consumeBack() {
  if (state.confirm.open) resolveConfirm(false);
  else if (navigation.selectOpen) navigation.selectOpen = false;
  else if (navigation.devicePickerOpen) navigation.devicePickerOpen = false;
  else if (navigation.playerPopup) navigation.playerPopup = "";
  else if (navigation.editorOpen) navigation.editorOpen = false;
  else if (navigation.settingsCategory) {
    navigation.settingsCategory = "";
    if (navigation.page === "settings" && navigation.wideLayout) closePage();
  } else if (navigation.page !== "main") closePage();
  else return false;
  return true;
}
export function installHostBack() {
  let session = "";
  const publish = () => {
    void invokeHost("plugin", "navigationState", {
      session,
      canBack: canGoBack(),
    });
  };
  const unsubscribe = onPush((event, raw) => {
    if (event !== "navigationBack") return;
    const data = JSON.parse(String(raw));
    if (data.type === "songloft-back-connect") {
      session = data.session;
      publish();
      return;
    }
    if (data.session !== session) return;
    const consumed = consumeBack();
    void invokeHost("plugin", "navigationResult", {
      session,
      id: data.id,
      consumed,
      canBack: canGoBack(),
    });
  });
  const unwatch = watch(canGoBack, publish, { immediate: true });
  return () => {
    unsubscribe();
    unwatch();
  };
}
export function notifyHostFavorite(songId: number, isFavorited: boolean) {
  void invokeHost("favorite", "refresh", { songId, isFavorited });
}
export const serverUrl = () =>
  String((getGlobalProps() as Record<string, unknown>).serverUrl || "");
export async function openExternal(url: string) {
  const result = await invokeHost("plugin", "openUrl", { url });
  if (!result.ok) throw new Error(result.error || "无法打开链接");
}
