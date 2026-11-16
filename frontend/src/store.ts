import { onPush } from "@songloft/lynx-plugin-sdk";
import { PluginSocket as WebSocket } from "./socket";
import type { ChatStatus } from "../../src/chat/types";
import { computed, reactive } from "@vue/reactivity";
import { del, get, messageOf, pluginWebSocketUrl, post, query } from "./api";
import type {
  Account,
  AccountDevices,
  ConversationMessage,
  Device,
  DeviceGroup,
  IndexStatus,
  MemoryEntity,
  MemoryStats,
  MiotConfig,
  PlayerStatus,
  Playlist,
  PlaylistProgress,
  PlayMode,
  ScheduleLog,
  ScheduledTask,
  SearchProvider,
  Song,
  VoiceCommand,
  Webhook,
} from "./types";

const defaultConfig: MiotConfig = {
  server_host: "",
  server_host_status: "empty",
  suggested_addresses: [],
  conversation_monitor_enabled: false,
  conversation_poll_interval: 2,
  debug_log_enabled: false,
  voice_command_enabled: false,
  voice_memory_enabled: true,
  voice_memory_max_records: 100,
  scheduled_tasks_enabled: false,
  timezone: "Asia/Shanghai",
  force_mp3: false,
  radio_force_mp3: false,
  volume_normalize: false,
  song_transition_offset: 0,
  max_song_index: 10000,
  external_search_enabled: false,
  external_search_url: "",
  external_search_token: "",
  external_search_sources: [],
  external_search_playlist_id: "",
  external_search_timeout: 6,
  external_search_no_import: false,
  search_priority: "parallel",
  song_match_threshold: 70,
  music_api_model_disabled: [],
  music_api_model_defaults: [],
  indicator_light_enabled: false,
  interrupt_tts_hint_enabled: false,
  interrupt_tts_hint_text: "正在搜索，请稍候",
  play_announcement_enabled: false,
  play_announcement_template: "即将播放{artist}的{song}",
  play_announcement_wait_mode: "auto",
  play_announcement_delay: 3,
  play_announcement_scope: "voice",
  smart_resume_timeout: 30,
  hourly_chime_resume_enabled: false,
  default_cover_id: "",
  touchscreen_lyrics_enabled: false,
  ai_config: {},
};

export interface SnackbarState {
  text: string;
  kind: "info" | "success" | "warning" | "error";
  token: number;
}

export interface OperationLogEntry {
  id: number;
  time: string;
  message: string;
  success: boolean;
  ttsText?: string;
}

export interface ConfirmState {
  open: boolean;
  title: string;
  message: string;
  confirmText: string;
  dangerous: boolean;
  /**
   * 可选复选框：出现在确认对话框正文下方，勾选状态随 resolve 一起回传。
   * 用于"删歌"这种"是/否" + "要不要顺带做另一件事"的确认场景。
   */
  checkbox?: { label: string; checked: boolean };
  resolve?: (value: { confirmed: boolean; checked: boolean }) => void;
}

export const state = reactive({
  chatStatus: null as ChatStatus | null,
  initialized: false,
  loading: true,
  startupError: "",
  deviceConnecting: false,
  refreshing: false,
  config: { ...defaultConfig } as MiotConfig,
  configLoaded: false,
  configSaving: false,
  configSaveState: "idle" as "idle" | "saving" | "saved" | "error",
  configSaveError: "",
  accounts: [] as Account[],
  devices: [] as AccountDevices[],
  groups: [] as DeviceGroup[],
  currentAccountId: "",
  currentDeviceId: "",
  playlists: [] as Playlist[],
  selectedPlaylistId: "",
  songs: [] as Song[],
  songsLoading: false,
  songsLoadingMore: false,
  songsPaged: false,
  songsHasMore: false,
  songsNextOffset: 0,
  songsError: "",
  songsMoreError: "",
  songsTotal: null as number | null,
  songSearch: "",
  // 当前设备在当前所选歌单上次播到哪一首。切歌单/切设备都要重取：进度是按
  // 「设备 × 歌单」记的，换任一维度都是另一条记录。
  playlistProgress: null as PlaylistProgress | null,
  player: {} as PlayerStatus,
  playerBusy: false,
  statusConnected: false,
  playerStatusState: "unknown" as "unknown" | "loading" | "ready" | "error",
  schedules: [] as ScheduledTask[],
  scheduleLogs: [] as ScheduleLog[],
  voiceCommands: [] as VoiceCommand[],
  conversationMessages: [] as ConversationMessage[],
  conversationStatus: null as Record<string, unknown> | null,
  webhooks: [] as Webhook[],
  indexStatus: {} as IndexStatus,
  memoryStats: {} as MemoryStats,
  memoryEntities: [] as MemoryEntity[],
  memoryUnclassified: [] as Array<Record<string, unknown>>,
  memoryAmbiguous: [] as Array<Record<string, unknown>>,
  searchProviders: [] as SearchProvider[],
  aiModels: [] as Array<{ id: string; ownedBy?: string }>,
  aiModelLoading: false,
  aiModelError: "" as string,
  snackbar: null as SnackbarState | null,
  confirm: {
    open: false,
    title: "",
    message: "",
    confirmText: "确定",
    dangerous: false,
  } as ConfirmState,
  operationLog: [] as OperationLogEntry[],
});

export function deviceId(device: Device): string {
  return String(device.device_id || device.deviceID || device.id || "");
}

