import { computed, reactive } from 'vue';
import { del, get, messageOf, pluginWebSocketUrl, post, query } from './api';
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
} from './types';

const defaultConfig: MiotConfig = {
  server_host: '',
  server_host_status: 'empty',
  suggested_addresses: [],
  conversation_monitor_enabled: false,
  conversation_poll_interval: 1,
  conversation_poll_debug: false,
  voice_command_enabled: false,
  voice_memory_enabled: true,
  voice_memory_max_records: 100,
  scheduled_tasks_enabled: false,
  timezone: 'Asia/Shanghai',
  force_mp3: false,
  radio_force_mp3: false,
  volume_normalize: false,
  song_transition_offset: 0,
  max_song_index: 10000,
  external_search_enabled: false,
  external_search_url: '',
  external_search_token: '',
  external_search_sources: [],
  external_search_playlist_id: '',
  external_search_timeout: 6,
  external_search_no_import: false,
  search_priority: 'parallel',
  extra_music_api_models: [],
  indicator_light_enabled: false,
  interrupt_tts_hint_enabled: false,
  interrupt_tts_hint_text: '正在搜索，请稍候',
  play_announcement_enabled: false,
  play_announcement_template: '即将播放{artist}的{song}',
  play_announcement_wait_mode: 'auto',
  play_announcement_delay: 3,
  play_announcement_scope: 'voice',
  smart_resume_timeout: 30,
  default_cover_id: '',
  touchscreen_lyrics_enabled: false,
  ai_config: {},
};

export interface SnackbarState {
  text: string;
  kind: 'info' | 'success' | 'warning' | 'error';
  token: number;
}

export interface ConfirmState {
  open: boolean;
  title: string;
  message: string;
  confirmText: string;
  dangerous: boolean;
  resolve?: (value: boolean) => void;
}

export const state = reactive({
  initialized: false,
  loading: true,
  startupError: '',
  deviceConnecting: false,
  refreshing: false,
  config: { ...defaultConfig } as MiotConfig,
  configLoaded: false,
  configSaving: false,
  accounts: [] as Account[],
  devices: [] as AccountDevices[],
  groups: [] as DeviceGroup[],
  currentAccountId: '',
  currentDeviceId: '',
  playlists: [] as Playlist[],
  selectedPlaylistId: '',
  songs: [] as Song[],
  songsLoading: false,
  songsError: '',
  songSearch: '',
  // 当前设备在当前所选歌单上次播到哪一首。切歌单/切设备都要重取：进度是按
  // 「设备 × 歌单」记的，换任一维度都是另一条记录。
  playlistProgress: null as PlaylistProgress | null,
  player: {} as PlayerStatus,
  playerBusy: false,
  statusConnected: false,
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
  aiModelError: '' as string,
  snackbar: null as SnackbarState | null,
  confirm: {
    open: false,
    title: '',
    message: '',
    confirmText: '确定',
    dangerous: false,
  } as ConfirmState,
  operationLog: [] as Array<{ time: string; message: string; success: boolean }>,
});

export function deviceId(device: Device): string {
  return String(device.device_id || device.deviceID || device.id || '');
}

export function deviceName(device: Device): string {
  return device.name || device.alias || '未命名设备';
}

// 歌单选项统一显示成「名称 (歌曲数)」。数量直接来自后端 /playlists 的 song_count，
// 用户靠它比对新导入的歌曲有没有真的入库（songloft-org/songloft-plugin-miot#79）。
export function playlistLabel(playlist: Playlist): string {
  return `${playlist.name} (${playlist.song_count ?? 0})`;
}

export const currentDevice = computed(() => {
  const account = state.devices.find((item) => item.account_id === state.currentAccountId);
  return account?.devices.find((device) => deviceId(device) === state.currentDeviceId) || null;
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
  const keyword = state.songSearch.trim().toLocaleLowerCase('zh-CN');
  if (!keyword) return state.songs;
  return state.songs.filter((song) =>
    [song.title, song.artist, song.album]
      .filter(Boolean)
      .some((value) => String(value).toLocaleLowerCase('zh-CN').includes(keyword)),
  );
});

