import {
  createContext,
  memo,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "@lynx-js/react";
import { getTheme, onPush, onThemeChange } from "@songloft/lynx-plugin-sdk";
import { watch } from "@vue/reactivity";
import { CompactSettingsContext, themeColors } from "./ui/theme";
import { useObserved, useObservedFields, classes } from "./page-state";
import {
  consumeBack,
  closePage,
  installHostBack,
  navigation,
  notifyHostFavorite,
  openPage,
} from "./runtime";
import * as store from "./store";
import { get, post, query, messageOf } from "./api";
import { stopChatSocket, setChatVisible } from "./chat-stream";
import { Cover, CoverPlaceholder } from "./Cover";
import { useSongListScroll } from "./song-list-scroll";
import { createPlayerDetails } from "./player-details";
import { paletteFromMetadata } from "./player-palette";
import type { PlayMode, SleepTimerStatus, Song } from "./types";
import type { LyricLine } from "./lyrics";
import {
  SlIcon,
  SlEmptyState,
  SlStatusChip,
  SlButton,
  SlCheckbox,
  SlInput,
  SlSelect,
  SlSlider,
  VolumeControl,
} from "./ui/native";
import DeviceSettings from "./views/settings/DeviceSettings";
import PlaybackSettings from "./views/settings/PlaybackSettings";
import VoiceSettings from "./views/settings/VoiceSettings";
import AISettings from "./views/settings/AISettings";
import ScheduleSettings from "./views/settings/ScheduleSettings";
import ToolboxSettings from "./views/settings/ToolboxSettings";
import SleepTimerPanel from "./views/SleepTimerPanel";
import { Overlay } from "./ui/Overlay";
import { PopupMaterial } from "./ui/PopupMaterial";
import { ThemeContext } from "./ui/theme";
import { measurePopover, placePopover } from "./ui/position";
const { state, playerProgress } = store;
const libraryHeaderRow = {
  display: "flex",
  flexDirection: "row",
  alignItems: "center",
} as const;
const Viewport = createContext({
  locateSong: { current: null } as { current: (() => Promise<void>) | null },
  width: 390,
  height: 800,
});
const categories = [
  {
    id: "device",
    icon: "speaker_group",
    title: "设备",
    description: "服务器、账号和设备分组",
    component: DeviceSettings,
  },
  {
    id: "playback",
    icon: "music_note",
    title: "播放",
    description: "格式、音量和触屏显示",
    component: PlaybackSettings,
  },
  {
    id: "voice",
    icon: "record_voice_over",
    title: "语音",
    description: "监听、口令和搜索",
    component: VoiceSettings,
  },
  {
    id: "ai",
    icon: "auto_awesome",
    title: "AI 设置",
    description: "模型连接、口令分析、对话与记忆",
    component: AISettings,
  },
  {
    id: "schedule",
    icon: "schedule",
    title: "定时",
    description: "调度规则和执行日志",
    component: ScheduleSettings,
  },
  {
    id: "toolbox",
    icon: "construction",
    title: "工具箱",
    description: "URL、TTS 和操作结果",
    component: ToolboxSettings,
  },
];
const modes: Array<{ value: PlayMode; label: string; icon: string }> = [
  { value: "order", label: "顺序播放", icon: "format_list_numbered" },
  { value: "loop", label: "列表循环", icon: "repeat" },
  { value: "single", label: "单曲循环", icon: "repeat_one" },
  { value: "random", label: "随机播放", icon: "shuffle" },
  { value: "singlePlay", label: "单曲播放", icon: "looks_one" },
];
const run = (operation: () => Promise<unknown>) => {
  void operation().catch((error) => store.notify(messageOf(error), "error"));
};
const target = () => ({
  account_id: state.currentAccountId,
  device_id: state.currentDeviceId,
});
const categoryGroups = [
  categories.slice(0, 2),
  categories.slice(2, 4),
  categories.slice(4),
];

function duration(seconds = 0) {
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
}
function Modal({
  children,
  close,
  className,
  cardStyle,
  captureTarget,
  showClose = true,
}: any) {
  return (
    <Overlay>
      <view
        flatten={false}
        className={classes(["modal-mask", className])}
        catchtap={close}
      >
        <view
          flatten={false}
          className={classes(["modal-card", captureTarget && "popup-glass"])}
          style={cardStyle}
          catchtap={() => {}}
        >
          {captureTarget && <PopupMaterial captureTarget={captureTarget} />}
          {children}
          {showClose && <SlButton label="关闭" onClick={close} />}
        </view>
      </view>
    </Overlay>
  );
}
const menuRowHeight = 44;
const popupInsets = 18; // 8px vertical padding and a 1px border on both sides.

type MenuItem = {
  label: string;
  icon?: string;
  selected?: boolean;
  danger?: boolean;
  action: () => void;
};

function useAnchoredPanel(
  anchor: string | null,
  panelWidth: number,
  panelHeight: number,
  align: "end" | "center" = "end",
) {
  const { width, height } = useContext(Viewport);
  const [placement, setPlacement] = useState<{
    key: string;
    style: ReturnType<typeof placePopover>;
  } | null>(null);
  const key = JSON.stringify([
    anchor,
    width,
    height,
    panelWidth,
    panelHeight,
    align,
  ]);
  useEffect(() => {
    if (!anchor) {
      setPlacement(null);
      return;
    }
    let active = true;
    void measurePopover("#" + anchor, panelWidth, panelHeight, align)
      .catch(() =>
        placePopover(
          { left: 0, top: 0, width, height },
          {
            left: width - 56,
            top: Math.max(0, height - 56),
            width: 40,
            height: 40,
          },
          panelWidth,
          panelHeight,
          align,
        ),
      )
      .then((style) => {
        if (active) setPlacement({ key, style });
      });
    return () => {
      active = false;
    };
  }, [key]);
  return placement?.key === key ? placement.style : null;
}

function PopupMenu({
  anchor,
  panelWidth,
  items,
  className,
  captureTarget,
  close,
}: {
  anchor: string;
  panelWidth: number;
  items: MenuItem[];
  className?: string;
  captureTarget: string;
  close: () => void;
}) {
  const position = useAnchoredPanel(
    anchor,
    panelWidth,
    popupInsets + menuRowHeight * items.length,
  );
  if (!position) return null;
  return (
    <Modal
      className={classes(["popup-menu", className])}
      captureTarget={captureTarget}
      cardStyle={position}
      close={close}
      showClose={false}
    >
      <scroll-view
        className="popup-menu-scroll"
        style={{
          height: `${Math.max(1, parseFloat(position.height) - popupInsets)}px`,
        }}
        scroll-y
      >
        {items.map((item) => (
          <SlButton
            key={item.label}
            variant="text"
            title={item.label}
            className={classes([
              "popup-menu-item",
              item.selected && "popup-menu-selected",
              item.danger && "popup-menu-danger",
            ])}
            onClick={item.action}
          >
            {item.icon && <SlIcon name={item.icon} color="muted" size={18} />}
            <text className="popup-menu-label" text-maxline="1">
              {item.label}
            </text>
            {item.selected && <SlIcon name="check" size={18} />}
          </SlButton>
        ))}
      </scroll-view>
    </Modal>
  );
}

function SongListHeader() {
  return (
    <view className="song-list-header">
      <text className="song-index">#</text>
      <view className="song-header-cover" />
      <text className="song-header-title">标题</text>
      <text className="song-header-artist">艺术家</text>
      <text className="song-header-album">专辑</text>
      <text className="song-duration">时长</text>
      <view className="song-header-actions" />
    </view>
  );
}
type SongAction = { song: Song; playlistId: string };

const SongListRow = memo(function SongListRow({
  song,
  index,
  rowHeight,
  selected,
  playbackEnabled,
  playlistId,
  isVirtualPlaylist,
  setSongAction,
  web,
  narrow,
}: {
  song: Song;
  index: number;
  rowHeight: number;
  selected: boolean;
  playbackEnabled: boolean;
  playlistId: string;
  isVirtualPlaylist: boolean;
  setSongAction: (action: SongAction) => void;
  web: boolean;
  narrow: boolean;
}) {
  const [coverVisible, setCoverVisible] = useState(false);
  const hasCover = !!song.cover_url?.trim();
  const deferCover = web && hasCover;
  const play = () => {
    if (!state.playerBusy) run(() => store.playSong(song, index));
  };

  return (
    <view
      className={classes(["song-row", selected && "selected"])}
      style={{ height: `${rowHeight}px` }}
      exposure-id={deferCover ? `song-cover-${song.id}` : undefined}
      binduiappear={deferCover ? () => setCoverVisible(true) : undefined}
      binduidisappear={deferCover ? () => setCoverVisible(false) : undefined}
    >
      <view
        className="song-play-target"
        aria-disabled={!playbackEnabled}
        bindtap={playbackEnabled ? play : undefined}
      >
        {/* Native Lynx can still paint flattened text hidden by responsive CSS. */}
        {!narrow && <text className="song-index">{index + 1}</text>}
        {!web || coverVisible ? (
          <Cover song={song} />
        ) : (
          <view className="cover-frame song-cover">
            {!hasCover && <CoverPlaceholder />}
          </view>
        )}
        <view className="song-copy" event-through>
          <text className="song-title" text-maxline="1">
            {song.title || "未知歌曲"}
          </text>
          {narrow && (
            <view className="song-mobile-meta">
              <text className="song-mobile-artist muted" text-maxline="1">
                {song.artist || "未知艺术家"}
              </text>
              <text className="song-mobile-duration muted">
                {duration(song.duration)}
              </text>
            </view>
          )}
        </view>
        {!narrow && (
          <>
            <text className="song-artist muted" text-maxline="1">
              {song.artist || "未知艺术家"}
            </text>
            <text className="song-album muted" text-maxline="1">
              {song.album || "未知专辑"}
            </text>
            <text className="song-duration muted">
              {duration(song.duration)}
            </text>
          </>
        )}
      </view>
      <view className="song-actions">
        {!narrow && (
          <SlButton
            variant="icon"
            icon="play_arrow"
            title="播放歌曲"
            className="song-action-play"
            disabled={!playbackEnabled}
            onClick={play}
          />
        )}
        {!isVirtualPlaylist && (
          <SlButton
            variant="icon"
            icon="more_vert"
            title="歌曲操作"
            id={`miot-song-actions-${song.id}`}
            onClick={() => {
              navigation.selectOpen = true;
              setSongAction({ song, playlistId });
            }}
          />
        )}
      </view>
      <view className="song-row-separator" event-through />
    </view>
  );
});

function SongList() {
  useObservedFields(() => [
    state.loading,
    state.startupError,
    state.configLoaded,
    state.configError,
    state.deviceError,
    state.deviceConnecting,
    state.playerStatusState,
    state.config.server_host,
    state.config.server_host_status,
    store.currentDevice.value,
    state.selectedPlaylistId,
    state.playlists,
    store.visibleSongs.value,
    state.songsLoading,
    state.songsError,
    state.songsLoadingMore,
    state.songsMoreError,
    state.songsHasMore,
    state.songsTotal,
    state.songSearch,
    state.playlistProgress,
    state.player.playlist_id,
    state.player.is_playing,
    state.player.current_song?.id,
    state.playerBusy,
    state.playerSyncing,
    navigation.selectOpen,
  ]);
  const { width, height, locateSong } = useContext(Viewport),
    rowHeight = 64;
  const {
    start,
    onScroll,
    locate: scrollToSong,
  } = useSongListScroll({
    rowHeight,
    playlistId: state.selectedPlaylistId,
    search: state.songSearch,
    ready:
      !!state.selectedPlaylistId &&
      !state.loading &&
      !state.songsLoading &&
      !state.songsError,
  });
  const [songAction, setSongAction] = useState<SongAction | null>(null);
  useEffect(() => {
    if (!navigation.selectOpen) setSongAction(null);
  });
  const closeSongActions = () => {
    setSongAction(null);
    navigation.selectOpen = false;
  };
  const songs = store.visibleSongs.value;
  const web = String(SystemInfo.platform).toLowerCase() === "web";
  // Web lays out loaded rows ahead of scrolling and skips offscreen painting.
  // Native keeps the fixed window updated by its scroll events.
  const first = web ? 0 : Math.min(start, Math.max(0, songs.length - 30));
  const end = web ? songs.length : Math.min(songs.length, first + 30);
  const isVirtualPlaylist = !!state.playlists.find(
    (p) => String(p.id) === state.selectedPlaylistId,
  )?.is_virtual;
  const device = store.currentDevice.value;
  const narrow = width < 600;
  const deviceStatus = state.deviceConnecting
    ? "连接中"
    : state.playerBusy
      ? "正在发送指令…"
      : state.playerSyncing
        ? "正在同步状态…"
        : state.playerStatusState === "error"
          ? "状态暂不可用"
          : state.playerStatusState !== "ready"
            ? "同步中"
            : state.player.is_playing
              ? "播放中"
              : state.player.current_song
                ? "已暂停"
                : "待机";
  const shortStatus: Record<string, string> = {
    "正在发送指令…": "发送中",
    "正在同步状态…": "同步中",
    状态暂不可用: "不可用",
  };
  const noServer =
    state.configLoaded &&
    (!state.config.server_host ||
      state.config.server_host_status === "loopback");
  const onThisPlaylist =
    String(state.player.playlist_id ?? "") === state.selectedPlaylistId;
  const playbackReady = !!device && state.configLoaded && !noServer;
  const canResume =
    !!state.selectedPlaylistId &&
    playbackReady &&
    !!state.playlistProgress?.song_id &&
    !(onThisPlaylist && state.player.is_playing);
  const currentSongId = state.player.current_song?.id;
  const playlistId = state.selectedPlaylistId;
  const playbackEnabled = playbackReady && (web || !state.playerBusy);
  const rows = useMemo(
    () =>
      songs
        .slice(first, end)
        .map((song, index) => (
          <SongListRow
            key={song.id}
            song={song}
            index={first + index}
            rowHeight={rowHeight}
            selected={currentSongId === song.id}
            playbackEnabled={playbackEnabled}
            playlistId={playlistId}
            isVirtualPlaylist={isVirtualPlaylist}
            setSongAction={setSongAction}
            web={web}
            narrow={narrow}
          />
        )),
    [
      songs,
      first,
      end,
      rowHeight,
      currentSongId,
      playbackEnabled,
      playlistId,
      isVirtualPlaylist,
      setSongAction,
      web,
      narrow,
    ],
  );
  async function remove(song: Song, fromLibrary: boolean, playlistId: string) {
    if (playlistId !== state.selectedPlaylistId) return;
    const answer = await store.confirmAction(
      fromLibrary ? "从曲库永久删除" : "从歌单移除",
      fromLibrary
        ? `从曲库及所有歌单永久删除《${song.title}》？封面和缓存会清理，本地原始音乐文件会保留。此操作不可撤销。`
        : `将《${song.title}》从当前歌单移除？歌曲文件会保留。`,
      fromLibrary ? "永久删除" : "移除",
      fromLibrary,
    );
    if (answer.confirmed && playlistId === state.selectedPlaylistId)
      await store.removeSongFromPlaylist(song, { fromLibrary });
  }
  useEffect(() => {
    locateSong.current = locate;
    return () => {
      locateSong.current = null;
    };
  });
  async function locate() {
    const index = await store.ensureSongLoaded(
      state.player.current_song?.id || 0,
    );
    if (index < 0) {
      store.notify("当前歌曲不在此歌单中");
      return;
    }
    scrollToSong(index);
  }
  return (
    <view className="main-page">
      <view className="library-heading" style={libraryHeaderRow}>
        <view className="device-target-row" style={libraryHeaderRow}>
          <SlButton
            className="device-target"
            variant="text"
            icon="speaker_group"
            iconSize={16}
            title="选择设备"
            disabled={state.deviceConnecting}
            onClick={() => {
              navigation.devicePickerOpen = true;
            }}
          >
            {!narrow && <text className="device-target-prefix">播放到</text>}
            <text className="device-target-name" text-maxline="1">
              {device ? store.deviceName(device) : "选择设备"}
            </text>
            <SlIcon name="expand_more" size={14} color="muted" />
          </SlButton>
          <view className="device-play-state-slot">
            {device && (
              <text
                className={classes([
                  "device-play-state",
                  state.playerStatusState === "error" && "error",
                ])}
                accessibility-label={deviceStatus}
                text-maxline="1"
              >
                {narrow
                  ? shortStatus[deviceStatus] || deviceStatus
                  : deviceStatus}
              </text>
            )}
          </view>
        </view>
        <view className="appbar-actions" style={libraryHeaderRow}>
          {narrow &&
            (state.player.current_song && state.selectedPlaylistId ? (
              <SlButton
                variant="icon"
                className="current-song-locate"
                icon="my_location"
                title="定位当前播放"
                onClick={() => run(locate)}
              />
            ) : (
              <view className="device-locate-placeholder" />
            ))}
          <SlButton
            variant="icon"
            icon="settings"
            title="设置"
            disabled={!state.configLoaded}
            onClick={() => openPage("settings")}
          />
        </view>
      </view>
      <view className="library-body">
        {noServer && (
          <view className="status-panel">
            <SlIcon name="info" size={18} />
            <text className="status-copy">
              {state.config.server_host_status === "loopback"
                ? "服务器地址是本地回环地址，音箱无法访问。请在设置中改为局域网地址。"
                : "请先在设置中配置音箱可访问的 Songloft 服务器地址。"}
            </text>
            <SlButton
              label="去设置"
              onClick={() => {
                navigation.settingsCategory = "device";
                openPage("settings");
              }}
            />
          </view>
        )}
        {!!state.configError && (
          <SlButton
            label="配置加载失败，点击重试"
            onClick={() => run(store.retryInitialConfig)}
          />
        )}
        {!!state.deviceError && (
          <SlButton
            label="设备加载失败，点击重试"
            onClick={() => run(store.retryInitialDevices)}
          />
        )}
        <view className="library-tools">
          <view className="library-filters player-toolbar">
            <SlSelect
              modelValue={state.selectedPlaylistId}
              options={state.playlists.map((playlist) => ({
                value: String(playlist.id),
                label: store.playlistLabel(playlist),
                searchText: playlist.name,
              }))}
              disabled={state.loading}
              leadingIcon="queue_music"
              searchable
              searchPlaceholder="搜索歌单"
              allowEmpty
              placeholder={state.loading ? "正在加载歌单…" : "选择播放歌单"}
              onUpdateModelValue={(value: string) =>
                run(() => store.selectPlaylist(value))
              }
            />
          </view>
          {state.selectedPlaylistId && (
            <view className="search-bar">
              <SlIcon name="search" />
              <SlInput
                modelValue={state.songSearch}
                placeholder="搜索歌曲、艺术家或专辑"
                onUpdateModelValue={(value: string) => {
                  store.searchSongs(value);
                }}
              />
              {state.songSearch && (
                <SlButton
                  variant="icon"
                  icon="close"
                  title="清除搜索"
                  onClick={() => store.searchSongs("")}
                />
              )}
            </view>
          )}
        </view>
        {canResume && (
          <view className="playlist-context">
            <text className="playlist-context-text" text-maxline="1">
              {store.lastPlayedSong.value
                ? `上次播放：${store.lastPlayedSong.value.title}`
                : "上次播放的位置已保存"}
            </text>
            <SlButton
              className="resume-playlist"
              variant="text"
              icon="play_arrow"
              label="继续播放"
              disabled={state.playerBusy}
              onClick={() => run(store.resumePlaylist)}
            />
          </view>
        )}
        {state.startupError ? (
          <SlEmptyState title="加载失败" description={state.startupError}>
            <SlButton
              label="重新加载"
              icon="refresh"
              onClick={() => run(store.retryInitialPlaylists)}
            />
          </SlEmptyState>
        ) : state.loading || state.songsLoading ? (
          <view
            className="song-list-skeleton"
            accessibility-label={
              state.loading ? "正在加载歌单" : "正在加载歌曲"
            }
          >
            {!narrow && state.selectedPlaylistId && <SongListHeader />}
            {Array.from({ length: 8 }, (_, index) => (
              <view
                key={index}
                className="song-skeleton-row"
                style={{ height: `${rowHeight}px` }}
              >
                <view className="skeleton-cover" />
                <view className="skeleton-copy">
                  <view className="skeleton-title" />
                  <view className="skeleton-artist" />
                </view>
              </view>
            ))}
          </view>
        ) : state.songsError ? (
          <SlEmptyState title="歌曲加载失败" description={state.songsError}>
            <SlButton
              label="重新加载"
              icon="refresh"
              onClick={() =>
                run(() => store.selectPlaylist(state.selectedPlaylistId))
              }
            />
          </SlEmptyState>
        ) : state.selectedPlaylistId ? (
          <>
            {!narrow && <SongListHeader />}
            <scroll-view
              id="miot-song-list"
              className={classes([
                "songs-scroll",
                web && "songs-scroll-web",
                web && state.playerBusy && "songs-playback-busy",
              ])}
              aria-busy={web && state.playerBusy ? true : undefined}
              scroll-y
              bindscroll={(event: any) => {
                const top = Number(event.detail.scrollTop || 0);
                if (!web) onScroll(top);
                if (top + height >= songs.length * rowHeight - rowHeight * 10)
                  void store.loadMoreSongs();
              }}
            >
              {!web && (
                <view
                  style={{ height: `${first * rowHeight}px`, flexShrink: 0 }}
                />
              )}
              {rows}
              {!web && (
                <view
                  style={{
                    height: `${(songs.length - end) * rowHeight}px`,
                    flexShrink: 0,
                  }}
                />
              )}
              <view className="songs-page-feedback">
                <text className="muted">
                  {state.songsHasMore
                    ? `已加载 ${state.songs.length} 首${state.songsTotal !== null && !isVirtualPlaylist ? ` / 共 ${state.songsTotal} 首` : ""}`
                    : state.songSearch.trim()
                      ? `找到 ${songs.length} 首`
                      : `已全部加载，共 ${songs.length} 首`}
                </text>
                {!!state.songsMoreError && (
                  <text className="songs-page-error" text-maxline="3">
                    加载失败：{state.songsMoreError}
                  </text>
                )}
                {state.songsHasMore && (
                  <SlButton
                    label={
                      state.songsLoadingMore
                        ? "正在加载…"
                        : state.songsMoreError
                          ? "重试加载"
                          : "加载更多"
                    }
                    disabled={state.songsLoadingMore}
                    onClick={() => run(() => store.loadMoreSongs(true))}
                  />
                )}
              </view>
              {!songs.length && !state.songsHasMore && (
                <text className="empty-state muted">没有匹配的歌曲</text>
              )}
            </scroll-view>
          </>
        ) : (
          <SlEmptyState
            title="选择一个歌单"
            description="选好歌单后，可以搜索、定位并直接推送到音箱播放。"
            icon="queue_music"
          />
        )}
      </view>
      {songAction && (
        <PopupMenu
          anchor={`miot-song-actions-${songAction.song.id}`}
          panelWidth={208}
          className="song-action-sheet"
          captureTarget="miot-main-content"
          close={closeSongActions}
          items={[
            {
              label: "从歌单移除",
              icon: "delete",
              action: () => {
                closeSongActions();
                run(() =>
                  remove(songAction.song, false, songAction.playlistId),
                );
              },
            },
            {
              label: "从曲库永久删除",
              icon: "delete",
              danger: true,
              action: () => {
                closeSongActions();
                run(() => remove(songAction.song, true, songAction.playlistId));
              },
            },
          ]}
        />
      )}
    </view>
  );
}
function Settings() {
  useObservedFields(() => [
    navigation.settingsCategory,
    navigation.page,
    navigation.hostVisible,
    state.accounts.length,
    store.managedDevices.value.length,
    state.config.conversation_monitor_enabled,
    state.config.scheduled_tasks_enabled,
    state.schedules.length,
    state.configSaving,
    state.configSaveState,
    state.configSaveError,
  ]);
  const { width } = useContext(Viewport),
    wide = width >= 600;
  const current =
    navigation.settingsCategory ||
    (wide && navigation.page === "settings" ? "device" : "");
  const category = categories.find((item) => item.id === current);
  const [visited, setVisited] = useState<string[]>([]);
  useEffect(() => {
    if (current)
      setVisited((items) =>
        items.includes(current) ? items : [...items, current],
      );
  }, [current]);
  function subtitle(id: string, fallback: string) {
    if (id === "device" && state.accounts.length)
      return `${state.accounts.length} 个账号 · ${store.managedDevices.value.length} 台受管理设备`;
    if (id === "voice" && state.config.conversation_monitor_enabled)
      return "监听运行中 · 口令与智能搜索";
    if (id === "schedule" && state.schedules.length)
      return `${state.schedules.length} 个任务 · ${state.config.scheduled_tasks_enabled ? "已启用" : "已暂停"}`;
    return fallback;
  }
  function status(id: string) {
    if (id === "device")
      return state.accounts.length
        ? `${store.managedDevices.value.length} 台`
        : "待配置";
    if (id === "voice")
      return state.config.conversation_monitor_enabled ? "运行中" : "未启用";
    if (id === "schedule")
      return state.config.scheduled_tasks_enabled ? "已启用" : "已暂停";
    return "";
  }
  return (
    <view className="settings-page">
      <view
        className={classes([
          "page-toolbar",
          "settings-toolbar",
          !wide && category && "settings-toolbar-subpage",
        ])}
      >
        <SlButton
          variant="icon"
          icon="chevron_left"
          title="返回"
          onClick={() =>
            wide && !navigation.editorOpen && !navigation.playerPopup
              ? ((navigation.settingsCategory = ""), closePage())
              : consumeBack()
          }
        />
        <text className="page-title" text-maxline="1">
          {!wide && category ? category.title : "设置"}
        </text>
        <text
          className={classes([
            "config-save-status",
            state.configSaveState === "error" && "error",
          ])}
        >
          {state.configSaving
            ? "正在保存…"
            : state.configSaveState === "error"
              ? "有更改未保存"
              : state.configSaveState === "saved"
                ? "更改已保存"
                : ""}
        </text>
      </view>
      {state.configSaveState === "error" && (
        <view className="config-save-error">
          <text>保存失败：{state.configSaveError}</text>
          <SlButton
            label="重试保存"
            disabled={state.configSaving}
            onClick={() => {
              void store.retryConfigSave();
            }}
          />
        </view>
      )}
      <CompactSettingsContext.Provider value={!wide}>
        <view className="settings-layout">
          {(wide || !current) && (
            <view
              className="settings-menu-panel"
              style={{ display: wide || !current ? "flex" : "none" }}
            >
              <scroll-view className="settings-menu" scroll-y>
                {categoryGroups.map((group) => (
                  <view className="settings-menu-group" key={group[0].id}>
                    {group.map((item) => (
                      <view
                        key={item.id}
                        className={classes([
                          "category",
                          current === item.id && "selected",
                        ])}
                        bindtap={() => {
                          navigation.settingsCategory = item.id;
                        }}
                      >
                        <view className="settings-nav-icon">
                          <SlIcon name={item.icon} color="muted" />
                        </view>
                        <view className="settings-nav-content">
                          <view className="settings-nav-copy">
                            <text className="settings-nav-title">
                              {item.title}
                            </text>
                            <text
                              className="settings-nav-subtitle"
                              text-maxline="1"
                            >
                              {subtitle(item.id, item.description)}
                            </text>
                          </view>
                          {wide && status(item.id) && (
                            <SlStatusChip
                              label={status(item.id)}
                              tone={
                                item.id === "device" && !state.accounts.length
                                  ? "warning"
                                  : "neutral"
                              }
                            />
                          )}
                          <view className="category-chevron">
                            <SlIcon name="chevron_right" color="muted" />
                          </view>
                        </view>
                      </view>
                    ))}
                  </view>
                ))}
              </scroll-view>
            </view>
          )}
          <view
            flatten={false}
            className="settings-detail"
            style={{ display: wide || current ? "flex" : "none" }}
          >
            {categories
              .filter((item) => visited.includes(item.id))
              .map((item) => (
                <view
                  key={item.id}
                  flatten={false}
                  className="settings-panel"
                  style={{
                    display: current === item.id ? "flex" : "none",
                    visibility: current === item.id ? "visible" : "hidden",
                  }}
                >
                  <scroll-view className="settings-scroll" scroll-y>
                    {wide && (
                      <view className="settings-header">
                        <text className="settings-title">{item.title}</text>
                        <text className="settings-description">
                          {subtitle(item.id, item.description)}
                        </text>
                      </view>
                    )}
                    <item.component
                      active={current === item.id && navigation.hostVisible}
                    />
                  </scroll-view>
                </view>
              ))}
          </view>
        </view>
      </CompactSettingsContext.Provider>
    </view>
  );
}
function MiniPlayerProgress() {
  useObservedFields(() => [
    playerProgress.position,
    state.player.duration,
    state.player.current_song?.is_live,
  ]);
  const elapsed = playerProgress.position ?? 0;
  const total = state.player.duration ?? 0;
  const fraction =
    Number.isFinite(elapsed) && total > 0 && !state.player.current_song?.is_live
      ? Math.min(1, Math.max(0, elapsed / total))
      : 0;
  return (
    <view className="mini-progress" event-through>
      <view
        className="mini-progress-fill"
        style={{ width: `${Math.round(fraction * 100)}%` }}
      />
    </view>
  );
}

function PlayerProgress() {
  useObservedFields(() => [
    playerProgress.position,
    state.player.duration,
    state.player.current_song?.id,
    state.player.current_song?.is_live,
    state.playerBusy,
  ]);
  const song = state.player.current_song;
  return (
    <view className="player-progress">
      <SlSlider
        key={song?.id || 0}
        modelValue={playerProgress.position || 0}
        max={state.player.duration || 1}
        disabled={!state.player.duration || song?.is_live || state.playerBusy}
        onCommit={(value: number) => run(() => store.seekPlayer(value))}
      />
      <view className="row time-row">
        <text>{duration(playerProgress.position)}</text>
        <text>{song?.is_live ? "直播" : duration(state.player.duration)}</text>
      </view>
    </view>
  );
}

function PlayerLyrics({
  details,
}: {
  details: ReturnType<typeof createPlayerDetails>;
}) {
  useObserved(
    playerProgress,
    details.lyrics,
    details.lyricLoading,
    details.lyricError,
  );
  const lyrics = details.lyrics.value;
  const lyricError = details.lyricError.value;
  const lyricLoading = details.lyricLoading.value;
  const [followLyrics, setFollowLyrics] = useState(true);
  const activeLine = lyrics.reduce(
    (active, line, index) =>
      line.time <= Number(playerProgress.position || 0) ? index : active,
    -1,
  );
  useEffect(() => {
    if (followLyrics && activeLine >= 0) {
      try {
        lynx
          .createSelectorQuery()
          .select("#lyric-" + activeLine)
          .invoke({
            method: "scrollIntoView",
            params: {
              scrollIntoViewOptions: { block: "center", behavior: "smooth" },
            },
          })
          .exec();
      } catch {}
    }
  }, [activeLine, followLyrics]);
  return (
    <view className="lyrics-panel">
      <scroll-view
        className="lyrics-scroll"
        scroll-y
        bindtouchmove={() => setFollowLyrics(false)}
        bindwheel={() => setFollowLyrics(false)}
        bindmousedown={() => setFollowLyrics(false)}
      >
        {lyricLoading && <text className="lyrics-empty">正在获取歌词…</text>}
        {lyricError && (
          <SlButton
            label="歌词获取失败，点击重试"
            onClick={() => run(details.retryLyrics)}
          />
        )}{" "}
        {!lyricLoading && !lyricError && !lyrics.length && (
          <view className="lyrics-empty">
            <text>暂无歌词，请确认已安装并启用歌词搜索插件</text>
            <SlButton
              label="重新获取歌词"
              onClick={() => run(details.retryLyrics)}
            />
          </view>
        )}
        {lyrics.map((line, index) => (
          <view
            id={"lyric-" + index}
            key={index}
            className={classes([
              "lyric-line",
              activeLine === index && "active",
            ])}
            bindtap={
              Number.isFinite(line.time)
                ? () =>
                    run(async () => {
                      await store.seekPlayer(line.time);
                      setFollowLyrics(true);
                    })
                : undefined
            }
          >
            <text>{line.text}</text>
          </view>
        ))}
      </scroll-view>
      {!followLyrics && lyrics.length > 0 && (
        <SlButton
          className="lyrics-follow"
          label="回到当前歌词"
          onClick={() => setFollowLyrics(true)}
        />
      )}
    </view>
  );
}

function SleepTimerPopup({
  accountId,
  deviceId,
  hostVisible,
  isLive,
  captureTarget,
  close,
}: {
  accountId: string;
  deviceId: string;
  hostVisible: boolean;
  isLive: boolean;
  captureTarget: string;
  close: () => void;
}) {
  const { width, height } = useContext(Viewport);
  const [contentHeight, setContentHeight] = useState(0);
  const [status, setStatus] = useState<SleepTimerStatus>();
  const [readFailed, setReadFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const maxScrollHeight = Math.max(1, height - 112);
  const scrollHeight = Math.min(
    contentHeight || maxScrollHeight,
    maxScrollHeight,
  );
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!hostVisible || !deviceId) return;
    const path =
      "/voice-commands/sleep-timer" +
      query({ account_id: accountId, device_id: deviceId });
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      try {
        const result = await get<SleepTimerStatus>(path);
        if (stopped) return;
        setStatus(result);
        setReadFailed(false);
        if (result.active) timer = setTimeout(refresh, 5000);
      } catch {
        if (!stopped) setReadFailed(true);
      }
    };
    void refresh();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [hostVisible, accountId, deviceId, retry]);
  async function changeTimer(
    path: string,
    options?: { mode: "time" | "songs"; value: number },
  ) {
    await post(path, { account_id: accountId, device_id: deviceId, ...options });
    if (
      mounted.current &&
      navigation.playerPopup === "sleep" &&
      accountId === state.currentAccountId &&
      deviceId === state.currentDeviceId
    ) {
      close();
    }
  }
  return (
    <Modal
      className={classes([
        "player-popup player-popup-sleep",
        // Measure the scroll content before showing the centered card.
        !contentHeight && "sleep-popup-measuring",
      ])}
      captureTarget={captureTarget}
      cardStyle={{
        width: `${Math.min(360, width - 32)}px`,
        maxHeight: `${Math.max(1, height - 32)}px`,
      }}
      close={close}
      showClose={false}
    >
      <view className="sleep-popup-header">
        <text className="section-title">延迟停止</text>
        <SlButton
          variant="icon"
          icon="close"
          title="关闭延迟停止"
          onClick={close}
        />
      </view>
      <scroll-view
        className="sleep-popup-scroll"
        scroll-y
        style={{ height: `${scrollHeight}px` }}
      >
        <view
          className="sleep-panel-content"
          bindlayoutchange={(event) => {
            const next = event.detail?.height;
            if (next > 0) setContentHeight(next);
          }}
        >
          <SleepTimerPanel
            status={status}
            readFailed={readFailed}
            isLive={isLive}
            onRetry={() => setRetry((attempt) => attempt + 1)}
            onSet={(mode: "time" | "songs", value: number) =>
              run(() =>
                changeTimer("/voice-commands/sleep-timer", { mode, value }),
              )
            }
            onCancel={() =>
              run(() => changeTimer("/voice-commands/sleep-timer/cancel"))
            }
          />
        </view>
      </scroll-view>
    </Modal>
  );
}

