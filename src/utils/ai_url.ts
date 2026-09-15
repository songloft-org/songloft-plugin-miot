// AI（OpenAI 兼容）接口地址规范化
//
// 背景：用户填写 api_url 的习惯差异很大，可能是
//   https://host                         （裸域名）
//   https://host/v1                      （标准 OpenAI 兼容）
//   https://host/compatible-mode/v1      （阿里云 DashScope）
//   https://host/v1/                     （带尾斜杠）
// 而各端点对「api_url 是否已含 /v1」的假设必须一致，否则会拼出重复前缀。
//
// 历史 bug：模型列表端点曾硬拼 `${api_url}/v1/models`，而对话端点用
// `${api_url}/chat/completions`——两者假设相反。按界面提示填写 `.../v1` 时，
// 模型请求变成 `.../v1/v1/models` → 404，且被笼统提示为「端点不存在」，
// 掩盖了真实原因。
//
// 约定：统一归一到「已包含版本段前缀、且无尾斜杠」的 base，再拼相对路径。
// 多数 OpenAI 兼容服务用 /v1；但部分厂商路径不同：火山方舟 /api/v3、智谱
// /api/paas/v4、千帆 /v2 等。若只认 /v1，这些服务会被错拼成 `.../v3/v1` → 404。

/** 已知 OpenAI 兼容版本段：/v1（标准）~ /v4（智谱等） */
const KNOWN_VERSION_SEG = /\/(v1|v2|v3|v4)$/i;

/** 归一化为「已包含版本段前缀」的 base URL（无尾斜杠） */
export function normalizeAiBaseUrl(apiUrl: string): string {
  let u = (apiUrl || '').trim();
  if (!u) return '';
  u = u.replace(/\/+$/, ''); // 去尾部斜杠
  if (KNOWN_VERSION_SEG.test(u)) return u; // 已含任意版本段：直接作为 base
  return `${u}/v1`; // 裸域名/未知：回退拼 /v1（兼容历史填写）
}

/** 模型列表端点：GET /v1/models */
export function aiModelsUrl(apiUrl: string): string {
  const base = normalizeAiBaseUrl(apiUrl);
  return base ? `${base}/models` : '';
}

/** 对话补全端点：POST /v1/chat/completions */
export function aiChatCompletionsUrl(apiUrl: string): string {
  const base = normalizeAiBaseUrl(apiUrl);
  return base ? `${base}/chat/completions` : '';
}

/**
 * 脱敏 URL：去掉 query 与 hash，仅保留「协议+主机+路径」。
 * 用于错误提示/日志展示实际请求地址，避免把 query 里可能带的 token 泄露出去
 * （api_key 走 Authorization 头，不在这类 URL 中，但用户可能把凭据写在 query 上）。
 */
export function maskUrl(raw: string): string {
  return String(raw || '').split(/[?#]/)[0];
}
