<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import SectionCard from '../../ui/SectionCard.vue';
import SettingRow from '../../ui/SettingRow.vue';
import SlButton from '../../ui/SlButton.vue';
import SlInput from '../../ui/SlInput.vue';
import SlSelect from '../../ui/SlSelect.vue';
import SlSwitch from '../../ui/SlSwitch.vue';
import AIHeadersField from '../../ui/AIHeadersField.vue';
import { parseAIHeaders } from '../../../../src/utils/ai_headers';
import { get, post } from '../../api';
import { AI_PRESET_PROVIDERS } from '../../aiPresets';
import { messageOf, notify, saveConfig, state } from '../../store';
import { navigation } from '../../runtime';

const selectedPreset = ref('custom'), customModel = ref(false);
const models = ref<Array<{ id: string; ownedBy?: string }>>([]);
const loading = ref(false), modelError = ref(''), latency = ref<number | null>(null);
const connectionState = ref<'idle' | 'loading' | 'ok' | 'error'>('idle');
const testQuery = ref(''), testResult = ref(''), testBusy = ref(false);
const customHeaders = ref(JSON.stringify(state.config.ai_config.custom_headers || {}, null, 2));
let alive = true, requestVersion = 0;
const presetOptions = [
  { value: 'custom', label: '自定义（OpenAI 兼容）' },
  ...AI_PRESET_PROVIDERS.map(p => ({ value: p.id, label: p.name, searchText: p.name })),
];
const preset = computed(() => AI_PRESET_PROVIDERS.find(p => p.id === selectedPreset.value));
const CUSTOM_MODEL = '__custom_model__';
const modelOptions = computed(() => [...models.value.map(m => ({ value: m.id, label: m.ownedBy ? `${m.id} (${m.ownedBy})` : m.id, searchText: m.id })), { value: CUSTOM_MODEL, label: '自定义模型名…' }]);
const modelValue = computed(() => customModel.value ? CUSTOM_MODEL : state.config.ai_config.model || '');
const signature = () => {
  let headers: unknown = customHeaders.value;
  try { headers = parseAIHeaders(customHeaders.value); } catch { }
  return JSON.stringify([state.config.ai_config.api_url, state.config.ai_config.api_key, headers]);
};
const connectionText = computed(() => ({ idle: '尚未检测连接', loading: '检测连接中…', ok: `已连接 · ${latency.value} ms`, error: `连接失败：${modelError.value}` })[connectionState.value]);

function syncPreset() {
  const url = (state.config.ai_config.api_url || '').trim().replace(/\/+$/, '');
  selectedPreset.value = AI_PRESET_PROVIDERS.find(p => p.baseUrl.replace(/\/+$/, '') === url)?.id || 'custom';
}
async function saveConnection() {
  let headers: Record<string, string>;
  try { headers = parseAIHeaders(customHeaders.value); }
  catch (error) { notify(messageOf(error), 'error'); throw error; }
  await saveConfig({ ai_config: { ...state.config.ai_config, custom_headers: headers } });
}
async function applyPreset(id: string) {
  selectedPreset.value = id;
  const next = AI_PRESET_PROVIDERS.find(p => p.id === id);
  if (!next) return;
  state.config.ai_config.api_url = next.baseUrl;
  if (next.defaultModel) state.config.ai_config.model = next.defaultModel;
  customModel.value = true;
  try { await saveConnection(); } catch { }
}
function selectModel(value: string) {
  customModel.value = value === CUSTOM_MODEL;
  if (customModel.value) return;
  state.config.ai_config.model = value;
  void saveConnection().catch(() => { });
}
async function refreshModels(silent = false) {
  const version = ++requestVersion, identity = signature();
  const current = () => alive && version === requestVersion && identity === signature();
  if (!state.config.ai_config.api_url || !state.config.ai_config.api_key) return;
  loading.value = true; modelError.value = ''; connectionState.value = 'loading';
  const started = Date.now();
  try {
    if (!silent) await saveConnection();
    if (!current()) return;
    const result = await get<{ models: Array<{ id: string; ownedBy?: string }> }>('/voice-commands/models');
    if (!current()) return;
    models.value = Array.isArray(result.models) ? result.models : [];
    latency.value = Date.now() - started; connectionState.value = 'ok';
    customModel.value = !!state.config.ai_config.model && !models.value.some(m => m.id === state.config.ai_config.model);
    if (!silent) notify(`已获取 ${models.value.length} 个模型`, 'success');
  } catch (error) {
    if (!current()) return;
    models.value = []; modelError.value = messageOf(error); connectionState.value = 'error'; customModel.value = true;
    if (!silent) notify(modelError.value, 'error');
  } finally { if (current()) loading.value = false; }
}
async function enableAnalysis(enabled: boolean) {
  if (enabled && !state.config.voice_command_enabled) { notify('请先开启语音口令', 'warning'); return; }
  try { await saveConfig({ ai_config: { ...state.config.ai_config, enabled } }); } catch { }
}
async function testAnalysis() {
  if (testBusy.value || !testQuery.value.trim()) return;
  testBusy.value = true; testResult.value = '';
  const question = testQuery.value.trim();
  const identity = JSON.stringify([signature(), state.config.ai_config.model, state.config.ai_config.timeout]);
  const current = () => alive && testQuery.value.trim() === question && identity === JSON.stringify([signature(), state.config.ai_config.model, state.config.ai_config.timeout]);
  try {
    await saveConnection();
    if (!current()) return;
    const result = await post<Record<string, unknown>>('/voice-commands/ai-test', { query: question });
    if (current()) testResult.value = JSON.stringify(result, null, 2);
  } catch (error) { if (current()) testResult.value = messageOf(error); }
  finally { if (alive) testBusy.value = false; }
}
watch(signature, () => { requestVersion++; models.value = []; loading.value = false; modelError.value = ''; latency.value = null; connectionState.value = 'idle'; syncPreset(); });
watch(() => JSON.stringify(state.config.ai_config.custom_headers || {}), () => { customHeaders.value = JSON.stringify(state.config.ai_config.custom_headers || {}, null, 2); });
onMounted(() => { syncPreset(); customModel.value = !!state.config.ai_config.model; void refreshModels(true); });
onUnmounted(() => { alive = false; requestVersion++; });
</script>

