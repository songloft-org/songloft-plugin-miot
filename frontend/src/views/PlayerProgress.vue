<script setup lang="ts">
import { computed, ref, watch } from 'vue';

const props = withDefaults(
  defineProps<{ position: number; duration: number; mini?: boolean; disabled?: boolean }>(),
  { mini: false, disabled: false },
);
const emit = defineEmits<{ seek: [number] }>();

const dragging = ref(false);
const dragPosition = ref(props.position);
const safeDuration = computed(() => Math.max(0, Number(props.duration) || 0));
const safeMax = computed(() => Math.max(1, safeDuration.value - 3));
const displayPosition = computed(() => dragging.value ? dragPosition.value : Math.max(0, Number(props.position) || 0));
const progress = computed(() => safeDuration.value > 0 ? Math.min(1, displayPosition.value / safeDuration.value) : 0);
const progressStyle = computed(() => ({ width: `${progress.value * 100}%` }));
const thumbStyle = computed(() => {
  const percent = progress.value * 100;
  return { left: `calc(6px + ${percent}% - ${progress.value * 12}px)` };
});

watch(() => props.position, (value) => {
  if (!dragging.value) dragPosition.value = value;
});

function time(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds || 0));
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, '0')}`;
}

// --- Standard input range ---
function valueFrom(event: Event): number {
  return Number((event.target as HTMLInputElement).value);
}

function update(event: Event): void {
  dragging.value = true;
  dragPosition.value = valueFrom(event);
}

function commit(event: Event): void {
  if (!dragging.value) return;
  dragPosition.value = valueFrom(event);
  dragging.value = false;
  emit('seek', dragPosition.value);
}
</script>

<template>
  <div v-if="mini" class="player-mini-progress" aria-hidden="true">
    <div class="player-mini-progress-active" :style="progressStyle"></div>
  </div>
  <div v-else class="player-full-progress">
    <span class="player-progress-time">{{ time(displayPosition) }}</span>
    <div class="player-seek-shell">
      <div class="player-seek-track">
        <div class="player-seek-active" :style="progressStyle"></div>
      </div>
      <span class="player-seek-thumb" :style="thumbStyle"></span>
      <input
        class="player-seek-input"
        type="range"
        :value="displayPosition"
        :min="0"
        :max="safeMax"
        :step="1"
        :disabled="disabled || safeDuration <= 0"
        aria-label="播放进度"
        @input="update"
        @change="commit"
      />
    </div>
    <span class="player-progress-time">{{ time(safeDuration) }}</span>
  </div>
</template>
