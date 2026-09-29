<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import AppBar from './AppBar.vue';
import DevicePicker from './DevicePicker.vue';
import MiotScrollbar from './MiotScrollbar.vue';
import PlayerBar from './PlayerBar.vue';
import SongRow from './SongRow.vue';
import SlButton from '../ui/SlButton.vue';
import SlIcon from '../ui/SlIcon.vue';
import SlInput from '../ui/SlInput.vue';
import SlListView from '../ui/SlListView.vue';
import SlSelect from '../ui/SlSelect.vue';
import SlEmptyState from '../ui/SlEmptyState.vue';
import { openSelect } from '../ui/selectState';
import { navigation, openPage } from '../runtime';
import { confirmAction, currentDevice, deviceName, lastPlayedSong, messageOf, playlistLabel, playSong, refreshAll, removeSongFromPlaylist, resumePlaylist, selectPlaylist, state, visibleSongs } from '../store';
import type { SelectOption, Song } from '../types';

const search = ref('');
const playlistOptions = computed<SelectOption[]>(() => state.playlists.map((p) => ({ value: String(p.id), label: playlistLabel(p), searchText: p.name })));
const noServerHint = computed(() => !state.config.server_host || state.config.server_host_status === 'loopback');
// 有进度记录 + 有设备才给「继续播放」。歌曲列表未必已加载完（歌名靠它取），
// 所以只用 playlistProgress 判断能不能续播，歌名有就显示在 title 里。
const canResume = computed(() => {
  if (!state.selectedPlaylistId || !currentDevice.value) return false;
  if (!state.playlistProgress?.song_id) return false;
  // 音箱此刻正播/正暂停在这个歌单上就不给「继续」：那一按等于把当前这首从头重放
  const onThisPlaylist = String(state.player.playlist_id ?? '') === state.selectedPlaylistId;
  return !(onThisPlaylist && (state.player.state === 'playing' || state.player.state === 'paused'));
});
const resumeTitle = computed(() => {
  const song = lastPlayedSong.value;
  return song ? `从上次播放的《${song.title || '未知歌曲'}》继续` : '从上次播放的那首继续';
});
const listMeasureRetries = 6;
let listMeasureTimer: ReturnType<typeof setTimeout> | null = null;
let locateTimer: ReturnType<typeof setTimeout> | null = null;
let mounted = false;

// ===== 双向虚拟列表 =====
//
// 为什么必须虚拟化（songloft-org/songloft-plugin-miot#96）：以前整份歌单一次性渲染，
// 1900 首歌就是 1900 个 SongRow 组件、1900 个封面防抖定时器、1900 个排队的封面请求。
// 列表容器的懒构建只省下绘制，组件实例与定时器这些开销全在 JS 侧照付，
// 于是「点定位卡好久 → 封面全空白 → 拖动很卡」：3 个并发封面槽被约 1900 个屏外行占满，
// 可见行永远排不上队。
//
// 做法是标准的定高窗口：只渲染 `[windowStart, windowEnd)`，上下各放一个占位条把未渲染
// 行的高度补齐，滚动条长度与真实列表一致，`scrollTop` 也保持原义（可以直接用
// `行号 × 行高` 换算），因此定位不再依赖 getBoundingClientRect 那套异步布局竞态。
/** 窗口在可视区之外上下各多渲染的行数，用来吸收滚动与重渲染之间的延迟。 */
const WINDOW_BUFFER_ROWS = 12;
/** 窗口起点漂移达到多少行才重渲染。太小则滚动时每帧都 patch，太大则来不及补空白。 */
const WINDOW_STEP_ROWS = 4;

const listRef = ref<InstanceType<typeof SlListView> | null>(null);
/** 行高（px），见 calibrateRowHeight：挂载时校准一次，之后每次量列表高度时再校准。 */
const rowHeight = ref(64);
/** 列表可视区高度（px），由 measureListHeight 写入。 */
const listHeight = ref(0);
/** 窗口起点的「意向值」，真正生效的是下面 clamp 过的 windowStart。 */
const rawWindowStart = ref(0);
/** 供自定义滚动条读取当前滚动位置：由轮询与 @scroll 同步，不依赖组件相互读写 DOM。 */
const currentScrollTop = ref(0);

