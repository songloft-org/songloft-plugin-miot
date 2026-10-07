// MIoT 智能音箱插件 - Mina HTTP 客户端
// 翻译自 Go 源码: plugins/songloft-plugin-xiaomi/pkg/mina/mina_client.go
// 设备控制 API 客户端：设备列表、播放控制、音量、TTS、对话记录

import { CookieJar } from '../utils/cookie';
import { fetchWithRedirects } from '../utils/http';
import { generateDeviceId } from '../utils/crypto';
import { isDebugLog } from '../utils/debug';
import {
  MINA_API_BASE_URL,
  MINA_SID,
  XIAOMI_IO_SID,
  SERVICE_TOKEN_VALID_HOURS,
  MAX_RETRIES,
  formatUserAgent,
  formatLatestAskUrl,
  shouldUseMinaForAsk,
  needUsePlayMusicAPI,
  getTTSCommand,
} from './constants';
import { MiIOClient } from '../miio/client';
import type { XiaomiTokenInfo, MinaDevice, AskMessage } from '../types';
import type { DeviceInfoRaw, DeviceListResponse, UbusResponse, NlpResultData, NlpInfoData, NlpDetail, ConversationData, MusicSearchResponse } from './models';

const DEFAULT_MUSIC_AUDIO_ID = '1732418460076477549';
const MUSIC_CP_ID = '355454500';

/** player_get_play_status 的 status 值：正在播放 */
const PLAY_STATUS_PLAYING = 1;
/** 暂停后回读设备状态的次数（全部仍为 playing 才判定 pause 未生效） */
const PAUSE_VERIFY_ATTEMPTS = 2;
/** 每次回读前的等待时间（ms），给设备状态上报留缓冲 */
const PAUSE_VERIFY_DELAY_MS = 700;

const UBUS_TIMEOUT_MS = 5000;
const STATUS_INTERVAL_MS = 5000;
const STATUS_FAILURE_DELAYS_MS = [5000, 60000, 300000, 600000];

export interface StatusQueryOptions {
  /** 控制操作后的有限次数回读，绕过后台节流；仍不能复用操作前的采样。 */
  verify?: boolean;
}

interface StatusQuery {
  revision: number;
  failures: number;
  nextAt: number;
  sample?: { revision: number; result: UbusResponse; at: number };
  inflight?: { revision: number; promise: Promise<UbusResponse | null> };
}

interface UbusTask {
  status: boolean;
  run: () => Promise<UbusResponse | null>;
  resolve: (value: UbusResponse | null) => void;
  reject: (reason: unknown) => void;
}

interface UbusQueue {
  running: boolean;
  tasks: UbusTask[];
}

export interface PlayMetadata {
  title: string;
  artist?: string;
}

/**
 * MinaHTTPClient - 小爱音箱 API 客户端
 * 提供设备控制、播放管理、对话记录获取等功能
 */
export class MinaHTTPClient {
  private tokenInfo: XiaomiTokenInfo;
  private userAgent: string;
  private onTokenExpired?: () => Promise<boolean>;
  private ubusQueues = new Map<string, UbusQueue>();
  private statusQueries = new Map<string, StatusQuery>();

  constructor(tokenInfo: XiaomiTokenInfo, onTokenExpired?: () => Promise<boolean>) {
    this.tokenInfo = tokenInfo;
    this.userAgent = formatUserAgent(tokenInfo.device_id);
    this.onTokenExpired = onTokenExpired;
  }

  /**
   * 从手动输入的 token 创建客户端
   */
  static fromManualToken(userId: string, serviceToken: string, ssecurity = ''): MinaHTTPClient {
    const deviceId = generateDeviceId();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + SERVICE_TOKEN_VALID_HOURS * 3600 * 1000);

    const tokenInfo: XiaomiTokenInfo = {
      user_id: userId,
      device_id: deviceId,
      services: {
        [MINA_SID]: {
          service_token: serviceToken,
          ssecurity,
          expires_at: expiresAt.getTime(),
        },
      },
      created_at: now.toISOString(),
      expires_at: expiresAt.toISOString(),
    };

