<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useSongCover } from '../covers';
import { usePlayerMaterial } from '../playerMaterial';
import { notifyHostFavorite, openPage } from '../runtime';
import { currentDevice, notify, playerCommand, seekPlayer, setPlayMode, setVolume, state } from '../store';
import { get, messageOf, post, query } from '../api';
import type { SleepTimerStatus } from '../types';
import SlButton from '../ui/SlButton.vue';
import SlIcon from '../ui/SlIcon.vue';
import PlayerBarMorePopup from './PlayerBarMorePopup.vue';
import PlayerModePopup from './PlayerModePopup.vue';
import PlayerSleepTimerPopup from './PlayerSleepTimerPopup.vue';
import PlayerVolumePopup from './PlayerVolumePopup.vue';

// ===== 断点与主程序一致 =====
//
// 主程序 responsive.dart：tablet=600 / desktop=900，迷你播放器只吃 600 这一档——
// `<600` 是手机档 MiniPlayer / AppCapsulePlayer.compact，`>=600` 是桌面档
// DesktopPlayer / AppCapsulePlayer.dense。插件过去用单一 760 档，600~760 这段
// 在手机和大屏之间反复横跳，和主程序对不上。
const viewportWidth = ref(window.innerWidth);
const playerMaterial = usePlayerMaterial();
const isWide = computed(() => viewportWidth.value >= 600);
// 胶囊 / 标准两种导航形态由宿主下发；运行时切主题要能跟着变。
const isCapsule = ref(document.documentElement.getAttribute('data-navigation-style') === 'capsule');
const density = computed(() => (isCapsule.value ? (isWide.value ? 'capsule-dense' : 'capsule-compact') : (isWide.value ? 'standard-desk' : 'standard-mobile')));

function syncLayoutState(): void {
  viewportWidth.value = window.innerWidth;
  isCapsule.value = document.documentElement.getAttribute('data-navigation-style') === 'capsule';
}
let styleObserver: MutationObserver | null = null;

const progressPercent = computed(() => {
  const dur = Number(state.player.duration || 0);
  const pos = Number(state.player.position || 0);
  return dur > 0 ? Math.min(100, (pos / dur) * 100) : 0;
});

function onProgressClick(event: MouseEvent): void {
  const dur = Number(state.player.duration || 0);
  if (dur <= 0 || state.playerBusy) return;
  const target = event.currentTarget as HTMLElement;
  const rect = target.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
  const position = Math.round(ratio * Math.max(0, dur - 3));
  seekPlayer(position);
}

function onProgressKeydown(event: KeyboardEvent): void {
  const duration = Number(state.player.duration || 0);
  if (duration <= 0 || state.playerBusy) return;
  const current = Number(state.player.position || 0);
  if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
    event.preventDefault();
    void seekPlayer(Math.max(0, current - 5));
  } else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
    event.preventDefault();
    void seekPlayer(Math.min(duration, current + 5));
  } else if (event.key === 'Home') {
    event.preventDefault();
    void seekPlayer(0);
  } else if (event.key === 'End') {
    event.preventDefault();
    void seekPlayer(duration);
  }
}

const isFavorite = ref(false);
const favoriteBusy = ref(false);
const sleepTimerBusy = ref(false);
const sleepTimer = ref<SleepTimerStatus>({ active: false, mode: 'time', remaining: 0, total: 0 });
const { src: cover, epoch: coverEpoch, onError: onCoverError, onLoad: onCoverLoad } = useSongCover(() => state.player.current_song, 96);

