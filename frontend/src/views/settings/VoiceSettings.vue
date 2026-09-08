<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue';
import SectionCard from '../../ui/SectionCard.vue';
import SettingRow from '../../ui/SettingRow.vue';
import SlButton from '../../ui/SlButton.vue';
import SlIcon from '../../ui/SlIcon.vue';
import SlInput from '../../ui/SlInput.vue';
import SlSelect from '../../ui/SlSelect.vue';
import SlSwitch from '../../ui/SlSwitch.vue';
import { del, post, pluginWebSocketUrl } from '../../api';
import {
  addWebhook,
  clearMemory,
  confirmAction,
  deleteWebhook,
  loadConversationMessages,
  loadMemory,
  loadSearchProviders,
  loadVoiceData,
  messageOf,
  notify,
  playlistLabel,
  refreshIndex,
  saveConfig,
  saveVoiceCommands,
  state,
} from '../../store';
import type { MemoryEntity, SearchSource, SelectOption, VoiceCommand } from '../../types';

interface CommandTestResult {
  matched: boolean;
  source: 'ai' | 'rule' | 'none';
  commandType?: string;
  keyword?: string;
  argument?: string;
  search?: { kind: 'song' | 'playlist'; found: boolean; detail: string } | null;
  ai?: { action: string; confidence: string } | null;
  executed: boolean;
  note?: string;
}

const commandLabels: Record<string, string> = {
  play_playlist: '播放歌单',
  play_artist: '播放歌手',
  play_song: '播放歌曲',
  set_play_mode: '播放模式',
  set_volume: '音量控制',
  favorite: '收藏歌曲',
  next: '下一首',
  previous: '上一首',
  stop: '停止播放',
  sleep_timer: '定时停止',
  cancel_sleep_timer: '取消定时',
  query_sleep_timer: '查询定时',
};
const commandIcons: Record<string, string> = {
  play_playlist: 'queue_music',
  play_artist: 'artist',
  play_song: 'music_note',
  set_play_mode: 'repeat',
  set_volume: 'volume_up',
  favorite: 'favorite',
  next: 'skip_next',
  previous: 'skip_previous',
  stop: 'stop',
  sleep_timer: 'bedtime',
  cancel_sleep_timer: 'timer_off',
  query_sleep_timer: 'timer',
};
const parameterLabels: Record<string, string> = {
  random: '随机播放',
  single: '单曲循环',
  loop: '列表循环',
  order: '顺序播放',
  singlePlay: '单曲播放',
  absolute: '绝对音量',
  up: '增大音量',
  down: '减小音量',
  add: '收藏',
  remove: '取消收藏',
};
const searchPriorityOptions: SelectOption[] = [
  { value: 'parallel', label: '并行搜索' },
  { value: 'local_first', label: '本地优先' },
  { value: 'external_first', label: '外部源优先' },
];

const appendPlaylistEnabled = computed(() => !!state.config.external_search_playlist_id);
const playlistOptions = computed<SelectOption[]>(() =>
  state.playlists.map((p) => ({ value: String(p.id), label: playlistLabel(p), searchText: p.name })),
);

function setAppendPlaylistEnabled(enabled: boolean): void {
  if (!enabled) {
    void saveConfig({ external_search_playlist_id: '' });
  } else if (state.playlists.length) {
    void saveConfig({ external_search_playlist_id: String(state.playlists[0].id) });
  }
}

function setAppendPlaylistId(value: string): void {
  void saveConfig({ external_search_playlist_id: value });
}

const pollInterval = ref(String(state.config.conversation_poll_interval));
const maxIndex = ref(String(state.config.max_song_index));
const maxMemory = ref(String(state.config.voice_memory_max_records));
const externalSearchTimeout = ref(String(state.config.external_search_timeout));
const webhookName = ref('');
const webhookUrl = ref('');
const commandInputs = reactive<Record<string, string>>({});
const commandInputVersions = reactive<Record<string, number>>({});
const commandSaving = ref(false);
const commandTestQuery = ref('');
const commandTestResult = ref('');
const commandTestSuccess = ref(false);
const commandTestBusy = ref(false);
const aiTestQuery = ref('');
const aiTestResult = ref('');
const aiTestBusy = ref(false);
const sourceTestQuery = ref('');
const sourceTestResult = ref('');
const selectedProviderId = ref('');
const newSourceName = ref('');
const newSourceUrl = ref('');
const newSourceToken = ref('');
const sourceDrafts = reactive<Record<string, SearchSource>>({});
const voiceCommandsExpanded = ref(false);
const conversationMessagesExpanded = ref(false);
const memoryExpanded = ref(false);
const memoryLoaded = ref(false);
const memoryLoading = ref(false);
const expandedMemory = ref<string | null>(null);
let conversationSocket: WebSocket | null = null;
let conversationPoll: ReturnType<typeof setInterval> | null = null;

function syncSourceDrafts(): void {
  for (const source of Array.isArray(state.config.external_search_sources) ? state.config.external_search_sources : []) {
    sourceDrafts[source.id] = { ...source };
  }
}

