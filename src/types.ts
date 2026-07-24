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
  temp_artist?: string;      // 临时歌手歌单的搜索词，重启后用于恢复
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

// ===== 设备分组 =====

/**
 * 设备分组（存储在 songloft.storage 的 device_groups key）。
 * 把多台音箱归为一组后，对组内任一设备的播放控制会同步给组内其他成员。
 * 成员用 DeviceTargetRef 表达，支持跨账号；一个设备最多属于一个组（成员互斥）。
 */
export interface DeviceGroup {
  id: string;                  // 'grp_<ts>_<rand>'
  name: string;
  members: DeviceTargetRef[];
  created_at: string;          // ISO8601
  updated_at: string;
}

// ===== 配置 =====

/** 搜歌优先级策略 */
export type SearchPriority = 'parallel' | 'local_first' | 'external_first';

/** 单个外部搜索源 */
export interface ExternalSearchSource {
  id: string;        // 插件源用 provider id（如 'subsonic'），自定义源用 'src_<ts>_<rand>'
  name: string;      // 显示名
  url: string;       // 完整 http(s) URL 或 '/' 开头相对路径（走宿主 loopback 调其他插件）
  token?: string;    // 可选认证，空则回落插件 token
  enabled: boolean;  // 单源启用开关
}

/**
 * 其他插件通过 songloft.comm 注册进来的「搜索源候选」。
 * entryPath 一律以宿主注入的可信 from 为准，绝不取自 payload（防伪造）。
 * 落盘后与 config handler 里的内置 knownProviders 合并去重，供配置页下拉选择。
 */
export interface SearchProviderRegistration {
  entryPath: string;   // 提供方插件 entryPath（= 可信 from）
  name: string;        // 显示名
  searchPath: string;  // 搜索子路径，默认 '/api/search/topone'
  icon?: string;       // 可选图标
}

/** 插件全局配置 */
export interface PluginConfig {
  version: string;
  server_host: string;
  timezone: string;
  conversation_monitor_enabled: boolean;
  voice_command_enabled: boolean;
  voice_memory_enabled: boolean;
  voice_memory_max_records: number;
  scheduled_tasks_enabled: boolean;
  force_mp3: boolean;
  radio_force_mp3: boolean; // 电台转码：部分音箱无法解码 AAC/HE-AAC 或不支持 HLS 电台，开启后电台流服务端实时转码为 MP3
  external_search_enabled: boolean; // 是否启用外部搜索（全局总开关）
  /** @deprecated 迁移到 external_search_sources[0]，仅读取用于兼容 */
  external_search_url: string;      // 外部搜索 API 地址
  /** @deprecated 迁移到 external_search_sources[0]，仅读取用于兼容 */
  external_search_token: string;    // 外部搜索 Token 认证
  external_search_sources: ExternalSearchSource[]; // 外部搜索源列表，数组顺序即优先级
  external_search_playlist_id: string; // 外部搜索导入后追加到的歌单 ID，空串表示不追加
  external_search_timeout: number;     // 外部搜索超时（秒），默认 6
  external_search_no_import: boolean;   // 不入库直接播放：命中直链型结果时直接把原始 URL 推给音箱，不写入曲库（临时链接友好）
  search_priority: SearchPriority;     // 搜歌优先级策略
  extra_music_api_models?: string[];
  indicator_light_enabled?: boolean;
  default_cover_id?: string;
  touchscreen_lyrics_enabled?: boolean; // 触屏歌词：逐首匹配小米曲库以在触屏音箱显示歌词
  interrupt_tts_hint_enabled: boolean;
  interrupt_tts_hint_text: string;
  conversation_poll_interval: number;
  conversation_poll_debug?: boolean; // 会话轮询调试日志开关，默认 false（稳态轮询不打冗余日志）
  smart_resume_timeout: number;
  max_song_index: number;
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

/** 起始位置(play_playlist 专用) */
export type StartPosition =
  | 'first'    // 从第一首开始(默认,兼容旧任务)
  | 'resume'   // 从上次播放进度继续(设备持久化的 current_song_index)
  | 'random';  // 每次执行随机挑一首作为起点

/** 任务参数 */
export interface TaskParams {
  playlist_name?: string;
  playlist_id?: number;
  song_name?: string;      // 用于 play_playlist_from 指定起始歌曲
  start_position?: StartPosition; // 用于 play_playlist 指定起始位置,缺省=first
  play_mode?: string;      // 空串表示「跟随上次」(沿用设备持久化的播放模式)
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
  type: string;            // "play_playlist" | "play_artist" | "play_song" | "set_play_mode" | "set_volume" | "next" | "previous" | "stop"
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
  playlist_name?: string;
  current_index: number;
  current_song?: { id: number; title: string; artist: string; cover_url?: string; lyric_url?: string };
  position: number;
  duration: number;
  is_playing: boolean;
}
