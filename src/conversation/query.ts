import type { ConversationMessage } from '../types';

/** 保留原始口令；意图文本可能已被云端去掉触发词或改写。 */
export function conversationQuery(message: ConversationMessage): string {
  const answer = message.message?.response?.answer?.[0];
  return answer?.question?.trim() || answer?.intention?.query?.trim() || '';
}

/** 只识别句首的点歌请求，避免“请问如何播放音乐”等讨论被当作点歌。 */
export function hasExplicitMusicRequest(text: string): boolean {
  return /^(?:请(?:你|帮我)?|麻烦(?:你)?|帮我|我要|我想|给我)?[，,\s]*(?:播放|点播|放一首|来一首|我想听|我要听|想听|听一首)\s*[^，。！？!?\s]/.test(text.trim());
}

/** 诊断随内存中的对话记录保留，不新增持久化或泄露连接凭证。 */
let traceListener: ((message: ConversationMessage) => void) | undefined;
export function setConversationTraceListener(listener?: (message: ConversationMessage) => void): void {
  traceListener = listener;
}
export function traceConversation(message: ConversationMessage, detail: string): void {
  const trace = message.routing_trace ||= [];
  if (trace.length >= 24) return;
  trace.push(detail.slice(0, 240));
  traceListener?.(message);
}
