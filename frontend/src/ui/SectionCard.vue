<script setup lang="ts">
import SlIcon from './SlIcon.vue';

withDefaults(
  defineProps<{
    title: string;
    icon?: string;
    description?: string;
    tone?: 'default' | 'warning' | 'danger';
  }>(),
  { tone: 'default' },
);
</script>

<template>
  <section class="miot-section" :class="`miot-section-${tone}`">
    <header class="section-heading">
      <span v-if="icon" class="section-heading-icon" aria-hidden="true">
        <SlIcon :name="icon" :size="20" />
      </span>
      <span class="section-heading-copy">
        <h2 class="section-title">{{ title }}</h2>
        <span v-if="description" class="section-description">{{ description }}</span>
      </span>
      <span v-if="$slots.actions" class="section-heading-actions"><slot name="actions" /></span>
    </header>
    <div class="card miot-card">
      <slot />
    </div>
  </section>
</template>
