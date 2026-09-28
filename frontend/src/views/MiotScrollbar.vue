<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';

// 手写可拖动滚动条：原生滚动条命中区太窄，长歌单里几百首歌很难快速跳位。
// 依赖 MainPage 的定高虚拟列表：totalContentHeight = totalItems × rowHeight，
// 拇指位置与真实 scrollTop 一一对应，拖动时按 fraction 反算目标 scrollTop 交给
// MainPage 挪窗口 + setScrollTop。
const props = withDefaults(
  defineProps<{
    totalItems: number;
    rowHeight: number;
    viewportHeight: number;
    scrollTop: number;
    enabled?: boolean;
    labelBuilder?: (currentIndex: number, total: number) => string;
  }>(),
  { enabled: true },
);
const emit = defineEmits<{ seek: [fraction: number] }>();

const THUMB_MIN_HEIGHT = 40;
const TRACK_VERTICAL_PADDING = 4;
const HIDE_DELAY_MS = 1500;
// 桌面 vs 移动的分界与 responsive.dart 保持一致：桌面常驻，移动滚动 1.5s 后自动隐藏。
const DESKTOP_MIN_WIDTH = 900;

const trackRef = ref<HTMLElement | null>(null);
const isDragging = ref(false);
const dragFraction = ref(0);
const isVisible = ref(false);
let hideTimer: ReturnType<typeof setTimeout> | null = null;

const isDesktop = ref(false);
function measureIsDesktop(): void {
  isDesktop.value = typeof window !== 'undefined' && window.innerWidth >= DESKTOP_MIN_WIDTH;
}
measureIsDesktop();
if (typeof window !== 'undefined') window.addEventListener('resize', measureIsDesktop);

const totalContentHeight = computed(() => props.totalItems * props.rowHeight);
const maxScroll = computed(() => Math.max(0, totalContentHeight.value - props.viewportHeight));

const scrollFraction = computed(() => {
  if (maxScroll.value <= 0) return 0;
  return Math.max(0, Math.min(1, props.scrollTop / maxScroll.value));
});

const trackHeight = computed(() => Math.max(0, props.viewportHeight - TRACK_VERTICAL_PADDING * 2));

const thumbHeight = computed(() => {
  if (props.totalItems <= 0 || totalContentHeight.value <= 0) return THUMB_MIN_HEIGHT;
  const ratio = props.viewportHeight / totalContentHeight.value;
  return Math.max(THUMB_MIN_HEIGHT, Math.min(trackHeight.value, trackHeight.value * ratio));
});

const scrollableTrack = computed(() => Math.max(0, trackHeight.value - thumbHeight.value));

const displayFraction = computed(() => (isDragging.value ? dragFraction.value : scrollFraction.value));

const thumbTop = computed(() => TRACK_VERTICAL_PADDING + scrollableTrack.value * displayFraction.value);

const displayIndex = computed(() => {
  const raw = isDragging.value
    ? Math.round(dragFraction.value * (props.totalItems - 1))
    : (props.rowHeight > 0 ? Math.floor(props.scrollTop / props.rowHeight) : 0);
  return Math.max(1, Math.min(props.totalItems, raw + 1));
});

const showBar = computed(() => props.enabled && (isDesktop.value || isVisible.value || isDragging.value));

function poke(): void {
  if (!props.enabled) return;
  isVisible.value = true;
  if (hideTimer) clearTimeout(hideTimer);
  if (isDesktop.value) return;
  hideTimer = setTimeout(() => {
    if (!isDragging.value) isVisible.value = false;
  }, HIDE_DELAY_MS);
}

// scrollTop 变化时短暂显示滚动条（拖动时不重置隐藏定时）
watch(() => props.scrollTop, () => {
  if (!isDragging.value) poke();
});

function onDragStart(): void {
  isDragging.value = true;
  dragFraction.value = scrollFraction.value;
  if (hideTimer) clearTimeout(hideTimer);
}

