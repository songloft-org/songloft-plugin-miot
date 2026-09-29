<script setup lang="ts">
import SlIcon from './SlIcon.vue';

withDefaults(
  defineProps<{
    title: string;
    description?: string;
    icon?: string;
    open?: boolean;
  }>(),
  { open: false },
);
</script>

<template>
  <details class="sl-disclosure" :open="open">
    <summary>
      <span v-if="icon" class="sl-disclosure-icon"><SlIcon :name="icon" :size="19" /></span>
      <span class="sl-disclosure-copy">
        <strong>{{ title }}</strong>
        <small v-if="description">{{ description }}</small>
      </span>
      <SlIcon class="sl-disclosure-chevron" name="expand_more" :size="20" />
    </summary>
    <div class="sl-disclosure-content"><slot /></div>
  </details>
</template>
