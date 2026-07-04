// MIoT 智能音箱插件 - HTTP 工具（真异步：基于 globalThis.fetch）
//
// 提供两组工具：
//  1. httpFetch / fetchJSON：常规 JSON 请求；
//  2. fetchWithRedirects：带 Cookie 跟踪的手动重定向链
//     （小米登录流程涉及多次 3xx，需要逐步收集 Set-Cookie 并在下一跳带回）。
//
// 所有方法都返回 Promise，调用方必须 await。

/// <reference types="@songloft/plugin-sdk" />

import { CookieJar, parseCookies } from './cookie';

/** fetch请求选项（扩展） */
export interface FetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  redirect?: 'follow' | 'manual';
}

type HeaderValue = string | string[];

/** 响应头包装器（支持 case-insensitive get + getSetCookie） */
class ResponseHeaders {
  private _raw: Record<string, HeaderValue>;
  constructor(raw: Record<string, HeaderValue>) {
    this._raw = raw || {};
  }
  get(name: string): string | null {
    const direct = this._raw[name];
    if (direct !== undefined) return Array.isArray(direct) ? direct.join(', ') : direct;
    const lower = name.toLowerCase();
    for (const key of Object.keys(this._raw)) {
      if (key.toLowerCase() === lower) {
        const value = this._raw[key];
        return Array.isArray(value) ? value.join(', ') : value;
      }
    }
    return null;
  }
  getSetCookie(): string[] {
    const raw = this.getRaw('set-cookie');
    if (!raw) return [];
    if (Array.isArray(raw)) {
      return raw.flatMap(v => splitSetCookieHeader(String(v)));
    }
    return splitSetCookieHeader(String(raw));
  }

  private getRaw(name: string): HeaderValue | null {
    if (this._raw[name] !== undefined) return this._raw[name];
    const lower = name.toLowerCase();
    for (const key of Object.keys(this._raw)) {
      if (key.toLowerCase() === lower) return this._raw[key];
    }
    return null;
  }
}

/** HTTP 响应对象（与 Web Response 兼容的子集，xiaomi 内部使用） */
export interface HttpResponse {
  ok: boolean;
  status: number;
  statusText: string;
  headers: ResponseHeaders;
  text(): string;
  json(): any;
}

/** 重定向跟踪结果 */
export interface RedirectResult {
  response: HttpResponse;
  finalUrl: string;
  redirectCount: number;
}

/**
 * 通用 HTTP 请求（包装 globalThis.fetch，把 Web Response 转为本插件的
 * HttpResponse 接口，便于与原同步代码对齐）。
 */
export async function httpFetch(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<HttpResponse> {
  const method = (options.method || 'GET').toUpperCase();
  const headers = options.headers || {};
  const body = options.body;

  const resp = await fetch(url, { method, headers, body });
  // 把 Response.headers 拆成普通对象，方便 ResponseHeaders 包装。
  const headerObj: Record<string, HeaderValue> = {};
  if (resp.headers && typeof (resp.headers as unknown as Record<string, unknown>) === 'object') {
    // QuickJS polyfill 的 fetch.headers 是一个普通对象。
    for (const k of Object.keys(resp.headers as unknown as Record<string, HeaderValue>)) {
      headerObj[k] = (resp.headers as unknown as Record<string, HeaderValue>)[k];
    }
  }
  const text = await resp.text();

  return {
    ok: resp.ok,
    status: resp.status,
    statusText: resp.statusText || '',
    headers: new ResponseHeaders(headerObj),
    text() { return text; },
    json() { return JSON.parse(text); },
  };
}

/**
 * 带 Cookie 跟踪的重定向请求。
 *
 * 小米登录流程涉及多次 3xx 重定向，每步需要收集并回传 Cookie；
 * 通过 X-Fetch-No-Redirect 请求头让 Go 侧 fetch 不自动跟随重定向，
 * JS 侧手动循环处理。
 */
export async function fetchWithRedirects(
  url: string,
  options: FetchOptions = {},
  cookieJar: CookieJar,
  maxRedirects = 10,
): Promise<RedirectResult> {
  let currentUrl = url;
  let redirectCount = 0;

  while (redirectCount <= maxRedirects) {
    const headers: Record<string, string> = { ...(options.headers || {}) };
    const cookieHeader = cookieJar.getCookieHeader(currentUrl);
    if (cookieHeader) {
      // 合并 cookieJar 与调用者显式 Cookie（而非覆盖）
      if (headers['Cookie']) {
        headers['Cookie'] = headers['Cookie'] + '; ' + cookieHeader;
      } else {
        headers['Cookie'] = cookieHeader;
      }
    }

    // 让 Go 侧 fetch 不自动跟随重定向，由 JS 侧手动处理以收集中间 Cookie
    headers['X-Fetch-No-Redirect'] = '1';

    const method = redirectCount === 0 ? (options.method || 'GET') : 'GET';
    const body = (redirectCount === 0 && options.body) ? options.body : undefined;

    const response = await httpFetch(currentUrl, { method, headers, body });

    collectCookies(response, currentUrl, cookieJar);

    const status = response.status;
    if (status >= 300 && status < 400) {
      const location = response.headers.get('location');
      if (!location) {
        return { response, finalUrl: currentUrl, redirectCount };
      }
      currentUrl = resolveUrl(currentUrl, location);
      redirectCount++;
      continue;
    }

    return { response, finalUrl: currentUrl, redirectCount };
  }

  throw new Error(`Too many redirects (max: ${maxRedirects})`);
}

/** 从 Response 收集 Set-Cookie 头并加到 CookieJar */
function collectCookies(response: HttpResponse, url: string, cookieJar: CookieJar): void {
  const setCookieHeaders: string[] = [];

  if (typeof response.headers.getSetCookie === 'function') {
    const cookies = response.headers.getSetCookie();
    setCookieHeaders.push(...cookies);
  } else {
    const raw = response.headers.get('set-cookie');
    if (raw) {
      setCookieHeaders.push(...splitSetCookieHeader(raw));
    }
  }

  if (setCookieHeaders.length > 0) {
    const cookies = parseCookies(setCookieHeaders, url);
    cookieJar.add(cookies);
  }
}

/**
 * 分割合并在一起的 Set-Cookie 头。
 * HTTP/1.1 中多个 Set-Cookie 可能被合并为逗号分隔的单个头。
 */
function splitSetCookieHeader(header: string): string[] {
  const result: string[] = [];
  let current = '';
  let i = 0;

  while (i < header.length) {
    const commaIdx = header.indexOf(',', i);
    if (commaIdx === -1) {
      current += header.slice(i);
      break;
    }

    const afterComma = header.slice(commaIdx + 1).trimStart();
    const eqIdx = afterComma.indexOf('=');
    const semiIdx = afterComma.indexOf(';');
    const spaceIdx = afterComma.indexOf(' ');

    if (eqIdx > 0 && (semiIdx === -1 || eqIdx < semiIdx) && (spaceIdx === -1 || eqIdx < spaceIdx || spaceIdx > 0)) {
      const beforeComma = header.slice(i, commaIdx);
      if (isDateFragment(beforeComma)) {
        current += header.slice(i, commaIdx + 1);
        i = commaIdx + 1;
      } else {
        current += header.slice(i, commaIdx);
        result.push(current.trim());
        current = '';
        i = commaIdx + 1;
      }
    } else {
      current += header.slice(i, commaIdx + 1);
      i = commaIdx + 1;
    }
  }

  if (current.trim()) {
    result.push(current.trim());
  }

  return result;
}

/** 检查字符串是否像日期片段（用于区分 expires 中的逗号 vs cookie 分隔逗号） */
function isDateFragment(str: string): boolean {
  const trimmed = str.trim();
  const lastPart = trimmed.split(';').pop()?.trim() || '';
  return /expires\s*=\s*\w{3}$/i.test(lastPart) || /\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)$/i.test(lastPart);
}