const hasSong = computed(() => !!state.player.current_song);
// 主程序 MiniPlayer（手机档）没有歌曲时整条不渲染；DesktopPlayer 保留占位。
// 胶囊档两档都跟主程序一致——没歌不占位。
const showBar = computed(() => {
  if (!currentDevice.value) return false;
  if (hasSong.value) return true;
  return !isCapsule.value && isWide.value;
});
// 主程序胶囊档也拿「内容行宽」和 AppCapsulePlayer.minWidthForTime(620) 比，低于就收起
// 时间、把宽度整块让给标题（compact 档是 infinity：手机档永不显示）。所以这里量
// `.player-bar` 的内容盒宽度，而不是拿视口宽凑一个经验阈值。
const barRowRef = ref<HTMLElement | null>(null);
const capsuleRowWidth = ref(0);
let barRowObserver: ResizeObserver | null = null;
const showTime = computed(() => (isCapsule.value ? capsuleRowWidth.value >= 620 : isWide.value));
// 主程序 MiniPlayer（标准手机档）在「上一首」左侧插一个播放模式按钮，但要宽度
// >= 340 才放（`_kPlayModeMinWidth`）；桌面档的播放模式在右侧工具栏里。
// 插件同样处理：够宽才内联到中央控制区，否则整条工具栏在手机档收起。
const showInlinePlayMode = computed(() => !isCapsule.value && !isWide.value && viewportWidth.value >= 340);
// 主程序 CompactPlayButton 图标 = 命中框 * 0.6；标准档中央键图标 20/24。
const playIconSize = computed(() => {
  if (isCapsule.value) return isWide.value ? 26 : 22;
  return isWide.value ? 24 : 26;
});

// ===== 「更多」菜单的收纳判定 =====
//
// 主程序 DesktopPlayer 用 `LayoutBuilder` 的 `maxWidth >= 300` 分档，300 是它那排十个
// 按钮（每枚约 30px）的总宽；胶囊 dense 档那一排有 7 枚、永远平铺。插件这排只有 5 枚
// （播放模式 / 音量 / 延迟停止 / 歌词 / 停止），所以两档都按「放得下就一枚不藏」判。
//
// 标准档：工具区是 `flex: 3` 的网格列，量到的列宽就是可用宽（所以 `.player-bar-tools`
// 必须 stretch 整列，否则量到的是内容宽、判定永远成立）。
//
// 胶囊档：整行是一个 flex 行，工具区 `flex: 0 0 auto` 不参与收缩，量不到「分给工具栏的
// 列宽」。改用「行内容宽 − 其它项实占宽 − 标题保底宽」当可用宽：这一行里只有标题是弹性
// 项，所以 `(行内容宽 − 标题宽 − 工具区宽)` 是**状态无关**的常量（收放「更多」时工具区
// 少一枚、标题正好多同样多），不会出现收进去又弹出来的抖动。
const toolsRef = ref<HTMLElement | null>(null);
const infoRef = ref<HTMLElement | null>(null);
const toolsWidth = ref(0);
const toolsCount = ref(0);
const infoWidth = ref(0);
let toolsObserver: ResizeObserver | null = null;
let infoObserver: ResizeObserver | null = null;

/** 平铺时的按钮数：播放模式 / 音量 / 延迟停止 / 歌词 / 停止。 */
const TOOLS_INLINE_COUNT = 5;
/** 标准档一枚工具按钮的宽度，5 枚 = 190（见 redesign.css 的 `.player-bar-tools > …`）。 */
const TOOLS_INLINE_MIN = TOOLS_INLINE_COUNT * 38;
/** 胶囊档标题的保底可读宽（约 5 个中文字）。比这更窄时把次要操作收进「更多」。 */
const TITLE_MIN_WIDTH = 132;

/** 胶囊档单枚按钮宽 = 命中框（dense 44 / compact 36）；工具区不收缩，量到的就是
 *  内容宽，除以可见枚数即单枚宽。 */
const capsuleToolUnit = computed(() => (toolsCount.value > 0 ? toolsWidth.value / toolsCount.value : 0));
const capsuleToolsNeed = computed(() => capsuleToolUnit.value * TOOLS_INLINE_COUNT);
/** 行内容宽里被「非弹性项 + 工具区」占掉的部分（封面 / 时间 / 收藏 / 中央控制 / 外边距）。 */
const capsuleReservedWidth = computed(() => Math.max(0, capsuleRowWidth.value - infoWidth.value - toolsWidth.value));
const standardToolsCompact = computed(() => !isCapsule.value && toolsWidth.value > 0 && toolsWidth.value < TOOLS_INLINE_MIN);
const capsuleToolsCompact = computed(() =>
  isCapsule.value && capsuleToolsNeed.value > 0 && capsuleRowWidth.value - capsuleReservedWidth.value - TITLE_MIN_WIDTH < capsuleToolsNeed.value,
);
const showMoreMenu = computed(() => standardToolsCompact.value || capsuleToolsCompact.value);