export function deviceName(device: Device): string {
  return device.name || device.alias || "未命名设备";
}

// 歌单选项统一显示成「名称 (歌曲数)」。数量直接来自后端 /playlists 的 song_count，
// 用户靠它比对新导入的歌曲有没有真的入库（songloft-org/songloft-plugin-miot#79）。
export function playlistLabel(playlist: Playlist): string {
  return `${playlist.name} (${playlist.song_count ?? 0})`;
}

export const currentDevice = computed(() => {
  const account = state.devices.find(
    (item) => item.account_id === state.currentAccountId,
  );
  return (
    account?.devices.find(
      (device) => deviceId(device) === state.currentDeviceId,
    ) || null
  );
});

export const managedDevices = computed(() =>
  state.devices.flatMap((account) =>
    account.devices
      .filter((device) => device.managed)
      .map((device) => ({
        accountId: account.account_id,
        accountName: account.account_name || account.account_id,
        device,
      })),
  ),
);

export const visibleSongs = computed(() => {
  if (state.songsPaged) return state.songs;
  const keyword = state.songSearch.trim().toLocaleLowerCase("zh-CN");
  if (!keyword) return state.songs;
  return state.songs.filter((song) =>
    [song.title, song.artist, song.album]
      .filter(Boolean)
      .some((value) =>
        String(value).toLocaleLowerCase("zh-CN").includes(keyword),
      ),
  );
});

let snackbarTimer: ReturnType<typeof setTimeout> | null = null;
let snackbarToken = 0;
export function notify(
  text: string,
  kind: SnackbarState["kind"] = "info",
  duration = 3200,
): void {
  snackbarToken += 1;
  const token = snackbarToken;
  state.snackbar = { text, kind, token };
  if (snackbarTimer) clearTimeout(snackbarTimer);
  snackbarTimer = setTimeout(() => {
    if (state.snackbar?.token === token) state.snackbar = null;
  }, duration);
}

let operationId = 0;
export function addOperation(
  message: string,
  success: boolean,
  text?: string,
): void {
  const ttsText = text?.trim() || undefined;
  const existingIndex =
    ttsText === undefined
      ? -1
      : state.operationLog.findIndex((item) => item.ttsText === ttsText);
  const existing =
    existingIndex >= 0
      ? state.operationLog.splice(existingIndex, 1)[0]
      : undefined;
  state.operationLog.unshift({
    id: existing?.id ?? ++operationId,
    time: new Date().toLocaleTimeString(),
    message,
    success,
    ttsText,
  });
  state.operationLog.splice(30);
}

export function confirmAction(
  title: string,
  message: string,
  confirmText = "确定",
  dangerous = false,
  checkbox?: { label: string; initial?: boolean },
): Promise<{ confirmed: boolean; checked: boolean }> {
  return new Promise((resolve) => {
    state.confirm = {
      open: true,
      title,
      message,
      confirmText,
      dangerous,
      checkbox: checkbox
        ? { label: checkbox.label, checked: !!checkbox.initial }
        : undefined,
      resolve,
    };
  });
}

export function resolveConfirm(value: boolean): void {
  const checked = !!state.confirm.checkbox?.checked;
  state.confirm.resolve?.({ confirmed: value, checked });
  state.confirm.open = false;
  state.confirm.resolve = undefined;
  state.confirm.checkbox = undefined;
}

/**
 * 从歌单删除一首歌。可选 `fromLibrary=true` 时同时从曲库永久删除
 * （封面 + 缓存都清，本地原始音乐文件保留）。
 *
 * 音箱正播那首被删时，后端会先切下一首再摘除；前端只负责刷新本地歌曲列表和
 * 播放状态（不重新拉整份进度：切换靠 status WS 推）。收藏歌单删除后，
 * fullscreen 的"已收藏"图标由下一次 `loadSongDetails` 校准。
 */
export async function removeSongFromPlaylist(
  song: Song,
  opts: { fromLibrary?: boolean; playlistId?: string | number } = {},
): Promise<void> {
  const playlistId = String(opts.playlistId ?? state.selectedPlaylistId);
  if (!playlistId) throw new Error("请先选择歌单");
  try {
    await post("/player/song/remove", {
      playlist_id: Number(playlistId),
      song_id: song.id,
      from_library: !!opts.fromLibrary,
      account_id: state.currentAccountId,
      device_id: state.currentDeviceId,
    });
    if (playlistId === state.selectedPlaylistId) {
      const loaded = state.songs.some((item) => item.id === song.id);
      songRequest++;
      state.songsLoadingMore = false;
      if (loaded && state.songsTotal !== null)
        state.songsTotal = Math.max(0, state.songsTotal - 1);
      if (loaded && state.songsPaged)
        state.songsNextOffset = Math.max(0, state.songsNextOffset - 1);
      state.songs = state.songs.filter((item) => item.id !== song.id);
    }
    notify(opts.fromLibrary ? "已从歌单和曲库删除" : "已从歌单删除", "success");
    void refreshPlayerStatus();
    void refreshPlaylistProgress();
  } catch (error) {
    notify(messageOf(error), "error");
    throw error;
  }
}