function providerKey(provider: { id?: string; entry_path?: string; entryPath?: string; name: string }): string {
  return String(provider.id || provider.entry_path || provider.entryPath || provider.name);
}

const showManualAdd = ref(false);

/**
 * 快速选择已安装搜索源：选择即添加/启用，直达可用，无需再手动填表单点添加。
 * 幂等——按 URL 匹配已配置源：已存在则确保启用，不存在则新增一条启用状态的源。
 */
async function applyProvider(providerId: string): Promise<void> {
  if (!providerId) return;
  const provider = state.searchProviders.find((item) => providerKey(item) === providerId);
  if (!provider) return;
  const url = (provider.url || '/api/search/topone').trim();
  const displayName = provider.name || url;
  const existing = state.config.external_search_sources.find((s) => (s.url || '').trim() === url);
  try {
    if (existing) {
      if (!existing.enabled) {
        const sources = state.config.external_search_sources.map((s) =>
          s.id === existing.id ? { ...s, enabled: true } : s,
        );
        if (sourceDrafts[existing.id]) sourceDrafts[existing.id].enabled = true;
        await saveConfig({ external_search_sources: sources });
        notify(`已启用搜索源「${existing.name || displayName}」`, 'success');
      } else {
        notify(`搜索源「${existing.name || displayName}」已在配置中`, 'success');
      }
    } else {
      const source: SearchSource = {
        id: `src_${Date.now()}`,
        name: displayName,
        url,
        token: '',
        enabled: true,
      };
      const sources = [...state.config.external_search_sources, source];
      sourceDrafts[source.id] = { ...source };
      await saveConfig({ external_search_sources: sources });
      notify(`已添加搜索源「${displayName}」`, 'success');
    }
  } catch { /* saveConfig presents the error */ }
  selectedProviderId.value = '';
}

const selectableSearchProviders = computed(() => state.searchProviders);

const searchProviderOptions = computed(() =>
  selectableSearchProviders.value.map((provider) => ({
    value: providerKey(provider),
    label: provider.name,
  })),
);

syncSourceDrafts();

onMounted(async () => {
  await Promise.all([loadVoiceData(), loadSearchProviders()]);
  syncSourceDrafts();

  if (state.config.conversation_monitor_enabled) connectConversation();
});
onUnmounted(() => {
  conversationSocket?.close();
  if (conversationPoll) clearInterval(conversationPoll);
});

function commandKey(command: VoiceCommand, index: number): string {
  return `${command.type}:${command.param || ''}:${index}`;
}

function keywordsOf(command: VoiceCommand): string[] {
  if (command.keywords?.length) return command.keywords;
  if (command.patterns?.length) return command.patterns;
  return command.pattern ? [command.pattern] : [];
}

function cloneCommand(command: VoiceCommand): VoiceCommand {
  return { ...command, keywords: [...keywordsOf(command)] };
}

async function replaceCommand(index: number, update: (command: VoiceCommand) => void): Promise<boolean> {
  if (commandSaving.value) return false;
  const commands = state.voiceCommands.map(cloneCommand);
  update(commands[index]);
  commandSaving.value = true;
  try {
    await saveVoiceCommands(commands);
    return true;
  } catch (error) {
    notify(messageOf(error), 'error');
    return false;
  } finally {
    commandSaving.value = false;
  }
}

async function addKeyword(command: VoiceCommand, index: number): Promise<void> {
  const key = commandKey(command, index);
  const keyword = (commandInputs[key] || '').trim();
  if (!keyword) {
    notify('请输入口令词', 'warning');
    return;
  }
  if (keywordsOf(command).includes(keyword)) {
    notify('口令词已存在', 'warning');
    return;
  }
  if (await replaceCommand(index, (item) => item.keywords = [...keywordsOf(item), keyword])) {
    commandInputs[key] = '';
    commandInputVersions[key] = (commandInputVersions[key] || 0) + 1;
  }
}

async function removeKeyword(command: VoiceCommand, index: number, keywordIndex: number): Promise<void> {
  if (keywordsOf(command).length <= 1) {
    notify('每条命令至少保留一个口令词', 'warning');
    return;
  }
  await replaceCommand(index, (item) => item.keywords = keywordsOf(item).filter((_, i) => i !== keywordIndex));
}

async function setCommandEnabled(index: number, enabled: boolean): Promise<void> {
  await replaceCommand(index, (command) => command.enabled = enabled);
}

async function resetCommands(): Promise<void> {
  if (!(await confirmAction('恢复默认口令', '当前自定义口令词会被默认配置覆盖。', '恢复默认'))) return;
  commandSaving.value = true;
  try {
    await saveVoiceCommands([]);
    await loadVoiceData();
    notify('已恢复默认口令', 'success');
  } catch (error) {
    notify(messageOf(error), 'error');
  } finally {
    commandSaving.value = false;
  }
}

async function setConversationEnabled(enabled: boolean): Promise<void> {
  const patch = enabled
    ? { conversation_monitor_enabled: true }
    : {
        conversation_monitor_enabled: false,
        voice_command_enabled: false,
        external_search_enabled: false,
        ai_config: { ...state.config.ai_config, enabled: false },
      };
  try {
    await saveConfig(patch);
    enabled ? connectConversation() : disconnectConversation();
  } catch { /* saveConfig presents the error */ }
}

