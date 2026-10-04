import { createRouter } from '@songloft/plugin-sdk';
import type { HTTPRequest, HTTPResponse, WebSocketRequest, InboundWebSocket } from '@songloft/plugin-sdk';
import { ConfigManager } from './config/manager';
import { AccountManager } from './account/manager';
import { AuthService } from './auth/service';
import { MinaService } from './service/service';
import { PlaylistManagerMap } from './player/manager';
import { GroupCoordinator } from './group/coordinator';
import { Scheduler } from './schedule/scheduler';
import { TaskExecutor } from './schedule/executor';
import { ConversationMonitor } from './conversation/monitor';
import { VoiceEngine } from './voicecmd/engine';
import { AIAnalyzer } from './voicecmd/ai_analyzer';
import { getDefaultVoiceCommands } from './voicecmd/engine';
import { IndexingManager } from './indexing/manager';
import { MemoryService } from './memory';
import { DLNAReceiver } from './receiver/receiver';

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
import { registerGroupHandlers } from './handlers/group';
import { registerSearchProviderComm } from './handlers/search_registry';
import { setHostBaseUrl } from './utils/http';
import { setDebugLog } from './utils/debug';
import { initStatusStream, handleStatusWebSocket, WS_STATUS_PATH } from './ws/status-stream';
import { initConversationStream, handleConversationWebSocket, WS_CONVERSATION_PATH } from './ws/conversation-stream';

const router = createRouter();

// server_host 失效自检：它是静态手动值，服务器换 IP（DHCP）/重启后不会自动刷新。
// 若非回环却不在本机当前网卡地址中，音箱将被指向拉不到的旧地址 → 无声（songloft-org/songloft#405）。
async function warnIfServerHostStale(serverHost: string): Promise<void> {
  try {
    const host = (serverHost || '').trim().toLowerCase();
    if (!host) return;
    // 回环由设置页 status 单独提示，这里只查「失效但非回环」的旧地址
    if (host.startsWith('http://localhost') || host.startsWith('http://127.')) return;

    const localAddrs = await songloft.plugin.getNetworkAddresses();
    // Older hosts and Docker-only network namespaces may return null when no
    // non-Docker interface is available. This diagnostic must never block init.
    if (!Array.isArray(localAddrs)) {
      songloft.log.warn('[URLBuilder] server_host 失效自检跳过（本机没有可用网卡地址）');
      return;
    }
    const validAddrs = localAddrs.filter((addr): addr is string => typeof addr === 'string');
    const norm = (s: string) => s.trim().toLowerCase().replace(/\/$/, '');
    if (!validAddrs.some(a => norm(a) === norm(host))) {
      songloft.log.warn('[URLBuilder] server_host=' + serverHost + ' 不在当前本机网卡地址中（' + validAddrs.join(', ') + '）；服务器可能已更换 IP 或音箱不在同一网段，音箱将无法访问，请在设置页重新选择地址');
    }
  } catch (e) {
    songloft.log.warn('[URLBuilder] server_host 失效自检失败（无法获取本机网卡地址）: ' + String(e));
  }
}