<template>
  <SectionCard title="默认模型连接" icon="auto_awesome" description="口令分析与 AI 对话可共用此连接。即使未开启口令分析，也能用于对话。">
    <div class="form-body">
      <div class="field"><label class="field-label">服务商</label><SlSelect :model-value="selectedPreset" :options="presetOptions" aria-label="选择 AI 预设服务商" @update:model-value="applyPreset" /></div>
      <div v-if="selectedPreset === 'custom'" class="field"><label class="field-label">API 地址</label><SlInput v-model="state.config.ai_config.api_url" aria-label="默认 AI API 地址" placeholder="https://api.example.com/v1" @change="saveConnection().catch(() => {})" /></div>
      <div class="field"><label class="field-label">API 密钥</label><SlInput v-model="state.config.ai_config.api_key" type="password" aria-label="默认 AI API 密钥" @change="saveConnection().catch(() => {})" /></div>
      <AIHeadersField v-model="customHeaders" label="默认 AI 自定义请求头" @change="saveConnection().catch(() => {})" />
      <a v-if="preset" class="preset-key-link" :href="preset.apiKeyUrl" target="_blank" rel="noopener">前往 {{ preset.name }} 获取 API Key ↗</a>
      <div class="field">
        <label class="field-label">默认模型</label>
        <div class="inline-fields model-row">
          <SlSelect :model-value="modelValue" :options="modelOptions" aria-label="选择 AI 模型" searchable search-placeholder="搜索模型名称" @update:model-value="selectModel" />
          <SlButton label="检测连接与获取模型" variant="outlined" icon="refresh" :disabled="loading || !state.config.ai_config.api_url || !state.config.ai_config.api_key" @click="refreshModels()" />
        </div>
        <SlInput v-if="customModel" v-model="state.config.ai_config.model" class="model-custom-input" aria-label="手动填写 AI 模型名" placeholder="填写服务商支持的模型名称" @change="saveConnection().catch(() => {})" />
        <p class="field-help">获取模型列表失败时，仍可手工填写模型名。</p>
      </div>
      <div class="status-chips"><span class="chip" :class="{ 'chip-success': connectionState === 'ok', 'chip-warning': connectionState === 'error' }">{{ connectionText }}</span></div>
    </div>
  </SectionCard>
  <SectionCard title="AI 口令分析" icon="mic" description="规则与点歌记忆未命中时，将自然语言解析成音乐控制口令。">
    <SettingRow title="启用 AI 分析" :subtitle="state.config.voice_command_enabled ? '使用默认模型连接，与 AI 对话独立启用' : '需要先开启语音口令'"><SlSwitch aria-label="启用 AI 分析" :model-value="!!state.config.ai_config.enabled" :disabled="!state.config.voice_command_enabled" @update:model-value="enableAnalysis" /></SettingRow>
    <div class="form-body">
      <SlButton v-if="!state.config.voice_command_enabled" label="设置语音口令" variant="outlined" @click="navigation.settingsCategory = 'voice'" />
      <div class="field"><label class="field-label">口令分析超时（1–30 秒）</label><SlInput :model-value="String(state.config.ai_config.timeout || 6)" type="number" aria-label="AI 口令分析超时" @update:model-value="state.config.ai_config.timeout = Math.max(1, Math.min(30, Number($event) || 6))" @change="saveConnection().catch(() => {})" /></div>
      <div class="command-test-panel command-test-panel-inset"><strong>AI 分析测试</strong><p>仅测试解析，不执行播放。</p><div class="inline-fields"><SlInput v-model="testQuery" aria-label="AI 分析测试问题" placeholder="输入自然语言口令" @submit="testAnalysis" /><SlButton label="测试分析" variant="outlined" icon="science" :disabled="testBusy || !testQuery.trim()" @click="testAnalysis" /></div><pre v-if="testResult" class="result-pre">{{ testResult }}</pre></div>
    </div>
  </SectionCard>
</template>
