import {
  displayText,
  usePageState,
  NativeView,
  classes,
  styleObject,
  renderItems,
} from '../../page-state';
import AIModelSettings from './AIModelSettings.tsx';
import ChatSettings from './ChatSettings.tsx';
const pageState = {
  name: 'AISettings',
  createState(input, {}) {
    const bindings = { AIModelSettings, ChatSettings };
    return bindings;
  },
};
export default function AISettings(props: any) {
  const vm = usePageState(pageState, props);
  return (
    <>
      <NativeView className="ai-settings">
        <NativeView className="ai-settings-intro">
          <text>
            先配置默认模型连接，再分别开启口令分析或 AI
            对话。两项功能可使用不同模型和超时。
          </text>
        </NativeView>
        <AIModelSettings></AIModelSettings>
        <ChatSettings active={props.active} />
      </NativeView>
    </>
  );
}
