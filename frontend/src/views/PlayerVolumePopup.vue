<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { navigation } from '../runtime';
import SlButton from '../ui/SlButton.vue';
import SlSlider from '../ui/SlSlider.vue';

const props = defineProps<{ modelValue: number; popupId: string; disabled?: boolean }>();
const emit = defineEmits<{ change: [number] }>();

const anchor = ref<HTMLElement | null>(null);
const popupStyle = ref<Record<string, string>>({});

function clampVolume(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
}

const localVolume = ref(clampVolume(props.modelValue));
const previousVolume = ref(50);
const open = computed(() => navigation.playerPopup === props.popupId);
const icon = computed(() => {
  if (localVolume.value <= 0) return 'volume_off';
  if (localVolume.value < 30) return 'volume_mute';
  if (localVolume.value < 70) return 'volume_down';
  return 'volume_up';
});

watch(() => props.modelValue, (value) => { localVolume.value = clampVolume(value); });

/** 用 JS 计算弹层 fixed 坐标。胶囊档的 shell 用 `overflow: hidden` 把整宽顶边进度按
 *  pill 轮廓裁掉，absolute 弹层会被那层裁到只剩贴着胶囊顶边的几像素 —— 表现就是
 *  「弹出来看不见」。和播放模式 / 延迟停止 / 更多菜单一样改成 fixed，脱离
 *  .player-popup-anchor 的包含块与 shell 的裁剪。 */
function positionPopup(): void {
  const el = anchor.value;
  if (!el) return;

  const rect = el.getBoundingClientRect();
  const vp = window.visualViewport;
  const viewHeight = vp ? vp.height : window.innerHeight;
  const viewTop = vp ? vp.offsetTop : 0;
  const viewBottom = viewTop + viewHeight;

  const popupWidth = 64;
  const popupHeight = 200;
  const gap = 8;
  const edgeInset = 8;

  const left = Math.max(
    edgeInset,
    Math.min(rect.left + rect.width / 2 - popupWidth / 2, window.innerWidth - popupWidth - edgeInset),
  );
  const spaceAbove = rect.top - viewTop - gap;
  const spaceBelow = viewBottom - rect.bottom - gap;
  const preferAbove = spaceAbove >= popupHeight || spaceAbove >= spaceBelow;

  const style: Record<string, string> = {
    width: `${popupWidth}px`,
    height: `${popupHeight}px`,
    // 上下都不宽裕时按可用空间收，别把弹层顶到视口外
    maxHeight: `${Math.round(Math.max(176, (preferAbove ? spaceAbove : spaceBelow) - 8))}px`,
    left: `${Math.round(left)}px`,
  };
  if (preferAbove) {
    style.bottom = `${Math.round(window.innerHeight - rect.top + gap)}px`;
    style.top = 'auto';
  } else {
    style.top = `${Math.round(rect.bottom + gap)}px`;
    style.bottom = 'auto';
  }
  popupStyle.value = style;
}

function handleViewportChange(): void {
  if (open.value) positionPopup();
}

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
  if (!open.value) positionPopup();
  navigation.playerPopup = open.value ? '' : props.popupId;
}

function update(value: number): void {
  localVolume.value = clampVolume(value);
}

function commit(value: number): void {
  update(value);
  emit('change', localVolume.value);
}

function toggleMute(): void {
  if (localVolume.value > 0) {
    previousVolume.value = localVolume.value;
    commit(0);
  } else {
    commit(previousVolume.value || 50);
  }
}
</script>

<template>
  <div ref="anchor" class="player-popup-anchor" @click.stop>
    <SlButton variant="icon" :icon="icon" player-icon class="player-tool-button" title="音量" :disabled="disabled" @click="toggle" />
    <template v-if="open">
      <div class="player-popup-dismiss" aria-label="关闭音量面板" @click="navigation.playerPopup = ''"></div>
      <div class="player-volume-popup" :style="popupStyle" aria-label="音量控制">
        <span class="player-volume-value">{{ Math.round(localVolume) }}%</span>
        <div class="player-volume-slider-shell">
          <SlSlider
            class="player-volume-slider"
            :model-value="localVolume"
            :min="0"
            :max="100"
            orientation="vertical"
            aria-label="设备音量"
            @update:model-value="update"
            @change="commit"
          />
        </div>
        <SlButton variant="icon" :icon="icon" player-icon class="player-tool-button" :title="localVolume > 0 ? '静音' : '取消静音'" @click="toggleMute" />
      </div>
    </template>
  </div>
</template>
