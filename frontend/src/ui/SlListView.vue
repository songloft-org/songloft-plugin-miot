<script setup lang="ts">
import { ref } from 'vue';

defineProps<{ ariaLabel?: string }>();
const emit = defineEmits<{ scroll: [Event] }>();

/**
 * 滚动位置的读写与 `@scroll` 事件，供 MainPage 的虚拟列表定位窗口用。
 */
const root = ref<HTMLElement | null>(null);

/** 当前滚动位置（px）。列表尚未布局时为 0。 */
function scrollTop(): number {
  return root.value?.scrollTop ?? 0;
}

/** 滚到指定位置。 */
function setScrollTop(value: number): void {
  if (!root.value) return;
  root.value.scrollTop = Math.max(0, Math.round(value));
}

/** 可视区高度（px）。用来决定虚拟窗口要渲染多少行。 */
function clientHeight(): number {
  return root.value?.clientHeight ?? 0;
}

defineExpose({ scrollTop, setScrollTop, clientHeight });
</script>

<template>
  <div ref="root" class="sl-list-view" :aria-label="ariaLabel" @scroll="emit('scroll', $event)">
    <slot />
  </div>
</template>