const totalSongs = computed(() => visibleSongs.value.length);
const windowRows = computed(() => {
  const visible = rowHeight.value > 0 ? Math.ceil(listHeight.value / rowHeight.value) : 0;
  return Math.max(8, visible + WINDOW_BUFFER_ROWS * 2);
});
const windowStart = computed(() => {
  const maxStart = Math.max(0, totalSongs.value - windowRows.value);
  return Math.max(0, Math.min(rawWindowStart.value, maxStart));
});
const windowEnd = computed(() => Math.min(totalSongs.value, windowStart.value + windowRows.value));
const renderedSongs = computed(() => visibleSongs.value.slice(windowStart.value, windowEnd.value));
const leadSpacerHeight = computed(() => windowStart.value * rowHeight.value);
const tailSpacerHeight = computed(() => Math.max(0, (totalSongs.value - windowEnd.value) * rowHeight.value));

/**
 * 窗口位置的轮询兜底。
 *
 * 主路径是 `@scroll`。留这一路轮询兜底是因为失败代价不对称：事件万一不来，窗口就
 * 永不推进、往下滚全是空白，比不虚拟化更糟；而轮询的代价只是每 120ms 读一次
 * `scrollTop` 加几步算术。不同宿主环境上的事件派发行为不必然一致，所以不赌它。
 */
const WINDOW_POLL_MS = 120;
let windowPollTimer: ReturnType<typeof setInterval> | null = null;
/** 定位期间的静默期（时间戳）：这段时间内不让轮询把窗口拽回旧位置。 */
let locateGuardUntilMs = 0;

function startWindowPoll(): void {
  if (windowPollTimer) return;
  windowPollTimer = setInterval(() => {
    if (!mounted || !listRef.value) return;
    const top = listRef.value.scrollTop();
    currentScrollTop.value = top;
    if (Date.now() < locateGuardUntilMs) return;
    syncWindowToScroll(top);
  }, WINDOW_POLL_MS);
}

/**
 * 校准行高。
 *
 * 三级取值：真实渲染出来的行 > CSS 变量 > 默认 64。
 * 以真实行优先是因为整套换算的误差会被行号放大——行高差 1px，滚到第 1900 行就偏出约
 * 2000px（三十屏）。而前两级都可能拿不到：getComputedStyle 对自定义属性不保证有
 * 返回值，列表还没渲染时也量不到行。拿不到就退回上一级，绝不会写入 0。
 */
function calibrateRowHeight(): void {
  const row = document.querySelector<HTMLElement>('.song-row');
  const measured = row ? row.getBoundingClientRect().height : 0;
  if (measured > 0) {
    rowHeight.value = measured;
    return;
  }
  const parsed = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--miot-row-height'));
  if (parsed > 0) rowHeight.value = parsed;
}

/**
 * 按当前滚动位置推进窗口。漂移不足 WINDOW_STEP_ROWS 行时不动，避免滚动中反复重渲染；
 * 但窗口一旦盖不住可视区，就无条件跟上，不受漂移阈值约束。
 *
 * 为什么需要这条「盖不住就强制跟上」（songloft-org/songloft#448）：`desired` 被
 * `Math.max(0, …)` 削去了上缓冲，所以在顶部前 WINDOW_BUFFER_ROWS 行里窗口起点就等于
 * 首个可见行，任何滞后都不再被缓冲吸收。快速下滑再快速回滑时，回滑途中的某次采样可能
 * 落在 `floor(top / 行高) = 13..15`（把 rawWindowStart 定成 1..3），随后停在顶部那次采样
 * `desired = 0`、漂移只有 1..3 行 < 阈值，旧逻辑直接跳过：windowStart 永久停在 1..3，
 * 顶部前几首歌不渲染、只剩占位条撑出的 64..192px 空白，而且 120ms 轮询也永远救不回来
 * （漂移恒 < 阈值），只有再往下滚 17 行以上才解开。底部边界不受影响——那里 desired 超过
 * maxStart 会被 windowStart 的 clamp 修成精确值。
 *
 * 判据刻意用 clamp 后的 windowStart / windowEnd（即真正渲染出来的区间），也就是直接问
 * 「屏上有没有洞」，不为顶部/底部各写一条边界特例。正常滚动时缓冲 12 行 > 阈值 4 行，
 * uncovered 恒为 false，行为与旧实现一致；重复赋同值的 ref 不触发 patch，所以轮询每
 * 120ms 多判一次也没有额外重渲染开销。
 */
