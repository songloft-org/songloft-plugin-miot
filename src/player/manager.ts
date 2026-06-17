// MIoT 智能音箱插件 - 歌单播放管理器
// 翻译自 Go 源码: plugins/songloft-plugin-xiaomi/player/playlist_manager.go
// 管理播放状态机、播放模式切换、自动切歌

/// <reference types="@songloft/plugin-sdk" />

import { ConfigManager } from '../config/manager';
import { MinaService } from '../service/service';
import { URLBuilder } from './url_builder';
import { getHostBaseUrl, callHostAPI } from '../utils/http';
import type { PlayState, PlayMode, PlayerStatus } from '../types';

// ===== 歌曲类型 =====

/** 歌曲信息（从宿主API返回） */
interface Song {
  id: number;
  type: string;       // "local" | "remote" | "radio"
  title: string;
  artist: string;
  album: string;
  duration: number;   // 秒
  file_path: string;
  url: string;
  cover_path: string;
  cover_url: string;
  lyric_url: string;  // 歌词URL（后端统一端点）
  file_size: number;
  format: string;
  bit_rate: number;
  sample_rate: number;
  is_live: boolean;
  cache_hash: string;
}

/** 宿主API歌单歌曲响应 */
interface PlaylistSongsResponse {
  code: number;
  data: {
    songs: Song[];
    total: number;
  };
}

// ===== PlaylistManager - 单设备播放管理器 =====

/**
 * PlaylistManager - 管理单个设备的歌单播放
 * 实现播放状态机、播放模式切换、定时切歌
 */
export class PlaylistManager {
  private accountId: string;
  private deviceId: string;
  private minaService: MinaService;
  private configManager: ConfigManager;

  private state: PlayState = 'idle';
  private playMode: PlayMode = 'order';
  private playlistId: number = 0;
  private songs: Song[] = [];
  private currentIndex: number = 0;
  private checkTimer: any = null;       // 定时器ID（基于歌曲时长的切歌定时器）
  private totalSongs: number = 0;
  private playStartTimeMs: number = 0;  // 当前歌曲开始播放的时间戳(ms)
  private randomPlayed: Set<number> = new Set(); // 随机模式已播放索引
  private voiceSuspendedAt: number = 0; // suspendForVoiceInteraction 首次调用时间戳

  constructor(
    accountId: string,
    deviceId: string,
    minaService: MinaService,
    configManager: ConfigManager,
  ) {
    this.accountId = accountId;
    this.deviceId = deviceId;
    this.minaService = minaService;
    this.configManager = configManager;
  }

  // ===== 公开方法 =====

  /**
   * 播放歌单
   * @param playlistId - 歌单ID
   * @param startIndex - 起始歌曲索引（默认0）
   * @param mode - 播放模式（默认order）
   * @returns 是否成功
   */
  async play(playlistId: number, startIndex?: number, mode?: PlayMode): Promise<boolean> {
    // 立即停止定时器和重置状态，防止 loadPlaylistSongs 期间旧定时器触发 onSongFinished
    this.stopCheckTimer();
    this.state = 'idle';
    this.playStartTimeMs = 0;

    // 加载歌单歌曲
    const loaded = await this.loadPlaylistSongs(playlistId);
    if (!loaded) {
      songloft.log.error('[PlaylistManager] Failed to load playlist songs: ' + playlistId);
      return false;
    }

    if (this.songs.length === 0) {
      songloft.log.warn('[PlaylistManager] Playlist is empty: ' + playlistId);
      return false;
    }

    // 设置播放参数
    this.playlistId = playlistId;
    this.currentIndex = (startIndex !== undefined && startIndex >= 0 && startIndex < this.songs.length)
      ? startIndex : 0;
    this.playMode = mode || 'order';
    this.randomPlayed = new Set();

    // 开始播放当前歌曲
    const ok = await this.playCurrent();
    if (!ok) {
      songloft.log.error('[PlaylistManager] Failed to play current song');
      return false;
    }

    // 持久化播放状态到设备配置
    await this.persistState();

    songloft.log.info(`[PlaylistManager] Playlist started id=${playlistId} index=${this.currentIndex} mode=${this.playMode} total=${this.songs.length}`);
    return true;
  }

