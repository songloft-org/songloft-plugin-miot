import {
  displayText,
  usePageState,
  NativeView,
  classes,
  styleObject,
  renderItems,
} from '../../page-state';
import { computed, ref } from '../../page-state';
import SectionCard from '../../ui/SectionCard.tsx';
import SlButton from '../../ui/SlButton.tsx';
import SlInput from '../../ui/SlInput.tsx';
import SlStatusChip from '../../ui/SlStatusChip.tsx';
import SlEmptyState from '../../ui/SlEmptyState.tsx';
import {
  currentDevice,
  deviceName,
  messageOf,
  notify,
  playerCommand,
  state,
} from '../../store';
const pageState = {
  name: 'ToolboxSettings',
  createState(input, {}) {
    const url = ref('https://lhttp.qtfm.cn/live/4915/64k.mp3');
    const text = ref('');
    const targetLabel = computed(() =>
      currentDevice.value ? deviceName(currentDevice.value) : '未选择设备',
    );
    async function sendUrl() {
      if (!url.value.trim()) return;
      try {
        await playerCommand('/mina/play-url', { url: url.value.trim() });
      } catch (error) {
        notify(messageOf(error), 'error');
      }
    }
    async function repeatText(content: string): Promise<boolean> {
      if (!content.trim()) return false;
      try {
        return await playerCommand('/mina/tts', { text: content.trim() });
      } catch {
        // playerCommand 已记录失败并展示错误提示。
        return false;
      }
    }
    async function sendText() {
      const draft = text.value;
      if ((await repeatText(draft)) && text.value === draft) text.value = '';
    }
    const bindings = {
      url,
      text,
      targetLabel,
      sendUrl,
      repeatText,
      sendText,
      SectionCard,
      SlButton,
      SlInput,
      SlStatusChip,
      SlEmptyState,
      get currentDevice() {
        return currentDevice;
      },
      get state() {
        return state;
      },
    };
    return bindings;
  },
};
export default function ToolboxSettings(props: any) {
  const vm = usePageState(pageState, props);
  return (
    <>
      <NativeView className="toolbox-target-card">
        <NativeView>
          <NativeView className="settings-header-eyebrow">
            <text>当前操作目标</text>
          </NativeView>
          <NativeView>
            <text>{displayText(vm.targetLabel)}</text>
          </NativeView>
          <NativeView>
            <text>
              文字播报发送到这台设备；URL 播放会同步到它所在的设备分组。
            </text>
          </NativeView>
        </NativeView>
        <SlStatusChip
          label={vm.currentDevice ? '已就绪' : '不可用'}
          tone={vm.currentDevice ? 'success' : 'warning'}
          icon={vm.currentDevice ? 'speaker' : 'warning'}
        ></SlStatusChip>
      </NativeView>
      <SectionCard
        title="URL 播放"
        icon="link"
        description="将音频 URL 推送到当前选中的设备或设备分组。URL 必须能从音箱所在网络访问。"
      >
        <NativeView className="form-body">
          <NativeView className="inline-fields">
            <SlInput
              modelValue={vm.url}
              onUpdateModelValue={($event: any) => {
                vm.url = $event;
              }}
              type="url"
              placeholder="https://example.com/audio.mp3"
              aria-label="音频 URL"
              onSubmit={($event: any) => {
                void vm.sendUrl($event);
              }}
            ></SlInput>
            <SlButton
              variant="filled"
              label="播放"
              icon="play_arrow"
              onClick={($event: any) => {
                void vm.sendUrl($event);
              }}
            ></SlButton>
          </NativeView>
        </NativeView>
      </SectionCard>
      <SectionCard
        title="文字播报"
        icon="record_voice_over"
        description="使用当前设备的 TTS 播报文字。"
      >
        <NativeView className="form-body">
          <NativeView className="inline-fields">
            <SlInput
              modelValue={vm.text}
              onUpdateModelValue={($event: any) => {
                vm.text = $event;
              }}
              placeholder="输入要播报的文字"
              aria-label="播报文字"
              onSubmit={($event: any) => {
                void vm.sendText($event);
              }}
            ></SlInput>
            <SlButton
              variant="filled"
              label="播报"
              icon="campaign"
              disabled={
                vm.state.playerBusy || !vm.currentDevice || !vm.text.trim()
              }
              onClick={($event: any) => {
                void vm.sendText($event);
              }}
            ></SlButton>
          </NativeView>
        </NativeView>
      </SectionCard>
      <SectionCard title="操作结果" icon="terminal">
        <NativeView className="form-body">
          <NativeView className="field-actions">
            <SlButton
              variant="text"
              label="清空记录"
              icon="delete_sweep"
              onClick={($event: any) => {
                vm.state.operationLog = [];
              }}
            ></SlButton>
          </NativeView>
          {renderItems(vm.state.operationLog, (item) => (
            <NativeView key={item.id} className="list-item">
              <NativeView className="list-item-copy">
                <NativeView
                  className="list-item-title"
                  title={item.ttsText || item.message}
                >
                  <text>{displayText(item.ttsText || item.message)}</text>
                </NativeView>
                <NativeView className="list-item-subtitle" title={item.message}>
                  <text>{displayText(item.time)}</text>
                  {item.ttsText ? (
                    <>
                      <text> · </text>
                      <text>{displayText(item.message)}</text>
                    </>
                  ) : null}
                </NativeView>
              </NativeView>
              <NativeView
                className={classes([
                  'chip',
                  classes(item.success ? 'chip-success' : 'chip-error'),
                ])}
              >
                <text>{displayText(item.success ? '成功' : '失败')}</text>
              </NativeView>
              {item.ttsText ? (
                <SlButton
                  variant="icon"
                  label="重复播报"
                  icon="refresh"
                  title="向当前设备重复播报"
                  disabled={vm.state.playerBusy || !vm.currentDevice}
                  onClick={($event: any) => {
                    vm.repeatText(item.ttsText);
                  }}
                ></SlButton>
              ) : null}
            </NativeView>
          ))}
          {!vm.state.operationLog.length ? (
            <SlEmptyState
              compact
              title="暂无操作记录"
              description="文字播报结果和操作失败信息会显示在这里。"
              icon="terminal"
            ></SlEmptyState>
          ) : null}
        </NativeView>
      </SectionCard>
    </>
  );
}