function syncWindowToScroll(top: number): void {
  const firstVisible = Math.max(0, Math.floor(top / rowHeight.value));
  const lastVisible = Math.min(totalSongs.value, Math.ceil((top + listHeight.value) / rowHeight.value));
  const desired = Math.max(0, firstVisible - WINDOW_BUFFER_ROWS);
  const uncovered = windowStart.value > firstVisible || windowEnd.value < lastVisible;
  if (uncovered || Math.abs(desired - rawWindowStart.value) >= WINDOW_STEP_ROWS) rawWindowStart.value = desired;
}

function onListScroll(event: Event): void {
  const target = event.currentTarget as HTMLElement | null;
  const top = target && typeof target.scrollTop === 'number' ? target.scrollTop : (listRef.value?.scrollTop() ?? 0);
  currentScrollTop.value = top;
  syncWindowToScroll(top);
}

function resetSongWindow(): void {
  rawWindowStart.value = 0;
  currentScrollTop.value = 0;
  // 回到顶部这段时间同样不能让轮询按旧 scrollTop 反推窗口。
  locateGuardUntilMs = Date.now() + 400;
  void nextTick(() => listRef.value?.setScrollTop(0));
}

/**
 * 拖动/点按自定义滚动条时的落点。fraction 是 [0, 1] 的目标滚动位置比例。
 *
 * 与 scrollToIndex 的路子一致：先按目标位置推进窗口再写 scrollTop，否则目标区域
 * 尚未布局时滚动范围未撑开、写入会被截断。这里还额外设置 locateGuardUntilMs，
 * 防止 120ms 轮询把窗口拽回旧位置。
 */
function seekToFraction(fraction: number): void {
  if (!mounted) return;
  const list = listRef.value;
  if (!list) return;
  const total = totalSongs.value;
  if (total <= 0 || rowHeight.value <= 0) return;
  const clamped = Math.max(0, Math.min(1, fraction));
  const totalHeight = total * rowHeight.value;
  const maxTop = Math.max(0, totalHeight - listHeight.value);
  const target = maxTop * clamped;
  rawWindowStart.value = Math.max(0, Math.floor(target / rowHeight.value) - WINDOW_BUFFER_ROWS);
  locateGuardUntilMs = Date.now() + 400;
  currentScrollTop.value = target;
  void nextTick(() => list.setScrollTop(target));
}

function measureListHeight(attempt = 0): void {
  if (!mounted) return;
  const list = document.querySelector<HTMLElement>('.sl-list-view');
  const player = document.querySelector<HTMLElement>('.player-bar-shell');
  const listTop = list?.getBoundingClientRect().top || 0;
  // 有播放条：列表填到播放条顶（它 fixed 在底部，`.miot-page-with-player` 已把
  // padding-bottom 归零）。无播放条：列表只能填到「视口底 − .miot-page 的
  // padding-bottom」—— 这段内边距是给 fixed 播放条预留的、无条件存在（移动端 90px）。
  // 旧写法恒用 innerHeight - 16 没算它，列表越过内容区底端把页面撑出约 74px，
  // 哪怕只有 1 首歌页面也出滚动条（songloft-org/songloft#410 后续报告）。
  let listBottom: number;
  if (player) {
    listBottom = player.getBoundingClientRect().top;
  } else {
    const page = list?.closest('.miot-page');
    const padBottom = page ? parseFloat(getComputedStyle(page).paddingBottom) || 0 : 0;
    listBottom = window.innerHeight - padBottom;
  }
  if (list && listTop > 0 && listBottom > listTop) {
    const height = Math.max(128, Math.round(listBottom - listTop));
    list.style.height = `${height}px`;
    // 窗口大小按可视区行数算，所以量到高度后要同步给虚拟列表。
    // 行也已经布局完了，顺便校准行高（这条重试阶梯本来就是等首次布局的）。
    listHeight.value = height;
    calibrateRowHeight();
    return;
  }
  if (attempt < listMeasureRetries) {
    listMeasureTimer = setTimeout(() => measureListHeight(attempt + 1), 32 * (attempt + 1));
  }
}

function remeasureList(): void {
  if (listMeasureTimer) clearTimeout(listMeasureTimer);
  void nextTick(() => measureListHeight());
}