let snackbarTimer: ReturnType<typeof setTimeout> | null = null;
let snackbarToken = 0;
export function notify(
  text: string,
  kind: SnackbarState['kind'] = 'info',
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

export function addOperation(message: string, success: boolean): void {
  state.operationLog.unshift({ time: new Date().toLocaleTimeString(), message, success });
  state.operationLog.splice(30);
}

export function confirmAction(
  title: string,
  message: string,
  confirmText = '确定',
  dangerous = false,
): Promise<boolean> {
  return new Promise((resolve) => {
    state.confirm = { open: true, title, message, confirmText, dangerous, resolve };
  });
}

export function resolveConfirm(value: boolean): void {
  state.confirm.resolve?.(value);
  state.confirm.open = false;
  state.confirm.resolve = undefined;
}

export async function loadConfig(): Promise<void> {
  const config = await get<MiotConfig>('/config');
  // Normalize nullable fields before touching the reactive object. WebF can render
  // between individual assignments, so never expose transient null arrays.
  const normalized: MiotConfig = {
    ...defaultConfig,
    ...(config || {}),
    suggested_addresses: Array.isArray(config?.suggested_addresses) ? config.suggested_addresses : [],
    external_search_sources: Array.isArray(config?.external_search_sources) ? config.external_search_sources : [],
    extra_music_api_models: Array.isArray(config?.extra_music_api_models) ? config.extra_music_api_models : [],
    ai_config: config?.ai_config && typeof config.ai_config === 'object' ? { ...config.ai_config } : {},
  };
  Object.assign(state.config, normalized);
  state.configLoaded = true;
}

let savedConfig = '';
let pendingConfigPatch: Partial<MiotConfig> | null = null;
let configSavePromise: Promise<void> | null = null;
function configFingerprint(): string {
  return JSON.stringify(state.config);
}

export async function saveConfig(patch: Partial<MiotConfig>): Promise<void> {
  Object.assign(state.config, patch);
  const fingerprint = configFingerprint();
  if (fingerprint === savedConfig && !configSavePromise) return;
  pendingConfigPatch = { ...(pendingConfigPatch || {}), ...patch };
  if (configSavePromise) return configSavePromise;

  state.configSaving = true;
  configSavePromise = (async () => {
    try {
      while (pendingConfigPatch) {
        const nextPatch = pendingConfigPatch;
        pendingConfigPatch = null;
        await post('/config', nextPatch);
        savedConfig = configFingerprint();
      }
      notify('设置已保存', 'success');
    } catch (error) {
      pendingConfigPatch = null;
      notify(messageOf(error), 'error');
      throw error;
    } finally {
      state.configSaving = false;
      configSavePromise = null;
    }
  })();
  return configSavePromise;
}

export async function loadAccountsAndDevices(): Promise<void> {
  const [accounts, devices] = await Promise.all([
    get<Account[]>('/auth/status'),
    get<AccountDevices[]>('/mina/devices'),
  ]);
  state.accounts = accounts || [];
  state.devices = devices || [];
  ensureCurrentDevice();
}

function ensureCurrentDevice(): void {
  const currentExists = state.devices.some(
    (account) =>
      account.account_id === state.currentAccountId &&
      account.devices.some((device) => deviceId(device) === state.currentDeviceId),
  );
  if (currentExists) return;
  for (const account of state.devices) {
    const selected =
      account.devices.find((device) => deviceId(device) === account.last_selected_device_id) ||
      account.devices.find((device) => device.managed) ||
      account.devices[0];
    if (selected) {
      state.currentAccountId = account.account_id;
      state.currentDeviceId = deviceId(selected);
      return;
    }
  }
  state.currentAccountId = '';
  state.currentDeviceId = '';
}

let selectionRevision = 0;
export async function selectDevice(accountId: string, selectedDeviceId: string): Promise<void> {
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
    await post('/mina/last_selection', { account_id: accountId, device_id: selectedDeviceId });
    if (revision === selectionRevision) await refreshPlayerStatus();
  } catch (error) {
    if (revision === selectionRevision) notify(messageOf(error), 'error');
  }
}

