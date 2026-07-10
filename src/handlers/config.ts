// MIoT 智能音箱插件 - 配置 Handler
// 翻译自 Go 源码: plugins/songloft-plugin-xiaomi/handlers/config_handler.go

import { jsonResponse } from '@songloft/plugin-sdk';
import type { Router, HTTPRequest } from '@songloft/plugin-sdk';
import { ConfigManager } from '../config/manager';
import { ConversationMonitor } from '../conversation/monitor';
import { Scheduler } from '../schedule/scheduler';
import { VoiceEngine } from '../voicecmd/engine';
import { setHostBaseUrl, callHostAPI } from '../utils/http';
import { setPollDebug } from '../utils/debug';
import type { SearchPriority } from '../types';

const SEARCH_PRIORITIES: SearchPriority[] = ['parallel', 'local_first', 'external_first'];

function normalizeSearchPriority(value: unknown): SearchPriority {
  return typeof value === 'string' && SEARCH_PRIORITIES.includes(value as SearchPriority)
    ? value as SearchPriority
    : 'parallel';
}

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

/** 判断是否为本地回环地址 */
function isLoopbackAddress(host: string): boolean {
  if (!host) return false;
  let hostname = host;
  const protoIdx = host.indexOf('://');
  if (protoIdx >= 0) {
    const rest = host.slice(protoIdx + 3);
    const slashIdx = rest.indexOf('/');
    const colonIdx = rest.indexOf(':');
    hostname = rest.slice(0, slashIdx >= 0 ? slashIdx : (colonIdx >= 0 ? colonIdx : undefined));
  }
  hostname = hostname.toLowerCase().trim();
  return hostname === 'localhost' || hostname.startsWith('127.') || hostname === '::1';
}

/** 获取服务器地址状态 */
function getServerHostStatus(host: string): string {
  if (!host) return 'empty';
  if (isLoopbackAddress(host)) return 'loopback';
  return 'ok';
}

/**
 * 注册配置相关路由
 * GET  /config → 获取配置
 * POST /config → 更新配置
 */