async function onPlaylist(value: string) { await selectPlaylist(value); }
function openDevicePicker() {
  openSelect.value = null;
  navigation.devicePickerOpen = true;
}
async function play(song: Song, index: number) {
  try { await playSong(song, index); } catch (error) { /* store already presents the error */ notifyLocal(error); }
}
// 临时歌单（id<0，语音"播放歌手X"生成的一次性队列）不允许"删除"：它本来就不落库，
// 用户想要的语义只对真实歌单成立。songRemovable 也据此隐藏 SongRow 的按钮。
const songRemovable = computed(() => {
  const id = Number(state.selectedPlaylistId);
  return Number.isFinite(id) && id > 0;
});
async function removeSong(song: Song) {
  const result = await confirmAction(
    '从歌单删除',
    `确定从当前歌单删除《${song.title || '未知歌曲'}》吗？`,
    '删除',
    true,
    { label: '同时从曲库中永久删除歌曲文件', initial: false },
  );
  if (!result.confirmed) return;
  try { await removeSongFromPlaylist(song, { fromLibrary: result.checked }); } catch (error) { notifyLocal(error); }
}
async function resume() {
  try { await resumePlaylist(); } catch (error) { /* store already presents the error */ notifyLocal(error); }
}
function notifyLocal(error: unknown) { console.warn('[miot] play failed', messageOf(error)); }
/**
 * 滚到指定行并居中。
 *
 * 行是定高的，所以目标位置就是 `index × 行高`，不再需要旧写法那套
 * 「等新行布局完 → 量 getBoundingClientRect → 相对位移」——那套要跟异步布局赛跑，
 * 量到零尺寸就把 scrollTop 冲成 0（表现为"定位跳回第一屏"）。
 *
 * 仍要重试，但重试的判据变成「写进去的 scrollTop 生效了没有」：滚动范围要等
 * 布局完占位条才成立，在那之前写入会被钳掉。
 */
function scrollToIndex(index: number, attempt = 0): void {
  if (!mounted) return;
  const list = listRef.value;
  if (!list) return;
  const viewport = list.clientHeight();
  if (viewport <= 0) {
    if (attempt < listMeasureRetries) locateTimer = setTimeout(() => scrollToIndex(index, attempt + 1), 32 * (attempt + 1));
    return;
  }
  const target = Math.max(0, index * rowHeight.value - (viewport - rowHeight.value) / 2);
  // 先把窗口挪到目标位置再滚：否则滚过去时那一段还没渲染，会先看到一屏空白。
  rawWindowStart.value = Math.max(0, Math.floor(target / rowHeight.value) - WINDOW_BUFFER_ROWS);
  // scrollTop 真正落到 target 之前，轮询读到的还是旧位置，会把窗口拽回去。
  locateGuardUntilMs = Date.now() + 400;
  void nextTick(() => {
    list.setScrollTop(target);
    if (attempt >= listMeasureRetries) return;
    locateTimer = setTimeout(() => {
      // 容一行的误差：末尾几行滚不到正中是正常的（已经到底了）。
      if (Math.abs(list.scrollTop() - target) > rowHeight.value) scrollToIndex(index, attempt + 1);
    }, 48);
  });
}
function locateCurrentSong() {
  const currentIndex = visibleSongs.value.findIndex((song) => song.id === state.player.current_song?.id);
  if (currentIndex < 0) return;
  if (locateTimer) clearTimeout(locateTimer);
  scrollToIndex(currentIndex);
}
watch(() => [state.selectedPlaylistId, state.songSearch], resetSongWindow);
watch(
  () => [state.selectedPlaylistId, state.songsLoading, state.songsError, visibleSongs.value.length, !!currentDevice.value, noServerHint.value],
  remeasureList,
);
onMounted(() => {
  mounted = true;
  calibrateRowHeight();
  window.addEventListener('resize', remeasureList);
  remeasureList();
  startWindowPoll();
});
onUnmounted(() => {
  mounted = false;
  window.removeEventListener('resize', remeasureList);
  if (listMeasureTimer) clearTimeout(listMeasureTimer);
  if (locateTimer) clearTimeout(locateTimer);
  if (windowPollTimer) {
    clearInterval(windowPollTimer);
    windowPollTimer = null;
  }
});
</script>

