<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue';
import AppBar from './AppBar.vue';
import DeviceSettings from './settings/DeviceSettings.vue';
import PlaybackSettings from './settings/PlaybackSettings.vue';
import VoiceSettings from './settings/VoiceSettings.vue';
import ScheduleSettings from './settings/ScheduleSettings.vue';
import ToolboxSettings from './settings/ToolboxSettings.vue';
import SlIcon from '../ui/SlIcon.vue';
import SlStatusChip from '../ui/SlStatusChip.vue';
import { closePage, navigation } from '../runtime';
import { state } from '../store';
import { openSelect } from '../ui/selectState';

const isNarrow = ref(typeof window !== 'undefined' && window.innerWidth < 600);
const categories = [
  { id: 'device', title: '设备', subtitle: '服务器、账号和设备分组', icon: 'speaker_group', component: DeviceSettings },
  { id: 'playback', title: '播放', subtitle: '格式、音量和触屏显示', icon: 'music_note', component: PlaybackSettings },
  { id: 'voice', title: '语音', subtitle: '监听、口令和搜索', icon: 'record_voice_over', component: VoiceSettings },
  { id: 'schedule', title: '定时', subtitle: '调度规则和执行日志', icon: 'schedule', component: ScheduleSettings },
  { id: 'toolbox', title: '工具箱', subtitle: 'URL、TTS 和操作结果', icon: 'construction', component: ToolboxSettings },
];
const currentCategory = computed(() => categories.find((category) => category.id === (navigation.settingsCategory || 'device')) || categories[0]);
const managedDeviceCount = computed(() => state.devices.reduce(
  (total, account) => total + account.devices.filter((device) => device.managed).length,
  0,
));
function categorySubtitle(category: (typeof categories)[number]): string {
  if (category.id === 'device') {
    const accountCount = state.accounts.length;
    return accountCount || managedDeviceCount.value
      ? `${accountCount} 个账号 · ${managedDeviceCount.value} 台受管理设备`
      : category.subtitle;
  }
  if (category.id === 'voice') {
    return state.config.conversation_monitor_enabled ? '监听运行中 · 口令与智能搜索' : category.subtitle;
  }
  if (category.id === 'schedule') {
    return state.schedules.length ? `${state.schedules.length} 个任务 · ${state.config.scheduled_tasks_enabled ? '已启用' : '已暂停'}` : category.subtitle;
  }
  if (category.id === 'toolbox' && state.operationLog.length) {
    return `${state.operationLog.length} 条最近操作结果`;
  }
  return category.subtitle;
}
function categoryStatus(category: (typeof categories)[number]): { label: string; tone: 'neutral' | 'success' | 'warning' } | null {
  if (category.id === 'device') {
    if (!state.accounts.length) return { label: '待配置', tone: 'warning' };
    return { label: `${managedDeviceCount.value} 台`, tone: managedDeviceCount.value ? 'success' : 'warning' };
  }
  if (category.id === 'voice') return { label: state.config.conversation_monitor_enabled ? '运行中' : '未启用', tone: state.config.conversation_monitor_enabled ? 'success' : 'neutral' };
  if (category.id === 'schedule') return { label: state.config.scheduled_tasks_enabled ? '已启用' : '已暂停', tone: state.config.scheduled_tasks_enabled ? 'success' : 'neutral' };
  return null;
}
const showMobileMenu = computed(() => isNarrow.value && !navigation.settingsCategory);
const appbarTitle = computed(() => isNarrow.value && navigation.settingsCategory ? currentCategory.value.title : '设置');
const settingsBody = ref<HTMLElement | null>(null);
const settingsContent = ref<HTMLElement | null>(null);
const mobileMenu = ref<HTMLElement | null>(null);
function resetSettingsViewport(): void {
  openSelect.value = null;
  navigation.editorOpen = false;
  settingsContent.value?.scrollTo?.(0, 0);
  mobileMenu.value?.scrollTo?.(0, 0);
  settingsBody.value?.scrollTo?.(0, 0);
  if (settingsBody.value) settingsBody.value.scrollTop = 0;
}
function setCategory(id: string) {
  resetSettingsViewport();
  navigation.settingsCategory = id;
  void nextTick(resetSettingsViewport);
}
function close() { resetSettingsViewport(); navigation.settingsCategory = ''; closePage(); }
function back() {
  resetSettingsViewport();
  if (isNarrow.value && navigation.settingsCategory) navigation.settingsCategory = '';
  else closePage();
}
function updateWidth() { isNarrow.value = window.innerWidth < 600; }
onMounted(() => window.addEventListener('resize', updateWidth));
onUnmounted(() => window.removeEventListener('resize', updateWidth));
</script>

<template>
  <div class="settings-page page-view">
    <div class="settings-appbar-shell">
      <div class="settings-appbar-inner">
        <AppBar :title="appbarTitle" back @back="back">
          <SlStatusChip v-if="state.configSaving" label="保存中" tone="info" icon="save" />
        </AppBar>
      </div>
    </div>
    <div ref="settingsBody" class="settings-scroll-body">
    <div class="settings-shell">
      <div v-if="showMobileMenu" ref="mobileMenu" class="settings-mobile-menu">
        <button v-for="category in categories" :key="category.id" class="settings-nav-item" @click="setCategory(category.id)">
          <span class="settings-nav-icon"><SlIcon :name="category.icon" :size="20" /></span>
          <span class="settings-nav-copy"><strong class="settings-nav-title">{{ category.title }}</strong><small class="settings-nav-subtitle">{{ categorySubtitle(category) }}</small></span>
          <SlStatusChip v-if="categoryStatus(category)" :label="categoryStatus(category)!.label" :tone="categoryStatus(category)!.tone" />
          <SlIcon name="chevron_right" :size="20" />
        </button>
      </div>
      <div v-else class="settings-layout">
        <nav class="settings-nav" aria-label="设置分类">
          <button v-for="category in categories" :key="category.id" class="settings-nav-item" :class="{ active: category.id === currentCategory.id }" @click="setCategory(category.id)">
            <span class="settings-nav-icon"><SlIcon :name="category.icon" :size="20" /></span>
            <span class="settings-nav-copy"><strong class="settings-nav-title">{{ category.title }}</strong><small class="settings-nav-subtitle">{{ categorySubtitle(category) }}</small></span>
            <SlStatusChip v-if="categoryStatus(category)" :label="categoryStatus(category)!.label" :tone="categoryStatus(category)!.tone" />
          </button>
        </nav>
        <section ref="settingsContent" class="settings-content">
          <div class="settings-header">
            <div class="settings-header-copy">
              <span class="settings-header-eyebrow">MIoT 设置</span>
              <h1>{{ currentCategory.title }}</h1>
              <p>{{ categorySubtitle(currentCategory) }}</p>
            </div>
          </div>
          <component :is="currentCategory.component" />
        </section>
      </div>
    </div>
    </div>
  </div>
</template>