export function registerConfigHandlers(
  router: Router,
  configManager: ConfigManager,
  conversationMonitor: ConversationMonitor,
  scheduler: Scheduler,
  voiceEngine: VoiceEngine,
): void {

  // GET /config - 获取配置
  router.get('/config', async (req: HTTPRequest) => {
    try {
      const config = await configManager.getConfig();
      const aiConfig = await configManager.getAIConfig();

      let suggestedAddresses: string[] = [];
      try {
        suggestedAddresses = await songloft.plugin.getNetworkAddresses();
      } catch {}

      return jsonResponse({
        success: true,
        data: {
          server_host: config.server_host,
          conversation_monitor_enabled: config.conversation_monitor_enabled,
          voice_command_enabled: config.voice_command_enabled,
          scheduled_tasks_enabled: config.scheduled_tasks_enabled,
          timezone: config.timezone,
          force_mp3: !!config.force_mp3,
          external_search_enabled: !!config.external_search_enabled,
          external_search_url: config.external_search_url || '',
          external_search_token: config.external_search_token || '',
          external_search_sources: config.external_search_sources || [],
          external_search_playlist_id: config.external_search_playlist_id ?? '',
          external_search_timeout: config.external_search_timeout ?? 6,
          external_search_no_import: !!config.external_search_no_import,
          search_priority: normalizeSearchPriority(config.search_priority),
          extra_music_api_models: config.extra_music_api_models || [],
          indicator_light_enabled: !!config.indicator_light_enabled,
          interrupt_tts_hint_enabled: !!config.interrupt_tts_hint_enabled,
          interrupt_tts_hint_text: config.interrupt_tts_hint_text || '正在搜索，请稍候',
          conversation_poll_interval: config.conversation_poll_interval ?? 1,
          conversation_poll_debug: !!config.conversation_poll_debug,
          smart_resume_timeout: config.smart_resume_timeout ?? 30,
          max_song_index: config.max_song_index ?? 10000,
          server_host_status: getServerHostStatus(config.server_host),
          suggested_addresses: suggestedAddresses,
          ai_config: aiConfig,
          default_cover_id: config.default_cover_id,
          touchscreen_lyrics_enabled: !!config.touchscreen_lyrics_enabled,
        },
      });
    } catch (e: any) {
      return jsonResponse({ success: false, error: e.message || String(e) }, 500);
    }
  });

  // POST /config - 更新配置
  router.post('/config', async (req: HTTPRequest) => {
    try {
      const body = parseBody(req);
      const config = await configManager.getConfig();

      // 更新 server_host
      if (body.server_host !== undefined) {
        let serverHost = typeof body.server_host === 'string' ? body.server_host.trim() : '';
        if (serverHost && !serverHost.startsWith('http://') && !serverHost.startsWith('https://')) {
          serverHost = 'http://' + serverHost;
        }
        config.server_host = serverHost;
        setHostBaseUrl(serverHost);
      }

      // 更新 timezone
      if (body.timezone !== undefined) {
        config.timezone = body.timezone;
      }

      // 记录本次是否需要联动 Monitor 启停（在 saveConfig 之后再执行，
      // 保证「先保存配置、再启停监听器」，且 start() 会 await 到设备列表初始化完成）
      let monitorAction: 'start' | 'stop' | 'restart' | null = null;

      // 更新 conversation_monitor_enabled（联动 Monitor 启停）
      if (body.conversation_monitor_enabled !== undefined) {
        const enabled = !!body.conversation_monitor_enabled;
        config.conversation_monitor_enabled = enabled;
        monitorAction = enabled ? 'start' : 'stop';
      }

      // 更新 voice_command_enabled
      if (body.voice_command_enabled !== undefined) {
        const enabled = !!body.voice_command_enabled;
        config.voice_command_enabled = enabled;
        voiceEngine.setEnabled(enabled);
      }

      // 更新 force_mp3
      if (body.force_mp3 !== undefined) {
        config.force_mp3 = !!body.force_mp3;
      }

      // 更新 external_search_url
      if (body.external_search_url !== undefined) {
        config.external_search_url = typeof body.external_search_url === 'string' ? body.external_search_url.trim() : '';
      }

      // 更新 external_search_token
      if (body.external_search_token !== undefined) {
        config.external_search_token = typeof body.external_search_token === 'string' ? body.external_search_token.trim() : '';
      }

      // 更新 external_search_sources（源列表，数组顺序即优先级）
      if (body.external_search_sources !== undefined) {
        config.external_search_sources = Array.isArray(body.external_search_sources)
          ? body.external_search_sources
              .filter((s: any) => s && typeof s.url === 'string' && s.url.trim())
              .map((s: any) => ({
                id: (typeof s.id === 'string' && s.id) ? s.id : `src_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
                name: typeof s.name === 'string' ? s.name.trim() : '',
                url: s.url.trim(),
                token: typeof s.token === 'string' ? s.token.trim() : '',
                enabled: s.enabled !== false,
              }))
          : [];
      }

      // 更新 external_search_enabled
      if (body.external_search_enabled !== undefined) {
        config.external_search_enabled = !!body.external_search_enabled;
      }

      // 更新 external_search_playlist_id
      if (body.external_search_playlist_id !== undefined) {
        config.external_search_playlist_id = typeof body.external_search_playlist_id === 'string'
          ? body.external_search_playlist_id.trim()
          : String(body.external_search_playlist_id);
      }

      // 更新 external_search_timeout
      if (body.external_search_timeout !== undefined) {
        config.external_search_timeout = Math.max(3, Math.min(60, Number(body.external_search_timeout) || 6));
      }

      // 更新 external_search_no_import
      if (body.external_search_no_import !== undefined) {
        config.external_search_no_import = !!body.external_search_no_import;
      }

      // 更新 search_priority
      if (body.search_priority !== undefined) {
        config.search_priority = normalizeSearchPriority(body.search_priority);
      }

      // 更新 indicator_light_enabled
      if (body.indicator_light_enabled !== undefined) {
        config.indicator_light_enabled = !!body.indicator_light_enabled;
      }

      // 更新 touchscreen_lyrics_enabled
      if (body.touchscreen_lyrics_enabled !== undefined) {
        config.touchscreen_lyrics_enabled = !!body.touchscreen_lyrics_enabled;
      }

      // ▼ 新增这段保存逻辑：接收前端传来的值并存入 config ▼
      if (body.default_cover_id !== undefined) {
        config.default_cover_id = String(body.default_cover_id).trim();
      }

      // 更新 interrupt_tts_hint_enabled
      if (body.interrupt_tts_hint_enabled !== undefined) {
        config.interrupt_tts_hint_enabled = !!body.interrupt_tts_hint_enabled;
      }

      // 更新 interrupt_tts_hint_text
      if (body.interrupt_tts_hint_text !== undefined) {
        config.interrupt_tts_hint_text = typeof body.interrupt_tts_hint_text === 'string'
          ? body.interrupt_tts_hint_text.trim()
          : '正在搜索，请稍候';
      }

      // 更新 conversation_poll_interval（联动 Monitor 重启）
      if (body.conversation_poll_interval !== undefined) {
        const val = Math.max(1, Math.min(30, Number(body.conversation_poll_interval) || 1));
        config.conversation_poll_interval = val;
        // 仅在监听器本次未被显式关闭时才重启（避免与上面的 stop 冲突）
        if (config.conversation_monitor_enabled && monitorAction !== 'stop') {
          monitorAction = 'restart';
        }
      }

      // 更新 conversation_poll_debug（同步到 debug 模块的缓存，热路径靠它门控日志）
      if (body.conversation_poll_debug !== undefined) {
        config.conversation_poll_debug = !!body.conversation_poll_debug;
        setPollDebug(config.conversation_poll_debug);
      }

      // 更新 smart_resume_timeout
      if (body.smart_resume_timeout !== undefined) {
        config.smart_resume_timeout = Math.max(5, Math.min(120, Number(body.smart_resume_timeout) || 30));
      }

      // 更新 max_song_index
      if (body.max_song_index !== undefined) {
        config.max_song_index = Math.max(1000, Math.min(100000, Number(body.max_song_index) || 10000));
      }

      // 更新 extra_music_api_models
      if (body.extra_music_api_models !== undefined) {
        config.extra_music_api_models = Array.isArray(body.extra_music_api_models)
          ? body.extra_music_api_models
              .filter((m: any) => typeof m === 'string' && m.trim())
              .map((m: string) => m.trim().toUpperCase())
          : [];
      }

      // 更新 ai_config
      if (body.ai_config !== undefined) {
        const aiConfig = await configManager.getAIConfig();
        const newAI = body.ai_config as Record<string, unknown>;
        if (typeof newAI.enabled === 'boolean') {
          aiConfig.enabled = newAI.enabled;
        }
        if (typeof newAI.api_url === 'string') {
          aiConfig.api_url = newAI.api_url;
        }
        if (typeof newAI.api_key === 'string') {
          aiConfig.api_key = newAI.api_key;
        }
        if (typeof newAI.model === 'string') {
          aiConfig.model = newAI.model;
        }
        if (typeof newAI.timeout === 'number') {
          aiConfig.timeout = newAI.timeout;
        }
        await configManager.saveAIConfig(aiConfig);
      }

      // 更新 scheduled_tasks_enabled（联动 Scheduler 启停）
      if (body.scheduled_tasks_enabled !== undefined) {
        const enabled = !!body.scheduled_tasks_enabled;
        config.scheduled_tasks_enabled = enabled;
        if (enabled) {
          scheduler.start();
        } else {
          scheduler.stop();
        }
      }

      await configManager.saveConfig(config);

      // 配置保存后再联动监听器启停：start() 会 await 到设备列表初始化完成，
      // 之后前端请求 /conversation/status 即可拿到真实设备数量
      if (monitorAction === 'start' || monitorAction === 'restart') {
        conversationMonitor.stop();          // 先清理旧状态（含残留设备）
        await conversationMonitor.start();   // 再干净启动并等待初始化
      } else if (monitorAction === 'stop') {
        conversationMonitor.stop();
      }

      // 检查保存后的地址是否有效，附带 warning
      let warning = '';
      if (!config.server_host) {
        warning = '服务器地址为空，MIoT 智能音箱将无法播放音乐。请配置局域网 IP 地址（如 http://192.168.x.x:58091）。';
      } else if (isLoopbackAddress(config.server_host)) {
        warning = '检测到服务器地址为本地回环地址，MIoT 智能音箱将无法通过此地址访问服务器播放音乐。请使用局域网 IP 地址。';
      }

      const resp: any = { success: true };
      if (warning) {
        resp.warning = warning;
      }
      return jsonResponse(resp);
    } catch (e: any) {
      return jsonResponse({ success: false, error: e.message || String(e) }, 500);
    }
  });

  // GET /search-providers - 获取可用的外部搜索提供方列表
  router.get('/search-providers', async (_req: HTTPRequest) => {
    const knownProviders = [
      { id: 'ytdlp', name: 'yt-dlp', entryPath: 'ytdlp', searchPath: '/api/search/topone' },
      { id: 'bili', name: '哔哩音乐', entryPath: 'bili', searchPath: '/api/search/topone' },
      { id: 'subsonic', name: 'Subsonic', entryPath: 'subsonic', searchPath: '/api/search/topone' },
    ];

    interface HostPlugin {
      entry_path: string;
      status: string;
    }

    let installedPlugins: HostPlugin[] = [];
    try {
      const data = await callHostAPI<{ plugins: HostPlugin[] }>('GET', '/api/v1/jsplugins/');
      installedPlugins = data.plugins || [];
    } catch (e) {
      songloft.log.warn('[config] Failed to fetch plugin list: ' + String(e));
    }

    const providers = knownProviders.map(p => {
      const found = installedPlugins.find(ip => ip.entry_path === p.entryPath);
      return {
        id: p.id,
        name: p.name,
        url: `/api/v1/jsplugin/${p.entryPath}${p.searchPath}`,
        installed: !!found,
        active: found?.status === 'active',
      };
    });

    return jsonResponse({ providers });
  });
}
