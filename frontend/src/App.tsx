import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "@lynx-js/react";
import { getTheme, onPush, onThemeChange } from "@songloft/lynx-plugin-sdk";
import { watch } from "@vue/reactivity";
import { CompactSettingsContext } from "./ui/theme";
import { useObserved, classes } from "./page-state";
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
import {
  connectChatSocket,
  stopChatSocket,
  setChatVisible,
} from "./chat-stream";
import { Cover } from "./Cover";
import { useSongListScroll } from "./song-list-scroll";
import { createPlayerDetails } from "./player-details";
import { paletteFromMetadata } from "./player-palette";
import type { PlayMode, SleepTimerStatus, Song } from "./types";
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
import { ThemeContext } from "./ui/theme";
import { measurePopover, placePopover } from "./ui/position";
const { state } = store;
const Viewport = createContext({ width: 390, height: 800 });
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
function duration(seconds = 0) {
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
}
function Modal({
  children,
  close,
  className,
  cardStyle,
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
          className="modal-card"
          style={cardStyle}
          catchtap={() => {}}
        >
          {children}
          {showClose && <SlButton label="关闭" onClick={close} />}
        </view>
      </view>
    </Overlay>
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
function SongList() {
  useObserved(state, navigation);
  const { width, height } = useContext(Viewport),
    rowHeight = width < 600 ? 64 : 56;
  const { start, onScroll, locate: scrollToSong } = useSongListScroll({
    rowHeight,
    playlistId: state.selectedPlaylistId,
    search: state.songSearch,
    ready:
      !!state.selectedPlaylistId &&
      !state.loading &&
      !state.songsLoading &&
      !state.songsError,
  });
  const [songAction, setSongAction] = useState<{
    song: Song;
    playlistId: string;
  } | null>(null);
  useEffect(() => {
    if (!navigation.selectOpen) setSongAction(null);
  });
  const closeSongActions = () => {
    setSongAction(null);
    navigation.selectOpen = false;
  };
  const songs = store.visibleSongs.value;
  const first = Math.min(start, Math.max(0, songs.length - 30)),
    end = Math.min(songs.length, first + 30);
  const device = store.currentDevice.value;
  const noServer =
    state.configLoaded &&
    (!state.config.server_host ||
      state.config.server_host_status === "loopback");
  const onThisPlaylist =
    String(state.player.playlist_id ?? "") === state.selectedPlaylistId;
  const canResume =
    !!device &&
    !!state.playlistProgress?.song_id &&
    !(onThisPlaylist && state.player.is_playing);
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
      <view className="library-heading">
        <view className="appbar-copy">
          <view className="device-target-row">
            <SlButton
              className="device-target"
              variant="text"
              icon="speaker_group"
              iconSize={16}
              title="选择设备"
              disabled={state.loading}
              onClick={() => {
                navigation.devicePickerOpen = true;
              }}
            >
              <text className="device-target-prefix">播放到</text>
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
                  text-maxline="1"
                >
                  {state.deviceConnecting
                    ? "连接中"
                    : state.playerStatusState === "error"
                      ? "状态暂不可用"
                      : state.playerStatusState !== "ready"
                        ? "同步中"
                        : state.player.is_playing
                          ? "播放中"
                          : state.player.current_song
                            ? "已暂停"
                            : "待机"}
                </text>
              )}
            </view>
          </view>
        </view>
        <view className="appbar-actions row">
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
          <view className="playlist-context">
            <text className="playlist-context-text" text-maxline="1">
              {onThisPlaylist && state.player.is_playing
                ? "正在播放此歌单"
                : store.lastPlayedSong.value
                  ? `上次播放：${store.lastPlayedSong.value.title}`
                  : state.playlistProgress?.song_id
                    ? "上次播放的位置已保存"
                    : "暂无续播记录"}
            </text>
            <SlButton
              className="resume-playlist"
              variant="text"
              icon="play_arrow"
              label="继续播放"
              disabled={!canResume || state.playerBusy}
              onClick={() => run(store.resumePlaylist)}
            />
          </view>
        )}
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
                onClick={() => {
                  state.songSearch = "";
                }}
              />
            )}
            <SlButton
              variant="icon"
              icon="my_location"
              title="定位当前播放"
              onClick={() => run(locate)}
            />
          </view>
        )}
        {state.startupError ? (
          <SlEmptyState title="加载失败" description={state.startupError}>
            <SlButton
              label="重新加载"
              icon="refresh"
              onClick={() => run(store.initialize)}
            />
          </SlEmptyState>
        ) : state.loading || state.songsLoading ? (
          <view
            className="song-list-skeleton"
            accessibility-label={
              state.loading ? "正在加载歌单" : "正在加载歌曲"
            }
          >
            {state.selectedPlaylistId && <SongListHeader />}
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
            <SongListHeader />
            <scroll-view
              id="miot-song-list"
              className="songs-scroll"
              scroll-y
              bindscroll={(event: any) => {
                onScroll(Number(event.detail.scrollTop || 0));
                if (
                  Number(event.detail.scrollTop || 0) + height >=
                  songs.length * rowHeight - rowHeight * 10
                )
                  void store.loadMoreSongs();
              }}
            >
              <view
                style={{ height: `${first * rowHeight}px`, flexShrink: 0 }}
              />
              {songs.slice(first, end).map((song, index) => (
                <view
                  key={song.id}
                  className={classes([
                    "song-row",
                    state.player.current_song?.id === song.id && "selected",
                  ])}
                >
                  <view
                    className="song-play-target"
                    bindtap={() =>
                      run(() => store.playSong(song, first + index))
                    }
                  >
                    <text className="song-index">{first + index + 1}</text>
                    <Cover song={song} />
                    <view className="song-copy" event-through>
                      <text className="song-title" text-maxline="1">
                        {song.title || "未知歌曲"}
                      </text>
                      <text
                        className="song-mobile-artist muted"
                        text-maxline="1"
                      >
                        {song.artist || "未知艺术家"}
                      </text>
                    </view>
                    <text className="song-artist muted" text-maxline="1">
                      {song.artist || "未知艺术家"}
                    </text>
                    <text className="song-album muted" text-maxline="1">
                      {song.album || "未知专辑"}
                    </text>
                    <text className="song-duration muted">
                      {duration(song.duration)}
                    </text>
                  </view>
                  <view className="song-actions">
                    <SlButton
                      variant="icon"
                      icon="play_arrow"
                      title="播放歌曲"
                      className="song-action-play"
                      onClick={() =>
                        run(() => store.playSong(song, first + index))
                      }
                    />
                    {!state.playlists.find(
                      (p) => String(p.id) === state.selectedPlaylistId,
                    )?.is_virtual && (
                      <SlButton
                        variant="icon"
                        icon="more_vert"
                        title="歌曲操作"
                        onClick={() => {
                          navigation.selectOpen = true;
                          setSongAction({
                            song,
                            playlistId: state.selectedPlaylistId,
                          });
                        }}
                      />
                    )}
                  </view>
                </view>
              ))}
              <view
                style={{
                  height: `${Math.max(0, songs.length - end) * rowHeight}px`,
                  flexShrink: 0,
                }}
              />
              <view className="songs-page-feedback">
                <text className="muted">
                  {state.songsHasMore
                    ? `已加载 ${state.songs.length} 首${state.songsTotal !== null && !state.playlists.find((p) => String(p.id) === state.selectedPlaylistId)?.is_virtual ? ` / 共 ${state.songsTotal} 首` : ""}`
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
        <Modal className="song-action-sheet" close={closeSongActions}>
          <text className="section-title" text-maxline="2">
            {songAction.song.title || "歌曲操作"}
          </text>
          <SlButton
            label="从歌单移除"
            onClick={() => {
              const action = songAction;
              closeSongActions();
              run(() => remove(action.song, false, action.playlistId));
            }}
          />
          <SlButton
            className="danger-action"
            label="从曲库永久删除"
            onClick={() => {
              const action = songAction;
              closeSongActions();
              run(() => remove(action.song, true, action.playlistId));
            }}
          />
        </Modal>
      )}
    </view>
  );
}
function Settings() {
  useObserved(state, navigation);
  const { width, height } = useContext(Viewport),
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
      <view className="page-toolbar">
        <SlButton
          variant="icon"
          icon="arrow_back"
          title="返回"
          onClick={() =>
            wide && !navigation.editorOpen && !navigation.playerPopup
              ? ((navigation.settingsCategory = ""), closePage())
              : consumeBack()
          }
        />
        <text className="page-title">
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
                : "自动保存已开启"}
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
                {categories.map((item) => (
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
                    <view className="settings-nav-copy">
                      <text className="settings-nav-title">{item.title}</text>
                      <text className="settings-nav-subtitle" text-maxline="1">
                        {subtitle(item.id, item.description)}
                      </text>
                    </view>
                    {status(item.id) && (
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
                    <view className="settings-header">
                      <text className="settings-eyebrow">MIoT 设置</text>
                      <text className="settings-title">{item.title}</text>
                      <text className="settings-description">
                        {subtitle(item.id, item.description)}
                      </text>
                    </view>
                    <item.component />
                  </scroll-view>
                </view>
              ))}
          </view>
        </view>
      </CompactSettingsContext.Provider>
    </view>
  );
}
function Player() {
  const theme = useContext(ThemeContext);
  const { width, height } = useContext(Viewport),
    narrow = width < 600;
  const song = state.player.current_song;
  const details = useMemo(
    () => createPlayerDetails(get, () => state.player.current_song?.id),
    [],
  );
  useObserved(details, navigation, state.player);
  const lyrics = details.lyrics.value,
    lyricError = details.lyricError.value,
    lyricLoading = details.lyricLoading.value;
  const favorite = details.isFavorite.value,
    setFavorite = details.setFavorite;
  const swipeStart = useRef<number | null>(null);
  const [followLyrics, setFollowLyrics] = useState(true);
  const [sleepPanelHeight, setSleepPanelHeight] = useState(320);
  const [favoriteBusy, setFavoriteBusy] = useState(false);
  const [sleep, setSleep] = useState<SleepTimerStatus>({
    active: false,
    mode: "time",
    remaining: 0,
    total: 0,
  });
  const identity = `${state.currentAccountId}:${state.currentDeviceId}:${song?.id || ""}`;
  const identityRef = useRef(identity);
  identityRef.current = identity;
  useEffect(() => {
    void details.loadSongDetails();
    return details.dispose;
  }, [song?.id]);
  useEffect(() => {
    let alive = true;
    const refresh = () => {
      if (state.currentDeviceId)
        void get<SleepTimerStatus>(
          "/voice-commands/sleep-timer" + query(target()),
        )
          .then((result) => {
            if (alive) setSleep(result);
          })
          .catch(() => {});
    };
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [state.currentAccountId, state.currentDeviceId]);
  const activeLine = lyrics.reduce(
    (active, line, index) =>
      line.time <= Number(state.player.position || 0) ? index : active,
    -1,
  );
  useEffect(() => {
    setFollowLyrics(true);
  }, [identity, navigation.page]);
  useEffect(() => {
    if (
      followLyrics &&
      navigation.page === "player" &&
      activeLine >= 0 &&
      (width >= 600 || navigation.playerPage === 1)
    ) {
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
  }, [activeLine, navigation.playerPage, navigation.page, followLyrics]);
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
  async function setTimer(mode: "time" | "songs", value: number) {
    const result = await post<SleepTimerStatus>("/voice-commands/sleep-timer", {
      ...target(),
      mode,
      value,
    });
    if (identity === identityRef.current) {
      setSleep(result);
      navigation.playerPopup = "";
    }
  }
  const coverSize = Math.max(
    96,
    Math.min(
      narrow ? (height < 650 ? width * 0.54 : width * 0.72) : 360,
      narrow ? Math.max(96, height - 390) : height - 360,
    ),
  );
  const full = navigation.page === "player";
  const popup = navigation.playerPopup;
  const [popupPosition, setPopupPosition] = useState<Record<
    string,
    string
  > | null>(null);
  useEffect(() => {
    if (!popup) {
      setPopupPosition(null);
      return;
    }
    if (popup === "sleep") {
      setPopupPosition({
        width: `${Math.min(360, width - 32)}px`,
        maxHeight: `${Math.max(1, height - 32)}px`,
      });
      return;
    }
    let active = true;
    const sizes: Record<string, [number, number]> = {
      volume: [76, 292],
      mode: [160, 236],
      speed: [160, 296],
      more: [240, 236],
      sleep: [304, 420],
    };
    const [panelWidth, panelHeight] = sizes[popup] || sizes.more;
    setPopupPosition(null);
    void measurePopover(
      "#" + navigation.playerPopupAnchor,
      panelWidth,
      panelHeight,
    )
      .catch(() =>
        placePopover(
          { left: 0, top: 0, width, height },
          { left: width / 2, top: height - 48, width: 0, height: 40 },
          panelWidth,
          panelHeight,
        ),
      )
      .then((position) => {
        if (active) setPopupPosition(position);
      });
    return () => {
      active = false;
    };
  }, [popup, navigation.playerPopupAnchor, width, height, full]);
  const palette = paletteFromMetadata(song);
  const foreground =
    full && palette ? "#ffffff" : theme === "dark" ? "#E2E2E9" : "#191C20";
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
  const progress = (
    <view className="player-progress">
      <SlSlider
        key={song?.id || 0}
        modelValue={state.player.position || 0}
        max={state.player.duration || 1}
        disabled={!state.player.duration || song?.is_live || state.playerBusy}
        onCommit={(value: number) => run(() => store.seekPlayer(value))}
      />
      {full && (
        <view className="row time-row">
          <text>{duration(state.player.position)}</text>
          <text>
            {song?.is_live ? "直播" : duration(state.player.duration)}
          </text>
        </view>
      )}
    </view>
  );
  const controls = (
    <view className="player-controls row">
      {((full && narrow) || (!full && narrow && width >= 340)) && (
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
      <SlButton
        variant="icon"
        icon="skip_previous"
        title="上一首"
        iconSize={full && narrow ? 36 : 24}
        iconColor={foreground}
        disabled={state.playerBusy}
        onClick={() => run(() => store.playerCommand("/player/previous"))}
      />
      <SlButton
        variant={full || !narrow ? "filled" : "icon"}
        className="play-primary"
        icon={state.player.is_playing ? "pause" : "play_arrow"}
        title="播放/暂停"
        iconSize={full && narrow ? 46 : full ? 32 : 26}
        iconColor={full || !narrow ? undefined : "primary"}
        disabled={state.playerBusy}
        onClick={() => run(() => store.playerCommand("/player/toggle"))}
      />
      <SlButton
        variant="icon"
        icon="skip_next"
        title="下一首"
        iconSize={full && narrow ? 36 : 24}
        iconColor={foreground}
        disabled={state.playerBusy}
        onClick={() => run(() => store.playerCommand("/player/next"))}
      />
      {full && narrow && favoriteButton}
    </view>
  );
  return (
    <view
      flatten={false}
      className={full ? "player-full" : "player-mini"}
      style={
        full && palette ? { backgroundColor: palette.darkMuted } : undefined
      }
    >
      {full ? (
        <>
          <view
            className="player-ambient"
            style={
              palette
                ? {
                    backgroundImage: `linear-gradient(145deg, ${palette.vibrant}, ${palette.dominant})`,
                  }
                : undefined
            }
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
              style={
                palette ? { backgroundColor: palette.darkMuted } : undefined
              }
            />
          </view>
          <view className="page-toolbar fullscreen-topbar">
            <SlButton
              variant="icon"
              icon="keyboard_arrow_down"
              iconSize={32}
              iconColor={foreground}
              title="收起播放器"
              onClick={consumeBack}
            />
            <text className="fullscreen-topbar-title">正在播放</text>
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
                  <view className="player-copy desktop-meta">
                    <text className="song-title" text-maxline="1">
                      {song?.title || "暂无播放"}
                    </text>
                    <text className="muted">
                      {song?.artist || "未知艺术家"}
                    </text>
                    {song?.album && (
                      <text className="muted album-meta">{song.album}</text>
                    )}
                  </view>
                </view>
              )}
              {(!narrow || navigation.playerPage === 1) && (
                <view
                  className="lyrics-panel"
                  style={{
                    display:
                      !narrow || navigation.playerPage === 1 ? "flex" : "none",
                  }}
                >
                  <scroll-view
                    className="lyrics-scroll"
                    scroll-y
                    bindtouchmove={() => setFollowLyrics(false)}
                    bindwheel={() => setFollowLyrics(false)}
                    bindmousedown={() => setFollowLyrics(false)}
                  >
                    {lyricLoading && (
                      <text className="lyrics-empty">正在获取歌词…</text>
                    )}
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
              <text className="swipe-hint" event-through>
                {navigation.playerPage === 0 ? "左滑看歌词" : "右滑看封面"}
              </text>
            </view>
            <view className="fullscreen-playback">
              <view className="player-copy mobile-meta">
                <text className="song-title" text-maxline="1">
                  {song?.title || "暂无播放"}
                </text>
                <text className="muted">{song?.artist || "未知艺术家"}</text>
              </view>
              {progress}
              {controls}
              <view className="player-tools row">
                <view className="desktop-tool">
                  <SlButton
                    variant="icon"
                    icon={
                      modes.find(
                        (mode) => mode.value === state.player.play_mode,
                      )?.icon || "format_list_numbered"
                    }
                    popupTrigger
                    title="播放模式"
                    iconColor={foreground}
                    onClick={() => {
                      navigation.playerPopup = "mode";
                    }}
                  />
                </view>
                <view className="desktop-tool">{favoriteButton}</view>
                <SlButton
                  label={`${state.player.speed || 1}×`}
                  iconColor={foreground}
                  popupTrigger
                  title="播放速度"
                  onClick={() => {
                    navigation.playerPopup = "speed";
                  }}
                />
                <SlButton
                  variant="icon"
                  icon="volume_up"
                  popupTrigger
                  title="音量"
                  iconColor={foreground}
                  onClick={() => {
                    navigation.playerPopup = "volume";
                  }}
                />
                <SlButton
                  variant="icon"
                  icon="bedtime"
                  popupTrigger
                  title="延迟停止"
                  iconColor={foreground}
                  onClick={() => {
                    navigation.playerPopup = "sleep";
                  }}
                />
                <SlButton
                  variant="icon"
                  icon="more_vert"
                  popupTrigger
                  title="更多"
                  iconColor={foreground}
                  onClick={() => {
                    navigation.playerPopup = "more";
                  }}
                />
              </view>
            </view>
          </view>
        </>
      ) : (
        <>
          <view className="mini-progress">{progress}</view>
          <view className="mini-inner">
            <view className="mini-stage" bindtap={() => openPage("player")}>
              <Cover song={song} className="mini-cover" />
              <view className="player-copy">
                <text className="song-title" text-maxline="1">
                  {song?.title || "暂无播放"}
                </text>
                <text className="muted" text-maxline="1">
                  {song?.artist || "未知艺术家"}
                </text>
              </view>
            </view>
            <view className="mini-favorite">{favoriteButton}</view>
            {controls}
            <text className="mini-time">
              {duration(state.player.position)} /{" "}
              {duration(state.player.duration)}
            </text>
            <view className="player-tools row">
              <SlButton
                variant="icon"
                icon={
                  modes.find((mode) => mode.value === state.player.play_mode)
                    ?.icon || "format_list_numbered"
                }
                popupTrigger
                title="播放模式"
                onClick={() => {
                  navigation.playerPopup = "mode";
                }}
              />
              <SlButton
                variant="icon"
                icon="volume_up"
                popupTrigger
                title="音量"
                onClick={() => {
                  navigation.playerPopup = "volume";
                }}
              />
              <SlButton
                variant="icon"
                icon="bedtime"
                popupTrigger
                title="延迟停止"
                onClick={() => {
                  navigation.playerPopup = "sleep";
                }}
              />
              <SlButton
                variant="icon"
                icon="lyrics"
                title="歌词"
                onClick={() => {
                  navigation.playerPage = 1;
                  openPage("player");
                }}
              />
              <SlButton
                variant="icon"
                icon="stop"
                title="停止播放"
                onClick={() => run(() => store.playerCommand("/player/stop"))}
              />
              <SlButton
                variant="icon"
                icon="more_vert"
                className="mini-more"
                popupTrigger
                title="更多"
                onClick={() => {
                  navigation.playerPopup = "more";
                }}
              />
            </view>
          </view>
        </>
      )}
      {popup && popupPosition && (
        <Modal
          cardStyle={popupPosition}
          showClose={false}
          className={`player-popup player-popup-${popup} ${full ? "player-popup-full" : "player-popup-mini"}`}
          close={() => {
            navigation.playerPopup = "";
          }}
        >
          {popup === "mode" && (
            <>
              {modes.map((mode) => (
                <SlButton
                  key={mode.value}
                  icon={mode.icon}
                  label={
                    (state.player.play_mode === mode.value ? "✓ " : "") +
                    mode.label
                  }
                  onClick={() =>
                    run(async () => {
                      await store.setPlayMode(mode.value);
                      navigation.playerPopup = "";
                    })
                  }
                />
              ))}
            </>
          )}
          {popup === "speed" && (
            <>
              {[0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map((speed) => (
                <SlButton
                  key={speed}
                  label={speed + "×"}
                  onClick={() =>
                    run(async () => {
                      await store.setPlaybackSpeed(speed);
                      navigation.playerPopup = "";
                    })
                  }
                />
              ))}
            </>
          )}
          {popup === "volume" && (
            <VolumeControl
              key={state.currentAccountId + ":" + state.currentDeviceId}
              value={state.player.volume || 0}
              onChange={(value: number) => run(() => store.setVolume(value))}
            />
          )}
          {popup === "sleep" && (
            <>
              <view className="sleep-popup-header">
                <text className="section-title">延迟停止</text>
                <SlButton
                  variant="icon"
                  icon="close"
                  title="关闭延迟停止"
                  onClick={() => {
                    navigation.playerPopup = "";
                  }}
                />
              </view>
              <scroll-view
                className="sleep-popup-scroll"
                scroll-y
                style={{
                  height: `${Math.max(1, Math.min(sleepPanelHeight, height - 112))}px`,
                }}
              >
                <view
                  className="sleep-panel-content"
                  bindlayoutchange={(event) => {
                    const next = event.detail?.height;
                    if (next > 0) setSleepPanelHeight(next);
                  }}
                >
                  <SleepTimerPanel
                    status={sleep}
                    isLive={!!song?.is_live}
                    onSet={(mode: "time" | "songs", value: number) =>
                      run(() => setTimer(mode, value))
                    }
                    onCancel={() =>
                      run(async () => {
                        await post(
                          "/voice-commands/sleep-timer/cancel",
                          target(),
                        );
                        if (identity !== identityRef.current) return;
                        setSleep({
                          active: false,
                          mode: "time",
                          remaining: 0,
                          total: 0,
                        });
                        navigation.playerPopup = "";
                      })
                    }
                  />
                </view>
              </scroll-view>
            </>
          )}
          {popup === "more" && (
            <>
              <SlButton
                label={`音量 · ${state.player.volume || 0}%`}
                onClick={() => {
                  navigation.playerPopup = "volume";
                }}
              />
              <SlButton
                label={`倍速 · ${state.player.speed || 1}×`}
                onClick={() => {
                  navigation.playerPopup = "speed";
                }}
              />
              <SlButton
                label="延迟停止"
                onClick={() => {
                  navigation.playerPopup = "sleep";
                }}
              />
              <SlButton
                label="停止播放"
                onClick={() =>
                  run(async () => {
                    await store.playerCommand("/player/stop");
                    navigation.playerPopup = "";
                  })
                }
              />
              {song &&
                Number(state.player.playlist_id) > 0 &&
                !state.playlists.find((p) => p.id === state.player.playlist_id)
                  ?.is_virtual && (
                  <SlButton
                    label="从当前歌单移除"
                    onClick={() =>
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
                          navigation.playerPopup = "";
                        }
                      })
                    }
                  />
                )}
            </>
          )}
        </Modal>
      )}
    </view>
  );
}

function DevicePicker({ height }: { height: number }) {
  useObserved(state);
  const [search, setSearch] = useState("");
  const count = state.devices.reduce(
    (sum, account) => sum + account.devices.length,
    0,
  );
  const searchable = count > 8;
  const keyword = search.trim().toLowerCase();
  const accounts = state.devices
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
            label="添加账号与设备"
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
  useObserved(state, navigation);
  const [theme, setTheme] = useState(getTheme());
  const [width, setWidth] = useState(390);
  const [height, setHeight] = useState(800);
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
      () => [state.currentAccountId, state.currentDeviceId],
      connectChatSocket,
    );
    const lifecycle = onPush((event, raw) => {
      if (event === "lifecycle") {
        const phase = JSON.parse(String(raw)).state;
        if (phase === "resumed") {
          store.setAppVisible(true);
          setChatVisible(true);
        } else if (phase === "paused") {
          store.setAppVisible(false);
          setChatVisible(false);
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
        ])}
      >
        <Viewport.Provider value={{ width, height }}>
          <view className="main-shell">
            <SongList />
          </view>
          {navigation.page === "settings" && (
            <view className="settings-shell">
              <Settings />
            </view>
          )}
          {((store.currentDevice.value &&
            (state.player.current_song || width >= 600)) ||
            navigation.page === "player") && (
            <view className="player-slot">
              {navigation.page !== "settings" && <Player />}
            </view>
          )}
        </Viewport.Provider>
        {navigation.devicePickerOpen && <DevicePicker height={height} />}
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