function onDragDelta(deltaY: number): void {
  if (scrollableTrack.value <= 0) return;
  const next = Math.max(0, Math.min(1, dragFraction.value + deltaY / scrollableTrack.value));
  if (next === dragFraction.value) return;
  dragFraction.value = next;
  emit('seek', next);
}

function onDragEnd(): void {
  isDragging.value = false;
  poke();
}

function onTrackTap(clientY: number): void {
  const el = trackRef.value;
  if (!el) return;
  const rect = el.getBoundingClientRect();
  const y = clientY - rect.top;
  const scrollable = scrollableTrack.value;
  if (scrollable <= 0) return;
  // 让拇指中心对准点按位置，与拖动落点手感一致
  const centered = y - thumbHeight.value / 2;
  const fraction = Math.max(0, Math.min(1, centered / scrollable));
  dragFraction.value = fraction;
  emit('seek', fraction);
  poke();
}

// ------- 触屏 -------
let lastTouchY = 0;
function onTouchStart(event: TouchEvent): void {
  const touch = event.touches[0];
  if (!touch) return;
  const onThumb = (event.target as HTMLElement | null)?.classList.contains('miot-scrollbar-thumb');
  if (onThumb) {
    lastTouchY = touch.clientY;
    onDragStart();
  } else {
    onTrackTap(touch.clientY);
  }
}
function onTouchMove(event: TouchEvent): void {
  if (!isDragging.value) return;
  const touch = event.touches[0];
  if (!touch) return;
  event.preventDefault();
  onDragDelta(touch.clientY - lastTouchY);
  lastTouchY = touch.clientY;
}
function onTouchEnd(): void {
  if (!isDragging.value) return;
  onDragEnd();
}

// ------- 鼠标 -------
let lastMouseY = 0;
function onMouseDown(event: MouseEvent): void {
  const onThumb = (event.target as HTMLElement | null)?.classList.contains('miot-scrollbar-thumb');
  if (onThumb) {
    event.preventDefault();
    lastMouseY = event.clientY;
    onDragStart();
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  } else {
    onTrackTap(event.clientY);
  }
}
function onMouseMove(event: MouseEvent): void {
  if (!isDragging.value) return;
  event.preventDefault();
  onDragDelta(event.clientY - lastMouseY);
  lastMouseY = event.clientY;
}
function onMouseUp(): void {
  document.removeEventListener('mousemove', onMouseMove);
  document.removeEventListener('mouseup', onMouseUp);
  if (!isDragging.value) return;
  onDragEnd();
}

onUnmounted(() => {
  document.removeEventListener('mousemove', onMouseMove);
  document.removeEventListener('mouseup', onMouseUp);
  if (typeof window !== 'undefined') window.removeEventListener('resize', measureIsDesktop);
  if (hideTimer) clearTimeout(hideTimer);
});

defineExpose({ poke });
</script>

<template>
  <div
    v-if="enabled && totalItems > 0 && trackHeight > THUMB_MIN_HEIGHT"
    class="miot-scrollbar"
    :class="{ 'miot-scrollbar-visible': showBar, 'miot-scrollbar-dragging': isDragging }"
    @mousedown="onMouseDown"
    @touchstart.passive="onTouchStart"
    @touchmove="onTouchMove"
    @touchend="onTouchEnd"
    @touchcancel="onTouchEnd"
  >
    <div ref="trackRef" class="miot-scrollbar-track"></div>
    <div
      class="miot-scrollbar-thumb"
      :style="{ top: thumbTop + 'px', height: thumbHeight + 'px' }"
    ></div>
    <div
      v-if="isDragging && labelBuilder"
      class="miot-scrollbar-label"
      :style="{ top: Math.max(0, thumbTop + thumbHeight / 2 - 14) + 'px' }"
    >
      {{ labelBuilder(displayIndex, totalItems) }}
    </div>
  </div>
</template>
