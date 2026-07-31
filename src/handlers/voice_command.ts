// MIoT 智能音箱插件 - 语音口令 Handler
// 翻译自 Go 源码: plugins/songloft-plugin-xiaomi/handlers/voice_command_handler.go

import { jsonResponse } from '@songloft/plugin-sdk';
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

/**
 * 注册语音口令相关路由
 * GET  /voice-commands → 获取语音口令配置
 * POST /voice-commands → 设置语音口令配置
 * POST /voice-commands/ai-test → 测试 AI 口令分析
 * POST /voice-commands/test → 模拟语音口令（完整匹配+执行）并返回诊断
 * POST /voice-commands/said → 模拟小米云对话消息并交给语音引擎处理
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
}