export async function loadConfig(): Promise<void> {
  const config = await get<MiotConfig>("/config");
  // Normalize nullable fields before touching the reactive object: never expose
  // transient null arrays (reactivity can render between individual assignments).
  const normalized: MiotConfig = {
    ...defaultConfig,
    ...(config || {}),
    suggested_addresses: Array.isArray(config?.suggested_addresses)
      ? config.suggested_addresses
      : [],
    external_search_sources: Array.isArray(config?.external_search_sources)
      ? config.external_search_sources
      : [],
    music_api_model_disabled: Array.isArray(config?.music_api_model_disabled)
      ? config.music_api_model_disabled
      : [],
    music_api_model_defaults: Array.isArray(config?.music_api_model_defaults)
      ? config.music_api_model_defaults
      : [],
    ai_config:
      config?.ai_config && typeof config.ai_config === "object"
        ? { ...config.ai_config }
        : {},
  };
  Object.assign(state.config, normalized);
  state.configLoaded = true;
}

let savedConfig = "";
let pendingConfigPatch: Partial<MiotConfig> | null = null;
let configSavePromise: Promise<void> | null = null;
function configFingerprint(): string {
  return JSON.stringify(state.config);
}

export function saveConfig(patch: Partial<MiotConfig>): Promise<void> {
  const snapshot = JSON.parse(JSON.stringify(patch)) as Partial<MiotConfig>;
  Object.assign(state.config, snapshot);
  const saved = JSON.parse(savedConfig || "{}") as Partial<MiotConfig>;
  const changed = Object.keys(snapshot).some(
    (key) =>
      JSON.stringify(snapshot[key as keyof MiotConfig]) !==
      JSON.stringify(saved[key as keyof MiotConfig]),
  );
  if (!changed && !pendingConfigPatch && !configSavePromise)
    return Promise.resolve();
  pendingConfigPatch = { ...(pendingConfigPatch || {}), ...snapshot };
  if (configSavePromise) return configSavePromise;

  state.configSaving = true;
  state.configSaveState = "saving";
  state.configSaveError = "";
  configSavePromise = (async () => {
    try {
      while (pendingConfigPatch) {
        const nextPatch = pendingConfigPatch;
        pendingConfigPatch = null;
        try {
          await post("/config", nextPatch);
        } catch (error) {
          // Keep the failed write and prefer any newer edits for the same key.
          pendingConfigPatch = { ...nextPatch, ...(pendingConfigPatch || {}) };
          throw error;
        }
        if (
          nextPatch.server_host !== undefined &&
          state.config.server_host === nextPatch.server_host
        ) {
          const host = nextPatch.server_host.trim();
          state.config.server_host_status = !host
            ? "empty"
            : /^https?:\/\/(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::|\/|$)/i.test(
                  host,
                )
              ? "loopback"
              : "ok";
        }
        savedConfig = JSON.stringify({
          ...JSON.parse(savedConfig || "{}"),
          ...nextPatch,
        });
      }
      state.configSaveState = "saved";
    } catch (error) {
      state.configSaveState = "error";
      state.configSaveError = messageOf(error);
      throw error;
    } finally {
      state.configSaving = false;
      configSavePromise = null;
    }
  })();
  // Automatic change handlers may intentionally ignore the returned promise.
  // Awaiting callers still receive rejection; the persistent UI owns feedback.
  void configSavePromise.catch(() => {});
  return configSavePromise;
}

export function retryConfigSave(): Promise<void> {
  return saveConfig({});
}

export async function loadAccountsAndDevices(): Promise<void> {
  const [accounts, devices] = await Promise.all([
    get<Account[]>("/auth/status"),
    get<AccountDevices[]>("/mina/devices"),
  ]);
  state.accounts = accounts || [];
  state.devices = devices || [];
  ensureCurrentDevice();
}

function ensureCurrentDevice(): void {
  const currentExists = state.devices.some(
    (account) =>
      account.account_id === state.currentAccountId &&
      account.devices.some(
        (device) => deviceId(device) === state.currentDeviceId,
      ),
  );
  if (currentExists) return;
  for (const account of state.devices) {
    const selected =
      account.devices.find(
        (device) => deviceId(device) === account.last_selected_device_id,
      ) ||
      account.devices.find((device) => device.managed) ||
      account.devices[0];
    if (selected) {
      state.currentAccountId = account.account_id;
      state.currentDeviceId = deviceId(selected);
      return;
    }
  }
  state.currentAccountId = "";
  state.currentDeviceId = "";
}

let selectionRevision = 0;
export async function selectDevice(
  accountId: string,
  selectedDeviceId: string,
): Promise<void> {
  selectionRevision += 1;
  const revision = selectionRevision;
  state.currentAccountId = accountId;
  state.currentDeviceId = selectedDeviceId;
  state.player = {};
  // 进度是按设备记的：换了设备，当前歌单的续播位置也换了一条记录
  state.playlistProgress = null;
  void refreshPlaylistProgress();
  connectStatusStream();
  try {
    await post("/mina/last_selection", {
      account_id: accountId,
      device_id: selectedDeviceId,
    });
    if (revision === selectionRevision) await refreshPlayerStatus();
  } catch (error) {
    if (revision === selectionRevision) notify(messageOf(error), "error");
  }
}

export async function toggleManaged(
  accountId: string,
  selectedDeviceId: string,
  managed: boolean,
) {
  await post("/mina/device/managed", {
    account_id: accountId,
    device_id: selectedDeviceId,
    managed,
  });
  const account = state.devices.find((item) => item.account_id === accountId);
  const device = account?.devices.find(
    (item) => deviceId(item) === selectedDeviceId,
  );
  if (device) device.managed = managed;
  notify(managed ? "已启用设备管理" : "已停用设备管理", "success");
}