/** 解析相对 URL 为绝对 URL */
function resolveUrl(base: string, relative: string): string {
  if (relative.startsWith('http://') || relative.startsWith('https://')) {
    return relative;
  }
  if (relative.startsWith('//')) {
    const proto = base.startsWith('https') ? 'https:' : 'http:';
    return proto + relative;
  }
  const protoIdx = base.indexOf('://');
  const protoEnd = protoIdx + 3;
  const pathIdx = base.indexOf('/', protoEnd);
  const origin = pathIdx === -1 ? base : base.slice(0, pathIdx);

  if (relative.startsWith('/')) {
    return origin + relative;
  }
  const basePath = pathIdx === -1 ? '/' : base.slice(pathIdx);
  const lastSlash = basePath.lastIndexOf('/');
  const dir = basePath.slice(0, lastSlash + 1);
  return origin + dir + relative;
}

/** 快速 JSON 请求（不跟踪 Cookie）。 */
export async function fetchJSON<T = unknown>(url: string, options: FetchOptions = {}): Promise<T> {
  const headers: Record<string, string> = {
    'Accept': 'application/json',
    ...(options.headers || {}),
  };
  if (options.body && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  const response = await httpFetch(url, {
    method: options.method || 'GET',
    headers,
    body: options.body,
  });
  if (!response.ok) {
    const text = response.text();
    throw new Error(`HTTP ${response.status}: ${text}`);
  }
  return JSON.parse(response.text()) as T;
}

// ===== 宿主 API 调用 =====

let _hostBaseUrl = '';

/** 获取宿主 API 基础 URL */
export function getHostBaseUrl(): string {
  return _hostBaseUrl;
}

/** 设置宿主 API 基础 URL（如 "http://127.0.0.1:58091"） */
export function setHostBaseUrl(url: string): void {
  _hostBaseUrl = url.endsWith('/') ? url.slice(0, -1) : url;
}

/** 调用 Songloft 宿主 API（自动携带 Bearer token） */
export async function callHostAPI<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  if (!_hostBaseUrl) {
    throw new Error('Host base URL not set. Call setHostBaseUrl() first.');
  }
  const pluginToken = await songloft.plugin.getToken();
  if (!pluginToken) {
    throw new Error('Plugin token not available from songloft.plugin.getToken()');
  }

  const url = _hostBaseUrl + path;
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${pluginToken}`,
    'Accept': 'application/json',
  };
  let bodyStr: string | undefined;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    bodyStr = JSON.stringify(body);
  }

  const response = await httpFetch(url, { method, headers, body: bodyStr });
  const text = response.text();
  if (!response.ok) {
    throw new Error(`Host API error ${response.status} ${method} ${path}: ${text}`);
  }
  return text ? (JSON.parse(text) as T) : (undefined as unknown as T);
}

// ===== 兼容别名 =====
// 旧代码使用 fetchSync / SyncResponse 名字；保留导出名以减少调用点改动，
// 但现在它们都返回 Promise，调用方必须 await。
export const fetchSync = httpFetch;
export type SyncResponse = HttpResponse;
