<script setup lang="ts">
defineProps<{ modelValue: boolean; disabled?: boolean; ariaLabel?: string }>();
const emit = defineEmits<{ 'update:modelValue': [boolean] }>();
</script>

<template>
  <input
    class="sl-checkbox"
    type="checkbox"
    :checked="modelValue"
    :disabled="disabled"
    :aria-label="ariaLabel"
    @change="emit('update:modelValue', ($event.target as HTMLInputElement).checked)"
  />
</template>
