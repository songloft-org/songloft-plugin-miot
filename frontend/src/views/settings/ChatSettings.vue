<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { DEFAULT_CHAT_CONFIG } from '../../../../src/chat/types';
import type { ConnectionTestResult } from '../../../../src/chat/connection_test';
import type { ChatConfig, ChatMemory, ChatTurn } from '../../../../src/chat/types';
import { isDashScopeEndpoint } from '../../../../src/utils/ai_url';
import { del, get, messageOf, post, put, query } from '../../api';
import { confirmAction, deviceId, deviceName, managedDevices, notify, saveConfig, selectDevice, state } from '../../store';
import SectionCard from '../../ui/SectionCard.vue';
import SettingRow from '../../ui/SettingRow.vue';
import SlInput from '../../ui/SlInput.vue';
import SlSwitch from '../../ui/SlSwitch.vue';
import SlButton from '../../ui/SlButton.vue';
import SlSelect from '../../ui/SlSelect.vue';
import SlDisclosure from '../../ui/SlDisclosure.vue';
import AIHeadersField from '../../ui/AIHeadersField.vue';
import { parseAIHeaders } from '../../../../src/utils/ai_headers';

const config = reactive<ChatConfig>({ ...DEFAULT_CHAT_CONFIG, trigger_words: [...DEFAULT_CHAT_CONFIG.trigger_words] });
const triggers = ref(config.trigger_words.join('、'));
const customHeaders = ref(JSON.stringify(config.custom_headers || {}, null, 2));
const connectionTest = ref<(ConnectionTestResult & { error?: string; }) | null>(null);
const connectionTesting = ref(false);
let testVersion = 0;
const savedConfig = ref(''), streamingAvailable = ref<boolean | null>(null);
const loaded = ref(false), busy = ref(false), error = ref(''), refreshError = ref(''), question = ref(''), speak = ref(true);
const history = ref<ChatTurn[]>([]), memories = ref<ChatMemory[]>([]), summary = ref(''), offset = ref(0), total = ref(0);
const memoryDrafts = reactive<Record<string, string>>({});
let refreshVersion = 0;
const newMemory = ref(''), models = ref<Array<{ id: string }>>([]);
const target = computed(() => ({ account_id: state.currentAccountId, device_id: state.currentDeviceId }));
const targetQuery = computed(() => query(target.value));
const lastContextTurns = ref(3);
const contextEnabled = computed(() => config.context_turns > 0);
const webSearchAvailable = computed(() => config.api_protocol === 'responses' || isDashScopeEndpoint(config.connection === 'independent' ? config.api_url : state.config.ai_config.api_url || ''));
const connectionIdentity = computed(() => JSON.stringify({
  connection: config.connection, api_url: config.api_url, api_key: config.api_key,
  model: config.model, timeout: config.timeout, api_protocol: config.api_protocol,
  customHeaders: customHeaders.value, web_search_enabled: config.web_search_enabled,
  shared: config.connection === 'analysis' ? state.config?.ai_config : undefined,
}));
function setWebSearch(enabled: boolean) {
  config.web_search_enabled = enabled;
  if (enabled && !webSearchAvailable.value) config.api_protocol = 'responses';
}
async function testConnection(search: boolean) {
  const version = ++testVersion, identity = connectionIdentity.value;
  const current = () => alive && version === testVersion && identity === connectionIdentity.value;
  connectionTest.value = null; connectionTesting.value = true;
  try {
    const draft = { ...config, custom_headers: config.connection === 'independent' ? parseAIHeaders(customHeaders.value) : config.custom_headers };
    const result = await post<ConnectionTestResult>('/chat/test-connection', { config: draft, search });
    if (current()) connectionTest.value = result;
  } catch (e) {
    if (current()) connectionTest.value = { connected: false, search: 'not_requested', error: messageOf(e) };
  } finally { connectionTesting.value = false; }
}
const dirty = computed(() => loaded.value && (JSON.stringify({ ...config, trigger_words: triggers.value.split(/[、,，\n]/).map(v => v.trim()).filter(Boolean) }) !== savedConfig.value || customHeaders.value !== JSON.stringify(config.custom_headers || {}, null, 2)));
function setContextEnabled(enabled: boolean) {
  if (!enabled && config.context_turns > 0) lastContextTurns.value = config.context_turns;
  config.context_turns = enabled ? lastContextTurns.value : 0;
}
const phases: Record<string, string> = { queued: '排队中', preparing: '接管音箱', generating: '生成回答', speaking: '播报中', resuming: '恢复音乐', completed: '已完成', cancelled: '已取消', failed: '失败', unknown: '播报结束未确认' };
const deviceSelection = computed(() => JSON.stringify([state.currentAccountId, state.currentDeviceId]));
const deviceOptions = computed(() => managedDevices.value.map(item => ({ value: JSON.stringify([item.accountId, deviceId(item.device)]), label: `${deviceName(item.device)} · ${item.accountName}` })));
const phase = computed(() => state.chatStatus ? phases[state.chatStatus.phase] : '空闲');
const active = computed(() => !!state.chatStatus && ['queued', 'preparing', 'generating', 'speaking', 'resuming'].includes(state.chatStatus.phase));

