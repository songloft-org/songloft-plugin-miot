<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { navigation } from '../runtime';
import type { SleepTimerStatus } from '../types';
import SlButton from '../ui/SlButton.vue';
import SlIcon from '../ui/SlIcon.vue';
import SlInput from '../ui/SlInput.vue';

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

const customMode = ref<'time' | 'songs' | ''>('');
const customValue = ref('');
const customError = ref('');
const anchor = ref<HTMLElement | null>(null);
const popupStyle = ref<Record<string, string>>({});
const open = computed(() => navigation.playerPopup === props.popupId);
const statusLabel = computed(() => {
  if (!props.status.active) return '';
  if (props.status.mode === 'songs') return `还剩 ${props.status.remaining} 首`;
  return `还剩 ${Math.max(1, Math.ceil(props.status.remaining / 60000))} 分钟`;
});
const title = computed(() => props.status.active
  ? `延迟停止，${statusLabel.value}`
  : '延迟停止');

watch(open, (value) => {
  if (!value) {
    customMode.value = '';
    customValue.value = '';
    customError.value = '';
  }
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

// 自定义输入行出现/消失时重新定位
watch(customMode, () => {
  if (open.value) nextTick(positionPopup);
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

function choose(mode: 'time' | 'songs', value: number): void {
  customError.value = '';
  emit('set', mode, value);
}

function showCustom(mode: 'time' | 'songs'): void {
  customMode.value = mode;
  customValue.value = '';
  customError.value = '';
}

function submitCustom(): void {
  if (!customMode.value) return;
  const value = Number(customValue.value.trim());
  const max = customMode.value === 'time' ? 999 : 99;
  if (!Number.isInteger(value) || value < 1 || value > max) {
    customError.value = `请输入 1-${max} 的整数`;
    return;
  }
  choose(customMode.value, value);
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
        <div v-if="status.active" class="sleep-timer-status">
          <SlIcon name="alarm_on" :size="18" player-icon />
          <span>{{ statusLabel }}</span>
          <button type="button" :disabled="busy" @click="emit('cancel')">取消定时</button>
        </div>

        <div class="sleep-timer-section">
          <div class="sleep-timer-heading"><SlIcon name="schedule" :size="16" player-icon /><span>按时长</span></div>
          <div class="sleep-timer-options">
            <button type="button" :disabled="busy" @click="choose('time', 15)">15 分钟</button>
            <button type="button" :disabled="busy" @click="choose('time', 30)">30 分钟</button>
            <button type="button" :disabled="busy" @click="choose('time', 60)">1 小时</button>
            <button type="button" :disabled="busy" @click="showCustom('time')"><SlIcon name="edit" :size="16" player-icon />自定义</button>
          </div>
          <!-- .grid-cell 让输入框在这个 flex 行里能伸缩（容器已由 grid 改 flex，见 style.css） -->
          <div v-if="customMode === 'time'" class="sleep-timer-custom">
            <div class="grid-cell"><SlInput v-model="customValue" type="number" placeholder="分钟 (1-999)" aria-label="自定义分钟数" @submit="submitCustom" /></div>
            <SlButton variant="filled" label="设定" :disabled="busy" @click="submitCustom" />
          </div>
          <span v-if="customMode === 'time' && customError" class="sleep-timer-error">{{ customError }}</span>
        </div>

        <div v-if="!isLive" class="sleep-timer-section sleep-timer-section-bordered">
          <div class="sleep-timer-heading"><SlIcon name="queue_music" :size="16" player-icon /><span>按歌曲</span></div>
          <div class="sleep-timer-options">
            <button type="button" :class="{ selected: status.active && status.mode === 'songs' && status.remaining === 1 }" :disabled="busy" @click="choose('songs', 1)">1 首</button>
            <button type="button" :class="{ selected: status.active && status.mode === 'songs' && status.remaining === 3 }" :disabled="busy" @click="choose('songs', 3)">3 首</button>
            <button type="button" :class="{ selected: status.active && status.mode === 'songs' && status.remaining === 5 }" :disabled="busy" @click="choose('songs', 5)">5 首</button>
            <button type="button" :disabled="busy" @click="showCustom('songs')"><SlIcon name="edit" :size="16" player-icon />自定义</button>
          </div>
          <div v-if="customMode === 'songs'" class="sleep-timer-custom">
            <div class="grid-cell"><SlInput v-model="customValue" type="number" placeholder="歌曲数 (1-99)" aria-label="自定义歌曲数" @submit="submitCustom" /></div>
            <SlButton variant="filled" label="设定" :disabled="busy" @click="submitCustom" />
          </div>
          <span v-if="customMode === 'songs' && customError" class="sleep-timer-error">{{ customError }}</span>
        </div>
      </div>
    </template>
  </div>
</template>