export async function toggleManaged(accountId: string, selectedDeviceId: string, managed: boolean) {
  await post('/mina/device/managed', {
    account_id: accountId,
    device_id: selectedDeviceId,
    managed,
  });
  const account = state.devices.find((item) => item.account_id === accountId);
  const device = account?.devices.find((item) => deviceId(item) === selectedDeviceId);
  if (device) device.managed = managed;
  notify(managed ? '已启用设备管理' : '已停用设备管理', 'success');
}

export async function loadPlaylists(): Promise<void> {
  state.playlists = (await get<Playlist[]>('/playlists')) || [];
  if (
    state.selectedPlaylistId &&
    !state.playlists.some((playlist) => String(playlist.id) === state.selectedPlaylistId)
  ) {
    state.selectedPlaylistId = '';
    state.songs = [];
  }
}

let songRequest = 0;
export async function selectPlaylist(playlistId: string): Promise<void> {
  state.selectedPlaylistId = playlistId;
  state.songSearch = '';
  state.songs = [];
  state.songsError = '';
  state.playlistProgress = null;
  if (!playlistId) return;
  songRequest += 1;
  const request = songRequest;
  state.songsLoading = true;
  // 不等它：进度只是辅助信息（标记上次播放的那首、亮起「继续播放」），
  // 不该把歌曲列表的加载卡在它后面
  void refreshPlaylistProgress();
  try {
    const songs = await get<Song[]>(`/playlists/${encodeURIComponent(playlistId)}/songs`);
    if (request === songRequest) state.songs = songs || [];
  } catch (error) {
    if (request === songRequest) state.songsError = messageOf(error);
  } finally {
    if (request === songRequest) state.songsLoading = false;
  }
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
    const matchedById = statusPlaylistId === undefined
      ? undefined
      : state.playlists.find((playlist) => String(playlist.id) === String(statusPlaylistId));
    const matched = matchedById || (
      state.player.playlist_name
        ? state.playlists.find((playlist) => playlist.name === state.player.playlist_name)
        : undefined
    );
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
    throw new Error('请先选择播放设备');
  }
  return { account_id: state.currentAccountId, device_id: state.currentDeviceId };
}

/**
 * 播放指令去重窗口（songloft-org/songloft#449）。
 * playerCommand 的 playerBusy 只覆盖请求在途期间：它在 refreshPlayerStatus 走完就释放，
 * 紧随其后的同一个播放意图（一次点击触发两个事件，或用户手抖点了两下）照样发得出去，
 * 结果是同一首歌在一两秒内向音箱连推两次 play-music。这种重复下发没有意义，丢掉后一次。
 */
const PLAY_DEDUP_WINDOW_MS = 1500;
let lastPlayIntentKey = '';
let lastPlayIntentAt = 0;

async function runPlayIntent(key: string, run: () => Promise<void>): Promise<void> {
  const now = Date.now();
  if (key === lastPlayIntentKey && now - lastPlayIntentAt < PLAY_DEDUP_WINDOW_MS) return;
  lastPlayIntentKey = key;
  lastPlayIntentAt = now;
  try {
    await run();
  } catch (error) {
    // 下发失败不该连用户紧接着的重试一起吞掉
    lastPlayIntentKey = '';
    throw error;
  }
}

export async function playSong(song: Song, visibleIndex?: number): Promise<void> {
  if (!state.selectedPlaylistId) throw new Error('请先选择歌单');
  const fallbackIndex = state.songs.findIndex((item) => item.id === song.id);
  await runPlayIntent(`song:${state.selectedPlaylistId}:${song.id}`, async () => {
    await playerCommand('/player/play', {
      ...targetBody(),
      playlist_id: Number(state.selectedPlaylistId),
      song_id: song.id,
      start_index: fallbackIndex >= 0 ? fallbackIndex : visibleIndex || 0,
      play_mode: state.player.play_mode || 'order',
    });
    void refreshPlaylistProgress();
  });
}

/**
 * 从本歌单上次播到的那首继续播放。
 * 起点由后端按「设备 × 歌单」的进度表算（按歌曲 ID 定位，歌单顺序变了也不会串歌），
 * 前端不传 song_id / start_index，避免两边各算一次口径不一致。
 */
