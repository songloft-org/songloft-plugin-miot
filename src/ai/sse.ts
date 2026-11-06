import type { HTTPStream } from '@songloft/plugin-sdk';

/** Incremental SSE framing on bytes: UTF-8 code points may cross HTTP chunks. */
export class SSEParser {
  private line: number[] = [];
  private data: string[] = [];
  private eventSize = 0;
  private skipLF = false;
  private first = true;
  constructor(private event: (data: string) => void, private maxEventSize = 65536) { }
  feed(bytes: Uint8Array): void {
    for (const byte of bytes) {
      if (this.skipLF) {
        this.skipLF = false;
        if (byte === 10) continue;
      }
      if (byte === 10 || byte === 13) {
        this.endLine();
        this.skipLF = byte === 13;
      }
      else {
        this.line.push(byte);
        if (this.line.length + this.eventSize > this.maxEventSize) throw new Error('AI 流式事件超过长度限制');
      }
    }
  }
  private endLine(): void {
    let line = new TextDecoder().decode(new Uint8Array(this.line));
    this.line = [];
    if (this.first) { line = line.replace(/^\uFEFF/, ''); this.first = false; }
    if (!line) {
      if (this.data.length) this.event(this.data.join('\n'));
      this.data = []; this.eventSize = 0;
      return;
    }
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    if (field !== 'data') return;
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    this.eventSize += value.length + 1;
    if (this.eventSize > this.maxEventSize) throw new Error('AI 流式事件超过长度限制');
    this.data.push(value);
  }
}

export async function readChatStream(stream: HTTPStream, current: () => boolean, progress: (text: string) => void): Promise<string> {
  let answer = '', done = false, finished = false;
  const parser = new SSEParser(data => {
    if (done) return;
    if (data.trim() === '[DONE]') { done = true; return; }
    const frame = JSON.parse(data);
    if (frame?.error) throw new Error('AI 流式响应返回错误');
    const choice = frame?.choices?.find((item: { index?: number }) => item.index === 0 || item.index === undefined);
    if (!choice) return; // usage-only frame or keep-alive
    if (choice.finish_reason) {
      if (!['stop', 'length'].includes(choice.finish_reason)) throw new Error('AI 流式回答未正常结束');
      finished = true;
    }
    const content = choice.delta?.content;
    if (content !== undefined && content !== null && typeof content !== 'string') throw new Error('AI 流式正文格式无效');
    if (content && answer.length < 16000) {
      answer = (answer + content).slice(0, 16000);
      progress(answer);
    }
  });
  while (!done) {
    if (!current()) throw new Error('任务已取消');
    const chunk = await stream.read();
    if (!current()) throw new Error('任务已取消');
    if (chunk === null) break;
    parser.feed(chunk);
  }
  if (!done && !finished) throw new Error('AI 流式连接中断，回答未完成');
  if (!answer.trim()) throw new Error('AI 返回了空回答');
  return answer.trim();
}

export async function readStreamText(stream: HTTPStream, current: () => boolean): Promise<string> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (; ;) {
    const chunk = await stream.read();
    if (!current()) throw new Error('任务已取消');
    if (chunk === null) break;
    size += chunk.length;
    if (size > 2 << 20) throw new Error('AI 回答超过长度限制');
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder().decode(bytes);
}

export async function readStreamJSON(stream: HTTPStream, current: () => boolean): Promise<unknown> {
  return JSON.parse(await readStreamText(stream, current));
}
