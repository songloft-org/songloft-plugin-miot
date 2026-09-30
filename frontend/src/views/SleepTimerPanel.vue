<script setup lang="ts">
import { computed, ref } from 'vue';
import { sleepTimerLabel } from '../sleepTimer';
import type { SleepTimerStatus } from '../types';
import SlButton from '../ui/SlButton.vue';
import SlIcon from '../ui/SlIcon.vue';
import SlInput from '../ui/SlInput.vue';

// 延迟停止面板本体：按时长 / 按歌曲两组档位 + 自定义输入。
//
// 宿主外壳有两处，所以正文单独成组件，档位列表不再各写一份：
// - PlayerSleepTimerPopup：工具栏按钮旁带锚点的浮层（`.player-sleep-popup`）
// - PlayerBarMorePopup：「更多」菜单里的二级面板（菜单项拿不到锚点，就地展开）
const props = defineProps<{
  status: SleepTimerStatus;
  busy?: boolean;
  isLive?: boolean;
}>();
const emit = defineEmits<{
  set: [mode: 'time' | 'songs', value: number];
  cancel: [];
}>();

const customMode = ref<'time' | 'songs' | ''>('');
const customValue = ref('');
const customError = ref('');
const statusLabel = computed(() => sleepTimerLabel(props.status));

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
</template>
