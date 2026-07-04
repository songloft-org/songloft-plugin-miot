// MIoT 智能音箱插件 - Mina API 中间数据模型
// 翻译自 Go 源码: plugins/songloft-plugin-xiaomi/pkg/mina/models.go
// 仅包含 types.ts 中未覆盖的认证流程中间类型

import type { LoginStateType } from './constants';
import type { XiaomiTokenInfo } from '../types';

/** Step1 响应数据（从 serviceLogin JSON 中解析） */
export interface LoginStep1Data {
  _sign: string;
  qs: string;
  callback: string;
  sid: string;
  [key: string]: unknown;
}

/** Step2 响应中的认证结果 */
export interface LoginStep2Response {
  /** 登录成功时有 location URL */
  location?: string;
  /** 需要验证码时返回 captchaUrl */
  captchaUrl?: string;
  /** 需要二次验证时返回 notificationUrl */
  notificationUrl?: string;
  /** ssecurity 密钥 */
  ssecurity?: string;
  /** nonce（用于计算 clientSign） */
  nonce?: string;
  /** 用户ID */
  userId?: string;
  /** 响应码 */
  code?: number;
  /** 错误描述 */
  description?: string;
  [key: string]: unknown;
}

/** 验证码获取结果 */
export interface CaptchaResult {
  /** Base64 编码的图片数据 */
  imageBase64: string;
  /** ick cookie 值（验证码提交时需要） */
  ick: string;
}

/** 验证票据响应 */
export interface VerifyTicketResponse {
  code: number;
  location?: string;
  [key: string]: unknown;
}

/** serviceLogin 响应 */
export interface ServiceLoginResponse {
  code: number;
  location?: string;
  ssecurity?: string;
  nonce?: string;
  userId?: string;
  desc?: string;
  [key: string]: unknown;
}

/** 认证登录结果（内部使用） */
export interface AuthLoginResult {
  state: LoginStateType;
  error?: string;
  tokenInfo?: XiaomiTokenInfo;
  captchaImage?: string;
  verifyUrl?: string;
  verifyType?: 'phone' | 'email';
}

/** 设备列表 API 响应 */
export interface DeviceListResponse {
  code: number;
  message: string;
  data: DeviceInfoRaw[];
}

/** 设备信息（原始 API 返回） */
export interface DeviceInfoRaw {
  deviceID: string;
  serialNumber?: string;
  name: string;
  alias: string;
  model: string;
  modelName?: string;
  mac?: string;
  ssid?: string;
  ip?: string;
  hardware: string;
  rom?: string;
  presence: string;
  miotDID: string;
  deviceSNProfile?: string;
}

/** 曲库搜索 API 响应（/music/search） */
export interface MusicSearchResponse {
  code: number;
  data?: {
    songList?: Array<{
      audioID?: string;
      songID?: string;
      name?: string;
      artist?: { name?: string };
    }>;
  };
}

/** UBus 请求响应 */
export interface UbusResponse {
  code: number;
  message?: string;
  data?: unknown;
  [key: string]: unknown;
}

/** 对话记录 API 响应（来自 xiaoai userprofile） */
export interface ConversationAPIResponse {
  code: number;
  data?: string;  // JSON string
}

/** 对话记录数据 */
export interface ConversationData {
  records: ConversationRecord[];
}

/** 单条对话记录 */
export interface ConversationRecord {
  time: number;
  query: string;
  answers: Array<{
    type: string;  // "TTS" | "AUDIO" 等
    tts?: { text: string };
  }>;
}

/** UBus nlp_result_get 响应数据 */
export interface NlpResultData {
  code: number;
  info?: string;  // JSON string
}

/** NLP 结果解析后的数据 */
export interface NlpInfoData {
  result: Array<{
    nlp?: string;  // JSON string
    [key: string]: unknown;
  }>;
}

/** NLP 详细结构 */
export interface NlpDetail {
  meta: {
    request_id: string;
    timestamp: string;
  };
  response: {
    answer: Array<{
      domain: string;
      action: string;
      content: { to_speak: string };
      intention: { query: string };
    }>;
  };
}