export async function loadPlaylists(): Promise<void> {
  state.playlists = (await get<Playlist[]>("/playlists")) || [];
  if (
    state.selectedPlaylistId &&
    !state.playlists.some(
      (playlist) => String(playlist.id) === state.selectedPlaylistId,
    )
  ) {
    state.selectedPlaylistId = "";
    state.songs = [];
  }
}

let songRequest = 0;
let songSearchTimer: ReturnType<typeof setTimeout> | undefined;
type SongPage = {
  songs: Song[];
  next_offset: number;
  has_more: boolean;
  total?: number;
};
function requestSongPage(playlistId: string, offset: number, keyword: string) {
  return get<SongPage | Song[]>(
    `/playlists/${encodeURIComponent(playlistId)}/songs${query({ limit: 100, offset, keyword })}`,
  );
}
function applySongPage(page: SongPage | Song[], append: boolean) {
  const rows = Array.isArray(page) ? page : page.songs;
  state.songs = append
    ? [
        ...state.songs,
        ...rows.filter(
          (song) => !state.songs.some((old) => old.id === song.id),
        ),
      ]
    : rows;
  state.songsTotal = Array.isArray(page)
    ? page.length
    : typeof page.total === "number" && Number.isFinite(page.total)
      ? Math.max(0, page.total)
      : null;
  state.songsPaged = !Array.isArray(page);
  state.songsHasMore =
    !Array.isArray(page) &&
    page.has_more &&
    page.next_offset > state.songsNextOffset;
  state.songsNextOffset = Array.isArray(page) ? page.length : page.next_offset;
}
async function loadFirstSongs() {
  const request = ++songRequest;
  state.songs = [];
  state.songsError = "";
  state.songsMoreError = "";
  state.songsTotal = null;
  state.songsNextOffset = 0;
  state.songsHasMore = false;
  state.songsPaged = true;
  state.songsLoading = true;
  state.songsLoadingMore = false;
  try {
    const page = await requestSongPage(
      state.selectedPlaylistId,
      0,
      state.songSearch.trim(),
    );
    if (request === songRequest) applySongPage(page, false);
  } catch (error) {
    if (request === songRequest) state.songsError = messageOf(error);
  } finally {
    if (request === songRequest) state.songsLoading = false;
  }
}
let pendingSongPage: Promise<void> | undefined;
export function loadMoreSongs(retry = false): Promise<void> {
  if (state.songsLoadingMore) return pendingSongPage || Promise.resolve();
  if (
    !state.songsHasMore ||
    state.songsLoading ||
    (state.songsMoreError && !retry)
  )
    return Promise.resolve();
  const request = songRequest;
  state.songsLoadingMore = true;
  state.songsMoreError = "";
  pendingSongPage = (async () => {
    try {
      const page = await requestSongPage(
        state.selectedPlaylistId,
        state.songsNextOffset,
        state.songSearch.trim(),
      );
      if (request === songRequest) applySongPage(page, true);
    } catch (error) {
      if (request === songRequest) state.songsMoreError = messageOf(error);
    } finally {
      if (request === songRequest) state.songsLoadingMore = false;
    }
  })();
  return pendingSongPage;
}
export function searchSongs(value: string) {
  state.songSearch = value;
  clearTimeout(songSearchTimer);
  if (state.songsPaged) {
    // Invalidate an outstanding page immediately, before the debounce expires.
    songRequest++;
    state.songsLoadingMore = false;
    state.songsLoading = true;
    state.songsMoreError = "";
    songSearchTimer = setTimeout(() => {
      void loadFirstSongs();
    }, 250);
  }
}
export async function ensureSongLoaded(id: number): Promise<number> {
  const playlistId = state.selectedPlaylistId;
  let index = state.songs.findIndex((song) => song.id === id);
  while (
    index < 0 &&
    state.songsHasMore &&
    playlistId === state.selectedPlaylistId
  ) {
    const offset = state.songsNextOffset;
    await loadMoreSongs();
    if (state.songsMoreError)
      throw new Error(`暂时无法定位歌曲：${state.songsMoreError}`);
    if (offset === state.songsNextOffset) break;
    index = state.songs.findIndex((song) => song.id === id);
  }
  return playlistId === state.selectedPlaylistId ? index : -1;
}
export async function selectPlaylist(playlistId: string): Promise<void> {
  clearTimeout(songSearchTimer);
  state.selectedPlaylistId = playlistId;
  state.songSearch = "";
  state.songs = [];
  state.songsError = "";
  state.songsMoreError = "";
  state.songsTotal = null;
  state.playlistProgress = null;
  songRequest += 1;
  state.songsLoadingMore = false;
  state.songsHasMore = false;
  if (!playlistId) {
    state.songsLoading = false;
    void refreshPlaylistProgress();
    return;
  }
  // 不等它：进度只是辅助信息（标记上次播放的那首、亮起「继续播放」），
  // 不该把歌曲列表的加载卡在它后面
  void refreshPlaylistProgress();
  await loadFirstSongs();
}

let progressRequest = 0;
/**
 * 拉取当前设备在当前所选歌单的续播进度。进度按「设备 × 歌单」记，
 * 所以切歌单、切设备都要重取；取不到就当没有，不打扰用户。
 */