<template>
  <div class="miot-main-appbar">
    <div class="miot-main-appbar-inner">
      <AppBar title="MIoT 智能音箱" :subtitle="state.deviceConnecting ? '正在连接音箱…' : currentDevice ? `${deviceName(currentDevice)} · ${state.player.is_playing ? '播放中' : '待机'}` : '请选择播放设备'">
        <SlButton variant="icon" icon="speaker_group" title="选择设备" @click="openDevicePicker" />
        <SlButton variant="icon" icon="refresh" title="刷新" :disabled="state.refreshing" @click="refreshAll" />
        <SlButton variant="icon" icon="settings" title="设置" @click="openPage('settings')" />
      </AppBar>
    </div>
  </div>

  <main class="miot-page" :class="{ 'miot-page-with-player': currentDevice }">

    <div v-if="noServerHint" class="status-panel">
      <div class="inline-fields">
        <SlIcon name="info" :size="18" />
        <span>{{ state.config.server_host_status === 'loopback' ? '服务器地址是本地回环地址，音箱无法访问。请在设置中改为局域网地址。' : '请先在设置中配置音箱可访问的 Songloft 服务器地址。' }}</span>
        <SlButton variant="text" label="去设置" @click="navigation.settingsCategory = 'device'; openPage('settings')" />
      </div>
    </div>

    <div class="player-toolbar">
      <div class="toolbar-field">
        <SlSelect leading-icon="queue_music" :model-value="state.selectedPlaylistId" :options="playlistOptions" placeholder="选择播放歌单" allow-empty searchable search-placeholder="搜索歌单" aria-label="选择歌单" @update:model-value="onPlaylist" />
      </div>
      <!-- 有上次播放记录才出现：从这个歌单自己的进度接着播，不受中间切过别的歌单影响 -->
      <SlButton
        v-if="canResume"
        variant="tonal"
        icon="play_arrow"
        label="继续播放"
        :disabled="state.playerBusy"
        :title="resumeTitle"
        @click="resume"
      />
    </div>

    <div v-if="state.selectedPlaylistId" class="search-bar">
      <SlIcon name="search" :size="20" />
      <SlInput :model-value="search" aria-label="搜索歌曲" placeholder="搜索歌曲、艺术家或专辑" @update:model-value="(v) => { search = v; state.songSearch = v; }" />
      <SlButton v-if="search" variant="icon" icon="close" title="清除搜索" @click="search = ''; state.songSearch = ''" />
      <SlButton variant="icon" icon="my_location" title="定位当前播放" @click="locateCurrentSong" />
    </div>

    <!-- 虚拟列表：两个占位条常驻（高度为 0 时也不摘掉），保持列表子节点结构稳定，
         避免窗口滑动时原生 ListView 的子节点索引整体错位。
         外层 miot-scrollbar-shell 是 position: relative，让自定义可拖动滚动条能覆盖在右侧。 -->
    <div v-if="state.selectedPlaylistId && !state.songsLoading && !state.songsError" class="miot-scrollbar-shell">
      <div class="song-list-header" aria-hidden="true">
        <span class="song-header-index">#</span>
        <span class="song-header-cover"></span>
        <span class="song-header-title">标题</span>
        <span class="song-header-artist">艺术家</span>
        <span class="song-header-album">专辑</span>
        <span class="song-header-duration">时长</span>
        <span class="song-header-actions"></span>
      </div>
      <SlListView ref="listRef" aria-label="歌曲列表" @scroll="onListScroll">
        <div class="song-list-spacer" :style="{ height: `${leadSpacerHeight}px` }"></div>
        <SongRow v-for="(song, index) in renderedSongs" :key="song.id" :song="song" :index="windowStart + index" :removable="songRemovable" @play="play" @remove="removeSong" />
        <div class="song-list-spacer" :style="{ height: `${tailSpacerHeight}px` }"></div>
        <div v-if="totalSongs === 0" class="song-list-empty">没有匹配的歌曲</div>
      </SlListView>
      <!-- 20 首以内没必要出滚动条，短列表用原生滚动更自然 -->
      <MiotScrollbar
        :total-items="totalSongs"
        :row-height="rowHeight"
        :viewport-height="listHeight"
        :scroll-top="currentScrollTop"
        :enabled="totalSongs > 20"
        :label-builder="(i, t) => `${i} / ${t}`"
        @seek="seekToFraction"
      />
    </div>
    <div v-else-if="state.songsLoading" class="song-list-empty"><span class="loading-spinner"></span><span>正在加载歌曲</span></div>
    <SlEmptyState v-else-if="state.songsError" title="歌曲加载失败" :description="state.songsError" icon="cloud_off">
      <SlButton variant="tonal" label="重新加载" icon="refresh" @click="selectPlaylist(state.selectedPlaylistId)" />
    </SlEmptyState>
    <SlEmptyState v-else title="选择一个歌单" description="选好歌单后，可以搜索、定位并直接推送到音箱播放。" icon="queue_music" />

    <PlayerBar />

  </main>
  <DevicePicker v-if="navigation.devicePickerOpen" @close="navigation.devicePickerOpen = false" />
</template>
