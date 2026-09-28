<script setup lang="ts">
import SlIcon from './SlIcon.vue';

// **单一 HTML 实现**（songloft-org/songloft#440；tests/run.mjs 有硬断言防止加回
// 原生控件分支）。按钮统一走宿主 components.css 的 M3 按钮类。
withDefaults(
  defineProps<{
    label?: string;
    icon?: string;
    playerIcon?: boolean;
    iconSize?: number;
    trailingIcon?: string;
    variant?: 'filled' | 'outlined' | 'text' | 'icon' | 'tonal';
    disabled?: boolean;
    title?: string;
    block?: boolean;
    type?: 'button' | 'submit';
  }>(),
  { variant: 'text', type: 'button' },
);
defineEmits<{ click: [MouseEvent] }>();
</script>

<template>
  <button
    class="sl-button"
    :class="[`sl-button-${variant}`, { 'sl-button-block': block }]"
    :disabled="disabled"
    :title="title"
    :aria-label="variant === 'icon' ? label || title : undefined"
    :type="type"
    @click="$emit('click', $event)"
  >
    <span class="sl-button-content">
      <SlIcon v-if="icon" :name="icon" :size="iconSize ?? (variant === 'icon' ? 22 : 18)" :player-icon="playerIcon" />
      <span v-if="label && variant !== 'icon'" class="sl-button-label">{{ label }}</span>
      <SlIcon v-if="trailingIcon" :name="trailingIcon" :size="18" />
    </span>
  </button>
</template>