export async function refreshPlaylistProgress(): Promise<void> {
  progressRequest += 1;
  const request = progressRequest;
  const playlistId = state.selectedPlaylistId;
  if (!playlistId || !state.currentAccountId || !state.currentDeviceId) {
    state.playlistProgress = null;
    return;
  }
  try {
    const progress = await get<PlaylistProgress | null>(
      `/playlists/${encodeURIComponent(playlistId)}/progress${query({
        account_id: state.currentAccountId,
        device_id: state.currentDeviceId,
      })}`,
    );
    if (request === progressRequest) state.playlistProgress = progress || null;
  } catch {
    if (request === progressRequest) state.playlistProgress = null;
  }
}

/** 当前所选歌单里「上次播到的那首」，用于列表标记与「继续播放」按钮文案 */
export const lastPlayedSong = computed(() => {
  const songId = state.playlistProgress?.song_id;
  if (!songId) return null;
  return state.songs.find((song) => song.id === songId) || null;
});

async function selectCurrentPlaylistOnEntry(): Promise<void> {
  if (state.selectedPlaylistId) return;

  if (state.player.current_song) {
    const statusPlaylistId = state.player.playlist_id;
    const matchedById =
      statusPlaylistId === undefined
        ? undefined
        : state.playlists.find(
            (playlist) => String(playlist.id) === String(statusPlaylistId),
          );
    const matched =
      matchedById ||
      (state.player.playlist_name
        ? state.playlists.find(
            (playlist) => playlist.name === state.player.playlist_name,
          )
        : undefined);
    if (matched) {
      await selectPlaylist(String(matched.id));
      return;
    }
  }

  // 有歌单但没有匹配到当前播放时，默认选第一个歌单
  if (state.playlists.length > 0) {
    await selectPlaylist(String(state.playlists[0].id));
  }
}

function targetBody() {
  if (!state.currentAccountId || !state.currentDeviceId) {
    throw new Error("请先选择播放设备");
  }
  return {
    account_id: state.currentAccountId,
    device_id: state.currentDeviceId,
  };
}

/**
 * 播放指令去重窗口（songloft-org/songloft#449）。
 * playerCommand 的 playerBusy 只覆盖请求在途期间：它在 refreshPlayerStatus 走完就释放，
 * 紧随其后的同一个播放意图（一次点击触发两个事件，或用户手抖点了两下）照样发得出去，
 * 结果是同一首歌在一两秒内向音箱连推两次 play-music。这种重复下发没有意义，丢掉后一次。
 */
const PLAY_DEDUP_WINDOW_MS = 1500;
let lastPlayIntentKey = "";
let lastPlayIntentAt = 0;

async function runPlayIntent(
  key: string,
  run: () => Promise<void>,
): Promise<void> {
  const now = Date.now();
  if (
    key === lastPlayIntentKey &&
    now - lastPlayIntentAt < PLAY_DEDUP_WINDOW_MS
  )
    return;
  lastPlayIntentKey = key;
  lastPlayIntentAt = now;
  try {
    await run();
  } catch (error) {
    // 下发失败不该连用户紧接着的重试一起吞掉
    lastPlayIntentKey = "";
    throw error;
  }
}

export async function playSong(
  song: Song,
  visibleIndex?: number,
): Promise<void> {
  if (!state.selectedPlaylistId) throw new Error("请先选择歌单");
  const fallbackIndex = state.songs.findIndex((item) => item.id === song.id);
  await runPlayIntent(
    `song:${state.selectedPlaylistId}:${song.id}`,
    async () => {
      await playerCommand("/player/play", {
        ...targetBody(),
        playlist_id: Number(state.selectedPlaylistId),
        song_id: song.id,
        start_index: fallbackIndex >= 0 ? fallbackIndex : visibleIndex || 0,
        play_mode: state.player.play_mode || "order",
      });
      void refreshPlaylistProgress();
    },
  );
}

/**
 * 从本歌单上次播到的那首继续播放。
 * 起点由后端按「设备 × 歌单」的进度表算（按歌曲 ID 定位，歌单顺序变了也不会串歌），
 * 前端不传 song_id / start_index，避免两边各算一次口径不一致。
 */
export async function resumePlaylist(): Promise<void> {
  if (!state.selectedPlaylistId) throw new Error("请先选择歌单");
  await runPlayIntent(`resume:${state.selectedPlaylistId}`, async () => {
    await playerCommand("/player/play", {
      ...targetBody(),
      playlist_id: Number(state.selectedPlaylistId),
      start_position: "resume",
      play_mode: state.player.play_mode || "order",
    });
    void refreshPlaylistProgress();
  });
}

export async function playerCommand(
  path: string,
  body: Record<string, unknown> = {},
): Promise<boolean> {
  if (state.playerBusy) return false;
  const ttsText =
    path === "/mina/tts" && typeof body.text === "string"
      ? body.text.trim()
      : undefined;
  state.playerBusy = true;
  try {
    await post(path, { ...targetBody(), ...body });
    if (ttsText) addOperation("文字播报已发送", true, ttsText);
    try {
      requestStatusRefresh();
    } catch (error) {
      // 指令已被接受，状态连接异常时继续通过 HTTP 刷新。
      console.warn("[miot] status refresh request failed", messageOf(error));
    }
    await refreshPlayerStatus();
    return true;
  } catch (error) {
    const message = messageOf(error);
    addOperation(message, false, ttsText);
    notify(message, "error");
    throw error;
  } finally {
    state.playerBusy = false;
  }
}

export async function setPlayMode(mode: PlayMode): Promise<void> {
  await playerCommand("/player/mode", { play_mode: mode });
}