async function action(run: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true; error.value = '';
  try { await run(); } catch (e) { error.value = messageOf(e); notify(error.value, 'error'); }
  finally { busy.value = false; }
}
async function refresh() {
  const version = ++refreshVersion;
  if (!target.value.account_id || !target.value.device_id) { history.value = []; memories.value = []; summary.value = ''; return; }
  const identity = targetQuery.value;
  const [h, m] = await Promise.all([
    get<{ history: ChatTurn[]; total: number; summary: string }>(`/chat/history${query({ ...target.value, offset: offset.value, limit: 20 })}`),
    get<{ memories: ChatMemory[] }>(`/chat/memories${identity}`),
  ]);
  if (!alive || version !== refreshVersion || identity !== targetQuery.value) return;
  history.value = h.history; total.value = h.total; summary.value = h.summary; memories.value = m.memories;
}
async function save() {
  if (config.connection === 'independent') config.custom_headers = parseAIHeaders(customHeaders.value);
  config.trigger_words = triggers.value.split(/[、,，\n]/).map(v => v.trim()).filter(Boolean);
  Object.assign(config, await put<ChatConfig>('/chat/config', config));
  customHeaders.value = JSON.stringify(config.custom_headers || {}, null, 2);
  savedConfig.value = JSON.stringify(config);
  notify('AI 对话设置已保存', 'success');
}
async function submit() {
  await post('/chat/messages', { ...target.value, text: question.value, speak: speak.value });
  question.value = '';
  if (!alive) return;
  notify('问题已提交，请查看当前状态和聊天历史', 'success');
  await refreshSafely();
}
async function refreshSafely() {
  const identity = targetQuery.value;
  const pending = refresh();
  const version = refreshVersion;
  const current = () => alive && version === refreshVersion && identity === targetQuery.value;
  try { await pending; if (current()) refreshError.value = ''; }
  catch (e) {
    if (!current()) return;
    refreshError.value = `历史刷新失败：${messageOf(e)}；已提交的问题会继续处理。`;
    notify(refreshError.value, 'warning');
  }
}
async function clear(range: 'history' | 'memory' | 'all') {
  const identity = targetQuery.value;
  if (!(await confirmAction('清理对话数据', '此操作会取消当前回答并删除所选数据。', '清理', true)).confirmed) return;
  if (!alive || identity !== targetQuery.value) return;
  await post('/chat/clear', { ...target.value, range }); offset.value = 0; await refresh();
}
async function removeTurn(id: string) {
  const identity = targetQuery.value;
  if (!(await confirmAction('删除对话', '相关自动记忆也会删除，摘要将重新构建。', '删除', true)).confirmed) return;
  if (!alive || identity !== targetQuery.value) return;
  await del(`/chat/history/${encodeURIComponent(id)}${targetQuery.value}`); await refresh();
}
watch(targetQuery, () => { history.value = []; memories.value = []; summary.value = ''; total.value = 0; refreshError.value = ''; for (const id of Object.keys(memoryDrafts)) delete memoryDrafts[id]; offset.value = 0; void refreshSafely(); });
watch([
  () => state.chatStatus?.task_id,
  () => state.chatStatus?.phase,
  () => state.chatStatus?.memory_revision,
], () => { void refreshSafely(); });
watch(connectionIdentity, () => { testVersion++; connectionTest.value = null; }, { flush: 'sync' });
onMounted(() => { void action(async () => { Object.assign(config, await get<ChatConfig>('/chat/config')); triggers.value = config.trigger_words.join('、'); customHeaders.value = JSON.stringify(config.custom_headers || {}, null, 2); savedConfig.value = JSON.stringify(config); lastContextTurns.value = config.context_turns || 3; loaded.value = true; void get<{ streaming: boolean; }>('/chat/capabilities').then(value => { if (alive) streamingAvailable.value = value.streaming; }).catch(() => { }); await refresh(); }); });
let alive = true;
onUnmounted(() => { alive = false; refreshVersion++; });
const safeAction = (run: () => Promise<void>) => { if (alive) void action(run); };
</script>

