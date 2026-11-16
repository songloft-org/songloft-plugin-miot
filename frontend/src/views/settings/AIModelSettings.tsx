import {
  displayText,
  usePageState,
  NativeView,
  classes,
  styleObject,
  renderItems,
} from '../../page-state';
import { computed, onMounted, onUnmounted, ref, watch } from '../../page-state';
import SectionCard from '../../ui/SectionCard.tsx';
import SettingRow from '../../ui/SettingRow.tsx';
import SlButton from '../../ui/SlButton.tsx';
import SlInput from '../../ui/SlInput.tsx';
import SlSelect from '../../ui/SlSelect.tsx';
import SlSwitch from '../../ui/SlSwitch.tsx';
import AIHeadersField from '../../ui/AIHeadersField.tsx';
import { parseAIHeaders } from '../../../../src/utils/ai_headers';
import { get, post } from '../../api';
import { AI_PRESET_PROVIDERS } from '../../aiPresets';
import { messageOf, notify, saveConfig, state } from '../../store';
import { navigation } from '../../runtime';
const CUSTOM_MODEL = '__custom_model__';
const pageState = {
  name: 'AIModelSettings',
  createState(input, {}) {
    const selectedPreset = ref('custom'),
      customModel = ref(false);
    const models = ref<
      Array<{
        id: string;
        ownedBy?: string;
      }>
    >([]);
    const loading = ref(false),
      modelError = ref(''),
      latency = ref<number | null>(null);
    const connectionState = ref<'idle' | 'loading' | 'ok' | 'error'>('idle');
    const testQuery = ref(''),
      testResult = ref(''),
      testBusy = ref(false);
    const customHeaders = ref(
      JSON.stringify(state.config.ai_config.custom_headers || {}, null, 2),
    );
    let alive = true,
      requestVersion = 0;
    const presetOptions = [
      { value: 'custom', label: '自定义（OpenAI 兼容）' },
      ...AI_PRESET_PROVIDERS.map((p) => ({
        value: p.id,
        label: p.name,
        searchText: p.name,
      })),
    ];
    const preset = computed(() =>
      AI_PRESET_PROVIDERS.find((p) => p.id === selectedPreset.value),
    );
    const modelOptions = computed(() => [
      ...models.value.map((m) => ({
        value: m.id,
        label: m.ownedBy ? `${m.id} (${m.ownedBy})` : m.id,
        searchText: m.id,
      })),
      { value: CUSTOM_MODEL, label: '自定义模型名…' },
    ]);
    const modelValue = computed(() =>
      customModel.value ? CUSTOM_MODEL : state.config.ai_config.model || '',
    );
    const signature = () => {
      let headers: unknown = customHeaders.value;
      try {
        headers = parseAIHeaders(customHeaders.value);
      } catch {}
      return JSON.stringify([
        state.config.ai_config.api_url,
        state.config.ai_config.api_key,
        headers,
      ]);
    };
    const connectionText = computed(
      () =>
        ({
          idle: '尚未检测连接',
          loading: '检测连接中…',
          ok: `已连接 · ${latency.value} ms`,
          error: `连接失败：${modelError.value}`,
        })[connectionState.value],
    );
    function syncPreset() {
      const url = (state.config.ai_config.api_url || '')
        .trim()
        .replace(/\/+$/, '');
      selectedPreset.value =
        AI_PRESET_PROVIDERS.find((p) => p.baseUrl.replace(/\/+$/, '') === url)
          ?.id || 'custom';
    }
    async function saveConnection() {
      let headers: Record<string, string>;
      try {
        headers = parseAIHeaders(customHeaders.value);
      } catch (error) {
        notify(messageOf(error), 'error');
        throw error;
      }
      await saveConfig({
        ai_config: { ...state.config.ai_config, custom_headers: headers },
      });
    }
    async function applyPreset(id: string) {
      selectedPreset.value = id;
      const next = AI_PRESET_PROVIDERS.find((p) => p.id === id);
      if (!next) return;
      state.config.ai_config.api_url = next.baseUrl;
      if (next.defaultModel) state.config.ai_config.model = next.defaultModel;
      customModel.value = true;
      try {
        await saveConnection();
      } catch {}
    }
    function selectModel(value: string) {
      customModel.value = value === CUSTOM_MODEL;
      if (customModel.value) return;
      state.config.ai_config.model = value;
      void saveConnection().catch(() => {});
    }
    async function refreshModels(silent = false) {
      const version = ++requestVersion,
        identity = signature();
      const current = () =>
        alive && version === requestVersion && identity === signature();
      if (!state.config.ai_config.api_url || !state.config.ai_config.api_key)
        return;
      loading.value = true;
      modelError.value = '';
      connectionState.value = 'loading';
      const started = Date.now();
      try {
        if (!silent) await saveConnection();
        if (!current()) return;
        const result = await get<{
          models: Array<{
            id: string;
            ownedBy?: string;
          }>;
        }>('/voice-commands/models');
        if (!current()) return;
        models.value = Array.isArray(result.models) ? result.models : [];
        latency.value = Date.now() - started;
        connectionState.value = 'ok';
        customModel.value =
          !!state.config.ai_config.model &&
          !models.value.some((m) => m.id === state.config.ai_config.model);
        if (!silent) notify(`已获取 ${models.value.length} 个模型`, 'success');
      } catch (error) {
        if (!current()) return;
        models.value = [];
        modelError.value = messageOf(error);
        connectionState.value = 'error';
        customModel.value = true;
        if (!silent) notify(modelError.value, 'error');
      } finally {
        if (current()) loading.value = false;
      }
    }
    async function enableAnalysis(enabled: boolean) {
      if (enabled && !state.config.voice_command_enabled) {
        notify('请先开启语音口令', 'warning');
        return;
      }
      try {
        await saveConfig({ ai_config: { ...state.config.ai_config, enabled } });
      } catch {}
    }
    async function testAnalysis() {
      if (testBusy.value || !testQuery.value.trim()) return;
      testBusy.value = true;
      testResult.value = '';
      const question = testQuery.value.trim();
      const identity = JSON.stringify([
        signature(),
        state.config.ai_config.model,
        state.config.ai_config.timeout,
      ]);
      const current = () =>
        alive &&
        testQuery.value.trim() === question &&
        identity ===
          JSON.stringify([
            signature(),
            state.config.ai_config.model,
            state.config.ai_config.timeout,
          ]);
      try {
        await saveConnection();
        if (!current()) return;
        const result = await post<Record<string, unknown>>(
          '/voice-commands/ai-test',
          { query: question },
        );
        if (current()) testResult.value = JSON.stringify(result, null, 2);
      } catch (error) {
        if (current()) testResult.value = messageOf(error);
      } finally {
        if (alive) testBusy.value = false;
      }
    }
    watch(signature, () => {
      requestVersion++;
      models.value = [];
      loading.value = false;
      modelError.value = '';
      latency.value = null;
      connectionState.value = 'idle';
      syncPreset();
    });
    watch(
      () => JSON.stringify(state.config.ai_config.custom_headers || {}),
      () => {
        customHeaders.value = JSON.stringify(
          state.config.ai_config.custom_headers || {},
          null,
          2,
        );
      },
    );
    onMounted(() => {
      syncPreset();
      customModel.value = !!state.config.ai_config.model;
      void refreshModels(true);
    });
    onUnmounted(() => {
      alive = false;
      requestVersion++;
    });
    const bindings = {
      selectedPreset,
      customModel,
      models,
      loading,
      modelError,
      latency,
      connectionState,
      testQuery,
      testResult,
      testBusy,
      customHeaders,
      get alive() {
        return alive;
      },
      set alive(v) {
        alive = v;
      },
      get requestVersion() {
        return requestVersion;
      },
      set requestVersion(v) {
        requestVersion = v;
      },
      presetOptions,
      preset,
      CUSTOM_MODEL,
      modelOptions,
      modelValue,
      signature,
      connectionText,
      syncPreset,
      saveConnection,
      applyPreset,
      selectModel,
      refreshModels,
      enableAnalysis,
      testAnalysis,
      SectionCard,
      SettingRow,
      SlButton,
      SlInput,
      SlSelect,
      SlSwitch,
      AIHeadersField,
      get state() {
        return state;
      },
      get navigation() {
        return navigation;
      },
    };
    return bindings;
  },
};
export default function AIModelSettings(props: any) {
  const vm = usePageState(pageState, props);
  return (
    <>
      <SectionCard
        title="默认模型连接"
        icon="auto_awesome"
        description="口令分析与 AI 对话可共用此连接。即使未开启口令分析，也能用于对话。"
      >
        <NativeView className="form-body">
          <NativeView className="field">
            <NativeView className="field-label">
              <text>服务商</text>
            </NativeView>
            <SlSelect
              modelValue={vm.selectedPreset}
              options={vm.presetOptions}
              aria-label="选择 AI 预设服务商"
              onUpdateModelValue={($event: any) => {
                void vm.applyPreset($event);
              }}
            ></SlSelect>
          </NativeView>
          {vm.selectedPreset === 'custom' ? (
            <NativeView className="field">
              <NativeView className="field-label">
                <text>API 地址</text>
              </NativeView>
              <SlInput
                modelValue={vm.state.config.ai_config.api_url}
                onUpdateModelValue={($event: any) => {
                  vm.state.config.ai_config.api_url = $event;
                }}
                aria-label="默认 AI API 地址"
                placeholder="https://api.example.com/v1"
                onChange={($event: any) => {
                  vm.saveConnection().catch(() => {});
                }}
              ></SlInput>
            </NativeView>
          ) : null}
          <NativeView className="field">
            <NativeView className="field-label">
              <text>API 密钥</text>
            </NativeView>
            <SlInput
              modelValue={vm.state.config.ai_config.api_key}
              onUpdateModelValue={($event: any) => {
                vm.state.config.ai_config.api_key = $event;
              }}
              type="password"
              aria-label="默认 AI API 密钥"
              onChange={($event: any) => {
                vm.saveConnection().catch(() => {});
              }}
            ></SlInput>
          </NativeView>
          <AIHeadersField
            modelValue={vm.customHeaders}
            onUpdateModelValue={($event: any) => {
              vm.customHeaders = $event;
            }}
            label="默认 AI 自定义请求头"
            onChange={($event: any) => {
              vm.saveConnection().catch(() => {});
            }}
          ></AIHeadersField>
          {vm.preset ? (
            <NativeView
              className="preset-key-link"
              href={vm.preset.apiKeyUrl}
              target="_blank"
              rel="noopener"
            >
              <text>前往 {displayText(vm.preset.name)} 获取 API Key ↗</text>
            </NativeView>
          ) : null}
          <NativeView className="field">
            <NativeView className="field-label">
              <text>默认模型</text>
            </NativeView>
            <NativeView className="inline-fields model-row">
              <SlSelect
                modelValue={vm.modelValue}
                options={vm.modelOptions}
                aria-label="选择 AI 模型"
                searchable
                searchPlaceholder="搜索模型名称"
                onUpdateModelValue={($event: any) => {
                  void vm.selectModel($event);
                }}
              ></SlSelect>
              <SlButton
                label="检测连接与获取模型"
                variant="outlined"
                icon="refresh"
                disabled={
                  vm.loading ||
                  !vm.state.config.ai_config.api_url ||
                  !vm.state.config.ai_config.api_key
                }
                onClick={($event: any) => {
                  vm.refreshModels();
                }}
              ></SlButton>
            </NativeView>
            {vm.customModel ? (
              <SlInput
                modelValue={vm.state.config.ai_config.model}
                onUpdateModelValue={($event: any) => {
                  vm.state.config.ai_config.model = $event;
                }}
                className="model-custom-input"
                aria-label="手动填写 AI 模型名"
                placeholder="填写服务商支持的模型名称"
                onChange={($event: any) => {
                  vm.saveConnection().catch(() => {});
                }}
              ></SlInput>
            ) : null}
            <NativeView className="field-help">
              <text>获取模型列表失败时，仍可手工填写模型名。</text>
            </NativeView>
          </NativeView>
          <NativeView className="status-chips">
            <NativeView
              className={classes([
                'chip',
                classes({
                  'chip-success': vm.connectionState === 'ok',
                  'chip-warning': vm.connectionState === 'error',
                }),
              ])}
            >
              <text>{displayText(vm.connectionText)}</text>
            </NativeView>
          </NativeView>
        </NativeView>
      </SectionCard>
      <SectionCard
        title="AI 口令分析"
        icon="mic"
        description="规则与点歌记忆未命中时，将自然语言解析成音乐控制口令。"
      >
        <SettingRow
          title="启用 AI 分析"
          subtitle={
            vm.state.config.voice_command_enabled
              ? '使用默认模型连接，与 AI 对话独立启用'
              : '需要先开启语音口令'
          }
        >
          <SlSwitch
            aria-label="启用 AI 分析"
            modelValue={!!vm.state.config.ai_config.enabled}
            disabled={!vm.state.config.voice_command_enabled}
            onUpdateModelValue={($event: any) => {
              void vm.enableAnalysis($event);
            }}
          ></SlSwitch>
        </SettingRow>
        <NativeView className="form-body">
          {!vm.state.config.voice_command_enabled ? (
            <SlButton
              label="设置语音口令"
              variant="outlined"
              onClick={($event: any) => {
                vm.navigation.settingsCategory = 'voice';
              }}
            ></SlButton>
          ) : null}
          <NativeView className="field">
            <NativeView className="field-label">
              <text>口令分析超时（1–30 秒）</text>
            </NativeView>
            <SlInput
              modelValue={String(vm.state.config.ai_config.timeout || 6)}
              type="number"
              aria-label="AI 口令分析超时"
              onUpdateModelValue={($event: any) => {
                vm.state.config.ai_config.timeout = Math.max(
                  1,
                  Math.min(30, Number($event) || 6),
                );
              }}
              onChange={($event: any) => {
                vm.saveConnection().catch(() => {});
              }}
            ></SlInput>
          </NativeView>
          <NativeView className="command-test-panel command-test-panel-inset">
            <NativeView>
              <text>AI 分析测试</text>
            </NativeView>
            <NativeView>
              <text>仅测试解析，不执行播放。</text>
            </NativeView>
            <NativeView className="inline-fields">
              <SlInput
                modelValue={vm.testQuery}
                onUpdateModelValue={($event: any) => {
                  vm.testQuery = $event;
                }}
                aria-label="AI 分析测试问题"
                placeholder="输入自然语言口令"
                onSubmit={($event: any) => {
                  void vm.testAnalysis($event);
                }}
              ></SlInput>
              <SlButton
                label="测试分析"
                variant="outlined"
                icon="science"
                disabled={vm.testBusy || !vm.testQuery.trim()}
                onClick={($event: any) => {
                  void vm.testAnalysis($event);
                }}
              ></SlButton>
            </NativeView>
            {vm.testResult ? (
              <NativeView className="result-pre">
                <text>{displayText(vm.testResult)}</text>
              </NativeView>
            ) : null}
          </NativeView>
        </NativeView>
      </SectionCard>
    </>
  );
}
