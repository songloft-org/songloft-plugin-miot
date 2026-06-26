// MIoT 智能音箱插件 - Mina HTTP 客户端
// 翻译自 Go 源码: plugins/songloft-plugin-xiaomi/pkg/mina/mina_client.go
// 设备控制 API 客户端：设备列表、播放控制、音量、TTS、对话记录

import { CookieJar } from '../utils/cookie';
import { fetchWithRedirects } from '../utils/http';
import { generateDeviceId } from '../utils/crypto';
import {
  MINA_API_BASE_URL,
  MINA_SID,
  SERVICE_TOKEN_VALID_HOURS,
  MAX_RETRIES,
  formatUserAgent,
  formatLatestAskUrl,
  shouldUseMinaForAsk,
  needUsePlayMusicAPI,
} from './constants';
import type { XiaomiTokenInfo, MinaDevice, AskMessage } from '../types';
import type { DeviceInfoRaw, DeviceListResponse, UbusResponse, NlpResultData, NlpInfoData, NlpDetail, ConversationData } from './models';

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
   */
  async playByUrl(deviceId: string, url: string, hardware = '', extraModels?: string[], keepLight = false, customAudioId?: string): Promise<boolean> {
    if (hardware && needUsePlayMusicAPI(hardware, extraModels)) {
      return this.playByMusicURL(deviceId, url, keepLight, customAudioId);
    }
    return this.playURL(deviceId, url, keepLight);
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
   */
  async textToSpeech(deviceId: string, text: string): Promise<boolean> {
    const message = { text };
    return (await this.ubusRequest(deviceId, 'player_play_tts', 'mediaplayer', message)) !== null;
  }

  // ===== 对话记录 =====

  /**
   * 获取最新对话记录（自动选择获取方式）
   * @param deviceId - 设备 ID
   * @param hardware - 设备硬件型号
   * @param limit - 记录数量限制（默认2）
   */
  async getLatestAskFromXiaoai(deviceId: string, hardware: string, limit = 2): Promise<AskMessage[]> {
    songloft.log.info(`[ConversationMonitor] getLatestAskFromXiaoai deviceId=${deviceId} hardware=${hardware} limit=${limit} useMinaForAsk=${shouldUseMinaForAsk(hardware)}`);
    // 部分设备需要通过 ubus 方式获取
    if (shouldUseMinaForAsk(hardware)) {
      const ubusResult = await this.getLatestAskByUbus(deviceId);
      songloft.log.info(`[ConversationMonitor] getLatestAskByUbus result: ${ubusResult ? ubusResult.length : 0} messages`);
      return ubusResult;
    }

    // 与 Go 版一致：在循环外部生成时间戳，重试时复用相同 URL
    const timestamp = Date.now();
    const apiUrl = formatLatestAskUrl(hardware, timestamp, limit);
    songloft.log.info(`[ConversationMonitor] getLatestAskFromXiaoai apiUrl=${apiUrl}`);

    // 大多数设备通过 xiaoai API 获取，带3次重试
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const messages = await this.doGetLatestAskFromXiaoai(deviceId, apiUrl);
      if (messages !== null) {
        songloft.log.info(`[ConversationMonitor] getLatestAskFromXiaoai attempt=${attempt} success, ${messages.length} messages`);
        return messages;
      }
      songloft.log.info(`[ConversationMonitor] getLatestAskFromXiaoai attempt=${attempt} returned null, retrying...`);
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
  async ubusRequest(deviceId: string, method: string, path: string, message: Record<string, unknown>): Promise<UbusResponse | null> {
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

    const result = await this.doPostRequest<UbusResponse>(apiUrl, body);

    // 如果401并且有回调，尝试刷新
    if (result === null) {
      return null;
    }

    // 检查响应码
    if (result.code !== 0) {
      return null;
    }

    return result;
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
  private async doPostRequest<T>(url: string, body: string): Promise<T | null> {
    const headers: Record<string, string> = {
      'User-Agent': this.userAgent,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': this.buildApiCookies(),
    };

    let response: any;
    try {
      const fetchResult = await fetchWithRedirects(url, { method: 'POST', headers, body }, new CookieJar(), 0);
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
            const retryResult = await fetchWithRedirects(url, { method: 'POST', headers, body }, new CookieJar(), 0);
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
      songloft.log.info(`[ConversationMonitor] doGetLatestAskFromXiaoai fetch error: ${String(e)}`);
      return null;
    }

    songloft.log.info(`[ConversationMonitor] doGetLatestAskFromXiaoai status=${response.status}`);

    if (response.status === 401) {
      songloft.log.info(`[ConversationMonitor] doGetLatestAskFromXiaoai 401 token expired`);
      if (this.onTokenExpired) {
        await this.onTokenExpired();
      }
      return null;
    }

    if (response.status !== 200) {
      songloft.log.info(`[ConversationMonitor] doGetLatestAskFromXiaoai unexpected status=${response.status}`);
      return null;
    }

    try {
      const text = response.text() as string;
      // 打印原始响应体（最多 1000 字符）
      songloft.log.info(`[ConversationMonitor] doGetLatestAskFromXiaoai raw response (${text.length} chars): ${text.substring(0, 1000)}`);

      const result = JSON.parse(text) as Record<string, unknown>;

      // data 字段是一个 JSON 字符串
      const dataStr = result['data'] as string;
      if (!dataStr) {
        songloft.log.info(`[ConversationMonitor] doGetLatestAskFromXiaoai data field is empty/null`);
        return [];
      }

      const dataObj = JSON.parse(dataStr) as ConversationData;
      if (!dataObj.records || dataObj.records.length === 0) {
        songloft.log.info(`[ConversationMonitor] doGetLatestAskFromXiaoai records empty or missing`);
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
      songloft.log.info(`[ConversationMonitor] doGetLatestAskFromXiaoai parsed ${messages.length} messages`);
      return messages;
    } catch (e) {
      songloft.log.info(`[ConversationMonitor] doGetLatestAskFromXiaoai parse error: ${String(e)}`);
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
