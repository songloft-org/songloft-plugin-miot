// MIoT 智能音箱插件 - 歌单播放管理器
// 翻译自 Go 源码: plugins/songloft-plugin-xiaomi/player/playlist_manager.go
// 管理播放状态机、播放模式切换、自动切歌

/// <reference types="@songloft/plugin-sdk" />

import { ConfigManager } from '../config/manager';
import { MinaService } from '../service/service';
import { URLBuilder } from './url_builder';
import { getHostBaseUrl, callHostAPI } from '../utils/http';
import type { PlayState, PlayMode, PlayerStatus, DeviceTargetRef, DeviceGroup } from '../types';

/** 分配临时歌单唯一负数 ID（每个设备/歌手各一个，互不冲突） */
let nextTempPlaylistId = -1;
function allocTempPlaylistId(): number {
  return nextTempPlaylistId--;
}

/** 判断 playlistId 是否为临时歌单 */
export function isTempPlaylistId(id: number): boolean {
  return id < 0;
}

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
  private tempPlaylistName: string = ''; // 临时歌单名称（如"歌手: 周杰伦"），playlistId < 0 时有效
  private readonly tempId: number; // 该 manager 的固定临时歌单 ID（构造时分配，生命周期内复用）
  private tempArtistQuery: string = ''; // 临时歌手歌单的原始搜索词，用于持久化和恢复
  private pendingTempArtist: string = ''; // 待恢复的临时歌手名（索引就绪后自动恢复）
  private _lastLoadNotFound: boolean = false; // 上次 loadPlaylistSongs 失败是否因歌单不存在(ID 过期)
  // 输出目标设备集合：独立设备时仅含自身；分组时含组内全部成员。
  // 一个分组共用一个 PlaylistManager（同一套队列/索引/播放模式/定时器/随机数），
  // 播放/暂停/停止/切歌等指令统一下发给 targets 里的所有音箱，从根本上保证多房间同步、随机不跑偏。
  // accountId/deviceId 仍作为「主设备」用于持久化、日志与自动切歌定时器的进度校准参考。
  private targets: DeviceTargetRef[];

  constructor(
    accountId: string,
    deviceId: string,
    minaService: MinaService,
    configManager: ConfigManager,
  ) {
    this.accountId = accountId;
    this.deviceId = deviceId;
    this.targets = [{ account_id: accountId, device_id: deviceId }];
    this.minaService = minaService;
    this.configManager = configManager;
    this.tempId = allocTempPlaylistId();
  }

  // ===== 公开方法 =====

  /**
   * 播放歌单
   * @param playlistId - 歌单ID
   * @param startIndex - 起始歌曲索引（默认0）
   * @param mode - 播放模式（默认order）
   * @param opts.randomStart - 忽略 startIndex，加载歌单后随机挑一首作为起点
   * @returns 是否成功
   */
  async play(playlistId: number, startIndex?: number, mode?: PlayMode, opts?: { randomStart?: boolean }): Promise<boolean> {
    // 立即停止定时器和重置状态，防止 loadPlaylistSongs 期间旧定时器触发 onSongFinished
    this.stopCheckTimer();
    this.state = 'idle';
    this.playStartTimeMs = 0;
    this._lastLoadNotFound = false;

    // 加载歌单歌曲
    const loaded = await this.loadPlaylistSongs(playlistId);
    if (!loaded) {
      songloft.log.error('[PlaylistManager] play: loadPlaylistSongs returned false, playlistId=' + playlistId);
      return false;
    }

    if (this.songs.length === 0) {
      songloft.log.warn('[PlaylistManager] Playlist is empty: ' + playlistId);
      return false;
    }

    // 设置播放参数
    this.playlistId = playlistId;
    this.tempPlaylistName = '';
    this.tempArtistQuery = '';
    this.pendingTempArtist = '';
    if (opts?.randomStart && this.songs.length > 0) {
      this.currentIndex = Math.floor(Math.random() * this.songs.length);
    } else {
      this.currentIndex = (startIndex !== undefined && startIndex >= 0 && startIndex < this.songs.length)
        ? startIndex : 0;
    }
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
   * 播放歌单并从指定歌曲 ID 开始播放
   * 用于外部搜索导入并追加到歌单后，接管为「完整歌单播放」，
   * 使歌曲播完后由切歌定时器自动续播歌单其余歌曲（issue #53）。
   * 找不到该歌曲时回退到从歌单头部播放。
   * @param playlistId - 歌单ID
   * @param songId - 起始歌曲ID（通常是刚追加到歌单末尾的那首）
   * @param mode - 播放模式（默认order）
   * @returns 是否成功
   */
  async playPlaylistFromSong(playlistId: number, songId: number, mode?: PlayMode): Promise<boolean> {
    // 立即停止定时器和重置状态，防止 loadPlaylistSongs 期间旧定时器触发 onSongFinished
    this.stopCheckTimer();
    this.state = 'idle';
    this.playStartTimeMs = 0;
    this._lastLoadNotFound = false;

    const loaded = await this.loadPlaylistSongs(playlistId);
    if (!loaded) {
      songloft.log.error('[PlaylistManager] playPlaylistFromSong: loadPlaylistSongs returned false, playlistId=' + playlistId);
      return false;
    }

    if (this.songs.length === 0) {
      songloft.log.warn('[PlaylistManager] Playlist is empty: ' + playlistId);
      return false;
    }

    // 定位目标歌曲索引；追加的歌曲通常在末尾，找不到时回退到从头播放
    let startIndex = this.songs.findIndex(s => s.id === songId);
    if (startIndex < 0) {
      songloft.log.warn(`[PlaylistManager] Song ${songId} not found in playlist ${playlistId}, starting from head`);
      startIndex = 0;
    }

    this.playlistId = playlistId;
    this.tempPlaylistName = '';
    this.tempArtistQuery = '';
    this.pendingTempArtist = '';
    this.currentIndex = startIndex;
    this.playMode = mode || 'order';
    this.randomPlayed = new Set();

    const ok = await this.playCurrent();
    if (!ok) {
      songloft.log.error('[PlaylistManager] playPlaylistFromSong: Failed to play current song');
      return false;
    }

    await this.persistState();

    songloft.log.info(`[PlaylistManager] Playlist started from song id=${songId} playlistId=${playlistId} index=${startIndex} mode=${this.playMode} total=${this.songs.length}`);
    return true;
  }

  /**
   * 播放预构建的歌曲列表（无需歌单ID）。
   * 用于"播放歌手XX的歌"等场景，将跨歌单收集的歌曲作为虚拟播放列表。
   * @param artistQuery - 歌手搜索词，用于重启后恢复
   */
  async playWithSongs(songs: Song[], startIndex: number, mode: PlayMode, label?: string, artistQuery?: string): Promise<boolean> {
    this.stopCheckTimer();
    this.state = 'idle';
    this.playStartTimeMs = 0;
    this._lastLoadNotFound = false;
    this.pendingTempArtist = '';

    if (!songs || songs.length === 0) {
      songloft.log.warn('[PlaylistManager] playWithSongs: empty song list');
      return false;
    }

    this.songs = songs;
    this.totalSongs = songs.length;
    this.playlistId = this.tempId;
    this.tempPlaylistName = label || '';
    this.tempArtistQuery = artistQuery !== undefined ? artistQuery : this.tempArtistQuery;
    this.currentIndex = (startIndex >= 0 && startIndex < songs.length) ? startIndex : 0;
    this.playMode = mode;
    this.randomPlayed = new Set();

    const ok = await this.playCurrent();
    if (!ok) {
      songloft.log.error('[PlaylistManager] playWithSongs: failed to play current song');
      return false;
    }

    songloft.log.info(`[PlaylistManager] playWithSongs started id=${this.playlistId} label="${this.tempPlaylistName}" index=${this.currentIndex} mode=${this.playMode} total=${this.songs.length}`);
    return true;
  }

  /**
   * 对所有输出目标设备并发执行同一设备操作，单个失败仅告警不影响其它成员。
   * 返回是否「至少一台」成功（用于 play/resume 判定整体是否成功）。
   */
  private async forEachTarget(
    label: string,
    fn: (t: DeviceTargetRef) => Promise<boolean>,
  ): Promise<boolean> {
    const results = await Promise.all(this.targets.map(async (t) => {
      try {
        return await fn(t);
      } catch (e) {
        songloft.log.warn(`[PlaylistManager] ${label} failed for ${t.account_id}:${t.device_id}: ${String(e)}`);
        return false;
      }
    }));
    return results.some(r => r);
  }

  /**
   * 暂停播放（保持状态，可恢复）
   */
  async pause(): Promise<void> {
    this.stopCheckTimer();
    this.clearVoiceSuspend();
    this.state = 'paused';
    // 不重置 playStartTimeMs，保持当前播放进度

    // 暂停所有目标设备（分组时为组内全部音箱）
    await this.forEachTarget('pause', t => this.minaService.pausePlay(t.account_id, t.device_id));

    songloft.log.info('[PlaylistManager] Playback paused');
  }

  /**
   * 停止播放
   */
  async stop(): Promise<void> {
    this.stopCheckTimer();
    this.clearVoiceSuspend();
    this.state = 'stopped';
    this.playStartTimeMs = 0;

    await this.forEachTarget('stop', t => this.minaService.stopPlay(t.account_id, t.device_id));

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
   * 设置输出目标设备集合（分组时为组内全部成员；独立时为自身）。
   * 由 PlaylistManagerMap 在解析分组后注入/刷新。空集合时回退为主设备自身，避免无目标。
   */
  setTargets(targets: DeviceTargetRef[]): void {
    this.targets = (targets && targets.length > 0)
      ? targets.slice()
      : [{ account_id: this.accountId, device_id: this.deviceId }];
  }

  /** 主设备（分组时为成员列表第一个）：用于持久化与自动切歌定时器的进度校准参考。 */
  getPrimary(): DeviceTargetRef {
    return { account_id: this.accountId, device_id: this.deviceId };
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
      playlist_name: this.tempPlaylistName || undefined,
    };
  }

  /** 返回当前加载的歌曲列表（临时歌单/真实歌单均可），供 handler 读取 */
  getSongs(): any[] {
    return this.songs;
  }

  /** 返回该 manager 的固定临时歌单 ID */
  getTempId(): number {
    return this.tempId;
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
   * 是否仍处于允许用设备进度校准本地自动切歌定时器的窗口。
   * 仅用于播放刚开始的缓冲修正；歌曲接近结束后不允许设备端小进度回拨定时器，
   * 否则某些音箱循环拉同一 URL 时会把自动下一首无限推迟。
   */
  canCalibrateAutoNextTimer(devicePositionSec: number): boolean {
    const song = this.getCurrentSong();
    if (this.state !== 'playing' || !song || song.duration <= 0 || this.playStartTimeMs <= 0) {
      return false;
    }

    const elapsedSec = (Date.now() - this.playStartTimeMs) / 1000;
    const remainingSec = song.duration - elapsedSec;
    if (remainingSec <= 15 || elapsedSec >= Math.max(45, song.duration * 0.5)) {
      return false;
    }

    // 播放一段时间后设备又回到开头，通常表示音箱在重拉同一首，不应用它重置自动切歌。
    if (elapsedSec > 15 && devicePositionSec < 3) {
      return false;
    }

    return true;
  }

  /**
   * 恢复播放（使用 play 接口继续，不重发 URL）
   * 用于语音命令（如调音量）中断 URL 播放后恢复
   * 同时重置切歌定时器以补偿暂停时间
   */
  async resumePlayback(): Promise<boolean> {
    if ((this.state !== 'playing' && this.state !== 'paused') || this.songs.length === 0) {
      return false;
    }

    this.stopCheckTimer();

    const ok = await this.forEachTarget('resume', t => this.minaService.resumePlay(t.account_id, t.device_id));
    if (!ok) {
      songloft.log.warn('[PlaylistManager] resumePlay failed');
      return false;
    }

    this.state = 'playing';

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
    } else {
      this.startCheckTimer(0.1);
      songloft.log.info(`[PlaylistManager] Timer reset: song ended (remaining=${remaining.toFixed(1)}s), triggering auto-next`);
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

  /**
   * 用歌手歌曲列表初始化临时歌单（恢复用，不自动播放）
   */
  initWithTempArtist(songs: Song[], artistName: string, playMode: PlayMode): void {
    this.songs = songs;
    this.totalSongs = songs.length;
    this.currentIndex = 0;
    this.playMode = playMode;
    this.playlistId = this.tempId;
    this.tempPlaylistName = '歌手: ' + artistName;
    this.tempArtistQuery = artistName;
    this.pendingTempArtist = '';
    this.state = 'idle';
    this.randomPlayed = new Set();
  }

  // ===== 私有方法 =====

  /**
   * 加载歌单歌曲（通过宿主API桥接）
   * 首次返回空时延迟 500ms 重试一次（规避 SQLite WAL 长时间运行后的间歇性空返回）
   */
  private async loadPlaylistSongs(playlistId: number): Promise<boolean> {
    const attempt = async (retry: boolean): Promise<boolean> => {
      try {
        const songs = await songloft.playlists.getSongs(playlistId, { limit: 100000 });
        const desc = songs ? (Array.isArray(songs) ? String(songs.length) : 'non-array') : 'null';
        songloft.log.info(`[PlaylistManager] loadPlaylistSongs playlistId=${playlistId} returned=${desc}${retry ? ' (retry)' : ''}`);
        if (!songs || !Array.isArray(songs)) {
          songloft.log.error('[PlaylistManager] Bridge returned invalid data for playlist: ' + playlistId);
          return false;
        }
        this.songs = songs as any;
        this.totalSongs = songs.length;
        return songs.length > 0;
      } catch (e) {
        songloft.log.error(`[PlaylistManager] loadPlaylistSongs exception playlistId=${playlistId}${retry ? ' (retry)' : ''}: ${String(e)}`);
        return false;
      }
    };

    const ok = await attempt(false);
    if (ok) {
      return true;
    }

    songloft.log.warn(`[PlaylistManager] loadPlaylistSongs empty or failed, retrying in 500ms playlistId=${playlistId}`);
    await new Promise(r => setTimeout(r, 500));
    const retryOk = await attempt(true);
    if (retryOk) {
      return true;
    }

    // retry 后仍为空/失败：检测歌单是否真的不存在（扫描后 auto-create 歌单 ID 变化会导致旧 ID 失效）。
    // 区分「歌单不存在(ID 过期)」与「歌单存在但为空」，供上层决定是否刷新索引重试。
    try {
      const pl = await songloft.playlists.getById(playlistId);
      if (!pl) {
        this._lastLoadNotFound = true;
        songloft.log.warn(`[PlaylistManager] playlist ${playlistId} not found (stale ID), signaling caller to refresh index`);
      }
    } catch (e) {
      songloft.log.warn(`[PlaylistManager] getById check failed playlistId=${playlistId}: ${String(e)}`);
    }
    return false;
  }

  /**
   * 上次播放失败是否因歌单 ID 已失效（歌单不存在）。
   * 用于上层在扫描导致 auto-create 歌单 ID 变化后，刷新索引并重试。
   */
  isLastPlayNotFound(): boolean {
    return this._lastLoadNotFound;
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

    // 读取是否强制 MP3 / 电台转码 / 音量均衡
    const config = await this.configManager.getConfig();
    const forceMp3 = !!config.force_mp3;
    const radioForceMp3 = !!config.radio_force_mp3;
    const normalize = !!config.volume_normalize;

    // 构造播放URL
    const songURL = await URLBuilder.buildSongURL(song, { forceMp3, radioForceMp3, normalize });
    if (!songURL) {
      songloft.log.error('[PlaylistManager] Failed to build song URL: ' + song.title);
      return false;
    }

    songloft.log.info(`[PlaylistManager] Playing song index=${this.currentIndex} title=${song.title} artist=${song.artist} duration=${song.duration} targets=${this.targets.length}`);

    // 下发到所有目标设备（分组时为组内全部音箱；传结构化歌曲信息供触屏歌词模式匹配曲库）。
    // 至少一台成功即视为成功；个别成员离线/失败不影响整组继续（自动切歌定时器仍以本机时长驱动）。
    const ok = await this.forEachTarget('playURL', t => this.minaService.playURL(t.account_id, t.device_id, songURL, {
      title: song.title,
      artist: song.artist,
    }));
    if (!ok) {
      songloft.log.error('[PlaylistManager] Failed to play URL on any target device');
      return false;
    }

    this.clearVoiceSuspend();
    this.state = 'playing';
    this.playStartTimeMs = Date.now();

    // 如果歌曲时长有效，注册定时器播放下一首
    if (song.duration > 0) {
      const offset = config.song_transition_offset || 0;
      const adjustedDuration = Math.max(1, song.duration + offset);
      this.startCheckTimer(adjustedDuration);
    } else {
      songloft.log.warn('[PlaylistManager] Song duration invalid, no auto-next timer: ' + song.duration);
    }

    this.prefetchNextSong();

    return true;
  }

  /**
   * 预缓存下一首歌曲（fire-and-forget）
   * 调用后端 ?prefetch=1 端点触发异步缓存+转码，减少切歌时的冷启动延迟。
   * force_mp3 开启时给 prefetch URL 也追加 format=mp3，使预热的转码产物与真实播放 URL
   * （buildSongURL 的 &format=mp3）命中同一缓存键；否则预热的是源格式、播放要 mp3，
   * 切歌时 mp3 转码仍冷启动，预热白做。
   */
  private prefetchNextSong(): void {
    const nextIdx = this.getNextIndex();
    if (nextIdx < 0 || nextIdx === this.currentIndex) return;

    const nextSong = this.songs[nextIdx];
    if (!nextSong || !nextSong.url) return;
    if (nextSong.type === 'local') return;
    if (nextSong.url.startsWith('http://') || nextSong.url.startsWith('https://')) return;

    // 捕获到局部常量：跨 async 边界后 TS 不再对 nextSong.url 做非空收窄。
    const songUrl = nextSong.url;
    const title = nextSong.title;

    void (async () => {
      let forceMp3 = false;
      let volumeNormalize = false;
      try {
        const config = await this.configManager.getConfig();
        forceMp3 = !!config.force_mp3;
        volumeNormalize = !!config.volume_normalize;
      } catch {
        // 读配置失败按不强制处理，仍预热源格式
      }
      const separator = songUrl.includes('?') ? '&' : '?';
      let prefetchPath = songUrl + separator + 'prefetch=1' + (forceMp3 ? '&format=mp3' : '');
      if (volumeNormalize) {
        prefetchPath += '&normalize=1';
        if (!forceMp3) {
          prefetchPath += '&format=mp3';
        }
      }
      try {
        await callHostAPI('GET', prefetchPath, undefined, { timeoutMs: 5000 });
        songloft.log.info(`[PlaylistManager] Prefetch next song index=${nextIdx} title=${title}${forceMp3 ? ' (mp3)' : ''}`);
      } catch (e) {
        songloft.log.warn('[PlaylistManager] Prefetch failed: ' + String(e));
      }
    })();
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

    const delayMs = Math.max(1, Math.floor(durationSec * 1000));
    songloft.log.info('[PlaylistManager] Timer registered delayMs=' + delayMs);

    this.checkTimer = setTimeout(() => {
      this.checkTimer = null;
      songloft.log.info('[PlaylistManager] Timer fired');
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
    // 分组共用一个 PlaylistManager：这里的切歌会经 playCurrent 一次性下发给组内所有音箱，
    // 只有一份队列/随机数/定时器，天然全组同一首，无需组长选举或成员间同步。
    await this.advanceToNext();
  }

  /**
   * 切到下一首并播放（自动续播核心）。playCurrent 会把新歌下发给全部目标设备。
   */
  private async advanceToNext(): Promise<void> {
    songloft.log.info(`[PlaylistManager] Song finished, advancing from index=${this.currentIndex}`);

    // 通知后端当前歌曲播放完成（触发 JS 插件播放事件广播）
    const finishedSong = this.songs[this.currentIndex];
    if (finishedSong && finishedSong.id > 0) {
      callHostAPI('POST', `/api/v1/songs/${finishedSong.id}/played?source=miot`, undefined, { timeoutMs: 3000 }).catch(e => {
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
      return;
    }

    // 第一次失败（常见于设备超时 code=3012），等 3 秒重试当前歌曲
    const retryIndex = this.currentIndex;
    songloft.log.warn('[PlaylistManager] Auto-next play failed, retrying in 3s');
    await new Promise(r => setTimeout(r, 3000));
    if (this.state !== 'playing' || this.currentIndex !== retryIndex) return;

    const retryOk = await this.playCurrent();
    if (retryOk) {
      await this.persistState();
      return;
    }

    // 重试仍失败，尝试跳到下一首
    const skipIdx = this.getNextIndex();
    if (skipIdx >= 0 && skipIdx !== this.currentIndex) {
      songloft.log.warn('[PlaylistManager] Retry failed, skipping to next song');
      this.currentIndex = skipIdx;
      const skipOk = await this.playCurrent();
      if (skipOk) {
        await this.persistState();
        return;
      }
    }

    songloft.log.error('[PlaylistManager] Auto-next failed after retry, stopping');
    this.state = 'stopped';
    this.playStartTimeMs = 0;
  }

  /**
   * 持久化播放状态到设备配置
   */
  private async persistState(): Promise<void> {
    if (isTempPlaylistId(this.playlistId)) {
      if (this.tempArtistQuery) {
        try {
          await this.configManager.updateDevice(this.accountId, this.deviceId, {
            temp_artist: this.tempArtistQuery,
            play_mode: this.playMode,
          });
        } catch (e) {
          songloft.log.warn('[PlaylistManager] Failed to persist temp artist: ' + String(e));
        }
      }
      return;
    }
    try {
      await this.configManager.updateDevice(this.accountId, this.deviceId, {
        playlist_id: this.playlistId,
        current_song_index: this.currentIndex,
        play_mode: this.playMode,
        temp_artist: '',
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
  // key: 分组用 'grp:<groupId>'，独立设备用 '<accountId>:<deviceId>'。一个分组共用一个 manager。
  private managers: Map<string, PlaylistManager> = new Map();
  // 分组快照（仅含 ≥2 成员的组）：同步可读，避免 get()/getOrCreate 每次读存储、也避免惰性索引过期。
  // 由 refreshGroups() 在启动与分组增删改时刷新。
  private groupsSnapshot: DeviceGroup[] = [];
  private minaService: MinaService;
  private configManager: ConfigManager;

  constructor(minaService: MinaService, configManager: ConfigManager) {
    this.minaService = minaService;
    this.configManager = configManager;
  }

  /**
   * 刷新分组快照（启动时与分组增删改后调用）。除更新快照外，还处理因成员归属变化而失效的 manager：
   * - 组 manager（key=groupId，无冒号）：组已删除/成员<2 → 清理；主设备仍是成员首位 → 刷新成员列表；
   *   主设备变化（首位换人/被移出，primary 不可变）→ 清理待重建。
   * - 独立 manager（key='acct:dev'，含冒号）：其设备现已并入某组 → 清理（交给共享 manager，避免双份定时器）。
   * 说明：组 manager 的 key 即 groupId（形如 'grp_<ts>_<rand>'，不含冒号），与独立 key 靠是否含冒号区分，
   *      不会与 account_id 恰为某值时的独立 key 冲突。
   */
  async refreshGroups(): Promise<void> {
    try {
      const groups = await this.configManager.getDeviceGroups();
      this.groupsSnapshot = groups.filter(g => g.members && g.members.length >= 2);
    } catch (e) {
      songloft.log.warn('[PlaylistManagerMap] refreshGroups failed: ' + String(e));
      return;
    }
    for (const [key, manager] of Array.from(this.managers.entries())) {
      if (!key.includes(':')) {
        // 组 manager：key 即 groupId
        const group = this.groupsSnapshot.find(g => g.id === key);
        if (!group) {
          manager.cleanup();
          this.managers.delete(key);
          continue;
        }
        const p = manager.getPrimary();
        const head = group.members[0];
        if (p.account_id === head.account_id && p.device_id === head.device_id) {
          manager.setTargets(group.members.slice()); // 主设备不变：仅刷新成员，保留播放状态
        } else {
          manager.cleanup(); // 主设备变了（primary 不可变）→ 丢弃，下次 getOrCreate 以新首位重建
          this.managers.delete(key);
        }
      } else {
        // 独立 manager：若其设备现已属某分组，则应由共享 manager 接管
        const p = manager.getPrimary();
        if (!this.resolveTargetSync(p.account_id, p.device_id).managerKey.includes(':')) {
          manager.cleanup();
          this.managers.delete(key);
        }
      }
    }
  }

  /**
   * 同步解析某设备应归属的 manager：在分组（≥2 成员）中则归属该组共享 manager（输出目标为全部成员，
   * 主设备取成员列表第一个）；否则为独立设备 manager（仅自身）。基于内存快照，无异步、无过期索引。
   * 组 manager 的 key 直接用 groupId（不含冒号），独立 key 为 'acct:dev'（含冒号），二者天然可区分。
   */
  private resolveTargetSync(accountId: string, deviceId: string): {
    managerKey: string;
    primary: DeviceTargetRef;
    targets: DeviceTargetRef[];
  } {
    const group = this.groupsSnapshot.find(g =>
      g.members.some(m => m.account_id === accountId && m.device_id === deviceId),
    );
    if (group) {
      return {
        managerKey: group.id,
        primary: group.members[0],
        targets: group.members.slice(),
      };
    }
    const self = { account_id: accountId, device_id: deviceId };
    return { managerKey: this.makeKey(accountId, deviceId), primary: self, targets: [self] };
  }

  /**
   * 获取或创建播放管理器。
   * 分组设备解析到该组共享的 manager（输出目标为组内全部音箱）；独立设备解析到自身 manager。
   * 若设备配置中存有 playlistId，则新建时自动恢复播放列表（不自动开始播放）。
   */
  async getOrCreate(accountId: string, deviceId: string): Promise<PlaylistManager> {
    const { managerKey, primary, targets } = this.resolveTargetSync(accountId, deviceId);

    const existing = this.managers.get(managerKey);
    if (existing) {
      existing.setTargets(targets); // 刷新成员（成员可能已变更）
      return existing;
    }

    // 组共享 manager 接管成员设备：清理这些设备遗留的独立 manager，避免重复定时器/双份队列
    if (!managerKey.includes(':')) {
      for (const t of targets) {
        const dk = this.makeKey(t.account_id, t.device_id);
        const stale = this.managers.get(dk);
        if (stale) {
          stale.cleanup();
          this.managers.delete(dk);
        }
      }
    }

    const manager = new PlaylistManager(primary.account_id, primary.device_id, this.minaService, this.configManager);
    manager.setTargets(targets);

    // 从主设备配置恢复播放列表状态（不自动播放）
    await this.restoreFromConfig(manager, primary.account_id, primary.device_id);

    // await 期间可能有并发 getOrCreate 建好了同 key，或 refreshGroups 令归属变化：以最新为准，
    // 避免返回「孤儿」实例造成双份驱动
    const concurrent = this.managers.get(managerKey);
    if (concurrent) {
      manager.cleanup();
      concurrent.setTargets(targets);
      return concurrent;
    }
    if (this.resolveTargetSync(accountId, deviceId).managerKey !== managerKey) {
      // 归属在 await 期间被改（分组增删改）→ 丢弃本实例，按最新归属重建
      manager.cleanup();
      return this.getOrCreate(accountId, deviceId);
    }
    this.managers.set(managerKey, manager);
    return manager;
  }

  /**
   * 获取指定设备的管理器（不存在返回null）。基于分组快照同步解析，分组设备命中共享 manager。
   */
  get(accountId: string, deviceId: string): PlaylistManager | null {
    const { managerKey } = this.resolveTargetSync(accountId, deviceId);
    return this.managers.get(managerKey) ?? null;
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

  /** 通过 playlistId 查找 manager（用于临时歌单的歌曲列表查询） */
  findByPlaylistId(playlistId: number): PlaylistManager | null {
    for (const manager of this.managers.values()) {
      if (manager.getStatus().playlist_id === playlistId) {
        return manager;
      }
    }
    return null;
  }

  /** 返回所有活跃的临时歌单信息（供歌单列表接口追加） */
  getTempPlaylists(): { id: number; name: string; songCount: number }[] {
    const result: { id: number; name: string; songCount: number }[] = [];
    for (const manager of this.managers.values()) {
      const status = manager.getStatus();
      if (isTempPlaylistId(status.playlist_id) && status.playlist_name) {
        result.push({
          id: status.playlist_id,
          name: status.playlist_name,
          songCount: manager.getSongs().length,
        });
      }
    }
    return result;
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
      if (!devCfg) return;

      // 检测临时歌手歌单：记录待恢复标记，等索引就绪后由 restoreTempPlaylists 完成
      const tempArtist = devCfg.temp_artist;
      if (tempArtist && typeof tempArtist === 'string' && tempArtist.trim()) {
        (manager as any).pendingTempArtist = tempArtist.trim();
        songloft.log.info(`[PlaylistManagerMap] Pending temp artist restore: "${tempArtist}" for ${deviceId}`);
      }

      if (!devCfg.playlist_id || devCfg.playlist_id <= 0) {
        return;
      }

      // 使用 songloft.playlists.getSongs 桥接调用加载歌单歌曲
      let songs: Song[] = [];
      try {
        const result = await songloft.playlists.getSongs(devCfg.playlist_id, { limit: 100000 });
        const desc = result ? (Array.isArray(result) ? String(result.length) : 'non-array') : 'null';
        songloft.log.info(`[PlaylistManagerMap] restoreFromConfig playlistId=${devCfg.playlist_id} songs=${desc}`);
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

  /**
   * 索引就绪后调用：遍历所有 manager，完成待恢复的临时歌手歌单。
   * 从索引中搜索歌手歌曲，加载完整歌曲信息，初始化临时歌单（不自动播放）。
   */
  async restoreTempPlaylists(indexingManager: import('../indexing/manager').IndexingManager): Promise<void> {
    for (const [key, manager] of Array.from(this.managers.entries())) {
      const artist = (manager as any).pendingTempArtist;
      if (!artist) continue;

      try {
        const artistLocs = indexingManager.findSongsByArtist(artist);
        if (artistLocs.length === 0) {
          songloft.log.info(`[PlaylistManagerMap] restoreTempPlaylists: no songs for "${artist}", skipping`);
          (manager as any).pendingTempArtist = '';
          continue;
        }

        const byPlaylist = new Map<number, Set<number>>();
        for (const loc of artistLocs) {
          let ids = byPlaylist.get(loc.playlistId);
          if (!ids) { ids = new Set(); byPlaylist.set(loc.playlistId, ids); }
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
            songloft.log.warn(`[PlaylistManagerMap] restoreTempPlaylists: failed to load playlist ${plId}: ${String(e)}`);
          }
        }

        if (fullSongs.length > 0) {
          const playMode = await this.getDevicePlayMode(manager);
          manager.initWithTempArtist(fullSongs as any, artist, playMode);
          songloft.log.info(`[PlaylistManagerMap] Restored temp artist "${artist}" with ${fullSongs.length} songs for ${key}`);
        } else {
          (manager as any).pendingTempArtist = '';
          songloft.log.info(`[PlaylistManagerMap] restoreTempPlaylists: no playable songs for "${artist}"`);
        }
      } catch (e) {
        songloft.log.warn(`[PlaylistManagerMap] restoreTempPlaylists error for "${artist}": ${String(e)}`);
        (manager as any).pendingTempArtist = '';
      }
    }
  }

  private async getDevicePlayMode(manager: PlaylistManager): Promise<PlayMode> {
    try {
      const p = manager.getPrimary();
      const devices = await this.configManager.getDevices(p.account_id);
      const devCfg = devices.find(d => d.device_id === p.device_id);
      return (devCfg?.play_mode || 'random') as PlayMode;
    } catch {
      return 'random';
    }
  }
}