export async function resumePlaylist(): Promise<void> {
  if (!state.selectedPlaylistId) throw new Error('请先选择歌单');
  await runPlayIntent(`resume:${state.selectedPlaylistId}`, async () => {
    await playerCommand('/player/play', {
      ...targetBody(),
      playlist_id: Number(state.selectedPlaylistId),
      start_position: 'resume',
      play_mode: state.player.play_mode || 'order',
    });
    void refreshPlaylistProgress();
  });
}

export async function playerCommand(path: string, body: Record<string, unknown> = {}): Promise<void> {
  if (state.playerBusy) return;
  state.playerBusy = true;
  try {
    await post(path, { ...targetBody(), ...body });
    requestStatusRefresh();
    await refreshPlayerStatus();
  } catch (error) {
    const message = messageOf(error);
    addOperation(message, false);
    notify(message, 'error');
    throw error;
  } finally {
    state.playerBusy = false;
  }
}

export async function setPlayMode(mode: PlayMode): Promise<void> {
  await playerCommand('/player/mode', { play_mode: mode });
}

export async function setPlaybackSpeed(speed: number): Promise<void> {
  await playerCommand('/player/speed', { speed });
}

export async function seekPlayer(position: number): Promise<void> {
  const duration = Number(state.player.duration || 0);
  if (duration <= 0) return;
  const normalized = Math.max(0, Math.min(Math.max(0, duration - 3), Math.round(position)));
  state.player.position = normalized;
  await playerCommand('/player/seek', { position: normalized });
}

export async function setVolume(volume: number): Promise<void> {
  const normalized = Math.max(0, Math.min(100, Math.round(volume)));
  state.player.volume = normalized;
  volumeSetAt = Date.now();
  try {
    await post('/mina/volume', { ...targetBody(), volume: normalized });
    requestStatusRefresh();
  } catch (error) {
    notify(messageOf(error), 'error');
  }
}

export async function refreshPlayerStatus(): Promise<void> {
  if (!state.currentAccountId || !state.currentDeviceId) return;
  if (statusRequestBusy) return;
  statusRequestBusy = true;
  try {
    const status = await get<PlayerStatus>(
      `/player/status${query({
        account_id: state.currentAccountId,
        device_id: state.currentDeviceId,
      })}`,
    );
    applyPlayerStatus(status);
  } catch (error) {
    if (!state.statusConnected) console.warn('[miot] status refresh failed', messageOf(error));
  } finally {
    statusRequestBusy = false;
  }
}

let volumeSetAt = 0;
const VOLUME_GRACE_MS = 3000;

function applyPlayerStatus(incoming: PlayerStatus): void {
  if (volumeSetAt && Date.now() - volumeSetAt < VOLUME_GRACE_MS) {
    incoming = { ...incoming, volume: state.player.volume };
  }
  state.player = incoming;
}

let statusSocket: WebSocket | null = null;
let statusReconnect: ReturnType<typeof setTimeout> | null = null;
let statusPoll: ReturnType<typeof setInterval> | null = null;
let statusOpenTimer: ReturnType<typeof setTimeout> | null = null;
let statusAttempts = 0;
let statusManualClose = false;
let statusRequestBusy = false;
// 每次开连自增。一次断线可能同时打到 onerror 和 onclose，用它保证回收只做一遍，
// 免得重连退避的 statusAttempts 被多加一次。
let statusSocketGen = 0;

