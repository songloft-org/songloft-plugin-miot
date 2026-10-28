// AI 请求的 JS 等待期限与宿主 HTTP 期限保持一致，避免超时后继续占用连接。
export function aiTimeoutMs(seconds: number): number {
  const value = Number.isFinite(seconds) && seconds > 0 ? seconds : 6;
  return Math.round(Math.max(1, Math.min(30, value)) * 1000);
}

export interface AIRequestOptions {
  method: string;
  headers: Record<string, string>;
  body?: string;
}

interface AIRequestContext {
  kind: 'analysis' | 'models' | 'chat' | 'summary' | 'memory';
  model?: string;
  thinkingDisabled?: boolean;
  queryChars?: number;
}

let requestSequence = 0;

/** 包含响应解析的等待期限；QuickJS fetch 在整个响应体读完后才返回。 */
export async function requestAI<T>(
  url: string,
  options: AIRequestOptions,
  timeoutSeconds: number,
  context: AIRequestContext,
  readResponse: (response: Pick<Response, 'ok' | 'status' | 'json' | 'text'>, requestId: string) => Promise<T>,
  transport?: (options: AIRequestOptions) => Promise<Pick<Response, 'ok' | 'status' | 'json' | 'text'>>,
): Promise<T> {
  const requestId = String(++requestSequence);
  const timeoutMs = aiTimeoutMs(timeoutSeconds);
  const started = Date.now();
  const safeUrl = url.split(/[?#]/)[0].replace(/^(https?:\/\/)[^/]*@/i, '$1');
  const apiKey = (options.headers.Authorization || '').replace(/^Bearer\s+/i, '');
  const credentials = [...new Set([apiKey, ...Object.entries(options.headers).filter(([name]) => name.toLowerCase() !== 'content-type').map(([, value]) => value)].filter(Boolean))].sort((a, b) => b.length - a.length);
  const redact = (value: string): string => {
    // Go 网络错误中的 URL 可能已移除 userinfo/fragment，不能只匹配原始配置。
    const withoutUrl = value.replace(/https?:\/\/[^\s"'<>]+/gi, matched =>
      matched.split(/[?#]/)[0].replace(/^(https?:\/\/)[^/]*@/i, '$1'));
    return credentials.reduce((text, secret) => text.split(secret).join('***'), withoutUrl).replace(/[\r\n]/g, ' ').slice(0, 500);
  };
  const prefix = `[AIRequest] id=${requestId} kind=${context.kind}`;
  const modelHint = context.model ? `，模型 ${redact(context.model)}` : '';
  const timeoutMessage = `AI API call timed out (${timeoutMs / 1000}s${modelHint})：请检查网络、加大超时时间或使用响应更快的非思考模型`;
  let finished = false;
  let status: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  songloft.log.info(`${prefix} start method=${options.method} url=${redact(safeUrl)} timeout_ms=${timeoutMs} model=${context.model ? redact(context.model) : 'unavailable'} thinking_disabled=${context.thinkingDisabled ?? 'unavailable'} query_chars=${context.queryChars ?? 'unavailable'}`);
  try {
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
    });
    const request = (async () => {
      const init = {
        ...options,
        headers: { ...options.headers, 'X-Fetch-Timeout-Ms': String(timeoutMs) },
      };
      const response = await (transport ? transport(init) : fetch(url, init));
      // 超时后的迟到响应不再解析或记录为成功。
      if (finished) throw new Error(timeoutMessage);
      status = response.status;
      songloft.log.info(`${prefix} response status=${status} elapsed_ms=${Date.now() - started}`);
      return await readResponse(response, requestId);
    })();
    const result = await Promise.race([request, deadline]);
    songloft.log.info(`${prefix} completed status=${status} elapsed_ms=${Date.now() - started}`);
    return result;
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    const networkTimeout = status === undefined && /timed out|timeout|deadline exceeded/i.test(raw);
    const message = raw === timeoutMessage || networkTimeout ? timeoutMessage : redact(raw);
    songloft.log.warn(`${prefix} failed status=${status ?? 'unavailable'} elapsed_ms=${Date.now() - started} error=${message}`);
    throw new Error(message);
  } finally {
    finished = true;
    if (timer !== undefined) clearTimeout(timer);
  }
}