function Player({ lyricCache }: { lyricCache: Map<number, LyricLine[]> }) {
  const theme = useContext(ThemeContext);
  const { width, height, locateSong } = useContext(Viewport),
    narrow = width < 600;
  const song = state.player.current_song;
  const details = useMemo(
    () =>
      createPlayerDetails(get, () => state.player.current_song?.id, lyricCache),
    [lyricCache],
  );
  useObservedFields(() => [
    state.player,
    details.isFavorite.value,
    navigation.page,
    navigation.playerPage,
    navigation.playerPopup,
    navigation.playerPopupAnchor,
    navigation.hostVisible,
    state.currentAccountId,
    state.currentDeviceId,
    state.playerBusy,
    state.playerSyncing,
    state.playlists,
  ]);
  const favorite = details.isFavorite.value,
    setFavorite = details.setFavorite;
  const swipeStart = useRef<number | null>(null);
  const [favoriteBusy, setFavoriteBusy] = useState(false);
  const identity = `${state.currentAccountId}:${state.currentDeviceId}:${song?.id || ""}`;
  const identityRef = useRef(identity);
  identityRef.current = identity;
  useEffect(() => {
    void details.loadSongDetails(false);
    if (showLyrics) void details.ensureLyrics();
    return details.dispose;
  }, [song?.id]);
  const showLyrics =
    navigation.hostVisible &&
    navigation.page === "player" &&
    (!narrow || navigation.playerPage === 1);
  useEffect(() => {
    if (showLyrics) void details.ensureLyrics();
  }, [details, showLyrics]);
  async function toggleFavorite() {
    if (!song || favoriteBusy) return;
    const previous = favorite;
    setFavoriteBusy(true);
    setFavorite(!previous);
    try {
      const result = await post<{ is_favorited: boolean }>(
        "/player/favorite/toggle",
        { song_id: song.id, action: previous ? "remove" : "add" },
      );
      notifyHostFavorite(song.id, result.is_favorited);
      if (identity === identityRef.current) setFavorite(result.is_favorited);
    } catch (error) {
      if (identity === identityRef.current) setFavorite(previous);
      throw error;
    } finally {
      setFavoriteBusy(false);
    }
  }
  const preferredCoverSize = narrow
    ? width * (height < 650 ? 0.54 : 0.75)
    : width >= 1600
      ? 420
      : width >= 960
        ? 300
        : 220;
  const coverSize = Math.max(
    96,
    Math.min(
      preferredCoverSize,
      narrow ? Math.max(96, height - 390) : height - 360,
    ),
  );
  const full = navigation.page === "player";
  const popup = navigation.playerPopup;
  const popupPosition = useAnchoredPanel(
    popup === "volume" ? navigation.playerPopupAnchor : null,
    76,
    294,
    "center",
  );
  const closePopup = () => {
    navigation.playerPopup = "";
  };
  const canRemoveSong =
    song &&
    Number(state.player.playlist_id) > 0 &&
    !state.playlists.find((p) => p.id === state.player.playlist_id)?.is_virtual;
  const popupItems: MenuItem[] =
    popup === "mode"
      ? modes.map((mode) => ({
          label: mode.label,
          icon: mode.icon,
          selected: state.player.play_mode === mode.value,
          action: () => {
            closePopup();
            run(() => store.setPlayMode(mode.value));
          },
        }))
      : popup === "speed"
        ? [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map((speed) => ({
            label: `${speed}×`,
            selected: speed === (state.player.speed || 1),
            action: () => {
              closePopup();
              run(() => store.setPlaybackSpeed(speed));
            },
          }))
        : popup === "more"
          ? [
              {
                label: `音量 · ${state.player.volume || 0}%`,
                icon: "volume_up",
                action: () => {
                  navigation.playerPopup = "volume";
                },
              },
              {
                label: `倍速 · ${state.player.speed || 1}×`,
                icon: "equalizer",
                action: () => {
                  navigation.playerPopup = "speed";
                },
              },
              {
                label: "延迟停止",
                icon: "bedtime",
                action: () => {
                  navigation.playerPopup = "sleep";
                },
              },
              {
                label: "停止播放",
                icon: "stop",
                action: () => {
                  closePopup();
                  run(() => store.playerCommand("/player/stop"));
                },
              },
              ...(canRemoveSong
                ? [
                    {
                      label: "从当前歌单移除",
                      icon: "delete",
                      danger: true,
                      action: () =>
                        run(async () => {
                          const playlistId = state.player.playlist_id;
                          const answer = await store.confirmAction(
                            "从当前歌单移除",
                            `将《${song.title}》从当前歌单移除？歌曲文件会保留。`,
                            "移除",
                            false,
                          );
                          if (answer.confirmed) {
                            await store.removeSongFromPlaylist(song, {
                              playlistId,
                            });
                            closePopup();
                          }
                        }),
                    },
                  ]
                : []),
            ]
          : [];
  const captureTarget = full ? "miot-player-content" : "miot-main-content";
  const shortWide = !narrow && height < 480;
  const palette =
    full && song?.cover_url?.trim() ? paletteFromMetadata(song) : null;
  const foreground = palette ? palette.onImage : themeColors[theme].label;
  const favoriteButton = (
    <SlButton
      variant="icon"
      icon={favorite ? "favorite" : "favorite_border"}
      title={favorite ? "取消收藏" : "收藏"}
      iconColor={favorite ? "#f44336" : foreground}
      disabled={!song || favoriteBusy}
      onClick={() => run(toggleFavorite)}
    />
  );
  const tools = [
    { popup: "volume", icon: "volume_up", title: "音量" },
    { popup: "sleep", icon: "bedtime", title: "延迟停止" },
    { popup: "more", icon: "more_vert", title: "更多" },
  ] as const;
  const toolButtons = tools
    .filter(({ popup }) => full || popup !== "more")
    .map(({ popup, icon, title }) => (
      <SlButton
        key={popup}
        variant="icon"
        icon={icon}
        popupTrigger
        title={title}
        iconColor={foreground}
        onClick={() => {
          navigation.playerPopup = popup;
        }}
      />
    ));
  const controls = (
    <view className="player-controls row">
      {(full || !narrow) && (
        <SlButton
          variant="icon"
          icon={
            modes.find((mode) => mode.value === state.player.play_mode)?.icon ||
            "format_list_numbered"
          }
          popupTrigger
          title="播放模式"
          iconColor={foreground}
          onClick={() => {
            navigation.playerPopup = "mode";
          }}
        />
      )}
      <view className="player-transport">
        <SlButton
          variant="icon"
          icon="skip_previous"
          title="上一首"
          iconSize={full ? 30 : 22}
          iconColor={foreground}
          disabled={state.playerBusy}
          onClick={() => run(() => store.playerCommand("/player/previous"))}
        />
        <SlButton
          variant="icon"
          className="play-primary"
          title="播放/暂停"
          disabled={state.playerBusy}
          onClick={() => run(() => store.playerCommand("/player/toggle"))}
        >
          <view className="play-primary-disc" event-through>
            <SlIcon
              name={state.player.is_playing ? "pause" : "play_arrow"}
              size={full ? 34 : 18}
              color={themeColors[theme].onAccent}
            />
          </view>
        </SlButton>
        <SlButton
          variant="icon"
          icon="skip_next"
          title="下一首"
          iconSize={full ? 30 : 22}
          iconColor={foreground}
          disabled={state.playerBusy}
          onClick={() => run(() => store.playerCommand("/player/next"))}
        />
      </view>
      {(full || !narrow) && favoriteButton}
    </view>
  );
  return (
    <view
      flatten={false}
      id="miot-player-content"
      className={classes([
        full ? "player-full" : "player-mini",
        palette && "player-tinted",
      ])}
      style={palette ? { backgroundColor: palette.darkMuted } : undefined}
    >
      {full ? (
        <>
          {palette && (
            <view
              className="player-ambient"
              style={{
                backgroundImage: `linear-gradient(145deg, ${palette.vibrant}, ${palette.dominant})`,
              }}
              event-through
            >
              <Cover
                song={song}
                className="player-ambient-cover"
                width={640}
                blur={48}
              />
              <view
                className="player-ambient-tint"
                style={{ backgroundColor: palette.darkMuted }}
              />
            </view>
          )}
          <view className="page-toolbar fullscreen-topbar">
            <SlButton
              variant="icon"
              icon="keyboard_arrow_down"
              iconSize={32}
              iconColor={foreground}
              title="收起播放器"
              onClick={consumeBack}
            />
            <text className="fullscreen-topbar-title" text-maxline="1">
              {state.playerBusy
                ? "正在发送指令…"
                : state.playerSyncing
                  ? "正在同步状态…"
                  : song?.album || "正在播放"}
            </text>
            <view className="fullscreen-topbar-spacer" />
          </view>
          <view className="fullscreen-inner">
            <view
              className="player-stage"
              bindtouchstart={(e: any) => {
                swipeStart.current =
                  e.touches?.[0]?.clientX ?? e.detail?.x ?? null;
              }}
              bindtouchend={(e: any) => {
                const x = e.changedTouches?.[0]?.clientX ?? e.detail?.x;
                if (
                  swipeStart.current !== null &&
                  typeof x === "number" &&
                  Math.abs(x - swipeStart.current) > 50
                )
                  navigation.playerPage = x < swipeStart.current ? 1 : 0;
                swipeStart.current = null;
              }}
            >
              {(!narrow || navigation.playerPage === 0) && (
                <view
                  className="player-art"
                  style={{
                    display:
                      !narrow || navigation.playerPage === 0 ? "flex" : "none",
                  }}
                >
                  <Cover
                    song={song}
                    className="large-cover"
                    width={640}
                    style={{
                      width: `${coverSize}px`,
                      height: `${coverSize}px`,
                    }}
                  />
                  {shortWide && (
                    <view className="player-copy desktop-meta">
                      <text className="song-title" text-maxline="1">
                        {song?.title || "暂无播放"}
                      </text>
                      <text className="muted" text-maxline="1">
                        {song?.artist || "未知艺术家"}
                      </text>
                    </view>
                  )}
                </view>
              )}
              {(!narrow || navigation.playerPage === 1) && (
                <PlayerLyrics key={identity} details={details} />
              )}
            </view>
            <view className="player-mobile-tabs row">
              <view
                className={classes([
                  "page-dot",
                  navigation.playerPage === 0 && "active",
                ])}
                accessibility-label="显示封面"
                bindtap={() => {
                  navigation.playerPage = 0;
                }}
              >
                <view className="page-dot-mark" event-through />
              </view>
              <view
                className={classes([
                  "page-dot",
                  navigation.playerPage === 1 && "active",
                ])}
                accessibility-label="显示歌词"
                bindtap={() => {
                  navigation.playerPage = 1;
                }}
              >
                <view className="page-dot-mark" event-through />
              </view>
            </view>
            <view className="fullscreen-playback">
              {!shortWide && (
                <view className="player-copy fullscreen-meta">
                  <text className="song-title" text-maxline="1">
                    {song?.title || "暂无播放"}
                  </text>
                  <text className="muted" text-maxline="1">
                    {song?.artist || "未知艺术家"}
                  </text>
                </view>
              )}
              <PlayerProgress />
              {controls}
              <view className="player-tools row">
                <SlButton
                  label={`${state.player.speed || 1}×`}
                  iconColor={foreground}
                  popupTrigger
                  title="播放速度"
                  onClick={() => {
                    navigation.playerPopup = "speed";
                  }}
                />
                {toolButtons}
              </view>
            </view>
          </view>
        </>
      ) : (
        <>
          <MiniPlayerProgress />
          <view className="mini-inner">
            <view className="mini-stage" bindtap={() => openPage("player")}>
              <Cover song={song} className="mini-cover" />
              <view className="player-copy">
                <text className="song-title" text-maxline="1">
                  {song?.title || "暂无播放"}
                </text>
                <text className="muted" text-maxline="1">
                  {[song?.artist, song?.album].filter(Boolean).join(" · ")}
                </text>
              </view>
            </view>
            {!narrow && song && (
              <SlButton
                variant="icon"
                className="current-song-locate"
                icon="my_location"
                title="定位当前播放"
                onClick={() => run(async () => locateSong.current?.())}
              />
            )}
            {controls}
            {!narrow && (
              <view className="player-tools mini-tools">
                {toolButtons}
                <SlButton
                  variant="icon"
                  icon="lyrics"
                  title="歌词"
                  iconColor={foreground}
                  onClick={() => {
                    navigation.playerPage = 1;
                    openPage("player");
                  }}
                />
                <SlButton
                  variant="icon"
                  icon="stop"
                  title="停止播放"
                  iconColor={foreground}
                  disabled={state.playerBusy}
                  onClick={() => run(() => store.playerCommand("/player/stop"))}
                />
              </view>
            )}
          </view>
        </>
      )}
      {popupItems.length > 0 && (
        <PopupMenu
          anchor={navigation.playerPopupAnchor}
          panelWidth={popup === "more" ? 218 : popup === "speed" ? 144 : 176}
          className={`player-popup player-popup-${popup}`}
          captureTarget={captureTarget}
          close={closePopup}
          items={popupItems}
        />
      )}
      {popup === "volume" && popupPosition && (
        <Modal
          className="player-popup player-popup-volume"
          captureTarget={captureTarget}
          cardStyle={popupPosition}
          close={closePopup}
          showClose={false}
        >
          <VolumeControl
            key={state.currentAccountId + ":" + state.currentDeviceId}
            value={state.player.volume || 0}
            onChange={(value: number) => run(() => store.setVolume(value))}
            trackHeight={Math.max(
              32,
              Math.min(148, parseFloat(popupPosition.height) - 146),
            )}
          />
        </Modal>
      )}
      {popup === "sleep" && (
        <SleepTimerPopup
          key={JSON.stringify([state.currentAccountId, state.currentDeviceId])}
          accountId={state.currentAccountId}
          deviceId={state.currentDeviceId}
          hostVisible={navigation.hostVisible}
          isLive={!!song?.is_live}
          captureTarget={captureTarget}
          close={closePopup}
        />
      )}
    </view>
  );
}

function DevicePicker() {
  const { width, height } = useContext(Viewport);
  useObservedFields(() => [
    store.managedAccounts.value,
    state.accounts.length,
    state.currentAccountId,
    state.currentDeviceId,
  ]);
  const [search, setSearch] = useState("");
  const count = store.managedAccounts.value.reduce(
    (sum, account) => sum + account.devices.length,
    0,
  );
  const searchable = count > 8;
  const keyword = search.trim().toLowerCase();
  const accounts = store.managedAccounts.value
    .map((account) => ({
      ...account,
      devices: account.devices.filter((device) =>
        `${account.account_name || account.account_id} ${store.deviceName(device)}`
          .toLowerCase()
          .includes(keyword),
      ),
    }))
    .filter((account) => account.devices.length);
  const listHeight = Math.max(
    48,
    Math.min(
      400,
      height - 156 - (searchable ? 52 : 0),
      accounts.reduce(
        (sum, account) => sum + 36 + account.devices.length * 48,
        0,
      ) || 48,
    ),
  );
  return (
    <Modal
      className="device-picker-overlay"
      captureTarget="miot-main-content"
      cardStyle={{ width: `${Math.min(420, Math.max(1, width - 32))}px` }}
      close={() => {
        navigation.devicePickerOpen = false;
      }}
    >
      <text className="section-title">选择播放设备</text>
      {searchable && (
        <SlInput
          modelValue={search}
          onUpdateModelValue={setSearch}
          placeholder="搜索设备或账号"
          aria-label="搜索播放设备"
        />
      )}
      <scroll-view
        className="device-picker-options"
        style={{ height: `${listHeight}px` }}
        scroll-y
      >
        {accounts.map((account) => (
          <view key={account.account_id} className="device-picker-account">
            <text
              className="device-picker-account-title muted"
              text-maxline="1"
            >
              {account.account_name || account.account_id}
            </text>
            {account.devices.map((device) => {
              const selected =
                state.currentDeviceId === store.deviceId(device) &&
                state.currentAccountId === account.account_id;
              return (
                <SlButton
                  className={classes([
                    "device-picker-choice",
                    selected && "selected",
                  ])}
                  key={store.deviceId(device)}
                  title={store.deviceName(device)}
                  onClick={() =>
                    run(async () => {
                      await store.selectDevice(
                        account.account_id,
                        store.deviceId(device),
                      );
                      navigation.devicePickerOpen = false;
                    })
                  }
                >
                  <text className="device-picker-name" text-maxline="1">
                    {store.deviceName(device)}
                  </text>
                  {selected && (
                    <text className="device-picker-current">当前</text>
                  )}
                </SlButton>
              );
            })}
          </view>
        ))}
        {!count && (
          <SlButton
            className="device-picker-choice"
            label={state.accounts.length ? "管理播放设备" : "添加账号与设备"}
            onClick={() => {
              navigation.devicePickerOpen = false;
              openPage("settings");
              navigation.settingsCategory = "device";
            }}
          />
        )}
        {!!count && !accounts.length && (
          <text className="device-picker-empty muted">没有匹配的设备</text>
        )}
      </scroll-view>
    </Modal>
  );
}

export function App() {
  useObservedFields(() => [
    navigation.page,
    navigation.devicePickerOpen,
    store.currentDevice.value,
    !!state.player.current_song,
    state.confirm,
    state.snackbar,
  ]);
  const [theme, setTheme] = useState(getTheme());
  const [width, setWidth] = useState(390);
  const [height, setHeight] = useState(800);
  const locateSong = useRef<(() => Promise<void>) | null>(null);
  const viewport = useMemo(
    () => ({ width, height, locateSong }),
    [width, height],
  );
  const lyricCache = useMemo(() => new Map<number, LyricLine[]>(), []);
  const measure = () => {
    try {
      lynx
        .createSelectorQuery()
        .select("#miot-app")
        .invoke({
          method: "boundingClientRect",
          success: (rect: any) => {
            if (rect.width > 0) setWidth(rect.width);
            if (rect.height > 0) setHeight(rect.height);
          },
        })
        .exec();
    } catch {}
  };
  useEffect(measure, []);
  useEffect(() => {
    navigation.wideLayout = width >= 600;
  }, [width]);
  useEffect(() => onThemeChange(setTheme), []);
  useEffect(() => {
    const back = installHostBack();
    void store.initialize();
    const stopWatch = watch(
      () =>
        [
          navigation.hostVisible &&
            navigation.page === "settings" &&
            navigation.settingsCategory === "ai",
          state.currentAccountId,
          state.currentDeviceId,
        ] as const,
      ([active]) => setChatVisible(active),
      { immediate: true },
    );
    const lifecycle = onPush((event, raw) => {
      if (event === "lifecycle") {
        const phase = JSON.parse(String(raw)).state;
        if (phase === "resumed") {
          store.setAppVisible(true);
          navigation.hostVisible = true;
        } else if (phase === "paused") {
          store.setAppVisible(false);
          navigation.hostVisible = false;
        }
      }
    });
    return () => {
      stopChatSocket();
      stopWatch();
      lifecycle();
      back();
      store.disposeStore();
    };
  }, []);
  return (
    <ThemeContext.Provider value={theme}>
      <view
        id="miot-app"
        flatten={false}
        bindlayoutchange={(event: any) => {
          const next = event.detail?.width || event.detail?.layout?.width;
          const nextHeight = event.detail?.height;
          if (nextHeight > 0) setHeight(nextHeight);
          if (next > 0) setWidth(next);
          else measure();
        }}
        className={classes([
          "miot-app",
          theme === "dark" && "dark",
          width < 600 && "narrow",
          width < 960 && "tablet",
          width < 360 && "compact",
          width >= 960 && "wide-display",
          width >= 600 && height < 480 && "short-wide",
        ])}
      >
        <Viewport.Provider value={viewport}>
          <view id="miot-main-content" className="main-shell" flatten={false}>
            <SongList />
          </view>
          {navigation.page === "settings" && (
            <view
              id="miot-settings-content"
              className="settings-shell"
              flatten={false}
            >
              <Settings />
            </view>
          )}
          {((store.currentDevice.value &&
            (state.player.current_song || width >= 600)) ||
            navigation.page === "player") && (
            <view className="player-slot">
              {navigation.page !== "settings" && (
                <Player lyricCache={lyricCache} />
              )}
            </view>
          )}
          {navigation.devicePickerOpen && <DevicePicker />}
        </Viewport.Provider>
        {state.confirm.open && (
          <Modal
            className="confirm-overlay"
            close={() => store.resolveConfirm(false)}
          >
            <text className="section-title">{state.confirm.title}</text>
            <text>{state.confirm.message}</text>
            {state.confirm.checkbox && (
              <view className="row">
                <SlCheckbox
                  modelValue={state.confirm.checkbox.checked}
                  onUpdateModelValue={(value: boolean) => {
                    if (state.confirm.checkbox)
                      state.confirm.checkbox.checked = value;
                  }}
                />
                <text>{state.confirm.checkbox.label}</text>
              </view>
            )}
            <SlButton
              variant="filled"
              label={state.confirm.confirmText}
              onClick={() => store.resolveConfirm(true)}
            />
          </Modal>
        )}
        {state.snackbar && (
          <view
            event-through
            className={classes(["snackbar", state.snackbar.kind])}
          >
            <text>{state.snackbar.text}</text>
          </view>
        )}
      </view>
    </ThemeContext.Provider>
  );
}
