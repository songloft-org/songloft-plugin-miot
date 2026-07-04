// MIoT 智能音箱插件 - Mina HTTP 客户端
// 翻译自 Go 源码: plugins/songloft-plugin-xiaomi/pkg/mina/mina_client.go
// 设备控制 API 客户端：设备列表、播放控制、音量、TTS、对话记录

import { CookieJar } from '../utils/cookie';
import { fetchWithRedirects } from '../utils/http';
import { generateDeviceId } from '../utils/crypto';
import { isPollDebug } from '../utils/debug';
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


/**
 * MinaHTTPClient - 小爱音箱 API 客户端
 * 提供设备控制、播放管理、对话记录获取等功能
 */
export class MinaHTTPClient {
  private tokenInfo: XiaomiTokenInfo;
  private userAgent: string;
  private onTokenExpired?: () => Promise<boolean>;

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
   * @param extraModels - 用户自定义的额外 Music API 型号列表
   * @param lyricsMode - 触屏歌词模式：开启后强制走 player_play_music 音乐模式，
   *   并逐首搜小米曲库匹配真实 audioID（搜不到回退 customAudioId），使触屏音箱显示歌词
   */
  async playByUrl(deviceId: string, url: string, hardware = '', extraModels?: string[], keepLight = false, customAudioId?: string, lyricsMode?: { enabled: boolean; songName: string }): Promise<boolean> {
    if (lyricsMode?.enabled) {
      let audioId = customAudioId || '';
      const searched = await this.searchAudioId(lyricsMode.songName);
      if (searched) {
        audioId = searched;
      }
      // 歌词模式强制音乐模式（audio_type=MUSIC），这是触屏音乐 UI/歌词的前提
      return this.playByMusicURL(deviceId, url, true, audioId);
    }
    if (hardware && needUsePlayMusicAPI(hardware, extraModels)) {
      return this.playByMusicURL(deviceId, url, keepLight, customAudioId);
    }
    return this.playURL(deviceId, url, keepLight);
  }