<template>
  <fieldset class="chat-settings" :disabled="busy || !loaded">
    <p v-if="error" role="alert" class="chat-error">{{ error }}</p>
    <SectionCard title="AI 对话" description="与音乐口令分析分别启用。默认每轮说“请问……”开始；可开启连续追问。">
      <div class="form-body">
      <SettingRow title="启用 AI 对话"><SlSwitch v-model="config.enabled" :disabled="!loaded || busy" aria-label="启用 AI 对话" /></SettingRow>
      <p v-if="!state.config.conversation_monitor_enabled">语音问答需要对话监听。<SlButton label="一并开启监听" variant="outlined" @click="safeAction(async () => { await saveConfig({ conversation_monitor_enabled: true }); })" /></p>
      <label class="chat-field">触发词（用顿号或逗号分隔）<SlInput v-model="triggers" aria-label="问答触发词" /></label>
      <SettingRow title="允许连续追问" subtitle="开启后，回答播报完成后的窗口内可不带触发词；仍需唤醒音箱。"><SlSwitch v-model="config.followup_enabled" aria-label="允许连续追问" /></SettingRow>
      <label v-if="config.followup_enabled" class="chat-field">追问窗口（秒，0 关闭）<SlInput :model-value="String(config.followup_seconds)" type="number" aria-label="追问窗口" @update:model-value="config.followup_seconds = Number($event)" /></label>
      <p v-if="!config.followup_enabled && !config.fallback_enabled">每轮提问都需要触发词，包括上一轮仍在回答时。</p>
      <SettingRow title="每轮回答后恢复原音乐"><SlSwitch v-model="config.resume_music" aria-label="回答后恢复音乐" /></SettingRow>
      <SettingRow title="等待时播报提示" subtitle="提问后说“收到，正在思考”，模型请求同时开始。"><SlSwitch v-model="config.waiting_feedback" aria-label="等待时播报提示" /></SettingRow>
      <p>追问仍需唤醒音箱。分组播放时全组暂停，仅提问设备回答；播报结束无法确认时保持暂停。DLNA 投放中请先停止投放。</p>
      </div>
    </SectionCard>
    <SectionCard title="对话上下文" description="聊天记录用于查看；只有开启以下选项才会发送相关历史或偏好。">
      <div class="form-body">
        <SettingRow title="携带历史对话" subtitle="让 AI 理解连续追问。关闭后不携带以前的问答和摘要。"><SlSwitch :model-value="contextEnabled" aria-label="携带历史对话" @update:model-value="setContextEnabled($event)" /></SettingRow>
        <label v-if="contextEnabled" class="chat-field">参考最近几轮（1–24）<SlInput :model-value="String(config.context_turns)" type="number" aria-label="上下文轮数" @update:model-value="config.context_turns = Number($event)" /><small>一轮包含一次提问和回答。</small></label>
        <SettingRow title="记住我的偏好" subtitle="自动保存并参考个人事实与偏好，会产生额外模型请求。"><SlSwitch v-model="config.memory_enabled" aria-label="长期记忆" /></SettingRow>
        <p v-if="!contextEnabled && !config.memory_enabled">每次提问独立处理，只发送角色提示词和本次问题。</p>
        <SlDisclosure title="高级设置" description="较早对话的摘要和记录保留">
          <SettingRow title="保留更早的对话摘要" subtitle="压缩较早的问答供后续参考，会产生额外模型请求。关闭历史对话时暂停使用和生成。"><SlSwitch v-model="config.summary_enabled" :disabled="!contextEnabled" aria-label="对话摘要" /></SettingRow>
          <label class="chat-field">历史保留天数（1–30）<SlInput :model-value="String(config.history_days)" type="number" aria-label="历史保留天数" @update:model-value="config.history_days = Number($event)" /></label>
          <label class="chat-field">历史最大轮数（12–500）<SlInput :model-value="String(config.history_limit)" type="number" aria-label="历史最大轮数" @update:model-value="config.history_limit = Number($event)" /></label>
          <p>关闭选项会保留本地数据；需要删除时使用下面的数据清理操作。</p>
        </SlDisclosure>
      </div>
    </SectionCard>
    <SectionCard title="对话模型与角色" description="默认使用上方的模型连接。可单独选择对话模型，或改用独立连接。">
      <div class="form-body">
      <SlSelect :disabled="busy || !loaded" v-model="config.connection" :options="[{ value: 'analysis', label: '复用默认模型连接' }, { value: 'independent', label: '独立连接' }]" aria-label="对话模型连接" />
      <template v-if="config.connection === 'independent'">
        <label class="chat-field">服务地址<SlInput v-model="config.api_url" type="url" aria-label="问答 API 地址" placeholder="粘贴服务商提供的 API 基础地址" /><small>例如 https://example.com/v1，请勿粘贴聊天或搜索请求的完整地址。</small></label>
        <label class="chat-field">API 密钥<SlInput v-model="config.api_key" type="password" aria-label="问答 API 密钥" /></label>
      </template>
      <p v-if="config.connection === 'analysis'">默认模型：{{ state.config.ai_config.model || '尚未配置' }}。同时复用默认连接的自定义请求头。启用对话不需要开启口令分析。</p>
      <label class="chat-field">问答模型<SlInput v-model="config.model" aria-label="问答模型" placeholder="留空则使用默认模型" /></label>
      <SlButton v-if="config.connection === 'independent'" label="保存并获取模型" variant="outlined" :disabled="busy || !loaded" @click="safeAction(async () => { await save(); models = (await get<{ models: Array<{ id: string }> }>('/chat/models')).models; })" />
      <SlSelect :disabled="busy || !loaded" v-if="models.length" v-model="config.model" :options="models.map(m => ({ value: m.id, label: m.id }))" aria-label="可用问答模型" />
      <SettingRow title="联网搜索" subtitle="回答实时问题时，允许 AI 搜索资料。可能产生额外费用。">
        <SlSwitch :model-value="config.web_search_enabled" aria-label="联网搜索" @update:model-value="setWebSearch($event)" />
      </SettingRow>
      <p v-if="config.web_search_enabled && webSearchAvailable">由模型决定是否搜索。建议先测试，确认当前服务和模型是否支持。</p>
      <div v-if="config.web_search_enabled && !webSearchAvailable" class="chat-search-help">
        <p>当前连接方式尚未启用搜索支持。</p>
        <SlButton label="启用搜索连接" variant="outlined" @click="config.api_protocol = 'responses'" />
      </div>
      <div class="chat-actions">
        <SlButton label="测试连接" variant="outlined" :disabled="busy || !loaded" @click="safeAction(() => testConnection(false))" />
        <SlButton v-if="config.web_search_enabled" label="测试联网搜索" variant="outlined" :disabled="busy || !loaded || !webSearchAvailable" @click="safeAction(() => testConnection(true))" />
      </div>
      <p class="chat-help">使用当前填写的内容发送一次简短提问，无需先保存，不播放也不保存聊天记录。</p>
      <p v-if="connectionTesting" role="status">正在测试当前连接，请稍候……</p>
      <div v-if="connectionTest" class="chat-connection-result" role="status" aria-live="polite">
        <template v-if="connectionTest.connected">
          <strong>{{ connectionTest.search === 'completed' ? '连接正常 · 已收到搜索完成记录' : connectionTest.search === 'unconfirmed' ? '连接正常 · 本次搜索未确认' : '连接正常 · 模型已回复' }}</strong>
          <p v-if="connectionTest.search === 'completed'">服务返回了搜索完成记录。正式问答时仍由模型决定是否搜索。</p>
          <p v-else-if="connectionTest.search === 'unconfirmed'">已允许模型搜索，但服务未返回搜索完成记录，不能确认本次实际联网。请核对服务商和模型的搜索支持。</p>
          <p v-else>可以继续配置或保存。连接正常不代表已验证联网搜索。</p>
        </template>
        <template v-else>
          <strong class="chat-error">测试未通过</strong>
          <p class="chat-text">{{ connectionTest.error }}</p>
          <p v-if="/401|403/.test(connectionTest.error || '')">请核对 API 密钥是否有效，以及账号是否有权使用此模型。</p>
          <p v-else-if="/404|405/.test(connectionTest.error || '')">请核对服务地址。当前服务可能不支持此连接方式，可在高级设置中切换后重试。</p>
          <p v-else-if="/timed out|超时/i.test(connectionTest.error || '')">请检查网络，尝试响应更快的模型，或在高级设置中调整超时时间。</p>
          <p v-else>请检查服务地址、密钥和模型；需要调整连接方式时展开高级设置。</p>
        </template>
      </div>
      <SlDisclosure title="高级设置" description="连接方式、自定义请求头、角色与其他选项">
      <label class="chat-field">连接方式<SlSelect v-model="config.api_protocol" :options="[{ value: 'chat_completions', label: '兼容模式（Chat Completions）' }, { value: 'responses', label: '搜索工具模式（Responses）' }]" aria-label="问答接口协议" /></label>
      <p>普通连接可保留兼容模式。自定义服务的内置搜索可尝试搜索工具模式，需服务商和模型支持 Responses。切换后请重新测试。</p>
      <AIHeadersField v-if="config.connection === 'independent'" v-model="customHeaders" label="问答自定义请求头" />
      <label class="chat-field">请求超时（1–30 秒）<SlInput :model-value="String(config.timeout)" type="number" aria-label="问答超时" @update:model-value="config.timeout = Number($event)" /></label>
      <label class="chat-field">角色提示词<textarea v-model="config.system_prompt" class="sl-input chat-textarea" aria-label="角色提示词" maxlength="4000"></textarea></label>
      <SettingRow title="音乐口令未命中后交给 AI" subtitle="开启后，无触发词的普通问题也可能交给 AI，不受连续追问开关限制。"><SlSwitch v-model="config.fallback_enabled" aria-label="兜底问答" /></SettingRow>
      <p>追问窗口决定哪些话交给 AI；历史上下文决定 AI 能参考哪些问答。</p>
      <SettingRow title="实时显示回答" subtitle="逐步显示模型生成的文字，音箱仍等待完整回答后播报。接口不支持时可关闭。"><SlSwitch v-model="config.streaming_enabled" aria-label="实时显示回答" /></SettingRow>
      <p v-if="streamingAvailable === false">当前服务端尚不支持实时接收，将等待完整回答。升级服务端后可用。</p>
      </SlDisclosure>
      </div>
    </SectionCard>
    <div class="chat-save">
      <span v-if="dirty" role="status">有未保存的修改</span>
      <SlButton label="保存设置" :disabled="busy || !loaded || !dirty" @click="safeAction(save)" />
    </div>
    <SectionCard title="对话测试" description="使用当前选中的受管理音箱。关闭播报可测试模型而不暂停音乐。">
      <div class="form-body">
      <SlSelect :disabled="busy || !loaded" :model-value="deviceSelection" :options="deviceOptions" aria-label="对话设备" @update:model-value="safeAction(async () => { const [account, device] = JSON.parse($event); await selectDevice(account, device); })" />
      <p>当前状态：<strong>{{ phase }}</strong></p>
      <p v-if="active" role="status">问题处理中，可随时停止回答。音箱会在完整回答生成后播报。</p>
      <div v-if="state.chatStatus?.answer" class="chat-live-answer" aria-label="当前回答"><strong>{{ active ? '当前回答' : '最近回答' }}</strong><p class="chat-text">{{ state.chatStatus.answer }}</p></div>
      <p v-if="refreshError" role="status">{{ refreshError }}</p>
      <p v-if="state.chatStatus?.error" role="alert">{{ state.chatStatus.error }}</p>
      <label class="chat-field">问题<textarea v-model="question" class="sl-input chat-textarea" aria-label="对话问题" maxlength="2000"></textarea></label>
      <SettingRow title="在音箱上播报"><SlSwitch v-model="speak" aria-label="播报回答" /></SettingRow>
      <div class="chat-actions">
        <SlButton label="提问" :disabled="busy || !config.enabled || !question.trim() || !target.device_id" @click="safeAction(submit)" />
        <SlButton label="停止回答" variant="outlined" :disabled="busy || !active" @click="safeAction(async () => { await post('/chat/cancel', { ...target, close_session: true, resume_music: false }); await refresh(); })" />
        <SlButton label="退出并恢复音乐" variant="outlined" :disabled="busy || !active" @click="safeAction(async () => { await post('/chat/cancel', { ...target, close_session: true, resume_music: true }); await refresh(); })" />
        <SlButton label="重置会话" variant="outlined" :disabled="busy || !target.device_id" @click="safeAction(async () => { await post('/chat/reset', target); await refresh(); })" />
      </div>
      </div>
    </SectionCard>
    <SectionCard title="聊天历史" description="按账号和设备隔离，默认保存 30 天、最多 500 轮。取消和失败也会显示。">
      <div class="form-body">
      <p v-if="summary" class="chat-text">摘要：{{ summary }}</p>
      <p v-if="!history.length">暂无对话记录</p>
      <article v-for="turn in history" :key="turn.id" class="chat-turn">
        <small>{{ new Date(turn.created_at).toLocaleString() }} · {{ phases[turn.phase] }}</small>
        <p class="chat-text">你：{{ turn.user }}</p><p v-if="turn.assistant" class="chat-text">AI：{{ turn.assistant }}</p><p v-if="turn.error">{{ turn.error }}</p>
        <SlButton label="删除这轮对话" variant="text" :disabled="busy" @click="safeAction(() => removeTurn(turn.id))" />
      </article>
      <div class="chat-actions">
        <SlButton label="上一页" variant="outlined" :disabled="busy || offset === 0" @click="safeAction(async () => { offset = Math.max(0, offset - 20); await refresh(); })" />
        <SlButton label="下一页" variant="outlined" :disabled="busy || offset + history.length >= total" @click="safeAction(async () => { offset += 20; await refresh(); })" />
        <SlButton label="清空历史和摘要" variant="text" :disabled="busy || !target.device_id" @click="safeAction(() => clear('history'))" />
      </div>
      </div>
    </SectionCard>
    <SlDisclosure title="偏好记忆管理" description="查看、编辑或删除保存的偏好；手工编辑不会被自动覆盖。">
      <div class="form-body">
      <article v-for="memory in memories" :key="memory.id" class="chat-turn">
        <SlInput :model-value="memoryDrafts[memory.id] ?? memory.content" @update:model-value="memoryDrafts[memory.id] = $event" aria-label="记忆内容" />
        <small>{{ memory.manual ? '手工维护' : '自动提取' }} · 来源：{{ memory.source_ids.join('、') || '手工添加' }}</small>
        <div class="chat-actions">
          <SlButton label="保存记忆" variant="text" :disabled="busy" @click="safeAction(async () => { await put(`/chat/memories/${encodeURIComponent(memory.id)}`, { ...target, content: memoryDrafts[memory.id] ?? memory.content }); delete memoryDrafts[memory.id]; await refresh(); })" />
          <SlButton label="删除记忆" variant="text" :disabled="busy" @click="safeAction(async () => { await del(`/chat/memories/${encodeURIComponent(memory.id)}${targetQuery}`); await refresh(); })" />
        </div>
      </article>
      <label class="chat-field">新增记忆<SlInput v-model="newMemory" aria-label="新增记忆" /></label>
      <div class="chat-actions">
        <SlButton label="添加记忆" variant="outlined" :disabled="busy || !newMemory.trim() || !target.device_id" @click="safeAction(async () => { await post('/chat/memories', { ...target, content: newMemory }); newMemory = ''; await refresh(); })" />
        <SlButton label="清空长期记忆" variant="text" :disabled="busy || !target.device_id" @click="safeAction(() => clear('memory'))" />
        <SlButton label="全部清空" variant="text" :disabled="busy || !target.device_id" @click="safeAction(() => clear('all'))" />
      </div>
      </div>
    </SlDisclosure>
  </fieldset>
</template>

<style scoped>
.chat-settings { display: grid; gap: 16px; min-width: 0; margin: 0; padding: 0; border: 0; }
.chat-save { display: flex; align-items: center; justify-content: flex-end; gap: 12px; flex-wrap: wrap; }
.chat-live-answer { padding: 12px; background: var(--md-surface-container); border-radius: 12px; }
.chat-field { display: grid; gap: 8px; margin-block: 12px; }
.chat-textarea { min-height: 100px; resize: vertical; }
.chat-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-block: 12px; }
.chat-turn { padding-block: 12px; border-bottom: 1px solid var(--md-outline-variant); }
.chat-text { white-space: pre-wrap; overflow-wrap: anywhere; }
.chat-connection-result { padding: 12px 16px; border: 1px solid var(--md-outline-variant); border-radius: 12px; background: var(--md-surface-container); overflow-wrap: anywhere; }
.chat-connection-result p { margin-block: 6px 0; }
.chat-help { color: var(--md-on-surface-variant); font-size: 0.875rem; }
.chat-error { color: var(--md-error); }
</style>
