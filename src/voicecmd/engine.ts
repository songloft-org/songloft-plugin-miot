// MIoT 智能音箱插件 - 语音口令引擎
// 翻译自 Go 源码: plugins/songloft-plugin-xiaomi/voicecmd/engine.go
// 匹配用户语音指令并执行对应动作（播放歌单/歌曲、切歌、停止、音量、播放模式）

/// <reference types="@songloft/plugin-sdk" />

import { ConfigManager } from '../config/manager';
import { AccountManager } from '../account/manager';
import { MinaService } from '../service/service';
import { PlaylistManagerMap } from '../player/manager';
import { IndexingManager } from '../indexing/manager';
import { URLBuilder } from '../player/url_builder';
import { AIAnalyzer } from './ai_analyzer';
import { OnlineSearcher } from './online_searcher';
import { updateDeviceStatusCache } from '../handlers/playlist';
import { MemoryService } from '../memory';
import type { PlaylistManager } from '../player/manager';
import type { SongLocation } from '../indexing/manager';
import type { MemoryRecord } from '../memory';
import type { OnlineSearchResult } from './online_searcher';
import type { ConversationMessage, VoiceCommand, PlayMode, AIAnalysisResult, SearchPriority } from '../types';

// ===== 类型定义 =====

/** 口令匹配结果 */
interface MatchResult {
  command: VoiceCommand;
  keyword: string;
  argument: string;
}

interface StandaloneSongCandidate {
  id: number;
  url: string;
  title: string;
  artist: string;
}

interface PlayedSong {
  songName: string;
  artist: string;
  songId?: number;
  playlistId?: number;
  playlistName?: string;
  songIndex?: number;
}

type SongSearchCandidate =
  | { source: 'local_index'; loc: SongLocation }
  | { source: 'remote_song'; song: StandaloneSongCandidate }
  | { source: 'external_search'; song: OnlineSearchResult };

/** 口令测试结果（供设置页「口令测试」展示） */
export interface CommandTestResult {
  /** 是否匹配到口令 */
  matched: boolean;
  /** 匹配来源：ai 分析 / 规则匹配 / 未匹配 */
  source: 'ai' | 'rule' | 'none';
  /** AI 分析结果（AI 启用时带回，无论是否采用） */
  ai?: { action: string; confidence: string; params: any } | null;
  /** 命令类型（play_song/play_playlist/...） */
  commandType?: string;
  /** 命中的关键词（规则匹配时） */
  keyword?: string;
  /** 口令后提取出的搜索参数 */
  argument?: string;
  /** 搜索预览：将命中的歌曲/歌单 */
  search?: { kind: 'song' | 'playlist'; found: boolean; detail: string } | null;
  /** 是否已实际执行（投放到设备） */
  executed: boolean;
  /** 附加说明 */
  note?: string;
}

/** 口令类型优先级（数字越小优先级越高） */
const COMMAND_PRIORITY: Record<string, number> = {
  'play_song': 1,
  'play_playlist': 2,
  'set_play_mode': 3,
  'set_volume': 4,
  'next': 5,
  'previous': 6,
  'stop': 7,
};

/** 跳字模糊匹配：关键词中间最多允许插入的字符数 */
const FUZZY_MAX_GAP = 4;

/** 跳字模糊匹配：关键词最小 rune 长度（2 字以内控制词如"停止/切歌"不参与，避免误触发） */
const FUZZY_MIN_KEYWORD_LEN = 3;

/** 语音请求到达时给后台索引刷新的短等待窗口。 */
const INDEX_READY_WAIT_MS = 5000;

/** 本地独立歌曲 URL 健康检查超时（ms），利用 TTS 播报窗口期异步验证，不增加用户感知延迟。 */
const URL_HEALTH_CHECK_TIMEOUT_MS = 3000;

const FIXED_CONTROL_COMMAND_TYPES = new Set(['set_play_mode', 'set_volume', 'next', 'previous', 'stop']);
const SEARCH_COMMAND_TYPES = new Set(['play_song', 'play_playlist']);
const BUILTIN_STOP_KEYWORDS = ['暂停播放', '停止播放', '暂停音乐', '停一下', 'pause', 'stop'];

/**
 * 有界跳字子序列匹配：在 query 的 rune 数组中按序查找关键词，允许中间插入有限字符。
 *
 * 对每个 `=== kwRunes[0]` 的位置作锚点各自贪心向后匹配（避免"最左锚点"漏掉更紧凑的匹配），
 * 命中后 inserted = (lastIdx - firstIdx + 1) - kwLen，仅当 inserted <= maxGap 视为候选，
 * 取 inserted 最小者返回。用于口令精确匹配零命中时的兜底（如"我想听" ⊇ "我今天想听"）。
 *
 * @returns 最佳候选的 { lastIdx, inserted }，无候选返回 null
 */
function fuzzySubseqMatch(qRunes: string[], kwRunes: string[], maxGap: number): { lastIdx: number; inserted: number } | null {
  const kwLen = kwRunes.length;
  if (kwLen < FUZZY_MIN_KEYWORD_LEN) return null;
  if (qRunes.length < kwLen) return null;

  let best: { lastIdx: number; inserted: number } | null = null;

  for (let start = 0; start <= qRunes.length - kwLen; start++) {
    if (qRunes[start] !== kwRunes[0]) continue;

    // 从 start 起贪心按序匹配关键词其余字符
    let ki = 1;
    let qi = start + 1;
    while (qi < qRunes.length && ki < kwLen) {
      if (qRunes[qi] === kwRunes[ki]) ki++;
      qi++;
    }
    if (ki < kwLen) continue; // 关键词未完整命中

    const lastIdx = qi - 1;
    const inserted = (lastIdx - start + 1) - kwLen;
    if (inserted > maxGap) continue;

    if (best === null || inserted < best.inserted) {
      best = { lastIdx, inserted };
    }
  }

  return best;
}

// ===== 默认口令配置 =====

/**
 * 获取默认语音口令配置（12 条）
 * 翻译自 Go 源码: plugins/songloft-plugin-xiaomi/config/manager.go GetDefaultVoiceCommands()
 */
export function getDefaultVoiceCommands(): VoiceCommand[] {
  return [
    { type: 'play_playlist', keywords: ['播放歌单', '放歌单', '播放列表'], enabled: true },
    { type: 'play_song', keywords: ['播放歌曲', '放歌曲', '我想听'], enabled: true },
    { type: 'set_play_mode', keywords: ['随机播放', '随机模式'], param: 'random', enabled: true },
    { type: 'set_play_mode', keywords: ['单曲循环', '循环播放这首'], param: 'single', enabled: true },
    { type: 'set_play_mode', keywords: ['列表循环', '循环播放'], param: 'loop', enabled: true },
    { type: 'set_play_mode', keywords: ['顺序播放'], param: 'order', enabled: true },
    { type: 'set_volume', keywords: ['设置音量', '音量调到', '音量', '声音', '声音调到'], param: 'absolute', enabled: true },
    { type: 'set_volume', keywords: ['大声一点', '声音大一点', '音量大一点'], param: 'up', enabled: true },
    { type: 'set_volume', keywords: ['小声一点', '声音小一点', '音量小一点'], param: 'down', enabled: true },
    { type: 'next', keywords: ['下一首', '切歌', '换一首', '下一曲'], enabled: true },
    { type: 'previous', keywords: ['上一首', '上一曲'], enabled: true },
    { type: 'stop', keywords: ['暂停播放', '停止播放', '暂停音乐', '停一下', 'pause', 'stop', '停止', '别播了', '关掉音乐', '关机', '关闭'], enabled: true },
  ];
}

// ===== VoiceEngine =====

/**
 * VoiceEngine - 语音口令引擎
 * 接收对话消息，匹配已配置的口令关键词，执行对应动作
 */
export class VoiceEngine {
  private configManager: ConfigManager;
  private accountManager: AccountManager;
  private minaService: MinaService;
  private playlistManagerMap: PlaylistManagerMap;
  private indexingManager: IndexingManager;
  private aiAnalyzer: AIAnalyzer;
  private onlineSearcher: OnlineSearcher;
  private memoryService: MemoryService;
  private memoryInitialized: boolean = false;
  private enabled: boolean = false;
  private resumeTimer: any = null;
  private resumeCancelled: boolean = false;

