<script setup lang="ts">
import SlIcon from './SlIcon.vue';

withDefaults(
  defineProps<{
    label: string;
    tone?: 'neutral' | 'success' | 'warning' | 'error' | 'info';
    icon?: string;
  }>(),
  { tone: 'neutral' },
);
</script>

<template>
  <span class="sl-status-chip" :class="`sl-status-chip-${tone}`">
    <SlIcon v-if="icon" :name="icon" :size="15" />
    <span>{{ label }}</span>
  </span>
</template>
