import { apiGet, apiPost, apiPut, apiDelete } from "@songloft/lynx-plugin-sdk";
import type { ApiEnvelope } from "./types";
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status = 0,
  ) {
    super(message);
    this.name = "ApiError";
  }
}
const transports = {
  GET: apiGet,
  POST: apiPost,
  PUT: apiPut,
  DELETE: apiDelete,
};
async function request(
  method: keyof typeof transports,
  path: string,
  body?: unknown,
): Promise<unknown> {
  try {
    return await transports[method]("/api" + path, body);
  } catch (error) {
    throw new ApiError(messageOf(error));
  }
}
export function unwrap<T>(value: unknown): T {
  return decodePayload<T>(value, 0, true);
}

function decodePayload<T>(value: unknown, status: number, ok: boolean): T {
  const payload = value as Partial<ApiEnvelope<T>> | null;
  if (payload && typeof payload === "object" && "success" in payload) {
    if (payload.success === true) {
      return payload.data as T;
    }
    throw new ApiError(payload.error || "请求失败，请稍后重试", status);
  }
  if (!ok) {
    const detail =
      (payload as { detail?: string } | null)?.detail ||
      (payload as { error?: string; message?: string } | null)?.error ||
      (payload as { error?: string; message?: string } | null)?.message ||
      `请求失败 (${status})`;
    throw new ApiError(detail, status);
  }
  return value as T;
}

export async function get<T>(path: string): Promise<T> {
  return unwrap<T>(await request("GET", path));
}
export async function post<T>(path: string, body: unknown = {}): Promise<T> {
  return unwrap<T>(await request("POST", path, body));
}
export async function put<T>(path: string, body: unknown): Promise<T> {
  return unwrap<T>(await request("PUT", path, body));
}
export async function del<T>(path: string): Promise<T> {
  return unwrap<T>(await request("DELETE", path));
}
export async function postEnvelope<T>(
  path: string,
  body: unknown = {},
): Promise<T> {
  const result = (await request("POST", path, body)) as {
    success?: boolean;
    error?: string;
  } & T;
  if (!result || result.success !== true)
    throw new ApiError(result?.error || "请求失败");
  return result;
}
export function query(
  params: Record<string, string | number | boolean | undefined>,
): string {
  const values: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") {
      values.push(
        `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`,
      );
    }
  }
  return values.length ? `?${values.join("&")}` : "";
}

export const pluginWebSocketUrl = (path: string) => path;
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error || "未知错误");
}
