import { PluginSocket as WebSocket } from '../../socket';
import { onPush } from '@songloft/lynx-plugin-sdk';
import {
  displayText,
  usePageState,
  NativeView,
  classes,
  styleObject,
  renderItems,
} from '../../page-state';
import {
  computed,
  onMounted,
  onUnmounted,
  reactive,
  ref,
  watch,
} from '../../page-state';
import SectionCard from '../../ui/SectionCard.tsx';
import SettingRow from '../../ui/SettingRow.tsx';
import SlButton from '../../ui/SlButton.tsx';
import SlIcon from '../../ui/SlIcon.tsx';
import SlInput from '../../ui/SlInput.tsx';
import SlSelect from '../../ui/SlSelect.tsx';
import SlSwitch from '../../ui/SlSwitch.tsx';
import VoiceSectionNav from './voice/VoiceSectionNav.tsx';
import { del, post, pluginWebSocketUrl } from '../../api';
import { navigation } from '../../runtime';
import {
  addWebhook,
  clearMemory,
  confirmAction,
  deleteWebhook,
  loadConversationMessages,
  loadMemory,
  loadSearchProviders,
  loadVoiceData,
  managedDevices,
  messageOf,
  notify,
  playlistLabel,
  refreshIndex,
  saveConfig,
  saveVoiceCommands,
  state,
} from '../../store';
import type {
  MemoryEntity,
  SearchSource,
  SelectOption,
  VoiceCommand,
} from '../../types';
type VoicePanel = 'listen' | 'commands' | 'memory' | 'intelligence';
interface CommandTestResult {
  matched: boolean;
  source: 'ai' | 'rule' | 'none';
  commandType?: string;
  keyword?: string;
  argument?: string;
  search?: {
    kind: 'song' | 'playlist';
    found: boolean;
    detail: string;
  } | null;
  ai?: {
    action: string;
    confidence: string;
  } | null;
  executed: boolean;
  note?: string;
}
const pageState = {
  name: 'VoiceSettings',
  createState(input, {}) {
    const voicePanel = ref<VoicePanel>('listen');
    const voicePanels: Array<{
      id: VoicePanel;
      title: string;
      subtitle: string;
      icon: string;
    }> = [
      {
        id: 'listen',
        title: '监听',
        subtitle: '对话与索引',
        icon: 'record_voice_over',
      },
      { id: 'commands', title: '口令', subtitle: '规则与测试', icon: 'mic' },
      { id: 'memory', title: '记忆', subtitle: '命中与歧义', icon: 'memory' },
      {
        id: 'intelligence',
        title: '搜索',
        subtitle: '匹配与搜索源',
        icon: 'auto_awesome',
      },
    ];
    const commandLabels: Record<string, string> = {
      play_playlist: '播放歌单',
      play_artist: '播放歌手',
      play_song: '播放歌曲',
      play_index: '播放指定序号',
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
      play_index: 'format_list_numbered',
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
      { value: 'parallel', label: '并行搜索（匹配度优先）' },
      { value: 'local_first', label: '本地优先' },
      { value: 'external_first', label: '外部源优先' },
    ];
    const appendPlaylistEnabled = computed(
      () => !!state.config.external_search_playlist_id,
    );
    const writablePlaylists = computed(() =>
      state.playlists.filter((p) => p.id > 0 && !p.is_virtual),
    );
    const playlistOptions = computed<SelectOption[]>(() =>
      writablePlaylists.value.map((p) => ({
        value: String(p.id),
        label: playlistLabel(p),
        searchText: p.name,
      })),
    );
    function setAppendPlaylistEnabled(enabled: boolean): void {
      if (!enabled) {
        void saveConfig({ external_search_playlist_id: '' });
      } else if (writablePlaylists.value.length) {
        void saveConfig({
          external_search_playlist_id: String(writablePlaylists.value[0].id),
        });
      }
    }
    function setAppendPlaylistId(value: string): void {
      void saveConfig({ external_search_playlist_id: value });
    }
    const pollInterval = ref(String(state.config.conversation_poll_interval));
    const maxIndex = ref(String(state.config.max_song_index));
    const maxMemory = ref(String(state.config.voice_memory_max_records));
    const songMatchThreshold = ref(String(state.config.song_match_threshold));
    watch(
      () => state.config.song_match_threshold,
      (value) => {
        songMatchThreshold.value = String(value);
      },
    );
    const externalSearchTimeout = ref(
      String(state.config.external_search_timeout),
    );
    const webhookName = ref('');
    const webhookUrl = ref('');
    const commandInputs = reactive<Record<string, string>>({});
    const commandInputVersions = reactive<Record<string, number>>({});
    const commandSaving = ref(false);
    const commandTestQuery = ref('');
    const commandTestResult = ref('');
    const commandTestSuccess = ref(false);
    const commandTestBusy = ref(false);
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
    let hostVisible = true,
      disposed = false,
      stopLifecycle = () => {};
    const conversationVisible = () =>
      hostVisible &&
      navigation.page === 'settings' &&
      navigation.settingsCategory === 'voice';
    function syncSourceDrafts(): void {
      for (const source of Array.isArray(state.config.external_search_sources)
        ? state.config.external_search_sources
        : []) {
        sourceDrafts[source.id] = { ...source };
      }
    }
    function providerKey(provider: {
      id?: string;
      entry_path?: string;
      entryPath?: string;
      name: string;
    }): string {
      return String(
        provider.id ||
          provider.entry_path ||
          provider.entryPath ||
          provider.name,
      );
    }
    const showManualAdd = ref(false);
    /**
     * 快速选择已安装搜索源：选择即添加/启用，直达可用，无需再手动填表单点添加。
     * 幂等——按 URL 匹配已配置源：已存在则确保启用，不存在则新增一条启用状态的源。
     */
    async function applyProvider(providerId: string): Promise<void> {
      if (!providerId) return;
      const provider = state.searchProviders.find(
        (item) => providerKey(item) === providerId,
      );
      if (!provider) return;
      const url = (provider.url || '/api/search/topone').trim();
      const displayName = provider.name || url;
      const existing = state.config.external_search_sources.find(
        (s) => (s.url || '').trim() === url,
      );
      try {
        if (existing) {
          if (!existing.enabled) {
            const sources = state.config.external_search_sources.map((s) =>
              s.id === existing.id ? { ...s, enabled: true } : s,
            );
            if (sourceDrafts[existing.id])
              sourceDrafts[existing.id].enabled = true;
            await saveConfig({ external_search_sources: sources });
            notify(
              `已启用搜索源「${existing.name || displayName}」`,
              'success',
            );
          } else {
            notify(
              `搜索源「${existing.name || displayName}」已在配置中`,
              'success',
            );
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
      } catch {
        /* saveConfig presents the error */
      }
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
      stopLifecycle = onPush((event, raw) => {
        if (event !== 'lifecycle') return;
        hostVisible = JSON.parse(String(raw)).state === 'resumed';
        if (
          hostVisible &&
          state.config.conversation_monitor_enabled &&
          conversationVisible()
        )
          connectConversation();
        else disconnectConversation();
      });
      await Promise.all([loadVoiceData(), loadSearchProviders()]);
      if (disposed) return;
      syncSourceDrafts();
      if (state.config.conversation_monitor_enabled && conversationVisible())
        connectConversation();
    });
    watch(
      () => [navigation.page, navigation.settingsCategory],
      () => {
        if (conversationVisible() && state.config.conversation_monitor_enabled)
          connectConversation();
        else disconnectConversation();
      },
    );
    onUnmounted(() => {
      disposed = true;
      stopLifecycle();
      disconnectConversation();
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
    async function replaceCommand(
      index: number,
      update: (command: VoiceCommand) => void,
    ): Promise<boolean> {
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
    async function addKeyword(
      command: VoiceCommand,
      index: number,
    ): Promise<void> {
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
      if (
        await replaceCommand(
          index,
          (item) => (item.keywords = [...keywordsOf(item), keyword]),
        )
      ) {
        commandInputs[key] = '';
        commandInputVersions[key] = (commandInputVersions[key] || 0) + 1;
      }
    }
    async function removeKeyword(
      command: VoiceCommand,
      index: number,
      keywordIndex: number,
    ): Promise<void> {
      if (keywordsOf(command).length <= 1) {
        notify('每条命令至少保留一个口令词', 'warning');
        return;
      }
      await replaceCommand(
        index,
        (item) =>
          (item.keywords = keywordsOf(item).filter(
            (_, i) => i !== keywordIndex,
          )),
      );
    }
    async function setCommandEnabled(
      index: number,
      enabled: boolean,
    ): Promise<void> {
      await replaceCommand(index, (command) => (command.enabled = enabled));
    }
    async function resetCommands(): Promise<void> {
      if (
        !(
          await confirmAction(
            '恢复默认口令',
            '当前自定义口令词会被默认配置覆盖。',
            '恢复默认',
          )
        ).confirmed
      )
        return;
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
      } catch {
        /* saveConfig presents the error */
      }
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
      try {
        await saveConfig(patch);
      } catch {
        /* saveConfig presents the error */
      }
    }
    async function setExternalSearchEnabled(enabled: boolean): Promise<void> {
      if (enabled && !state.config.voice_command_enabled) {
        notify('请先开启语音口令', 'warning');
        return;
      }
      try {
        await saveConfig({ external_search_enabled: enabled });
      } catch {
        /* saveConfig presents the error */
      }
    }
    function setSwitch(key: keyof typeof state.config, value: boolean): void {
      void saveConfig({ [key]: value } as never);
    }
    async function saveNumber(
      key:
        | 'conversation_poll_interval'
        | 'max_song_index'
        | 'voice_memory_max_records',
      raw: string,
      min: number,
      max: number,
    ): Promise<void> {
      const value = Math.max(
        min,
        Math.min(max, Number.parseInt(raw, 10) || min),
      );
      if (key === 'conversation_poll_interval')
        pollInterval.value = String(value);
      if (key === 'max_song_index') maxIndex.value = String(value);
      if (key === 'voice_memory_max_records') maxMemory.value = String(value);
      try {
        await saveConfig({ [key]: value });
        if (key === 'voice_memory_max_records' && memoryExpanded.value)
          await ensureMemoryLoaded(true);
      } catch {
        /* saveConfig presents the error */
      }
    }
    function connectConversation(): void {
      disconnectConversation();
      if (!conversationVisible() || !state.config.conversation_monitor_enabled)
        return;
      if (typeof WebSocket === 'undefined') {
        conversationPoll = setInterval(
          () => void loadConversationMessages(),
          4000,
        );
        return;
      }
      try {
        conversationSocket = new WebSocket(
          pluginWebSocketUrl('/conversation/ws?limit=50'),
        );
        const socket = conversationSocket;
        conversationSocket.onopen = () => {
          if (conversationSocket !== socket) return;
          if (conversationPoll) clearInterval(conversationPoll);
          conversationPoll = null;
        };
        conversationSocket.onmessage = (event) => {
          if (conversationSocket !== socket || !conversationVisible()) return;
          try {
            const frame = JSON.parse(String(event.data));
            if (frame.type === 'snapshot')
              state.conversationMessages = frame.data || [];
            else if (frame.type === 'message' || frame.type === 'update') {
              const incoming = frame.data;
              const index = state.conversationMessages.findIndex(
                (item) =>
                  item.account_id === incoming.account_id &&
                  item.device_id === incoming.device_id &&
                  item.id === incoming.id &&
                  item.timestamp === incoming.timestamp,
              );
              if (index >= 0) state.conversationMessages[index] = incoming;
              else if (frame.type === 'message')
                state.conversationMessages.unshift(incoming);
            }
          } catch {
            /* ignore malformed stream frame */
          }
        };
        conversationSocket.onerror = () => socket.close();
        conversationSocket.onclose = () => {
          if (conversationSocket !== socket) return;
          conversationSocket = null;
          if (
            conversationVisible() &&
            state.config.conversation_monitor_enabled &&
            !conversationPoll
          ) {
            conversationPoll = setInterval(
              () => void loadConversationMessages(),
              4000,
            );
          }
        };
      } catch {
        conversationPoll = setInterval(
          () => void loadConversationMessages(),
          4000,
        );
      }
    }
    function disconnectConversation(): void {
      const socket = conversationSocket;
      conversationSocket = null;
      socket?.close();
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
      if (
        !(
          await confirmAction(
            '删除 Webhook',
            '确定删除这个回调地址吗？',
            '删除',
            true,
          )
        ).confirmed
      )
        return;
      try {
        await deleteWebhook(id);
      } catch (error) {
        notify(messageOf(error), 'error');
      }
    }
    function formatCommandResult(
      result: CommandTestResult,
      elapsedMs: number,
    ): string {
      const lines: string[] = [];
      if (!result.matched) {
        lines.push('未匹配到口令');
      } else {
        lines.push(
          `匹配来源：${result.source === 'ai' ? 'AI 分析' : '规则匹配'}`,
        );
        if (result.commandType)
          lines.push(
            `命令：${commandLabels[result.commandType] || result.commandType}`,
          );
        if (result.keyword) lines.push(`命中口令词：${result.keyword}`);
        if (result.argument) lines.push(`搜索参数：${result.argument}`);
        if (result.search) {
          lines.push(
            `${result.search.kind === 'playlist' ? '歌单' : '歌曲'}：${result.search.found ? '已找到' : '未找到'} ${result.search.detail}`,
          );
        }
        if (result.ai)
          lines.push(`AI：${result.ai.action}，置信度 ${result.ai.confidence}`);
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
        commandTestResult.value = formatCommandResult(
          result,
          Date.now() - startedAt,
        );
      } catch (error) {
        commandTestSuccess.value = false;
        commandTestResult.value = messageOf(error);
      } finally {
        commandTestBusy.value = false;
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
      const removed = state.config.external_search_sources.find(
        (source) => source.id === id,
      );
      const sources = state.config.external_search_sources.filter(
        (source) => source.id !== id,
      );
      delete sourceDrafts[id];
      await saveConfig({ external_search_sources: sources });
      if (removed)
        notify(`已移除搜索源「${removed.name || removed.url}」`, 'success');
    }
    async function saveSources(): Promise<void> {
      const sources = (
        Array.isArray(state.config.external_search_sources)
          ? state.config.external_search_sources
          : []
      ).map((source) => ({
        ...(sourceDrafts[source.id] || source),
      }));
      await saveConfig({ external_search_sources: sources });
      notify('外部搜索源已保存', 'success');
    }
    async function testSource(): Promise<void> {
      if (!sourceTestQuery.value.trim()) return;
      const source = state.config.external_search_sources.find(
        (item) => item.enabled,
      );
      if (!source) {
        sourceTestResult.value = '没有启用的搜索源';
        return;
      }
      try {
        sourceTestResult.value = JSON.stringify(
          await post('/search-providers/test', {
            keyword: sourceTestQuery.value.trim(),
            source_id: source.id,
          }),
          null,
          2,
        );
      } catch (error) {
        sourceTestResult.value = messageOf(error);
      }
    }
    async function refreshSearchProviders(): Promise<void> {
      await loadSearchProviders();
      if (
        selectedProviderId.value &&
        !selectableSearchProviders.value.some(
          (provider) => providerKey(provider) === selectedProviderId.value,
        )
      ) {
        selectedProviderId.value = '';
      }
      notify(
        state.searchProviders.length
          ? `已刷新，发现 ${state.searchProviders.length} 个已安装搜索源`
          : '已刷新，暂未发现已安装搜索源',
        'success',
      );
    }
    function memoryAliases(entity: MemoryEntity): Array<{
      id?: string;
      query?: string;
      alias?: string;
    }> {
      return entity.aliases || entity.records || [];
    }
    async function deleteMemoryEntity(
      key: string,
      title: string,
    ): Promise<void> {
      if (
        !(
          await confirmAction(
            '删除语音记忆',
            `确定删除"${title}"的全部记忆吗？`,
            '删除',
            true,
          )
        ).confirmed
      )
        return;
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
    const bindings = {
      voicePanel,
      voicePanels,
      commandLabels,
      commandIcons,
      parameterLabels,
      searchPriorityOptions,
      appendPlaylistEnabled,
      writablePlaylists,
      playlistOptions,
      setAppendPlaylistEnabled,
      setAppendPlaylistId,
      pollInterval,
      maxIndex,
      maxMemory,
      songMatchThreshold,
      externalSearchTimeout,
      webhookName,
      webhookUrl,
      commandInputs,
      commandInputVersions,
      commandSaving,
      commandTestQuery,
      commandTestResult,
      commandTestSuccess,
      commandTestBusy,
      sourceTestQuery,
      sourceTestResult,
      selectedProviderId,
      newSourceName,
      newSourceUrl,
      newSourceToken,
      sourceDrafts,
      voiceCommandsExpanded,
      conversationMessagesExpanded,
      memoryExpanded,
      memoryLoaded,
      memoryLoading,
      expandedMemory,
      get conversationSocket() {
        return conversationSocket;
      },
      set conversationSocket(v) {
        conversationSocket = v;
      },
      get conversationPoll() {
        return conversationPoll;
      },
      set conversationPoll(v) {
        conversationPoll = v;
      },
      syncSourceDrafts,
      providerKey,
      showManualAdd,
      applyProvider,
      selectableSearchProviders,
      searchProviderOptions,
      commandKey,
      keywordsOf,
      cloneCommand,
      replaceCommand,
      addKeyword,
      removeKeyword,
      setCommandEnabled,
      resetCommands,
      setConversationEnabled,
      setVoiceEnabled,
      setExternalSearchEnabled,
      setSwitch,
      saveNumber,
      connectConversation,
      disconnectConversation,
      refreshConversation,
      ensureMemoryLoaded,
      toggleMemoryExpanded,
      addHook,
      removeHook,
      formatCommandResult,
      testCommand,
      addSource,
      removeSource,
      saveSources,
      testSource,
      refreshSearchProviders,
      memoryAliases,
      deleteMemoryEntity,
      deleteMemoryRecord,
      SectionCard,
      SettingRow,
      SlButton,
      SlIcon,
      SlInput,
      SlSelect,
      SlSwitch,
      VoiceSectionNav,
      get navigation() {
        return navigation;
      },
      get clearMemory() {
        return clearMemory;
      },
      get managedDevices() {
        return managedDevices;
      },
      get refreshIndex() {
        return refreshIndex;
      },
      get saveConfig() {
        return saveConfig;
      },
      get state() {
        return state;
      },
    };
    return bindings;
  },
};
export default function VoiceSettings(props: any) {
  const vm = usePageState(pageState, props);
  return (
    <>
      <VoiceSectionNav
        modelValue={vm.voicePanel}
        onUpdateModelValue={($event: any) => {
          vm.voicePanel = $event;
        }}
        panels={vm.voicePanels}
      ></VoiceSectionNav>
      <NativeView
        visible={!!(vm.voicePanel === 'listen')}
        className="voice-panel"
        data-voice-panel="listen"
      >
        <SectionCard
          title="对话监听"
          icon="record_voice_over"
          description="监听已启用管理的音箱对话记录，并把语音内容交给语音引擎。"
        >
          <SettingRow
            title="启用对话监听"
            subtitle="关闭后会同时关闭语音口令、AI 分析和外部搜索"
          >
            <SlSwitch
              aria-label="启用对话监听"
              modelValue={vm.state.config.conversation_monitor_enabled}
              onUpdateModelValue={($event: any) => {
                void vm.setConversationEnabled($event);
              }}
            ></SlSwitch>
          </SettingRow>
          <NativeView className="form-body">
            <NativeView className="field-grid">
              <NativeView className="field">
                <NativeView className="field-label">
                  <text>轮询间隔（秒）</text>
                </NativeView>
                <SlInput
                  modelValue={vm.pollInterval}
                  type="number"
                  min={1}
                  max={30}
                  step={1}
                  unit="秒"
                  onUpdateModelValue={($event: any) => {
                    vm.pollInterval = $event;
                  }}
                  onChange={($event: any) => {
                    vm.saveNumber(
                      'conversation_poll_interval',
                      vm.pollInterval,
                      1,
                      30,
                    );
                  }}
                ></SlInput>
                <NativeView className="field-help">
                  <text>
                    默认 2 秒，可设 1～30 秒。无新对话时逐步延长到 5
                    秒，所设间隔超过 5 秒时保持该值；收到新对话后恢复所设间隔。
                  </text>
                </NativeView>
              </NativeView>
              <NativeView className="field setting-field-control">
                <NativeView className="field-label">
                  <text>调试日志</text>
                </NativeView>
                <SlSwitch
                  modelValue={vm.state.config.debug_log_enabled}
                  onUpdateModelValue={($event: any) => {
                    vm.setSwitch('debug_log_enabled', $event);
                  }}
                ></SlSwitch>
              </NativeView>
            </NativeView>
            {vm.state.config.conversation_monitor_enabled ? (
              <NativeView className="status-panel status-panel-inset">
                <NativeView className="status-chips">
                  <NativeView className="chip chip-success">
                    <text>
                      {displayText(
                        vm.conversationSocket
                          ? 'WebSocket 已连接'
                          : '轮询回落中',
                      )}
                    </text>
                  </NativeView>
                  <NativeView
                    className={classes([
                      'chip',
                      classes(
                        vm.managedDevices.length
                          ? 'chip-success'
                          : 'chip-warning',
                      ),
                    ])}
                  >
                    <text>
                      {displayText(vm.managedDevices.length)} 台受管理设备
                    </text>
                  </NativeView>
                  <NativeView className="chip">
                    <text>
                      {displayText(vm.state.conversationMessages.length)}{' '}
                      条最近记录
                    </text>
                  </NativeView>
                </NativeView>
              </NativeView>
            ) : null}
            {vm.state.config.conversation_monitor_enabled &&
            !vm.managedDevices.length ? (
              <NativeView className="dependency-hint">
                <SlIcon name="warning" size={18}></SlIcon>
                <NativeView>
                  <text>
                    尚未勾选任何受管理设备，对话监听不会工作。请到"设备设置"勾选要监听的音箱。
                  </text>
                </NativeView>
              </NativeView>
            ) : null}
            <NativeView className="field-actions">
              <SlButton
                variant="text"
                label="刷新记录"
                icon="refresh"
                onClick={($event: any) => {
                  void vm.refreshConversation($event);
                }}
              ></SlButton>
            </NativeView>
          </NativeView>
          <NativeView className="form-body">
            <NativeView
              className="advanced-toggle"
              bindtap={($event: any) => {
                vm.conversationMessagesExpanded =
                  !vm.conversationMessagesExpanded;
              }}
              button
            >
              <NativeView>
                <text>
                  {displayText(
                    vm.conversationMessagesExpanded
                      ? '收起最近对话记录'
                      : '展开最近对话记录',
                  )}
                </text>
              </NativeView>
              <SlIcon
                name={
                  vm.conversationMessagesExpanded
                    ? 'expand_less'
                    : 'expand_more'
                }
                size={20}
              ></SlIcon>
            </NativeView>
            {vm.conversationMessagesExpanded ? (
              <NativeView className="sub-panel">
                {renderItems(vm.state.conversationMessages, (item) => (
                  <NativeView
                    key={String(item.id || item.timestamp)}
                    className="list-item"
                  >
                    <NativeView className="list-item-copy">
                      <NativeView className="list-item-title">
                        <text>
                          {displayText(item.query || item.text || '未识别内容')}
                        </text>
                      </NativeView>
                      <NativeView className="list-item-subtitle">
                        <text>
                          {displayText(
                            item.device_name || item.device_id || '设备',
                          )}{' '}
                          · {displayText(item.answer || '暂无回复')}
                        </text>
                      </NativeView>
                      {item.routing_trace?.length ? (
                        <NativeView className="list-item-subtitle">
                          <text>
                            {displayText(item.routing_trace.join(' → '))}
                          </text>
                        </NativeView>
                      ) : null}
                    </NativeView>
                  </NativeView>
                ))}
                {!vm.state.conversationMessages.length ? (
                  <NativeView className="empty-state">
                    <text>暂无对话记录</text>
                  </NativeView>
                ) : null}
              </NativeView>
            ) : (
              <NativeView className="collapsed-summary">
                <NativeView className="chip">
                  <text>
                    {displayText(vm.state.conversationMessages.length)}{' '}
                    条最近对话记录
                  </text>
                </NativeView>
              </NativeView>
            )}
          </NativeView>
          <NativeView className="form-body">
            <NativeView className="card-title">
              <text>Webhook 回调</text>
            </NativeView>
            <NativeView className="inline-fields webhook-fields">
              <SlInput
                modelValue={vm.webhookName}
                onUpdateModelValue={($event: any) => {
                  vm.webhookName = $event;
                }}
                placeholder="名称（可选）"
                aria-label="Webhook 名称"
              ></SlInput>
              <SlInput
                modelValue={vm.webhookUrl}
                onUpdateModelValue={($event: any) => {
                  vm.webhookUrl = $event;
                }}
                placeholder="https://..."
                aria-label="Webhook URL"
              ></SlInput>
              <SlButton
                variant="filled"
                label="添加"
                onClick={($event: any) => {
                  void vm.addHook($event);
                }}
              ></SlButton>
            </NativeView>
            {renderItems(vm.state.webhooks, (hook) => (
              <NativeView key={hook.id} className="list-item">
                <NativeView className="list-item-copy">
                  <NativeView className="list-item-title">
                    <text>{displayText(hook.name || hook.url)}</text>
                  </NativeView>
                  <NativeView className="list-item-subtitle">
                    <text>{displayText(hook.url)}</text>
                  </NativeView>
                </NativeView>
                <SlButton
                  variant="icon"
                  icon="delete"
                  title="删除 Webhook"
                  onClick={($event: any) => {
                    vm.removeHook(hook.id);
                  }}
                ></SlButton>
              </NativeView>
            ))}
          </NativeView>
        </SectionCard>
        <SectionCard
          title="歌曲索引"
          icon="database"
          description="索引供语音口令快速匹配歌曲和歌单。"
        >
          <NativeView className="form-body">
            <NativeView className="status-panel status-panel-inset">
              <NativeView className="status-chips">
                <NativeView
                  className={classes([
                    'chip',
                    classes(
                      vm.state.indexStatus.ready ||
                        vm.state.indexStatus.is_ready
                        ? 'chip-success'
                        : 'chip-warning',
                    ),
                  ])}
                >
                  <text>
                    {displayText(
                      vm.state.indexStatus.ready ||
                        vm.state.indexStatus.is_ready
                        ? '索引就绪'
                        : '索引未就绪',
                    )}
                  </text>
                </NativeView>
                <NativeView className="chip">
                  <text>
                    {displayText(vm.state.indexStatus.song_count || 0)} 首歌曲
                  </text>
                </NativeView>
                <NativeView className="chip">
                  <text>
                    {displayText(vm.state.indexStatus.playlist_count || 0)}{' '}
                    个歌单
                  </text>
                </NativeView>
              </NativeView>
            </NativeView>
            <NativeView className="field">
              <NativeView className="field-label">
                <text>最大索引歌曲数</text>
              </NativeView>
              <SlInput
                modelValue={vm.maxIndex}
                type="number"
                min={1000}
                max={100000}
                step={1}
                onUpdateModelValue={($event: any) => {
                  vm.maxIndex = $event;
                }}
                onChange={($event: any) => {
                  vm.saveNumber('max_song_index', vm.maxIndex, 1000, 100000);
                }}
              ></SlInput>
            </NativeView>
            <NativeView className="field-actions">
              <SlButton
                variant="outlined"
                label="刷新索引"
                icon="refresh"
                onClick={($event: any) => {
                  void vm.refreshIndex($event);
                }}
              ></SlButton>
            </NativeView>
          </NativeView>
        </SectionCard>
      </NativeView>
      <NativeView
        visible={!!(vm.voicePanel === 'commands')}
        className="voice-panel"
        data-voice-panel="commands"
      >
        <SectionCard
          title="语音口令"
          icon="mic"
          description="为每种操作维护可识别的口令词；添加、删除和启停都会立即保存。"
        >
          <SettingRow
            title="启用语音口令"
            subtitle={
              vm.state.config.conversation_monitor_enabled
                ? '将对话监听结果交给播放器执行'
                : '需要先开启对话监听'
            }
          >
            <SlSwitch
              aria-label="启用语音口令"
              modelValue={vm.state.config.voice_command_enabled}
              disabled={!vm.state.config.conversation_monitor_enabled}
              onUpdateModelValue={($event: any) => {
                void vm.setVoiceEnabled($event);
              }}
            ></SlSwitch>
          </SettingRow>
          {!vm.state.config.conversation_monitor_enabled ? (
            <NativeView className="dependency-hint">
              <SlIcon name="warning" size={18}></SlIcon>
              <NativeView>
                <text>需要先开启"对话监听"才能使用语音口令。</text>
              </NativeView>
            </NativeView>
          ) : null}
          {vm.state.config.voice_command_enabled ? (
            <NativeView className="dependency-hint">
              <SlIcon name="info" size={18}></SlIcon>
              <NativeView>
                <text>
                  口令触发后，音箱会先播完自身的语音回复，再由插件打断并开始播放，中间会有短暂延迟。
                </text>
              </NativeView>
            </NativeView>
          ) : null}
          <NativeView className="form-body">
            <NativeView
              className="advanced-toggle"
              bindtap={($event: any) => {
                vm.voiceCommandsExpanded = !vm.voiceCommandsExpanded;
              }}
              button
            >
              <NativeView>
                <text>
                  {displayText(
                    vm.voiceCommandsExpanded
                      ? '收起语音口令配置'
                      : '展开语音口令配置',
                  )}
                </text>
              </NativeView>
              <SlIcon
                name={vm.voiceCommandsExpanded ? 'expand_less' : 'expand_more'}
                size={20}
              ></SlIcon>
            </NativeView>
            {vm.voiceCommandsExpanded ? (
              <NativeView className="voice-command-list">
                {renderItems(vm.state.voiceCommands, (command, index) => (
                  <NativeView
                    key={vm.commandKey(command, index)}
                    className="voice-command-group"
                  >
                    <NativeView className="voice-command-header">
                      <SlIcon
                        name={vm.commandIcons[command.type] || 'label'}
                        size={20}
                      ></SlIcon>
                      <NativeView>
                        <text>
                          {displayText(
                            vm.commandLabels[command.type] || command.type,
                          )}
                        </text>
                      </NativeView>
                      {command.param ? (
                        <NativeView className="command-param">
                          <text>
                            {displayText(
                              vm.parameterLabels[command.param] ||
                                command.param,
                            )}
                          </text>
                        </NativeView>
                      ) : null}
                      <SlSwitch
                        modelValue={command.enabled !== false}
                        disabled={vm.commandSaving}
                        ariaLabel={`启用${vm.commandLabels[command.type] || command.type}`}
                        onUpdateModelValue={($event: any) => {
                          vm.setCommandEnabled(index, $event);
                        }}
                      ></SlSwitch>
                    </NativeView>
                    <NativeView className="command-keywords">
                      {renderItems(
                        vm.keywordsOf(command),
                        (keyword, keywordIndex) => (
                          <NativeView
                            key={`${keyword}-${keywordIndex}`}
                            className="command-keyword"
                          >
                            <NativeView>
                              <text>{displayText(keyword)}</text>
                            </NativeView>
                            <NativeView
                              ariaLabel={`删除口令词 ${keyword}`}
                              disabled={vm.commandSaving}
                              bindtap={($event: any) => {
                                vm.removeKeyword(command, index, keywordIndex);
                              }}
                              button
                            >
                              <SlIcon name="close" size={14}></SlIcon>
                            </NativeView>
                          </NativeView>
                        ),
                      )}
                    </NativeView>
                    <NativeView className="command-add-row">
                      <SlInput
                        modelValue={
                          vm.commandInputs[vm.commandKey(command, index)] || ''
                        }
                        inputKey={
                          vm.commandInputVersions[
                            vm.commandKey(command, index)
                          ] || 0
                        }
                        placeholder="添加口令词"
                        aria-label="添加口令词"
                        onUpdateModelValue={($event: any) => {
                          vm.commandInputs[vm.commandKey(command, index)] =
                            $event;
                        }}
                        onSubmit={($event: any) => {
                          vm.addKeyword(command, index);
                        }}
                      ></SlInput>
                      <SlButton
                        variant="icon"
                        icon="add"
                        title="添加口令词"
                        disabled={vm.commandSaving}
                        onClick={($event: any) => {
                          vm.addKeyword(command, index);
                        }}
                      ></SlButton>
                    </NativeView>
                  </NativeView>
                ))}
                {!vm.state.voiceCommands.length ? (
                  <NativeView className="empty-state">
                    <text>暂无语音口令</text>
                  </NativeView>
                ) : null}
                <NativeView className="field-actions">
                  <SlButton
                    variant="text"
                    label="恢复默认"
                    icon="restart_alt"
                    disabled={vm.commandSaving}
                    onClick={($event: any) => {
                      void vm.resetCommands($event);
                    }}
                  ></SlButton>
                </NativeView>
              </NativeView>
            ) : (
              <NativeView className="collapsed-summary">
                <NativeView className="chip">
                  <text>
                    {displayText(vm.state.voiceCommands.length)} 条语音口令
                  </text>
                </NativeView>
              </NativeView>
            )}
          </NativeView>
          <NativeView className="command-test-panel">
            <NativeView>
              <text>口令测试</text>
            </NativeView>
            <NativeView>
              <text>
                模拟当前所选设备收到语音口令，会实际执行匹配到的操作。
              </text>
            </NativeView>
            <NativeView className="inline-fields">
              <SlInput
                modelValue={vm.commandTestQuery}
                onUpdateModelValue={($event: any) => {
                  vm.commandTestQuery = $event;
                }}
                placeholder="例如：我今天想听周杰伦的晴天"
                aria-label="口令测试输入"
                onSubmit={($event: any) => {
                  void vm.testCommand($event);
                }}
              ></SlInput>
              <SlButton
                variant="filled"
                label="执行测试"
                icon="play_arrow"
                disabled={vm.commandTestBusy || !vm.state.currentDeviceId}
                onClick={($event: any) => {
                  void vm.testCommand($event);
                }}
              ></SlButton>
            </NativeView>
            {vm.commandTestResult ? (
              <NativeView
                className={classes([
                  'result-pre',
                  classes(
                    vm.commandTestSuccess ? 'result-success' : 'result-error',
                  ),
                ])}
              >
                <text>{displayText(vm.commandTestResult)}</text>
              </NativeView>
            ) : null}
          </NativeView>
        </SectionCard>
      </NativeView>
      <NativeView
        visible={!!(vm.voicePanel === 'memory')}
        className="voice-panel"
        data-voice-panel="memory"
      >
        <SectionCard
          title="语音记忆"
          icon="memory"
          description="记录用户说法与歌曲实体的对应关系，减少重复 AI 分析。"
        >
          <SettingRow
            title="启用语音记忆"
            subtitle="关闭后保留历史记忆，但不再写入新记录"
          >
            <SlSwitch
              aria-label="启用语音记忆"
              modelValue={vm.state.config.voice_memory_enabled}
              onUpdateModelValue={($event: any) => {
                vm.setSwitch('voice_memory_enabled', $event);
              }}
            ></SlSwitch>
          </SettingRow>
          <NativeView className="form-body">
            <NativeView
              className="advanced-toggle"
              bindtap={($event: any) => {
                void vm.toggleMemoryExpanded($event);
              }}
              button
            >
              <NativeView>
                <text>
                  {displayText(
                    vm.memoryExpanded ? '收起语音记忆' : '展开语音记忆',
                  )}
                </text>
              </NativeView>
              <SlIcon
                name={vm.memoryExpanded ? 'expand_less' : 'expand_more'}
                size={20}
              ></SlIcon>
            </NativeView>
            {vm.memoryExpanded ? (
              <NativeView className="sub-panel memory-list">
                <NativeView className="field">
                  <NativeView className="field-label">
                    <text>自动学习记忆上限（10-5000）</text>
                  </NativeView>
                  <SlInput
                    modelValue={vm.maxMemory}
                    type="number"
                    min={10}
                    max={5000}
                    step={1}
                    unit="条"
                    onUpdateModelValue={($event: any) => {
                      vm.maxMemory = $event;
                    }}
                    onChange={($event: any) => {
                      vm.saveNumber(
                        'voice_memory_max_records',
                        vm.maxMemory,
                        10,
                        5000,
                      );
                    }}
                  ></SlInput>
                  <NativeView className="field-help">
                    <text>手动添加的别名不计入此上限，也不会被自动淘汰。</text>
                  </NativeView>
                </NativeView>
                <NativeView className="status-chips">
                  <NativeView className="chip">
                    <text>
                      已保存{' '}
                      {displayText(
                        vm.state.memoryStats.recordCount ||
                          vm.state.memoryStats.queryCount ||
                          0,
                      )}{' '}
                      条
                    </text>
                  </NativeView>
                  <NativeView className="chip">
                    <text>
                      已学习{' '}
                      {displayText(vm.state.memoryStats.entityCount || 0)} 首
                    </text>
                  </NativeView>
                  <NativeView className="chip">
                    <text>
                      本地命中{' '}
                      {displayText(
                        vm.state.memoryStats.localHitCount ||
                          vm.state.memoryStats.hitCount ||
                          0,
                      )}{' '}
                      次
                    </text>
                  </NativeView>
                </NativeView>
                <NativeView className="field-actions">
                  <SlButton
                    variant="text"
                    label="刷新"
                    icon="refresh"
                    onClick={($event: any) => {
                      vm.ensureMemoryLoaded(true);
                    }}
                  ></SlButton>
                  <SlButton
                    variant="text"
                    label="清空全部"
                    icon="delete_sweep"
                    onClick={($event: any) => {
                      void vm.clearMemory($event);
                    }}
                  ></SlButton>
                </NativeView>
                <NativeView className="memory-list-body">
                  {renderItems(vm.state.memoryEntities, (entity) => (
                    <NativeView
                      key={String(entity.canonicalKey || entity.canonical_key)}
                      className="memory-entity"
                    >
                      <NativeView className="list-item">
                        <NativeView className="list-item-copy">
                          <NativeView className="list-item-title">
                            <text>
                              {displayText(entity.songName || '未命名歌曲')}
                              {displayText(
                                entity.artist ? ` · ${entity.artist}` : '',
                              )}
                            </text>
                          </NativeView>
                          <NativeView className="list-item-subtitle">
                            <text>
                              {displayText(vm.memoryAliases(entity).length)}{' '}
                              种说法
                            </text>
                          </NativeView>
                        </NativeView>
                        <SlButton
                          variant="icon"
                          icon={
                            vm.expandedMemory ===
                            String(entity.canonicalKey || entity.canonical_key)
                              ? 'expand_less'
                              : 'expand_more'
                          }
                          title="展开记忆"
                          onClick={($event: any) => {
                            vm.expandedMemory =
                              vm.expandedMemory ===
                              String(
                                entity.canonicalKey || entity.canonical_key,
                              )
                                ? null
                                : String(
                                    entity.canonicalKey || entity.canonical_key,
                                  );
                          }}
                        ></SlButton>
                        <SlButton
                          variant="icon"
                          icon="delete"
                          title="删除歌曲记忆"
                          onClick={($event: any) => {
                            vm.deleteMemoryEntity(
                              String(
                                entity.canonicalKey || entity.canonical_key,
                              ),
                              entity.songName || '歌曲',
                            );
                          }}
                        ></SlButton>
                      </NativeView>
                      {vm.expandedMemory ===
                      String(entity.canonicalKey || entity.canonical_key) ? (
                        <NativeView className="memory-aliases">
                          {renderItems(
                            vm.memoryAliases(entity),
                            (alias, index) => (
                              <NativeView
                                key={alias.id || index}
                                className="memory-alias-row"
                              >
                                <NativeView>
                                  <text>
                                    {displayText(
                                      alias.query ||
                                        alias.alias ||
                                        '未命名说法',
                                    )}
                                  </text>
                                </NativeView>
                                {alias.id ? (
                                  <SlButton
                                    variant="icon"
                                    icon="close"
                                    title="删除这条记忆"
                                    onClick={($event: any) => {
                                      vm.deleteMemoryRecord(alias.id);
                                    }}
                                  ></SlButton>
                                ) : null}
                              </NativeView>
                            ),
                          )}
                        </NativeView>
                      ) : null}
                    </NativeView>
                  ))}
                  {!vm.state.memoryEntities.length ? (
                    <NativeView className="empty-state">
                      <text>暂无可聚合的歌曲记忆</text>
                    </NativeView>
                  ) : null}
                  {vm.state.memoryUnclassified.length ? (
                    <NativeView className="field-help">
                      <text>
                        未归类记忆{' '}
                        {displayText(vm.state.memoryUnclassified.length)} 条
                      </text>
                    </NativeView>
                  ) : null}
                  {vm.state.memoryAmbiguous.length ? (
                    <NativeView className="field-help">
                      <text>
                        最近歧义 {displayText(vm.state.memoryAmbiguous.length)}{' '}
                        条
                      </text>
                    </NativeView>
                  ) : null}
                </NativeView>
              </NativeView>
            ) : (
              <NativeView className="collapsed-summary">
                <NativeView className="chip">
                  <text>记忆数据按需加载</text>
                </NativeView>
              </NativeView>
            )}
          </NativeView>
        </SectionCard>
      </NativeView>
      <NativeView
        visible={!!(vm.voicePanel === 'intelligence')}
        className="voice-panel"
        data-voice-panel="intelligence"
      >
        <SectionCard
          title="歌曲搜索"
          icon="search"
          description="本地与外部候选按匹配阈值筛选，再按搜索优先级选择。"
        >
          <SettingRow
            title="启用外部搜索"
            subtitle={
              vm.state.config.voice_command_enabled
                ? '搜索源需要返回 topone 格式结果'
                : '需要先开启语音口令'
            }
          >
            <SlSwitch
              aria-label="启用外部搜索"
              modelValue={vm.state.config.external_search_enabled}
              disabled={!vm.state.config.voice_command_enabled}
              onUpdateModelValue={($event: any) => {
                void vm.setExternalSearchEnabled($event);
              }}
            ></SlSwitch>
          </SettingRow>
          {!vm.state.config.voice_command_enabled ? (
            <NativeView className="dependency-hint">
              <SlIcon name="warning" size={18}></SlIcon>
              <NativeView>
                <text>需要先开启"语音口令"才能使用外部搜索。</text>
              </NativeView>
            </NativeView>
          ) : null}
          <NativeView className="form-body">
            <NativeView className="field">
              <NativeView className="field-label">
                <text>搜索优先级</text>
              </NativeView>
              <SlSelect
                modelValue={vm.state.config.search_priority}
                options={vm.searchPriorityOptions}
                aria-label="搜索优先级"
                onUpdateModelValue={($event: any) => {
                  vm.saveConfig({
                    search_priority: $event as
                      'parallel' | 'local_first' | 'external_first',
                  });
                }}
              ></SlSelect>
            </NativeView>
            <NativeView className="field">
              <NativeView className="field-label">
                <text>歌曲匹配阈值（0–100）</text>
              </NativeView>
              <SlInput
                modelValue={vm.songMatchThreshold}
                onUpdateModelValue={($event: any) => {
                  vm.songMatchThreshold = $event;
                }}
                type="number"
                min={0}
                max={100}
                step={1}
                unit="分"
                aria-label="歌曲匹配阈值"
                onChange={($event: any) => {
                  vm.saveConfig({
                    song_match_threshold: Math.max(
                      0,
                      Math.min(100, Number(vm.songMatchThreshold) || 0),
                    ),
                  });
                }}
              ></SlInput>
              <NativeView className="field-help">
                <text>
                  默认 70，越高越严格；支持同音字与中阿数字容错，无需开启
                  AI。本地与外部歌曲都须达标；并行搜索等待两端后按匹配度选择，同分优先本地。该分数不是命中概率。
                </text>
              </NativeView>
            </NativeView>
            <NativeView className="field-grid">
              <NativeView className="field">
                <NativeView className="field-label">
                  <text>超时（秒）</text>
                </NativeView>
                <SlInput
                  modelValue={vm.externalSearchTimeout}
                  type="number"
                  min={3}
                  max={60}
                  step={1}
                  unit="秒"
                  aria-label="外部搜索超时"
                  onUpdateModelValue={($event: any) => {
                    vm.externalSearchTimeout = $event;
                  }}
                  onChange={($event: any) => {
                    vm.saveConfig({
                      external_search_timeout: Math.max(
                        3,
                        Math.min(60, Number(vm.externalSearchTimeout) || 6),
                      ),
                    });
                  }}
                ></SlInput>
              </NativeView>
              <NativeView className="field setting-field-control">
                <NativeView className="field-label">
                  <text>不入库直接播放</text>
                </NativeView>
                <SlSwitch
                  modelValue={vm.state.config.external_search_no_import}
                  onUpdateModelValue={($event: any) => {
                    vm.setSwitch('external_search_no_import', $event);
                  }}
                ></SlSwitch>
              </NativeView>
            </NativeView>
            <NativeView className="field-grid">
              <NativeView className="field setting-field-control">
                <NativeView className="field-label">
                  <text>自动追加到歌单</text>
                </NativeView>
                <SlSwitch
                  modelValue={vm.appendPlaylistEnabled}
                  onUpdateModelValue={($event: any) => {
                    void vm.setAppendPlaylistEnabled($event);
                  }}
                ></SlSwitch>
              </NativeView>
              {vm.appendPlaylistEnabled ? (
                <NativeView className="field">
                  <NativeView className="field-label">
                    <text>目标歌单</text>
                  </NativeView>
                  <SlSelect
                    modelValue={vm.state.config.external_search_playlist_id}
                    options={vm.playlistOptions}
                    searchable
                    searchPlaceholder="搜索歌单"
                    aria-label="目标歌单"
                    onUpdateModelValue={($event: any) => {
                      void vm.setAppendPlaylistId($event);
                    }}
                  ></SlSelect>
                </NativeView>
              ) : null}
            </NativeView>
            <NativeView className="card-title">
              <text>已安装搜索源</text>
            </NativeView>
            <NativeView className="field-grid">
              <NativeView className="field">
                <NativeView className="field-label">
                  <text>快速选择</text>
                </NativeView>
                <SlSelect
                  modelValue={vm.selectedProviderId}
                  options={vm.searchProviderOptions}
                  allowEmpty
                  placeholder="选择后立即添加/启用"
                  aria-label="选择已安装搜索源"
                  onUpdateModelValue={($event: any) => {
                    void vm.applyProvider($event);
                  }}
                ></SlSelect>
              </NativeView>
              <NativeView className="field setting-field-control">
                <NativeView className="field-label">
                  <text>操作</text>
                </NativeView>
                <NativeView className="field-actions field-actions-tight">
                  <SlButton
                    variant="outlined"
                    label="刷新"
                    icon="refresh"
                    onClick={($event: any) => {
                      void vm.refreshSearchProviders($event);
                    }}
                  ></SlButton>
                </NativeView>
              </NativeView>
            </NativeView>
            <NativeView className="card-title section-subtitle">
              <text>已配置源</text>
            </NativeView>
            {renderItems(vm.state.config.external_search_sources, (source) => (
              <NativeView key={source.id} className="sub-panel sub-panel-inset">
                <NativeView className="field-grid">
                  <NativeView className="field">
                    <SlInput
                      modelValue={vm.sourceDrafts[source.id].name}
                      onUpdateModelValue={($event: any) => {
                        vm.sourceDrafts[source.id].name = $event;
                      }}
                      placeholder="显示名称"
                    ></SlInput>
                  </NativeView>
                  <NativeView className="field">
                    <SlInput
                      modelValue={vm.sourceDrafts[source.id].url}
                      onUpdateModelValue={($event: any) => {
                        vm.sourceDrafts[source.id].url = $event;
                      }}
                      placeholder="接口地址"
                    ></SlInput>
                  </NativeView>
                </NativeView>
                <SlInput
                  modelValue={vm.sourceDrafts[source.id].token}
                  onUpdateModelValue={($event: any) => {
                    vm.sourceDrafts[source.id].token = $event;
                  }}
                  type="password"
                  placeholder="Bearer Token（可选）"
                ></SlInput>
                <SettingRow title="启用此源">
                  <SlSwitch
                    modelValue={vm.sourceDrafts[source.id].enabled}
                    onUpdateModelValue={($event: any) => {
                      vm.sourceDrafts[source.id].enabled = $event;
                    }}
                    ariaLabel={`启用搜索源 ${vm.sourceDrafts[source.id].name || source.id}`}
                  ></SlSwitch>
                </SettingRow>
                <NativeView className="field-actions">
                  <SlButton
                    variant="text"
                    label="移除"
                    icon="delete"
                    onClick={($event: any) => {
                      vm.removeSource(source.id);
                    }}
                  ></SlButton>
                </NativeView>
              </NativeView>
            ))}
            {!vm.state.config.external_search_sources.length ? (
              <NativeView className="empty-state">
                <text>暂无已配置源，从上方「快速选择」添加，或手动添加</text>
              </NativeView>
            ) : null}
            <NativeView className="field-actions">
              <SlButton
                variant="outlined"
                label="手动添加搜索源"
                icon="add"
                onClick={($event: any) => {
                  vm.showManualAdd = !vm.showManualAdd;
                }}
              ></SlButton>
              <SlButton
                variant="filled"
                label="保存全部"
                icon="save"
                onClick={($event: any) => {
                  void vm.saveSources($event);
                }}
              ></SlButton>
            </NativeView>
            {vm.showManualAdd ? (
              <NativeView className="sub-panel sub-panel-inset">
                <NativeView className="field-grid">
                  <NativeView className="field">
                    <SlInput
                      modelValue={vm.newSourceName}
                      onUpdateModelValue={($event: any) => {
                        vm.newSourceName = $event;
                      }}
                      placeholder="新源名称"
                    ></SlInput>
                  </NativeView>
                  <NativeView className="field">
                    <SlInput
                      modelValue={vm.newSourceUrl}
                      onUpdateModelValue={($event: any) => {
                        vm.newSourceUrl = $event;
                      }}
                      placeholder="接口 URL"
                    ></SlInput>
                  </NativeView>
                </NativeView>
                <SlInput
                  modelValue={vm.newSourceToken}
                  onUpdateModelValue={($event: any) => {
                    vm.newSourceToken = $event;
                  }}
                  type="password"
                  placeholder="Token（可选）"
                ></SlInput>
                <NativeView className="field-actions">
                  <SlButton
                    variant="outlined"
                    label="添加"
                    icon="add"
                    onClick={($event: any) => {
                      void vm.addSource($event);
                    }}
                  ></SlButton>
                  <SlButton
                    variant="text"
                    label="取消"
                    onClick={($event: any) => {
                      vm.showManualAdd = false;
                    }}
                  ></SlButton>
                </NativeView>
              </NativeView>
            ) : null}
            <NativeView className="field">
              <NativeView className="field-label">
                <text>接口测试</text>
              </NativeView>
              <NativeView className="inline-fields">
                <SlInput
                  modelValue={vm.sourceTestQuery}
                  onUpdateModelValue={($event: any) => {
                    vm.sourceTestQuery = $event;
                  }}
                  placeholder="输入测试关键字"
                  onSubmit={($event: any) => {
                    void vm.testSource($event);
                  }}
                ></SlInput>
                <SlButton
                  variant="outlined"
                  label="测试"
                  onClick={($event: any) => {
                    void vm.testSource($event);
                  }}
                ></SlButton>
              </NativeView>
              {vm.sourceTestResult ? (
                <NativeView className="result-pre">
                  <text>{displayText(vm.sourceTestResult)}</text>
                </NativeView>
              ) : null}
            </NativeView>
          </NativeView>
        </SectionCard>
        <SectionCard
          title="AI 设置"
          icon="auto_awesome"
          description="模型连接、口令分析、AI 对话和长期记忆在同一处配置。"
        >
          <NativeView className="form-body">
            <SlButton
              label="打开 AI 设置"
              icon="auto_awesome"
              variant="outlined"
              onClick={($event: any) => {
                vm.navigation.settingsCategory = 'ai';
              }}
            ></SlButton>
          </NativeView>
        </SectionCard>
      </NativeView>
    </>
  );
}
