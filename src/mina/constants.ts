// MIoT 智能音箱插件 - Mina API 常量定义
// 翻译自 Go 源码: plugins/songloft-plugin-xiaomi/pkg/mina/constants.go

/** 小米账号服务基础 URL */
export const ACCOUNT_BASE_URL = 'https://account.xiaomi.com';

/** 小爱音箱 API 主机 */
export const MINA_API_HOST = 'api2.mina.mi.com';

/** 小爱音箱 API 基础 URL */
export const MINA_API_BASE_URL = `https://${MINA_API_HOST}`;

/** 小爱音箱服务标识符 */
export const MINA_SID = 'micoapi';

/** 米家 / MIoT 服务标识符（用于 MiIO RPC） */
export const XIAOMI_IO_SID = 'xiaomiio';

/** 米家 MiIO API 基础 URL */
export const MIIO_API_BASE_URL = 'https://api.io.mi.com/app';

/** MiIO API User-Agent（与 mi-gpt / mi-service-lite 的 MiIOT 请求对齐） */
export const MIIO_USER_AGENT = 'MICO/AndroidApp/@SHIP.TO.2A2FE0D7@/2.4.40';

/** 用户代理模板（%s 将被替换为 deviceID） */
export const USER_AGENT_TEMPLATE = 'Android-7.1.1-1.0.0-ONEPLUS A3010-136-%s APP/xiaomi.smarthome APPV/62830';

/** 默认 HTTP 超时时间（毫秒） */
export const DEFAULT_HTTP_TIMEOUT = 30000;

/** serviceToken 有效期（小时） */
export const SERVICE_TOKEN_VALID_HOURS = 12;

/** serviceToken 主动刷新阈值（小时），剩余时间低于此值时触发刷新 */
export const TOKEN_REFRESH_THRESHOLD_HOURS = 3;

/** 小爱对话记录 API 模板 */
export const LATEST_ASK_API_TEMPLATE = 'https://userprofile.mina.mi.com/device_profile/v2/conversation?source=dialogu&hardware=%s&timestamp=%d&limit=%l';

/** 最大重定向次数 */
export const MAX_REDIRECTS = 10;

/** 最大重试次数（对话记录API） */
export const MAX_RETRIES = 3;

/** 登录状态 */
export const LoginState = {
  SUCCESS: 'success' as const,
  NEED_CAPTCHA: 'need_captcha' as const,
  NEED_VERIFY: 'need_verify' as const,
  FAILED: 'failed' as const,
};

export type LoginStateType = typeof LoginState[keyof typeof LoginState];

/**
 * 需要通过 Mina ubus 方式获取对话记录的设备型号列表
 * 这些设备不支持 LATEST_ASK_API，需要使用 ubus nlp_result_get 接口
 */
export const GET_ASK_BY_MINA: string[] = ['M01'];

/**
 * 需要使用 PlayByMusicURL（player_play_music）接口的设备型号
 * 这些设备不支持标准的 player_play_url 方法
 */
export const NEED_USE_PLAY_MUSIC_API: Record<string, boolean> = {
  'X08C': true,
  'X08E': true,
  'X8F': true,
  'X4B': true,
  'LX05': true,
  'OH2': true,
  'OH2P': true,
  'X6A': true,
  'LX04': true,
  'L05B': true,
  'L05C': true,
  'LX06': true,
  'L06A': true,
  'X08A': true,
  'X10A': true,
  'L15A': true,
  'L16A': true,
  'L17A': true,
};

/**
 * 支持通过 MIoT action 播放 TTS 的设备型号。
 * 映射值为 xiaomusic 的 TTS command: "<siid>-<aiid>"。
 */
export const TTS_COMMAND: Record<string, string> = {
  OH2: '5-3',
  OH2P: '7-3',
  LX06: '5-1',
  S12: '5-1',
  L15A: '7-3',
  LX5A: '5-1',
  LX01: '5-1',
  LX05: '5-1',
  X10A: '7-3',
  L17A: '7-3',
  ASX4B: '5-3',
  L06A: '5-1',
  L05B: '5-3',
  L05C: '5-3',
  X6A: '7-3',
  X08E: '7-3',
  X8F: '7-3',
  L09A: '3-1',
  LX04: '5-1',
};

/**
 * 判断指定硬件型号是否需要通过 Mina 方式获取对话记录
 */
export function shouldUseMinaForAsk(hardware: string): boolean {
  return GET_ASK_BY_MINA.includes(hardware);
}

/**
 * 判断指定硬件型号是否需要使用 player_play_music API
 * @param extraModels - 用户自定义的额外型号列表（补充内置白名单）
 */
export function needUsePlayMusicAPI(hardware: string, extraModels?: string[]): boolean {
  if (NEED_USE_PLAY_MUSIC_API[hardware] === true) return true;
  if (extraModels && extraModels.includes(hardware)) return true;
  return false;
}

/**
 * 获取指定硬件型号的 MIoT TTS command。
 */
export function getTTSCommand(hardware: string): string {
  return TTS_COMMAND[hardware] || '';
}

/**
 * 格式化 UserAgent（替换 %s 为 deviceID）
 */
export function formatUserAgent(deviceId: string): string {
  return USER_AGENT_TEMPLATE.replace('%s', deviceId);
}

/**
 * 格式化对话记录API URL
 */
export function formatLatestAskUrl(hardware: string, timestamp: number, limit = 2): string {
  return LATEST_ASK_API_TEMPLATE.replace('%s', hardware).replace('%d', String(timestamp)).replace('%l', String(limit));
}