export async function setPlaybackSpeed(speed: number): Promise<void> {
  await playerCommand("/player/speed", { speed });
}

export async function seekPlayer(position: number): Promise<void> {
  const duration = Number(state.player.duration || 0);
  if (duration <= 0) return;
  const normalized = Math.max(
    0,
    Math.min(Math.max(0, duration - 3), Math.round(position)),
  );
  state.player.position = normalized;
  await playerCommand("/player/seek", { position: normalized });
}

export async function setVolume(volume: number): Promise<void> {
  const normalized = Math.max(0, Math.min(100, Math.round(volume)));
  state.player.volume = normalized;
  volumeSetAt = Date.now();
  try {
    await post("/mina/volume", { ...targetBody(), volume: normalized });
    requestStatusRefresh();
  } catch (error) {
    notify(messageOf(error), "error");
  }
}

export async function refreshPlayerStatus(): Promise<void> {
  if (!state.currentAccountId || !state.currentDeviceId) return;
  if (statusRequestBusy) return;
  statusRequestBusy = true;
  const generation = statusRequestGeneration;
  if (state.playerStatusState !== "ready") state.playerStatusState = "loading";
  try {
    const status = await get<PlayerStatus>(
      `/player/status${query({
        account_id: state.currentAccountId,
        device_id: state.currentDeviceId,
      })}`,
    );
    if (generation === statusRequestGeneration) applyPlayerStatus(status);
  } catch (error) {
    if (generation === statusRequestGeneration && !state.statusConnected) {
      state.playerStatusState = "error";
      console.warn("[miot] status refresh failed", messageOf(error));
    }
  } finally {
    if (generation === statusRequestGeneration) statusRequestBusy = false;
  }
}

let volumeSetAt = 0;
const VOLUME_GRACE_MS = 3000;

function applyPlayerStatus(incoming: PlayerStatus): void {
  state.playerStatusState = "ready";
  if (volumeSetAt && Date.now() - volumeSetAt < VOLUME_GRACE_MS) {
    incoming = { ...incoming, volume: state.player.volume };
  }
  state.player = incoming;
}

let statusLifecycle: (() => void) | undefined;
let statusSocket: WebSocket | null = null;
let statusReconnect: ReturnType<typeof setTimeout> | null = null;
let statusPoll: ReturnType<typeof setInterval> | null = null;
let statusOpenTimer: ReturnType<typeof setTimeout> | null = null;
let statusAttempts = 0;
let statusManualClose = false;
let appVisible = true;
export function setAppVisible(visible: boolean) {
  appVisible = visible;
}
let statusRequestBusy = false;
// 恢复、切设备或卸载后，旧 HTTP 请求的结果和 finally 都不能影响新一轮请求。
let statusRequestGeneration = 0;
// 每次开连自增。一次断线可能同时打到 onerror 和 onclose，用它保证回收只做一遍，
// 免得重连退避的 statusAttempts 被多加一次。
let statusSocketGen = 0;

// close 必须带关闭码：本地 close 不带码时，部分实现会把 closeCode 留成 null 并在
// 派发 close 事件时抛空指针，导致 onclose 永不触发、状态流静默停更
// （songloft-org/songloft-plugin-miot#96）。带上码之后各条赋值路径都非空了。
const STATUS_CLOSE_CODE = 1000;
const STATUS_CLOSE_REASON = "client";
// 开连后这么久还没 onopen 就先把轮询顶上，别让「连不上」等于「没状态」。
// 真连上时 onopen 会把轮询清掉。
const STATUS_OPEN_TIMEOUT_MS = 8000;

function resetStatusRequests(): void {
  statusRequestGeneration += 1;
  statusRequestBusy = false;
}

function resumeStatusStream(): void {
  if (statusManualClose || !state.currentAccountId || !state.currentDeviceId)
    return;
  // 后台断网可能留下 readyState=OPEN 的旧连接，且不触发 error/close。
  // 恢复可见或网络恢复时主动换连接，HTTP 快照不必等待握手完成（songloft-org/songloft#493）。
  if (statusReconnect) clearTimeout(statusReconnect);
  statusReconnect = null;
  statusAttempts = 0;
  resetStatusRequests();
  abandonStatusSocket(statusSocketGen, false);
  openStatusSocket();
  void refreshPlayerStatus();
}

function startStatusPolling() {
  if (statusPoll) return;
  void refreshPlayerStatus();
  statusPoll = setInterval(() => void refreshPlayerStatus(), 5000);
}

function scheduleStatusReconnect() {
  if (statusManualClose || statusReconnect) return;
  const delay = Math.min(1000 * 2 ** statusAttempts, 15000);
  statusAttempts += 1;
  statusReconnect = setTimeout(() => {
    statusReconnect = null;
    openStatusSocket();
  }, delay);
}

function clearStatusOpenTimer() {
  if (statusOpenTimer) clearTimeout(statusOpenTimer);
  statusOpenTimer = null;
}