    return new MinaHTTPClient(tokenInfo);
  }

  /** 获取当前 token 信息 */
  getTokenInfo(): XiaomiTokenInfo {
    return this.tokenInfo;
  }

  /** 更新 token 信息（用于 token 刷新后同步） */
  updateTokenInfo(newInfo: XiaomiTokenInfo): void {
    this.tokenInfo = newInfo;
    this.userAgent = formatUserAgent(newInfo.device_id);
  }

  /** 设置 token 过期回调 */
  setOnTokenExpired(fn: () => Promise<boolean>): void {
    this.onTokenExpired = fn;
  }

  /** 检查 token 是否有效 */
  isTokenValid(): boolean {
    if (!this.tokenInfo || !this.tokenInfo.user_id) return false;
    const svc = this.tokenInfo.services[MINA_SID];
    if (!svc || !svc.service_token) return false;
    if (svc.expires_at && Date.now() > svc.expires_at) return false;
    return true;
  }

  // ===== 设备相关 =====

  /**
   * 获取设备列表
   */
  async getDeviceList(): Promise<MinaDevice[]> {
    const apiUrl = `${MINA_API_BASE_URL}/admin/v2/device_list?master=1`;
    const result = await this.doGetRequest<DeviceListResponse>(apiUrl);
    if (!result || result.code !== 0 || !result.data) {
      return [];
    }

    return result.data.map((d: DeviceInfoRaw) => ({
      deviceID: d.deviceID,
      name: d.name,
      miotDID: d.miotDID,
      model: d.model,
      hardware: d.hardware,
      alias: d.alias,
      presence: d.presence,
    }));
  }

  // ===== 播放控制 =====

  /**
   * 播放音乐 URL（根据设备型号自动选择方法）
   * @param deviceId - 设备 ID
   * @param url - 音频 URL
   * @param hardware - 设备硬件型号（用于选择播放方法）
   * @param disabledModels - 用户显式禁用 Music API 的型号列表（优先于默认白名单）
   * @param lyricsMode - 触屏歌词模式：仅在 Music API 播放路径上启用，
   *   逐首搜云端曲库匹配真实 audioID（搜不到回退 customAudioId），使触屏音箱显示歌词。
   *   参考 xiaomusic：player_play_music 有兼容性风险，非兼容型号仍走 player_play_url。
   */
  async playByUrl(deviceId: string, url: string, hardware = '', disabledModels?: string[], keepLight = false, customAudioId?: string, lyricsMode?: { enabled: boolean; songName?: string; metadata?: PlayMetadata }): Promise<boolean> {
    const useMusicAPI = hardware ? needUsePlayMusicAPI(hardware, disabledModels) : false;
    if (isDebugLog()) {
      const disabled = Array.isArray(disabledModels) ? disabledModels.join(',') : '';
      songloft.log.info(`[MinaClient] playByUrl device=${deviceId} hardware=${hardware} useMusicAPI=${useMusicAPI} keepLight=${keepLight} lyricsMode=${!!lyricsMode?.enabled} disabledModels=[${disabled}] url=${this.redactAccessToken(url).slice(0, 160)}`);
    }
    if (useMusicAPI) {
      const fallbackAudioId = customAudioId || DEFAULT_MUSIC_AUDIO_ID;
      if (lyricsMode?.enabled) {
        const audioId = await this.searchAudioId(lyricsMode.metadata || lyricsMode.songName || '', fallbackAudioId);
        const displayName = this.formatPlayMetadataForLog(lyricsMode.metadata || lyricsMode.songName || '');
        songloft.log.info(`[MinaClient] touchscreen lyrics selected audioID=${audioId} fallbackAudioID=${fallbackAudioId} song=${displayName}`);
        // xiaomusic 的 continue_play 通过 _type=1 设置 audio_type=MUSIC；这是触屏歌词/封面的前提。
        const ok = await this.playByMusicURL(deviceId, url, true, audioId, 'play-music:lyrics');
        if (ok) {
          return true;
        }

        if (audioId !== fallbackAudioId) {
          songloft.log.warn(`[MinaClient] searched audioID failed, retrying default audioID=${fallbackAudioId} in touchscreen lyrics mode`);
          const defaultLyricsOK = await this.playByMusicURL(deviceId, url, true, fallbackAudioId, 'play-music:lyrics-default');
          if (defaultLyricsOK) {
            return true;
          }
        }

        songloft.log.warn('[MinaClient] playByMusicURL failed in touchscreen lyrics mode, retrying normal Music API playback');
        const normalMusicOK = await this.playByMusicURL(deviceId, url, keepLight, fallbackAudioId, 'play-music:fallback');
        if (normalMusicOK) {
          return true;
        }

        songloft.log.warn('[MinaClient] normal Music API fallback failed, trying player_play_url');
        return this.playURL(deviceId, url, keepLight);
      }

      return this.playByMusicURL(deviceId, url, keepLight, fallbackAudioId, 'play-music');
    }
    return this.playURL(deviceId, url, keepLight);
  }

  /**
   * 搜索云端曲库匹配歌曲，返回真实 audioID（供触屏音箱拉取歌词/封面）
   * 参照 xiaomusic _get_audio_id：按「歌名完全相等 + 歌手包含匹配」精确命中
   * @param target - 歌曲信息；字符串参数兼容旧的「歌名-歌手」格式
   * @param fallbackAudioId - 默认封面/歌词 ID；无结果或失败时返回
   * @returns 匹配到的 audioID；无结果或失败返回 fallbackAudioId
   */
  async searchAudioId(target: string | PlayMetadata, fallbackAudioId = DEFAULT_MUSIC_AUDIO_ID): Promise<string> {
    let audioId = fallbackAudioId || DEFAULT_MUSIC_AUDIO_ID;
    const parsed = this.normalizePlayMetadata(target);
    const query = parsed.artist ? `${parsed.title}-${parsed.artist}` : parsed.title;
    if (!query) {
      songloft.log.info('[MinaClient] searchAudioId empty name, using default audioID');
      return audioId;
    }

    const params: Record<string, string> = {
      query,
      queryType: '1',
      offset: '0',
      count: '6',
      timestamp: String(Math.floor(Date.now() * 1000)),
      requestId: this.generateRequestId(),
    };
    const body = Object.entries(params)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');

    const result = await this.doPostRequest<MusicSearchResponse>(
      `${MINA_API_BASE_URL}/music/search`,
      body,
      '',
      this.preserveMusicSearchIDStrings,
    );
    const songList = result?.data?.songList;
    if (!songList || songList.length === 0) {
      songloft.log.info(`[MinaClient] searchAudioId no match for: ${query}, using default audioID=${audioId}`);
      return audioId;
    }

    const selectedReason = 'first-result';

    const candidates = songList.slice(0, 6).map((song, index) => ({
      index,
      audioID: song.audioID || '',
      songID: song.songID || '',
      name: song.name || '',
      artist: song.artist?.name || '',
    }));
    songloft.log.info(`[MinaClient] searchAudioId candidates query=${query} fallbackAudioID=${fallbackAudioId} candidates=${this.summarizeForLog(candidates, 1200)}`);
    songloft.log.info(`[MinaClient] searchAudioId rawSongs query=${query} resultCode=${result?.code ?? 'unknown'} rawSongs=${this.summarizeForLog(songList.slice(0, 6), 4000)}`);

    audioId = songList[0].audioID || audioId;

    const targetSong = parsed.title;
    let firstArtist = parsed.artist;
    if (firstArtist) {
      for (const sep of [';', '；', ',', '，', '&', '、', '/']) {
        firstArtist = firstArtist.split(sep).join('|');
      }
      firstArtist = firstArtist.split('|')[0].trim();
    }

    for (const song of songList) {
      const sName = song.name || '';
      const sArtist = song.artist?.name || '';
      if (targetSong.toLowerCase() === sName.toLowerCase()) {
        if (!firstArtist || sArtist.toLowerCase().includes(firstArtist.toLowerCase())) {
          audioId = song.audioID || audioId;
          break;
        }
      }
    }

    songloft.log.info(`[MinaClient] searchAudioId selected query=${query} audioID=${audioId} reason=${selectedReason} targetSong=${targetSong} targetArtist=${firstArtist || ''}`);
    return audioId;
  }

  private normalizePlayMetadata(target: string | PlayMetadata): PlayMetadata {
    if (typeof target !== 'string') {
      return {
        title: (target.title || '').trim(),
        artist: (target.artist || '').trim(),
      };
    }

    const query = (target || '').trim();
    const dashIdx = query.lastIndexOf('-');
    if (dashIdx < 0) {
      return { title: query, artist: '' };
    }
    return {
      title: query.slice(0, dashIdx).trim(),
      artist: query.slice(dashIdx + 1).trim(),
    };
  }

  private formatPlayMetadataForLog(target: string | PlayMetadata): string {
    const metadata = this.normalizePlayMetadata(target);
    return metadata.artist ? `${metadata.title}-${metadata.artist}` : metadata.title;
  }

  /**
   * 使用 player_play_url 播放 URL
   */
  async playURL(deviceId: string, url: string, keepLight = false): Promise<boolean> {
    if (isDebugLog()) {
      songloft.log.info(`[MinaClient] play-url stream device=${deviceId} keepLight=${keepLight} url=${this.redactAccessToken(url).slice(0, 160)}`);
    }
    const message = { url, type: keepLight ? 1 : 2, media: 'app_ios' };
    const result = await this.ubusRequest(deviceId, 'player_play_url', 'mediaplayer', message, 'play-url');
    return this.isDeviceResultOK(result, 'player_play_url');
  }

  /**
   * 使用 player_play_music 播放 URL（用于部分设备型号）
   */
  async playByMusicURL(deviceId: string, audioUrl: string, keepLight = false, customAudioId?: string, logLabel = 'play-music'): Promise<boolean> {
    // 默认封面
    const audioId = customAudioId || DEFAULT_MUSIC_AUDIO_ID;
    if (isDebugLog()) {
      songloft.log.info(`[MinaClient] ${logLabel} stream device=${deviceId} keepLight=${keepLight} audioId=${audioId} url=${this.redactAccessToken(audioUrl).slice(0, 160)}`);
    }

    const music = {
      payload: {
        audio_type: keepLight ? 'MUSIC' : '',
        audio_items: [{
          item_id: {
            audio_id: audioId,
            cp: {
              album_id: '-1',
              episode_index: 0,
              id: MUSIC_CP_ID,
              name: 'xiaowei',
            },
          },
          stream: { url: audioUrl },
        }],
        list_params: {
          listId: '-1',
          loadmore_offset: 0,
          origin: 'xiaowei',
          type: 'MUSIC',
        },
      },
      play_behavior: 'REPLACE_ALL',
    };

    const message = {
      startaudioid: audioId,
      music: JSON.stringify(music),
    };

    const result = await this.ubusRequest(deviceId, 'player_play_music', 'mediaplayer', message, logLabel);
    const ok = this.isDeviceResultOK(result, 'player_play_music');
    // 诊断 songloft-org/songloft#453：ubus 云端汇报 success，但音箱仍无声。
    // 推送 2s 后异步回读一次真实播放状态，暴露「云端受理但设备未拉流」的静默失败。
    // fire-and-forget：不阻塞返回、异常吞掉，仅打日志。
    if (ok && isDebugLog()) {
      setTimeout(() => {
        this.getPlayerStatus(deviceId).then(status => {
          const data = (status?.data ?? {}) as Record<string, unknown>;
          const info = typeof data.info === 'string' ? data.info : '';
          songloft.log.info(`[MinaClient] ${logLabel} readback+2s device=${deviceId} code=${status?.code ?? 'null'} info=${info.substring(0, 200)}`);
        }).catch(e => {
          songloft.log.warn(`[MinaClient] ${logLabel} readback+2s failed device=${deviceId}: ${String(e)}`);
        });
      }, 2000);
    }
    return ok;
  }

  /**
   * 日志脱敏：把 URL 里的 access_token 值遮成 <redacted>。
   * 播放路径日志会打完整 URL 便于排障，但不能把 token 泄漏到日志文件。
   */
  private redactAccessToken(url: string): string {
    if (!url) return url;
    return url.replace(/([?&]access_token=)[^&\s]+/g, '$1<redacted>');
  }

  /**
   * 播放控制原语（play / pause / stop）
   * 统一带日志标签，并按设备级返回码判定成功：只看 ubus 外层 code 会把
   * 「云端受理了但音箱拒绝执行」也当成功，导致暂停等操作静默失效。
   */
  private async playerOperation(deviceId: string, action: 'play' | 'pause' | 'stop'): Promise<boolean> {
    const message = { action, media: 'app_ios' };
    const result = await this.ubusRequest(deviceId, 'player_play_operation', 'mediaplayer', message, 'play-op:' + action);
    return this.isDeviceResultOK(result, 'player_play_operation:' + action);
  }

  /**
   * 播放操作（play）
   */
  async playerPlay(deviceId: string): Promise<boolean> {
    return this.playerOperation(deviceId, 'play');
  }

  /**
   * 暂停播放
   */
  async playerPause(deviceId: string): Promise<boolean> {
    return this.playerOperation(deviceId, 'pause');
  }

  /**
   * 暂停播放并回读设备状态核验是否真的停下来了。
   *
   * 部分小爱型号在推流播放（player_play_url / player_play_music）下会「受理」pause 但音频继续，
   * 表现为网页端暂停按钮无效（songloft-org/songloft-plugin-miot#59）。此时升级为 stop 真正静音，
   * 与 xiaomusic 的 force_stop_xiaoai（pause → 查状态 → 仍在播则 stop）同策略。
   *
   * @returns 'paused' 暂停已生效 | 'stopped' 已升级为停止（设备端媒体上下文丢失，无法原位续播）
   *          | 'failed' pause 与 stop 均下发失败
   */
  async playerPauseVerified(deviceId: string): Promise<'paused' | 'stopped' | 'failed'> {
    const pauseOK = await this.playerPause(deviceId);

    // 设备状态上报有延迟：连续两次回读都仍是 playing 才判定 pause 未生效，
    // 避免误伤 pause 正常、只是状态上报慢的型号（升级 stop 会丢失续播位置）。
    for (let i = 0; i < PAUSE_VERIFY_ATTEMPTS; i++) {
      await new Promise(r => setTimeout(r, PAUSE_VERIFY_DELAY_MS));
      const status = await this.readPlayStatus(deviceId);
      if (status !== PLAY_STATUS_PLAYING) {
        return 'paused';
      }
    }

    songloft.log.warn(`[MinaClient] pause ignored by device=${deviceId} (still playing), escalating to stop`);
    if (await this.playerOperation(deviceId, 'stop')) {
      return 'stopped';
    }
    return pauseOK ? 'paused' : 'failed';
  }

  /**
   * 恢复播放
   */
  async playerResume(deviceId: string): Promise<boolean> {
    return this.playerPlay(deviceId);
  }

  /**
   * 停止播放
   */
  async playerStop(deviceId: string): Promise<boolean> {
    // 部分小爱音箱型号单独调用 stop 不会真正停止播放，先暂停再停止
    await this.playerPause(deviceId);
    return this.playerOperation(deviceId, 'stop');
  }

  /**
   * 回读设备播放状态码
   * @returns 1=playing 2=paused 0=stopped，-1 表示未知（请求失败或响应无法解析）
   */
  async readPlayStatus(deviceId: string): Promise<number> {
    const raw = await this.getPlayerStatus(deviceId, { verify: true });
    const info = (raw?.data as any)?.info;
    if (typeof info !== 'string') return -1;
    try {
      const parsed = JSON.parse(info);
      return typeof parsed.status === 'number' ? parsed.status : -1;
    } catch {
      return -1;
    }
  }

  // ===== 音量 =====

  /**
   * 设置音量 (0-100)
   */
  async setVolume(deviceId: string, volume: number): Promise<boolean> {
    const v = Math.max(0, Math.min(100, Math.floor(volume)));
    const message = { volume: v };
    return (await this.ubusRequest(deviceId, 'player_set_volume', 'mediaplayer', message)) !== null;
  }

  /**
   * 获取音量
   */
  async getVolume(deviceId: string): Promise<number> {
    const result = await this.getPlayerStatus(deviceId, { verify: true });
    if (result && typeof result.data === 'object' && result.data !== null) {
      const data = result.data as Record<string, unknown>;
      const info = data['info'];
      if (typeof info === 'string') {
        try {
          const parsed = JSON.parse(info);
          if (typeof parsed.volume === 'number') {
            return parsed.volume;
          }
        } catch {}
      }
    }
    return -1;
  }

  // ===== TTS =====

  /**
   * 文字转语音
   *
   * 优先走 mibrain/text_to_speech（多数固件真正的语音播报入口），
   * 失败再回退到旧的 mediaplayer/player_play_tts（部分老设备）。
   */
  async textToSpeech(deviceId: string, text: string, options?: { hardware?: string; miotDID?: string }): Promise<boolean> {
    const textLength = text.length;
    const hardware = options?.hardware || '';
    const miotDID = options?.miotDID || '';
    const ttsCommand = getTTSCommand(hardware);

    if (ttsCommand) {
      if (miotDID && this.hasXiaomiIOToken()) {
        try {
          songloft.log.info(`[MinaClient] textToSpeech using MiIO TTS command hardware=${hardware} did=${miotDID} command=${ttsCommand} text_length=${textLength}`);
          const ok = await new MiIOClient(this.tokenInfo).textToSpeechByCommand(miotDID, ttsCommand, text);
          if (ok) {
            return true;
          }
          songloft.log.warn(`[MinaClient] MiIO TTS command failed, falling back to Mina UBus hardware=${hardware} device=${deviceId}`);
        } catch (e) {
          songloft.log.warn(`[MinaClient] MiIO TTS command error, falling back to Mina UBus hardware=${hardware} device=${deviceId}: ${String(e)}`);
        }
      } else {
        songloft.log.warn(`[MinaClient] MiIO TTS command unavailable hardware=${hardware} did=${miotDID || ''} has_xiaomiio=${this.hasXiaomiIOToken()}`);
      }
    }

    const message = { text };
    songloft.log.info(`[MinaClient] textToSpeech start device=${deviceId} hardware=${hardware} text_length=${textLength}`);

    const mibrainResult = await this.ubusRequest(deviceId, 'text_to_speech', 'mibrain', message, 'tts:mibrain');
    if (mibrainResult !== null) {
      songloft.log.info(`[MinaClient] textToSpeech success endpoint=mibrain/text_to_speech device=${deviceId} code=${mibrainResult.code}`);
      return true;
    }
    songloft.log.warn(`[MinaClient] text_to_speech/mibrain failed, falling back to player_play_tts/mediaplayer device=${deviceId}`);

    const fallbackResult = await this.ubusRequest(deviceId, 'player_play_tts', 'mediaplayer', message, 'tts:mediaplayer');
    if (fallbackResult !== null) {
      songloft.log.info(`[MinaClient] textToSpeech success endpoint=mediaplayer/player_play_tts device=${deviceId} code=${fallbackResult.code}`);
      return true;
    }

    songloft.log.warn(`[MinaClient] textToSpeech failed on all endpoints device=${deviceId} text_length=${textLength}`);
    return false;
  }

  private hasXiaomiIOToken(): boolean {
    const service = this.tokenInfo.services[XIAOMI_IO_SID];
    return !!(service && service.service_token && service.ssecurity && (!service.expires_at || service.expires_at > Date.now()));
  }

  // ===== 对话记录 =====

  /**
   * 获取最新对话记录（自动选择获取方式）
   *
   * 返回值区分两种「空」，调用方**不能**混为一谈：
   * - `null`  → 取记录失败（token 失效 / 网络错误 / 非 200 / 解析失败 / 重试用尽）
   * - `[]`    → 取记录成功，但该设备确实没有对话记录
   *
   * ConversationMonitor 的首轮基线建立依赖这个区分：把失败当成「没有记录」会让基线
   * 停在 0，等取记录恢复后整批历史记录会被当作新消息重放（旧语音指令凭空执行）。
   *
   * @param deviceId - 设备 ID
   * @param hardware - 设备硬件型号
   * @param limit - 记录数量限制（默认2）
   */
  async getLatestAskFromXiaoai(deviceId: string, hardware: string, limit = 2): Promise<AskMessage[] | null> {
    if (isDebugLog()) songloft.log.info(`[ConversationMonitor] getLatestAskFromXiaoai deviceId=${deviceId} hardware=${hardware} limit=${limit} useMinaForAsk=${shouldUseMinaForAsk(hardware)}`);
    // 部分设备需要通过 ubus 方式获取
    if (shouldUseMinaForAsk(hardware)) {
      const ubusResult = await this.getLatestAskByUbus(deviceId);
      if (isDebugLog()) songloft.log.info(`[ConversationMonitor] getLatestAskByUbus result: ${ubusResult ? ubusResult.length : 0} messages`);
      return ubusResult;
    }

    // 与 Go 版一致：在循环外部生成时间戳，重试时复用相同 URL
    const timestamp = Date.now();
    const apiUrl = formatLatestAskUrl(hardware, timestamp, limit);
    if (isDebugLog()) songloft.log.info(`[ConversationMonitor] getLatestAskFromXiaoai apiUrl=${apiUrl}`);

    // 大多数设备通过 xiaoai API 获取，带3次重试
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const messages = await this.doGetLatestAskFromXiaoai(deviceId, apiUrl);
      if (messages !== null) {
        if (isDebugLog()) songloft.log.info(`[ConversationMonitor] getLatestAskFromXiaoai attempt=${attempt} success, ${messages.length} messages`);
        return messages;
      }
      if (isDebugLog()) songloft.log.info(`[ConversationMonitor] getLatestAskFromXiaoai attempt=${attempt} returned null, retrying...`);
    }
    songloft.log.info(`[ConversationMonitor] getLatestAskFromXiaoai all ${MAX_RETRIES} attempts failed`);
    // 返回 null 而非 []：让调用方知道这是「取不到」，不是「没有记录」
    return null;
  }

  // ===== 播放状态 =====

  /**
   * 获取播放器状态
   */
  async getPlayerStatus(deviceId: string, options: StatusQueryOptions = {}): Promise<UbusResponse | null> {
    const query = this.getStatusQuery(deviceId);
    if (query.inflight?.revision === query.revision) return query.inflight.promise;
    if (!options.verify && Date.now() < query.nextAt) {
      return query.sample?.revision === query.revision && Date.now() - query.sample.at < STATUS_INTERVAL_MS
        ? query.sample.result : null;
    }

    const revision = query.revision;
    const promise = this.enqueueUbus(deviceId, true, async () => {
      // 控制指令优先执行。旧的后台查询在出队时作废，不再给云端补发历史请求。
      if (revision !== query.revision || (!options.verify && Date.now() < query.nextAt)) return null;
      let result: UbusResponse | null = null;
      try {
        result = await this.doUbusRequest(deviceId, 'player_get_play_status', 'mediaplayer', {}, isDebugLog() ? 'status' : '');
        const data = result?.data as { info?: string } | undefined;
        const info = JSON.parse(data?.info || '{}');
        if (typeof info.status !== 'number' || !Number.isFinite(info.status) || info.status < 0) result = null;
      } catch {
        result = null;
      }
      // 在途查询期间用户操作过设备：结果属于旧媒体上下文，不能参与任何校准。
      if (revision !== query.revision) return null;
      if (result) {
        result = { ...result, sampledAt: Date.now() };
        query.sample = { revision, result, at: Date.now() };
      } else {
        query.sample = undefined;
      }
      query.failures = result ? 0 : query.failures + 1;
      const delay = result ? STATUS_INTERVAL_MS
        : STATUS_FAILURE_DELAYS_MS[Math.min(query.failures - 1, STATUS_FAILURE_DELAYS_MS.length - 1)];
      query.nextAt = Date.now() + delay;
      if (!result) songloft.log.warn(`[MinaClient] status unavailable device=${deviceId} failures=${query.failures} retryInMs=${delay}`);
      return result;
    }).finally(() => {
      if (query.inflight?.promise === promise) query.inflight = undefined;
    });
    query.inflight = { revision, promise };
    return promise;
  }

  private getStatusQuery(deviceId: string): StatusQuery {
    let query = this.statusQueries.get(deviceId);
    if (!query) {
      query = { revision: 0, failures: 0, nextAt: 0 };
      this.statusQueries.set(deviceId, query);
    }
    return query;
  }

  /**
   * 验证 Token 有效性（通过调用 API）
   *
   * 直接判定底层响应：token 有效时 device_list 返回 code=0（即使账号名下没有
   * 任何设备也是 code=0，返回 true）；token 失效时 doGetRequest 遇 401 返回 null，
   * 返回 false。
   *
   * 不能复用 getDeviceList()：它把 401/网络失败兜底成空数组 []，而 `[] !== null`
   * 恒为 true，会让失效 token 被误判为有效——正是 token 过期后刷新链条持续「假成功」、
   * 既不提示重登又持续 401 的根因（issue #57）。
   */
  async validateToken(): Promise<boolean> {
    try {
      const apiUrl = `${MINA_API_BASE_URL}/admin/v2/device_list?master=1`;
      const result = await this.doGetRequest<DeviceListResponse>(apiUrl);
      return result !== null && result.code === 0;
    } catch {
      return false;
    }
  }

  // ===== 内部方法 =====

  /**
   * 构建 API 请求的 Cookie 字符串
   */
  private buildApiCookies(): string {
    const svc = this.tokenInfo.services[MINA_SID];
    if (!svc) return '';

    return [
      `userId=${this.tokenInfo.user_id}`,
      `serviceToken=${svc.service_token}`,
      `channel=MI_APP_STORE`,
    ].join('; ');
  }

  /**
   * 生成请求 ID
   */
  private generateRequestId(): string {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let result = 'app_ios_';
    for (let i = 0; i < 30; i++) {
      result += chars[Math.floor(Math.random() * chars.length)];
    }
    return result;
  }

  /**
   * 执行 UBus 请求
   */
  async ubusRequest(deviceId: string, method: string, path: string, message: Record<string, unknown>, logLabel = ''): Promise<UbusResponse | null> {
    if (method === 'player_get_play_status') return this.getPlayerStatus(deviceId);
    this.getStatusQuery(deviceId).revision++;
    return this.enqueueUbus(deviceId, false, () => this.doUbusRequest(deviceId, method, path, message, logLabel));
  }

  private enqueueUbus(deviceId: string, status: boolean, run: UbusTask['run']): Promise<UbusResponse | null> {
    let queue = this.ubusQueues.get(deviceId);
    if (!queue) {
      queue = { running: false, tasks: [] };
      this.ubusQueues.set(deviceId, queue);
    }
    const pending = new Promise<UbusResponse | null>((resolve, reject) => {
      queue.tasks.push({ status, run, resolve, reject });
    });
    void this.drainUbus(deviceId, queue);
    return pending;
  }

  private async drainUbus(deviceId: string, queue: UbusQueue): Promise<void> {
    if (queue.running) return;
    queue.running = true;
    try {
      while (queue.tasks.length) {
        const controlIndex = queue.tasks.findIndex(task => !task.status);
        const [task] = queue.tasks.splice(controlIndex < 0 ? 0 : controlIndex, 1);
        try {
          task.resolve(await task.run());
        } catch (error) {
          task.reject(error);
        }
      }
    } finally {
      queue.running = false;
      if (this.ubusQueues.get(deviceId) === queue) this.ubusQueues.delete(deviceId);
    }
  }

  private async doUbusRequest(deviceId: string, method: string, path: string, message: Record<string, unknown>, logLabel = ''): Promise<UbusResponse | null> {
    const apiUrl = `${MINA_API_BASE_URL}/remote/ubus`;
    const requestId = this.generateRequestId();

    const formParams: Record<string, string> = {
      deviceId,
      method,
      path,
      message: JSON.stringify(message),
      requestId,
    };

    const body = Object.entries(formParams)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');

    if (logLabel) {
      songloft.log.info(`[MinaClient] ${logLabel} ubus request device=${deviceId} path=${path} method=${method} request_id=${requestId} message=${this.summarizeUbusMessageForLog(message)}`);
    }

    const result = await this.doPostRequest<UbusResponse>(apiUrl, body, logLabel, undefined, UBUS_TIMEOUT_MS);

    // 如果401并且有回调，尝试刷新
    if (result === null) {
      if (logLabel) {
        songloft.log.warn(`[MinaClient] ${logLabel} ubus request returned null device=${deviceId} path=${path} method=${method}`);
      }
      return null;
    }

    // 检查响应码
    if (result.code !== 0) {
      if (logLabel) {
        songloft.log.warn(`[MinaClient] ${logLabel} ubus non-zero code=${result.code} message=${result.message || ''} data=${this.summarizeForLog(result.data)}`);
      }
      return null;
    }

    if (logLabel) {
      songloft.log.info(`[MinaClient] ${logLabel} ubus success code=${result.code} message=${result.message || ''} data=${this.summarizeForLog(result.data)}`);
    }
    return result;
  }

  private isDeviceResultOK(result: UbusResponse | null, action: string): boolean {
    if (result === null) {
      songloft.log.warn(`[MinaClient] ${action} returned null`);
      return false;
    }

    const data = result.data;
    if (data && typeof data === 'object' && 'code' in data) {
      const code = Number((data as Record<string, unknown>).code);
      if (!Number.isNaN(code) && code !== 0) {
        songloft.log.warn(`[MinaClient] ${action} device returned code=${code} data=${this.summarizeForLog(data)}`);
        return false;
      }
    }

    return true;
  }

  private summarizeForLog(value: unknown, maxLength = 600): string {
    if (value === undefined) return 'undefined';
    if (value === null) return 'null';
    try {
      const text = typeof value === 'string' ? value : JSON.stringify(value);
      return text.length > maxLength ? text.slice(0, maxLength) + '...(truncated)' : text;
    } catch {
      return String(value);
    }
  }

  private summarizeUbusMessageForLog(message: Record<string, unknown>): string {
    const summary: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(message)) {
      if (key === 'text' && typeof value === 'string') {
        summary.text_length = value.length;
      } else if (key === 'url' && typeof value === 'string') {
        summary.url_length = value.length;
      } else if (key === 'music' && typeof value === 'string') {
        summary.music_length = value.length;
      } else {
        summary[key] = value;
      }
    }
    return this.summarizeForLog(summary);
  }

  /**
   * 执行 GET 请求（带401重试）
   */
  private async doGetRequest<T>(url: string): Promise<T | null> {
    const headers: Record<string, string> = {
      'User-Agent': this.userAgent,
      'Cookie': this.buildApiCookies(),
    };

    let response: any;
    try {
      const fetchResult = await fetchWithRedirects(url, { method: 'GET', headers }, new CookieJar(), 0);
      response = fetchResult.response;
    } catch {
      return null;
    }

    // 401 处理
    if (response.status === 401) {
      if (this.onTokenExpired) {
        const refreshed = await this.onTokenExpired();
        if (refreshed) {
          // 重试
          headers['Cookie'] = this.buildApiCookies();
          try {
            const retryResult = await fetchWithRedirects(url, { method: 'GET', headers }, new CookieJar(), 0);
            response = retryResult.response;
          } catch {
            return null;
          }
          if (response.status === 401) return null;
        } else {
          return null;
        }
      } else {
        return null;
      }
    }

    try {
      const text = response.text() as string;
      return JSON.parse(text) as T;
    } catch {
      return null;
    }
  }

  /**
   * 执行 POST 请求（带401重试）
   */
  private async doPostRequest<T>(url: string, body: string, logLabel = '', transformResponseText?: (text: string) => string, timeoutMs?: number): Promise<T | null> {
    const headers: Record<string, string> = {
      'User-Agent': this.userAgent,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': this.buildApiCookies(),
    };
    if (timeoutMs !== undefined) headers['X-Fetch-Timeout-Ms'] = String(timeoutMs);

    let response: any;
    try {
      const fetchResult = await fetchWithRedirects(url, { method: 'POST', headers, body }, new CookieJar(), 0);
      response = fetchResult.response;
      if (logLabel) {
        songloft.log.info(`[MinaClient] ${logLabel} HTTP POST status=${response.status}`);
      }
    } catch (e) {
      if (logLabel) {
        songloft.log.warn(`[MinaClient] ${logLabel} HTTP POST fetch failed: ${String(e)}`);
      }
      return null;
    }

    // 401 处理
    if (response.status === 401) {
      if (logLabel) {
        songloft.log.warn(`[MinaClient] ${logLabel} HTTP POST got 401, refreshing token`);
      }
      if (this.onTokenExpired) {
        const refreshed = await this.onTokenExpired();
        if (refreshed) {
          // 重试
          headers['Cookie'] = this.buildApiCookies();
          try {
            const retryResult = await fetchWithRedirects(url, { method: 'POST', headers, body }, new CookieJar(), 0);
            response = retryResult.response;
            if (logLabel) {
              songloft.log.info(`[MinaClient] ${logLabel} HTTP POST retry status=${response.status}`);
            }
          } catch (e) {
            if (logLabel) {
              songloft.log.warn(`[MinaClient] ${logLabel} HTTP POST retry failed: ${String(e)}`);
            }
            return null;
          }
          if (response.status === 401) {
            if (logLabel) {
              songloft.log.warn(`[MinaClient] ${logLabel} HTTP POST still 401 after token refresh`);
            }
            return null;
          }
        } else {
          if (logLabel) {
            songloft.log.warn(`[MinaClient] ${logLabel} token refresh failed`);
          }
          return null;
        }
      } else {
        if (logLabel) {
          songloft.log.warn(`[MinaClient] ${logLabel} no token refresh callback`);
        }
        return null;
      }
    }

    if (response.status < 200 || response.status >= 300) return null;

    try {
      const text = response.text() as string;
      if (logLabel) {
        songloft.log.info(`[MinaClient] ${logLabel} HTTP POST response=${this.summarizeForLog(text)}`);
      }
      return JSON.parse(transformResponseText ? transformResponseText(text) : text) as T;
    } catch (e) {
      if (logLabel) {
        songloft.log.warn(`[MinaClient] ${logLabel} HTTP POST parse failed: ${String(e)}`);
      }
      return null;
    }
  }

  private preserveMusicSearchIDStrings(text: string): string {
    return text.replace(/"(audioID|songID)"\s*:\s*(-?\d+)/g, '"$1":"$2"');
  }

  /**
   * 通过 xiaoai API 获取对话记录
   */
  private async doGetLatestAskFromXiaoai(deviceId: string, apiUrl: string): Promise<AskMessage[] | null> {

    const headers: Record<string, string> = {
      'User-Agent': this.userAgent,
      'Cookie': this.buildApiCookies() + `; deviceId=${deviceId}`,
    };

    let response: any;
    try {
      const fetchResult = await fetchWithRedirects(apiUrl, { method: 'GET', headers }, new CookieJar(), 0);
      response = fetchResult.response;
    } catch (e) {
      songloft.log.warn(`[ConversationMonitor] doGetLatestAskFromXiaoai fetch error: ${String(e)}`);
      return null;
    }

    if (isDebugLog()) songloft.log.info(`[ConversationMonitor] doGetLatestAskFromXiaoai status=${response.status}`);

    if (response.status === 401) {
      if (isDebugLog()) songloft.log.info(`[ConversationMonitor] doGetLatestAskFromXiaoai 401 token expired`);
      if (this.onTokenExpired) {
        await this.onTokenExpired();
      }
      return null;
    }

    if (response.status !== 200) {
      songloft.log.warn(`[ConversationMonitor] doGetLatestAskFromXiaoai unexpected status=${response.status}`);
      return null;
    }

    try {
      const text = response.text() as string;
      // 打印原始响应体（最多 1000 字符）
      if (isDebugLog()) songloft.log.info(`[ConversationMonitor] doGetLatestAskFromXiaoai raw response (${text.length} chars): ${text.substring(0, 1000)}`);

      const result = JSON.parse(text) as Record<string, unknown>;

      // data 字段是一个 JSON 字符串
      const dataStr = result['data'] as string;
      if (!dataStr) {
        if (isDebugLog()) songloft.log.info(`[ConversationMonitor] doGetLatestAskFromXiaoai data field is empty/null`);
        return [];
      }

      const dataObj = JSON.parse(dataStr) as ConversationData;
      if (!dataObj.records || dataObj.records.length === 0) {
        if (isDebugLog()) songloft.log.info(`[ConversationMonitor] doGetLatestAskFromXiaoai records empty or missing`);
        return [];
      }

      // 转换为 AskMessage 格式（与 WASM 版一致）
      const messages = dataObj.records.map(record => {
        // 从 answers 中找到 TTS 类型的回答，安全访问 tts.text
        const ttsAnswer = (record.answers || []).find(a => a.type === 'TTS');
        const answerText = ttsAnswer?.tts?.text || '';
        return {
          timestamp_ms: record.time,
          response: {
            answer: [{
              question: record.query,
              content: answerText,
            }],
          },
        };
      });
      if (isDebugLog()) songloft.log.info(`[ConversationMonitor] doGetLatestAskFromXiaoai parsed ${messages.length} messages`);
      return messages;
    } catch (e) {
      songloft.log.warn(`[ConversationMonitor] doGetLatestAskFromXiaoai parse error: ${String(e)}`);
      return null;
    }
  }

  /**
   * 通过 UBus nlp_result_get 获取对话记录
   * 用于不支持 xiaoai API 的设备（如 M01）
   *
   * 返回值语义同 getLatestAskFromXiaoai：`null` = 取记录失败，`[]` = 确实没有记录
   */
  private async getLatestAskByUbus(deviceId: string): Promise<AskMessage[] | null> {
    const result = await this.ubusRequest(deviceId, 'nlp_result_get', 'mibrain', {});
    if (!result || !result.data) return null;

    try {
      const data = result.data as NlpResultData;
      // code != 0 是设备侧报错（取不到），不是「没有对话」
      if (data.code !== 0) return null;
      if (!data.info) return [];

      const infoData = JSON.parse(data.info) as NlpInfoData;
      if (!infoData.result) return [];

      const messages: AskMessage[] = [];

      for (const item of infoData.result) {
        if (!item.nlp) continue;

        try {
          const nlp = JSON.parse(item.nlp) as NlpDetail;
          // 时间戳解析失败时**必须跳过**，不能兜底成 0：0 永远小于去重基线，
          // 该条会被静默吞掉且无任何日志（原实现 `|| 0` 的后果）
          const timestamp = parseInt(nlp.meta?.timestamp ?? '', 10);
          if (!Number.isFinite(timestamp) || timestamp <= 0) {
            songloft.log.warn(`[ConversationMonitor] getLatestAskByUbus skip record with invalid timestamp device=${deviceId} raw=${String(nlp.meta?.timestamp)}`);
            continue;
          }

          // 转换为 AskMessage 格式（与 WASM 版一致）
          messages.push({
            request_id: nlp.meta.request_id,
            timestamp_ms: timestamp,
            response: {
              answer: nlp.response.answer.map(ans => ({
                domain: ans.domain,
                action: ans.action,
                content: ans.content.to_speak,
                question: ans.intention.query,
              })),
            },
          });
        } catch {
          continue;
        }
      }

      return messages;
    } catch {
      // 解析失败属于「取不到」，返回 null 而非 []
      return null;
    }
  }
}
