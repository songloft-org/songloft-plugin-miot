import type { HTTPStream } from '@songloft/plugin-sdk';
import { SSEParser } from './sse';

interface ResponseOutput {
  status?: string;
  type?: string;
  role?: string;
  content?: Array<{ type?: string; text?: string; }>;
}
interface ModelResponse {
  status?: string;
  error?: unknown;
  incomplete_details?: unknown;
  output?: ResponseOutput[];
  output_text?: string;
}

/** Only completed assistant text is suitable for history and TTS. */
export function readResponsesText(value: unknown, onSearchCompleted?: () => void): string {
  const data = value as ModelResponse | null;
  if (!data || data.error || data.incomplete_details || (data.status && data.status !== 'completed'))
    throw new Error('AI Responses 回答未正常完成');
  const output = Array.isArray(data.output) ? data.output : [];
  if (output.some(item => item.status && item.status !== 'completed'))
    throw new Error('AI Responses 输出或搜索未正常完成');
  if (output.some(item => ['function_call', 'custom_tool_call'].includes(item.type || '')))
    throw new Error('AI 返回了尚未执行的工具调用');
  const parts = output.filter(item => item.type === 'message' && (!item.role || item.role === 'assistant'))
    .flatMap(item => item.content || []).filter(part => part.type === 'output_text');
  if (parts.some(part => typeof part.text !== 'string'))
    throw new Error('AI Responses 正文格式无效');
  const text = parts.length ? parts.map(part => part.text).join('') : data.output_text;
  if (typeof text !== 'string' || !text.trim())
    throw new Error('AI 返回了空回答');
  if (output.some(item => item.type === 'web_search_call' && item.status === 'completed')) onSearchCompleted?.();
  return text.trim().slice(0, 16000);
}

/** Responses ends with a semantic terminal event, never with [DONE]. */
export async function readResponsesStream(stream: HTTPStream, current: () => boolean, progress: (text: string) => void, onSearchCompleted?: () => void): Promise<string> {
  let answer = '', done = false;
  const parser = new SSEParser(data => {
    if (done) return;
    const frame = JSON.parse(data);
    if (frame.error || ['error', 'response.failed', 'response.incomplete'].includes(frame.type))
      throw new Error('AI Responses 回答未正常完成');
    if (frame.type === 'response.output_text.delta') {
      if (typeof frame.delta !== 'string') throw new Error('AI Responses 正文格式无效');
      if (frame.delta && answer.length < 16000) {
        answer = (answer + frame.delta).slice(0, 16000);
        progress(answer);
      }
    }
    if (frame.type === 'response.completed') {
      const complete = readResponsesText(frame.response, onSearchCompleted);
      if (complete !== answer) progress(complete);
      answer = complete;
      done = true;
    }
  }, 256 << 10); // The terminal snapshot includes reasoning and tool records, unlike chat deltas.
  while (!done) {
    if (!current()) throw new Error('任务已取消');
    const chunk = await stream.read();
    if (!current()) throw new Error('任务已取消');
    if (chunk === null) break;
    parser.feed(chunk);
  }
  if (!done) throw new Error('AI 流式连接中断，回答未完成');
  return answer;
}
