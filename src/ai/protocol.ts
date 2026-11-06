import type { AIConfig } from '../types';
import { aiChatCompletionsUrl, aiResponsesUrl, isDashScopeEndpoint } from '../utils/ai_url';
import { canDisableDashScopeThinking } from '../utils/ai_thinking';
import { readChatStream } from './sse';
import { readResponsesStream, readResponsesText } from './responses';

export interface AIMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}
export type AIProtocol = 'chat_completions' | 'responses';
export type AIConnection = AIConfig & { api_protocol?: AIProtocol; };

/** Protocol-specific wire formats; transport, scheduling and cancellation stay in AIClient. */
export function createAIRequest(config: AIConnection, messages: AIMessage[], kind: 'chat' | 'summary' | 'memory', streaming: boolean, webSearch: boolean) {
  const responses = config.api_protocol === 'responses';
  const endpoint = responses ? aiResponsesUrl(config.api_url) : aiChatCompletionsUrl(config.api_url);
  // Responses search on some DashScope models requires thinking; use the provider default.
  const thinkingDisabled = !responses && canDisableDashScopeThinking(endpoint, config.model);
  const search = kind === 'chat' && webSearch;
  // Responses budgets can include reasoning and tool processing, not just visible text.
  const maxTokens = kind === 'chat' ? 2048 : 1200;
  return {
    endpoint, thinkingDisabled,
    body: responses ? {
      model: config.model, stream: streaming, input: messages, max_output_tokens: kind === 'chat' ? 8192 : 4096,
      store: false,
      ...(search ? { tools: [{ type: 'web_search' }] } : {}),
    } : {
      model: config.model, stream: streaming, messages, max_tokens: maxTokens,
      ...(thinkingDisabled ? { enable_thinking: false } : {}),
      ...(search && isDashScopeEndpoint(endpoint) ? { enable_search: true } : {}),
    },
    readJSON: responses ? readResponsesText : (value: unknown, _onSearchCompleted?: () => void): string => {
      const data = value as { choices?: Array<{ message?: { content?: unknown; }; }>; };
      const content = data?.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || !content.trim()) throw new Error('AI 返回了空回答');
      return content.trim().slice(0, 16000);
    },
    readStream: responses ? readResponsesStream : readChatStream,
  };
}