// 全局服务实例
let configManager: ConfigManager;
let accountManager: AccountManager;
let authService: AuthService;
let minaService: MinaService;
let playlistManagerMap: PlaylistManagerMap;
let groupCoordinator: GroupCoordinator;
let scheduler: Scheduler;
let conversationMonitor: ConversationMonitor;
let voiceEngine: VoiceEngine;
let indexingManager: IndexingManager;
let memoryService: MemoryService;
let dlnaReceiver: DLNAReceiver;

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
  groupCoordinator = new GroupCoordinator(playlistManagerMap, minaService, configManager);
  // 加载分组快照，使 PlaylistManagerMap 能同步把分组设备解析到共享 manager（多房间共用一套播放列表）
  await playlistManagerMap.refreshGroups();
  dlnaReceiver = new DLNAReceiver(configManager, minaService, playlistManagerMap);
  await dlnaReceiver.init();
  memoryService = new MemoryService();

  // 注入状态推送依赖（WebSocket 订阅端点 /status/ws 使用）
  initStatusStream(playlistManagerMap, minaService);

  // 从配置中读取服务器地址并设置音箱播放 URL 基础地址
  const pluginConfig = await configManager.getConfig();
  if (pluginConfig.server_host) {
    setHostBaseUrl(pluginConfig.server_host);
    songloft.log.info('音箱播放 URL 基础地址已设置: ' + pluginConfig.server_host);
    await warnIfServerHostStale(pluginConfig.server_host);
  }

  // 同步调试日志开关到 debug 模块缓存（热路径同步读取，不能每 tick await 配置）
  setDebugLog(pluginConfig.debug_log_enabled ?? false);

  conversationMonitor = new ConversationMonitor(accountManager, configManager);
  // 注入对话推送依赖（WebSocket 订阅端点 /conversation/ws 使用）
  initConversationStream(conversationMonitor);
  voiceEngine = new VoiceEngine(configManager, accountManager, minaService, playlistManagerMap, indexingManager, new AIAnalyzer(), memoryService, groupCoordinator);

  const executor = new TaskExecutor(configManager, accountManager, minaService, playlistManagerMap, indexingManager, conversationMonitor, groupCoordinator, voiceEngine);
  scheduler = new Scheduler(configManager, executor);

  // 如果配置中没有语音口令配置，写入默认配置；已有配置时补充新增的默认口令类型
  const existingCommands = await configManager.getVoiceCommands();
  if (!existingCommands || existingCommands.length === 0) {
    const defaultCommands = getDefaultVoiceCommands();
    await configManager.saveVoiceCommands(defaultCommands);
    songloft.log.info(`[VoiceCmd] Initialized ${defaultCommands.length} default voice commands`);
  } else {
    const defaultCommands = getDefaultVoiceCommands();
    const existingTypes = new Set(existingCommands.map(c => c.type + (c.param || '')));
    const missing = defaultCommands.filter(c => !existingTypes.has(c.type + (c.param || '')));
    if (missing.length > 0) {
      const merged = [...existingCommands, ...missing];
      await configManager.saveVoiceCommands(merged);
      songloft.log.info(`[VoiceCmd] Merged ${missing.length} new default voice commands: ${missing.map(c => c.type).join(', ')}`);
    }
  }

  // 注册所有路由
  registerAccountHandlers(router, accountManager, authService);
  registerAuthHandlers(router, authService, accountManager);
  registerDeviceHandlers(router, minaService, accountManager, conversationMonitor, groupCoordinator);
  registerPlaylistHandlers(router, playlistManagerMap, minaService, configManager);
  registerConfigHandlers(router, configManager, conversationMonitor, scheduler, voiceEngine, memoryService);
  registerConversationHandlers(router, conversationMonitor, configManager);
  registerScheduleHandlers(router, scheduler, configManager);
  registerVoiceCommandHandlers(router, configManager, accountManager, voiceEngine);
  registerIndexingHandlers(router, indexingManager);
  registerMemoryHandlers(router, memoryService, configManager);
  registerLyricHandlers(router);
  registerGroupHandlers(router, configManager, playlistManagerMap);

  // 注册「搜索源候选」的插件间通信入口（其他插件经 comm 自注册）
  registerSearchProviderComm(configManager);

  // 自动登录 + 启动后台服务（异步，不阻塞插件初始化）
  authService.autoLoginAll().catch(e => {
    songloft.log.error('autoLoginAll failed: ' + String(e));
  });
  // 异步刷新索引，不阻塞插件初始化
  setTimeout(() => {
    indexingManager.refresh().then(async () => {
      // 必须等歌单歌曲缓存加载完再恢复：临时歌手歌单靠 findSongsByArtist 重建，
      // 而 refresh() resolve 时缓存还在后台加载，结果必然为空——旧代码因此永远恢复不了，
      // 还会把 pendingTempArtist 清空（songloft-org/songloft-plugin-miot#62）。
      // 不在语音热路径上，等待预算给大。索引本身没建起来（宿主 API 不可用）时不必白等。
      if (indexingManager.isIndexReady()) {
        await indexingManager.waitForPlaylistCache(30_000);
      }
      await playlistManagerMap.restoreTempPlaylists(indexingManager).catch(e => {
        songloft.log.warn('restoreTempPlaylists failed: ' + String(e));
      });
    }).catch(e => {
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
  await dlnaReceiver?.close();
  scheduler?.stop();
  conversationMonitor?.stop();
  playlistManagerMap?.cleanup();
  authService?.cleanup();
  songloft.log.info('MIoT 智能音箱插件已停止');
}

// 后端热重载（自动更新）前的忙碌探测：正在播放时返回 busy，让后端把重载推迟到空闲，
// 避免自动更新在播放中途打断播放。手动更新不受影响，仍然立即重载。
//
// 必须返回 JSON **字符串**：宿主的 ExecuteJS 用 fmt.Sprintf("%v") 字符串化返回值，
// 直接返回对象会变成 Go 的 map 文本（map[busy:true ...]），后端解析不出来。
async function onQueryBusy(): Promise<string> {
  try {
    const reason = dlnaReceiver?.busyReason() || playlistManagerMap?.busyReason() || '';
    return JSON.stringify({ busy: reason !== '', reason });
  } catch (e) {
    // 探测本身出错时按空闲处理，不能因为探测失败就永久阻塞更新
    songloft.log.warn('[onQueryBusy] 忙碌探测失败，按空闲处理: ' + String(e));
    return JSON.stringify({ busy: false, reason: '' });
  }
}

async function onHTTPRequest(req: HTTPRequest): Promise<HTTPResponse> {
  if (req.path === '/receiver/config' || req.path.startsWith('/dlna/')) return dlnaReceiver.handle(req);
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
globalThis.onQueryBusy = onQueryBusy;
globalThis.onHTTPRequest = onHTTPRequest;
globalThis.onWebSocket = onWebSocket;
