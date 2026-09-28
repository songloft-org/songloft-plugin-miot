<script setup lang="ts">
import { withDefaults } from 'vue';

const props = withDefaults(
  defineProps<{
    modelValue: string;
    type?: 'text' | 'password' | 'number' | 'tel' | 'email' | 'url';
    placeholder?: string;
    disabled?: boolean;
    clearable?: boolean;
    ariaLabel?: string;
    inputKey?: string | number;
  }>(),
  { type: 'text', placeholder: '' },
);
const emit = defineEmits<{
  'update:modelValue': [string];
  change: [];
  submit: [];
}>();
</script>

<template>
  <input
    :key="inputKey"
    class="sl-input"
    :type="type"
    :value="modelValue"
    :placeholder="placeholder"
    :disabled="disabled"
    :aria-label="ariaLabel"
    @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
    @change="emit('change')"
    @keyup.enter="emit('submit')"
  />
</template>
