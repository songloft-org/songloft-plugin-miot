<script setup lang="ts">
import { onMounted, onUnmounted, watch } from 'vue';
import MainPage from './views/MainPage.vue';
import SettingsPage from './views/SettingsPage.vue';
import FullscreenPlayer from './views/FullscreenPlayer.vue';
import Snackbar from './views/Snackbar.vue';
import ConfirmDialog from './views/ConfirmDialog.vue';
import { detectHostMode, navigation } from './runtime';
import { disposeStore, initialize, state } from './store';

onMounted(() => {
  detectHostMode();
  void initialize();
});

watch(
  () => navigation.page,
  () => {
    navigation.playerPopup = '';
  },
);

onUnmounted(disposeStore);
</script>

<template>
  <div class="miot-app">
    <div v-if="state.loading" class="app-state-page">
      <span class="loading-spinner" aria-hidden="true"></span>
      <p>正在加载</p>
    </div>
    <div v-else-if="state.startupError" class="app-state-page">
      <div class="state-icon"><span class="material-symbols-outlined">cloud_off</span></div>
      <h2>页面加载失败</h2>
      <p>{{ state.startupError }}</p>
      <button class="btn-filled" @click="initialize">重试</button>
    </div>
    <template v-else>
      <SettingsPage v-if="navigation.page === 'settings'" />
      <FullscreenPlayer v-if="navigation.page === 'player'" />
      <MainPage v-if="navigation.page !== 'settings' && navigation.page !== 'player'" />
    </template>
    <Snackbar />
    <ConfirmDialog />
  </div>
</template>