  /**
   * 停止播放
   */
  async stop(): Promise<void> {
    this.stopCheckTimer();
    this.clearVoiceSuspend();
    this.state = 'stopped';
    this.playStartTimeMs = 0;

    // 调用设备暂停
    if (this.accountId && this.deviceId) {
      await this.minaService.pausePlay(this.accountId, this.deviceId);
    }

    songloft.log.info('[PlaylistManager] Playback stopped');
  }

  /**
   * 下一首
   * @returns 是否成功
   */
  async next(): Promise<boolean> {
    this.stopCheckTimer();
    if (this.songs.length === 0) {
      songloft.log.warn('[PlaylistManager] No playlist loaded for next');
      return false;
    }

    const nextIdx = this.getNextIndex();
    if (nextIdx < 0) {
      songloft.log.info('[PlaylistManager] No next song, stopping');
      await this.stop();
      return false;
    }

    this.currentIndex = nextIdx;
    const ok = await this.playCurrent();
    if (ok) {
      await this.persistState();
    }
    return ok;
  }

  /**
   * 上一首
   * @returns 是否成功
   */
  async previous(): Promise<boolean> {
    this.stopCheckTimer();
    if (this.songs.length === 0) {
      songloft.log.warn('[PlaylistManager] No playlist loaded for previous');
      return false;
    }

    const prevIdx = this.getPreviousIndex();
    if (prevIdx < 0) {
      songloft.log.info('[PlaylistManager] No previous song');
      return false;
    }

    this.currentIndex = prevIdx;
    const ok = await this.playCurrent();
    if (ok) {
      await this.persistState();
    }
    return ok;
  }

  /**
   * 设置播放模式
   */
  async setPlayMode(mode: PlayMode): Promise<void> {
    this.playMode = mode;

    // 切换到随机模式时重置已播放记录
    if (mode === 'random') {
      this.randomPlayed = new Set();
    }

    // 持久化到设备配置
    try {
      await this.configManager.updateDevice(this.accountId, this.deviceId, {
        play_mode: mode,
      });
    } catch (e) {
      songloft.log.warn('[PlaylistManager] Failed to save play mode: ' + String(e));
    }

    songloft.log.info('[PlaylistManager] Play mode set to ' + mode);
  }

  /**
   * 获取播放状态
   */
  getStatus(): PlayerStatus {
    let currentSong: { id: number; title: string; artist: string; cover_url?: string; lyric_url?: string } | undefined;
    let duration = 0;
    if (this.currentIndex >= 0 && this.currentIndex < this.songs.length) {
      const song = this.songs[this.currentIndex];
      currentSong = { id: song.id, title: song.title, artist: song.artist, cover_url: song.cover_url, lyric_url: song.lyric_url };
      duration = song.duration;
    }

    return {
      state: this.state,
      play_mode: this.playMode,
      playlist_id: this.playlistId,
      current_index: this.currentIndex,
      current_song: currentSong,
      position: this.getPosition(),
      duration: duration,
      is_playing: this.state === 'playing',
    };
  }

  /**
   * 获取当前歌曲
   */
  getCurrentSong(): Song | null {
    if (this.currentIndex >= 0 && this.currentIndex < this.songs.length) {
      return this.songs[this.currentIndex];
    }
    return null;
  }

  /**
   * 是否有播放列表
   */
  hasPlaylist(): boolean {
    return this.songs.length > 0;
  }

  /**
   * 是否正在播放
   */
  isPlaying(): boolean {
    return this.state === 'playing';
  }

