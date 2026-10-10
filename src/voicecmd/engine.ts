// MIoT 智能音箱插件 - 语音口令引擎
// 翻译自 Go 源码: plugins/songloft-plugin-xiaomi/voicecmd/engine.go
// 匹配用户语音指令并执行对应动作（播放歌单/歌曲、切歌、停止、音量、播放模式）

/// <reference types="@songloft/plugin-sdk" />

import { ConfigManager } from '../config/manager';
import { AccountManager } from '../account/manager';
import { MinaService } from '../service/service';
import { PlaylistManagerMap, resolvePlaylistResumeStart } from '../player/manager';
import { IndexingManager } from '../indexing/manager';
import { GroupCoordinator } from '../group/coordinator';
import { URLBuilder } from '../player/url_builder';
import { AIAnalyzer } from './ai_analyzer';
import { OnlineSearcher } from './online_searcher';
import { updateDeviceStatusCache } from '../handlers/playlist';
import { callHostAPI, getHostAPIBaseUrl } from '../utils/http';
import { findFavoritesPlaylist } from '../utils/favorites';
import { MemoryService } from '../memory';
import { SleepTimer, parseTimeDuration, parseSongsCount, parseSongIndex, detectSleepTimerMode, formatRemaining } from '../sleep_timer';
import type { PlaylistManager } from '../player/manager';
import type { SongLocation, ArtistSongLocation } from '../indexing/manager';
import type { MemoryRecord } from '../memory';
import type { OnlineSearchResult } from './online_searcher';
import type { ConversationMessage, VoiceCommand, PlayMode, AIAnalysisResult, SearchPriority } from '../types';
import { getDefaultVoiceCommands } from './defaults';
export { getDefaultVoiceCommands } from './defaults';

// ===== 类型定义 =====

/** 口令匹配结果 */
interface MatchResult {
  command: VoiceCommand;
  keyword: string;
  argument: string;
}

interface SmartResumeTask {
  accountId: string;
  deviceId: string;
  revision: number;
  startedAt: number;
  position: number;
}

const SMART_RESUME_INITIAL_DELAY_MS = 1000;
const SMART_RESUME_FAST_INTERVAL_MS = 1000;
const SMART_RESUME_FAST_QUERIES = 4;
const SMART_RESUME_NORMAL_INTERVAL_MS = 5000;

/**
 * 独立歌曲候选：不在任何歌单里的歌，由 findStandaloneSongByName 经 songs.getById 拿到完整字段。
 * type 决定电台转码是否生效、duration 决定能否注册自动切歌定时器，两者都不能丢
 * （songloft-org/songloft-plugin-miot#62）。
 */
interface StandaloneSongCandidate {
  id: number;
  url: string;
  title: string;
  artist: string;
  album?: string;
  type?: string;
  duration?: number;
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

/**
 * 并行搜歌竞速里的一个待 settle 任务。
 * slot 是任务在原数组里的下标：settle 后按 slot 精确剔除，保证同一个候选不会被试第二次。
 */
type PendingCandidateTask = {
  slot: number;
  promise: Promise<{ slot: number; candidate: SongSearchCandidate | null }>;
};

/**
 * 竞速一轮的产出：胜出候选 + **尚未 settle 的其余任务**。
 * rest 交回调用方，是为了让 parallel 模式在「胜出候选播不出来」时接着试别的源
 * （见 executePlaySongParallel 的注释）。
 */
type SongCandidateRaceResult = {
  candidate: SongSearchCandidate;
  rest: PendingCandidateTask[];
};

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
  'play_artist': 1,
  'play_song': 1,
  'play_playlist': 2,
  'play_index': 2,
  'set_play_mode': 3,
  'set_volume': 4,
  'favorite': 5,
  'next': 6,
  'previous': 7,
  'sleep_timer': 7,
  'cancel_sleep_timer': 7,
  'query_sleep_timer': 7,
  'resume': 8,
  'stop': 8,
};

/** 跳字模糊匹配：关键词中间最多允许插入的字符数 */
const FUZZY_MAX_GAP = 4;

/** 跳字模糊匹配：关键词最小 rune 长度（2 字以内控制词如"停止/切歌"不参与，避免误触发） */
const FUZZY_MIN_KEYWORD_LEN = 3;

/** 语音请求到达时给后台索引刷新的短等待窗口。 */
const INDEX_READY_WAIT_MS = 5000;

/** 本地独立歌曲 URL 健康检查超时（ms），利用 TTS 播报窗口期异步验证，不增加用户感知延迟。 */
const URL_HEALTH_CHECK_TIMEOUT_MS = 3000;

