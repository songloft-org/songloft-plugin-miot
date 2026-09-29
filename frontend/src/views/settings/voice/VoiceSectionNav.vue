<script setup lang="ts">
import SlIcon from '../../../ui/SlIcon.vue';

type VoicePanel = 'listen' | 'commands' | 'memory' | 'intelligence';

const props = defineProps<{
  modelValue: VoicePanel;
  panels: Array<{ id: VoicePanel; title: string; subtitle: string; icon: string }>;
}>();
const emit = defineEmits<{ 'update:modelValue': [VoicePanel] }>();
</script>

<template>
  <div class="voice-settings-overview">
    <div class="voice-settings-heading">
      <span class="settings-header-eyebrow">语音中枢</span>
      <strong>选择要配置的能力</strong>
      <span>基础监听、口令、记忆与智能搜索互相独立，按需逐项启用。</span>
    </div>
    <nav class="voice-section-nav" aria-label="语音设置分类">
      <button
        v-for="panel in props.panels"
        :key="panel.id"
        type="button"
        class="voice-section-nav-item"
        :class="{ active: props.modelValue === panel.id }"
        :aria-current="props.modelValue === panel.id ? 'page' : undefined"
        @click="emit('update:modelValue', panel.id)"
      >
        <span class="voice-section-nav-icon"><SlIcon :name="panel.icon" :size="20" /></span>
        <span><strong>{{ panel.title }}</strong><small>{{ panel.subtitle }}</small></span>
      </button>
    </nav>
  </div>
</template>