/** 量元素的内容盒宽度：减去左右 padding，与 Flutter `LayoutBuilder` 的
 *  `constraints.maxWidth` 同义（主程序就是拿这个值跟 minWidthForTime 比的）。 */
function contentWidth(el: HTMLElement): number {
  const style = getComputedStyle(el);
  const padding = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
  return Math.max(0, el.clientWidth - padding);
}

watch(barRowRef, (el) => {
  barRowObserver?.disconnect();
  barRowObserver = null;
  if (!el) return;
  capsuleRowWidth.value = contentWidth(el);
  if (typeof ResizeObserver === 'undefined') return;
  barRowObserver = new ResizeObserver(() => {
    capsuleRowWidth.value = contentWidth(el);
  });
  barRowObserver.observe(el);
});

watch(toolsRef, (el) => {
  toolsObserver?.disconnect();
  toolsObserver = null;
  if (!el) return;
  const measure = (): void => {
    toolsWidth.value = el.getBoundingClientRect().width;
    toolsCount.value = el.children.length;
  };
  measure();
  if (typeof ResizeObserver === 'undefined') return;
  toolsObserver = new ResizeObserver(measure);
  toolsObserver.observe(el);
});

watch(infoRef, (el) => {
  infoObserver?.disconnect();
  infoObserver = null;
  if (!el) return;
  infoWidth.value = el.getBoundingClientRect().width;
  if (typeof ResizeObserver === 'undefined') return;
  infoObserver = new ResizeObserver(() => {
    infoWidth.value = el.getBoundingClientRect().width;
  });
  infoObserver.observe(el);
});

const formattedPosition = computed(() => formatTime(Number(state.player.position || 0)));
const formattedDuration = computed(() => formatTime(Number(state.player.duration || 0)));

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

watch(() => state.player.current_song?.id, loadFavoriteStatus);
watch(() => [state.currentAccountId, state.currentDeviceId], loadSleepTimer);

onMounted(() => {
  syncLayoutState();
  window.addEventListener('resize', syncLayoutState);
  if (typeof MutationObserver !== 'undefined') {
    styleObserver = new MutationObserver(syncLayoutState);
    styleObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-navigation-style'] });
  }
  void loadFavoriteStatus();
  void loadSleepTimer();
});
onUnmounted(() => {
  window.removeEventListener('resize', syncLayoutState);
  styleObserver?.disconnect();
  styleObserver = null;
  toolsObserver?.disconnect();
  toolsObserver = null;
  infoObserver?.disconnect();
  infoObserver = null;
  barRowObserver?.disconnect();
  barRowObserver = null;
});

function openPlayer(): void {
  openPage('player');
}

/**
 * 与主程序 MiniPlayer 一致：整条播放栏都是展开播放器的点击面。
 * 控制按钮和进度条会自行 stop/位于播放栏外，不触发这里。
 */
function onBarSurfaceClick(event: MouseEvent): void {
  const target = event.target as HTMLElement | null;
  if (target?.closest('button, input, .player-popup-anchor')) return;
  openPlayer();
}

async function loadFavoriteStatus(): Promise<void> {
  const songId = state.player.current_song?.id;
  if (!songId) { isFavorite.value = false; return; }
  try {
    const result = await get<{ is_favorited: boolean }>(`/player/favorite/status?song_id=${songId}`);
    isFavorite.value = result.is_favorited;
  } catch {
    isFavorite.value = false;
  }
}

async function toggleFavorite(): Promise<void> {
  const id = state.player.current_song?.id;
  if (!id || favoriteBusy.value) return;
  const previous = isFavorite.value;
  const next = !previous;
  isFavorite.value = next;
  favoriteBusy.value = true;
  try {
    const result = await post<{ is_favorited: boolean }>('/player/favorite/toggle', {
      song_id: id,
      action: next ? 'add' : 'remove',
    });
    isFavorite.value = result.is_favorited;
    notify(result.is_favorited ? '已收藏' : '已取消收藏', 'success', 1800);
    notifyHostFavorite(id, result.is_favorited);
  } catch (error) {
    isFavorite.value = previous;
    notify(messageOf(error), 'error');
  } finally {
    favoriteBusy.value = false;
  }
}

