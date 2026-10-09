export interface ApiEnvelope<T> {
  success: boolean;
  data: T;
  error?: string;
  message?: string;
  expired?: boolean;
  warning?: string;
}

export interface AIConfig {
  enabled?: boolean;
  api_url?: string;
  api_key?: string;
  model?: string;
  timeout?: number;
}

export interface MiotConfig {
  server_host: string;
  server_host_status: 'empty' | 'loopback' | 'ok';
  suggested_addresses: string[];
  conversation_monitor_enabled: boolean;
  conversation_poll_interval: number;
  debug_log_enabled: boolean;
  voice_command_enabled: boolean;
  voice_memory_enabled: boolean;
  voice_memory_max_records: number;
  scheduled_tasks_enabled: boolean;
  timezone: string;
  force_mp3: boolean;
  radio_force_mp3: boolean;
  volume_normalize: boolean;
  song_transition_offset: number;
  max_song_index: number;
  external_search_enabled: boolean;
  external_search_url: string;
  external_search_token: string;
  external_search_sources: SearchSource[];
  external_search_playlist_id: string;
  external_search_timeout: number;
  external_search_no_import: boolean;
  search_priority: 'parallel' | 'local_first' | 'external_first';
  music_api_model_disabled: string[];
  music_api_model_defaults: string[];
  indicator_light_enabled: boolean;
  interrupt_tts_hint_enabled: boolean;
  interrupt_tts_hint_text: string;
  play_announcement_enabled: boolean;
  play_announcement_template: string;
  play_announcement_wait_mode: string;
  play_announcement_delay: number;
  play_announcement_scope: string;
  smart_resume_timeout: number;
  hourly_chime_resume_enabled: boolean;
  default_cover_id: string | number;
  touchscreen_lyrics_enabled: boolean;
  ai_config: AIConfig;
}

export interface SearchSource {
  id: string;
  name: string;
  url: string;
  token: string;
  enabled: boolean;
}

export interface SearchProvider {
  id?: string;
  entry_path?: string;
  entryPath?: string;
  name: string;
  url?: string;
  installed?: boolean;
  active?: boolean;
  search_path?: string;
  searchPath?: string;
  icon?: string;
}

export interface Account {
  id: string;
  account: string;
  account_name?: string;
  name?: string;
  user_id?: string;
  status?: string;
  logged_in?: boolean;
  is_valid?: boolean;
  login_method?: string;
}

export interface Device {
  device_id?: string;
  id?: string;
  name: string;
  alias?: string;
  model?: string;
  hardware?: string;
  managed?: boolean;
  online?: boolean;
  presence?: string;
  deviceID?: string;
}

export interface AccountDevices {
  account_id: string;
  account_name?: string;
  devices: Device[];
  last_selected_device_id?: string;
}

export interface DeviceMember {
  account_id: string;
  device_id: string;
}

export interface DeviceGroup {
  id: string;
  name: string;
  members: DeviceMember[];
  created_at?: string;
  updated_at?: string;
}

export interface Playlist {
  id: number;
  name: string;
  song_count?: number;
  type?: string;
  sort_by?: string;
  sort_order?: string;
}

export interface Song {
  id: number;
  title: string;
  artist?: string;
  album?: string;
  duration?: number;
  cover_url?: string;
  lyric_url?: string;
  is_live?: boolean;
}

/** 某台设备在某个歌单上次播到哪一首（后端 GET /playlists/:id/progress） */
export interface PlaylistProgress {
  playlist_id: number;
  song_id: number;
  song_index: number;
  position_sec: number;
  updated_at: number;
}

export type PlayMode = 'order' | 'single' | 'random' | 'loop' | 'singlePlay';

export interface PlayerStatus {
  state?: string;
  is_playing?: boolean;
  position?: number;
  duration?: number;
  volume?: number;
  play_mode?: PlayMode;
  playlist_id?: number;
  playlist_name?: string;
  current_index?: number;
  current_song?: Song | null;
  device_online?: boolean;
  speed?: number;
}

export interface SleepTimerStatus {
  active: boolean;
  mode: 'time' | 'songs';
  /** time 模式为毫秒，songs 模式为歌曲数。 */
  remaining: number;
  total: number;
}

export interface ConversationMessage {
  id?: string;
  timestamp?: number | string;
  account_id?: string;
  device_id?: string;
  device_name?: string;
  query?: string;
  text?: string;
  answer?: string;
}

export interface Webhook {
  id: string;
  name: string;
  url: string;
}

export interface VoiceCommand {
  id?: string;
  type: string;
  patterns?: string[];
  pattern?: string;
  param?: string;
  enabled?: boolean;
  keywords?: string[];
}

export interface IndexStatus {
  ready?: boolean;
  is_ready?: boolean;
  refreshing?: boolean;
  song_count?: number;
  playlist_count?: number;
  message?: string;
  error?: string;
}

export interface MemoryStats {
  entityCount?: number;
  queryCount?: number;
  hitCount?: number;
  savedAiCalls?: number;
  [key: string]: unknown;
}

export interface MemoryEntity {
  canonicalKey?: string;
  canonical_key?: string;
  songName?: string;
  artist?: string;
  aliases?: Array<{ id?: string; query?: string; alias?: string }>;
  records?: Array<{ id: string; query?: string }>;
}

export type ScheduleType = 'daily' | 'weekly' | 'monthly';

export interface ScheduledTask {
  id?: string;
  name: string;
  enabled: boolean;
  action: string;
  schedule: {
    type: ScheduleType;
    time: string;
    weekdays?: number[];
    monthdays?: number[];
    holiday_mode?: string;
  };
  target: {
    all_managed?: boolean;
    all?: boolean;
    devices?: DeviceMember[];
  };
  params: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

export interface ScheduleLog {
  task_id: string;
  task_name: string;
  action: string;
  executed_at: string;
  success: boolean;
  message: string;
}

export interface LoginChallenge {
  need_captcha?: boolean;
  captcha_url?: string;
  need_verify?: boolean;
  verify_url?: string;
  notification_url?: string;
  session_id?: string;
  poll_session_id?: string;
  qrcode_url?: string;
  qr_url?: string;
  image?: string;
  status?: string;
  account?: Account;
  message?: string;
}

export interface SelectOption {
  value: string;
  label: string;
  /**
   * `searchable` 下拉的匹配文本，缺省时回退 `label`。
   *
   * 歌单的 label 是 `playlistLabel()` 产出的「名称 (歌曲数)」，直接拿它匹配会让
   * 输入 `2` 命中所有歌曲数含 2 的歌单。旧版原生前端匹配的是纯名称
   * （`.playlist-select-item-name` 的 textContent），这里靠该字段还原。
   */
  searchText?: string;
}
