import { createRouter } from '@songloft/plugin-sdk';
import type { HTTPRequest, HTTPResponse, WebSocketRequest, InboundWebSocket } from '@songloft/plugin-sdk';
import { ConfigManager } from './config/manager';
import { AccountManager } from './account/manager';
import { AuthService } from './auth/service';
import { MinaService } from './service/service';
import { PlaylistManagerMap } from './player/manager';
import { Scheduler } from './schedule/scheduler';
import { TaskExecutor } from './schedule/executor';
import { ConversationMonitor } from './conversation/monitor';
import { VoiceEngine } from './voicecmd/engine';
import { AIAnalyzer } from './voicecmd/ai_analyzer';
import { getDefaultVoiceCommands } from './voicecmd/engine';
import { IndexingManager } from './indexing/manager';
import { MemoryService } from './memory';

// 导入所有handler注册函数
import { registerAccountHandlers } from './handlers/account';
import { registerAuthHandlers } from './handlers/auth';
import { registerDeviceHandlers } from './handlers/device';
import { registerPlaylistHandlers } from './handlers/playlist';
import { registerConfigHandlers } from './handlers/config';
import { registerConversationHandlers } from './handlers/conversation';
import { registerScheduleHandlers } from './handlers/schedule';
import { registerVoiceCommandHandlers } from './handlers/voice_command';
import { registerIndexingHandlers } from './handlers/indexing';
import { registerMemoryHandlers } from './handlers/memory';
import { registerLyricHandlers } from './handlers/lyric';
import { registerSearchProviderComm } from './handlers/search_registry';
import { setHostBaseUrl } from './utils/http';
import { setPollDebug } from './utils/debug';
import { initStatusStream, handleStatusWebSocket, WS_STATUS_PATH } from './ws/status-stream';
import { initConversationStream, handleConversationWebSocket, WS_CONVERSATION_PATH } from './ws/conversation-stream';

const router = createRouter();

// 全局服务实例
let configManager: ConfigManager;
let accountManager: AccountManager;
let authService: AuthService;
let minaService: MinaService;
let playlistManagerMap: PlaylistManagerMap;
let scheduler: Scheduler;
let conversationMonitor: ConversationMonitor;
let voiceEngine: VoiceEngine;
let indexingManager: IndexingManager;
let memoryService: MemoryService;

async function onInit(): Promise<void> {
  songloft.log.info('MIoT 智能音箱插件初始化...');

  // 初始化管理器
  configManager = new ConfigManager();
  accountManager = new AccountManager(configManager);
  await accountManager.init();

  indexingManager = new IndexingManager(configManager);
  authService = new AuthService(configManager, accountManager);
  minaService = new MinaService(accountManager, configManager);
  playlistManagerMap = new PlaylistManagerMap(minaService, configManager);
  memoryService = new MemoryService();

  // 注入状态推送依赖（WebSocket 订阅端点 /status/ws 使用）
  initStatusStream(playlistManagerMap, minaService);

  // 从配置中读取服务器地址并设置音箱播放 URL 基础地址
  const pluginConfig = await configManager.getConfig();
  if (pluginConfig.server_host) {
    setHostBaseUrl(pluginConfig.server_host);
    songloft.log.info('音箱播放 URL 基础地址已设置: ' + pluginConfig.server_host);
  }

  // 同步轮询调试日志开关到 debug 模块缓存（热路径同步读取，不能每 tick await 配置）
  setPollDebug(pluginConfig.conversation_poll_debug ?? false);

  conversationMonitor = new ConversationMonitor(accountManager, configManager);
  // 注入对话推送依赖（WebSocket 订阅端点 /conversation/ws 使用）
  initConversationStream(conversationMonitor);
  voiceEngine = new VoiceEngine(configManager, accountManager, minaService, playlistManagerMap, indexingManager, new AIAnalyzer(), memoryService);

  const executor = new TaskExecutor(configManager, accountManager, minaService, playlistManagerMap, indexingManager, conversationMonitor);
  scheduler = new Scheduler(configManager, executor);

  // 如果配置中没有语音口令配置，写入默认配置
  const existingCommands = await configManager.getVoiceCommands();
  if (!existingCommands || existingCommands.length === 0) {
    const defaultCommands = getDefaultVoiceCommands();
    await configManager.saveVoiceCommands(defaultCommands);
    songloft.log.info(`[VoiceCmd] Initialized ${defaultCommands.length} default voice commands`);
  }

  // 注册所有路由
  registerAccountHandlers(router, accountManager, authService);
  registerAuthHandlers(router, authService, accountManager);
  registerDeviceHandlers(router, minaService, accountManager, conversationMonitor);
  registerPlaylistHandlers(router, playlistManagerMap, minaService, configManager);
  registerConfigHandlers(router, configManager, conversationMonitor, scheduler, voiceEngine, memoryService);
  registerConversationHandlers(router, conversationMonitor, configManager);
  registerScheduleHandlers(router, scheduler, configManager);
  registerVoiceCommandHandlers(router, configManager, voiceEngine);
  registerIndexingHandlers(router, indexingManager);
  registerMemoryHandlers(router, memoryService, configManager);
  registerLyricHandlers(router);

  // 注册「搜索源候选」的插件间通信入口（其他插件经 comm 自注册）
  registerSearchProviderComm(configManager);

  // 自动登录 + 启动后台服务（异步，不阻塞插件初始化）
  authService.autoLoginAll().catch(e => {
    songloft.log.error('autoLoginAll failed: ' + String(e));
  });
  // 异步刷新索引，不阻塞插件初始化
  setTimeout(() => {
    indexingManager.refresh().catch(e => {
      songloft.log.error('indexingManager.refresh failed: ' + String(e));
    });
  }, 100);

  // 注册 VoiceEngine 回调（独立于启停生命周期）
  conversationMonitor.registerCallback('voice_engine', (msg) => {
    return voiceEngine.handleMessage(msg);
  });

  // 根据配置启动后台服务
  if (pluginConfig.scheduled_tasks_enabled) {
    scheduler.start();
  }
  if (pluginConfig.conversation_monitor_enabled) {
    conversationMonitor.start().catch(e => {
      songloft.log.error('conversationMonitor.start failed: ' + String(e));
    });
  }
  if (pluginConfig.voice_command_enabled) {
    voiceEngine.setEnabled(true);
  }

  songloft.log.info('MIoT 智能音箱插件初始化完成');
}

async function onDeinit(): Promise<void> {
  songloft.log.info('MIoT 智能音箱插件停止...');
  scheduler?.stop();
  conversationMonitor?.stop();
  playlistManagerMap?.cleanup();
  authService?.cleanup();
  songloft.log.info('MIoT 智能音箱插件已停止');
}

async function onHTTPRequest(req: HTTPRequest): Promise<HTTPResponse> {
  return await router.handle(req);
}

// 入站 WebSocket：播放状态推送订阅（/status/ws）+ 对话记录推送订阅（/conversation/ws）
async function onWebSocket(req: WebSocketRequest, socket: InboundWebSocket): Promise<void> {
  if (req.path === WS_STATUS_PATH) {
    await handleStatusWebSocket(req, socket);
    return;
  }
  if (req.path === WS_CONVERSATION_PATH) {
    await handleConversationWebSocket(req, socket);
    return;
  }
  await socket.close(1008, 'unknown websocket path');
}

// 暴露为全局（QuickJS 需要显式声明）。SDK 0.8+ 已正式支持 async 签名。
globalThis.onInit = onInit;
globalThis.onDeinit = onDeinit;
globalThis.onHTTPRequest = onHTTPRequest;
globalThis.onWebSocket = onWebSocket;