/** 回收当前 socket。`recover` 为真时按退避重连，并先让轮询顶上。 */
function abandonStatusSocket(gen: number, recover: boolean) {
  if (gen !== statusSocketGen) return;
  statusSocketGen += 1;
  clearStatusOpenTimer();
  const socket = statusSocket;
  statusSocket = null;
  state.statusConnected = false;
  // 读实例上的常量，不读 `WebSocket.CLOSED`：部分宿主环境的 WebSocket 实现只在
  // 构造函数里把 readyState 常量挂到实例上、类上没有静态同名成员。
  if (socket && socket.readyState !== socket.CLOSED) {
    try {
      socket.close(STATUS_CLOSE_CODE, STATUS_CLOSE_REASON);
    } catch {
      // 已经关掉、或根本没连上，都不影响下面的回落。
    }
  }
  if (recover && !statusManualClose) {
    startStatusPolling();
    scheduleStatusReconnect();
  }
}

function openStatusSocket() {
  if (
    !state.currentAccountId ||
    !state.currentDeviceId ||
    typeof WebSocket === "undefined"
  ) {
    startStatusPolling();
    return;
  }
  if (statusSocket) abandonStatusSocket(statusSocketGen, false);
  const gen = statusSocketGen;
  try {
    statusSocket = new WebSocket(
      pluginWebSocketUrl(
        `/status/ws${query({
          account_id: state.currentAccountId,
          device_id: state.currentDeviceId,
        })}`,
      ),
    );
    statusSocket.onopen = () => {
      if (gen !== statusSocketGen) return;
      clearStatusOpenTimer();
      state.statusConnected = true;
      statusAttempts = 0;
      if (statusPoll) clearInterval(statusPoll);
      statusPoll = null;
    };
    statusSocket.onmessage = (event) => {
      if (gen !== statusSocketGen) return;
      try {
        const frame = JSON.parse(String(event.data));
        if (frame?.type === "status" && frame.data)
          applyPlayerStatus(frame.data);
      } catch {
        // Ignore malformed frames; the next valid status replaces them.
      }
    };
    // 恢复动作必须在 onerror 里自己做完，不能 `close()` 一下等 onclose 收尾：
    // 部分实现的连接失败只发 error、不发 close，close() 也可能落在「未连接」分支
    // 不产生任何事件 —— 于是 onclose 永不触发，既不重连也不回落轮询。
    statusSocket.onerror = () => abandonStatusSocket(gen, true);
    statusSocket.onclose = () => abandonStatusSocket(gen, true);
    clearStatusOpenTimer();
    statusOpenTimer = setTimeout(() => {
      statusOpenTimer = null;
      if (gen !== statusSocketGen || state.statusConnected) return;
      startStatusPolling();
    }, STATUS_OPEN_TIMEOUT_MS);
  } catch {
    abandonStatusSocket(gen, true);
  }
}

export function connectStatusStream(): void {
  disconnectStatusStream();
  state.playerStatusState = "unknown";
  statusManualClose = !appVisible;
  statusAttempts = 0;
  statusLifecycle = onPush((event, data) => {
    if (event !== "lifecycle") return;
    const lifecycle = JSON.parse(String(data)).state;
    if (lifecycle === "resumed") {
      appVisible = true;
      statusManualClose = false;
      resumeStatusStream();
    } else if (lifecycle === "paused") {
      appVisible = false;
      statusManualClose = true;
      resetStatusRequests();
      if (statusReconnect) clearTimeout(statusReconnect);
      if (statusPoll) clearInterval(statusPoll);
      statusReconnect = null;
      statusPoll = null;
      abandonStatusSocket(statusSocketGen, false);
    }
  });
  if (appVisible) openStatusSocket();
}

export function requestStatusRefresh(): void {
  // 同上：读实例上的常量比对 readyState，类上的静态成员在部分宿主环境是 undefined。
  if (statusSocket && statusSocket.readyState === statusSocket.OPEN) {
    statusSocket.send(JSON.stringify({ type: "refresh" }));
  }
}

export function disconnectStatusStream(): void {
  statusManualClose = true;
  statusLifecycle?.();
  statusLifecycle = undefined;
  resetStatusRequests();
  if (statusReconnect) clearTimeout(statusReconnect);
  if (statusPoll) clearInterval(statusPoll);
  statusReconnect = null;
  statusPoll = null;
  abandonStatusSocket(statusSocketGen, false);
}

export async function loadGroups(): Promise<void> {
  state.groups = (await get<DeviceGroup[]>("/groups")) || [];
}

export async function saveGroup(
  group: Pick<DeviceGroup, "name" | "members"> & { id?: string },
) {
  if (group.id) await post("/groups/update", group);
  else await post("/groups", group);
  await loadGroups();
  notify("设备分组已保存", "success");
}

export async function deleteGroup(id: string) {
  await del(`/groups${query({ id })}`);
  await loadGroups();
  notify("设备分组已删除", "success");
}

export async function loadSchedules(): Promise<void> {
  const result = await get<{ enabled: boolean; tasks: ScheduledTask[] }>(
    "/schedules",
  );
  state.schedules = Array.isArray(result?.tasks) ? result.tasks : [];
  state.config.scheduled_tasks_enabled = !!result?.enabled;
}

export async function saveSchedule(task: ScheduledTask): Promise<void> {
  if (task.id) await post("/schedules/update", task);
  else await post("/schedules", task);
  await loadSchedules();
  notify("定时任务已保存", "success");
}

export async function toggleSchedule(
  task: ScheduledTask,
  enabled: boolean,
): Promise<void> {
  await post("/schedules/toggle", { id: task.id, enabled });
  task.enabled = enabled;
}

export async function deleteSchedule(id: string): Promise<void> {
  await del(`/schedules${query({ id })}`);
  await loadSchedules();
}

