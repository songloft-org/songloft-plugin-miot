import {
  displayText,
  usePageState,
  NativeView,
  classes,
  styleObject,
  renderItems,
} from '../page-state';
import { ref } from '../page-state';
import { sleepTimerLabel } from '../sleepTimer';
import type { SleepTimerStatus } from '../types';
import SlButton from '../ui/SlButton.tsx';
import SlIcon from '../ui/SlIcon.tsx';
import SlInput from '../ui/SlInput.tsx';
// 延迟停止的状态、档位和自定义输入。
const pageState = {
  name: 'SleepTimerPanel',
  props: {
    status: { type: null, required: false },
    busy: { type: Boolean, required: false },
    isLive: { type: Boolean, required: false },
  },
  emits: ['set', 'cancel'],
  createState(input: any, { emit: emitEvent }) {
    const props = input;
    const emit = emitEvent;
    const customMode = ref<'time' | 'songs' | ''>('');
    const customValue = ref('');
    const customError = ref('');
    function choose(mode: 'time' | 'songs', value: number): void {
      customError.value = '';
      emit('set', mode, value);
    }
    function showCustom(mode: 'time' | 'songs'): void {
      customMode.value = mode;
      customValue.value = '';
      customError.value = '';
    }
    function submitCustom(): void {
      if (!customMode.value) return;
      const value = Number(customValue.value.trim());
      const max = customMode.value === 'time' ? 999 : 99;
      if (!Number.isInteger(value) || value < 1 || value > max) {
        customError.value = `请输入 1-${max} 的整数`;
        return;
      }
      choose(customMode.value, value);
    }
    const bindings = {
      props,
      emit,
      customMode,
      customValue,
      customError,
      choose,
      showCustom,
      submitCustom,
      SlButton,
      SlIcon,
      SlInput,
    };
    return bindings;
  },
};
export default function SleepTimerPanel(props: {
  status: SleepTimerStatus | undefined;
  readFailed: boolean;
  busy?: boolean;
  isLive: boolean;
  onRetry: () => void;
  onSet: (mode: 'time' | 'songs', value: number) => void;
  onCancel: () => void;
}) {
  const vm = usePageState(pageState, props);
  const { status, readFailed, onRetry } = props;
  const statusLabel = readFailed
    ? '定时状态读取失败'
    : !status
      ? '正在读取定时状态…'
      : sleepTimerLabel(status) || '未设置延迟停止';
  return (
    <>
      <NativeView className="sleep-timer-status">
        {!readFailed && (
          <SlIcon
            name={status?.active ? 'alarm_on' : 'schedule'}
            size={18}
            playerIcon
          />
        )}
        <text className="sleep-timer-status-label" text-maxline="1">
          {statusLabel}
        </text>
        {readFailed && (
          <NativeView bindtap={onRetry} button>
            <text>重试</text>
          </NativeView>
        )}
        {status?.active && (
          <NativeView
            disabled={vm.busy}
            bindtap={($event: any) => {
              vm.emit('cancel');
            }}
            button
          >
            <text>取消定时</text>
          </NativeView>
        )}
      </NativeView>
      <NativeView className="sleep-timer-section">
        <NativeView className="sleep-timer-heading">
          <SlIcon name="schedule" size={16} playerIcon></SlIcon>
          <NativeView>
            <text>按时长</text>
          </NativeView>
        </NativeView>
        <NativeView className="sleep-timer-options">
          <NativeView
            disabled={vm.busy}
            bindtap={($event: any) => {
              vm.choose('time', 15);
            }}
            button
          >
            <text>15 分钟</text>
          </NativeView>
          <NativeView
            disabled={vm.busy}
            bindtap={($event: any) => {
              vm.choose('time', 30);
            }}
            button
          >
            <text>30 分钟</text>
          </NativeView>
          <NativeView
            disabled={vm.busy}
            bindtap={($event: any) => {
              vm.choose('time', 60);
            }}
            button
          >
            <text>1 小时</text>
          </NativeView>
          <NativeView
            disabled={vm.busy}
            bindtap={($event: any) => {
              vm.showCustom('time');
            }}
            button
          >
            <SlIcon name="edit" size={16} playerIcon></SlIcon>
            <text>自定义</text>
          </NativeView>
        </NativeView>
        {vm.customMode === 'time' ? (
          <NativeView className="sleep-timer-custom">
            <NativeView className="grid-cell">
              <SlInput
                modelValue={vm.customValue}
                onUpdateModelValue={($event: any) => {
                  vm.customValue = $event;
                }}
                type="number"
                min={1}
                max={999}
                step={1}
                unit="分钟"
                strictNumber
                placeholder="分钟 (1-999)"
                aria-label="自定义分钟数"
                onSubmit={($event: any) => {
                  void vm.submitCustom($event);
                }}
              ></SlInput>
            </NativeView>
            <SlButton
              variant="filled"
              label="设定"
              disabled={vm.busy}
              onClick={($event: any) => {
                void vm.submitCustom($event);
              }}
            ></SlButton>
          </NativeView>
        ) : null}
        {vm.customMode === 'time' && vm.customError ? (
          <NativeView className="sleep-timer-error">
            <text>{displayText(vm.customError)}</text>
          </NativeView>
        ) : null}
      </NativeView>
      {!vm.isLive ? (
        <NativeView className="sleep-timer-section sleep-timer-section-bordered">
          <NativeView className="sleep-timer-heading">
            <SlIcon name="queue_music" size={16} playerIcon></SlIcon>
            <NativeView>
              <text>按歌曲</text>
            </NativeView>
          </NativeView>
          <NativeView className="sleep-timer-options">
            <NativeView
              className={classes({
                selected:
                  status?.active &&
                  status.mode === 'songs' &&
                  status.remaining === 1,
              })}
              disabled={vm.busy}
              bindtap={($event: any) => {
                vm.choose('songs', 1);
              }}
              button
            >
              <text>1 首</text>
            </NativeView>
            <NativeView
              className={classes({
                selected:
                  status?.active &&
                  status.mode === 'songs' &&
                  status.remaining === 3,
              })}
              disabled={vm.busy}
              bindtap={($event: any) => {
                vm.choose('songs', 3);
              }}
              button
            >
              <text>3 首</text>
            </NativeView>
            <NativeView
              className={classes({
                selected:
                  status?.active &&
                  status.mode === 'songs' &&
                  status.remaining === 5,
              })}
              disabled={vm.busy}
              bindtap={($event: any) => {
                vm.choose('songs', 5);
              }}
              button
            >
              <text>5 首</text>
            </NativeView>
            <NativeView
              disabled={vm.busy}
              bindtap={($event: any) => {
                vm.showCustom('songs');
              }}
              button
            >
              <SlIcon name="edit" size={16} playerIcon></SlIcon>
              <text>自定义</text>
            </NativeView>
          </NativeView>
          {vm.customMode === 'songs' ? (
            <NativeView className="sleep-timer-custom">
              <NativeView className="grid-cell">
                <SlInput
                  modelValue={vm.customValue}
                  onUpdateModelValue={($event: any) => {
                    vm.customValue = $event;
                  }}
                  type="number"
                  min={1}
                  max={99}
                  step={1}
                  unit="首"
                  strictNumber
                  placeholder="歌曲数 (1-99)"
                  aria-label="自定义歌曲数"
                  onSubmit={($event: any) => {
                    void vm.submitCustom($event);
                  }}
                ></SlInput>
              </NativeView>
              <SlButton
                variant="filled"
                label="设定"
                disabled={vm.busy}
                onClick={($event: any) => {
                  void vm.submitCustom($event);
                }}
              ></SlButton>
            </NativeView>
          ) : null}
          {vm.customMode === 'songs' && vm.customError ? (
            <NativeView className="sleep-timer-error">
              <text>{displayText(vm.customError)}</text>
            </NativeView>
          ) : null}
        </NativeView>
      ) : null}
    </>
  );
}