async function loadSleepTimer(): Promise<void> {
  if (!state.currentAccountId || !state.currentDeviceId) {
    sleepTimer.value = { active: false, mode: 'time', remaining: 0, total: 0 };
    return;
  }
  try {
    sleepTimer.value = await get<SleepTimerStatus>(`/voice-commands/sleep-timer${query({
      account_id: state.currentAccountId,
      device_id: state.currentDeviceId,
    })}`);
  } catch {
    sleepTimer.value = { active: false, mode: 'time', remaining: 0, total: 0 };
  }
}

async function setSleepTimer(mode: 'time' | 'songs', value: number): Promise<void> {
  if (!state.currentAccountId || !state.currentDeviceId || sleepTimerBusy.value) return;
  sleepTimerBusy.value = true;
  try {
    sleepTimer.value = await post<SleepTimerStatus>('/voice-commands/sleep-timer', {
      account_id: state.currentAccountId,
      device_id: state.currentDeviceId,
      mode,
      value,
    });
    notify(mode === 'time' ? `将在 ${value} 分钟后停止` : `将在播放 ${value} 首后停止`, 'success');
  } catch (error) {
    notify(messageOf(error), 'error');
  } finally {
    sleepTimerBusy.value = false;
  }
}

async function cancelSleepTimer(): Promise<void> {
  if (!state.currentAccountId || !state.currentDeviceId || sleepTimerBusy.value) return;
  sleepTimerBusy.value = true;
  try {
    await post<{ cancelled: boolean }>('/voice-commands/sleep-timer/cancel', {
      account_id: state.currentAccountId,
      device_id: state.currentDeviceId,
    });
    sleepTimer.value = { active: false, mode: 'time', remaining: 0, total: 0 };
    notify('已取消延迟停止', 'success');
  } catch (error) {
    notify(messageOf(error), 'error');
  } finally {
    sleepTimerBusy.value = false;
  }
}
</script>

