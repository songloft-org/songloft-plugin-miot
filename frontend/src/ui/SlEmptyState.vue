<script setup lang="ts">
import SlIcon from './SlIcon.vue';

withDefaults(
  defineProps<{
    title: string;
    description?: string;
    icon?: string;
    compact?: boolean;
  }>(),
  { icon: 'inbox', compact: false },
);
</script>

<template>
  <div class="sl-empty-state" :class="{ 'sl-empty-state-compact': compact }">
    <span class="sl-empty-state-icon" aria-hidden="true"><SlIcon :name="icon" :size="compact ? 24 : 32" /></span>
    <strong>{{ title }}</strong>
    <span v-if="description">{{ description }}</span>
    <div v-if="$slots.default" class="sl-empty-state-actions"><slot /></div>
  </div>
</template>
