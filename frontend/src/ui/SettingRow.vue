<script setup lang="ts">
import SlIcon from './SlIcon.vue';

withDefaults(
  defineProps<{
    title: string;
    subtitle?: string;
    stacked?: boolean;
    icon?: string;
    disabled?: boolean;
  }>(),
  { stacked: false, disabled: false },
);
</script>

<template>
  <div
    class="setting-row"
    :class="{ 'setting-row-stacked': stacked, 'setting-row-disabled': disabled }"
  >
    <span v-if="icon || $slots.leading" class="setting-row-leading" aria-hidden="true">
      <slot name="leading"><SlIcon v-if="icon" :name="icon" :size="20" /></slot>
    </span>
    <div class="setting-row-copy">
      <div class="setting-row-title">{{ title }}</div>
      <div v-if="subtitle" class="setting-row-subtitle">{{ subtitle }}</div>
      <slot name="detail" />
    </div>
    <div class="setting-row-control"><slot /></div>
  </div>
</template>