<template>
  <div
    v-if="showBar"
    class="player-bar-shell"
    :class="`player-bar-${density}`"
    :style="playerMaterial"
    title="打开全屏播放器"
    @click="onBarSurfaceClick"
  >
    <div
      class="player-bar-progress"
      role="slider"
      :tabindex="isCapsule ? -1 : 0"
      aria-label="播放进度"
      aria-valuemin="0"
      :aria-valuemax="Math.round(Number(state.player.duration || 0))"
      :aria-valuenow="Math.round(Number(state.player.position || 0))"
      @click.stop="onProgressClick"
      @keydown="onProgressKeydown"
    >
      <div class="player-bar-progress-track">
        <div class="player-bar-progress-fill" :style="{ width: progressPercent + '%' }"></div>
        <div class="player-bar-progress-thumb" :style="{ left: progressPercent + '%' }"></div>
      </div>
    </div>
    <div ref="barRowRef" class="player-bar">
      <!-- 左侧：歌曲信息 + 收藏按钮（收藏在手机档隐藏，与主程序一致） -->
      <div class="player-bar-left">
        <div ref="infoRef" class="player-bar-info" role="button" tabindex="0" aria-label="展开播放器" @click.stop="openPlayer" @keydown.enter.stop="openPlayer" @keydown.space.prevent.stop="openPlayer">
          <img v-if="cover" :key="coverEpoch" class="player-cover" :src="cover" :alt="state.player.current_song?.title || '歌曲封面'" @error="onCoverError" @load="onCoverLoad" />
          <div v-else class="player-cover player-cover-empty"><SlIcon name="music_note" :size="22" player-icon /></div>
          <div class="player-copy">
            <span class="player-title">{{ state.player.current_song?.title || '暂无播放' }}</span>
            <span class="player-subtitle">{{ state.player.current_song?.artist || currentDevice.name || '已选择设备' }}</span>
          </div>
        </div>
        <SlButton
          class="player-favorite-button player-bar-favorite"
          variant="icon"
          player-icon
          :icon="isFavorite ? 'favorite' : 'favorite_border'"
          :icon-size="22"
          :title="isFavorite ? '取消收藏' : '收藏'"
          :class="{ 'player-control-active': isFavorite }"
          :disabled="favoriteBusy || !state.player.current_song"
          @click.stop="toggleFavorite"
        />
      </div>

      <!-- 中间：播放控制（宽屏显示时间） -->
      <div class="player-bar-center" @click.stop>
        <div class="player-bar-center-controls">
          <PlayerModePopup
            v-if="showInlinePlayMode"
            :model-value="state.player.play_mode || 'order'"
            popup-id="bar-mode-inline"
            :disabled="state.playerBusy"
            @change="setPlayMode"
          />
          <SlButton variant="icon" icon="skip_previous" player-icon :icon-size="22" class="player-control-button" title="上一首" :disabled="state.playerBusy" @click="playerCommand('/player/previous')" />
          <SlButton
            class="bar-play-primary"
            variant="icon"
            player-icon
            :icon-size="playIconSize"
            :icon="state.player.is_playing ? 'pause' : 'play_arrow'"
            :title="state.player.is_playing ? '暂停' : '播放'"
            :disabled="state.playerBusy"
            @click="playerCommand('/player/toggle')"
          />
          <SlButton variant="icon" icon="skip_next" player-icon :icon-size="22" class="player-control-button" title="下一首" :disabled="state.playerBusy" @click="playerCommand('/player/next')" />
        </div>
        <div v-if="showTime" class="player-bar-time">
          <span>{{ formattedPosition }}</span>
          <span class="player-bar-time-sep">/</span>
          <span>{{ formattedDuration }}</span>
        </div>
      </div>

      <!-- 右侧：工具栏。胶囊档与「放不下」时把次要操作收进「更多」菜单 -->
      <div ref="toolsRef" class="player-bar-tools" @click.stop>
        <PlayerModePopup
          v-if="!showInlinePlayMode"
          :model-value="state.player.play_mode || 'order'"
          popup-id="bar-mode"
          :disabled="state.playerBusy"
          @change="setPlayMode"
        />
        <PlayerVolumePopup
          :model-value="Number(state.player.volume || 0)"
          popup-id="bar-volume"
          :disabled="state.playerBusy"
          @change="setVolume"
        />
        <PlayerSleepTimerPopup
          v-if="!showMoreMenu"
          :status="sleepTimer"
          popup-id="bar-sleep-timer"
          :disabled="!state.currentAccountId || !state.currentDeviceId"
          :busy="sleepTimerBusy"
          :is-live="!!state.player.current_song?.is_live"
          @refresh="loadSleepTimer"
          @set="setSleepTimer"
          @cancel="cancelSleepTimer"
        />
        <!-- 歌词：主程序胶囊/桌面工具栏都有。没有 current_song 时禁用；有歌没歌词
             也允许点（进全屏播放器看空歌词），只是弱化配色。 -->
        <SlButton
          variant="icon"
          icon="lyrics"
          class="player-tool-button player-lyrics-button"
          :class="{ 'player-tool-muted': !state.player.current_song?.lyric_url }"
          title="歌词"
          :icon-size="20"
          :disabled="!state.player.current_song"
          @click="openPlayer"
        />
        <PlayerBarMorePopup
          v-if="showMoreMenu"
          popup-id="bar-more"
          :sleep-timer="sleepTimer"
          :sleep-busy="sleepTimerBusy || !state.currentAccountId || !state.currentDeviceId"
          :disabled="state.playerBusy"
          :is-live="!!state.player.current_song?.is_live"
          @refresh="loadSleepTimer"
          @sleep="setSleepTimer"
          @cancel-sleep="cancelSleepTimer"
          @stop="playerCommand('/player/stop')"
        />
        <SlButton
          v-else
          variant="icon"
          icon="stop"
          player-icon
          class="player-tool-button"
          title="停止播放"
          :disabled="state.playerBusy"
          @click="playerCommand('/player/stop')"
        />
      </div>
    </div>
  </div>
</template>