  constructor(
    configManager: ConfigManager,
    accountManager: AccountManager,
    minaService: MinaService,
    playlistManagerMap: PlaylistManagerMap,
    indexingManager: IndexingManager,
    aiAnalyzer?: AIAnalyzer,
    memoryService?: MemoryService,
  ) {
    this.configManager = configManager;
    this.accountManager = accountManager;
    this.minaService = minaService;
    this.playlistManagerMap = playlistManagerMap;
    this.indexingManager = indexingManager;
    this.aiAnalyzer = aiAnalyzer || new AIAnalyzer();
    this.onlineSearcher = new OnlineSearcher(configManager);
    this.memoryService = memoryService || new MemoryService();
  }

  // ===== 公开方法 =====

  /** 启用/禁用语音口令引擎 */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    songloft.log.info(`[VoiceEngine] ${enabled ? 'Enabled' : 'Disabled'}`);
  }

  /** 是否已启用 */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * 处理新对话消息（由 ConversationMonitor 回调触发）
   * @param msg - 对话消息
   */
  async handleMessage(msg: ConversationMessage): Promise<void> {
    if (!this.enabled) {
      return;
    }

    // 从 AskMessage 中提取 query
    const query = this.extractQuery(msg);
    if (!query || query.trim() === '') {
      return;
    }

    // 找到设备对应的 accountId
    const accountId = await this.findAccountForDevice(msg.device_id);
    if (!accountId) {
      songloft.log.warn(`[VoiceEngine] No account found for device: ${msg.device_id}`);
      return;
    }

    // 固定控制命令优先，避免 memory 或 AI 覆盖切歌、停止、音量、播放模式等操作。
    songloft.log.info(`[VoiceEngine] [Rule] Matching fixed control query="${query}"`);
    const builtinStopResult = this.matchBuiltinStopCommand(query);
    const fixedResult = builtinStopResult ?? await this.matchCommand(query, FIXED_CONTROL_COMMAND_TYPES);
    if (fixedResult) {
      songloft.log.info(`[VoiceEngine] [Rule] → Matched fixed control: type=${fixedResult.command.type} keyword="${fixedResult.keyword}" argument="${fixedResult.argument}"`);
      await this.executeCommand(fixedResult, accountId, msg.device_id);
      return;
    }

    const pluginConfig = await this.configManager.getConfig();
    const memoryEnabled = pluginConfig.voice_memory_enabled;
    this.memoryService.setMaxRecords(pluginConfig.voice_memory_max_records);

    if (memoryEnabled) {
      try {
        const memoryHandled = await this.tryHandleMemory(query, accountId, msg.device_id);
        if (memoryHandled) {
          return;
        }
      } catch (error) {
        songloft.log.warn('[VoiceMemory] error fallback: ' + String(error));
      }
    } else {
      songloft.log.info('[VoiceMemory] disabled');
    }

    // 歌曲/歌单规则匹配
    songloft.log.info(`[VoiceEngine] [Rule] Matching search query="${query}"`);
    const result = await this.matchCommand(query, SEARCH_COMMAND_TYPES);
    if (result) {
      songloft.log.info(`[VoiceEngine] [Rule] → Matched search: type=${result.command.type} keyword="${result.keyword}" argument="${result.argument}"`);

      // 执行口令
      const playedSong = await this.executeCommand(result, accountId, msg.device_id);
      if (memoryEnabled && result.command.type === 'play_song' && playedSong) {
        this.queueMemorySuccess(query, playedSong);
      }
      return;
    }

    songloft.log.info(`[VoiceEngine] [Rule] No search match found`);

    // AI 兜底（如果启用）
    const aiConfig = await this.configManager.getAIConfig();
    if (aiConfig.enabled) {
      songloft.log.info(`[VoiceEngine] [AI] Analyzing query="${query}"`);
      const aiResult = await this.aiAnalyzer.analyze(query, aiConfig);
      if (aiResult) {
        songloft.log.info(`[VoiceEngine] [AI] Done: action=${aiResult.action} confidence=${aiResult.confidence} params=${JSON.stringify(aiResult.params)}`);
        if (aiResult.confidence === 'high' && aiResult.action !== 'unknown') {
          songloft.log.info(`[VoiceEngine] [AI] → Executing fallback (high confidence, action=${aiResult.action})`);
          const playedSong = await this.executeAIResult(aiResult, accountId, msg.device_id);
          if (memoryEnabled && aiResult.action === 'play_song' && playedSong) {
            this.queueMemorySuccess(query, playedSong);
          }
          return;
        }
        songloft.log.info(`[VoiceEngine] [AI] → No fallback execution (action=${aiResult.action}, confidence=${aiResult.confidence})`);
      } else {
        songloft.log.info(`[VoiceEngine] [AI] → No fallback execution (analyze returned null)`);
      }
    }

    // 任何语音交互都会唤醒音箱并打断 URL 播放。
    // 立即挂起定时器（防止 AI 响应期间触发切歌），等小爱说完后重新推送歌曲 URL。
    const pm = this.playlistManagerMap.get(accountId, msg.device_id);
    if (pm && pm.isPlaying()) {
      pm.suspendForVoiceInteraction();
      songloft.log.info('[VoiceEngine] Unmatched command while playing, scheduling smart resume');
      this.scheduleSmartResume(pm, accountId, msg.device_id);
    }
  }

  private async ensureMemoryInitialized(): Promise<void> {
    if (this.memoryInitialized) return;
    if (this.memoryService.isInitialized()) {
      this.memoryInitialized = true;
      return;
    }
    await this.memoryService.init();
    this.memoryInitialized = this.memoryService.isInitialized();
  }

  private async tryHandleMemory(query: string, accountId: string, deviceId: string): Promise<boolean> {
    try {
      await this.ensureMemoryInitialized();
      if (!this.memoryInitialized) {
        songloft.log.info(`[VoiceMemory] miss query="${query}" reason="memory service not initialized"`);
        return false;
      }

      const record = this.memoryService.findByQuery(query);
      if (!record) {
        songloft.log.info(`[VoiceMemory] miss query="${query}"`);
        return false;
      }

      if (record.type !== 'play_song') {
        songloft.log.info(`[VoiceMemory] miss query="${query}" reason="unsupported type=${record.type}"`);
        return false;
      }

      const playedSong = await this.executeMemorySong(record, query, accountId, deviceId);
      if (!playedSong) {
        void this.memoryService.recordFailure(query).catch(error => {
          songloft.log.warn('[VoiceMemory] error fallback: record failure failed: ' + String(error));
        });
        songloft.log.warn(`[VoiceMemory] error fallback: hit could not be played id=${record.id}`);
        return false;
      }

      songloft.log.info(`[VoiceMemory] hit query="${query}" song="${playedSong.songName}" artist="${playedSong.artist}"`);
      this.queueMemorySuccess(query, playedSong);
      return true;
    } catch (error) {
      songloft.log.warn('[VoiceMemory] error fallback: ' + String(error));
      return false;
    }
  }

  private async executeMemorySong(record: MemoryRecord, query: string, accountId: string, deviceId: string): Promise<PlayedSong | null> {
    const songName = record.songName || query;
    const searchTerm = record.artist ? `${songName} ${record.artist}` : songName;

    if (typeof record.playlistId === 'number' && typeof record.songIndex === 'number') {
      const pm = await this.prepareMemoryPlayback(accountId, deviceId);
      const loc: SongLocation = {
        songId: record.songId,
        playlistId: record.playlistId,
        playlistName: record.playlistName || 'memory',
        songIndex: record.songIndex,
        songTitle: songName,
        artist: record.artist || '',
      };
      const playedLoc = await this.playIndexedSong(loc, pm, searchTerm, songName, accountId, deviceId);
      return playedLoc ? this.playedSongFromLocation(playedLoc) : null;
    }

    if (typeof record.songId === 'number') {
      try {
        const song = await songloft.songs.getById(record.songId);
        if (!song || !song.url) {
          songloft.log.warn(`[VoiceMemory] error fallback: songId not playable id=${record.songId}`);
          return null;
        }
        await this.prepareMemoryPlayback(accountId, deviceId);
        const standalone = {
          id: song.id,
          url: song.url,
          title: song.title || songName,
          artist: song.artist || record.artist || '',
        };
        const played = await this.playStandaloneSong(standalone, accountId, deviceId);
        return played ? {
          songId: standalone.id,
          songName: standalone.title,
          artist: standalone.artist,
        } : null;
      } catch (error) {
        songloft.log.warn('[VoiceMemory] error fallback: get song by id failed: ' + String(error));
        return null;
      }
    }

    if (record.songName) {
      const playedSong = await this.executePlaySong(record.songName, accountId, deviceId, record.artist);
      return playedSong;
    }

    songloft.log.warn(`[VoiceMemory] error fallback: record has no playable id id=${record.id}`);
    return null;
  }

  private queueMemorySuccess(query: string, song: PlayedSong): void {
    songloft.log.info(`[VoiceMemory] recordSuccess queued query="${query}" song="${song.songName}"`);
    void this.memoryService.recordSuccess({
      query,
      type: 'play_song',
      songId: song.songId,
      songName: song.songName,
      artist: song.artist,
      playlistId: song.playlistId,
      playlistName: song.playlistName,
      songIndex: song.songIndex,
    }).then(saved => {
      if (saved) {
        songloft.log.info(`[VoiceMemory] recordSuccess done query="${query}"`);
      } else {
        songloft.log.warn(`[VoiceMemory] recordSuccess failed query="${query}" reason="save returned false"`);
      }
    }).catch(error => {
      songloft.log.warn(`[VoiceMemory] recordSuccess failed query="${query}" error=${String(error)}`);
    });
  }

  private async prepareMemoryPlayback(accountId: string, deviceId: string): Promise<PlaylistManager> {
    const pm = await this.playlistManagerMap.getOrCreate(accountId, deviceId);
    this.cancelPendingResume();
    pm.prepareForNewPlayback();

    try {
      await this.minaService.stopPlay(accountId, deviceId);
    } catch (e) {
      songloft.log.warn('[VoiceMemory] error fallback: failed to interrupt broadcast: ' + String(e));
    }

    return pm;
  }

  /**
   * 测试口令：模拟收到一条语音指令，走现有 AI/规则诊断 + 执行逻辑，
   * 并返回诊断信息（匹配到的口令、搜索到的歌曲/歌单、是否执行）供设置页展示。
   * 与 handleMessage 不同：不经过 memory 和固定命令优先分支，且 query 直接给定、忽略引擎启停状态。
   *
   * @param query - 模拟的用户语音文本
   * @param deviceId - 目标设备（实际投放到该设备）
   * @param accountId - 可选，缺省时按 deviceId 反查
   */
  async testCommand(query: string, deviceId: string, accountId?: string): Promise<CommandTestResult> {
    const testStart = Date.now();
    const q = (query || '').trim();
    songloft.log.info(`[VoiceEngine] [Test] start query="${q}" deviceId=${deviceId}`);
    if (!q) {
      return { matched: false, source: 'none', executed: false, note: '查询为空' };
    }

    let acc = accountId;
    if (!acc) {
      acc = (await this.findAccountForDevice(deviceId)) || undefined;
    }
    if (!acc || !deviceId) {
      return { matched: false, source: 'none', executed: false, note: '未找到设备对应的账号，请先选择有效设备' };
    }

    // AI 路径（与 handleMessage 一致：高置信度且识别到有效 action 才执行）
    const aiConfig = await this.configManager.getAIConfig();
    if (aiConfig.enabled) {
      const aiStart = Date.now();
      const aiResult = await this.aiAnalyzer.analyze(q, aiConfig);
      songloft.log.info(`[VoiceEngine] [Test] AI analyze done in ${Date.now() - aiStart}ms → ${aiResult ? `action=${aiResult.action} confidence=${aiResult.confidence}` : 'null'}`);
      if (aiResult && aiResult.confidence === 'high' && aiResult.action !== 'unknown') {
        const search = await this.previewForAI(aiResult);
        const execStart = Date.now();
        await this.executeAIResult(aiResult, acc, deviceId);
        songloft.log.info(`[VoiceEngine] [Test] AI execute done in ${Date.now() - execStart}ms (total ${Date.now() - testStart}ms)`);
        return {
          matched: true,
          source: 'ai',
          ai: { action: aiResult.action, confidence: aiResult.confidence, params: aiResult.params },
          commandType: aiResult.action,
          argument: aiResult.params?.name || aiResult.params?.playlist || aiResult.params?.artist || '',
          search,
          executed: true,
        };
      }
      // AI 未达标 → 回退规则匹配，同时把 AI 结果带回给前端展示
      const ruleRes = await this.testRule(q, acc, deviceId);
      ruleRes.ai = aiResult
        ? { action: aiResult.action, confidence: aiResult.confidence, params: aiResult.params }
        : null;
      if (!ruleRes.note) {
        ruleRes.note = 'AI 未达高置信度或未识别，已回退规则匹配';
      }
      return ruleRes;
    }

    return await this.testRule(q, acc, deviceId);
  }

  /** 规则匹配测试：匹配 + 执行 + 返回诊断 */
  private async testRule(query: string, accountId: string, deviceId: string): Promise<CommandTestResult> {
    const ruleStart = Date.now();
    const result = await this.matchCommand(query);
    songloft.log.info(`[VoiceEngine] [Test] rule match done in ${Date.now() - ruleStart}ms → ${result ? `type=${result.command.type} keyword="${result.keyword}" argument="${result.argument}"` : 'no match'}`);
    if (!result) {
      return { matched: false, source: 'rule', executed: false, note: '未匹配到任何口令' };
    }
    const previewStart = Date.now();
    const search = await this.previewSearch(result.command.type, result.argument);
    songloft.log.info(`[VoiceEngine] [Test] previewSearch done in ${Date.now() - previewStart}ms`);
    const execStart = Date.now();
    await this.executeCommand(result, accountId, deviceId);
    songloft.log.info(`[VoiceEngine] [Test] executeCommand done in ${Date.now() - execStart}ms (total ${Date.now() - ruleStart}ms)`);
    return {
      matched: true,
      source: 'rule',
      commandType: result.command.type,
      keyword: result.keyword,
      argument: result.argument,
      search,
      executed: true,
    };
  }

  /** 搜索预览：按命令类型在本地索引查一遍，报告将命中的歌曲/歌单（不影响实际执行） */
  private async previewSearch(
    type: string,
    argument: string,
    artist?: string,
  ): Promise<{ kind: 'song' | 'playlist'; found: boolean; detail: string } | null> {
    if (type === 'play_song') {
      const term = artist && artist.trim() ? `${argument} ${artist.trim()}` : (argument || '');
      if (!term.trim()) {
        return { kind: 'song', found: false, detail: '（无歌名，将恢复上次播放）' };
      }
      if (!(await this.indexingManager.waitForReady(INDEX_READY_WAIT_MS))) {
        return { kind: 'song', found: false, detail: '索引未就绪，无法预览搜索结果' };
      }
      const loc = await this.indexingManager.findSongByName(term);
      if (loc) {
        const artistStr = loc.artist ? ` - ${loc.artist}` : '';
        return { kind: 'song', found: true, detail: `${loc.songTitle}${artistStr}（歌单：${loc.playlistName}）` };
      }
      return { kind: 'song', found: false, detail: `本地索引未命中「${term}」，将尝试独立歌曲/外部搜索` };
    }
    if (type === 'play_playlist') {
      if (!(argument || '').trim()) {
        return { kind: 'playlist', found: false, detail: '（无歌单名，将使用默认歌单/恢复播放）' };
      }
      if (!(await this.indexingManager.waitForReady(INDEX_READY_WAIT_MS))) {
        return { kind: 'playlist', found: false, detail: '索引未就绪，无法预览搜索结果' };
      }
      const pl = this.indexingManager.findPlaylistByName(argument);
      if (pl) {
        return { kind: 'playlist', found: true, detail: `${pl.name}（${pl.songCount} 首）` };
      }
      return { kind: 'playlist', found: false, detail: `未找到歌单「${argument}」` };
    }
    return null;
  }

  /** AI 结果的搜索预览（与 executeAIResult 的传参口径一致） */
  private async previewForAI(
    aiResult: AIAnalysisResult,
  ): Promise<{ kind: 'song' | 'playlist'; found: boolean; detail: string } | null> {
    if (aiResult.action === 'play_song') {
      const name = aiResult.params?.name || '';
      const artist = aiResult.params?.artist || '';
      if (name && artist) {
        return this.previewSearch('play_song', name, artist);
      }
      return this.previewSearch('play_song', name || artist);
    }
    if (aiResult.action === 'play_playlist') {
      return this.previewSearch('play_playlist', aiResult.params?.playlist || '');
    }
    return null;
  }

  /**
   * 从 ConversationMessage 中提取用户 query
   */
  private extractQuery(msg: ConversationMessage): string {
    const response = msg.message?.response;
    if (!response || !response.answer || response.answer.length === 0) {
      return '';
    }
    const ans = response.answer[0];
    return ans.question || ans.intention?.query || '';
  }

  // ===== 私有方法 - 口令匹配 =====

  private matchBuiltinStopCommand(query: string): MatchResult | null {
    const normalizedQuery = query.toLowerCase();
    const keyword = BUILTIN_STOP_KEYWORDS
      .filter(item => normalizedQuery.includes(item))
      .sort((a, b) => Array.from(b).length - Array.from(a).length)[0];
    if (!keyword) return null;

    return {
      command: { type: 'stop', keywords: BUILTIN_STOP_KEYWORDS, enabled: true },
      keyword,
      argument: '',
    };
  }

  /**
   * 匹配语音口令
   * 按优先级遍历所有已启用的口令，使用包含匹配
   * @param query - 用户说的话
   * @returns 匹配结果，null 表示未匹配
   */
  private async matchCommand(query: string, allowedTypes?: Set<string>): Promise<MatchResult | null> {
    const commands = await this.configManager.getVoiceCommands();
    if (commands.length === 0) {
      return null;
    }

    const enabledCommands = commands
      .filter(cmd => cmd.enabled && (!allowedTypes || allowedTypes.has(cmd.type)))
      .map(cmd => ({
        cmd,
        priority: COMMAND_PRIORITY[cmd.type] ?? 99,
      }));

    if (enabledCommands.length === 0) {
      return null;
    }

    // 跨优先级最长关键词匹配：遍历所有命令，取全局最长匹配，长度相同时高优先级优先。
    // 防止短关键词（如"播放"）窃取更长关键词（如"播放歌单"）的匹配。
    let bestMatch: MatchResult | null = null;
    let bestKeywordLen = 0;
    let bestPriority = 99;

    for (const item of enabledCommands) {
      for (const keyword of item.cmd.keywords) {
        const idx = query.indexOf(keyword);
        if (idx >= 0) {
          const kwLen = Array.from(keyword).length;
          if (kwLen > bestKeywordLen || (kwLen === bestKeywordLen && item.priority < bestPriority)) {
            bestKeywordLen = kwLen;
            bestPriority = item.priority;
            bestMatch = {
              command: item.cmd,
              keyword,
              argument: query.slice(idx + keyword.length).trim(),
            };
          }
        }
      }
    }

    if (bestMatch) {
      return bestMatch;
    }

    // 第二趟：精确匹配零命中时，跑有界跳字子序列兜底（如"我想听" ⊇ "我今天想听"）。
    // tiebreak 与第一趟一致：最长关键词 > inserted 最小 > 高优先级。
    const qRunes = Array.from(query);
    let bestInserted = Infinity;

    for (const item of enabledCommands) {
      for (const keyword of item.cmd.keywords) {
        const kwRunes = Array.from(keyword);
        const m = fuzzySubseqMatch(qRunes, kwRunes, FUZZY_MAX_GAP);
        if (!m) continue;

        const kwLen = kwRunes.length;
        const better =
          kwLen > bestKeywordLen ||
          (kwLen === bestKeywordLen && m.inserted < bestInserted) ||
          (kwLen === bestKeywordLen && m.inserted === bestInserted && item.priority < bestPriority);
        if (better) {
          bestKeywordLen = kwLen;
          bestInserted = m.inserted;
          bestPriority = item.priority;
          bestMatch = {
            command: item.cmd,
            keyword,
            argument: qRunes.slice(m.lastIdx + 1).join('').trim(),
          };
        }
      }
    }

    return bestMatch;
  }

  // ===== 私有方法 - 口令执行 =====

  /**
   * 执行匹配到的口令
   */
  private async executeCommand(result: MatchResult, accountId: string, deviceId: string): Promise<PlayedSong | null> {
    const pm = this.playlistManagerMap.get(accountId, deviceId);
    const wasPlaying = pm?.isPlaying() ?? false;
    let playedSong: PlayedSong | null = null;

    switch (result.command.type) {
      case 'play_playlist':
        await this.executePlayPlaylist(result.argument, accountId, deviceId);
        break;
      case 'play_song':
        playedSong = await this.executePlaySong(result.argument, accountId, deviceId);
        break;
      case 'set_play_mode':
        await this.executeSetPlayMode(accountId, deviceId, result.command.param || result.argument);
        break;
      case 'set_volume':
        await this.executeSetVolume(accountId, deviceId, result.command.param || 'absolute', result.argument);
        break;
      case 'next':
        await this.executeNext(accountId, deviceId);
        break;
      case 'previous':
        await this.executePrevious(accountId, deviceId);
        break;
      case 'stop':
        await this.executeStop(accountId, deviceId);
        break;
      default:
        songloft.log.warn(`[VoiceEngine] Unknown command type: ${result.command.type}`);
    }

    this.tryResumePlayback(result.command.type, wasPlaying, pm, accountId, deviceId);
    return playedSong;
  }

  /**
   * 执行 AI 分析结果
   */
  private async executeAIResult(result: AIAnalysisResult, accountId: string, deviceId: string): Promise<PlayedSong | null> {
    songloft.log.info(`[VoiceEngine] [AI] Executing action=${result.action} params=${JSON.stringify(result.params)}`);
    const pm = this.playlistManagerMap.get(accountId, deviceId);
    const wasPlaying = pm?.isPlaying() ?? false;
    let playedSong: PlayedSong | null = null;

    switch (result.action) {
      case 'play_song': {
        const name = result.params.name || '';
        const artist = result.params.artist || '';
        if (!name && !artist) {
          songloft.log.warn('[VoiceEngine] [AI] play_song: no name or artist to play');
          return null;
        }
        // 歌名+歌手都有：歌名作主搜索词、歌手作辅助字段（多字段 cover 匹配）；
        // 只有其一：用非空者作主搜索词
        if (name && artist) {
          playedSong = await this.executePlaySong(name, accountId, deviceId, artist);
        } else {
          playedSong = await this.executePlaySong(name || artist, accountId, deviceId);
        }
        break;
      }
      case 'play_playlist': {
        const playlist = result.params.playlist || '';
        if (!playlist) {
          songloft.log.warn('[VoiceEngine] [AI] play_playlist: no playlist name');
          return null;
        }
        await this.executePlayPlaylist(playlist, accountId, deviceId);
        break;
      }
      case 'set_play_mode': {
        const mode = result.params.mode || '';
        if (!mode) {
          songloft.log.warn('[VoiceEngine] [AI] set_play_mode: no mode');
          return null;
        }
        await this.executeSetPlayMode(accountId, deviceId, mode);
        break;
      }
      case 'set_volume': {
        const direction = result.params.direction || 'absolute';
        const volume = result.params.volume;
        await this.executeSetVolume(accountId, deviceId, direction, volume !== undefined ? String(volume) : '');
        break;
      }
      case 'next':
        await this.executeNext(accountId, deviceId);
        break;
      case 'previous':
        await this.executePrevious(accountId, deviceId);
        break;
      case 'stop':
        await this.executeStop(accountId, deviceId);
        break;
      default:
        songloft.log.warn(`[VoiceEngine] [AI] Unknown action: ${result.action}`);
    }

    this.tryResumePlayback(result.action, wasPlaying, pm, accountId, deviceId);
    return playedSong;
  }

  /**
   * 非播放类命令执行后，尝试恢复被小爱语音唤醒中断的 URL 播放
   */
  private tryResumePlayback(commandType: string, wasPlaying: boolean, pm: import('../player/manager').PlaylistManager | null, accountId: string, deviceId: string): void {
    const isNonPlaybackCommand = commandType === 'set_volume' || commandType === 'set_play_mode';
    if (!isNonPlaybackCommand || !wasPlaying || !pm) return;

    pm.suspendForVoiceInteraction();
    songloft.log.info('[VoiceEngine] Non-playback command while playing, scheduling smart resume');
    this.scheduleSmartResume(pm, accountId, deviceId);
  }

  /**
   * 执行播放歌单
   * 通过 IndexingManager 模糊匹配歌单名，然后调用 PlaylistManager 播放
   */
  private async executePlayPlaylist(playlistName: string, accountId: string, deviceId: string): Promise<void> {
    this.cancelPendingResume();
    const pm = await this.playlistManagerMap.getOrCreate(accountId, deviceId);

    // 空参数 + 有活跃歌单：直接恢复播放，无需搜索和打断
    if (!playlistName && pm.hasPlaylist()) {
      songloft.log.info('[VoiceEngine] Play playlist: resume last playback');
      await pm.next();
      return;
    }

    // 立即停止定时器和重置状态，防止后续异步操作期间旧定时器触发
    pm.prepareForNewPlayback();

    // 打断音箱当前播报
    await this.interruptBroadcast(accountId, deviceId);

    // 检查索引是否就绪，未就绪则尝试按需刷新
    if (!this.indexingManager.isIndexReady()) {
      songloft.log.warn('[VoiceEngine] Playlist index not ready, attempting on-demand refresh');
      const result = await this.indexingManager.refresh();
      if (!result.success || !this.indexingManager.isIndexReady()) {
        songloft.log.warn('[VoiceEngine] Playlist index refresh failed, skip play playlist');
        return;
      }
      songloft.log.info(`[VoiceEngine] Playlist index refreshed on-demand: playlists=${result.playlistCount} songs=${result.songCount}`);
    }

    // 空参数处理：使用默认歌单
    if (!playlistName) {
      // 使用第一个歌单
      const playlists = this.indexingManager.searchPlaylist('');
      if (playlists.length === 0) {
        songloft.log.warn('[VoiceEngine] No playlists available');
        return;
      }
      playlistName = playlists[0].name;
      songloft.log.info(`[VoiceEngine] No name specified, using default playlist: ${playlistName}`);
    }

    // 模糊匹配歌单
    const matchedPlaylist = this.indexingManager.findPlaylistByName(playlistName);
    if (!matchedPlaylist) {
      songloft.log.warn(`[VoiceEngine] Playlist not found: ${playlistName}`);
      await this.minaService.textToSpeech(accountId, deviceId, `未找到歌单：${playlistName}`);
      return;
    }

    songloft.log.info(`[VoiceEngine] Matched playlist: ${matchedPlaylist.name} (id=${matchedPlaylist.id})`);

    // 获取设备配置中的播放模式和起始位置
    let startIndex = 0;
    let playMode: PlayMode = 'order';

    const devices = await this.configManager.getDevices(accountId);
    const devCfg = devices.find(d => d.device_id === deviceId);
    if (devCfg) {
      if (devCfg.playlist_id === matchedPlaylist.id) {
        // 同一个歌单，从上次位置继续
        startIndex = devCfg.current_song_index || 0;
      }
      if (devCfg.play_mode) {
        playMode = devCfg.play_mode as PlayMode;
      }
    }

    // 播放歌单
    const ok = await pm.play(matchedPlaylist.id, startIndex, playMode);
    if (ok) {
      songloft.log.info(`[VoiceEngine] Play playlist success: ${matchedPlaylist.name} index=${startIndex} mode=${playMode}`);
      return;
    }

    // 播放失败且因歌单 ID 已失效：刷新索引后按名字重新查找并重试一次
    if (pm.isLastPlayNotFound()) {
      songloft.log.warn(`[VoiceEngine] Stale playlist ID ${matchedPlaylist.id} in playPlaylist, refreshing index and retrying`);
      await this.indexingManager.refresh();
      // 用已匹配到的规范歌单名精确重查（比原始模糊查询更稳，能命中改了 ID 的同名歌单）
      const newPlaylist = this.indexingManager.findPlaylistByName(matchedPlaylist.name);
      if (newPlaylist) {
        songloft.log.info(`[VoiceEngine] Re-matched playlist after refresh: ${newPlaylist.name} (id=${newPlaylist.id})`);
        const retryOk = await pm.play(newPlaylist.id, 0, playMode);
        if (retryOk) {
          songloft.log.info(`[VoiceEngine] Retry play playlist success: ${newPlaylist.name}`);
          return;
        }
      }
      songloft.log.error(`[VoiceEngine] Retry play playlist failed after index refresh: ${playlistName}`);
      return;
    }

    songloft.log.error(`[VoiceEngine] Play playlist failed: ${matchedPlaylist.name}`);
  }

  /**
   * 执行播放歌曲
   * 通过 IndexingManager 模糊匹配歌曲名，获取所在歌单及索引，然后调用 PlaylistManager 播放
   * 翻译自 Go 版本: voicecmd/engine.go executePlaySong
   */
  private async executePlaySong(songName: string, accountId: string, deviceId: string, artist?: string): Promise<PlayedSong | null> {
    this.cancelPendingResume();
    const pm = await this.playlistManagerMap.getOrCreate(accountId, deviceId);

    // 本地多字段搜索用歌名+歌手（配合 cover 匹配提升命中）；在线 hint / TTS 文案仍用纯歌名
    const searchTerm = artist && artist.trim() ? `${songName} ${artist.trim()}` : songName;

    // 空参数处理：继续上次播放
    if (!songName) {
      if (pm.hasPlaylist()) {
        songloft.log.info('[VoiceEngine] Play song: resume last playback');
        await pm.next();
        return null;
      }
      songloft.log.warn('[VoiceEngine] No song name specified and no active playlist');
      return null;
    }

    // 立即停止定时器和重置状态，防止后续异步操作期间旧定时器触发
    pm.prepareForNewPlayback();

    // 打断音箱当前播报（停止播放），不在此处播放 TTS 提示
    try {
      await this.minaService.stopPlay(accountId, deviceId);
    } catch (e) {
      songloft.log.warn('[VoiceEngine] Failed to interrupt broadcast: ' + String(e));
    }

    const config = await this.configManager.getConfig();
    const hint = this.buildExternalSearchHint(songName, artist);
    const priority = this.normalizeSearchPriority(config.search_priority);
    songloft.log.info(`[VoiceEngine] Play song priority=${priority} keyword="${songName}" localTerm="${searchTerm}"`);

    // 搜索提示 TTS 与搜歌并行执行
    const ttsHintEnabled = config.interrupt_tts_hint_enabled;
    const ttsHintText = config.interrupt_tts_hint_text || '正在搜索，请稍候';
    const parallelStart = Date.now();

    const searchTask = async (): Promise<PlayedSong | null> => {
      const result = await (async () => {
        switch (priority) {
          case 'local_first':
            return this.executePlaySongLocalFirst(songName, searchTerm, hint, pm, accountId, deviceId);
          case 'external_first':
            return this.executePlaySongExternalFirst(songName, searchTerm, hint, pm, accountId, deviceId);
          case 'parallel':
          default:
            return this.executePlaySongParallel(songName, searchTerm, hint, pm, accountId, deviceId);
        }
      })();
      songloft.log.info(`[VoiceEngine] Parallel search done in ${Date.now() - parallelStart}ms result=${result !== null}`);
      return result;
    };

    const ttsTask = async (): Promise<void> => {
      if (!ttsHintEnabled) return;
      // 300ms 延迟在此处可能导致 TTS 晚于 play-url 到达音箱，
      // 使 TTS"正在搜索"覆盖歌曲播放。去掉可恢复正确时序，
      // 但打断后立即播 TTS 是否被吞需验证，原作者自行决策。
      // await new Promise(resolve => setTimeout(resolve, 300));
      try {
        await this.minaService.textToSpeech(accountId, deviceId, ttsHintText);
        songloft.log.info(`[VoiceEngine] Parallel TTS done in ${Date.now() - parallelStart}ms`);
      } catch (e) {
        songloft.log.warn('[VoiceEngine] Failed to play TTS hint: ' + String(e));
      }
    };

    const [playedSong] = await Promise.all([searchTask(), ttsTask()]);
    songloft.log.info(`[VoiceEngine] Parallel all done in ${Date.now() - parallelStart}ms played=${playedSong !== null} ttsEnabled=${ttsHintEnabled}`);

    if (playedSong) {
      return playedSong;
    }

    songloft.log.warn(`[VoiceEngine] Song not found or failed to play: ${songName}`);
    await this.minaService.textToSpeech(accountId, deviceId, `未找到歌曲：${songName}`);
    return null;
  }

  private normalizeSearchPriority(priority: unknown): SearchPriority {
    return priority === 'local_first' || priority === 'external_first' || priority === 'parallel'
      ? priority
      : 'parallel';
  }

  private buildExternalSearchHint(songName: string, artist?: string): { title: string; artist?: string; duration?: number } | null {
    const title = songName.trim();
    if (!title) return null;
    const artistName = artist?.trim();
    return artistName ? { title, artist: artistName } : { title };
  }

  private async executePlaySongLocalFirst(
    songName: string,
    searchTerm: string,
    hint: { title: string; artist?: string; duration?: number } | null,
    pm: PlaylistManager,
    accountId: string,
    deviceId: string,
  ): Promise<PlayedSong | null> {
    const local = await this.findLocalSongCandidate(searchTerm);
    if (local) {
      return await this.playSongCandidate(local, pm, searchTerm, songName, accountId, deviceId);
    }

    songloft.log.warn(`[VoiceEngine] Song not found locally: ${songName}, trying online search`);
    const external = await this.findExternalSongCandidate(songName, hint);
    if (!external) {
      return null;
    }
    return await this.playSongCandidate(external, pm, searchTerm, songName, accountId, deviceId);
  }

  private async executePlaySongExternalFirst(
    songName: string,
    searchTerm: string,
    hint: { title: string; artist?: string; duration?: number } | null,
    pm: PlaylistManager,
    accountId: string,
    deviceId: string,
  ): Promise<PlayedSong | null> {
    const external = await this.findExternalSongCandidate(songName, hint);
    if (external) {
      const played = await this.playSongCandidate(external, pm, searchTerm, songName, accountId, deviceId);
      if (played) {
        return played;
      }
      songloft.log.warn(`[VoiceEngine] External search found result but failed to play, falling back to local: ${songName}`);
    }

    const local = await this.findLocalSongCandidate(searchTerm);
    if (!local) {
      return null;
    }
    return await this.playSongCandidate(local, pm, searchTerm, songName, accountId, deviceId);
  }

  private async executePlaySongParallel(
    songName: string,
    searchTerm: string,
    hint: { title: string; artist?: string; duration?: number } | null,
    pm: PlaylistManager,
    accountId: string,
    deviceId: string,
  ): Promise<PlayedSong | null> {
    const candidate = await this.firstSuccessfulSongCandidate([
      this.findLocalSongCandidate(searchTerm),
      this.findExternalSongCandidate(songName, hint),
    ]);
    if (!candidate) {
      return null;
    }
    songloft.log.info(`[VoiceEngine] Parallel search selected source=${candidate.source}`);
    return await this.playSongCandidate(candidate, pm, searchTerm, songName, accountId, deviceId);
  }

  private async firstSuccessfulSongCandidate(
    tasks: Array<Promise<SongSearchCandidate | null>>,
  ): Promise<SongSearchCandidate | null> {
    let pending = tasks.map((task, slot) => ({
      slot,
      promise: task
        .then(candidate => ({ slot, candidate }))
        .catch(e => {
          songloft.log.warn('[VoiceEngine] Search task failed: ' + String(e));
          return { slot, candidate: null as SongSearchCandidate | null };
        }),
    }));

    while (pending.length > 0) {
      const settled = await Promise.race(pending.map(p => p.promise));
      if (settled.candidate) {
        if (await this.isCandidateUrlHealthy(settled.candidate)) {
          return settled.candidate;
        }
        // URL 不健康：有其他候选在跑则继续等，没有则死马当活马医
        const otherPending = pending.filter(p => p.slot !== settled.slot);
        if (otherPending.length === 0) {
          songloft.log.warn(`[VoiceEngine] Candidate ${settled.candidate.source} URL unhealthy, no fallback available, will try anyway`);
          return settled.candidate;
        }
        songloft.log.warn(`[VoiceEngine] Candidate ${settled.candidate.source} URL unhealthy, waiting for other sources`);
        pending = otherPending;
        continue;
      }
      pending = pending.filter(p => p.slot !== settled.slot);
    }

    return null;
  }

  /**
   * 检查候选歌曲的 URL 是否有效。
   * - 本地索引歌曲（local_index）不检查，URL 由插件内部管理。
   * - 独立远程歌曲（remote_song）通过 range 请求验证，防止过期链接推送给音箱。
   */
  private async isCandidateUrlHealthy(candidate: SongSearchCandidate): Promise<boolean> {
    if (candidate.source !== 'remote_song') return true;

    const playUrl = await URLBuilder.buildSongURL(candidate.song);
    if (!playUrl) return false;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), URL_HEALTH_CHECK_TIMEOUT_MS);
      const resp = await fetch(playUrl, {
        method: 'GET',
        headers: { Range: 'bytes=0-0' },
        signal: controller.signal,
      });
      clearTimeout(timer);
      const ok = resp.ok || resp.status === 206;
      if (!ok) {
        songloft.log.warn(`[VoiceEngine] URL health check failed status=${resp.status}: ${playUrl.slice(0, 80)}`);
      }
      return ok;
    } catch (e) {
      songloft.log.warn(`[VoiceEngine] URL health check error: ${String(e)}`);
      return false;
    }
  }

  private async findLocalSongCandidate(searchTerm: string): Promise<SongSearchCandidate | null> {
    if (!(await this.indexingManager.waitForReady(INDEX_READY_WAIT_MS))) {
      songloft.log.warn('[VoiceEngine] Song index not ready after wait, skip local search');
      return null;
    }

    // 从索引中模糊匹配歌曲，获取歌单ID和歌曲索引（使用预加载缓存，纯内存操作）
    songloft.log.info(`[VoiceEngine] Searching local song: "${searchTerm}"`);
    const loc = await this.indexingManager.findSongByName(searchTerm);
    if (loc) {
      return { source: 'local_index', loc };
    }

    // 尝试查找独立远程歌曲（不在任何歌单中的外部导入歌曲）
    const standalone = await this.indexingManager.findStandaloneSongByName(searchTerm);
    if (standalone) {
      return { source: 'remote_song', song: standalone };
    }

    return null;
  }

  private async findExternalSongCandidate(
    songName: string,
    hint: { title: string; artist?: string; duration?: number } | null,
  ): Promise<SongSearchCandidate | null> {
    if (!(await this.onlineSearcher.isExternalSearchConfigured())) {
      songloft.log.info('[VoiceEngine] External search not configured, skip online search');
      return null;
    }

    const song = await this.onlineSearcher.search(songName, hint);
    if (!song) {
      songloft.log.warn(`[VoiceEngine] Online search missed for: ${songName}`);
      return null;
    }

    return { source: 'external_search', song };
  }

  private async playSongCandidate(
    candidate: SongSearchCandidate,
    pm: PlaylistManager,
    searchTerm: string,
    requestedSongName: string,
    accountId: string,
    deviceId: string,
  ): Promise<PlayedSong | null> {
    switch (candidate.source) {
      case 'local_index': {
        const playedLoc = await this.playIndexedSong(candidate.loc, pm, searchTerm, requestedSongName, accountId, deviceId);
        return playedLoc ? this.playedSongFromLocation(playedLoc) : null;
      }
      case 'remote_song': {
        const played = await this.playStandaloneSong(candidate.song, accountId, deviceId);
        return played ? {
          songId: candidate.song.id,
          songName: candidate.song.title,
          artist: candidate.song.artist,
        } : null;
      }
      case 'external_search': {
        // 外部搜索播放成功后，由 playSearchResult 增量把这首歌加入索引（见 addImportedSong），
        // 后续可直接本地命中，无需为一首独立远程歌曲重建全部歌单缓存。
        const played = await this.onlineSearcher.playSearchResult(
          candidate.song, accountId, deviceId, this.minaService, this.indexingManager,
        );
        return played ? {
          songName: candidate.song.title,
          artist: candidate.song.artist || '',
        } : null;
      }
    }
  }

  private playedSongFromLocation(loc: SongLocation): PlayedSong {
    return {
      songId: loc.songId,
      songName: loc.songTitle,
      artist: loc.artist,
      playlistId: loc.playlistId,
      playlistName: loc.playlistName,
      songIndex: loc.songIndex,
    };
  }

  private async playStandaloneSong(
    standalone: StandaloneSongCandidate,
    accountId: string,
    deviceId: string,
  ): Promise<boolean> {
    const playUrl = await URLBuilder.buildSongURL(standalone);
    if (!playUrl) {
      songloft.log.error('[VoiceEngine] Failed to build standalone remote song URL: ' + standalone.title);
      return false;
    }

    const standaloneName = standalone.artist ? `${standalone.title}-${standalone.artist}` : standalone.title;
    const played = await this.minaService.playURL(accountId, deviceId, playUrl, standaloneName);
    if (!played) {
      songloft.log.error('[VoiceEngine] Failed to play standalone remote song: ' + standalone.title + ' - ' + standalone.artist);
      return false;
    }

    songloft.log.info('[VoiceEngine] Played standalone remote song: ' + standalone.title + ' - ' + standalone.artist);
    return true;
  }

  private async playIndexedSong(
    loc: SongLocation,
    pm: PlaylistManager,
    searchTerm: string,
    requestedSongName: string,
    accountId: string,
    deviceId: string,
  ): Promise<SongLocation | null> {
    songloft.log.info(`[VoiceEngine] Matched song: ${loc.songTitle} - ${loc.artist} playlist="${loc.playlistName}" playlistId=${loc.playlistId} songIndex=${loc.songIndex}`);

    // 获取设备配置中的播放模式
    let playMode: PlayMode = 'order';
    const devices = await this.configManager.getDevices(accountId);
    const devCfg = devices.find(d => d.device_id === deviceId);
    if (devCfg && devCfg.play_mode) {
      playMode = devCfg.play_mode as PlayMode;
    }

    // 播放歌单，从匹配到的歌曲索引开始
    const ok = await pm.play(loc.playlistId, loc.songIndex, playMode);
    if (ok) {
      songloft.log.info(`[VoiceEngine] Play song success: ${loc.songTitle} playlist="${loc.playlistName}" index=${loc.songIndex} mode=${playMode}`);
      return loc;
    }

    // 播放失败且因歌单 ID 已失效（扫描后 auto-create 歌单 ID 变化）：刷新索引后重试一次
    if (pm.isLastPlayNotFound()) {
      songloft.log.warn(`[VoiceEngine] Stale playlist ID ${loc.playlistId}, refreshing index and retrying`);
      await this.indexingManager.refresh();
      const newLoc = await this.indexingManager.findSongByName(searchTerm);
      if (newLoc) {
        songloft.log.info(`[VoiceEngine] Re-matched after refresh: ${newLoc.songTitle} playlist="${newLoc.playlistName}" playlistId=${newLoc.playlistId} songIndex=${newLoc.songIndex}`);
        const retryOk = await pm.play(newLoc.playlistId, newLoc.songIndex, playMode);
        if (retryOk) {
          songloft.log.info(`[VoiceEngine] Retry play song success: ${newLoc.songTitle}`);
          return newLoc;
        }
      }
      songloft.log.error(`[VoiceEngine] Retry play song failed after index refresh: ${requestedSongName}`);
      return null;
    }

    songloft.log.error(`[VoiceEngine] Play song failed: ${loc.songTitle}`);
    return null;
  }

  /**
   * 执行设置播放模式
   * @param modeParam - 播放模式参数（来自 command.param 或 argument）
   */
  private async executeSetPlayMode(accountId: string, deviceId: string, modeParam: string): Promise<void> {
    if (!modeParam) {
      songloft.log.warn('[VoiceEngine] Set play mode: missing mode param');
      return;
    }

    // 尝试从参数中提取播放模式
    const modeMap: Record<string, PlayMode> = {
      '顺序': 'order',
      '顺序播放': 'order',
      '随机': 'random',
      '随机播放': 'random',
      '单曲循环': 'single',
      '单曲': 'single',
      '列表循环': 'loop',
      '循环': 'loop',
      'order': 'order',
      'random': 'random',
      'single': 'single',
      'loop': 'loop',
    };

    const playMode = modeMap[modeParam];
    if (!playMode) {
      songloft.log.warn(`[VoiceEngine] Unknown play mode: ${modeParam}`);
      return;
    }

    const pm = this.playlistManagerMap.get(accountId, deviceId);
    if (pm) {
      await pm.setPlayMode(playMode);
    } else {
      // 没有活跃的播放管理器，仅更新配置
      try {
        await this.configManager.updateDevice(accountId, deviceId, { play_mode: playMode });
      } catch (e) {
        songloft.log.error(`[VoiceEngine] Failed to update play mode config: ${String(e)}`);
      }
    }

    songloft.log.info(`[VoiceEngine] Play mode set to: ${playMode}`);
  }

  /**
   * 执行设置音量（绝对值/相对值）
   * @param param - 音量方向："absolute"|"up"|"down"
   * @param argument - 口令关键词后的文本（用于提取数字）
   */
  private async executeSetVolume(accountId: string, deviceId: string, param: string, argument: string): Promise<void> {
    let currentVolume = 50;

    if (param === 'up' || param === 'down') {
      // 相对音量命令：查询设备实际音量，避免本地缓存过期
      const realVolume = await this.minaService.getVolume(accountId, deviceId);
      if (realVolume >= 0) {
        currentVolume = realVolume;
        songloft.log.info(`[VoiceEngine] Got real device volume: ${realVolume}`);
      } else {
        songloft.log.warn('[VoiceEngine] Failed to get real volume, falling back to config');
        const devices = await this.configManager.getDevices(accountId);
        const dev = devices.find(d => d.device_id === deviceId);
        if (dev) {
          currentVolume = dev.volume || 50;
        }
      }
    }

    let targetVolume: number;

    switch (param) {
      case 'up':
        targetVolume = currentVolume + 10;
        break;
      case 'down':
        targetVolume = currentVolume - 10;
        break;
      case 'absolute':
      default: {
        const volume = this.extractNumber(argument);
        if (volume === null) {
          songloft.log.warn(`[VoiceEngine] No volume number found in: ${argument}`);
          return;
        }
        targetVolume = volume;
        break;
      }
    }

    // 限制范围 0-100
    targetVolume = Math.max(0, Math.min(100, targetVolume));

    songloft.log.info(`[VoiceEngine] Set volume: current=${currentVolume} target=${targetVolume} param=${param}`);

    const ok = await this.minaService.setVolume(accountId, deviceId, targetVolume);
    if (ok) {
      updateDeviceStatusCache(accountId, deviceId, { volume: targetVolume, lockVolume: true });
      songloft.log.info(`[VoiceEngine] Volume set to: ${targetVolume}`);
    } else {
      songloft.log.error(`[VoiceEngine] Failed to set volume: ${targetVolume}`);
    }
  }

  /**
   * 执行下一首
   */
  private async executeNext(accountId: string, deviceId: string): Promise<void> {
    this.cancelPendingResume();
    const pm = await this.playlistManagerMap.getOrCreate(accountId, deviceId);
    const ok = await pm.next();
    if (ok) {
      songloft.log.info(`[VoiceEngine] Next song success`);
    } else {
      songloft.log.warn(`[VoiceEngine] Next song failed or no next`);
    }
  }

  /**
   * 执行上一首
   */
  private async executePrevious(accountId: string, deviceId: string): Promise<void> {
    this.cancelPendingResume();
    const pm = await this.playlistManagerMap.getOrCreate(accountId, deviceId);
    const ok = await pm.previous();
    if (ok) {
      songloft.log.info(`[VoiceEngine] Previous song success`);
    } else {
      songloft.log.warn(`[VoiceEngine] Previous song failed or no previous`);
    }
  }

  /**
   * 执行停止播放
   */
  private async executeStop(accountId: string, deviceId: string): Promise<void> {
    this.cancelPendingResume();
    const pm = await this.playlistManagerMap.getOrCreate(accountId, deviceId);
    await pm.stop();
    songloft.log.info(`[VoiceEngine] Playback stopped`);
  }

  /**
   * 取消待执行的恢复操作
   */
  private cancelPendingResume(): void {
    if (this.resumeTimer !== null) {
      clearTimeout(this.resumeTimer);
      this.resumeTimer = null;
    }
    this.resumeCancelled = true;
  }

  /**
   * 调度智能恢复：先等 3 秒让小爱开始 TTS，再轮询设备状态等待 TTS 结束后重新推送歌曲
   */
  private scheduleSmartResume(pm: import('../player/manager').PlaylistManager, accountId: string, deviceId: string): void {
    this.cancelPendingResume();
    this.resumeCancelled = false;
    this.resumeTimer = setTimeout(async () => {
      this.resumeTimer = null;
      await this.smartResume(pm, accountId, deviceId);
    }, 3000);
  }

  /**
   * 从 UBus player_get_play_status 响应中解析设备状态
   * 响应格式：{ data: { info: '{"status":1,"volume":50,"play_song_detail":{"position":12000,...}}' } }
   */
  private parseDeviceStatus(raw: any): { status: number; position: number } {
    let status = -1;
    let position = 0;
    const info = (raw?.data as any)?.info;
    if (typeof info === 'string') {
      try {
        const parsed = JSON.parse(info);
        if (typeof parsed.status === 'number') status = parsed.status;
        if (parsed.play_song_detail && typeof parsed.play_song_detail.position === 'number') {
          position = Math.floor(parsed.play_song_detail.position / 1000);
        }
      } catch {}
    }
    return { status, position };
  }

  /**
   * 等待小爱 TTS 播报结束后重新推送当前歌曲 URL
   */
  private async smartResume(pm: import('../player/manager').PlaylistManager, accountId: string, deviceId: string): Promise<void> {
    if (!pm.isPlaying() || this.resumeCancelled) return;

    const config = await this.configManager.getConfig();
    const timeoutSec = Math.max(5, Math.min(120, config.smart_resume_timeout ?? 30));
    const maxWaitMs = timeoutSec * 1000;
    const pollInterval = 2000;
    const startTime = Date.now();
    let deviceBecameIdle = false;
    let lastDevicePosition = 0;

    while (Date.now() - startTime < maxWaitMs) {
      if (!pm.isPlaying() || this.resumeCancelled) return;

      const raw = await this.minaService.getPlayerStatus(accountId, deviceId);
      const deviceStatus = this.parseDeviceStatus(raw);
      if (deviceStatus.status !== 1) {
        deviceBecameIdle = true;
        break;
      }
      lastDevicePosition = deviceStatus.position;

      await new Promise(r => setTimeout(r, pollInterval));
    }

    if (!pm.isPlaying() || this.resumeCancelled) return;

    if (!deviceBecameIdle) {
      // 超时退出：设备一直在播放，说明已自动恢复，仅重置切歌定时器
      // 不发送 play 命令，避免部分设备（如 L15A）收到多余指令后从头播放
      songloft.log.info('[VoiceEngine] Device auto-resumed, resetting timer only');
      pm.resetAutoNextTimer(lastDevicePosition);
      return;
    }

    const ok = await pm.replayCurrent();
    if (ok) {
      songloft.log.info('[VoiceEngine] Playback restored via replay after voice interaction');
    } else {
      songloft.log.warn('[VoiceEngine] Failed to restore playback after voice interaction');
    }
  }

  /**
   * 搜索前打断音箱正在播报的语音，可选播 TTS 提示
   */
  private async interruptBroadcast(accountId: string, deviceId: string): Promise<void> {
    songloft.log.info('[VoiceEngine] Interrupting speaker broadcast before search');
    try {
      await this.minaService.stopPlay(accountId, deviceId);
    } catch (e) {
      songloft.log.warn('[VoiceEngine] Failed to interrupt broadcast: ' + String(e));
    }

    const config = await this.configManager.getConfig();
    if (config.interrupt_tts_hint_enabled) {
      const text = config.interrupt_tts_hint_text || '正在搜索，请稍候';
      try {
        await new Promise(resolve => setTimeout(resolve, 300));
        await this.minaService.textToSpeech(accountId, deviceId, text);
      } catch (e) {
        songloft.log.warn('[VoiceEngine] Failed to play TTS hint: ' + String(e));
      }
    }
  }

  // ===== 辅助方法 =====

  /**
   * 从设备ID反查 accountId
   * 遍历所有账号的设备列表，找到包含该 deviceId 的账号
   */
  private async findAccountForDevice(deviceId: string): Promise<string | null> {
    const accounts = await this.accountManager.getAccounts();
    for (const acc of accounts) {
      const devices = await this.configManager.getDevices(acc.id);
      if (devices.some(d => d.device_id === deviceId)) {
        return acc.id;
      }
    }
    return null;
  }

  /**
   * 从字符串中提取数字
   * 支持阿拉伯数字和中文数字
   */
  private extractNumber(s: string): number | null {
    if (!s) return null;

    // 剥离"百分之"前缀，避免"百"被误解析为数字 100
    const cleaned = s.replace(/百分之/g, '');

    const target = cleaned || s;

    // 优先尝试阿拉伯数字
    const numMatch = target.match(/\d+/);
    if (numMatch) {
      return parseInt(numMatch[0], 10);
    }

    // 尝试中文数字
    const cnMatch = target.match(/[零一二三四五六七八九十百千万]+/);
    if (cnMatch) {
      return this.parseChineseNumber(cnMatch[0]);
    }

    return null;
  }

  /**
   * 将中文数字字符串转换为阿拉伯数字
   * 支持：五十、一百、三十五、二百五十、十五 等常见表达
   */
  private parseChineseNumber(s: string): number | null {
    if (!s) return null;

    const digitMap: Record<string, number> = {
      '零': 0, '一': 1, '二': 2, '三': 3, '四': 4,
      '五': 5, '六': 6, '七': 7, '八': 8, '九': 9,
      '十': 10, '百': 100, '千': 1000, '万': 10000,
    };

    const chars = Array.from(s);
    let result = 0;
    let current = 0;
    let hasDigit = false;

    for (const ch of chars) {
      const val = digitMap[ch];
      if (val === undefined) {
        return null;
      }
      hasDigit = true;

      if (val >= 10) {
        // 遇到单位（十、百、千、万）
        if (current === 0) {
          // "十五" 省略了 "一" 的情况
          current = 1;
        }
        result += current * val;
        current = 0;
      } else {
        current = val;
      }
    }

    // 处理末尾的数字（如 "五十三" 中的 "三"）
    result += current;

    if (!hasDigit) return null;
    return result;
  }
}
