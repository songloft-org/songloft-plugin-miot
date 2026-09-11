// MIoT 智能音箱插件 - 语音口令 Handler
// 翻译自 Go 源码: plugins/songloft-plugin-xiaomi/handlers/voice_command_handler.go

import { jsonResponse, parseQuery } from '@songloft/plugin-sdk';
import type { Router, HTTPRequest } from '@songloft/plugin-sdk';
import { AccountManager } from '../account/manager';
import { ConfigManager } from '../config/manager';
import type { ConversationMessage, DeviceConfig } from '../types';
import { AIAnalyzer } from '../voicecmd/ai_analyzer';
import { VoiceEngine } from '../voicecmd/engine';

/** 解析请求体（兼容 Uint8Array 和 string） */
function parseBody(req: HTTPRequest): any {
  if (!req.body) return {};
  try {
    const str = typeof req.body === 'string'
      ? req.body
      : String.fromCharCode.apply(null, Array.from(req.body as Uint8Array));
    return JSON.parse(str);
  } catch {
    return {};
  }
}

interface VoiceCommandTarget {
  accountId: string;
  device: DeviceConfig;
}

/**
 * 解析模拟消息的目标设备。显式 deviceId 优先；缺省时使用最近选择的受管理设备。
 */
async function resolveTargetDevice(
  accountManager: AccountManager,
  deviceId?: string,
): Promise<VoiceCommandTarget> {
  const accounts = await accountManager.getAccounts();
  const managedTargets: VoiceCommandTarget[] = [];

  for (const account of accounts) {
    const devices = await accountManager.getManagedDevices(account.id);
    for (const device of devices) {
      const target = { accountId: account.id, device };
      if (deviceId && device.device_id === deviceId) {
        return target;
      }
      managedTargets.push(target);
    }
  }

  if (deviceId) {
    throw new Error(`managed device not found: ${deviceId}`);
  }

  const recentTargets = managedTargets
    .filter(target => {
      const account = accounts.find(item => item.id === target.accountId);
      return account?.last_selected_device_id === target.device.device_id;
    })
    .sort((a, b) => {
      const aTime = Date.parse(a.device.last_selected_at || '') || 0;
      const bTime = Date.parse(b.device.last_selected_at || '') || 0;
      return bTime - aTime;
    });

  if (recentTargets.length === 1) {
    return recentTargets[0];
  }
  if (recentTargets.length > 1) {
    const firstTime = Date.parse(recentTargets[0].device.last_selected_at || '') || 0;
    const secondTime = Date.parse(recentTargets[1].device.last_selected_at || '') || 0;
    if (firstTime > secondTime) {
      return recentTargets[0];
    }
    throw new Error('multiple recently selected devices found; device_id is required');
  }

  if (managedTargets.length === 1) {
    return managedTargets[0];
  }
  if (managedTargets.length === 0) {
    throw new Error('no managed device found');
  }
  throw new Error('device_id is required when multiple managed devices are available');
}

interface ModelInfo {
  id: string;
  object?: string;
  owned_by?: string;
}

/**
 * 注册语音口令相关路由
 * GET  /voice-commands → 获取语音口令配置
 * GET  /voice-commands/models → 获取可用模型列表（同时校验 API 连通性）
 * POST /voice-commands → 设置语音口令配置
 * POST /voice-commands/ai-test → 测试 AI 口令分析
 * POST /voice-commands/test → 模拟语音口令（完整匹配+执行）并返回诊断
 * POST /voice-commands/said → 模拟云端对话消息并交给语音引擎处理
 */
