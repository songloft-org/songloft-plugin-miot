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
import type { ConversationMessage, VoiceCommand, PlayMode, AIAnalysisResult } from '../types';

// ===== 类型定义 =====

/** 口令匹配结果 */
interface MatchResult {
  command: VoiceCommand;
  keyword: string;
  argument: string;
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
    { type: 'stop', keywords: ['停止播放', '停止', '别播了', '关掉音乐', '关机', '关闭'], enabled: true },
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
  ) {
    this.configManager = configManager;
    this.accountManager = accountManager;
    this.minaService = minaService;
    this.playlistManagerMap = playlistManagerMap;
    this.indexingManager = indexingManager;
    this.aiAnalyzer = aiAnalyzer || new AIAnalyzer();
    this.onlineSearcher = new OnlineSearcher(configManager);
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

    // 尝试 AI 分析（如果启用）
    const aiConfig = await this.configManager.getAIConfig();
    if (aiConfig.enabled) {
      songloft.log.info(`[VoiceEngine] [AI] Analyzing query="${query}"`);
      const aiResult = await this.aiAnalyzer.analyze(query, aiConfig);
      if (aiResult) {
        songloft.log.info(`[VoiceEngine] [AI] Done: action=${aiResult.action} confidence=${aiResult.confidence} params=${JSON.stringify(aiResult.params)}`);
        // AI 高置信度且识别到有效 action 才执行，否则用规则兜底
        if (aiResult.confidence === 'high' && aiResult.action !== 'unknown') {
          songloft.log.info(`[VoiceEngine] [AI] → Executing (high confidence, action=${aiResult.action})`);
          await this.executeAIResult(aiResult, accountId, msg.device_id);
          return;
        } else {
          songloft.log.info(`[VoiceEngine] [AI] → Falling back to rule matching (action=${aiResult.action}, confidence=${aiResult.confidence})`);
        }
      } else {
        songloft.log.info(`[VoiceEngine] [AI] → Fallback to rule matching (analyze returned null)`);
      }
    }

    // 规则匹配兜底
    songloft.log.info(`[VoiceEngine] [Rule] Matching query="${query}"`);
    const result = await this.matchCommand(query);
    if (!result) {
      songloft.log.info(`[VoiceEngine] [Rule] No match found`);

      // 任何语音交互都会唤醒音箱并打断 URL 播放。
      // 立即挂起定时器（防止 AI 响应期间触发切歌），等小爱说完后重新推送歌曲 URL。
      const pm = this.playlistManagerMap.get(accountId, msg.device_id);
      if (pm && pm.isPlaying()) {
        pm.suspendForVoiceInteraction();
        songloft.log.info('[VoiceEngine] Unmatched command while playing, scheduling smart resume');
        this.scheduleSmartResume(pm, accountId, msg.device_id);
      }

      return;
    }

    songloft.log.info(`[VoiceEngine] [Rule] → Matched: type=${result.command.type} keyword="${result.keyword}" argument="${result.argument}"`);

    // 执行口令
    await this.executeCommand(result, accountId, msg.device_id);
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

    return bestMatch;
  }

  // ===== 私有方法 - 口令执行 =====

  /**
   * 执行匹配到的口令
   */
  private async executeCommand(result: MatchResult, accountId: string, deviceId: string): Promise<void> {
    const pm = this.playlistManagerMap.get(accountId, deviceId);
    const wasPlaying = pm?.isPlaying() ?? false;

    switch (result.command.type) {
      case 'play_playlist':
        await this.executePlayPlaylist(result.argument, accountId, deviceId);
        break;
      case 'play_song':
        await this.executePlaySong(result.argument, accountId, deviceId);
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
  }

  /**
   * 执行 AI 分析结果
   */
  private async executeAIResult(result: AIAnalysisResult, accountId: string, deviceId: string): Promise<void> {
    songloft.log.info(`[VoiceEngine] [AI] Executing action=${result.action} params=${JSON.stringify(result.params)}`);
    const pm = this.playlistManagerMap.get(accountId, deviceId);
    const wasPlaying = pm?.isPlaying() ?? false;

    switch (result.action) {
      case 'play_song': {
        const name = result.params.name || '';
        const artist = result.params.artist || '';
        const searchTerm = name || artist;
        if (!searchTerm) {
          songloft.log.warn('[VoiceEngine] [AI] play_song: no name or artist to play');
          return;
        }
        await this.executePlaySong(searchTerm, accountId, deviceId);
        break;
      }
      case 'play_playlist': {
        const playlist = result.params.playlist || '';
        if (!playlist) {
          songloft.log.warn('[VoiceEngine] [AI] play_playlist: no playlist name');
          return;
        }
        await this.executePlayPlaylist(playlist, accountId, deviceId);
        break;
      }
      case 'set_play_mode': {
        const mode = result.params.mode || '';
        if (!mode) {
          songloft.log.warn('[VoiceEngine] [AI] set_play_mode: no mode');
          return;
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
  private async executePlaySong(songName: string, accountId: string, deviceId: string): Promise<void> {
    this.cancelPendingResume();
    const pm = await this.playlistManagerMap.getOrCreate(accountId, deviceId);

    // 空参数处理：继续上次播放
    if (!songName) {
      if (pm.hasPlaylist()) {
        songloft.log.info('[VoiceEngine] Play song: resume last playback');
        await pm.next();
        return;
      }
      songloft.log.warn('[VoiceEngine] No song name specified and no active playlist');
      return;
    }

    // 立即停止定时器和重置状态，防止后续异步操作期间旧定时器触发
    pm.prepareForNewPlayback();

    // 打断音箱当前播报
    await this.interruptBroadcast(accountId, deviceId);

    // 检查索引是否就绪
    if (!this.indexingManager.isIndexReady()) {
      songloft.log.warn('[VoiceEngine] Song index not ready, skip play song');
      return;
    }

    // 从索引中模糊匹配歌曲，获取歌单ID和歌曲索引（使用预加载缓存，纯内存操作）
    songloft.log.info(`[VoiceEngine] Searching song: "${songName}"`);
    let loc = await this.indexingManager.findSongByName(songName);
    if (!loc) {
      // 尝试查找独立远程歌曲（不在任何歌单中的外部导入歌曲）
      const standalone = await this.indexingManager.findStandaloneSongByName(songName);
      if (standalone) {
        const playUrl = await URLBuilder.buildSongURL(standalone);
        if (playUrl) {
          const standaloneName = standalone.artist ? `${standalone.title}-${standalone.artist}` : standalone.title;
          await this.minaService.playURL(accountId, deviceId, playUrl, standaloneName);
          songloft.log.info('[VoiceEngine] Played standalone remote song: ' + standalone.title + ' - ' + standalone.artist);
          return;
        }
      }

      songloft.log.warn(`[VoiceEngine] Song not found locally: ${songName}, trying online search`);
      // 本地缓存歌曲未击中，尝试在线搜索（需配置了外部搜索 API）
      if (!(await this.onlineSearcher.isExternalSearchConfigured())) {
        songloft.log.warn('[VoiceEngine] External search not configured, skip online search');
        await this.minaService.textToSpeech(accountId, deviceId, `未找到歌曲：${songName}`);
        return;
      }
      const hint = songName.trim() ? { title: songName.trim() } : null;
      const played = await this.onlineSearcher.searchAndPlay(
        songName, hint, accountId, deviceId, this.minaService,
      );
      if (!played) {
        songloft.log.warn(`[VoiceEngine] Online search failed for: ${songName}`);
        await this.minaService.textToSpeech(accountId, deviceId, `未找到歌曲：${songName}`);
        return;
      }
      // 外部搜索播放成功后刷新索引，后续可直接本地命中
      await this.indexingManager.refresh();
      return;
    }

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
      return;
    }

    // 播放失败且因歌单 ID 已失效（扫描后 auto-create 歌单 ID 变化）：刷新索引后重试一次
    if (pm.isLastPlayNotFound()) {
      songloft.log.warn(`[VoiceEngine] Stale playlist ID ${loc.playlistId}, refreshing index and retrying`);
      await this.indexingManager.refresh();
      const newLoc = await this.indexingManager.findSongByName(songName);
      if (newLoc) {
        songloft.log.info(`[VoiceEngine] Re-matched after refresh: ${newLoc.songTitle} playlist="${newLoc.playlistName}" playlistId=${newLoc.playlistId} songIndex=${newLoc.songIndex}`);
        const retryOk = await pm.play(newLoc.playlistId, newLoc.songIndex, playMode);
        if (retryOk) {
          songloft.log.info(`[VoiceEngine] Retry play song success: ${newLoc.songTitle}`);
          return;
        }
      }
      songloft.log.error(`[VoiceEngine] Retry play song failed after index refresh: ${songName}`);
      return;
    }

    songloft.log.error(`[VoiceEngine] Play song failed: ${loc.songTitle}`);
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