// resume 必须进入真实语音消息的固定控制匹配，否则停止后的「继续播放」无法恢复自动切歌（songloft-org/songloft#490）。
const FIXED_CONTROL_COMMAND_TYPES = new Set(['set_play_mode', 'set_volume', 'favorite', 'next', 'previous', 'resume', 'stop', 'sleep_timer', 'cancel_sleep_timer', 'query_sleep_timer', 'play_index']);
const SEARCH_COMMAND_TYPES = new Set(['play_song', 'play_playlist', 'play_artist']);
const BUILTIN_STOP_KEYWORDS = ['暂停播放', '停止播放', '暂停音乐', '停一下', 'pause', 'stop', '暂停'];

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
  private groupCoordinator?: GroupCoordinator;
  private memoryInitialized: boolean = false;
  private enabled: boolean = false;
  private resumeTimer: any = null;
  private resumeTask: SmartResumeTask | null = null;
  private sleepTimers: Map<string, SleepTimer> = new Map();

  constructor(
    configManager: ConfigManager,
    accountManager: AccountManager,
    minaService: MinaService,
    playlistManagerMap: PlaylistManagerMap,
    indexingManager: IndexingManager,
    aiAnalyzer?: AIAnalyzer,
    memoryService?: MemoryService,
    groupCoordinator?: GroupCoordinator,
  ) {
    this.configManager = configManager;
    this.accountManager = accountManager;
    this.minaService = minaService;
    this.playlistManagerMap = playlistManagerMap;
    this.indexingManager = indexingManager;
    this.aiAnalyzer = aiAnalyzer || new AIAnalyzer();
    this.groupCoordinator = groupCoordinator;
    this.onlineSearcher = new OnlineSearcher(configManager, groupCoordinator);
    this.memoryService = memoryService || new MemoryService();
  }

  // ===== 公开方法 =====

  /** 启用/禁用语音口令引擎 */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.cancelPendingResume();
    songloft.log.info(`[VoiceEngine] ${enabled ? 'Enabled' : 'Disabled'}`);
  }

  /** 是否已启用 */
  isEnabled(): boolean {
    return this.enabled;
  }

  /** 获取指定设备的 sleep timer 状态 */
  getSleepTimerState(accountId: string, deviceId: string): { active: boolean; mode: string; remaining: number; total: number } {
    const key = this.getSleepTimerKey(accountId, deviceId);
    const timer = this.sleepTimers.get(key);
    if (!timer || !timer.isActive()) {
      return { active: false, mode: 'time', remaining: 0, total: 0 };
    }
    const state = timer.getState();
    return { active: state.active, mode: state.mode, remaining: state.remaining, total: state.total };
  }

  /** 取消指定设备的 sleep timer */
  cancelSleepTimer(accountId: string, deviceId: string): boolean {
    const key = this.getSleepTimerKey(accountId, deviceId);
    const timer = this.sleepTimers.get(key);
    if (timer && timer.isActive()) {
      timer.cancel();
      const pm = this.playlistManagerMap.get(accountId, deviceId);
      if (pm) pm.setOnAdvanceHook(undefined);
      return true;
    }
    return false;
  }

  /** 设置指定设备的 sleep timer，供播放器界面调用。 */
  setSleepTimer(
    accountId: string,
    deviceId: string,
    mode: 'time' | 'songs',
    value: number,
  ): { active: boolean; mode: string; remaining: number; total: number } {
    const max = mode === 'time' ? 999 : 99;
    if (!Number.isInteger(value) || value < 1 || value > max) {
      throw new Error(`value must be an integer between 1 and ${max}`);
    }
    this.setupSleepTimer(accountId, deviceId, mode, value);
    return this.getSleepTimerState(accountId, deviceId);
  }

  /**
   * 处理新对话消息（由 ConversationMonitor 回调触发）
   * @param msg - 对话消息
   */
  async handleMessage(msg: ConversationMessage): Promise<void> {
    // 从 AskMessage 中提取 query
    const query = this.extractQuery(msg);
    if (!query || query.trim() === '') {
      return;
    }

    // 整点续播独立于语音口令开关；新对话仍须立即作废旧任务。
    this.playlistManagerMap.cancelHourlyResumes(msg.device_id);
    if (!this.enabled) return;

    // 不能等账号查询、规则匹配或 AI 请求结束后才取消语音恢复。
    this.cancelPendingResume(msg.account_id, msg.device_id);

    // 找到设备对应的 accountId
    const accountId = await this.findAccountForDevice(msg.device_id);
    if (!accountId) {
      songloft.log.warn(`[VoiceEngine] No account found for device: ${msg.device_id}`);
      return;
    }

    // 控制与搜索命令共同匹配，避免控制词截走歌名/歌单名；胜出的控制仍先于 memory 和 AI 执行。
    songloft.log.info(`[VoiceEngine] [Rule] Matching query="${query}"`);
    const ruleResult = await this.matchRuleCommand(query);
    const fixedResult = ruleResult && FIXED_CONTROL_COMMAND_TYPES.has(ruleResult.command.type) ? ruleResult : null;
    if (fixedResult) {
      songloft.log.info(`[VoiceEngine] [Rule] → Matched fixed control: type=${fixedResult.command.type} keyword="${fixedResult.keyword}" argument="${fixedResult.argument}"`);
      await this.executeCommand(fixedResult, accountId, msg.device_id, query);
      return;
    }

    let memoryEnabled = false;
    try {
      const pluginConfig = await this.configManager.getConfig();
      memoryEnabled = pluginConfig.voice_memory_enabled;
      await this.memoryService.setMaxRecords(pluginConfig.voice_memory_max_records);
      if (memoryEnabled) {
        const memoryHandled = await this.tryHandleMemory(query, accountId, msg.device_id);
        if (memoryHandled) {
          return;
        }
      } else {
        songloft.log.info('[VoiceMemoryV2] miss reason="disabled"');
      }
    } catch (error) {
      memoryEnabled = false;
      songloft.log.warn('[VoiceMemoryV2] error fallback stage="config_or_memory" error="' + String(error) + '"');
    }

    // 歌曲/歌单规则匹配
    songloft.log.info(`[VoiceEngine] [Rule] Matching search query="${query}"`);
    const result = ruleResult && SEARCH_COMMAND_TYPES.has(ruleResult.command.type) ? ruleResult : null;
    if (result) {
      songloft.log.info(`[VoiceEngine] [Rule] → Matched search: type=${result.command.type} keyword="${result.keyword}" argument="${result.argument}"`);

      // 执行口令
      const playedSong = await this.executeCommand(result, accountId, msg.device_id);
      if (memoryEnabled && (result.command.type === 'play_song' || result.command.type === 'play_artist') && playedSong) {
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
        if (aiResult.confidence !== 'low' && aiResult.action !== 'unknown') {
          songloft.log.info(`[VoiceEngine] [AI] → Executing fallback (high confidence, action=${aiResult.action})`);
          const playedSong = await this.executeAIResult(aiResult, accountId, msg.device_id);
          if (memoryEnabled && (aiResult.action === 'play_song' || aiResult.action === 'play_artist') && playedSong) {
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
        songloft.log.info(`[VoiceMemoryV2] miss query="${query}" reason="memory_not_initialized"`);
        return false;
      }

      let record = this.memoryService.findByQuery(query);
      let matchMode: 'exact' | 'entity_hit' = 'exact';
      let canonicalKey: string | undefined;
      let score: number | undefined;
      let reason = 'v1_normalized_query';

      if (record) {
        songloft.log.info(`[VoiceMemoryV2] exact_hit query="${query}" id="${record.id}"`);
      } else {
        const resolved = this.memoryService.resolveEntity(query);
        if (resolved.status === 'ambiguous') {
          songloft.log.info(`[VoiceMemoryV2] ambiguous query="${query}" candidates=${resolved.candidateCount ?? 0} reason="${resolved.reason || 'ambiguous'}"`);
          void this.memoryService.recordAmbiguity(query, resolved).catch(error => {
            songloft.log.warn('[VoiceMemoryV3] error fallback stage="record_ambiguous" error="' + String(error) + '"');
          });
          return false;
        }
        if (resolved.status !== 'entity_hit' || !resolved.record) {
          songloft.log.info(`[VoiceMemoryV2] miss query="${query}" reason="${resolved.reason || 'no_candidate'}" score=${(resolved.score ?? 0).toFixed(2)}`);
          return false;
        }
        record = resolved.record;
        matchMode = 'entity_hit';
        canonicalKey = resolved.canonicalKey;
        score = resolved.score;
        reason = resolved.reason || 'entity_match';
      }

      if (record.type !== 'play_song') {
        songloft.log.info(`[VoiceMemoryV2] miss query="${query}" reason="unsupported_type_${record.type}"`);
        return false;
      }

      const playedSong = await this.executeMemorySong(record, query, accountId, deviceId);
      if (!playedSong) {
        void this.memoryService.recordFailure(query, record.id).catch(error => {
          songloft.log.warn('[VoiceMemoryV2] error fallback stage="record_failure" error="' + String(error) + '"');
        });
        songloft.log.warn(`[VoiceMemoryV2] fallback query="${query}" reason="play_failed" id="${record.id}"`);
        return false;
      }

      if (matchMode === 'entity_hit') {
        songloft.log.info(`[VoiceMemoryV2] entity_hit query="${query}" song="${playedSong.songName}" artist="${playedSong.artist}" score=${(score ?? 0).toFixed(2)} reason="${reason}" canonicalKey="${canonicalKey || ''}"`);
        this.queueMemorySuccess(query, playedSong, record.id, reason);
      } else {
        if (record.recordVersion !== 2 || !record.canonicalKey) {
          this.queueMemorySuccess(query, playedSong, record.id, 'v1_exact');
        } else {
          this.memoryService.queueHit(record.id, 'v1_exact');
        }
      }
      return true;
    } catch (error) {
      songloft.log.warn('[VoiceMemoryV2] error fallback stage="play" error="' + String(error) + '"');
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
        const pm = await this.prepareMemoryPlayback(accountId, deviceId);
        // 展开完整 song 后再覆盖标题/歌手：type / duration 要留着，否则电台转码判定与
        // 自动切歌定时器都会失效（songloft-org/songloft-plugin-miot#62）。
        const standalone = {
          ...(song as any),
          id: song.id,
          url: song.url,
          title: song.title || songName,
          artist: song.artist || record.artist || '',
        };
        const played = await this.playStandaloneSong(standalone, pm);
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

  private queueMemorySuccess(query: string, song: PlayedSong, matchedRecordId?: string, memoryHitReason?: string): void {
    songloft.log.info(`[VoiceMemoryV2] lazy_migrate queued query="${query}" song="${song.songName}"`);
    void this.memoryService.recordSuccess({
      query,
      type: 'play_song',
      songId: song.songId,
      songName: song.songName,
      artist: song.artist,
      playlistId: song.playlistId,
      playlistName: song.playlistName,
      songIndex: song.songIndex,
      matchedRecordId,
      memoryHitReason,
    }).then(saved => {
      if (saved) {
        songloft.log.info(`[VoiceMemoryV2] lazy_migrate done query="${query}"`);
      } else {
        songloft.log.warn(`[VoiceMemoryV2] lazy_migrate failed query="${query}" reason="save_returned_false"`);
      }
    }).catch(error => {
      songloft.log.warn(`[VoiceMemoryV2] error fallback stage="record_success" error="${String(error)}"`);
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
      if (aiResult && aiResult.confidence !== 'low' && aiResult.action !== 'unknown') {
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
    const result = await this.matchRuleCommand(query);
    songloft.log.info(`[VoiceEngine] [Test] rule match done in ${Date.now() - ruleStart}ms → ${result ? `type=${result.command.type} keyword="${result.keyword}" argument="${result.argument}"` : 'no match'}`);
    if (!result) {
      return { matched: false, source: 'rule', executed: false, note: '未匹配到任何口令' };
    }
    const previewStart = Date.now();
    const search = await this.previewSearch(result.command.type, result.argument);
    songloft.log.info(`[VoiceEngine] [Test] previewSearch done in ${Date.now() - previewStart}ms`);
    const execStart = Date.now();
    await this.executeCommand(result, accountId, deviceId, query);
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
    if (type === 'play_artist') {
      const cleanArtist = this.stripArtistSuffix(argument || '');
      if (!cleanArtist) {
        return { kind: 'song', found: false, detail: '（无歌手名）' };
      }
      if (!(await this.indexingManager.waitForReady(INDEX_READY_WAIT_MS))) {
        return { kind: 'song', found: false, detail: '索引未就绪，无法预览搜索结果' };
      }
      const locs = this.indexingManager.findSongsByArtist(cleanArtist);
      if (locs.length > 0) {
        return { kind: 'song', found: true, detail: `歌手「${cleanArtist}」共 ${locs.length} 首歌曲（随机播放）` };
      }
      return { kind: 'song', found: false, detail: `未找到歌手「${cleanArtist}」的歌曲` };
    }
    if (type === 'play_playlist') {
      if (!(argument || '').trim()) {
        return { kind: 'playlist', found: false, detail: '（无歌单名，将使用默认歌单/恢复播放）' };
      }
      if (!(await this.indexingManager.waitForReady(INDEX_READY_WAIT_MS))) {
        return { kind: 'playlist', found: false, detail: '索引未就绪，无法预览搜索结果' };
      }
      const pl = await this.indexingManager.findPlaylistByNameWithRefresh(argument);
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
    if (aiResult.action === 'play_artist') {
      return this.previewSearch('play_artist', aiResult.params?.artist || '');
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

  /** 真实语音与规则测试共用匹配；内置停止仅在所有已启用口令都未命中时兜底。 */
  private async matchRuleCommand(query: string): Promise<MatchResult | null> {
    return await this.matchCommand(query) ?? this.matchBuiltinStopCommand(query);
  }

  /**
   * 匹配语音口令
   * 按优先级遍历所有已启用的口令，使用包含匹配
   * @param query - 用户说的话
   * @returns 匹配结果，null 表示未匹配
   */
  private async matchCommand(query: string): Promise<MatchResult | null> {
    const commands = await this.configManager.getVoiceCommands();
    if (commands.length === 0) {
      return null;
    }

    const enabledCommands = commands
      .filter(cmd => cmd.enabled)
      .map(cmd => ({
        cmd,
        priority: COMMAND_PRIORITY[cmd.type] ?? 99,
      }));

    if (enabledCommands.length === 0) {
      return null;
    }

    // 最早出现的搜索口令后面是名称参数，不能再把其中的文字当作新的控制/搜索命令。
    // 同一起点仍按最长关键词和业务优先级选择（如“播放”与“播放歌单”）。
    let searchStart = Infinity;
    let argumentStart = Infinity;
    let searchKeywordLen = 0;
    for (const { cmd } of enabledCommands) {
      if (!SEARCH_COMMAND_TYPES.has(cmd.type)) continue;
      for (const keyword of cmd.keywords) {
        if (!keyword) continue;
        const idx = query.indexOf(keyword);
        const kwLen = Array.from(keyword).length;
        if (idx >= 0 && (idx < searchStart || (idx === searchStart && kwLen > searchKeywordLen))) {
          searchStart = idx;
          argumentStart = idx + keyword.length;
          searchKeywordLen = kwLen;
        }
      }
    }

    // 跨优先级最长关键词匹配：遍历所有命令，取全局最长匹配，长度相同时高优先级优先。
    // 防止短关键词（如"播放"）窃取更长关键词（如"播放歌单"）的匹配。
    let bestMatch: MatchResult | null = null;
    let bestKeywordLen = 0;
    let bestPriority = 99;

    for (const item of enabledCommands) {
      for (const keyword of item.cmd.keywords) {
        if (!keyword) continue;
        const idx = query.indexOf(keyword);
        if (idx >= 0 && idx < argumentStart) {
          // 序号口令必须包含完整有效的序号，不能把“播放第一周”等名称当作跳播。
          if (item.cmd.type === 'play_index' && parseSongIndex(query.slice(idx)) <= 0) continue;
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
      // “播放第”不能跨过“歌单/歌曲”等文字，否则会抢占名称中含“第N”的搜索口令。
      if (item.cmd.type === 'play_index') continue;
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
  private async executeCommand(result: MatchResult, accountId: string, deviceId: string, query?: string): Promise<PlayedSong | null> {
    const pm = this.playlistManagerMap.get(accountId, deviceId);
    const wasPlaying = pm?.isPlaying() ?? false;
    let playedSong: PlayedSong | null = null;

    switch (result.command.type) {
      case 'play_playlist':
        await this.executePlayPlaylist(result.argument, accountId, deviceId);
        break;
      case 'play_index':
        await this.executePlayIndex(`${result.keyword}${result.argument}`, accountId, deviceId);
        break;
      case 'play_song':
        playedSong = await this.executePlaySong(result.argument, accountId, deviceId);
        break;
      case 'play_artist':
        playedSong = await this.executePlayArtist(result.argument, accountId, deviceId);
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
      case 'resume':
        await this.executeResume(accountId, deviceId);
        break;
      case 'favorite':
        await this.executeFavorite(accountId, deviceId, result.command.param || 'add');
        break;
      case 'sleep_timer':
        await this.executeSleepTimer(query || result.argument, accountId, deviceId);
        break;
      case 'cancel_sleep_timer':
        await this.executeCancelSleepTimer(accountId, deviceId);
        break;
      case 'query_sleep_timer':
        await this.executeQuerySleepTimer(accountId, deviceId);
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
      case 'play_artist': {
        const artist = result.params.artist || result.params.name || '';
        if (!artist) {
          songloft.log.warn('[VoiceEngine] [AI] play_artist: no artist name');
          return null;
        }
        playedSong = await this.executePlayArtist(artist, accountId, deviceId);
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
      case 'play_index': {
        const idx = result.params.index;
        if (!idx || idx <= 0) {
          songloft.log.warn('[VoiceEngine] [AI] play_index: invalid index');
          return null;
        }
        await this.executePlayIndexNumber(idx, accountId, deviceId);
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
      /*case 'set_volume': {
        const direction = result.params.direction || 'absolute';
        const volume = result.params.volume;
        await this.executeSetVolume(accountId, deviceId, direction, volume !== undefined ? String(volume) : '');
        break;
      }*/
      case 'next':
        await this.executeNext(accountId, deviceId);
        break;
      case 'previous':
        await this.executePrevious(accountId, deviceId);
        break;
      case 'stop':
        await this.executeStop(accountId, deviceId);
        break;
      case 'resume':
        await this.executeResume(accountId, deviceId);
        break;
      case 'favorite':
        await this.executeFavorite(accountId, deviceId, result.params?.action || 'add');
        break;
      case 'sleep_timer':
        await this.executeSleepTimerFromAI(result, accountId, deviceId);
        break;
      case 'cancel_sleep_timer':
        await this.executeCancelSleepTimer(accountId, deviceId);
        break;
      case 'query_sleep_timer':
        await this.executeQuerySleepTimer(accountId, deviceId);
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
    const isNonPlaybackCommand = commandType === 'set_volume' || commandType === 'set_play_mode' || commandType === 'favorite';
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
      const ok = await pm.next();
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

    // 模糊匹配歌单（miss 时按需刷新索引，捡回运行期间新建的歌单 #84）
    const matchedPlaylist = await this.indexingManager.findPlaylistByNameWithRefresh(playlistName);
    if (!matchedPlaylist) {
      const indexStatus = this.indexingManager.getStatus();
      songloft.log.warn(`[VoiceEngine] Playlist not found: ${playlistName} (indexReady=${indexStatus.ready} playlists=${indexStatus.playlist_count} refreshing=${indexStatus.is_refreshing})`);
      await this.minaService.textToSpeech(accountId, deviceId, `未找到歌单：${playlistName}`);
      return;
    }

    songloft.log.info(`[VoiceEngine] Matched playlist: ${matchedPlaylist.name} (id=${matchedPlaylist.id})`);

    // 获取设备配置中的播放模式
    let playMode: PlayMode = 'order';

    const devices = await this.configManager.getDevices(accountId);
    const devCfg = devices.find(d => d.device_id === deviceId);
    if (devCfg && devCfg.play_mode) {
      playMode = devCfg.play_mode as PlayMode;
    }

    // 起始位置查「每设备 × 每歌单」的进度表：中途切去别的歌单再切回来，这个歌单
    // 依然从自己上次那首接着播。按 song_id 定位，歌单排序变化/增删歌后不会串歌。
    const resume = await resolvePlaylistResumeStart(this.configManager, pm.getPrimary(), matchedPlaylist.id);
    const startIndex = resume ? resume.songIndex : 0;

    // 播放歌单
    pm.setAnnounceOnSongChange(true);
    const ok = resume && resume.songId > 0
      ? await pm.playPlaylistFromSong(matchedPlaylist.id, resume.songId, playMode, startIndex)
      : await pm.play(matchedPlaylist.id, startIndex, playMode);
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
        pm.setAnnounceOnSongChange(true);
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
   * 执行"播放第 N 首"：从原始 query 中解析序号后跳到当前歌单/临时列表的对应位置。
   * 序号从 1 起；无正在播放的歌单或越界则 TTS 提示，不改变播放状态。
   */
  private async executePlayIndex(query: string, accountId: string, deviceId: string): Promise<void> {
    const target = parseSongIndex(query);
    if (target <= 0) {
      songloft.log.warn(`[VoiceEngine] play_index: 无法识别序号 query="${query}"`);
      await this.minaService.textToSpeech(accountId, deviceId, '抱歉，无法识别序号');
      return;
    }
    await this.executePlayIndexNumber(target, accountId, deviceId);
  }

  /**
   * 按 1 起序号跳到当前歌单/临时列表的第 N 首。
   * 走既有 pm 而不 getOrCreate：跳位只对已在播的歌单有意义，从零态里创建一个空 pm 不合理。
   */
  private async executePlayIndexNumber(target: number, accountId: string, deviceId: string): Promise<void> {
    const pm = this.playlistManagerMap.get(accountId, deviceId);
    if (!pm || !pm.hasPlaylist()) {
      songloft.log.warn('[VoiceEngine] play_index: 当前没有正在播放的歌单');
      await this.minaService.textToSpeech(accountId, deviceId, '当前没有正在播放的歌单，无法跳转');
      return;
    }
    const total = pm.getTotalSongs();
    if (target > total) {
      songloft.log.warn(`[VoiceEngine] play_index: 越界 target=${target} total=${total}`);
      await this.minaService.textToSpeech(accountId, deviceId, `歌单只有${total}首`);
      return;
    }
    this.cancelPendingResume();
    await this.interruptBroadcast(accountId, deviceId);
    const ok = await pm.playAtIndex(target - 1);
    if (ok) {
      songloft.log.info(`[VoiceEngine] play_index success: index=${target} total=${total}`);
    } else {
      songloft.log.error(`[VoiceEngine] play_index failed: index=${target}`);
      await this.minaService.textToSpeech(accountId, deviceId, '跳转失败');
    }
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
        const ok = await pm.next();
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
    // warn 级：这是搜歌链路的入口锚点。插件日志默认都是 info，而宿主 log level 常被设为
    // error/warn，导出的日志连一条插件记录都没有，问题完全不可定位
    // （songloft-org/songloft-plugin-miot#62 的排查就卡在这）。
    songloft.log.warn(`[VoiceEngine] Play song priority=${priority} keyword="${songName}" localTerm="${searchTerm}"`);

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

  private stripArtistSuffix(argument: string): string {
    return argument
      .replace(/的?(歌曲|歌儿|歌|音乐|曲子|曲|所有歌|全部歌)\s*$/u, '')
      .trim();
  }

  private async executePlayArtist(artistName: string, accountId: string, deviceId: string): Promise<PlayedSong | null> {
    this.cancelPendingResume();
    const pm = await this.playlistManagerMap.getOrCreate(accountId, deviceId);

    const cleanArtist = this.stripArtistSuffix(artistName);
    if (!cleanArtist) {
      songloft.log.warn('[VoiceEngine] play_artist: empty artist name after cleanup');
      return null;
    }

    pm.prepareForNewPlayback();

    try {
      await this.minaService.stopPlay(accountId, deviceId);
    } catch (e) {
      songloft.log.warn('[VoiceEngine] Failed to interrupt broadcast: ' + String(e));
    }

    if (!(await this.indexingManager.waitForReady(INDEX_READY_WAIT_MS))) {
      songloft.log.warn('[VoiceEngine] Index not ready for play_artist');
      await this.minaService.textToSpeech(accountId, deviceId, `索引未就绪，无法播放`);
      return null;
    }

    // findSongsByArtist 只遍历歌单歌曲缓存，缓存未就绪时必然返回空、被误报成
    // 「未找到该歌手的歌曲」（songloft-org/songloft-plugin-miot#62 的同源表现）。
    await this.indexingManager.waitForPlaylistCache();

    const artistLocs = this.indexingManager.findSongsByArtist(cleanArtist);
    if (artistLocs.length === 0) {
      songloft.log.warn(`[VoiceEngine] No songs found for artist: ${cleanArtist} (playlistCacheReady=${this.indexingManager.isPlaylistCacheReady()})`);
      await this.minaService.textToSpeech(accountId, deviceId, `未找到歌手${cleanArtist}的歌曲`);
      return null;
    }

    songloft.log.info(`[VoiceEngine] play_artist: found ${artistLocs.length} songs for "${cleanArtist}"`);

    const byPlaylist = new Map<number, Set<number>>();
    for (const loc of artistLocs) {
      let ids = byPlaylist.get(loc.playlistId);
      if (!ids) {
        ids = new Set();
        byPlaylist.set(loc.playlistId, ids);
      }
      ids.add(loc.songId);
    }

    const fullSongs: any[] = [];
    const seenIds = new Set<number>();
    for (const [plId, songIds] of byPlaylist) {
      try {
        const plSongs = await songloft.playlists.getSongs(plId, { limit: 100000 });
        if (!plSongs || !Array.isArray(plSongs)) continue;
        for (const s of plSongs) {
          if (songIds.has(s.id) && !seenIds.has(s.id)) {
            seenIds.add(s.id);
            fullSongs.push(s);
          }
        }
      } catch (e) {
        songloft.log.warn(`[VoiceEngine] play_artist: failed to load playlist ${plId}: ${String(e)}`);
      }
    }

    if (fullSongs.length === 0) {
      songloft.log.warn(`[VoiceEngine] play_artist: no playable songs found for "${cleanArtist}"`);
      await this.minaService.textToSpeech(accountId, deviceId, `加载歌手${cleanArtist}的歌曲失败`);
      return null;
    }

    const startIndex = Math.floor(Math.random() * fullSongs.length);

    pm.setAnnounceOnSongChange(true);
    const ok = await pm.playWithSongs(fullSongs as any, startIndex, 'random', '歌手: ' + cleanArtist, cleanArtist);
    if (!ok) {
      songloft.log.error(`[VoiceEngine] play_artist failed for "${cleanArtist}"`);
      return null;
    }

    songloft.log.info(`[VoiceEngine] play_artist success: "${cleanArtist}" ${fullSongs.length} songs, start=${startIndex}`);
    const currentSong = pm.getCurrentSong();
    return {
      songName: currentSong?.title || cleanArtist,
      artist: currentSong?.artist || cleanArtist,
    };
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

  /**
   * 响应优先（parallel）：本地与外部搜索同时开跑，谁先给出可用候选就先播谁。
   *
   * 胜出候选**播放失败时要接着试其余候选**，语义与 executePlaySongExternalFirst 的回落对齐：
   * 旧实现拿到一个候选就 all-in，设备拒绝 / 直链失效 / 上游挂了都会让用户直接听到
   * 「未找到歌曲」，而另一个源可能明明是好的——三种策略里只有 parallel 缺这一步。
   *
   * 回落用的是**同一批已经在跑的任务**（firstSuccessfulSongCandidate 把未 settle 的任务原样
   * 交回来），不是重新调 findXxxSongCandidate：重搜会二次打外部搜索接口，更要紧的是
   * external_search 的播放路径有导入副作用（playSearchResult → importSong + 追加歌单 + 增量
   * 索引），重搜后同一首歌可能被导入两遍。每个 slot 在 settle 时即从 pending 剔除，
   * 循环次数上界 = 任务数，每个候选最多只试一次，不存在循环重试。
   *
   * 回落时**刻意不再** pm.prepareForNewPlayback() / minaService.stopPlay()：executePlaySong
   * 进搜索前已经打断过一次，这里重复打断会掐掉上一个候选可能已经开始出声的流。
   */
  private async executePlaySongParallel(
    songName: string,
    searchTerm: string,
    hint: { title: string; artist?: string; duration?: number } | null,
    pm: PlaylistManager,
    accountId: string,
    deviceId: string,
  ): Promise<PlayedSong | null> {
    let pending = this.pendingCandidateTasks([
      this.findLocalSongCandidate(searchTerm),
      this.findExternalSongCandidate(songName, hint),
    ]);

    // 上一个试过但播放失败的源；null 表示当前这次是首选而非回落。
    let failedSource: SongSearchCandidate['source'] | null = null;

    while (pending.length > 0) {
      const race = await this.firstSuccessfulSongCandidate(pending);
      if (!race) {
        break;
      }
      pending = race.rest;

      if (failedSource === null) {
        // warn 级：这一行直接回答「为什么播的是外部搜索结果而不是本地歌曲」。
        songloft.log.warn(`[VoiceEngine] Parallel search selected source=${race.candidate.source}`);
      } else {
        // warn 级：回落必须能只凭 warn 日志看出「从哪个源换到哪个源、为什么换」。插件日志
        // 默认走 info，而宿主 log level 常被设成 error/warn，导出的日志里一条插件记录都没有
        // （songloft-org/songloft-plugin-miot#62 的排查就卡在这）。
        songloft.log.warn(`[VoiceEngine] Parallel fallback: source=${failedSource} found a candidate but failed to play, retrying with source=${race.candidate.source} keyword="${songName}"`);
      }

      const played = await this.playSongCandidate(race.candidate, pm, searchTerm, songName, accountId, deviceId);
      if (played) {
        return played;
      }
      failedSource = race.candidate.source;
    }

    if (failedSource !== null) {
      songloft.log.warn(`[VoiceEngine] Parallel search exhausted all sources, last failed source=${failedSource} keyword="${songName}"`);
    }
    return null;
  }

  /**
   * 把搜索任务包成带 slot 的竞速单元。搜索任务自身抛异常按「无候选」处理（只 warn 不上抛），
   * 否则一个源挂掉会连带另一个源已经拿到的候选一起丢掉。
   */
  private pendingCandidateTasks(
    tasks: Array<Promise<SongSearchCandidate | null>>,
  ): PendingCandidateTask[] {
    return tasks.map((task, slot) => ({
      slot,
      promise: task
        .then(candidate => ({ slot, candidate }))
        .catch(e => {
          songloft.log.warn('[VoiceEngine] Search task failed: ' + String(e));
          return { slot, candidate: null as SongSearchCandidate | null };
        }),
    }));
  }

  /**
   * 竞速取一个可用候选，并把尚未 settle 的其余任务随结果交回调用方（供播放失败时回落）。
   *
   * 不做成 async generator「按 settle 顺序逐个 yield」：URL 体检判死的候选是要**丢弃**而不是
   * yield 的（一次调用可能吃掉多个 settle），生成器表达这段就得把体检逻辑漏到调用方；
   * 而且 async generator 依赖 Symbol.asyncIterator，QuickJS 沙盒里不值得为此赌一把。
   * 传入/返回同一种 PendingCandidateTask[] 则可被反复调用，控制流全留在调用方一个 while 里。
   */
  private async firstSuccessfulSongCandidate(
    tasks: PendingCandidateTask[],
  ): Promise<SongCandidateRaceResult | null> {
    let pending = tasks;

    while (pending.length > 0) {
      const settled = await Promise.race(pending.map(p => p.promise));
      const rest = pending.filter(p => p.slot !== settled.slot);
      if (settled.candidate) {
        if (await this.isCandidateUrlHealthy(settled.candidate)) {
          return { candidate: settled.candidate, rest };
        }
        // URL 不健康：有其他候选在跑则继续等，没有则死马当活马医
        if (rest.length === 0) {
          songloft.log.warn(`[VoiceEngine] Candidate ${settled.candidate.source} URL unhealthy, no fallback available, will try anyway`);
          return { candidate: settled.candidate, rest };
        }
        songloft.log.warn(`[VoiceEngine] Candidate ${settled.candidate.source} URL unhealthy, waiting for other sources`);
      }
      pending = rest;
    }

    return null;
  }

  /**
   * 检查候选歌曲的 URL 是否有效——只对**外部直链**做，防止过期链接推送给音箱。
   * 本地索引歌曲（local_index）与指向自家服务端的 URL 都直接放行。
   *
   * 这个函数以前恒定返回 false，是「响应优先总是播外部搜索结果」的直接原因
   * （songloft-org/songloft-plugin-miot#62）。三个坑按顺序记下来，别再踩回去：
   *
   * 1. 不要用 AbortController：QuickJS 沙盒里没有这个全局（宿主 polyfill 只提供 fetch /
   *    setTimeout / URL 等，见 internal/jsruntime/polyfill.go）。`new AbortController()` 会抛
   *    ReferenceError，被本函数的 catch 吞掉后**恒定返回 false**，于是并行搜歌里每个
   *    remote_song 候选都被判死，不做体检的外部搜索结果无条件胜出。改用
   *    X-Fetch-Timeout-Ms 头 + Promise.race，与 online_searcher.ts 的带超时 fetch 同一套写法。
   *
   * 2. 不要探测自家服务端的 URL。后端 MarshalJSON 对所有类型都输出相对路径
   *    `/api/v1/songs/{id}/play`，所以库里的歌**永远**走这一支，探它有两个害处：
   *    - 未缓存的网络歌曲上，`Range: bytes=0-0` 会命中服务端的 206 分支并触发
   *      `go onCacheMiss()`（internal/handlers/proxy.go:388），把整首歌后台下载完——
   *      哪怕这个候选最终落败、这首歌根本没播；
   *    - 竞速是 await 体检的，慢源会把整整 3 秒加到语音响应延迟上。
   *    自家服务端能不能出声，交给真正播放时判断（playCurrent 失败会返回 false）。
   *
   * 3. 若将来真要探测，探针必须走本机 API 地址（getHostAPIBaseUrl）而不是给音箱用的
   *    server_host——外网部署下后者是一次 hairpin NAT 出网回环，容易失败或超过预算。
   *    并且探针不能带 format=mp3 / normalize=1，那会让服务端为一次探针启动 ffmpeg 冷启动。
   */
  private async isCandidateUrlHealthy(candidate: SongSearchCandidate): Promise<boolean> {
    if (candidate.source !== 'remote_song') return true;

    const rawUrl = candidate.song.url || '';
    if (!rawUrl) return false;

    // 指向自家服务端的相对路径：不探测，直接放行（见上面第 2 条）。
    if (!rawUrl.startsWith('http://') && !rawUrl.startsWith('https://')) {
      return true;
    }

    const started = Date.now();
    try {
      const resp = await Promise.race([
        fetch(rawUrl, {
          method: 'GET',
          headers: { Range: 'bytes=0-0', 'X-Fetch-Timeout-Ms': String(URL_HEALTH_CHECK_TIMEOUT_MS) },
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('probe timeout')), URL_HEALTH_CHECK_TIMEOUT_MS)),
      ]);
      const ok = resp.ok || resp.status === 206;
      if (!ok) {
        songloft.log.warn(`[VoiceEngine] 外部直链体检不通过 status=${resp.status} (${Date.now() - started}ms): ${rawUrl.slice(0, 80)}`);
      }
      return ok;
    } catch (e) {
      // 外部直链超时/网络错就判死——本检查的原意就是防过期直链。
      songloft.log.warn(`[VoiceEngine] 外部直链体检异常 (${Date.now() - started}ms): ${String(e)} → 判为不健康`);
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
    pm.setAnnounceOnSongChange(true);

    switch (candidate.source) {
      case 'local_index': {
        const playedLoc = await this.playIndexedSong(candidate.loc, pm, searchTerm, requestedSongName, accountId, deviceId);
        return playedLoc ? this.playedSongFromLocation(playedLoc) : null;
      }
      case 'remote_song': {
        const played = await this.playStandaloneSong(candidate.song, pm);
        return played ? {
          songId: candidate.song.id,
          songName: candidate.song.title,
          artist: candidate.song.artist,
        } : null;
      }
      case 'external_search': {
        // 外部搜索播放成功后，由 playSearchResult 增量把这首歌加入索引（见 addImportedSong），
        // 后续可直接本地命中，无需为一首独立远程歌曲重建全部歌单缓存。
        // 传入 pm：若已配置导入歌单，接管为完整歌单播放，播完自动续播（issue #53）。
        const played = await this.onlineSearcher.playSearchResult(
          candidate.song, accountId, deviceId, this.minaService, this.indexingManager, pm,
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

  /**
   * 播放一首独立歌曲（不在任何歌单里）。
   *
   * 交给 PlaylistManager 当「单曲临时列表」播，而不是手写 playURL——playCurrent 已经把
   * 「读 config 拿 force_mp3/normalize → 构 URL → 分组扇出 → 注册切歌定时器 → 预热 → 更新
   * 播放状态」全做了。旧实现手写直推，漏掉 force_mp3 后音箱拿到不能解码的流就亮灯不出声
   * （songloft-org/songloft-plugin-miot#62），也不注册定时器、网页端看不到在播什么。
   */
  private async playStandaloneSong(
    standalone: StandaloneSongCandidate,
    pm: PlaylistManager,
  ): Promise<boolean> {
    // 固定 order 模式：单曲列表下 getNextIndex() 返回 -1，播完即停，与原直推行为一致。
    // 若沿用设备的 single/loop 模式会变成无限循环。
    // artistQuery 必须显式传 ''：playWithSongs 对 undefined 会保留上一次的临时歌手查询词，
    // 持久化后会被 restoreTempPlaylists 误当成「歌手歌单」恢复。
    // 分组扇出由 playCurrent 对 targets 统一处理，这里不再自己调 fanOutPlayURL，否则重复下发。
    const ok = await pm.playWithSongs([standalone as any], 0, 'order', `单曲: ${standalone.title}`, '');
    if (!ok) {
      songloft.log.error('[VoiceEngine] Failed to play standalone song: ' + standalone.title + ' - ' + standalone.artist);
      return false;
    }

    songloft.log.warn(`[VoiceEngine] 走独立歌曲路径播放（不在任何歌单，无自动续播）: "${standalone.title}" - ${standalone.artist} id=${standalone.id} type=${standalone.type}`);
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

    // 按 songId 定位播放：songIndex 来自缓存快照，歌单增删歌曲后会错位（#420）；
    // songId 是稳定标识，playPlaylistFromSong 在重新加载歌单后按 ID 精确定位。
    const ok = loc.songId
      ? await pm.playPlaylistFromSong(loc.playlistId, loc.songId, playMode, loc.songIndex)
      : await pm.play(loc.playlistId, loc.songIndex, playMode);
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
        const retryOk = newLoc.songId
          ? await pm.playPlaylistFromSong(newLoc.playlistId, newLoc.songId, playMode, newLoc.songIndex)
          : await pm.play(newLoc.playlistId, newLoc.songIndex, playMode);
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
      '单曲播放': 'singlePlay',
      '只播放这首': 'singlePlay',
      '播完这首停止': 'singlePlay',
      '列表循环': 'loop',
      '循环': 'loop',
      'order': 'order',
      'random': 'random',
      'single': 'single',
      'singlePlay': 'singlePlay',
      'single_play': 'singlePlay',
      'loop': 'loop',
    };

    const playMode = modeMap[modeParam];
    if (!playMode) {
      songloft.log.warn(`[VoiceEngine] Unknown play mode: ${modeParam}`);
      return;
    }

    // 用 getOrCreate 解析到（分组则为共享）manager，保证分组下模式落到共享 manager 及其主设备配置，
    // 不会误写到非主成员的配置而丢失。
    const pm = await this.playlistManagerMap.getOrCreate(accountId, deviceId);
    await pm.setPlayMode(playMode);


    songloft.log.info(`[VoiceEngine] Play mode set to: ${playMode}`);
  }

  /**
   * 音量口令后等固件把音量落定再读回的时间。
   *
   * 对话记录本身已比用户说话晚 1~2 秒（实测 addMessage 比 ts 晚约 1.3s），加上这一拍基本能保证
   * 读到的是小爱调整后的值。万一读早了也只是这一轮缓存偏旧，4 秒后 /mina/status 穿透会自我纠正。
   */
  private static readonly VOLUME_SETTLE_MS = 800;

  /**
   * 处理音量口令：**不下发音量，只读回设备真实值**。
   *
   * 「大声/小声一点」「音量调到 X」这类口令小爱固件原生就会处理（f81e0fe 把音量从 AI 分析里
   * 摘掉时已经认定「音响本身可实现」，只是规则匹配这条漏了）。插件再算一次 ±10 下发 player_set_volume
   * 就成了同一条口令调两次音量，用户听到小爱播报 15% 而界面显示插件自己算出的 25%
   * ——因为旧实现把**目标值**而非设备真实值写进了状态缓存并锁定 10 秒
   * （songloft-org/songloft-plugin-miot#61 问题 2）。这条多余的 player_set_volume 同时也是
   * 「调音量后静音」的触发点之一（同 issue 问题 3）。
   *
   * 分组仍需显式对齐：固件只调了听到口令的那台，组内其他成员靠 fanOutSetVolume 跟上。
   *
   * @param param - 音量方向："absolute"|"up"|"down"（保留入参用于日志，行为已不依赖它）
   * @param argument - 口令关键词后的文本（同上，仅日志）
   */
  private async executeSetVolume(accountId: string, deviceId: string, param: string, argument: string): Promise<void> {
    await new Promise(r => setTimeout(r, VoiceEngine.VOLUME_SETTLE_MS));

    const volume = await this.minaService.syncVolumeFromDevice(accountId, deviceId);
    if (volume < 0) {
      songloft.log.warn(`[VoiceEngine] Volume command handled by 小爱, but reading it back failed (param=${param} argument="${argument}")`);
      return;
    }

    // 读回值就是设备真相，不需要 lockVolume 去挡云端「旧值」——那把锁是为了保护
    // 「插件刚下发、云端还没同步」的窗口，现在没有下发这一步了。
    updateDeviceStatusCache(accountId, deviceId, { volume });
    await this.groupCoordinator?.fanOutSetVolume(accountId, deviceId, volume);
    songloft.log.info(`[VoiceEngine] Volume synced from device: ${volume} (handled by 小爱, not re-applied; param=${param})`);
  }

  /**
   * 执行下一首
   */
  private async executeNext(accountId: string, deviceId: string): Promise<void> {
    this.cancelPendingResume();
    const pm = await this.playlistManagerMap.getOrCreate(accountId, deviceId);
    pm.setAnnounceOnSongChange(true);
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
    pm.setAnnounceOnSongChange(true);
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
    // 主动停止时清除 sleep timer
    const key = this.getSleepTimerKey(accountId, deviceId);
    const sleepTimer = this.sleepTimers.get(key);
    if (sleepTimer && sleepTimer.isActive()) {
      sleepTimer.cancel();
      const pm = this.playlistManagerMap.get(accountId, deviceId);
      if (pm) pm.setOnAdvanceHook(undefined);
    }
    const pm = await this.playlistManagerMap.getOrCreate(accountId, deviceId);
    await pm.stop();
    songloft.log.info(`[VoiceEngine] Playback stopped`);
  }

  /**
   * 恢复播放：paused/playing(voice suspended) 走 resumePlayback，
   * stopped 且有歌单走 playCurrent 重推当前歌曲（与 POST /player/toggle 同策略）。
   */
  private async executeResume(accountId: string, deviceId: string): Promise<void> {
    this.cancelPendingResume();
    const pm = this.playlistManagerMap.get(accountId, deviceId);
    if (!pm || !pm.hasPlaylist()) {
      songloft.log.warn('[VoiceEngine] Resume: no playlist loaded');
      await this.minaService.textToSpeech(accountId, deviceId, '没有正在播放的内容');
      return;
    }

    const status = pm.getStatus();

    if (status.state === 'paused' || status.state === 'playing') {
      const ok = await pm.resumePlayback();
      if (ok) {
        songloft.log.info('[VoiceEngine] Playback resumed');
        return;
      }
    }

    if (status.state === 'stopped' || status.state === 'paused') {
      pm.setAnnounceOnSongChange(false);
      const ok = await pm.replayCurrent();
      if (ok) {
        songloft.log.info('[VoiceEngine] Playback restarted from current song');
        return;
      }
    }

    songloft.log.warn('[VoiceEngine] Resume failed');
    await this.minaService.textToSpeech(accountId, deviceId, '恢复播放失败');
  }

  /**
   * 执行收藏/取消收藏当前歌曲
   */
  private async executeFavorite(accountId: string, deviceId: string, action: string): Promise<void> {
    const pm = this.playlistManagerMap.get(accountId, deviceId);
    const song = pm?.getCurrentSong();
    if (!song) {
      songloft.log.warn('[VoiceEngine] Favorite: no song playing');
      await this.minaService.textToSpeech(accountId, deviceId, '当前没有播放歌曲');
      return;
    }

    try {
      const playlists = await songloft.playlists.list();
      const favPlaylist = findFavoritesPlaylist(playlists);
      if (!favPlaylist) {
        songloft.log.warn('[VoiceEngine] Favorite: built-in favorites playlist not found');
        await this.minaService.textToSpeech(accountId, deviceId, '未找到收藏歌单');
        return;
      }

      const songTitle = song.title || '未知歌曲';
      if (action === 'remove') {
        await songloft.playlists.removeSongs(favPlaylist.id, [song.id]);
        songloft.log.info(`[VoiceEngine] Unfavorited: ${songTitle} (id=${song.id})`);
        await this.minaService.textToSpeech(accountId, deviceId, `已取消收藏${songTitle}`);
      } else {
        await songloft.playlists.addSongs(favPlaylist.id, [song.id]);
        songloft.log.info(`[VoiceEngine] Favorited: ${songTitle} (id=${song.id})`);
        await this.minaService.textToSpeech(accountId, deviceId, `已收藏${songTitle}`);
      }
    } catch (e) {
      songloft.log.error(`[VoiceEngine] Favorite failed: ${String(e)}`);
      await this.minaService.textToSpeech(accountId, deviceId, '收藏操作失败');
    }
  }

  /** 关闭整点续播配置后，立即作废所有设备的恢复任务。 */
  cancelHourlyResumes(): void {
    this.playlistManagerMap.cancelHourlyResumes();
  }

  /** 取消待执行的语音恢复操作。 */
  private cancelPendingResume(accountId?: string, deviceId?: string): void {
    if (this.resumeTask &&
      ((accountId && this.resumeTask.accountId !== accountId) || (deviceId && this.resumeTask.deviceId !== deviceId))) return;
    if (this.resumeTimer !== null) {
      clearTimeout(this.resumeTimer);
      this.resumeTimer = null;
    }
    this.resumeTask = null;
  }

  /**
   * 给小爱一秒启动播报，短窗口内读取新状态；旧任务在每次异步返回后核对身份。
   */
  private scheduleSmartResume(pm: import('../player/manager').PlaylistManager, accountId: string, deviceId: string): void {
    this.cancelPendingResume();
    const task: SmartResumeTask = {
      accountId, deviceId,
      revision: pm.getPlaybackRevision(),
      startedAt: Date.now(),
      position: pm.getPosition(),
    };
    this.resumeTask = task;
    this.resumeTimer = setTimeout(() => {
      this.resumeTimer = null;
      void this.smartResume(pm, task).catch(e => {
        songloft.log.warn('[VoiceEngine] Smart resume failed: ' + String(e));
      });
    }, SMART_RESUME_INITIAL_DELAY_MS);
  }

  /**
   * 等待小爱 TTS 播报结束后重新推送当前歌曲 URL
   */
  private async smartResume(pm: import('../player/manager').PlaylistManager, task: SmartResumeTask): Promise<void> {
    const isTaskCurrent = () => this.enabled && this.resumeTask === task;
    const isCurrent = () => isTaskCurrent() && pm.isPlaying() && pm.getPlaybackRevision() === task.revision;
    if (!isCurrent()) return;
    const config = await this.configManager.getConfig();
    if (!isCurrent()) return;
    const timeoutSec = Math.max(5, Math.min(120, config.smart_resume_timeout ?? 30));
    const maxWaitMs = timeoutSec * 1000;
    let deviceBecameIdle = false;
    let deviceTakenOver = false;
    let resumePosition = task.position;
    let fastQueries = 0;
    let idleConfirmationQueries = 0;
    let idleHits = 0;
    let lastPosition = -1;
    let lastSampleAt = -1;
    let lastStatus = -1;
    let progressStalled = false;

    while (Date.now() - task.startedAt < maxWaitMs) {
      if (!isCurrent()) return;
      // 快速窗口耗尽后，首次发现 idle 仍可加一次确认，避免已说完又等五秒。
      const confirmIdle = idleHits === 1 && idleConfirmationQueries < 1;
      const fast = fastQueries < SMART_RESUME_FAST_QUERIES || confirmIdle;
      if (fastQueries < SMART_RESUME_FAST_QUERIES) fastQueries++;
      else if (confirmIdle) idleConfirmationQueries++;
      const st = await this.minaService.getPlayState(task.accountId, task.deviceId, fast ? { verify: true } : {});
      if (!isCurrent()) return;
      const sampleAt = st.sampledAt ?? Date.now();
      if (st.status < 0) {
        // 查询失败不是「播报结束」。停止快速回读，遵守 Mina 的失败退避。
        fastQueries = SMART_RESUME_FAST_QUERIES;
        idleHits = 0;
        lastPosition = -1;
        lastStatus = -1;
        progressStalled = false;
      } else if (sampleAt >= task.startedAt && sampleAt > lastSampleAt) {
        lastSampleAt = sampleAt;
        lastStatus = st.status;
        const stream = pm.matchDeviceStream({ ...st, status: 1 });
        // 某些固件在实际播放时连续误报 paused/stopped；进度推进时只校准，不再发 play（#449）。
        if ((st.status === 0 || st.status === 1 || st.status === 2) && stream !== 'foreign' && st.hasPosition) {
          if (lastPosition >= 0 && st.position - lastPosition + 1e-6 >= 0.1) {
            songloft.log.info('[VoiceEngine] Device auto-resumed, progress confirmed; resetting timer only');
            pm.resetAutoNextTimer(st.position * pm.getPlaybackSpeed() + pm.getStreamSeekOffsetSec());
            return;
          }
          progressStalled = lastPosition >= 0 && st.position >= lastPosition;
          lastPosition = st.position;
        } else {
          lastPosition = -1;
          progressStalled = false;
        }
        if (st.status === 0 || st.status === 2) {
          idleHits++;
          progressStalled = false;
          if (st.hasPosition && stream === 'ours') {
            resumePosition = st.position * pm.getPlaybackSpeed() + pm.getStreamSeekOffsetSec();
          }
          // 两次新采样确认，给延迟启动的播报留出窗口，缓存不能累积命中。
          if (idleHits >= 2) {
            deviceBecameIdle = true;
            break;
          }
        } else if (st.status === 1) {
          idleHits = 0;
          if (stream === 'foreign') {
            // 外来媒体可能就是正在播报的小爱回答，先等结束，不能立刻重推打断。
            deviceTakenOver = true;
            lastPosition = -1;
            progressStalled = false;
          }
        } else {
          idleHits = 0;
          lastPosition = -1;
          lastStatus = -1;
          progressStalled = false;
        }
      }
      const remainingMs = maxWaitMs - (Date.now() - task.startedAt);
      if (remainingMs <= 0) break;
      const interval = fastQueries < SMART_RESUME_FAST_QUERIES || (idleHits === 1 && idleConfirmationQueries < 1)
        ? SMART_RESUME_FAST_INTERVAL_MS : SMART_RESUME_NORMAL_INTERVAL_MS;
      await new Promise(r => setTimeout(r, Math.min(interval, remainingMs)));
    }

    if (!isCurrent()) return;
    if (!deviceBecameIdle && (lastStatus < 0 || (!deviceTakenOver && !progressStalled))) {
      // 未知状态/缺失进度不能证明已续播，也不能据此重推。恢复本地驱动，不发送设备指令。
      songloft.log.warn('[VoiceEngine] Smart resume timed out without playback evidence; restoring timer only');
      pm.resetAutoNextTimer(resumePosition);
      return;
    }

    if (deviceBecameIdle && !deviceTakenOver) {
      const resumed = await pm.resumePlayback({ positionSec: resumePosition, isCurrent: isTaskCurrent });
      if (resumed) {
        songloft.log.info('[VoiceEngine] Resume command sent after voice interaction; verification pending');
        return;
      }
      if (!isCurrent()) return;
    }

    // 被接管或超时仍无进度：带挂起时的位置重推，不把整个播报等待时间算成已听内容。
    // 失败推送自身只停一次定时器；版本再变化说明已有新操作，不能替它收尾。
    const replayRevision = pm.getPlaybackRevision() + 1;
    const ok = await pm.replayCurrent(resumePosition, isTaskCurrent);
    if (ok) {
      songloft.log.info(`[VoiceEngine] Playback restored via replay after voice interaction seek=${resumePosition.toFixed(1)}s`);
    } else if (isTaskCurrent() && pm.getPlaybackRevision() === replayRevision && pm.isPlaying() && pm.isVoiceSuspended()) {
      songloft.log.warn('[VoiceEngine] Failed to restore playback after voice interaction');
      await pm.stop(false);
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

  // ===== SleepTimer 相关方法 =====

  private getSleepTimerKey(accountId: string, deviceId: string): string {
    return `${accountId}:${deviceId}`;
  }

  private getOrCreateSleepTimer(accountId: string, deviceId: string): SleepTimer {
    const key = this.getSleepTimerKey(accountId, deviceId);
    let timer = this.sleepTimers.get(key);
    if (!timer) {
      timer = new SleepTimer(async () => {
        songloft.log.info(`[VoiceEngine] SleepTimer expired for ${key}, stopping playback`);
        const pm = this.playlistManagerMap.get(accountId, deviceId);
        if (pm) {
          await pm.stop();
        } else {
          await this.minaService.stopPlay(accountId, deviceId);
        }
      });
      this.sleepTimers.set(key, timer);
    }
    return timer;
  }

  /**
   * 设置 SleepTimer 并注册 PlaylistManager hook（曲目模式用）
   */
  private setupSleepTimer(accountId: string, deviceId: string, mode: 'time' | 'songs', value: number): void {
    const timer = this.getOrCreateSleepTimer(accountId, deviceId);
    const pm = this.playlistManagerMap.get(accountId, deviceId);
    if (pm) pm.setOnAdvanceHook(undefined);

    if (mode === 'time') {
      timer.setTime(value);
    } else {
      timer.setSongs(value);
      if (pm) {
        pm.setOnAdvanceHook(() => timer.onSongAdvanced());
      }
    }
  }

  /**
   * 规则匹配路径：从原始 query 中提取时间/曲目参数并设置定时器
   * @param query 原始语音文本（如 "30分钟后停止播放"、"再听3首后停"）
   */
  private async executeSleepTimer(query: string, accountId: string, deviceId: string): Promise<void> {
    const mode = detectSleepTimerMode(query);
    if (!mode) {
      songloft.log.warn(`[VoiceEngine] [SleepTimer] 无法识别定时模式 query="${query}"`);
      await this.minaService.textToSpeech(accountId, deviceId, '抱歉，无法识别定时时间');
      return;
    }

    if (mode === 'songs') {
      const count = parseSongsCount(query);
      if (count <= 0) {
        songloft.log.warn(`[VoiceEngine] [SleepTimer] 无法解析曲目数 query="${query}"`);
        await this.minaService.textToSpeech(accountId, deviceId, '抱歉，无法识别曲目数');
        return;
      }
      this.setupSleepTimer(accountId, deviceId, 'songs', count);
      songloft.log.info(`[VoiceEngine] [SleepTimer] 设置曲目定时: ${count}首后停止`);
      await this.minaService.textToSpeech(accountId, deviceId, `好的，再播${count}首后将停止播放`);
    } else {
      const minutes = parseTimeDuration(query);
      if (minutes <= 0) {
        songloft.log.warn(`[VoiceEngine] [SleepTimer] 无法解析时间 query="${query}"`);
        await this.minaService.textToSpeech(accountId, deviceId, '抱歉，无法识别定时时间');
        return;
      }
      this.setupSleepTimer(accountId, deviceId, 'time', minutes);
      songloft.log.info(`[VoiceEngine] [SleepTimer] 设置时间定时: ${minutes}分钟后停止`);
      const desc = minutes >= 60
        ? (minutes % 60 === 0 ? `${minutes / 60}小时` : `${Math.floor(minutes / 60)}小时${minutes % 60}分钟`)
        : `${minutes}分钟`;
      await this.minaService.textToSpeech(accountId, deviceId, `好的，${desc}后将停止播放`);
    }
  }

  /**
   * AI 分析路径：从 AI 结果中提取参数并设置定时器
   */
  private async executeSleepTimerFromAI(result: AIAnalysisResult, accountId: string, deviceId: string): Promise<void> {
    const { duration, songs_count } = result.params;

    if (songs_count && songs_count > 0) {
      this.setupSleepTimer(accountId, deviceId, 'songs', songs_count);
      songloft.log.info(`[VoiceEngine] [SleepTimer] [AI] 设置曲目定时: ${songs_count}首后停止`);
      await this.minaService.textToSpeech(accountId, deviceId, `好的，再播${songs_count}首后将停止播放`);
    } else if (duration && duration > 0) {
      this.setupSleepTimer(accountId, deviceId, 'time', duration);
      songloft.log.info(`[VoiceEngine] [SleepTimer] [AI] 设置时间定时: ${duration}分钟后停止`);
      const desc = duration >= 60
        ? (duration % 60 === 0 ? `${duration / 60}小时` : `${Math.floor(duration / 60)}小时${duration % 60}分钟`)
        : `${duration}分钟`;
      await this.minaService.textToSpeech(accountId, deviceId, `好的，${desc}后将停止播放`);
    } else {
      songloft.log.warn(`[VoiceEngine] [SleepTimer] [AI] 参数无效: ${JSON.stringify(result.params)}`);
      await this.minaService.textToSpeech(accountId, deviceId, '抱歉，无法识别定时时间');
    }
  }

  /**
   * 取消定时器
   */
  private async executeCancelSleepTimer(accountId: string, deviceId: string): Promise<void> {
    const key = this.getSleepTimerKey(accountId, deviceId);
    const timer = this.sleepTimers.get(key);
    if (timer && timer.isActive()) {
      timer.cancel();
      const pm = this.playlistManagerMap.get(accountId, deviceId);
      if (pm) {
        pm.setOnAdvanceHook(undefined);
      }
      songloft.log.info(`[VoiceEngine] [SleepTimer] 已取消定时停止`);
      await this.minaService.textToSpeech(accountId, deviceId, '已取消定时停止');
    } else {
      await this.minaService.textToSpeech(accountId, deviceId, '当前没有定时任务');
    }
  }

  /**
   * 查询定时器剩余
   */
  private async executeQuerySleepTimer(accountId: string, deviceId: string): Promise<void> {
    const key = this.getSleepTimerKey(accountId, deviceId);
    const timer = this.sleepTimers.get(key);
    if (timer && timer.isActive()) {
      const state = timer.getState();
      const text = formatRemaining(state);
      await this.minaService.textToSpeech(accountId, deviceId, text);
    } else {
      await this.minaService.textToSpeech(accountId, deviceId, '当前没有定时任务');
    }
  }

}

// extractNumber / parseChineseNumber 随 executeSetVolume 改为「只读回不下发」一并删除：
// 它们唯一的用途是从「音量调到五十/百分之五十」里解析目标值，而现在目标值由小爱固件自己决定，
// 插件不再需要理解口令里的数字（含 songloft-org/songloft#166 那个「百分之X」被解析成 100 的修复）。
// 若将来发现某型号固件确实不原生处理音量、需要插件兜底下发，从 git 历史取回即可。
