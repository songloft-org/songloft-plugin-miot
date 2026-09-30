<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { navigation } from '../runtime';
import { sleepTimerLabel } from '../sleepTimer';
import type { SleepTimerStatus } from '../types';
import SlButton from '../ui/SlButton.vue';
import SleepTimerPanel from './SleepTimerPanel.vue';

const props = defineProps<{
  status: SleepTimerStatus;
  popupId: string;
  disabled?: boolean;
  isLive?: boolean;
  busy?: boolean;
}>();
const emit = defineEmits<{
  refresh: [];
  set: [mode: 'time' | 'songs', value: number];
  cancel: [];
}>();

const anchor = ref<HTMLElement | null>(null);
const popupStyle = ref<Record<string, string>>({});
const open = computed(() => navigation.playerPopup === props.popupId);
const title = computed(() => {
  const label = sleepTimerLabel(props.status);
  return label ? `延迟停止，${label}` : '延迟停止';
});

/** 用 JS 计算弹层 fixed 坐标。脱离 .player-popup-anchor 的堆叠上下文，
 *  避免遮罩（z-index:231）压住弹层（z-index:232）导致点不到。 */
function positionPopup(): void {
  const el = anchor.value;
  if (!el) return;

  const rect = el.getBoundingClientRect();
  const vp = window.visualViewport;
  // 可视区域：优先用 visualViewport（有键盘时会更小），fallback window
  const viewHeight = vp ? vp.height : window.innerHeight;
  const viewTop = vp ? vp.offsetTop : 0;
  const viewBottom = viewTop + viewHeight;

  const popupWidth = 280;
  const maxWidth = Math.min(window.innerWidth - 32, popupWidth);
  const gap = 8;
  const edgeInset = 16;

  // PlayerBar 工具区右对齐，其余居中
  const isBarTools = el.closest('.player-bar-tools') !== null;
  const left = isBarTools
    ? Math.max(edgeInset, rect.right - maxWidth)
    : Math.max(edgeInset, Math.min(rect.left + rect.width / 2 - maxWidth / 2, window.innerWidth - maxWidth - edgeInset));

  // 优先向上弹出，上方空间不足则向下
  const spaceAbove = rect.top - viewTop - gap;
  const spaceBelow = viewBottom - rect.bottom - gap;
  const preferAbove = spaceAbove >= 240 || spaceAbove >= spaceBelow;
  const maxHeight = Math.max(120, (preferAbove ? spaceAbove : spaceBelow) - 16);

  const style: Record<string, string> = {
    width: `${maxWidth}px`,
    left: `${Math.round(left)}px`,
    maxHeight: `${Math.round(maxHeight)}px`,
  };
  if (preferAbove) {
    style.bottom = `${window.innerHeight - rect.top + gap}px`;
  } else {
    style.top = `${Math.round(rect.bottom + gap)}px`;
  }
  popupStyle.value = style;
}

function handleViewportChange(): void {
  if (open.value) positionPopup();
}

// 弹层打开时定位，关闭时清理
watch(open, (isOpen) => {
  if (isOpen) {
    nextTick(positionPopup);
    window.addEventListener('resize', handleViewportChange);
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', handleViewportChange);
      window.visualViewport.addEventListener('scroll', handleViewportChange);
    }
    return;
  }
  window.removeEventListener('resize', handleViewportChange);
  if (window.visualViewport) {
    window.visualViewport.removeEventListener('resize', handleViewportChange);
    window.visualViewport.removeEventListener('scroll', handleViewportChange);
  }
});

onBeforeUnmount(() => {
  window.removeEventListener('resize', handleViewportChange);
  if (window.visualViewport) {
    window.visualViewport.removeEventListener('resize', handleViewportChange);
    window.visualViewport.removeEventListener('scroll', handleViewportChange);
  }
});

function toggle(): void {
  if (open.value) {
    navigation.playerPopup = '';
    return;
  }
  navigation.playerPopup = props.popupId;
  emit('refresh');
}

// 选完就收：主程序 SleepTimerSheet.show / _SleepTimerOverlayPanel 都是回调 + 关浮层。
function choose(mode: 'time' | 'songs', value: number): void {
  emit('set', mode, value);
  navigation.playerPopup = '';
}

function cancel(): void {
  emit('cancel');
  navigation.playerPopup = '';
}
</script>

<template>
  <div ref="anchor" class="player-popup-anchor" @click.stop>
    <SlButton
      variant="icon"
      :icon="status.active ? 'alarm_on' : 'alarm'"
      player-icon
      class="player-tool-button"
      :title="title"
      :disabled="disabled"
      :class="{ 'player-control-active': status.active }"
      @click="toggle"
    />
    <template v-if="open">
      <div class="player-popup-dismiss" aria-label="关闭延迟停止面板" @click="navigation.playerPopup = ''"></div>
      <div class="player-sleep-popup" :style="popupStyle" role="dialog" aria-label="延迟停止">
        <SleepTimerPanel
          :status="status"
          :busy="busy"
          :is-live="isLive"
          @set="choose"
          @cancel="cancel"
        />
      </div>
    </template>
  </div>
</template>