async function setVoiceEnabled(enabled: boolean): Promise<void> {
  if (enabled && !state.config.conversation_monitor_enabled) {
    notify('请先开启对话监听', 'warning');
    return;
  }
  const patch = enabled
    ? { voice_command_enabled: true }
    : {
        voice_command_enabled: false,
        external_search_enabled: false,
        ai_config: { ...state.config.ai_config, enabled: false },
      };
  try { await saveConfig(patch); } catch { /* saveConfig presents the error */ }
}

async function setAIEnabled(enabled: boolean): Promise<void> {
  if (enabled && !state.config.voice_command_enabled) {
    notify('请先开启语音口令', 'warning');
    return;
  }
  try {
    await saveConfig({ ai_config: { ...state.config.ai_config, enabled } });
  } catch { /* saveConfig presents the error */ }
}

async function setExternalSearchEnabled(enabled: boolean): Promise<void> {
  if (enabled && !state.config.voice_command_enabled) {
    notify('请先开启语音口令', 'warning');
    return;
  }
  try { await saveConfig({ external_search_enabled: enabled }); } catch { /* saveConfig presents the error */ }
}

function setSwitch(key: keyof typeof state.config, value: boolean): void {
  void saveConfig({ [key]: value } as never);
}

async function saveNumber(
  key: 'conversation_poll_interval' | 'max_song_index' | 'voice_memory_max_records',
  raw: string,
  min: number,
  max: number,
): Promise<void> {
  const value = Math.max(min, Math.min(max, Number.parseInt(raw, 10) || min));
  if (key === 'conversation_poll_interval') pollInterval.value = String(value);
  if (key === 'max_song_index') maxIndex.value = String(value);
  if (key === 'voice_memory_max_records') maxMemory.value = String(value);
  try {
    await saveConfig({ [key]: value });
    if (key === 'voice_memory_max_records' && memoryExpanded.value) await ensureMemoryLoaded(true);
  } catch { /* saveConfig presents the error */ }
}

function connectConversation(): void {
  disconnectConversation();
  if (typeof WebSocket === 'undefined') {
    conversationPoll = setInterval(() => void loadConversationMessages(), 4000);
    return;
  }
  try {
    conversationSocket = new WebSocket(pluginWebSocketUrl('/conversation/ws?limit=50'));
    conversationSocket.onopen = () => {
      if (conversationPoll) clearInterval(conversationPoll);
      conversationPoll = null;
    };
    conversationSocket.onmessage = (event) => {
      try {
        const frame = JSON.parse(String(event.data));
        if (frame.type === 'snapshot') state.conversationMessages = frame.data || [];
        else if (frame.type === 'message') state.conversationMessages.unshift(frame.data);
      } catch { /* ignore malformed stream frame */ }
    };
    conversationSocket.onerror = () => conversationSocket?.close();
    conversationSocket.onclose = () => {
      conversationSocket = null;
      if (state.config.conversation_monitor_enabled && !conversationPoll) {
        conversationPoll = setInterval(() => void loadConversationMessages(), 4000);
      }
    };
  } catch {
    conversationPoll = setInterval(() => void loadConversationMessages(), 4000);
  }
}

function disconnectConversation(): void {
  conversationSocket?.close();
  conversationSocket = null;
  if (conversationPoll) clearInterval(conversationPoll);
  conversationPoll = null;
}

async function refreshConversation(): Promise<void> {
  await loadConversationMessages();
  notify('对话记录已刷新', 'success');
}

async function ensureMemoryLoaded(force = false): Promise<void> {
  if (memoryLoading.value) return;
  if (!force && memoryLoaded.value) return;
  memoryLoading.value = true;
  try {
    await loadMemory();
    memoryLoaded.value = true;
  } finally {
    memoryLoading.value = false;
  }
}

async function toggleMemoryExpanded(): Promise<void> {
  memoryExpanded.value = !memoryExpanded.value;
  if (memoryExpanded.value) {
    await ensureMemoryLoaded();
  }
}

async function addHook(): Promise<void> {
  if (!webhookUrl.value.trim()) return;
  try {
    await addWebhook(webhookName.value.trim(), webhookUrl.value.trim());
    webhookName.value = '';
    webhookUrl.value = '';
    notify('Webhook 已添加', 'success');
  } catch (error) {
    notify(messageOf(error), 'error');
  }
}

async function removeHook(id: string): Promise<void> {
  if (!(await confirmAction('删除 Webhook', '确定删除这个回调地址吗？', '删除', true))) return;
  try { await deleteWebhook(id); } catch (error) { notify(messageOf(error), 'error'); }
}

