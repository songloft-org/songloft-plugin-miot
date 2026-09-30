<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { navigation } from '../runtime';
import { sleepTimerLabel } from '../sleepTimer';
import type { SleepTimerStatus } from '../types';
import SlButton from '../ui/SlButton.vue';
import SlIcon from '../ui/SlIcon.vue';
import SleepTimerPanel from './SleepTimerPanel.vue';

// 「更多」菜单：播放栏工具区放不下全部按钮时，把次要操作收进这里
// （延迟停止 / 停止播放）；放得下时这个组件根本不渲染，见 PlayerBar。
//
// 菜单只列「动作行」，选一项执行一件事。延迟停止是唯一需要二级面板的动作：主程序
// CapsuleMiniPlayer._buildMoreMenu 也是把「睡眠定时」当菜单项、选中后再开
// SleepTimerSheet，而不是把时长档位摊在菜单里 —— 摊进去看着就不像菜单，点开只
// 见「15 分钟 / 30 分钟 / 1 小时」，更像误触了延迟停止。
// 菜单项拿不到锚点，所以二级不再起第二个浮层，就地在这个浮层里换成延迟停止面板。
const props = defineProps<{
  popupId: string;
  disabled?: boolean;
  sleepTimer: SleepTimerStatus;
  sleepBusy?: boolean;
  isLive?: boolean;
}>();
const emit = defineEmits<{
  refresh: [];
  sleep: [mode: 'time' | 'songs', value: number];
  cancelSleep: [];
  stop: [];
}>();

const stage = ref<'menu' | 'sleep'>('menu');
const anchor = ref<HTMLElement | null>(null);
const popupStyle = ref<Record<string, string>>({});
const open = computed(() => navigation.playerPopup === props.popupId);
const statusLabel = computed(() => sleepTimerLabel(props.sleepTimer));

/** 用 JS 计算弹层 fixed 坐标。脱离 .player-popup-anchor 的堆叠上下文，
 *  避免遮罩（z-index:231）压住弹层（z-index:232）导致点不到。 */
function positionPopup(): void {
  const el = anchor.value;
  if (!el) return;

  const rect = el.getBoundingClientRect();
  const vp = window.visualViewport;
  const viewHeight = vp ? vp.height : window.innerHeight;
  const viewTop = vp ? vp.offsetTop : 0;
  const viewBottom = viewTop + viewHeight;

  // 二级的延迟停止面板要跟上它自己的浮层同宽：档位是「15 分钟 / 30 分钟 / 1 小时 /
  // 自定义」四枚胶囊按钮，200 装不下会折成两行。
  const popupWidth = stage.value === 'sleep' ? 280 : 200;
  const maxWidth = Math.min(window.innerWidth - 32, popupWidth);
  const gap = 8;
  const edgeInset = 16;

  // PlayerBar 工具区右对齐，其余居中
  const isBarTools = el.closest('.player-bar-tools') !== null;
  const left = isBarTools
    ? Math.max(edgeInset, rect.right - maxWidth)
    : Math.max(edgeInset, Math.min(rect.left + rect.width / 2 - maxWidth / 2, window.innerWidth - maxWidth - edgeInset));

  const spaceAbove = rect.top - viewTop - gap;
  const spaceBelow = viewBottom - rect.bottom - gap;
  const preferAbove = spaceAbove >= 280 || spaceAbove >= spaceBelow;
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
  // 关掉菜单后回到一级，下次点开还是菜单本身
  stage.value = 'menu';
  window.removeEventListener('resize', handleViewportChange);
  if (window.visualViewport) {
    window.visualViewport.removeEventListener('resize', handleViewportChange);
    window.visualViewport.removeEventListener('scroll', handleViewportChange);
  }
});

// 二级面板比一级菜单宽且更高，切换后要重新定位
watch(stage, () => {
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
  navigation.playerPopup = open.value ? '' : props.popupId;
}

function openSleep(): void {
  stage.value = 'sleep';
  emit('refresh');
}

function backToMenu(): void {
  stage.value = 'menu';
}

// 选完就收：主程序 SleepTimerSheet.show / _SleepTimerOverlayPanel 都是
// 「回调 + 关浮层」，菜单项（停止播放）同样点完即关。插件过去选完还摊在那里，
// 用户得再点一下空白处才能收起，与主程序不一致。
function chooseSleep(mode: 'time' | 'songs', value: number): void {
  emit('sleep', mode, value);
  navigation.playerPopup = '';
}

function cancelSleep(): void {
  emit('cancelSleep');
  navigation.playerPopup = '';
}

function stopPlayback(): void {
  emit('stop');
  navigation.playerPopup = '';
}
</script>

<template>
  <div ref="anchor" class="player-popup-anchor" @click.stop>
    <!-- icon 用 more_vert（三点）：主程序 CapsuleMiniPlayer._buildMoreMenu 与
         DesktopPlayer 的溢出菜单都是 Icons.more_vert_rounded，写 expand_more 会变成
         下拉箭头，形状对不上。 -->
    <SlButton
      variant="icon"
      icon="more_vert"
      class="player-tool-button"
      title="更多"
      :disabled="disabled"
      @click="toggle"
    />
    <template v-if="open">
      <div class="player-popup-dismiss" aria-label="关闭更多菜单" @click="navigation.playerPopup = ''"></div>
      <div
        class="player-bar-more-popup"
        :style="popupStyle"
        :role="stage === 'sleep' ? 'dialog' : 'menu'"
        :aria-label="stage === 'sleep' ? '延迟停止' : '更多操作'"
      >
        <template v-if="stage === 'menu'">
          <!-- 延迟停止要求已选中真实设备，没设备时和工具条上的按钮一样置灰 -->
          <button type="button" role="menuitem" :disabled="disabled || sleepBusy" @click="openSleep">
            <SlIcon name="bedtime" :size="18" />
            <span class="player-bar-more-label">延迟停止</span>
            <span v-if="sleepTimer.active" class="player-bar-more-status">{{ statusLabel }}</span>
            <!-- 有二级面板才画箭头，免得好端端的动作行看着像能展开 -->
            <SlIcon name="chevron_right" :size="18" class="player-bar-more-chevron" />
          </button>
          <div class="player-bar-more-divider"></div>
          <button type="button" role="menuitem" :disabled="disabled" @click="stopPlayback">
            <SlIcon name="stop" :size="18" player-icon />
            <span class="player-bar-more-label">停止播放</span>
          </button>
        </template>

        <template v-else>
          <button type="button" class="player-bar-more-back" @click="backToMenu">
            <SlIcon name="arrow_back" :size="18" />
            <span class="player-bar-more-label">延迟停止</span>
          </button>
          <SleepTimerPanel
            :status="sleepTimer"
            :busy="sleepBusy"
            :is-live="isLive"
            @set="chooseSleep"
            @cancel="cancelSleep"
          />
        </template>
      </div>
    </template>
  </div>
</template>
