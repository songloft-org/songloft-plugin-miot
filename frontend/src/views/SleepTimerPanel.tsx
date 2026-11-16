import {
  displayText,
  usePageState,
  NativeView,
  classes,
  styleObject,
  renderItems,
} from '../page-state';
import { computed, ref } from '../page-state';
import { sleepTimerLabel } from '../sleepTimer';
import type { SleepTimerStatus } from '../types';
import SlButton from '../ui/SlButton.tsx';
import SlIcon from '../ui/SlIcon.tsx';
import SlInput from '../ui/SlInput.tsx';
// 延迟停止面板本体：按时长 / 按歌曲两组档位 + 自定义输入。
//
// 宿主外壳有两处，所以正文单独成组件，档位列表不再各写一份：
// - PlayerSleepTimerPopup：工具栏按钮旁带锚点的浮层（`.player-sleep-popup`）
// - PlayerBarMorePopup：「更多」菜单里的二级面板（菜单项拿不到锚点，就地展开）
const pageState = {
  name: 'SleepTimerPanel',
  props: {
    status: { type: null, required: true },
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
    const statusLabel = computed(() => sleepTimerLabel(props.status));
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
      statusLabel,
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
export default function SleepTimerPanel(props: any) {
  const vm = usePageState(pageState, props);
  return (
    <>
      {vm.status.active ? (
        <NativeView className="sleep-timer-status">
          <SlIcon name="alarm_on" size={18} playerIcon></SlIcon>
          <NativeView>
            <text>{displayText(vm.statusLabel)}</text>
          </NativeView>
          <NativeView
            disabled={vm.busy}
            bindtap={($event: any) => {
              vm.emit('cancel');
            }}
            button
          >
            <text>取消定时</text>
          </NativeView>
        </NativeView>
      ) : null}
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
                  vm.status.active &&
                  vm.status.mode === 'songs' &&
                  vm.status.remaining === 1,
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
                  vm.status.active &&
                  vm.status.mode === 'songs' &&
                  vm.status.remaining === 3,
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
                  vm.status.active &&
                  vm.status.mode === 'songs' &&
                  vm.status.remaining === 5,
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