  /**
   * 搜索小米官方曲库匹配歌曲，返回真实 audioID（供触屏音箱拉取歌词/封面）
   * 参照 xiaomusic _get_audio_id：按「歌名完全相等 + 歌手包含匹配」精确命中
   * @param name - 「歌名-歌手」格式；为空直接返回 ''（TTS/无名场景不请求，避免小米账号报错）
   * @returns 匹配到的 audioID；无结果或失败返回 ''
   */
  async searchAudioId(name: string): Promise<string> {
    const query = (name || '').trim();
    if (!query) {
      return '';
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

    const result = await this.doPostRequest<MusicSearchResponse>(`${MINA_API_BASE_URL}/music/search`, body);
    const songList = result?.data?.songList;
    if (!songList || songList.length === 0) {
      songloft.log.info(`[MinaClient] searchAudioId no match for: ${query}`);
      return '';
    }

    // 兜底：先用第一首
    let audioId = songList[0].audioID || '';

    // 拆「歌名-歌手」，歌手多值时只取第一个
    let targetSong = query;
    let targetArtist = '';
    const dashIdx = query.indexOf('-');
    if (dashIdx >= 0) {
      targetSong = query.slice(0, dashIdx).trim();
      targetArtist = query.slice(dashIdx + 1).trim();
    }
    let firstArtist = targetArtist;
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

    songloft.log.info(`[MinaClient] searchAudioId name=${query} matched audioID=${audioId}`);
    return audioId;
  }

  /**
   * 使用 player_play_url 播放 URL
   */
  async playURL(deviceId: string, url: string, keepLight = false): Promise<boolean> {
    const message = { url, type: keepLight ? 1 : 2, media: 'app_ios' };
    return (await this.ubusRequest(deviceId, 'player_play_url', 'mediaplayer', message)) !== null;
  }

  /**
   * 使用 player_play_music 播放 URL（用于部分设备型号）
   */
  async playByMusicURL(deviceId: string, audioUrl: string, keepLight = false, customAudioId?: string): Promise<boolean> {
    // 默认封面
    const audioId = customAudioId || '1732418460076477549';
    const cpId = '355454500';

    const music = {
      payload: {
        audio_type: keepLight ? 'MUSIC' : '',
        audio_items: [{
          item_id: {
            audio_id: audioId,
            cp: {
              album_id: '-1',
              episode_index: 0,
              id: cpId,
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

    return (await this.ubusRequest(deviceId, 'player_play_music', 'mediaplayer', message)) !== null;
  }

  /**
   * 播放操作（play）
   */
  async playerPlay(deviceId: string): Promise<boolean> {
    const message = { action: 'play', media: 'app_ios' };
    return (await this.ubusRequest(deviceId, 'player_play_operation', 'mediaplayer', message)) !== null;
  }

  /**
   * 暂停播放
   */
  async playerPause(deviceId: string): Promise<boolean> {
    const message = { action: 'pause', media: 'app_ios' };
    return (await this.ubusRequest(deviceId, 'player_play_operation', 'mediaplayer', message)) !== null;
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
    const message = { action: 'stop', media: 'app_ios' };
    return (await this.ubusRequest(deviceId, 'player_play_operation', 'mediaplayer', message)) !== null;
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
    const result = await this.getPlayerStatus(deviceId);
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
   * @param deviceId - 设备 ID
   * @param hardware - 设备硬件型号
   * @param limit - 记录数量限制（默认2）
   */
  async getLatestAskFromXiaoai(deviceId: string, hardware: string, limit = 2): Promise<AskMessage[]> {
    if (isPollDebug()) songloft.log.info(`[ConversationMonitor] getLatestAskFromXiaoai deviceId=${deviceId} hardware=${hardware} limit=${limit} useMinaForAsk=${shouldUseMinaForAsk(hardware)}`);
    // 部分设备需要通过 ubus 方式获取
    if (shouldUseMinaForAsk(hardware)) {
      const ubusResult = await this.getLatestAskByUbus(deviceId);
      if (isPollDebug()) songloft.log.info(`[ConversationMonitor] getLatestAskByUbus result: ${ubusResult ? ubusResult.length : 0} messages`);
      return ubusResult;
    }

    // 与 Go 版一致：在循环外部生成时间戳，重试时复用相同 URL
    const timestamp = Date.now();
    const apiUrl = formatLatestAskUrl(hardware, timestamp, limit);
    if (isPollDebug()) songloft.log.info(`[ConversationMonitor] getLatestAskFromXiaoai apiUrl=${apiUrl}`);

    // 大多数设备通过 xiaoai API 获取，带3次重试
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const messages = await this.doGetLatestAskFromXiaoai(deviceId, apiUrl);
      if (messages !== null) {
        if (isPollDebug()) songloft.log.info(`[ConversationMonitor] getLatestAskFromXiaoai attempt=${attempt} success, ${messages.length} messages`);
        return messages;
      }
      if (isPollDebug()) songloft.log.info(`[ConversationMonitor] getLatestAskFromXiaoai attempt=${attempt} returned null, retrying...`);
    }
    songloft.log.info(`[ConversationMonitor] getLatestAskFromXiaoai all ${MAX_RETRIES} attempts failed`);
    return [];
  }

  // ===== 播放状态 =====

  /**
   * 获取播放器状态
   */
  async getPlayerStatus(deviceId: string): Promise<UbusResponse | null> {
    return this.ubusRequest(deviceId, 'player_get_play_status', 'mediaplayer', {});
  }

  /**
   * 验证 Token 有效性（通过调用 API）
   */
  async validateToken(): Promise<boolean> {
    try {
      const devices = await this.getDeviceList();
      return devices !== null;
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

    const result = await this.doPostRequest<UbusResponse>(apiUrl, body, logLabel);

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
  private async doPostRequest<T>(url: string, body: string, logLabel = ''): Promise<T | null> {
    const headers: Record<string, string> = {
      'User-Agent': this.userAgent,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': this.buildApiCookies(),
    };

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

    try {
      const text = response.text() as string;
      if (logLabel) {
        songloft.log.info(`[MinaClient] ${logLabel} HTTP POST response=${this.summarizeForLog(text)}`);
      }
      return JSON.parse(text) as T;
    } catch (e) {
      if (logLabel) {
        songloft.log.warn(`[MinaClient] ${logLabel} HTTP POST parse failed: ${String(e)}`);
      }
      return null;
    }
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

    if (isPollDebug()) songloft.log.info(`[ConversationMonitor] doGetLatestAskFromXiaoai status=${response.status}`);

    if (response.status === 401) {
      if (isPollDebug()) songloft.log.info(`[ConversationMonitor] doGetLatestAskFromXiaoai 401 token expired`);
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
      if (isPollDebug()) songloft.log.info(`[ConversationMonitor] doGetLatestAskFromXiaoai raw response (${text.length} chars): ${text.substring(0, 1000)}`);

      const result = JSON.parse(text) as Record<string, unknown>;

      // data 字段是一个 JSON 字符串
      const dataStr = result['data'] as string;
      if (!dataStr) {
        if (isPollDebug()) songloft.log.info(`[ConversationMonitor] doGetLatestAskFromXiaoai data field is empty/null`);
        return [];
      }

      const dataObj = JSON.parse(dataStr) as ConversationData;
      if (!dataObj.records || dataObj.records.length === 0) {
        if (isPollDebug()) songloft.log.info(`[ConversationMonitor] doGetLatestAskFromXiaoai records empty or missing`);
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
      if (isPollDebug()) songloft.log.info(`[ConversationMonitor] doGetLatestAskFromXiaoai parsed ${messages.length} messages`);
      return messages;
    } catch (e) {
      songloft.log.warn(`[ConversationMonitor] doGetLatestAskFromXiaoai parse error: ${String(e)}`);
      return null;
    }
  }

  /**
   * 通过 UBus nlp_result_get 获取对话记录
   * 用于不支持 xiaoai API 的设备（如 M01）
   */
  private async getLatestAskByUbus(deviceId: string): Promise<AskMessage[]> {
    const result = await this.ubusRequest(deviceId, 'nlp_result_get', 'mibrain', {});
    if (!result || !result.data) return [];

    try {
      const data = result.data as NlpResultData;
      if (data.code !== 0 || !data.info) return [];

      const infoData = JSON.parse(data.info) as NlpInfoData;
      if (!infoData.result) return [];

      const messages: AskMessage[] = [];

      for (const item of infoData.result) {
        if (!item.nlp) continue;

        try {
          const nlp = JSON.parse(item.nlp) as NlpDetail;
          const timestamp = parseInt(nlp.meta.timestamp, 10) || 0;

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
      return [];
    }
  }
}
