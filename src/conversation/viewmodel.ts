// MIoT 智能音箱插件 - 对话记录视图模型
//
// 后端 ConversationMonitor 内部用嵌套的 ConversationMessage
//（{ message: { timestamp_ms, response: { answer: [{ question, content }] } } }），
// 语音引擎 extractQuery 也按嵌套读取。但前端「最近对话记录」列表与
// /conversation/messages、/conversation/ws 的消费方约定的是扁平结构
//（{ timestamp, query, answer, device_name, ... }）。
// 在 HTTP / WS 出口统一拍平，前端类型与模板无需感知嵌套。

import type { ConversationMessage } from '../types';

/** 前端消费的扁平对话记录视图模型 */
export interface ConversationViewModel {
  id?: string;
  timestamp: number;
  account_id: string;
  device_id: string;
  device_name: string;
  query: string;
  answer: string;
  routing_trace?: string[];
}

/**
 * 把嵌套的 ConversationMessage 拍平为前端约定的视图模型。
 *
 * query 取值与 VoiceEngine.extractQuery 同源：answer[0].question 优先，
 * 回退 intention.query；二者皆空时 query 为 ''，前端模板据此显示「未识别内容」。
 * 因此前端再出现「未识别内容」即可判定为平台 API 侧 record.query 确实为空，
 * 而非本插件的数据结构错位。
 */
export function toConversationViewModel(msg: ConversationMessage): ConversationViewModel {
  const ans = msg.message?.response?.answer?.[0];
  return {
    id: msg.message?.request_id,
    timestamp: msg.message?.timestamp_ms ?? 0,
    account_id: msg.account_id,
    device_id: msg.device_id,
    device_name: msg.device_name,
    query: ans?.question || ans?.intention?.query || '',
    answer: ans?.content || '',
    ...(msg.routing_trace ? { routing_trace: [...msg.routing_trace] } : {}),
  };
}