  /**
   * 恢复播放（使用 play 接口继续，不重发 URL）
   * 用于语音命令（如调音量）中断 URL 播放后恢复
   * 同时重置切歌定时器以补偿暂停时间
   */
  async resumePlayback(): Promise<boolean> {
    if (this.state !== 'playing' || this.songs.length === 0) {
      return false;
    }

    this.stopCheckTimer();

    const ok = await this.minaService.resumePlay(this.accountId, this.deviceId);
    if (!ok) {
      songloft.log.warn('[PlaylistManager] resumePlay failed');
      return false;
    }

    const song = this.getCurrentSong();
    if (song && song.duration > 0 && this.playStartTimeMs > 0) {
      const elapsedSec = (Date.now() - this.playStartTimeMs) / 1000;
      const remaining = song.duration - elapsedSec;
      if (remaining > 0) {
        this.startCheckTimer(remaining);
        songloft.log.info(`[PlaylistManager] Timer reset after resume: remaining=${remaining.toFixed(1)}s`);
      }
    }

    return true;
  }

  /**
   * 获取当前播放位置（秒）
   */
  getPosition(): number {
    if (this.state !== 'playing' || this.playStartTimeMs === 0) {
      return 0;
    }
    const elapsed = (Date.now() - this.playStartTimeMs) / 1000;
    const song = this.getCurrentSong();
    if (song && song.duration > 0 && elapsed > song.duration) {
      return song.duration;
    }
    return elapsed;
  }

  /**
   * 清理定时器
   */
  cleanup(): void {
    this.stopCheckTimer();
  }

  /**
   * 准备播放新内容：立即清除定时器并重置状态
   * 用于 VoiceEngine 在 interruptBroadcast 之前调用，
   * 防止搜索/加载期间旧定时器触发 onSongFinished
   */
  prepareForNewPlayback(): void {
    this.stopCheckTimer();
    this.clearVoiceSuspend();
    this.state = 'idle';
    this.playStartTimeMs = 0;
  }

  /**
   * 挂起播放：停止切歌定时器但保持 playing 状态
   * 用于语音交互打断时，防止定时器在 AI 响应期间触发 onSongFinished，
   * 同时保持状态为 playing 以便后续 resumePlayback() 恢复。
   */
  suspendForVoiceInteraction(): void {
    this.stopCheckTimer();
    if (this.voiceSuspendedAt === 0) {
      this.voiceSuspendedAt = Date.now();
    }
  }

  isVoiceSuspended(): boolean {
    return this.voiceSuspendedAt > 0;
  }

  isVoiceSuspendStale(): boolean {
    return this.voiceSuspendedAt > 0 && (Date.now() - this.voiceSuspendedAt) > 60000;
  }

  private clearVoiceSuspend(): void {
    this.voiceSuspendedAt = 0;
  }

  /**
   * 仅重置切歌定时器（不发送任何设备命令）
   * 用于设备已自动恢复播放的场景，避免多余的 play 命令导致歌曲从头播放
   * @param devicePositionSec - 设备实际播放位置（秒），优先使用；未提供时回退到挂钟时间
   */
  resetAutoNextTimer(devicePositionSec?: number): void {
    this.stopCheckTimer();
    this.clearVoiceSuspend();
    const song = this.getCurrentSong();
    if (!song || song.duration <= 0) return;

    let remaining: number;
    if (typeof devicePositionSec === 'number' && devicePositionSec >= 0) {
      remaining = song.duration - devicePositionSec;
      this.playStartTimeMs = Date.now() - devicePositionSec * 1000;
    } else if (this.playStartTimeMs > 0) {
      const elapsedSec = (Date.now() - this.playStartTimeMs) / 1000;
      remaining = song.duration - elapsedSec;
    } else {
      return;
    }

    if (remaining > 0) {
      this.startCheckTimer(remaining);
      songloft.log.info(`[PlaylistManager] Timer reset: remaining=${remaining.toFixed(1)}s`);
    }
  }