export function registerVoiceCommandHandlers(
  router: Router,
  configManager: ConfigManager,
  accountManager: AccountManager,
  voiceEngine: VoiceEngine,
): void {

  // GET /voice-commands - 获取语音口令配置
  router.get('/voice-commands', async (req: HTTPRequest) => {
    try {
      const commands = await configManager.getVoiceCommands();
      const config = await configManager.getConfig();
      return jsonResponse({
        success: true,
        data: { enabled: config.voice_command_enabled, commands },
      });
    } catch (e: any) {
      return jsonResponse({ success: false, error: e.message || String(e) });
    }
  });

  // GET /voice-commands/models - 获取可用模型列表（同时校验 API 连通性）
  router.get('/voice-commands/models', async (req: HTTPRequest) => {
    try {
      const aiConfig = await configManager.getAIConfig();
      if (!aiConfig.api_url || !aiConfig.api_key) {
        return jsonResponse({ success: false, error: 'AI 配置不完整，请先填写 API 地址和密钥' });
      }

      const modelsUrl = `${aiConfig.api_url}/v1/models`;
      songloft.log.info(`[VoiceCommands] Fetching models from ${modelsUrl}`);

      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('模型列表获取超时')), (aiConfig.timeout || 6) * 1000);
      });

      const fetchPromise = fetch(modelsUrl, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${aiConfig.api_key}`,
          'Content-Type': 'application/json',
        },
      });

      const resp = await Promise.race([fetchPromise, timeoutPromise]);

      // QuickJS 无 Response 类，duck-type 检查关键属性
      if (!resp || typeof resp.ok !== 'boolean' || typeof resp.status !== 'number') {
        throw new Error('无效的响应对象');
      }

      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        throw new Error(`模型列表请求失败 (${resp.status}): ${body.slice(0, 200)}`);
      }

      const data: { object: string; data?: Array<{ id: string; object?: string; owned_by?: string }> } = await resp.json();

      if (!Array.isArray(data.data)) {
        throw new Error('响应格式错误：缺少 data 数组');
      }

      const models = data.data.map((m: ModelInfo) => ({
        id: m.id,
        ownedBy: m.owned_by || '',
      }));

      return jsonResponse({
        success: true,
        data: { models, modelCount: models.length },
      });
    } catch (e: any) {
      const msg = e.message || String(e);
      // 把底层网络错误包装成通俗提示
      if (msg.includes('dial tcp') || msg.includes('lookup') || msg.includes('ENOTFOUND')) {
        return jsonResponse({ success: false, error: '无法连接 API，请检查 API 地址是否正确' });
      }
      if (msg.includes('timed out') || msg.includes('timeout')) {
        return jsonResponse({ success: false, error: '请求超时，请检查网络或加大超时时间' });
      }
      if (msg.includes('401') || msg.includes('403') || msg.includes('unauthorized') || msg.includes('forbidden')) {
        return jsonResponse({ success: false, error: 'API Key 不正确或无权限' });
      }
      if (msg.includes('404') || msg.includes('not found')) {
        return jsonResponse({ success: false, error: '接口不正确或未找到 /v1/models 端点' });
      }
      return jsonResponse({ success: false, error: '获取模型列表失败：' + msg.slice(0, 200) });
    }
  });

  // POST /voice-commands - 设置语音口令配置
  router.post('/voice-commands', async (req: HTTPRequest) => {
    try {
      const body = parseBody(req);
      const { commands } = body;

      if (!commands || !Array.isArray(commands)) {
        return jsonResponse({ success: false, error: 'commands array is required' });
      }

      await configManager.saveVoiceCommands(commands);
      return jsonResponse({ success: true, data: { message: 'voice commands saved', commands } });
    } catch (e: any) {
      return jsonResponse({ success: false, error: e.message || String(e) });
    }
  });

  // POST /voice-commands/ai-test - 测试 AI 口令分析
  router.post('/voice-commands/ai-test', async (req: HTTPRequest) => {
    try {
      const body = parseBody(req);
      const query = body.query as string | undefined;

      if (!query || typeof query !== 'string' || !query.trim()) {
        return jsonResponse({ success: false, error: 'query is required' });
      }

      const aiConfig = await configManager.getAIConfig();
      if (!aiConfig.api_url || !aiConfig.api_key) {
        return jsonResponse({ success: false, error: 'AI 配置不完整，请先填写 API 地址和密钥' });
      }

      // 测试时强制启用（忽略 saved enabled 状态）
      aiConfig.enabled = true;
      const analyzer = new AIAnalyzer();
      const start = Date.now();
      //严格模式，失败则抛出异常
      const result = await analyzer.strictAnalyze(query, aiConfig);
      const elapsed_ms = Date.now() - start;
      return jsonResponse({ success: true, data: result, elapsed_ms });
    } catch (e: any) {
      return jsonResponse({ success: false, error: e.message || String(e) });
    }
  });

  // POST /voice-commands/test - 模拟语音口令（完整匹配+执行）
  router.post('/voice-commands/test', async (req: HTTPRequest) => {
    try {
      const body = parseBody(req);
      const query = body.query as string | undefined;
      const deviceId = body.device_id as string | undefined;
      const accountId = body.account_id as string | undefined;

      if (!query || typeof query !== 'string' || !query.trim()) {
        return jsonResponse({ success: false, error: 'query is required' });
      }
      if (!deviceId || typeof deviceId !== 'string') {
        return jsonResponse({ success: false, error: 'device_id is required（请先选择设备）' });
      }

      const result = await voiceEngine.testCommand(query, deviceId, accountId);
      return jsonResponse({ success: true, data: result });
    } catch (e: any) {
      return jsonResponse({ success: false, error: e.message || String(e) });
    }
  });

  // POST /voice-commands/said - 语音口令主流程调用
  router.post('/voice-commands/said', async (req: HTTPRequest) => {
    try {
      const body = parseBody(req);
      const message = body.message;

      if (typeof message !== 'string' || !message.trim()) {
        return jsonResponse({ success: false, error: 'message is required' });
      }
      if (body.device_id !== undefined && (typeof body.device_id !== 'string' || !body.device_id.trim())) {
        return jsonResponse({ success: false, error: 'device_id must be a non-empty string' });
      }

      const target = await resolveTargetDevice(accountManager, body.device_id?.trim());
      const text = message.trim();
      const now = Date.now();
      const conversationMessage: ConversationMessage = {
        account_id: target.accountId,
        device_id: target.device.device_id,
        device_name: target.device.device_name,
        message: {
          request_id: `said_${now}`,
          timestamp_ms: now,
          response: {
            answer: [{
              question: text,
              content: '',
              intention: { query: text },
            }],
          },
        },
      };

      await voiceEngine.handleMessage(conversationMessage);
      return jsonResponse({
        success: true,
        data: {
          submitted: true,
          engine_enabled: voiceEngine.isEnabled(),
          account_id: target.accountId,
          device_id: target.device.device_id,
          device_name: target.device.device_name,
        },
      });
    } catch (e: any) {
      return jsonResponse({ success: false, error: e.message || String(e) });
    }
  });

  // GET /voice-commands/sleep-timer?account_id=...&device_id=... - 查询 sleep timer 状态
  router.get('/voice-commands/sleep-timer', async (req: HTTPRequest) => {
    try {
      const query = parseQuery(req.query);
      const accountId = query.account_id as string;
      const deviceId = query.device_id as string;
      if (!accountId || !deviceId) {
        return jsonResponse({ success: false, error: 'account_id and device_id are required' });
      }
      const state = voiceEngine.getSleepTimerState(accountId, deviceId);
      return jsonResponse({ success: true, data: state });
    } catch (e: any) {
      return jsonResponse({ success: false, error: e.message || String(e) });
    }
  });

  // POST /voice-commands/sleep-timer - 设置 sleep timer
  router.post('/voice-commands/sleep-timer', async (req: HTTPRequest) => {
    try {
      const body = parseBody(req);
      const { account_id: accountId, device_id: deviceId, mode } = body;
      const value = Number(body.value);
      if (!accountId || !deviceId) {
        return jsonResponse({ success: false, error: 'account_id and device_id are required' });
      }
      if (mode !== 'time' && mode !== 'songs') {
        return jsonResponse({ success: false, error: 'mode must be "time" or "songs"' });
      }
      const state = voiceEngine.setSleepTimer(accountId, deviceId, mode, value);
      return jsonResponse({ success: true, data: state });
    } catch (e: any) {
      return jsonResponse({ success: false, error: e.message || String(e) });
    }
  });

  // POST /voice-commands/sleep-timer/cancel - 取消 sleep timer
  router.post('/voice-commands/sleep-timer/cancel', async (req: HTTPRequest) => {
    try {
      const body = parseBody(req);
      const { account_id: accountId, device_id: deviceId } = body;
      if (!accountId || !deviceId) {
        return jsonResponse({ success: false, error: 'account_id and device_id are required' });
      }
      const cancelled = voiceEngine.cancelSleepTimer(accountId, deviceId);
      return jsonResponse({ success: true, data: { cancelled } });
    } catch (e: any) {
      return jsonResponse({ success: false, error: e.message || String(e) });
    }
  });
}