// close 必须带关闭码。webf 0.24.27 的 websocket.dart:145 派发 close 事件时写的是
// `client.closeCode!`，而本地 close 不带码时 dart:io 会把它留成 null
// （websocket_impl.dart:1362 只赋传入的 code，1375 那个「5 秒等不到对端 close 帧」
// 的兜底再把 null 抄给 closeCode），弱网断线于是抛 Null check operator used on a
// null value。它抛在 _listen 的 onDone 里，后面派发 close 事件和清 map 的代码全部
// 跳过 —— JS 侧 onclose 永不触发，既不重连也不回落轮询，状态流静默停更
// （songloft-org/songloft-plugin-miot#96 第 4 条日志里那两次 PlatformError）。
// 带上码之后 closeCode 的三条赋值路径就都非空了。
const STATUS_CLOSE_CODE = 1000;
const STATUS_CLOSE_REASON = 'client';
// 开连后这么久还没 onopen 就先把轮询顶上，别让「连不上」等于「没状态」。
// 真连上时 onopen 会把轮询清掉。
const STATUS_OPEN_TIMEOUT_MS = 8000;

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
  // 读实例上的常量，不读 `WebSocket.CLOSED`：WebF 的 WebSocket 是 JS polyfill
  // （webf `bridge/polyfill/src/websocket.ts`），四个 readyState 常量只在构造函数里
  // 挂到实例上，类上**没有**静态同名成员，`WebSocket.CLOSED` 在 WebF 里是 undefined。
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
  if (!state.currentAccountId || !state.currentDeviceId || typeof WebSocket === 'undefined') {
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
        if (frame?.type === 'status' && frame.data) applyPlayerStatus(frame.data);
      } catch {
        // Ignore malformed frames; the next valid status replaces them.
      }
    };
    // 恢复动作必须在 onerror 里自己做完，不能像旧写法那样 `close()` 一下等 onclose 收尾：
    // WebF 的连接失败只发 error、不发 close（真实浏览器两者都发，close 才是恢复入口），
    // 而那一下 close() 落到 webf 的「has not connect」分支，不产生任何事件 ——
    // 于是 onclose 永不触发，既不重连也不回落轮询，状态永久停在最后一帧。
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
  statusManualClose = false;
  statusAttempts = 0;
  openStatusSocket();
}

export function requestStatusRefresh(): void {
  // 同上：`WebSocket.OPEN` 在 WebF 里是 undefined，旧写法拿它比对 readyState 恒为 false
  // —— 这条「让服务端立刻推一帧状态」的请求在客户端里从来没发出去过。
  if (statusSocket && statusSocket.readyState === statusSocket.OPEN) {
    statusSocket.send(JSON.stringify({ type: 'refresh' }));
  }
}

export function disconnectStatusStream(): void {
  statusManualClose = true;
  if (statusReconnect) clearTimeout(statusReconnect);
  if (statusPoll) clearInterval(statusPoll);
  statusReconnect = null;
  statusPoll = null;
  abandonStatusSocket(statusSocketGen, false);
}

export async function loadGroups(): Promise<void> {
  state.groups = (await get<DeviceGroup[]>('/groups')) || [];
}

export async function saveGroup(group: Pick<DeviceGroup, 'name' | 'members'> & { id?: string }) {
  if (group.id) await post('/groups/update', group);
  else await post('/groups', group);
  await loadGroups();
  notify('设备分组已保存', 'success');
}

export async function deleteGroup(id: string) {
  await del(`/groups${query({ id })}`);
  await loadGroups();
  notify('设备分组已删除', 'success');
}

export async function loadSchedules(): Promise<void> {
  const result = await get<{ enabled: boolean; tasks: ScheduledTask[] }>('/schedules');
  state.schedules = Array.isArray(result?.tasks) ? result.tasks : [];
  state.config.scheduled_tasks_enabled = !!result?.enabled;
}

export async function saveSchedule(task: ScheduledTask): Promise<void> {
  if (task.id) await post('/schedules/update', task);
  else await post('/schedules', task);
  await loadSchedules();
  notify('定时任务已保存', 'success');
}

export async function toggleSchedule(task: ScheduledTask, enabled: boolean): Promise<void> {
  await post('/schedules/toggle', { id: task.id, enabled });
  task.enabled = enabled;
}

export async function deleteSchedule(id: string): Promise<void> {
  await del(`/schedules${query({ id })}`);
  await loadSchedules();
}

export async function loadScheduleLogs(): Promise<void> {
  const result = await get<{ logs: ScheduleLog[] }>('/schedules/logs?limit=50');
  state.scheduleLogs = result.logs || [];
}