  /**
   * 重新推送当前歌曲 URL 到设备（用于语音打断后恢复）
   * 与 resumePlayback() 不同，这里重新发送 URL 而非简单 resume，
   * 因为被语音唤醒打断后设备的 URL 播放状态已被清除。
   */
  async replayCurrent(): Promise<boolean> {
    return this.playCurrent();
  }

  /**
   * 使用已有歌曲列表初始化播放列表（恢复用）
   */
  initWithSongs(songs: Song[], startIndex: number, playMode: PlayMode, playlistId: number): void {
    this.songs = songs;
    this.totalSongs = songs.length;
    this.currentIndex = (startIndex >= 0 && startIndex < songs.length) ? startIndex : 0;
    this.playMode = playMode;
    this.playlistId = playlistId;
    this.state = 'idle';
    this.randomPlayed = new Set();
  }

  // ===== 私有方法 =====

  /**
   * 加载歌单歌曲（通过宿主API桥接）
   */
  private async loadPlaylistSongs(playlistId: number): Promise<boolean> {
    try {
      // 使用 songloft.playlists.getSongs 桥接调用（与 Go WASM 版本的 hostFunctions.CallRouter 等价）
      // 这样不需要 hostBaseUrl 和 pluginToken，直接通过内部桥接访问数据库
      const songs = await songloft.playlists.getSongs(playlistId, { limit: 100000 });
      if (!songs || !Array.isArray(songs)) {
        songloft.log.error('[PlaylistManager] Bridge returned invalid songs data for playlist: ' + playlistId);
        return false;
      }
      this.songs = songs as any;
      this.totalSongs = songs.length;
      return songs.length > 0;
    } catch (e) {
      songloft.log.error('[PlaylistManager] Failed to load playlist songs: ' + String(e));
      return false;
    }
  }

  /**
   * 播放当前索引的歌曲
   */
  private async playCurrent(): Promise<boolean> {
    if (this.currentIndex < 0 || this.currentIndex >= this.songs.length) {
      songloft.log.error('[PlaylistManager] Invalid current index: ' + this.currentIndex);
      return false;
    }

    this.stopCheckTimer();

    const song = this.songs[this.currentIndex];

    // 检查服务器地址
    const serverHost = getHostBaseUrl();
    if (!serverHost) {
      songloft.log.error('[PlaylistManager] Server host not configured');
      return false;
    }

    // 读取是否强制 MP3
    const config = await this.configManager.getConfig();
    const forceMp3 = !!config.force_mp3;

    // 构造播放URL
    const songURL = await URLBuilder.buildSongURL(song, { forceMp3 });
    if (!songURL) {
      songloft.log.error('[PlaylistManager] Failed to build song URL: ' + song.title);
      return false;
    }

    songloft.log.info(`[PlaylistManager] Playing song index=${this.currentIndex} title=${song.title} artist=${song.artist} duration=${song.duration}`);

    // 调用小爱音箱播放
    const ok = await this.minaService.playURL(this.accountId, this.deviceId, songURL);
    if (!ok) {
      songloft.log.error('[PlaylistManager] Failed to play URL on device');
      return false;
    }

    this.clearVoiceSuspend();
    this.state = 'playing';
    this.playStartTimeMs = Date.now();

    // 如果歌曲时长有效，注册定时器播放下一首
    if (song.duration > 0) {
      this.startCheckTimer(song.duration);
    } else {
      songloft.log.warn('[PlaylistManager] Song duration invalid, no auto-next timer: ' + song.duration);
    }

    return true;
  }