export async function loadScheduleLogs(): Promise<void> {
  const result = await get<{ logs: ScheduleLog[] }>("/schedules/logs?limit=50");
  state.scheduleLogs = result.logs || [];
}

export async function loadVoiceData(): Promise<void> {
  const [commands, conversation, webhooks, index] = await Promise.all([
    get<{ enabled: boolean; commands: VoiceCommand[] }>("/voice-commands"),
    get<Record<string, unknown>>("/conversation/status").catch(() => null),
    get<Webhook[]>("/conversation/webhooks").catch(() => []),
    get<IndexStatus>("/indexing/status").catch(() => ({})),
  ]);
  state.voiceCommands = Array.isArray(commands?.commands)
    ? commands.commands
    : [];
  state.config.voice_command_enabled = !!commands?.enabled;
  state.conversationStatus =
    conversation && typeof conversation === "object" ? conversation : null;
  state.webhooks = Array.isArray(webhooks) ? webhooks : [];
  state.indexStatus = index && typeof index === "object" ? index : {};
}

export async function saveVoiceCommands(
  commands = state.voiceCommands,
): Promise<void> {
  await post("/voice-commands", { commands });
  state.voiceCommands = commands;
  notify("语音口令已保存", "success");
}

export async function loadConversationMessages(): Promise<void> {
  state.conversationMessages =
    (await get<ConversationMessage[]>("/conversation/messages?limit=50")) || [];
}

export async function addWebhook(name: string, url: string): Promise<void> {
  await post("/conversation/webhooks", { name, url });
  state.webhooks = await get<Webhook[]>("/conversation/webhooks");
}

export async function deleteWebhook(id: string): Promise<void> {
  await del(`/conversation/webhooks${query({ id })}`);
  state.webhooks = await get<Webhook[]>("/conversation/webhooks");
}

export async function refreshIndex(): Promise<void> {
  await post("/indexing/refresh");
  notify("索引刷新已开始", "success");
  setTimeout(async () => {
    state.indexStatus = await get<IndexStatus>("/indexing/status").catch(
      () => state.indexStatus,
    );
  }, 1500);
}

export async function loadMemory(): Promise<void> {
  const [stats, entities, ambiguous] = await Promise.all([
    get<MemoryStats>("/memory/stats"),
    get<{
      stats: MemoryStats;
      entities: MemoryEntity[];
      unclassified: Array<Record<string, unknown>>;
    }>("/memory/entities"),
    get<{ records: Array<Record<string, unknown>> }>("/memory/ambiguous"),
  ]);
  state.memoryStats = stats && typeof stats === "object" ? stats : {};
  state.memoryEntities = Array.isArray(entities?.entities)
    ? entities.entities
    : [];
  state.memoryUnclassified = Array.isArray(entities?.unclassified)
    ? entities.unclassified
    : [];
  state.memoryAmbiguous = Array.isArray(ambiguous?.records)
    ? ambiguous.records
    : [];
}

export async function clearMemory(): Promise<void> {
  await del("/memory/all");
  await loadMemory();
  notify("语音记忆已清空", "success");
}

export async function loadSearchProviders(): Promise<void> {
  const result = await get<SearchProvider[] | { providers?: SearchProvider[] }>(
    "/search-providers",
  ).catch(() => []);
  state.searchProviders = Array.isArray(result)
    ? result
    : result.providers || [];
}

/** 从 AI provider 拉取模型列表（同时预检 API 连通性） */
export async function loadAiModels(): Promise<void> {
  state.aiModelLoading = true;
  state.aiModelError = "";
  try {
    const resp = await get<{
      models: Array<{ id: string; ownedBy?: string }>;
      modelCount: number;
    }>("/voice-commands/models");
    state.aiModels = resp?.models || [];
  } catch (error) {
    state.aiModels = [];
    state.aiModelError = messageOf(error);
    throw error;
  } finally {
    state.aiModelLoading = false;
  }
}

export async function refreshAll(): Promise<void> {
  if (state.refreshing) return;
  state.refreshing = true;
  try {
    await Promise.all([
      loadConfig(),
      loadAccountsAndDevices(),
      loadPlaylists(),
      loadGroups(),
    ]);
    savedConfig = configFingerprint();
    connectStatusStream();
    await refreshPlayerStatus();
    notify("内容已刷新", "success");
  } catch (error) {
    notify(messageOf(error), "error");
  } finally {
    state.refreshing = false;
  }
}

export async function initialize(): Promise<void> {
  state.loading = true;
  state.startupError = "";
  try {
    await Promise.all([loadConfig(), loadPlaylists()]);
    savedConfig = configFingerprint();
    state.initialized = true;
  } catch (error) {
    state.startupError = messageOf(error);
    return;
  } finally {
    state.loading = false;
  }
  connectDevicesInBackground();
}

async function connectDevicesInBackground(): Promise<void> {
  state.deviceConnecting = true;
  try {
    await Promise.all([loadAccountsAndDevices(), loadGroups()]);
    connectStatusStream();
    await refreshPlayerStatus();
    await selectCurrentPlaylistOnEntry();
  } catch (error) {
    notify(messageOf(error), "error");
  } finally {
    state.deviceConnecting = false;
  }
}

export function disposeStore(): void {
  clearTimeout(songSearchTimer);
  songRequest++;
  disconnectStatusStream();
  if (snackbarTimer) clearTimeout(snackbarTimer);
  state.confirm.resolve?.({ confirmed: false, checked: false });
}

export { messageOf };
