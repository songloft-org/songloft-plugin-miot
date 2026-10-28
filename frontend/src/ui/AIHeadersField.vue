<script setup lang="ts">
import { computed } from 'vue';
import { parseAIHeaders } from '../../../src/utils/ai_headers';
const props = defineProps<{ modelValue: string; label: string; }>();
const emit = defineEmits<{ 'update:modelValue': [string]; change: []; }>();
const error = computed(() => {
  try { parseAIHeaders(props.modelValue); return ''; }
  catch (e) { return e instanceof Error ? e.message : '自定义请求头无效'; }
});
</script>

<template>
  <label class="ai-headers-field">
    <span>自定义请求头（可选，JSON 对象）</span>
    <textarea class="sl-input ai-headers-input" :aria-label="label" :aria-invalid="!!error" :value="modelValue" placeholder='{"x-opencode-session":"固定的会话 ID"}' spellcheck="false" @input="emit('update:modelValue', ($event.target as HTMLTextAreaElement).value)" @change="emit('change')"></textarea>
    <small>留空表示不添加。应用于此连接的模型列表、问答和分析请求；不能覆盖认证、JSON 类型或超时等内置请求头。</small>
    <small v-if="error" role="alert" class="ai-headers-error">{{ error }}</small>
  </label>
</template>

<style scoped>
.ai-headers-field { display: grid; gap: 8px; margin-block: 12px; min-width: 0; }
.ai-headers-input { min-height: 84px; resize: vertical; width: 100%; box-sizing: border-box; }
.ai-headers-error { color: var(--md-error); }
</style>
