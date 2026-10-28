import { jsonResponse, parseQuery } from '@songloft/plugin-sdk';
import type { Router, HTTPRequest, HTTPResponse } from '@songloft/plugin-sdk';
import type { ConfigManager } from '../config/manager';
import type { AIChatService } from '../chat/service';
import { chatConnection, chatScope } from '../chat/types';
import type { ChatConfig } from '../chat/types';
import { aiModelsUrl } from '../utils/ai_url';
import { requestAI } from '../utils/ai_request';
import { aiRequestHeaders } from '../utils/ai_headers';
export function chatBody(req: HTTPRequest): Record<string, unknown> {
  const raw = !req.body ? '{}' : typeof req.body === 'string' ? req.body : decodeURIComponent(Array.from(req.body).map(byte => '%' + byte.toString(16).padStart(2, '0')).join(''));
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  }
  catch {
    throw new Error('请求 JSON 无效');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('请求必须是对象');
  return parsed as Record<string, unknown>;
}
export async function validateChatTarget(config: ConfigManager, input: Record<string, unknown>): Promise<{
  account: string;
  device: string;
  scope: string;
}> {
  const account = input.account_id, device = input.device_id;
  if (typeof account !== 'string' || !account || typeof device !== 'string' || !device)
    throw new Error('请选择账号和设备');
  if (!(await config.getAccounts()).some(a => a.id === account))
    throw new Error('账号不存在');
  if (!(await config.getDevices(account)).some(d => d.device_id === device && d.managed))
    throw new Error('设备不存在或未启用管理');
  return { account, device, scope: chatScope(account, device) };
}
export function registerChatHandlers(router: Router, config: ConfigManager, chat: AIChatService, onConfigChanged?: (config: ChatConfig) => void): void {
  const wrap = (run: (req: HTTPRequest, params: Record<string, string>) => Promise<HTTPResponse>) => async (req: HTTPRequest, params: Record<string, string>) => {
    try {
      return await run(req, params);
    }
    catch (error) {
      return jsonResponse({ error: 'chat_request_failed', detail: error instanceof Error ? error.message : 'AI 对话操作失败' }, 400);
    }
  };
  const target = (req: HTTPRequest, body?: Record<string, unknown>) => validateChatTarget(config, body || parseQuery(req.query));
  router.get('/chat/capabilities', wrap(async () => jsonResponse({ streaming: typeof songloft.net?.httpStream === 'function' })));
  router.get('/chat/config', wrap(async () => jsonResponse(await config.getChatConfig())));
  router.put('/chat/config', wrap(async (req) => {
    const next = await config.saveChatConfig(chatBody(req) as Partial<ChatConfig>);
    await chat.cancelAll();
    chat.configurationChanged();
    onConfigChanged?.(next);
    return jsonResponse(next);
  }));
  router.get('/chat/models', wrap(async () => {
    const connection = chatConnection(await config.getChatConfig(), await config.getAIConfig());
    if (!connection.api_url || !connection.api_key)
      throw new Error('AI 对话连接配置不完整');
    const models = await requestAI(aiModelsUrl(connection.api_url), { method: 'GET', headers: aiRequestHeaders(connection) }, connection.timeout, { kind: 'models' }, async (response) => {
      if (!response.ok)
        throw new Error(`模型列表请求失败：${response.status}`);
      const result = await response.json();
      if (!Array.isArray(result.data))
        throw new Error('模型列表格式无效');
      return result.data.filter((m: {
        id?: unknown;
      }) => typeof m?.id === 'string').map((m: {
        id: string;
      }) => ({ id: m.id }));
    });
    return jsonResponse({ models });
  }));
  router.post('/chat/messages', wrap(async (req) => {
    const body = chatBody(req), t = await target(req, body);
    if (body.speak !== undefined && typeof body.speak !== 'boolean')
      throw new Error('speak 必须是布尔值');
    const id = await chat.submit(t.account, t.device, body.text as string, body.speak !== false);
    return jsonResponse({ task_id: id, phase: 'queued' }, 202);
  }));
  router.get('/chat/status', wrap(async (req) => { const t = await target(req); return jsonResponse(chat.status(t.account, t.device)); }));
  router.get('/chat/history', wrap(async (req) => {
    const t = await target(req), q = parseQuery(req.query), value = await chat.memory.load(t.scope);
    const limit = Math.max(1, Math.min(100, Number(q.limit) || 20)), offset = Math.max(0, Math.floor(Number(q.offset) || 0));
    const cfg = await config.getChatConfig();
    const history = value.history.filter(turn => turn.created_at >= Date.now() - cfg.history_days * 86400000).slice(-cfg.history_limit).reverse();
    return jsonResponse({ history: history.slice(offset, offset + limit), total: history.length, summary: value.summary });
  }));
  router.delete('/chat/history/:id', wrap(async (req, params) => {
    const t = await target(req);
    await chat.cancel(t.account, t.device);
    await chat.memory.removeTurn(t.scope, params.id);
    chat.dataChanged(t.scope);
    void chat.maintain(t.scope, await config.getChatConfig(), true);
    return jsonResponse({ deleted: true });
  }));
  router.post('/chat/cancel', wrap(async (req) => {
    const body = chatBody(req), t = await target(req, body);
    for (const field of ['close_session', 'resume_music'])
      if (body[field] !== undefined && typeof body[field] !== 'boolean')
        throw new Error(`${field} 必须是布尔值`);
    await chat.cancel(t.account, t.device, body.close_session !== false, body.resume_music === true);
    return jsonResponse({ cancelled: true });
  }));
  router.post('/chat/reset', wrap(async (req) => {
    const t = await target(req, chatBody(req));
    await chat.cancel(t.account, t.device);
    await chat.memory.reset(t.scope);
    chat.dataChanged(t.scope);
    return jsonResponse({ reset: true });
  }));
  router.get('/chat/memories', wrap(async (req) => { const t = await target(req); return jsonResponse({ memories: (await chat.memory.load(t.scope)).memories }); }));
  router.post('/chat/memories', wrap(async (req) => {
    const body = chatBody(req), t = await target(req, body);
    if (typeof body.content !== 'string')
      throw new Error('记忆内容必须是文本');
    const memory = await chat.memory.editMemory(t.scope, body.content);
    chat.dataChanged(t.scope);
    return jsonResponse(memory, 201);
  }));
  router.put('/chat/memories/:id', wrap(async (req, params) => {
    const body = chatBody(req), t = await target(req, body);
    if (typeof body.content !== 'string')
      throw new Error('记忆内容必须是文本');
    const memory = await chat.memory.editMemory(t.scope, body.content, params.id);
    chat.dataChanged(t.scope);
    return jsonResponse(memory);
  }));
  router.delete('/chat/memories/:id', wrap(async (req, params) => { const t = await target(req); await chat.memory.removeMemory(t.scope, params.id); chat.dataChanged(t.scope); return jsonResponse({ deleted: true }); }));
  router.post('/chat/clear', wrap(async (req) => {
    const body = chatBody(req), t = await target(req, body);
    if (!['history', 'memory', 'all'].includes(body.range as string))
      throw new Error('清理范围无效');
    await chat.clear(t.account, t.device, body.range as 'history' | 'memory' | 'all');
    return jsonResponse({ cleared: true });
  }));
}
