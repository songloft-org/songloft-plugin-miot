import { isDashScopeEndpoint } from './ai_url';

/** 仅百炼官方端点的已知混合思考模型使用非标准参数，避免影响其它兼容接口。 */
export function canDisableDashScopeThinking(endpoint: string, model: string): boolean {
  const isDashScope = isDashScopeEndpoint(endpoint);
  const hybridModel = /^qwen3\.[5-8]-(?:plus|flash)(?:-latest|-\d{4}-\d{2}-\d{2})?$/i.test(model);
  const legacyHybrid = /^qwen-(plus|flash)(?:-(latest|\d{4}-\d{2}-\d{2}))?$/i.exec(model);
  const legacySupported = legacyHybrid !== null && (!legacyHybrid[2] || legacyHybrid[2].toLowerCase() === 'latest' ||
    legacyHybrid[2] >= (legacyHybrid[1].toLowerCase() === 'plus' ? '2025-04-28' : '2025-07-28'));
  const hybridMaxModels = ['qwen3.8-max', 'qwen3.7-max', 'qwen3.7-max-2026-05-20', 'qwen3.7-max-2026-06-08'];
  return isDashScope && (hybridModel || legacySupported || hybridMaxModels.includes(model.toLowerCase()));
}
