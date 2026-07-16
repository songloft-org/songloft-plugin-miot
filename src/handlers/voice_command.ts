// MIoT 智能音箱插件 - 语音口令 Handler
// 翻译自 Go 源码: plugins/songloft-plugin-xiaomi/handlers/voice_command_handler.go

import { jsonResponse } from '@songloft/plugin-sdk';
import type { Router, HTTPRequest } from '@songloft/plugin-sdk';
import { ConfigManager } from '../config/manager';
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

/**
 * 注册语音口令相关路由
 * GET  /voice-commands → 获取语音口令配置
 * POST /voice-commands → 设置语音口令配置
 * POST /voice-commands/ai-test → 测试 AI 口令分析
 * POST /voice-commands/test → 模拟语音口令（完整匹配+执行）并返回诊断
 */
export function registerVoiceCommandHandlers(
  router: Router,
  configManager: ConfigManager,
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
      const result = await analyzer.analyze(query, aiConfig);
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
}
