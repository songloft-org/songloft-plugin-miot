<script setup lang="ts">
import { computed, onUnmounted, ref, useAttrs } from 'vue';

defineOptions({ inheritAttrs: false });

const props = withDefaults(
  defineProps<{
    modelValue: number;
    min?: number;
    max?: number;
    step?: number;
    disabled?: boolean;
    ariaLabel?: string;
    orientation?: 'horizontal' | 'vertical';
  }>(),
  { min: 0, max: 100, step: 1, orientation: 'horizontal' },
);
const emit = defineEmits<{ 'update:modelValue': [number]; change: [number] }>();
const attrs = useAttrs();
const track = ref<HTMLElement | null>(null);

function valueFrom(event: Event): number {
  return Number((event.target as HTMLInputElement).value);
}

function positionFromEvent(clientX: number, clientY: number): number {
  const el = track.value;
  if (!el) return props.modelValue;
  const rect = el.getBoundingClientRect();
  let ratio: number;
  if (props.orientation === 'vertical') {
    ratio = rect.height > 0 ? 1 - (clientY - rect.top) / rect.height : 0;
  } else {
    ratio = rect.width > 0 ? (clientX - rect.left) / rect.width : 0;
  }
  ratio = Math.max(0, Math.min(1, ratio));
  const value = props.min + ratio * (props.max - props.min);
  return Math.round(value / props.step) * props.step;
}

let dragging = false;

function onTouchStart(event: TouchEvent): void {
  if (props.disabled) return;
  const touch = event.touches[0];
  if (!touch) return;
  dragging = true;
  const val = positionFromEvent(touch.clientX, touch.clientY);
  emit('update:modelValue', val);
}

function onTouchMove(event: TouchEvent): void {
  if (!dragging) return;
  const touch = event.touches[0];
  if (!touch) return;
  event.preventDefault();
  const val = positionFromEvent(touch.clientX, touch.clientY);
  emit('update:modelValue', val);
}

function onTouchEnd(event: TouchEvent): void {
  if (!dragging) return;
  dragging = false;
  const touch = event.changedTouches[0];
  const val = touch ? positionFromEvent(touch.clientX, touch.clientY) : props.modelValue;
  emit('change', val);
}

function onMouseDown(event: MouseEvent): void {
  if (props.disabled) return;
  dragging = true;
  const val = positionFromEvent(event.clientX, event.clientY);
  emit('update:modelValue', val);
  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseup', onMouseUp);
}

function onMouseMove(event: MouseEvent): void {
  if (!dragging) return;
  event.preventDefault();
  const val = positionFromEvent(event.clientX, event.clientY);
  emit('update:modelValue', val);
}

function onMouseUp(event: MouseEvent): void {
  document.removeEventListener('mousemove', onMouseMove);
  document.removeEventListener('mouseup', onMouseUp);
  if (!dragging) return;
  dragging = false;
  const val = positionFromEvent(event.clientX, event.clientY);
  emit('change', val);
}

onUnmounted(() => {
  document.removeEventListener('mousemove', onMouseMove);
  document.removeEventListener('mouseup', onMouseUp);
});

const fillPercent = computed(() => {
  const range = props.max - props.min;
  if (range <= 0) return 0;
  return Math.max(0, Math.min(100, ((props.modelValue - props.min) / range) * 100));
});
</script>

<template>
  <div v-bind="attrs" class="sl-slider-wrap">
    <input
      class="sl-slider"
      type="range"
      :value="modelValue"
      :min="min"
      :max="max"
      :step="step"
      :disabled="disabled"
      :aria-label="ariaLabel"
      @input="emit('update:modelValue', valueFrom($event))"
      @change="emit('change', valueFrom($event))"
    />
  </div>
</template>
