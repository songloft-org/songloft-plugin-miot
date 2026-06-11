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
    { type: 'play_playlist', keywords: ['播放歌单', '放歌单'], enabled: true },
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
    { type: 'stop', keywords: ['停止播放', '停止', '别播了', '关掉音乐', '关机'], enabled: true },
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
      songloft.log.info(`[VoiceEngine] [Rule] No match found, ignoring`);
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

    // 过滤已启用的口令并按优先级排序
    const enabledCommands = commands
      .filter(cmd => cmd.enabled)
      .map(cmd => ({
        cmd,
        priority: COMMAND_PRIORITY[cmd.type] ?? 99,
      }))
      .sort((a, b) => a.priority - b.priority);

    // 按优先级分组遍历，同优先级内取最长关键词匹配
    // 避免短关键词（如"音量"）窃取长关键词（如"音量大一点"）的匹配
    let currentPriority = -1;
    let bestMatch: MatchResult | null = null;
    let bestKeywordLen = 0;

    for (const item of enabledCommands) {
      if (item.priority !== currentPriority) {
        if (bestMatch) {
          return bestMatch;
        }
        currentPriority = item.priority;
        bestMatch = null;
        bestKeywordLen = 0;
      }

      for (const keyword of item.cmd.keywords) {
        const idx = query.indexOf(keyword);
        if (idx >= 0) {
          const kwLen = Array.from(keyword).length;
          if (kwLen > bestKeywordLen) {
            bestKeywordLen = kwLen;
            const argument = query.slice(idx + keyword.length).trim();
            bestMatch = {
              command: item.cmd,
              keyword,
              argument,
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

    this.tryResumePlayback(result.command.type, wasPlaying, pm);
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

    this.tryResumePlayback(result.action, wasPlaying, pm);
  }

  /**
   * 非播放类命令执行后，尝试恢复被小爱语音唤醒中断的 URL 播放
   */
  private tryResumePlayback(commandType: string, wasPlaying: boolean, pm: import('../player/manager').PlaylistManager | null): void {
    const isNonPlaybackCommand = commandType === 'set_volume' || commandType === 'set_play_mode';
    if (!isNonPlaybackCommand || !wasPlaying || !pm) return;

    songloft.log.info('[VoiceEngine] Non-playback command while playing, will resume after delay');
    setTimeout(async () => {
      try {
        const ok = await pm.resumePlayback();
        if (ok) {
          songloft.log.info('[VoiceEngine] Playback resumed after voice command');
        } else {
          songloft.log.warn('[VoiceEngine] Failed to resume playback');
        }
      } catch (e) {
        songloft.log.error('[VoiceEngine] Error resuming playback: ' + String(e));
      }
    }, 2000);
  }

  /**
   * 执行播放歌单
   * 通过 IndexingManager 模糊匹配歌单名，然后调用 PlaylistManager 播放
   */
  private async executePlayPlaylist(playlistName: string, accountId: string, deviceId: string): Promise<void> {
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
    } else {
      songloft.log.error(`[VoiceEngine] Play playlist failed: ${matchedPlaylist.name}`);
    }
  }

  /**
   * 执行播放歌曲
   * 通过 IndexingManager 模糊匹配歌曲名，获取所在歌单及索引，然后调用 PlaylistManager 播放
   * 翻译自 Go 版本: voicecmd/engine.go executePlaySong
   */
  private async executePlaySong(songName: string, accountId: string, deviceId: string): Promise<void> {
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

    // 从索引中模糊匹配歌曲，获取歌单ID和歌曲索引
    let loc = await this.indexingManager.findSongByName(songName);
    if (!loc) {
      // 尝试查找独立远程歌曲（不在任何歌单中的外部导入歌曲）
      const standalone = await this.indexingManager.findStandaloneSongByName(songName);
      if (standalone) {
        const playUrl = await URLBuilder.buildSongURL(standalone);
        if (playUrl) {
          await this.minaService.playURL(accountId, deviceId, playUrl);
          songloft.log.info('[VoiceEngine] Played standalone remote song: ' + standalone.title + ' - ' + standalone.artist);
          return;
        }
      }

      songloft.log.warn(`[VoiceEngine] Song not found locally: ${songName}, trying online search`);
      // 本地缓存歌曲未击中，尝试在线搜索（需配置了外部搜索 API）
      if (!(await this.onlineSearcher.isExternalSearchConfigured())) {
        songloft.log.warn('[VoiceEngine] External search not configured, skip online search');
        return;
      }
      const hint = songName.trim() ? { title: songName.trim() } : null;
      const played = await this.onlineSearcher.searchAndPlay(
        songName, hint, accountId, deviceId, this.minaService,
      );
      if (!played) {
        songloft.log.warn(`[VoiceEngine] Online search failed for: ${songName}`);
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
    } else {
      songloft.log.error(`[VoiceEngine] Play song failed: ${loc.songTitle}`);
    }
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
      songloft.log.info(`[VoiceEngine] Volume set to: ${targetVolume}`);
    } else {
      songloft.log.error(`[VoiceEngine] Failed to set volume: ${targetVolume}`);
    }
  }

  /**
   * 执行下一首
   */
  private async executeNext(accountId: string, deviceId: string): Promise<void> {
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
    const pm = await this.playlistManagerMap.getOrCreate(accountId, deviceId);
    await pm.stop();
    songloft.log.info(`[VoiceEngine] Playback stopped`);
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

    // 优先尝试阿拉伯数字
    const numMatch = s.match(/\d+/);
    if (numMatch) {
      return parseInt(numMatch[0], 10);
    }

    // 尝试中文数字
    const cnMatch = s.match(/[零一二三四五六七八九十百千万]+/);
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