function formatCommandResult(result: CommandTestResult, elapsedMs: number): string {
  const lines: string[] = [];
  if (!result.matched) {
    lines.push('未匹配到口令');
  } else {
    lines.push(`匹配来源：${result.source === 'ai' ? 'AI 分析' : '规则匹配'}`);
    if (result.commandType) lines.push(`命令：${commandLabels[result.commandType] || result.commandType}`);
    if (result.keyword) lines.push(`命中口令词：${result.keyword}`);
    if (result.argument) lines.push(`搜索参数：${result.argument}`);
    if (result.search) {
      lines.push(`${result.search.kind === 'playlist' ? '歌单' : '歌曲'}：${result.search.found ? '已找到' : '未找到'} ${result.search.detail}`);
    }
    if (result.ai) lines.push(`AI：${result.ai.action}，置信度 ${result.ai.confidence}`);
    lines.push(result.executed ? '已投放到当前设备执行' : '未执行');
  }
  if (result.note) lines.push(`说明：${result.note}`);
  lines.push(`耗时：${elapsedMs} ms`);
  return lines.join('\n');
}

async function testCommand(): Promise<void> {
  const query = commandTestQuery.value.trim();
  if (!query) return;
  if (!state.currentDeviceId) {
    notify('请先在首页选择设备', 'warning');
    return;
  }
  commandTestBusy.value = true;
  const startedAt = Date.now();
  try {
    const result = await post<CommandTestResult>('/voice-commands/test', {
      query,
      device_id: state.currentDeviceId,
      account_id: state.currentAccountId,
    });
    commandTestSuccess.value = result.matched;
    commandTestResult.value = formatCommandResult(result, Date.now() - startedAt);
  } catch (error) {
    commandTestSuccess.value = false;
    commandTestResult.value = messageOf(error);
  } finally {
    commandTestBusy.value = false;
  }
}

async function testAI(): Promise<void> {
  if (!aiTestQuery.value.trim()) return;
  aiTestBusy.value = true;
  try {
    const result = await post<Record<string, unknown>>('/voice-commands/ai-test', { query: aiTestQuery.value.trim() });
    aiTestResult.value = JSON.stringify(result, null, 2);
  } catch (error) {
    aiTestResult.value = messageOf(error);
  } finally {
    aiTestBusy.value = false;
  }
}

async function addSource(): Promise<void> {
  if (!newSourceUrl.value.trim()) {
    notify('请填写接口 URL', 'warning');
    return;
  }
  const source: SearchSource = {
    id: `src_${Date.now()}`,
    name: newSourceName.value.trim() || newSourceUrl.value.trim(),
    url: newSourceUrl.value.trim(),
    token: newSourceToken.value.trim(),
    enabled: true,
  };
  const sources = [...state.config.external_search_sources, source];
  sourceDrafts[source.id] = { ...source };
  newSourceName.value = '';
  newSourceUrl.value = '';
  newSourceToken.value = '';
  await saveConfig({ external_search_sources: sources });
  showManualAdd.value = false;
  notify(`已添加搜索源「${source.name}」`, 'success');
}

async function removeSource(id: string): Promise<void> {
  const removed = state.config.external_search_sources.find((source) => source.id === id);
  const sources = state.config.external_search_sources.filter((source) => source.id !== id);
  delete sourceDrafts[id];
  await saveConfig({ external_search_sources: sources });
  if (removed) notify(`已移除搜索源「${removed.name || removed.url}」`, 'success');
}

async function saveSources(): Promise<void> {
  const sources = (Array.isArray(state.config.external_search_sources) ? state.config.external_search_sources : []).map((source) => ({
    ...(sourceDrafts[source.id] || source),
  }));
  await saveConfig({ external_search_sources: sources });
  notify('外部搜索源已保存', 'success');
}

