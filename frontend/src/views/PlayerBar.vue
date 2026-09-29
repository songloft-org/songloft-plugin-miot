<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useSongCover } from '../covers';
import { notifyHostFavorite, openPage } from '../runtime';
import { currentDevice, notify, playerCommand, seekPlayer, setPlayMode, setVolume, state } from '../store';
import { get, messageOf, post, query } from '../api';
import type { SleepTimerStatus } from '../types';
import SlButton from '../ui/SlButton.vue';
import SlIcon from '../ui/SlIcon.vue';
import PlayerModePopup from './PlayerModePopup.vue';
import PlayerSleepTimerPopup from './PlayerSleepTimerPopup.vue';
import PlayerVolumePopup from './PlayerVolumePopup.vue';

const isWide = ref(window.innerWidth > 760);
function onResize() { isWide.value = window.innerWidth > 760; }
onMounted(() => window.addEventListener('resize', onResize));

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
  void loadFavoriteStatus();
  void loadSleepTimer();
});
onUnmounted(() => window.removeEventListener('resize', onResize));

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
  <div v-if="currentDevice" class="player-bar-shell" title="打开全屏播放器" @click="onBarSurfaceClick">
    <div
      class="player-bar-progress"
      role="slider"
      tabindex="0"
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
    <div class="player-bar">
      <!-- 左侧：歌曲信息 + 收藏按钮 -->
      <div class="player-bar-left">
        <div class="player-bar-info" role="button" tabindex="0" aria-label="展开播放器" @click.stop="openPlayer" @keydown.enter.stop="openPlayer" @keydown.space.prevent.stop="openPlayer">
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
          :title="isFavorite ? '取消收藏' : '收藏'"
          :class="{ 'player-control-active': isFavorite }"
          :disabled="favoriteBusy || !state.player.current_song"
          @click.stop="toggleFavorite"
        />
      </div>

      <!-- 中间：播放控制（宽屏显示时间） -->
      <div class="player-bar-center" @click.stop>
        <div class="player-bar-center-controls">
          <SlButton variant="icon" icon="skip_previous" player-icon :icon-size="22" class="player-control-button" title="上一首" :disabled="state.playerBusy" @click="playerCommand('/player/previous')" />
          <SlButton
            class="bar-play-primary"
            variant="icon"
            player-icon
            :icon-size="isWide ? 24 : 26"
            :icon="state.player.is_playing ? 'pause' : 'play_arrow'"
            :title="state.player.is_playing ? '暂停' : '播放'"
            :disabled="state.playerBusy"
            @click="playerCommand('/player/toggle')"
          />
          <SlButton variant="icon" icon="skip_next" player-icon :icon-size="22" class="player-control-button" title="下一首" :disabled="state.playerBusy" @click="playerCommand('/player/next')" />
        </div>
        <div class="player-bar-time">
          <span>{{ formattedPosition }}</span>
          <span class="player-bar-time-sep">/</span>
          <span>{{ formattedDuration }}</span>
        </div>
      </div>

      <!-- 右侧：工具栏（仅宽屏显示） -->
      <div class="player-bar-tools" @click.stop>
        <PlayerModePopup
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
          :status="sleepTimer"
          popup-id="bar-sleep-timer"
          :disabled="!state.currentAccountId || !state.currentDeviceId"
          :busy="sleepTimerBusy"
          :is-live="!!state.player.current_song?.is_live"
          @refresh="loadSleepTimer"
          @set="setSleepTimer"
          @cancel="cancelSleepTimer"
        />
        <SlButton variant="icon" icon="stop" player-icon class="player-tool-button" title="停止播放" :disabled="state.playerBusy" @click="playerCommand('/player/stop')" />
      </div>
    </div>
  </div>
</template>
