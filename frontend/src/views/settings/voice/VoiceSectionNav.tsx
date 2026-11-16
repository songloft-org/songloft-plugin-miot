import {
  displayText,
  usePageState,
  NativeView,
  classes,
  styleObject,
  renderItems,
} from '../../../page-state';
import SlIcon from '../../../ui/SlIcon.tsx';
type VoicePanel = 'listen' | 'commands' | 'memory' | 'intelligence';
const pageState = {
  name: 'VoiceSectionNav',
  props: {
    modelValue: { type: String, required: true },
    panels: { type: Array, required: true },
  },
  emits: ['update:modelValue'],
  createState(input: any, { emit: emitEvent }) {
    const props = input;
    const emit = emitEvent;
    const bindings = { props, emit, SlIcon };
    return bindings;
  },
};
export default function VoiceSectionNav(props: any) {
  const vm = usePageState(pageState, props);
  return (
    <>
      <NativeView className="voice-settings-overview">
        <NativeView className="voice-settings-heading">
          <NativeView className="settings-header-eyebrow">
            <text>语音中枢</text>
          </NativeView>
          <NativeView>
            <text>选择要配置的能力</text>
          </NativeView>
          <NativeView>
            <text>基础监听、口令、记忆与智能搜索互相独立，按需逐项启用。</text>
          </NativeView>
        </NativeView>
        <NativeView className="voice-section-nav" aria-label="语音设置分类">
          {renderItems(vm.props.panels, (panel) => (
            <NativeView
              key={panel.id}
              ariaCurrent={
                vm.props.modelValue === panel.id ? 'page' : undefined
              }
              bindtap={($event: any) => {
                vm.emit('update:modelValue', panel.id);
              }}
              button
              className={classes([
                'voice-section-nav-item',
                classes({ active: vm.props.modelValue === panel.id }),
              ])}
            >
              <NativeView className="voice-section-nav-icon">
                <SlIcon name={panel.icon} size={20}></SlIcon>
              </NativeView>
              <NativeView>
                <NativeView>
                  <text>{displayText(panel.title)}</text>
                </NativeView>
                <NativeView>
                  <text>{displayText(panel.subtitle)}</text>
                </NativeView>
              </NativeView>
            </NativeView>
          ))}
        </NativeView>
      </NativeView>
    </>
  );
}
