import SlTextArea from '../../ui/SlTextArea';
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
import { DEFAULT_CHAT_CONFIG } from '../../../../src/chat/types';
import type { ConnectionTestResult } from '../../../../src/chat/connection_test';
import type {
  ChatConfig,
  ChatMemory,
  ChatTurn,
} from '../../../../src/chat/types';
import { isDashScopeEndpoint } from '../../../../src/utils/ai_url';
import { del, get, messageOf, post, put, query } from '../../api';
import {
  confirmAction,
  deviceId,
  deviceName,
  managedDevices,
  notify,
  saveConfig,
  selectDevice,
  state,
} from '../../store';
import SectionCard from '../../ui/SectionCard.tsx';
import SettingRow from '../../ui/SettingRow.tsx';
import SlInput from '../../ui/SlInput.tsx';
import SlSwitch from '../../ui/SlSwitch.tsx';
import SlButton from '../../ui/SlButton.tsx';
import SlSelect from '../../ui/SlSelect.tsx';
import SlDisclosure from '../../ui/SlDisclosure.tsx';
import AIHeadersField from '../../ui/AIHeadersField.tsx';
import { parseAIHeaders } from '../../../../src/utils/ai_headers';
const pageState = {
  name: 'ChatSettings',
  createState(input, {}) {
    const config = reactive<ChatConfig>({
      ...DEFAULT_CHAT_CONFIG,
      trigger_words: [...DEFAULT_CHAT_CONFIG.trigger_words],
    });
    const triggers = ref(config.trigger_words.join('、'));
    const customHeaders = ref(
      JSON.stringify(config.custom_headers || {}, null, 2),
    );
    const connectionTest = ref<
      | (ConnectionTestResult & {
          error?: string;
        })
      | null
    >(null);
    const connectionTesting = ref(false);
    let testVersion = 0;
    const savedConfig = ref(''),
      streamingAvailable = ref<boolean | null>(null);
    const loaded = ref(false),
      busy = ref(false),
      error = ref(''),
      refreshError = ref(''),
      question = ref(''),
      speak = ref(true);
    const history = ref<ChatTurn[]>([]),
      memories = ref<ChatMemory[]>([]),
      summary = ref(''),
      offset = ref(0),
      total = ref(0);
    const memoryDrafts = reactive<Record<string, string>>({});
    let refreshVersion = 0;
    const newMemory = ref(''),
      models = ref<
        Array<{
          id: string;
        }>
      >([]);
    const target = computed(() => ({
      account_id: state.currentAccountId,
      device_id: state.currentDeviceId,
    }));
    const targetQuery = computed(() => query(target.value));
    const lastContextTurns = ref(3);
    const contextEnabled = computed(() => config.context_turns > 0);
    const webSearchAvailable = computed(
      () =>
        config.api_protocol === 'responses' ||
        isDashScopeEndpoint(
          config.connection === 'independent'
            ? config.api_url
            : state.config.ai_config.api_url || '',
        ),
    );
    const connectionIdentity = computed(() =>
      JSON.stringify({
        connection: config.connection,
        api_url: config.api_url,
        api_key: config.api_key,
        model: config.model,
        timeout: config.timeout,
        api_protocol: config.api_protocol,
        customHeaders: customHeaders.value,
        web_search_enabled: config.web_search_enabled,
        shared:
          config.connection === 'analysis'
            ? state.config?.ai_config
            : undefined,
      }),
    );
    function setWebSearch(enabled: boolean) {
      config.web_search_enabled = enabled;
      if (enabled && !webSearchAvailable.value)
        config.api_protocol = 'responses';
    }
    async function testConnection(search: boolean) {
      const version = ++testVersion,
        identity = connectionIdentity.value;
      const current = () =>
        alive &&
        version === testVersion &&
        identity === connectionIdentity.value;
      connectionTest.value = null;
      connectionTesting.value = true;
      try {
        const draft = {
          ...config,
          custom_headers:
            config.connection === 'independent'
              ? parseAIHeaders(customHeaders.value)
              : config.custom_headers,
        };
        const result = await post<ConnectionTestResult>(
          '/chat/test-connection',
          { config: draft, search },
        );
        if (current()) connectionTest.value = result;
      } catch (e) {
        if (current())
          connectionTest.value = {
            connected: false,
            search: 'not_requested',
            error: messageOf(e),
          };
      } finally {
        connectionTesting.value = false;
      }
    }
    const dirty = computed(
      () =>
        loaded.value &&
        (JSON.stringify({
          ...config,
          trigger_words: triggers.value
            .split(/[、,，\n]/)
            .map((v) => v.trim())
            .filter(Boolean),
        }) !== savedConfig.value ||
          customHeaders.value !==
            JSON.stringify(config.custom_headers || {}, null, 2)),
    );
    function setContextEnabled(enabled: boolean) {
      if (!enabled && config.context_turns > 0)
        lastContextTurns.value = config.context_turns;
      config.context_turns = enabled ? lastContextTurns.value : 0;
    }
    const phases: Record<string, string> = {
      queued: '排队中',
      preparing: '接管音箱',
      generating: '生成回答',
      speaking: '播报中',
      resuming: '恢复音乐',
      completed: '已完成',
      cancelled: '已取消',
      failed: '失败',
      unknown: '播报结束未确认',
    };
    const deviceSelection = computed(() =>
      JSON.stringify([state.currentAccountId, state.currentDeviceId]),
    );
    const deviceOptions = computed(() =>
      managedDevices.value.map((item) => ({
        value: JSON.stringify([item.accountId, deviceId(item.device)]),
        label: `${deviceName(item.device)} · ${item.accountName}`,
      })),
    );
    const phase = computed(() =>
      state.chatStatus ? phases[state.chatStatus.phase] : '空闲',
    );
    const active = computed(
      () =>
        !!state.chatStatus &&
        ['queued', 'preparing', 'generating', 'speaking', 'resuming'].includes(
          state.chatStatus.phase,
        ),
    );
    async function action(run: () => Promise<void>) {
      if (busy.value) return;
      busy.value = true;
      error.value = '';
      try {
        await run();
      } catch (e) {
        error.value = messageOf(e);
        notify(error.value, 'error');
      } finally {
        busy.value = false;
      }
    }
    async function refresh() {
      const version = ++refreshVersion;
      if (!target.value.account_id || !target.value.device_id) {
        history.value = [];
        memories.value = [];
        summary.value = '';
        return;
      }
      const identity = targetQuery.value;
      const [h, m] = await Promise.all([
        get<{
          history: ChatTurn[];
          total: number;
          summary: string;
        }>(
          `/chat/history${query({ ...target.value, offset: offset.value, limit: 20 })}`,
        ),
        get<{
          memories: ChatMemory[];
        }>(`/chat/memories${identity}`),
      ]);
      if (
        !alive ||
        version !== refreshVersion ||
        identity !== targetQuery.value
      )
        return;
      history.value = h.history;
      total.value = h.total;
      summary.value = h.summary;
      memories.value = m.memories;
    }
    async function save() {
      if (config.connection === 'independent')
        config.custom_headers = parseAIHeaders(customHeaders.value);
      config.trigger_words = triggers.value
        .split(/[、,，\n]/)
        .map((v) => v.trim())
        .filter(Boolean);
      Object.assign(config, await put<ChatConfig>('/chat/config', config));
      customHeaders.value = JSON.stringify(
        config.custom_headers || {},
        null,
        2,
      );
      savedConfig.value = JSON.stringify(config);
      notify('AI 对话设置已保存', 'success');
    }
    async function submit() {
      await post('/chat/messages', {
        ...target.value,
        text: question.value,
        speak: speak.value,
      });
      question.value = '';
      if (!alive) return;
      notify('问题已提交，请查看当前状态和聊天历史', 'success');
      await refreshSafely();
    }
    async function refreshSafely() {
      const identity = targetQuery.value;
      const pending = refresh();
      const version = refreshVersion;
      const current = () =>
        alive && version === refreshVersion && identity === targetQuery.value;
      try {
        await pending;
        if (current()) refreshError.value = '';
      } catch (e) {
        if (!current()) return;
        refreshError.value = `历史刷新失败：${messageOf(e)}；已提交的问题会继续处理。`;
        notify(refreshError.value, 'warning');
      }
    }
    async function clear(range: 'history' | 'memory' | 'all') {
      const identity = targetQuery.value;
      if (
        !(
          await confirmAction(
            '清理对话数据',
            '此操作会取消当前回答并删除所选数据。',
            '清理',
            true,
          )
        ).confirmed
      )
        return;
      if (!alive || identity !== targetQuery.value) return;
      await post('/chat/clear', { ...target.value, range });
      offset.value = 0;
      await refresh();
    }
    async function removeTurn(id: string) {
      const identity = targetQuery.value;
      if (
        !(
          await confirmAction(
            '删除对话',
            '相关自动记忆也会删除，摘要将重新构建。',
            '删除',
            true,
          )
        ).confirmed
      )
        return;
      if (!alive || identity !== targetQuery.value) return;
      await del(`/chat/history/${encodeURIComponent(id)}${targetQuery.value}`);
      await refresh();
    }
    watch(targetQuery, () => {
      history.value = [];
      memories.value = [];
      summary.value = '';
      total.value = 0;
      refreshError.value = '';
      for (const id of Object.keys(memoryDrafts)) delete memoryDrafts[id];
      offset.value = 0;
      void refreshSafely();
    });
    watch(
      [
        () => state.chatStatus?.task_id,
        () => state.chatStatus?.phase,
        () => state.chatStatus?.memory_revision,
      ],
      () => {
        void refreshSafely();
      },
    );
    watch(
      connectionIdentity,
      () => {
        testVersion++;
        connectionTest.value = null;
      },
      { flush: 'sync' },
    );
    onMounted(() => {
      void action(async () => {
        Object.assign(config, await get<ChatConfig>('/chat/config'));
        triggers.value = config.trigger_words.join('、');
        customHeaders.value = JSON.stringify(
          config.custom_headers || {},
          null,
          2,
        );
        savedConfig.value = JSON.stringify(config);
        lastContextTurns.value = config.context_turns || 3;
        loaded.value = true;
        void get<{
          streaming: boolean;
        }>('/chat/capabilities')
          .then((value) => {
            if (alive) streamingAvailable.value = value.streaming;
          })
          .catch(() => {});
        await refresh();
      });
    });
    let alive = true;
    onUnmounted(() => {
      alive = false;
      refreshVersion++;
    });
    const safeAction = (run: () => Promise<void>) => {
      if (alive) void action(run);
    };
    const bindings = {
      config,
      triggers,
      customHeaders,
      connectionTest,
      connectionTesting,
      get testVersion() {
        return testVersion;
      },
      set testVersion(v) {
        testVersion = v;
      },
      savedConfig,
      streamingAvailable,
      loaded,
      busy,
      error,
      refreshError,
      question,
      speak,
      history,
      memories,
      summary,
      offset,
      total,
      memoryDrafts,
      get refreshVersion() {
        return refreshVersion;
      },
      set refreshVersion(v) {
        refreshVersion = v;
      },
      newMemory,
      models,
      target,
      targetQuery,
      lastContextTurns,
      contextEnabled,
      webSearchAvailable,
      connectionIdentity,
      setWebSearch,
      testConnection,
      dirty,
      setContextEnabled,
      phases,
      deviceSelection,
      deviceOptions,
      phase,
      active,
      action,
      refresh,
      save,
      submit,
      refreshSafely,
      clear,
      removeTurn,
      get alive() {
        return alive;
      },
      set alive(v) {
        alive = v;
      },
      safeAction,
      get del() {
        return del;
      },
      get get() {
        return get;
      },
      get post() {
        return post;
      },
      get put() {
        return put;
      },
      get saveConfig() {
        return saveConfig;
      },
      get selectDevice() {
        return selectDevice;
      },
      get state() {
        return state;
      },
      SectionCard,
      SettingRow,
      SlInput,
      SlSwitch,
      SlButton,
      SlSelect,
      SlDisclosure,
      AIHeadersField,
    };
    return bindings;
  },
};
export default function ChatSettings(props: any) {
  const vm = usePageState(pageState, props);
  return (
    <>
      <NativeView className="chat-settings" disabled={vm.busy || !vm.loaded}>
        {vm.error ? (
          <NativeView className="chat-error">
            <text>{displayText(vm.error)}</text>
          </NativeView>
        ) : null}
        <SectionCard
          title="AI 对话"
          saveMode="manual"
          description="与音乐口令分析分别启用。默认每轮说“请问……”开始；可开启连续追问。"
        >
          <NativeView className="form-body">
            <SettingRow title="启用 AI 对话">
              <SlSwitch
                modelValue={vm.config.enabled}
                onUpdateModelValue={($event: any) => {
                  vm.config.enabled = $event;
                }}
                disabled={!vm.loaded || vm.busy}
                aria-label="启用 AI 对话"
              ></SlSwitch>
            </SettingRow>
            {!vm.state.config.conversation_monitor_enabled ? (
              <NativeView>
                <text>语音问答需要对话监听。</text>
                <SlButton
                  label="一并开启监听"
                  variant="outlined"
                  onClick={($event: any) => {
                    vm.safeAction(async () => {
                      await vm.saveConfig({
                        conversation_monitor_enabled: true,
                      });
                    });
                  }}
                ></SlButton>
              </NativeView>
            ) : null}
            <NativeView className="chat-field">
              <text>触发词（用顿号或逗号分隔）</text>
              <SlInput
                modelValue={vm.triggers}
                onUpdateModelValue={($event: any) => {
                  vm.triggers = $event;
                }}
                aria-label="问答触发词"
              ></SlInput>
            </NativeView>
            <SettingRow
              title="允许连续追问"
              subtitle="开启后，回答播报完成后的窗口内可不带触发词；仍需唤醒音箱。"
            >
              <SlSwitch
                modelValue={vm.config.followup_enabled}
                onUpdateModelValue={($event: any) => {
                  vm.config.followup_enabled = $event;
                }}
                aria-label="允许连续追问"
              ></SlSwitch>
            </SettingRow>
            {vm.config.followup_enabled ? (
              <NativeView className="chat-field">
                <text>追问窗口（秒，0 关闭）</text>
                <SlInput
                  modelValue={String(vm.config.followup_seconds)}
                  type="number"
                  min={0}
                  max={300}
                  step={1}
                  unit="秒"
                  aria-label="追问窗口"
                  onUpdateModelValue={($event: any) => {
                    vm.config.followup_seconds = Number($event);
                  }}
                ></SlInput>
              </NativeView>
            ) : null}
            <SettingRow
              title="无需触发词也交给 AI"
              subtitle="开启后，天气、闲聊等未识别为音乐指令的语音会进入 AI 对话，不受连续追问开关和窗口限制。已识别的音乐指令仍优先处理。"
            >
              <SlSwitch
                modelValue={vm.config.fallback_enabled}
                onUpdateModelValue={($event: any) => {
                  vm.config.fallback_enabled = $event;
                }}
                aria-label="无需触发词也交给 AI"
              ></SlSwitch>
            </SettingRow>
            {!vm.config.followup_enabled && !vm.config.fallback_enabled ? (
              <NativeView>
                <text>每轮提问都需要触发词，包括上一轮仍在回答时。</text>
              </NativeView>
            ) : null}
            <SettingRow title="每轮回答后恢复原音乐">
              <SlSwitch
                modelValue={vm.config.resume_music}
                onUpdateModelValue={($event: any) => {
                  vm.config.resume_music = $event;
                }}
                aria-label="回答后恢复音乐"
              ></SlSwitch>
            </SettingRow>
            <SettingRow
              title="等待时播报提示"
              subtitle="提问后说“收到，正在思考”，模型请求同时开始。"
            >
              <SlSwitch
                modelValue={vm.config.waiting_feedback}
                onUpdateModelValue={($event: any) => {
                  vm.config.waiting_feedback = $event;
                }}
                aria-label="等待时播报提示"
              ></SlSwitch>
            </SettingRow>
            <NativeView>
              <text>
                追问仍需唤醒音箱。分组播放时全组暂停，仅提问设备回答；播报结束无法确认时保持暂停。DLNA
                投放中请先停止投放。
              </text>
            </NativeView>
          </NativeView>
        </SectionCard>
        <SectionCard
          title="对话上下文"
          description="聊天记录用于查看；只有开启以下选项才会发送相关历史或偏好。"
        >
          <NativeView className="form-body">
            <SettingRow
              title="携带历史对话"
              subtitle="让 AI 理解连续追问。关闭后不携带以前的问答和摘要。"
            >
              <SlSwitch
                modelValue={vm.contextEnabled}
                aria-label="携带历史对话"
                onUpdateModelValue={($event: any) => {
                  vm.setContextEnabled($event);
                }}
              ></SlSwitch>
            </SettingRow>
            {vm.contextEnabled ? (
              <NativeView className="chat-field">
                <text>参考最近几轮（1–24）</text>
                <SlInput
                  modelValue={String(vm.config.context_turns)}
                  type="number"
                  min={1}
                  max={24}
                  step={1}
                  unit="轮"
                  aria-label="上下文轮数"
                  onUpdateModelValue={($event: any) => {
                    vm.config.context_turns = Number($event);
                  }}
                ></SlInput>
                <NativeView>
                  <text>一轮包含一次提问和回答。</text>
                </NativeView>
              </NativeView>
            ) : null}
            <SettingRow
              title="记住我的偏好"
              subtitle="自动保存并参考个人事实与偏好，会产生额外模型请求。"
            >
              <SlSwitch
                modelValue={vm.config.memory_enabled}
                onUpdateModelValue={($event: any) => {
                  vm.config.memory_enabled = $event;
                }}
                aria-label="长期记忆"
              ></SlSwitch>
            </SettingRow>
            {!vm.contextEnabled && !vm.config.memory_enabled ? (
              <NativeView>
                <text>每次提问独立处理，只发送角色提示词和本次问题。</text>
              </NativeView>
            ) : null}
            <SlDisclosure
              title="高级设置"
              description="较早对话的摘要和记录保留"
            >
              <SettingRow
                title="保留更早的对话摘要"
                subtitle="压缩较早的问答供后续参考，会产生额外模型请求。关闭历史对话时暂停使用和生成。"
              >
                <SlSwitch
                  modelValue={vm.config.summary_enabled}
                  onUpdateModelValue={($event: any) => {
                    vm.config.summary_enabled = $event;
                  }}
                  disabled={!vm.contextEnabled}
                  aria-label="对话摘要"
                ></SlSwitch>
              </SettingRow>
              <NativeView className="chat-field">
                <text>历史保留天数（1–30）</text>
                <SlInput
                  modelValue={String(vm.config.history_days)}
                  type="number"
                  min={1}
                  max={30}
                  step={1}
                  unit="天"
                  aria-label="历史保留天数"
                  onUpdateModelValue={($event: any) => {
                    vm.config.history_days = Number($event);
                  }}
                ></SlInput>
              </NativeView>
              <NativeView className="chat-field">
                <text>历史最大轮数（12–500）</text>
                <SlInput
                  modelValue={String(vm.config.history_limit)}
                  type="number"
                  min={12}
                  max={500}
                  step={1}
                  unit="轮"
                  aria-label="历史最大轮数"
                  onUpdateModelValue={($event: any) => {
                    vm.config.history_limit = Number($event);
                  }}
                ></SlInput>
              </NativeView>
              <NativeView>
                <text>
                  关闭选项会保留本地数据；需要删除时使用下面的数据清理操作。
                </text>
              </NativeView>
            </SlDisclosure>
          </NativeView>
        </SectionCard>
        <SectionCard
          title="对话模型与角色"
          description="默认使用上方的模型连接。可单独选择对话模型，或改用独立连接。"
        >
          <NativeView className="form-body">
            <SlSelect
              disabled={vm.busy || !vm.loaded}
              modelValue={vm.config.connection}
              onUpdateModelValue={($event: any) => {
                vm.config.connection = $event;
              }}
              options={[
                { value: 'analysis', label: '复用默认模型连接' },
                { value: 'independent', label: '独立连接' },
              ]}
              aria-label="对话模型连接"
            ></SlSelect>
            {vm.config.connection === 'independent' ? (
              <>
                <NativeView className="chat-field">
                  <text>服务地址</text>
                  <SlInput
                    modelValue={vm.config.api_url}
                    onUpdateModelValue={($event: any) => {
                      vm.config.api_url = $event;
                    }}
                    type="url"
                    aria-label="问答 API 地址"
                    placeholder="粘贴服务商提供的 API 基础地址"
                  ></SlInput>
                  <NativeView>
                    <text>
                      例如
                      https://example.com/v1，请勿粘贴聊天或搜索请求的完整地址。
                    </text>
                  </NativeView>
                </NativeView>
                <NativeView className="chat-field">
                  <text>API 密钥</text>
                  <SlInput
                    modelValue={vm.config.api_key}
                    onUpdateModelValue={($event: any) => {
                      vm.config.api_key = $event;
                    }}
                    type="password"
                    aria-label="问答 API 密钥"
                  ></SlInput>
                </NativeView>
              </>
            ) : null}
            {vm.config.connection === 'analysis' ? (
              <NativeView>
                <text>
                  默认模型：
                  {displayText(vm.state.config.ai_config.model || '尚未配置')}
                  。同时复用默认连接的自定义请求头。启用对话不需要开启口令分析。
                </text>
              </NativeView>
            ) : null}
            <NativeView className="chat-field">
              <text>问答模型</text>
              <SlInput
                modelValue={vm.config.model}
                onUpdateModelValue={($event: any) => {
                  vm.config.model = $event;
                }}
                aria-label="问答模型"
                placeholder="留空则使用默认模型"
              ></SlInput>
            </NativeView>
            {vm.config.connection === 'independent' ? (
              <SlButton
                label="保存并获取模型"
                variant="outlined"
                disabled={vm.busy || !vm.loaded}
                onClick={($event: any) => {
                  vm.safeAction(async () => {
                    await vm.save();
                    vm.models = (await vm.get('/chat/models')).models;
                  });
                }}
              ></SlButton>
            ) : null}
            {vm.models.length ? (
              <SlSelect
                disabled={vm.busy || !vm.loaded}
                modelValue={vm.config.model}
                onUpdateModelValue={($event: any) => {
                  vm.config.model = $event;
                }}
                options={vm.models.map((m) => ({ value: m.id, label: m.id }))}
                aria-label="可用问答模型"
              ></SlSelect>
            ) : null}
            <SettingRow
              title="联网搜索"
              subtitle="回答实时问题时，允许 AI 搜索资料。可能产生额外费用。"
            >
              <SlSwitch
                modelValue={vm.config.web_search_enabled}
                aria-label="联网搜索"
                onUpdateModelValue={($event: any) => {
                  vm.setWebSearch($event);
                }}
              ></SlSwitch>
            </SettingRow>
            {vm.config.web_search_enabled && vm.webSearchAvailable ? (
              <NativeView>
                <text>
                  由模型决定是否搜索。建议先测试，确认当前服务和模型是否支持。
                </text>
              </NativeView>
            ) : null}
            {vm.config.web_search_enabled && !vm.webSearchAvailable ? (
              <NativeView className="chat-search-help">
                <NativeView>
                  <text>当前连接方式尚未启用搜索支持。</text>
                </NativeView>
                <SlButton
                  label="启用搜索连接"
                  variant="outlined"
                  onClick={($event: any) => {
                    vm.config.api_protocol = 'responses';
                  }}
                ></SlButton>
              </NativeView>
            ) : null}
            <NativeView className="chat-actions">
              <SlButton
                label="测试连接"
                variant="outlined"
                disabled={vm.busy || !vm.loaded}
                onClick={($event: any) => {
                  vm.safeAction(() => vm.testConnection(false));
                }}
              ></SlButton>
              {vm.config.web_search_enabled ? (
                <SlButton
                  label="测试联网搜索"
                  variant="outlined"
                  disabled={vm.busy || !vm.loaded || !vm.webSearchAvailable}
                  onClick={($event: any) => {
                    vm.safeAction(() => vm.testConnection(true));
                  }}
                ></SlButton>
              ) : null}
            </NativeView>
            <NativeView className="chat-help">
              <text>
                使用当前填写的内容发送一次简短提问，无需先保存，不播放也不保存聊天记录。
              </text>
            </NativeView>
            {vm.connectionTesting ? (
              <NativeView>
                <text>正在测试当前连接，请稍候……</text>
              </NativeView>
            ) : null}
            {vm.connectionTest ? (
              <NativeView className="chat-connection-result" aria-live="polite">
                {vm.connectionTest.connected ? (
                  <>
                    <NativeView>
                      <text>
                        {displayText(
                          vm.connectionTest.search === 'completed'
                            ? '连接正常 · 已收到搜索完成记录'
                            : vm.connectionTest.search === 'unconfirmed'
                              ? '连接正常 · 本次搜索未确认'
                              : '连接正常 · 模型已回复',
                        )}
                      </text>
                    </NativeView>
                    {vm.connectionTest.search === 'completed' ? (
                      <NativeView>
                        <text>
                          服务返回了搜索完成记录。正式问答时仍由模型决定是否搜索。
                        </text>
                      </NativeView>
                    ) : vm.connectionTest.search === 'unconfirmed' ? (
                      <NativeView>
                        <text>
                          已允许模型搜索，但服务未返回搜索完成记录，不能确认本次实际联网。请核对服务商和模型的搜索支持。
                        </text>
                      </NativeView>
                    ) : (
                      <NativeView>
                        <text>
                          可以继续配置或保存。连接正常不代表已验证联网搜索。
                        </text>
                      </NativeView>
                    )}
                  </>
                ) : (
                  <>
                    <NativeView className="chat-error">
                      <text>测试未通过</text>
                    </NativeView>
                    <NativeView className="chat-text">
                      <text>{displayText(vm.connectionTest.error)}</text>
                    </NativeView>
                    {/401|403/.test(vm.connectionTest.error || '') ? (
                      <NativeView>
                        <text>
                          请核对 API 密钥是否有效，以及账号是否有权使用此模型。
                        </text>
                      </NativeView>
                    ) : /404|405/.test(vm.connectionTest.error || '') ? (
                      <NativeView>
                        <text>
                          请核对服务地址。当前服务可能不支持此连接方式，可在高级设置中切换后重试。
                        </text>
                      </NativeView>
                    ) : /timed out|超时/i.test(
                        vm.connectionTest.error || '',
                      ) ? (
                      <NativeView>
                        <text>
                          请检查网络，尝试响应更快的模型，或在高级设置中调整超时时间。
                        </text>
                      </NativeView>
                    ) : (
                      <NativeView>
                        <text>
                          请检查服务地址、密钥和模型；需要调整连接方式时展开高级设置。
                        </text>
                      </NativeView>
                    )}
                  </>
                )}
              </NativeView>
            ) : null}
            <SlDisclosure
              title="高级设置"
              description="连接方式、自定义请求头、角色与其他选项"
            >
              <NativeView className="chat-field">
                <text>连接方式</text>
                <SlSelect
                  modelValue={vm.config.api_protocol}
                  onUpdateModelValue={($event: any) => {
                    vm.config.api_protocol = $event;
                  }}
                  options={[
                    {
                      value: 'chat_completions',
                      label: '兼容模式（Chat Completions）',
                    },
                    { value: 'responses', label: '搜索工具模式（Responses）' },
                  ]}
                  aria-label="问答接口协议"
                ></SlSelect>
              </NativeView>
              <NativeView>
                <text>
                  普通连接可保留兼容模式。自定义服务的内置搜索可尝试搜索工具模式，需服务商和模型支持
                  Responses。切换后请重新测试。
                </text>
              </NativeView>
              {vm.config.connection === 'independent' ? (
                <AIHeadersField
                  modelValue={vm.customHeaders}
                  onUpdateModelValue={($event: any) => {
                    vm.customHeaders = $event;
                  }}
                  label="问答自定义请求头"
                ></AIHeadersField>
              ) : null}
              <NativeView className="chat-field">
                <text>请求超时（1–30 秒）</text>
                <SlInput
                  modelValue={String(vm.config.timeout)}
                  type="number"
                  min={1}
                  max={30}
                  step={1}
                  unit="秒"
                  aria-label="问答超时"
                  onUpdateModelValue={($event: any) => {
                    vm.config.timeout = Number($event);
                  }}
                ></SlInput>
              </NativeView>
              <NativeView className="chat-field">
                <text>角色提示词</text>
                <SlTextArea
                  modelValue={vm.config.system_prompt}
                  onUpdateModelValue={($event: any) => {
                    vm.config.system_prompt = $event;
                  }}
                  className="sl-input chat-textarea"
                  aria-label="角色提示词"
                  maxlength="4000"
                ></SlTextArea>
              </NativeView>
              <NativeView>
                <text>
                  触发词、连续追问和无触发词问答决定哪些话交给
                  AI；历史上下文决定 AI 能参考哪些问答。
                </text>
              </NativeView>
              <SettingRow
                title="实时显示回答"
                subtitle="逐步显示模型生成的文字，音箱仍等待完整回答后播报。接口不支持时可关闭。"
              >
                <SlSwitch
                  modelValue={vm.config.streaming_enabled}
                  onUpdateModelValue={($event: any) => {
                    vm.config.streaming_enabled = $event;
                  }}
                  aria-label="实时显示回答"
                ></SlSwitch>
              </SettingRow>
              {vm.streamingAvailable === false ? (
                <NativeView>
                  <text>
                    当前服务端尚不支持实时接收，将等待完整回答。升级服务端后可用。
                  </text>
                </NativeView>
              ) : null}
            </SlDisclosure>
          </NativeView>
        </SectionCard>
        <NativeView className="chat-save">
          {vm.dirty ? (
            <NativeView>
              <text>有未保存的修改</text>
            </NativeView>
          ) : null}
          <SlButton
            label="保存设置"
            disabled={vm.busy || !vm.loaded || !vm.dirty}
            onClick={($event: any) => {
              vm.safeAction(vm.save);
            }}
          ></SlButton>
        </NativeView>
        <SectionCard
          title="对话测试"
          description="使用当前选中的受管理音箱。关闭播报可测试模型而不暂停音乐。"
        >
          <NativeView className="form-body">
            <SlSelect
              disabled={vm.busy || !vm.loaded}
              modelValue={vm.deviceSelection}
              options={vm.deviceOptions}
              aria-label="对话设备"
              onUpdateModelValue={($event: any) => {
                vm.safeAction(async () => {
                  const [account, device] = JSON.parse($event);
                  await vm.selectDevice(account, device);
                });
              }}
            ></SlSelect>
            <NativeView>
              <text>当前状态：</text>
              <NativeView>
                <text>{displayText(vm.phase)}</text>
              </NativeView>
            </NativeView>
            {vm.active ? (
              <NativeView>
                <text>
                  问题处理中，可随时停止回答。音箱会在完整回答生成后播报。
                </text>
              </NativeView>
            ) : null}
            {vm.state.chatStatus?.answer ? (
              <NativeView className="chat-live-answer" aria-label="当前回答">
                <NativeView>
                  <text>
                    {displayText(vm.active ? '当前回答' : '最近回答')}
                  </text>
                </NativeView>
                <NativeView className="chat-text">
                  <text>{displayText(vm.state.chatStatus.answer)}</text>
                </NativeView>
              </NativeView>
            ) : null}
            {vm.refreshError ? (
              <NativeView>
                <text>{displayText(vm.refreshError)}</text>
              </NativeView>
            ) : null}
            {vm.state.chatStatus?.error ? (
              <NativeView>
                <text>{displayText(vm.state.chatStatus.error)}</text>
              </NativeView>
            ) : null}
            <NativeView className="chat-field">
              <text>问题</text>
              <SlTextArea
                modelValue={vm.question}
                onUpdateModelValue={($event: any) => {
                  vm.question = $event;
                }}
                className="sl-input chat-textarea"
                aria-label="对话问题"
                maxlength="2000"
              ></SlTextArea>
            </NativeView>
            <SettingRow title="在音箱上播报">
              <SlSwitch
                modelValue={vm.speak}
                onUpdateModelValue={($event: any) => {
                  vm.speak = $event;
                }}
                aria-label="播报回答"
              ></SlSwitch>
            </SettingRow>
            <NativeView className="chat-actions">
              <SlButton
                label="提问"
                disabled={
                  vm.busy ||
                  !vm.config.enabled ||
                  !vm.question.trim() ||
                  !vm.target.device_id
                }
                onClick={($event: any) => {
                  vm.safeAction(vm.submit);
                }}
              ></SlButton>
              <SlButton
                label="停止回答"
                variant="outlined"
                disabled={vm.busy || !vm.active}
                onClick={($event: any) => {
                  vm.safeAction(async () => {
                    await vm.post('/chat/cancel', {
                      ...vm.target,
                      close_session: true,
                      resume_music: false,
                    });
                    await vm.refresh();
                  });
                }}
              ></SlButton>
              <SlButton
                label="退出并恢复音乐"
                variant="outlined"
                disabled={vm.busy || !vm.active}
                onClick={($event: any) => {
                  vm.safeAction(async () => {
                    await vm.post('/chat/cancel', {
                      ...vm.target,
                      close_session: true,
                      resume_music: true,
                    });
                    await vm.refresh();
                  });
                }}
              ></SlButton>
              <SlButton
                label="重置会话"
                variant="outlined"
                disabled={vm.busy || !vm.target.device_id}
                onClick={($event: any) => {
                  vm.safeAction(async () => {
                    await vm.post('/chat/reset', vm.target);
                    await vm.refresh();
                  });
                }}
              ></SlButton>
            </NativeView>
          </NativeView>
        </SectionCard>
        <SectionCard
          title="聊天历史"
          description="按账号和设备隔离，默认保存 30 天、最多 500 轮。取消和失败也会显示。"
        >
          <NativeView className="form-body">
            {vm.summary ? (
              <NativeView className="chat-text">
                <text>摘要：{displayText(vm.summary)}</text>
              </NativeView>
            ) : null}
            {!vm.history.length ? (
              <NativeView>
                <text>暂无对话记录</text>
              </NativeView>
            ) : null}
            {renderItems(vm.history, (turn) => (
              <NativeView key={turn.id} className="chat-turn">
                <NativeView>
                  <text>
                    {displayText(new Date(turn.created_at).toLocaleString())} ·{' '}
                    {displayText(vm.phases[turn.phase])}
                  </text>
                </NativeView>
                <NativeView className="chat-text">
                  <text>你：{displayText(turn.user)}</text>
                </NativeView>
                {turn.assistant ? (
                  <NativeView className="chat-text">
                    <text>AI：{displayText(turn.assistant)}</text>
                  </NativeView>
                ) : null}
                {turn.error ? (
                  <NativeView>
                    <text>{displayText(turn.error)}</text>
                  </NativeView>
                ) : null}
                <SlButton
                  label="删除这轮对话"
                  variant="text"
                  disabled={vm.busy}
                  onClick={($event: any) => {
                    vm.safeAction(() => vm.removeTurn(turn.id));
                  }}
                ></SlButton>
              </NativeView>
            ))}
            <NativeView className="chat-actions">
              <SlButton
                label="上一页"
                variant="outlined"
                disabled={vm.busy || vm.offset === 0}
                onClick={($event: any) => {
                  vm.safeAction(async () => {
                    vm.offset = Math.max(0, vm.offset - 20);
                    await vm.refresh();
                  });
                }}
              ></SlButton>
              <SlButton
                label="下一页"
                variant="outlined"
                disabled={vm.busy || vm.offset + vm.history.length >= vm.total}
                onClick={($event: any) => {
                  vm.safeAction(async () => {
                    vm.offset += 20;
                    await vm.refresh();
                  });
                }}
              ></SlButton>
              <SlButton
                label="清空历史和摘要"
                variant="text"
                disabled={vm.busy || !vm.target.device_id}
                onClick={($event: any) => {
                  vm.safeAction(() => vm.clear('history'));
                }}
              ></SlButton>
            </NativeView>
          </NativeView>
        </SectionCard>
        <SlDisclosure
          title="偏好记忆管理"
          description="查看、编辑或删除保存的偏好；手工编辑不会被自动覆盖。"
        >
          <NativeView className="form-body">
            {renderItems(vm.memories, (memory) => (
              <NativeView key={memory.id} className="chat-turn">
                <SlInput
                  modelValue={vm.memoryDrafts[memory.id] ?? memory.content}
                  onUpdateModelValue={($event: any) => {
                    vm.memoryDrafts[memory.id] = $event;
                  }}
                  aria-label="记忆内容"
                ></SlInput>
                <NativeView>
                  <text>
                    {displayText(memory.manual ? '手工维护' : '自动提取')} ·
                    来源：
                    {displayText(memory.source_ids.join('、') || '手工添加')}
                  </text>
                </NativeView>
                <NativeView className="chat-actions">
                  <SlButton
                    label="保存记忆"
                    variant="text"
                    disabled={vm.busy}
                    onClick={($event: any) => {
                      vm.safeAction(async () => {
                        await vm.put(
                          `/chat/memories/${encodeURIComponent(memory.id)}`,
                          {
                            ...vm.target,
                            content:
                              vm.memoryDrafts[memory.id] ?? memory.content,
                          },
                        );
                        delete vm.memoryDrafts[memory.id];
                        await vm.refresh();
                      });
                    }}
                  ></SlButton>
                  <SlButton
                    label="删除记忆"
                    variant="text"
                    disabled={vm.busy}
                    onClick={($event: any) => {
                      vm.safeAction(async () => {
                        await vm.del(
                          `/chat/memories/${encodeURIComponent(memory.id)}${vm.targetQuery}`,
                        );
                        await vm.refresh();
                      });
                    }}
                  ></SlButton>
                </NativeView>
              </NativeView>
            ))}
            <NativeView className="chat-field">
              <text>新增记忆</text>
              <SlInput
                modelValue={vm.newMemory}
                onUpdateModelValue={($event: any) => {
                  vm.newMemory = $event;
                }}
                aria-label="新增记忆"
              ></SlInput>
            </NativeView>
            <NativeView className="chat-actions">
              <SlButton
                label="添加记忆"
                variant="outlined"
                disabled={
                  vm.busy || !vm.newMemory.trim() || !vm.target.device_id
                }
                onClick={($event: any) => {
                  vm.safeAction(async () => {
                    await vm.post('/chat/memories', {
                      ...vm.target,
                      content: vm.newMemory,
                    });
                    vm.newMemory = '';
                    await vm.refresh();
                  });
                }}
              ></SlButton>
              <SlButton
                label="清空长期记忆"
                variant="text"
                disabled={vm.busy || !vm.target.device_id}
                onClick={($event: any) => {
                  vm.safeAction(() => vm.clear('memory'));
                }}
              ></SlButton>
              <SlButton
                label="全部清空"
                variant="text"
                disabled={vm.busy || !vm.target.device_id}
                onClick={($event: any) => {
                  vm.safeAction(() => vm.clear('all'));
                }}
              ></SlButton>
            </NativeView>
          </NativeView>
        </SlDisclosure>
      </NativeView>
    </>
  );
}