export async function loadVoiceData(): Promise<void> {
  const [commands, conversation, webhooks, index] = await Promise.all([
    get<{ enabled: boolean; commands: VoiceCommand[] }>('/voice-commands'),
    get<Record<string, unknown>>('/conversation/status').catch(() => null),
    get<Webhook[]>('/conversation/webhooks').catch(() => []),
    get<IndexStatus>('/indexing/status').catch(() => ({})),
  ]);
  state.voiceCommands = Array.isArray(commands?.commands) ? commands.commands : [];
  state.config.voice_command_enabled = !!commands?.enabled;
  state.conversationStatus = conversation && typeof conversation === 'object' ? conversation : null;
  state.webhooks = Array.isArray(webhooks) ? webhooks : [];
  state.indexStatus = index && typeof index === 'object' ? index : {};
}

export async function saveVoiceCommands(commands = state.voiceCommands): Promise<void> {
  await post('/voice-commands', { commands });
  state.voiceCommands = commands;
  notify('语音口令已保存', 'success');
}

export async function loadConversationMessages(): Promise<void> {
  state.conversationMessages =
    (await get<ConversationMessage[]>('/conversation/messages?limit=50')) || [];
}

export async function addWebhook(name: string, url: string): Promise<void> {
  await post('/conversation/webhooks', { name, url });
  state.webhooks = await get<Webhook[]>('/conversation/webhooks');
}

export async function deleteWebhook(id: string): Promise<void> {
  await del(`/conversation/webhooks${query({ id })}`);
  state.webhooks = await get<Webhook[]>('/conversation/webhooks');
}

export async function refreshIndex(): Promise<void> {
  await post('/indexing/refresh');
  notify('索引刷新已开始', 'success');
  setTimeout(async () => {
    state.indexStatus = await get<IndexStatus>('/indexing/status').catch(() => state.indexStatus);
  }, 1500);
}

export async function loadMemory(): Promise<void> {
  const [stats, entities, ambiguous] = await Promise.all([
    get<MemoryStats>('/memory/stats'),
    get<{ stats: MemoryStats; entities: MemoryEntity[]; unclassified: Array<Record<string, unknown>> }>(
      '/memory/entities',
    ),
    get<{ records: Array<Record<string, unknown>> }>('/memory/ambiguous'),
  ]);
  state.memoryStats = stats && typeof stats === 'object' ? stats : {};
  state.memoryEntities = Array.isArray(entities?.entities) ? entities.entities : [];
  state.memoryUnclassified = Array.isArray(entities?.unclassified) ? entities.unclassified : [];
  state.memoryAmbiguous = Array.isArray(ambiguous?.records) ? ambiguous.records : [];
}

export async function clearMemory(): Promise<void> {
  await del('/memory/all');
  await loadMemory();
  notify('语音记忆已清空', 'success');
}

export async function loadSearchProviders(): Promise<void> {
  const result = await get<SearchProvider[] | { providers?: SearchProvider[] }>('/search-providers').catch(() => []);
  state.searchProviders = Array.isArray(result) ? result : result.providers || [];
}

/** 从 AI provider 拉取模型列表（同时预检 API 连通性） */
export async function loadAiModels(): Promise<void> {
  state.aiModelLoading = true;
  state.aiModelError = '';
  try {
    const resp = await get<{ models: Array<{ id: string; ownedBy?: string }>; modelCount: number }>(
      '/voice-commands/models',
    );
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
    await Promise.all([loadConfig(), loadAccountsAndDevices(), loadPlaylists(), loadGroups()]);
    savedConfig = configFingerprint();
    connectStatusStream();
    await refreshPlayerStatus();
    notify('内容已刷新', 'success');
  } catch (error) {
    notify(messageOf(error), 'error');
  } finally {
    state.refreshing = false;
  }
}

export async function initialize(): Promise<void> {
  state.loading = true;
  state.startupError = '';
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
    notify(messageOf(error), 'error');
  } finally {
    state.deviceConnecting = false;
  }
}

export function disposeStore(): void {
  disconnectStatusStream();
  if (snackbarTimer) clearTimeout(snackbarTimer);
  state.confirm.resolve?.(false);
}

export { messageOf };
