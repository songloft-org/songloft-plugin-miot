import type { AIClient } from '../ai/client';
import type { AIConfig } from '../types';
import { isDashScopeEndpoint } from '../utils/ai_url';
import { chatConnection } from './types';
import type { ChatConfig } from './types';

export interface ConnectionTestResult {
  connected: boolean;
  search: 'not_requested' | 'unconfirmed' | 'completed';
}

/** Probe the draft connection without devices, history, config writes or playback. */
export async function testChatConnection(client: AIClient, config: ChatConfig, analysis: AIConfig, search: boolean): Promise<ConnectionTestResult> {
  const connection = chatConnection(config, analysis);
  if (search && (!config.web_search_enabled || (connection.api_protocol !== 'responses' && !isDashScopeEndpoint(connection.api_url))))
    throw new Error('请先启用联网搜索；若当前连接方式不支持，可在高级设置中切换');
  let completed = false;
  await client.request(connection, [{
    role: 'user', content: search
      ? '请联网查询今天的日期，简短回答，并附上来源。'
      : '请只回复：连接正常。'
  }], 'chat', () => true, 'connection-test', {
    streaming: false,
    webSearch: search,
    onSearchCompleted: () => { completed = true; },
  });
  return { connected: true, search: search ? completed ? 'completed' : 'unconfirmed' : 'not_requested' };
}