async function testSource(): Promise<void> {
  if (!sourceTestQuery.value.trim()) return;
  const source = state.config.external_search_sources.find((item) => item.enabled);
  if (!source) {
    sourceTestResult.value = '没有启用的搜索源';
    return;
  }
  try {
    let url = source.url;
    if (!/^https?:\/\//i.test(url)) url = `${window.location.origin}${url}`;
    const token = source.token.trim() || window.SongloftPlugin?.getAuthToken?.() || '';
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: token.startsWith('Bearer ') ? token : `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ keyword: sourceTestQuery.value.trim(), quality: '320k' }),
    });
    sourceTestResult.value = JSON.stringify(await response.json(), null, 2);
  } catch (error) {
    sourceTestResult.value = messageOf(error);
  }
}

async function refreshSearchProviders(): Promise<void> {
  await loadSearchProviders();
  if (selectedProviderId.value && !selectableSearchProviders.value.some((provider) => providerKey(provider) === selectedProviderId.value)) {
    selectedProviderId.value = '';
  }
  notify(state.searchProviders.length
    ? `已刷新，发现 ${state.searchProviders.length} 个已安装搜索源`
    : '已刷新，暂未发现已安装搜索源', 'success');
}

function memoryAliases(entity: MemoryEntity): Array<{ id?: string; query?: string; alias?: string }> {
  return entity.aliases || entity.records || [];
}

async function deleteMemoryEntity(key: string, title: string): Promise<void> {
  if (!(await confirmAction('删除语音记忆', `确定删除“${title}”的全部记忆吗？`, '删除', true))) return;
  try {
    await del(`/memory/entity?canonicalKey=${encodeURIComponent(key)}`);
    await ensureMemoryLoaded(true);
  } catch (error) {
    notify(messageOf(error), 'error');
  }
}

async function deleteMemoryRecord(id?: string): Promise<void> {
  if (!id) return;
  try {
    await del(`/memory?id=${encodeURIComponent(id)}`);
    await ensureMemoryLoaded(true);
  } catch (error) {
    notify(messageOf(error), 'error');
  }
}
</script>

<template>
  <SectionCard title="对话监听" icon="record_voice_over" description="监听已启用管理的音箱对话记录，并把语音内容交给语音引擎。">
    <SettingRow title="启用对话监听" subtitle="关闭后会同时关闭语音口令、AI 分析和外部搜索">
      <SlSwitch :model-value="state.config.conversation_monitor_enabled" @update:model-value="setConversationEnabled" />
    </SettingRow>
    <div class="form-body">
      <div class="field-grid">
        <div class="field"><label class="field-label">轮询间隔（秒）</label><SlInput :model-value="pollInterval" type="number" @update:model-value="pollInterval = $event" @change="saveNumber('conversation_poll_interval', pollInterval, 1, 30)" /></div>
        <div class="field setting-field-control"><label class="field-label">调试日志</label><SlSwitch :model-value="state.config.conversation_poll_debug" @update:model-value="setSwitch('conversation_poll_debug', $event)" /></div>
      </div>
      <div v-if="state.config.conversation_monitor_enabled" class="status-panel status-panel-inset">
        <div class="status-chips"><span class="chip chip-success">{{ conversationSocket ? 'WebSocket 已连接' : '轮询回落中' }}</span><span class="chip">{{ state.conversationMessages.length }} 条最近记录</span></div>
      </div>
      <div class="field-actions"><SlButton variant="text" label="刷新记录" icon="refresh" @click="refreshConversation" /></div>
    </div>
    <div class="form-body">
      <button type="button" class="advanced-toggle" @click="conversationMessagesExpanded = !conversationMessagesExpanded">
        <span>{{ conversationMessagesExpanded ? '收起最近对话记录' : '展开最近对话记录' }}</span>
        <SlIcon :name="conversationMessagesExpanded ? 'expand_less' : 'expand_more'" :size="20" />
      </button>
      <div v-if="conversationMessagesExpanded" class="sub-panel">
        <div v-for="item in state.conversationMessages" :key="String(item.id || item.timestamp)" class="list-item">
          <div class="list-item-copy"><strong class="list-item-title">{{ item.query || item.text || '未识别内容' }}</strong><span class="list-item-subtitle">{{ item.device_name || item.device_id || '设备' }} · {{ item.answer || '暂无回复' }}</span></div>
        </div>
        <div v-if="!state.conversationMessages.length" class="empty-state">暂无对话记录</div>
      </div>
      <div v-else class="collapsed-summary">
        <span class="chip">{{ state.conversationMessages.length }} 条最近对话记录</span>
      </div>
    </div>
    <div class="form-body">
      <h3 class="card-title">Webhook 回调</h3>
      <div class="inline-fields webhook-fields"><SlInput v-model="webhookName" placeholder="名称（可选）" aria-label="Webhook 名称" /><SlInput v-model="webhookUrl" placeholder="https://..." aria-label="Webhook URL" /><SlButton variant="filled" label="添加" @click="addHook" /></div>
      <div v-for="hook in state.webhooks" :key="hook.id" class="list-item"><div class="list-item-copy"><strong class="list-item-title">{{ hook.name || hook.url }}</strong><span class="list-item-subtitle">{{ hook.url }}</span></div><SlButton variant="icon" icon="delete" title="删除 Webhook" @click="removeHook(hook.id)" /></div>
    </div>
  </SectionCard>

  <SectionCard title="歌曲索引" icon="database" description="索引供语音口令快速匹配歌曲和歌单。">
    <div class="form-body">
      <div class="status-panel status-panel-inset"><div class="status-chips"><span class="chip" :class="state.indexStatus.ready || state.indexStatus.is_ready ? 'chip-success' : 'chip-warning'">{{ state.indexStatus.ready || state.indexStatus.is_ready ? '索引就绪' : '索引未就绪' }}</span><span class="chip">{{ state.indexStatus.song_count || 0 }} 首歌曲</span><span class="chip">{{ state.indexStatus.playlist_count || 0 }} 个歌单</span></div></div>
      <div class="field"><label class="field-label">最大索引歌曲数</label><SlInput :model-value="maxIndex" type="number" @update:model-value="maxIndex = $event" @change="saveNumber('max_song_index', maxIndex, 1000, 100000)" /></div>
      <div class="field-actions"><SlButton variant="outlined" label="刷新索引" icon="refresh" @click="refreshIndex" /></div>
    </div>
  </SectionCard>

  <SectionCard title="语音口令" icon="mic" description="为每种操作维护可识别的口令词；添加、删除和启停都会立即保存。">
    <SettingRow title="启用语音口令" :subtitle="state.config.conversation_monitor_enabled ? '将对话监听结果交给播放器执行' : '需要先开启对话监听'">
      <SlSwitch :model-value="state.config.voice_command_enabled" :disabled="!state.config.conversation_monitor_enabled" @update:model-value="setVoiceEnabled" />
    </SettingRow>
    <div v-if="!state.config.conversation_monitor_enabled" class="dependency-hint"><SlIcon name="warning" :size="18" /><span>需要先开启“对话监听”才能使用语音口令。</span></div>
    <div v-if="state.config.voice_command_enabled" class="dependency-hint"><SlIcon name="info" :size="18" /><span>口令触发后，音箱会先播完自身的语音回复，再由插件打断并开始播放，中间会有短暂延迟。</span></div>
    <div class="form-body">
      <button type="button" class="advanced-toggle" @click="voiceCommandsExpanded = !voiceCommandsExpanded">
        <span>{{ voiceCommandsExpanded ? '收起语音口令配置' : '展开语音口令配置' }}</span>
        <SlIcon :name="voiceCommandsExpanded ? 'expand_less' : 'expand_more'" :size="20" />
      </button>
      <div v-if="voiceCommandsExpanded" class="voice-command-list">
        <div v-for="(command, index) in state.voiceCommands" :key="commandKey(command, index)" class="voice-command-group">
          <div class="voice-command-header">
            <SlIcon :name="commandIcons[command.type] || 'label'" :size="20" />
            <strong>{{ commandLabels[command.type] || command.type }}</strong>
            <span v-if="command.param" class="command-param">{{ parameterLabels[command.param] || command.param }}</span>
            <SlSwitch :model-value="command.enabled !== false" :disabled="commandSaving" :aria-label="`启用${commandLabels[command.type] || command.type}`" @update:model-value="setCommandEnabled(index, $event)" />
          </div>
          <div class="command-keywords">
            <span v-for="(keyword, keywordIndex) in keywordsOf(command)" :key="`${keyword}-${keywordIndex}`" class="command-keyword">
              <span>{{ keyword }}</span>
              <button type="button" title="删除口令词" :aria-label="`删除口令词 ${keyword}`" :disabled="commandSaving" @click="removeKeyword(command, index, keywordIndex)"><SlIcon name="close" :size="14" /></button>
            </span>
          </div>
          <div class="command-add-row">
            <SlInput :model-value="commandInputs[commandKey(command, index)] || ''" :input-key="commandInputVersions[commandKey(command, index)] || 0" placeholder="添加口令词" aria-label="添加口令词" @update:model-value="commandInputs[commandKey(command, index)] = $event" @submit="addKeyword(command, index)" />
            <SlButton variant="icon" icon="add" title="添加口令词" :disabled="commandSaving" @click="addKeyword(command, index)" />
          </div>
        </div>
        <div v-if="!state.voiceCommands.length" class="empty-state">暂无语音口令</div>
        <div class="field-actions"><SlButton variant="text" label="恢复默认" icon="restart_alt" :disabled="commandSaving" @click="resetCommands" /></div>
      </div>
      <div v-else class="collapsed-summary">
        <span class="chip">{{ state.voiceCommands.length }} 条语音口令</span>
      </div>
    </div>
    <div class="command-test-panel">
      <strong>口令测试</strong>
      <p>模拟当前所选设备收到语音口令，会实际执行匹配到的操作。</p>
      <div class="inline-fields"><SlInput v-model="commandTestQuery" placeholder="例如：我今天想听周杰伦的晴天" aria-label="口令测试输入" @submit="testCommand" /><SlButton variant="filled" label="执行测试" icon="play_arrow" :disabled="commandTestBusy || !state.currentDeviceId" @click="testCommand" /></div>
      <pre v-if="commandTestResult" class="result-pre" :class="commandTestSuccess ? 'result-success' : 'result-error'">{{ commandTestResult }}</pre>
    </div>
  </SectionCard>

  <SectionCard title="语音记忆" icon="memory" description="记录用户说法与歌曲实体的对应关系，减少重复 AI 分析。">
    <SettingRow title="启用语音记忆" subtitle="关闭后保留历史记忆，但不再写入新记录"><SlSwitch :model-value="state.config.voice_memory_enabled" @update:model-value="setSwitch('voice_memory_enabled', $event)" /></SettingRow>
    <div class="form-body">
      <button type="button" class="advanced-toggle" @click="toggleMemoryExpanded">
        <span>{{ memoryExpanded ? '收起语音记忆' : '展开语音记忆' }}</span>
        <SlIcon :name="memoryExpanded ? 'expand_less' : 'expand_more'" :size="20" />
      </button>
      <div v-if="memoryExpanded" class="sub-panel memory-list">
        <div class="field"><label class="field-label">最大记忆数量（10-500）</label><SlInput :model-value="maxMemory" type="number" @update:model-value="maxMemory = $event" @change="saveNumber('voice_memory_max_records', maxMemory, 10, 500)" /></div>
        <div class="status-chips"><span class="chip">已保存 {{ state.memoryStats.recordCount || state.memoryStats.queryCount || 0 }} 条</span><span class="chip">已学习 {{ state.memoryStats.entityCount || 0 }} 首</span><span class="chip">本地命中 {{ state.memoryStats.localHitCount || state.memoryStats.hitCount || 0 }} 次</span></div>
        <div class="field-actions"><SlButton variant="text" label="刷新" icon="refresh" @click="ensureMemoryLoaded(true)" /><SlButton variant="text" label="清空全部" icon="delete_sweep" @click="clearMemory" /></div>
        <div class="memory-list-body">
          <div v-for="entity in state.memoryEntities" :key="String(entity.canonicalKey || entity.canonical_key)" class="memory-entity">
            <div class="list-item"><div class="list-item-copy"><strong class="list-item-title">{{ entity.songName || '未命名歌曲' }}{{ entity.artist ? ` · ${entity.artist}` : '' }}</strong><span class="list-item-subtitle">{{ memoryAliases(entity).length }} 种说法</span></div><SlButton variant="icon" :icon="expandedMemory === String(entity.canonicalKey || entity.canonical_key) ? 'expand_less' : 'expand_more'" title="展开记忆" @click="expandedMemory = expandedMemory === String(entity.canonicalKey || entity.canonical_key) ? null : String(entity.canonicalKey || entity.canonical_key)" /><SlButton variant="icon" icon="delete" title="删除歌曲记忆" @click="deleteMemoryEntity(String(entity.canonicalKey || entity.canonical_key), entity.songName || '歌曲')" /></div>
            <div v-if="expandedMemory === String(entity.canonicalKey || entity.canonical_key)" class="memory-aliases">
              <div v-for="(alias, index) in memoryAliases(entity)" :key="alias.id || index" class="memory-alias-row"><span>{{ alias.query || alias.alias || '未命名说法' }}</span><SlButton v-if="alias.id" variant="icon" icon="close" title="删除这条记忆" @click="deleteMemoryRecord(alias.id)" /></div>
            </div>
          </div>
          <div v-if="!state.memoryEntities.length" class="empty-state">暂无可聚合的歌曲记忆</div>
          <div v-if="state.memoryUnclassified.length" class="field-help">未归类记忆 {{ state.memoryUnclassified.length }} 条</div>
          <div v-if="state.memoryAmbiguous.length" class="field-help">最近歧义 {{ state.memoryAmbiguous.length }} 条</div>
        </div>
      </div>
      <div v-else class="collapsed-summary">
        <span class="chip">记忆数据按需加载</span>
      </div>
    </div>
  </SectionCard>

  <SectionCard title="外部搜索" icon="search" description="本地曲库未命中时，按优先级调用已启用的搜索源。">
    <SettingRow title="启用外部搜索" :subtitle="state.config.voice_command_enabled ? '搜索源需要返回 topone 格式结果' : '需要先开启语音口令'"><SlSwitch :model-value="state.config.external_search_enabled" :disabled="!state.config.voice_command_enabled" @update:model-value="setExternalSearchEnabled" /></SettingRow>
    <div v-if="!state.config.voice_command_enabled" class="dependency-hint"><SlIcon name="warning" :size="18" /><span>需要先开启“语音口令”才能使用外部搜索。</span></div>
    <div class="form-body">
      <div class="field"><label class="field-label">搜索优先级</label><SlSelect :model-value="state.config.search_priority" :options="searchPriorityOptions" aria-label="搜索优先级" @update:model-value="saveConfig({ search_priority: $event as 'parallel' | 'local_first' | 'external_first' })" /></div>
      <div class="field-grid"><div class="field"><label class="field-label">超时（秒）</label><SlInput :model-value="externalSearchTimeout" type="number" aria-label="外部搜索超时" @update:model-value="externalSearchTimeout = $event" @change="saveConfig({ external_search_timeout: Math.max(3, Math.min(60, Number(externalSearchTimeout) || 6)) })" /></div><div class="field setting-field-control"><label class="field-label">不入库直接播放</label><SlSwitch :model-value="state.config.external_search_no_import" @update:model-value="setSwitch('external_search_no_import', $event)" /></div></div>
      <div class="field-grid"><div class="field setting-field-control"><label class="field-label">自动追加到歌单</label><SlSwitch :model-value="appendPlaylistEnabled" @update:model-value="setAppendPlaylistEnabled" /></div><div v-if="appendPlaylistEnabled" class="field"><label class="field-label">目标歌单</label><SlSelect :model-value="state.config.external_search_playlist_id" :options="playlistOptions" searchable search-placeholder="搜索歌单" aria-label="目标歌单" @update:model-value="setAppendPlaylistId" /></div></div>
      <h3 class="card-title">已安装搜索源</h3>
      <div class="field-grid">
        <div class="field">
          <label class="field-label">快速选择</label>
          <SlSelect
            :model-value="selectedProviderId"
            :options="searchProviderOptions"
            allow-empty
            placeholder="选择后立即添加/启用"
            aria-label="选择已安装搜索源"
            @update:model-value="applyProvider"
          />
        </div>
        <div class="field setting-field-control">
          <label class="field-label">操作</label>
          <div class="field-actions field-actions-tight">
            <SlButton variant="outlined" label="刷新" icon="refresh" @click="refreshSearchProviders" />
          </div>
        </div>
      </div>
      <h3 class="card-title section-subtitle">已配置源</h3>
      <div v-for="source in state.config.external_search_sources" :key="source.id" class="sub-panel sub-panel-inset">
        <!-- 各包一层 .field 是为了拿到与其它表单行一致的 16px 行距：.field-grid 的
             row-gap 是 0，裸 input 会挤在一起。这一行在 APP 里整体不显示的根因是
             WebF 不绘制 grid 容器，已在 style.css 把 .field-grid 改成 flex
             （songloft-org/songloft-plugin-miot#79）。 -->
        <div class="field-grid"><div class="field"><SlInput v-model="sourceDrafts[source.id].name" placeholder="显示名称" /></div><div class="field"><SlInput v-model="sourceDrafts[source.id].url" placeholder="接口地址" /></div></div>
        <SlInput v-model="sourceDrafts[source.id].token" type="password" placeholder="Bearer Token（可选）" />
        <SettingRow title="启用此源"><SlSwitch v-model="sourceDrafts[source.id].enabled" /></SettingRow>
        <div class="field-actions"><SlButton variant="text" label="移除" icon="delete" @click="removeSource(source.id)" /></div>
      </div>
      <div v-if="!state.config.external_search_sources.length" class="empty-state">暂无已配置源，从上方「快速选择」添加，或手动添加</div>
      <div class="field-actions">
        <SlButton variant="outlined" label="手动添加搜索源" icon="add" @click="showManualAdd = !showManualAdd" />
        <SlButton variant="filled" label="保存全部" icon="save" @click="saveSources" />
      </div>
      <div v-if="showManualAdd" class="sub-panel sub-panel-inset"><div class="field-grid"><div class="field"><SlInput v-model="newSourceName" placeholder="新源名称" /></div><div class="field"><SlInput v-model="newSourceUrl" placeholder="接口 URL" /></div></div><SlInput v-model="newSourceToken" type="password" placeholder="Token（可选）" /><div class="field-actions"><SlButton variant="outlined" label="添加" icon="add" @click="addSource" /><SlButton variant="text" label="取消" @click="showManualAdd = false" /></div></div>
      <div class="field"><label class="field-label">接口测试</label><div class="inline-fields"><SlInput v-model="sourceTestQuery" placeholder="输入测试关键字" @submit="testSource" /><SlButton variant="outlined" label="测试" @click="testSource" /></div><pre v-if="sourceTestResult" class="result-pre">{{ sourceTestResult }}</pre></div>
    </div>
  </SectionCard>

  <SectionCard title="AI 口令分析" icon="auto_awesome" description="可选的 OpenAI 兼容接口，用于解析复杂自然语言口令。">
    <SettingRow title="启用 AI 分析" :subtitle="state.config.voice_command_enabled ? '规则和记忆未命中时再调用 AI' : '需要先开启语音口令'"><SlSwitch :model-value="!!state.config.ai_config.enabled" :disabled="!state.config.voice_command_enabled" @update:model-value="setAIEnabled" /></SettingRow>
    <div v-if="!state.config.voice_command_enabled" class="dependency-hint"><SlIcon name="warning" :size="18" /><span>需要先开启“语音口令”才能使用 AI 分析。</span></div>
    <div class="form-body">
      <div class="field"><label class="field-label">API 地址</label><SlInput :model-value="state.config.ai_config.api_url || ''" placeholder="https://api.example.com/v1" @update:model-value="state.config.ai_config.api_url = $event" @change="saveConfig({ ai_config: state.config.ai_config })" /></div>
      <div class="field"><label class="field-label">API Key</label><SlInput :model-value="state.config.ai_config.api_key || ''" type="password" placeholder="sk-..." @update:model-value="state.config.ai_config.api_key = $event" @change="saveConfig({ ai_config: state.config.ai_config })" /></div>
      <div class="field-grid"><div class="field"><label class="field-label">模型</label><SlInput :model-value="state.config.ai_config.model || ''" placeholder="qwen-flash" @update:model-value="state.config.ai_config.model = $event" @change="saveConfig({ ai_config: state.config.ai_config })" /></div><div class="field"><label class="field-label">超时（秒）</label><SlInput :model-value="String(state.config.ai_config.timeout || 6)" type="number" @update:model-value="state.config.ai_config.timeout = Math.max(1, Math.min(30, Number($event) || 6))" @change="saveConfig({ ai_config: state.config.ai_config })" /></div></div>
      <div class="command-test-panel command-test-panel-inset"><strong>AI 分析测试</strong><div class="inline-fields"><SlInput v-model="aiTestQuery" placeholder="输入自然语言口令" @submit="testAI" /><SlButton variant="outlined" label="测试分析" icon="science" :disabled="aiTestBusy" @click="testAI" /></div><pre v-if="aiTestResult" class="result-pre">{{ aiTestResult }}</pre></div>
    </div>
  </SectionCard>
</template>