  /**
   * 获取下一首索引（根据播放模式）
   * @returns 下一首索引，-1表示没有下一首
   */
  private getNextIndex(): number {
    const len = this.songs.length;
    if (len === 0) return -1;

    switch (this.playMode) {
      case 'order':
        // 顺序播放：到末尾停止
        if (this.currentIndex < len - 1) {
          return this.currentIndex + 1;
        }
        return -1; // 没有下一首

      case 'loop':
        // 列表循环
        return (this.currentIndex + 1) % len;

      case 'single':
        // 单曲循环：一直播放当前歌曲
        return this.currentIndex;

      case 'random':
        // 随机播放：避免重复直到全部播完
        this.randomPlayed.add(this.currentIndex);

        // 如果所有歌曲都播放过了，重置
        if (this.randomPlayed.size >= len) {
          this.randomPlayed = new Set();
        }

        // 找到未播放的歌曲
        const unplayed: number[] = [];
        for (let i = 0; i < len; i++) {
          if (!this.randomPlayed.has(i)) {
            unplayed.push(i);
          }
        }

        if (unplayed.length === 0) {
          return Math.floor(Math.random() * len);
        }

        return unplayed[Math.floor(Math.random() * unplayed.length)];

      default:
        return -1;
    }
  }

  /**
   * 获取上一首索引
   * @returns 上一首索引，-1表示没有上一首
   */
  private getPreviousIndex(): number {
    const len = this.songs.length;
    if (len === 0) return -1;

    switch (this.playMode) {
      case 'order':
        // 顺序播放：到第一首停止
        if (this.currentIndex > 0) {
          return this.currentIndex - 1;
        }
        return -1;

      case 'loop':
        // 列表循环：第一首回到最后一首
        if (this.currentIndex > 0) {
          return this.currentIndex - 1;
        }
        return len - 1;

      case 'single':
        // 单曲循环：重复当前
        return this.currentIndex;

      case 'random':
        // 随机模式：简单返回前一首
        if (this.currentIndex > 0) {
          return this.currentIndex - 1;
        }
        return len - 1;

      default:
        if (this.currentIndex > 0) {
          return this.currentIndex - 1;
        }
        return -1;
    }
  }

  /**
   * 启动切歌定时器（基于歌曲时长）
   * @param durationSec - 歌曲时长（秒）
   */
  private startCheckTimer(durationSec: number): void {
    this.stopCheckTimer();

    const delayMs = Math.floor(durationSec * 1000);
    songloft.log.info('[PlaylistManager] Timer registered delayMs=' + delayMs);

    this.checkTimer = setTimeout(() => {
      this.onSongFinished().catch(e => {
        songloft.log.error('[PlaylistManager] onSongFinished error: ' + String(e));
      });
    }, delayMs);
  }

  /**
   * 停止定时器
   */
  private stopCheckTimer(): void {
    if (this.checkTimer !== null) {
      clearTimeout(this.checkTimer);
      this.checkTimer = null;
    }
  }

  /**
   * 歌曲播放结束回调
   */
  private async onSongFinished(): Promise<void> {
    if (this.state !== 'playing') {
      songloft.log.info('[PlaylistManager] Not playing, skip auto-next');
      return;
    }

    // 通知后端当前歌曲播放完成（触发 JS 插件播放事件广播）
    const finishedSong = this.songs[this.currentIndex];
    if (finishedSong && finishedSong.id > 0) {
      callHostAPI('POST', `/api/v1/songs/${finishedSong.id}/played?source=miot`).catch(e => {
        songloft.log.warn('[PlaylistManager] songPlayed notify failed: ' + String(e));
      });
    }

    const nextIdx = this.getNextIndex();
    if (nextIdx < 0) {
      songloft.log.info('[PlaylistManager] No next song, playback complete');
      this.state = 'stopped';
      this.playStartTimeMs = 0;
      return;
    }

    this.currentIndex = nextIdx;
    const ok = await this.playCurrent();
    if (ok) {
      await this.persistState();
    } else {
      songloft.log.error('[PlaylistManager] Auto-next failed, stopping');
      this.state = 'stopped';
      this.playStartTimeMs = 0;
    }
  }

