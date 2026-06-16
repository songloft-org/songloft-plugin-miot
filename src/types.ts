// MIoT 智能音箱插件 - 数据类型定义

// ===== 账号相关 =====

/** 账号配置（存储在 songloft.storage 中） */
export interface AccountConfig {
  id: string;
  account: string;           // 小米账号（用户名/邮箱/手机）
  auth_type: string;         // "password" | "token" | "qrcode"
  login_method: string;      // "password" | "qrcode" | "token"
  password: string;          // 加密后密码
  pass_token: string;        // passToken
  user_id: string;           // 小米用户ID
  services: Record<string, ServiceTokenInfo>;
  devices: DeviceConfig[];
  last_selected_device_id: string;
  created_at: string;        // ISO8601
  updated_at: string;
}

/** 小米服务Token信息 */
export interface ServiceTokenInfo {
  service_token: string;
  ssecurity: string;
  expires_at: number;        // Unix timestamp
}

/** 设备配置 */
export interface DeviceConfig {
  device_id: string;
  device_name: string;
  model: string;
  hardware: string;
  alias: string;
  managed: boolean;
  volume: number;
  play_mode: string;         // "order" | "random" | "single" | "loop"
  playlist_id: number;
  current_song_index: number;
  last_selected_at: string;
}

// ===== Token信息 =====

/** 小米Token完整信息 */
export interface XiaomiTokenInfo {
  user_id: string;
  device_id: string;
  services: Record<string, ServiceTokenInfo>;
  created_at: string;
  expires_at: string;
}

// ===== 登录相关 =====

/** 登录结果 */
export interface LoginResult {
  state: LoginState;
  message: string;
  captcha_url?: string;
  notification_url?: string;
  qrcode_url?: string;
}

/** 登录状态 */
export type LoginState = 'idle' | 'logging_in' | 'need_captcha' | 'need_verify' | 'success' | 'failed';

// ===== 设备相关 =====

/** 小米API返回的原始设备数据 */
export interface MinaDevice {
  deviceID: string;
  name: string;
  miotDID: string;
  model: string;
  hardware: string;
  alias: string;
  presence: string;
}

// ===== 配置 =====

/** 插件全局配置 */
export interface PluginConfig {
  version: string;
  server_host: string;
  timezone: string;
  conversation_monitor_enabled: boolean;
  voice_command_enabled: boolean;
  scheduled_tasks_enabled: boolean;
  force_mp3: boolean;
  external_search_enabled: boolean; // 是否启用外部搜索
  external_search_url: string;      // 外部搜索 API 地址
  external_search_token: string;    // 外部搜索 Token 认证
  extra_music_api_models?: string[];
  indicator_light_enabled?: boolean;
  interrupt_tts_hint_enabled: boolean;
  interrupt_tts_hint_text: string;
  ai_config: AIConfig;
}

// ===== 定时任务 =====

/** 定时任务 */
export interface ScheduledTask {
  id: string;              // "task_{timestamp_ms}"
  name: string;
  enabled: boolean;
  action: TaskAction;
  schedule: TaskSchedule;
  target: TaskTarget;
  params: TaskParams;
  created_at: string;
  updated_at: string;
}

/** 任务动作类型 */
export type TaskAction = 'play_playlist' | 'play_playlist_from' | 'stop' | 'set_volume' | 'set_play_mode' | 'enable_monitor' | 'disable_monitor';

/** 节假日感知模式(仅对 weekly 调度生效) */
export type HolidayMode =
  | 'ignore'           // 不感知节假日,完全按 weekdays 触发(默认,向后兼容)
  | 'only_holiday'     // 仅在法定放假日触发,且 weekday 也必须勾选
  | 'exclude_holiday'; // 跳过法定假,但调休补班日强制触发(无视 weekday)

/** 任务调度规则 */
export interface TaskSchedule {
  type: 'weekly' | 'monthly';
  time: string;            // "HH:MM"
  weekdays?: number[];     // 0=Sun, 1=Mon...6=Sat
  monthdays?: number[];    // 1-31
  holiday_mode?: HolidayMode;
}

/** 目标设备标识（与 Go DeviceTarget 一致） */
export interface DeviceTargetRef {
  account_id: string;
  device_id: string;
}

/** 任务目标设备 */
export interface TaskTarget {
  all_managed: boolean;
  devices: DeviceTargetRef[];  // [{account_id, device_id}]
}

/** 任务参数 */
export interface TaskParams {
  playlist_name?: string;
  playlist_id?: number;
  song_name?: string;      // 用于 play_playlist_from 指定起始歌曲
  play_mode?: string;
  volume?: number;
}

/** 任务执行日志 */
export interface TaskLog {
  task_id: string;
  task_name: string;
  action: string;
  executed_at: string;
  success: boolean;
  message: string;
}

// ===== Webhook =====

/** Webhook配置 */
export interface WebhookConfig {
  id: string;
  url: string;
  name: string;
}

// ===== 语音口令 =====

/** 语音口令配置 */
export interface VoiceCommand {
  type: string;            // "play_playlist" | "play_song" | "set_play_mode" | "set_volume" | "next" | "previous" | "stop"
  keywords: string[];
  param?: string;          // 附加参数（播放模式值、音量方向等）
  enabled: boolean;
}

// ===== AI 口令分析 =====

/** AI 分析配置 */
export interface AIConfig {
  enabled: boolean;
  api_url: string;
  api_key: string;
  model: string;
  timeout: number;         // 秒数，默认 6
}

/** AI 分析结果 */
export interface AIAnalysisResult {
  /** 匹配到的操作类型，与 VoiceCommand.type 对应 */
  action: string;
  /** 操作参数字段（根据 action 类型不同而不同） */
  params: {
    name?: string;
    artist?: string;
    playlist?: string;
    mode?: string;
    volume?: number;
    direction?: string;
  };
  /** AI 置信度 */
  confidence: 'high' | 'medium' | 'low';
  /** 原始文本中的有效信息片段 */
  rawText: string;
}

// ===== 对话记录 =====

/** Mina API 返回的原始对话消息（与 WASM 版 mina.AskMessage 一致） */
export interface AskMessage {
  request_id?: string;
  timestamp_ms: number;
  response: {
    answer: Array<{
      domain?: string;
      action?: string;
      content?: string;
      question?: string;
      intention?: { query?: string };
    }>;
  };
}

/** 带设备上下文的对话消息（与 WASM 版 ConversationMessage 一致） */
export interface ConversationMessage {
  account_id: string;
  device_id: string;
  device_name: string;
  message: AskMessage;
}

// ===== 播放状态 =====

/** 播放状态枚举 */
export type PlayState = 'idle' | 'playing' | 'paused' | 'stopped';

/** 播放模式枚举 */
export type PlayMode = 'order' | 'random' | 'single' | 'loop';

/** 播放器状态 */
export interface PlayerStatus {
  state: PlayState;
  play_mode: PlayMode;
  playlist_id: number;
  current_index: number;
  current_song?: { id: number; title: string; artist: string; cover_url?: string; lyric_url?: string };
  position: number;
  duration: number;
  is_playing: boolean;
}