  /**
   * 持久化播放状态到设备配置
   */
  private async persistState(): Promise<void> {
    try {
      await this.configManager.updateDevice(this.accountId, this.deviceId, {
        playlist_id: this.playlistId,
        current_song_index: this.currentIndex,
        play_mode: this.playMode,
      });
    } catch (e) {
      songloft.log.warn('[PlaylistManager] Failed to persist state: ' + String(e));
    }
  }
}

// ===== PlaylistManagerMap - 多设备播放管理器集合 =====

/**
 * PlaylistManagerMap - 管理多个设备的播放管理器实例
 * key格式: "accountId:deviceId"
 */
export class PlaylistManagerMap {
  private managers: Map<string, PlaylistManager> = new Map();
  private minaService: MinaService;
  private configManager: ConfigManager;

  constructor(minaService: MinaService, configManager: ConfigManager) {
    this.minaService = minaService;
    this.configManager = configManager;
  }

  /**
   * 获取或创建播放管理器
   * 若设备配置中存有 playlistId，则自动恢复播放列表（不自动开始播放）
   */
  async getOrCreate(accountId: string, deviceId: string): Promise<PlaylistManager> {
    const key = this.makeKey(accountId, deviceId);
    const existing = this.managers.get(key);
    if (existing) {
      return existing;
    }

    // 创建新的播放管理器
    const manager = new PlaylistManager(accountId, deviceId, this.minaService, this.configManager);
    this.managers.set(key, manager);

    // 尝试从配置中恢复播放列表状态（不自动播放）
    await this.restoreFromConfig(manager, accountId, deviceId);

    return manager;
  }

  /**
   * 获取指定设备的管理器（不存在返回null）
   */
  get(accountId: string, deviceId: string): PlaylistManager | null {
    const key = this.makeKey(accountId, deviceId);
    return this.managers.get(key) ?? null;
  }

  /**
   * 移除管理器
   */
  remove(accountId: string, deviceId: string): void {
    const key = this.makeKey(accountId, deviceId);
    const manager = this.managers.get(key);
    if (manager) {
      manager.cleanup();
    }
    this.managers.delete(key);
  }

  /**
   * 清理所有管理器
   */
  cleanup(): void {
    for (const manager of this.managers.values()) {
      manager.cleanup();
    }
    this.managers.clear();
  }

  /**
   * 获取所有管理器的设备Key列表
   */
  keys(): string[] {
    return Array.from(this.managers.keys());
  }

  // ===== 内部方法 =====

  private makeKey(accountId: string, deviceId: string): string {
    return accountId + ':' + deviceId;
  }

  /**
   * 从配置中恢复播放列表（不自动播放）
   */
  private async restoreFromConfig(manager: PlaylistManager, accountId: string, deviceId: string): Promise<void> {
    try {
      const devices = await this.configManager.getDevices(accountId);
      const devCfg = devices.find(d => d.device_id === deviceId);
      if (!devCfg || !devCfg.playlist_id || devCfg.playlist_id <= 0) {
        return;
      }

      // 使用 songloft.playlists.getSongs 桥接调用加载歌单歌曲
      let songs: Song[] = [];
      try {
        const result = await songloft.playlists.getSongs(devCfg.playlist_id, { limit: 100000 });
        if (result && Array.isArray(result)) {
          songs = result as any;
        }
      } catch (e) {
        songloft.log.warn('[PlaylistManagerMap] Failed to load songs via bridge: ' + String(e));
      }

      if (songs.length > 0) {
        const startIndex = devCfg.current_song_index || 0;
        const playMode = (devCfg.play_mode || 'order') as PlayMode;
        manager.initWithSongs(songs, startIndex, playMode, devCfg.playlist_id);
        songloft.log.info(`[PlaylistManagerMap] Restored playlist from config playlistId=${devCfg.playlist_id} index=${startIndex} mode=${playMode}`);
      }
    } catch (e) {
      songloft.log.warn('[PlaylistManagerMap] Failed to restore playlist from config: ' + String(e));
    }
  }
}
