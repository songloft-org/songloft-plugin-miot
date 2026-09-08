// MIoT 智能音箱插件 - 配置管理器
// 基于 songloft.storage API 实现配置持久化（异步桥接）

/// <reference types="@songloft/plugin-sdk" />

import type {
  PluginConfig,
  ExternalSearchSource,
  SearchProviderRegistration,
  AccountConfig,
  DeviceConfig,
  DeviceGroup,
  DeviceTargetRef,
  WebhookConfig,
  VoiceCommand,
  ScheduledTask,
  TaskLog,
  AIConfig,
  PlaylistProgress,
  PlaylistProgressStore,
} from '../types';
import { DEFAULT_MEMORY_MAX_RECORDS, normalizeMemoryMaxRecords } from '../memory/types';
import { getDefaultVoiceCommands } from '../voicecmd/defaults';

// ===== 存储键常量 =====
const STORAGE_KEY_CONFIG = 'config';
const STORAGE_KEY_ACCOUNTS = 'accounts';
const STORAGE_KEY_WEBHOOKS = 'webhooks';
const STORAGE_KEY_VOICE_COMMANDS = 'voice_commands';
const STORAGE_KEY_SCHEDULED_TASKS = 'scheduled_tasks';
const STORAGE_KEY_SCHEDULE_LOGS = 'schedule_logs';
const STORAGE_KEY_AI_CONFIG = 'ai_config';
const STORAGE_KEY_SEARCH_PROVIDERS = 'search_provider_registry';
const STORAGE_KEY_DEVICE_GROUPS = 'device_groups';
const STORAGE_KEY_PLAYLIST_PROGRESS = 'playlist_progress';

/** 搜索源候选注册默认搜索子路径 */
const DEFAULT_SEARCH_PATH = '/api/search/topone';

/** 日志最大条数（环形缓冲） */
const MAX_SCHEDULE_LOGS = 200;

/**
 * 每台设备最多记多少个歌单的播放进度。
 * 进度是每次切歌都要写的热数据，整表以一个 JSON 落在 storage 里，必须有界：
 * 超出后按 updated_at 淘汰最久没播的歌单（用户几乎不会在 30 个歌单之间来回切）。
 */
const MAX_PLAYLIST_PROGRESS_PER_DEVICE = 30;

/**
 * 歌单进度的作用域键。
 *
 * 一律记在「PlaylistManager 的主设备」名下（分组共享主设备的那一份），与
 * `PlaylistManager.persistState` 写 DeviceConfig 的口径完全一致。调用方拿到的是
 * 用户点的那台设备，分组时它可能不是主设备，所以要用 `pm.getPrimary()` 的结果来构造。
 */
export function playlistProgressScope(accountId: string, deviceId: string): string {
  return accountId + ':' + deviceId;
}

/** 默认插件配置 */
function defaultPluginConfig(): PluginConfig {
  return {
    version: '1.0',
    server_host: '',
    timezone: 'Asia/Shanghai',
    conversation_monitor_enabled: false,
    voice_command_enabled: false,
    voice_memory_enabled: true,
    voice_memory_max_records: DEFAULT_MEMORY_MAX_RECORDS,
    scheduled_tasks_enabled: false,
    force_mp3: false,
    radio_force_mp3: false,
    volume_normalize: false,
    song_transition_offset: 0,
    external_search_enabled: false,
    external_search_url: '',
    external_search_token: '',
    external_search_sources: [],
    external_search_playlist_id: '',
    external_search_timeout: 6,
    external_search_no_import: false,
    search_priority: 'parallel',
    indicator_light_enabled: true,
    default_cover_id: '1732418460076477549',
    touchscreen_lyrics_enabled: false,
    interrupt_tts_hint_enabled: false,
    interrupt_tts_hint_text: '正在搜索，请稍候',
    play_announcement_enabled: false,
    play_announcement_template: '即将播放{artist}的{song}',
    play_announcement_wait_mode: 'auto',
    play_announcement_delay: 3,
    play_announcement_scope: 'voice',
    conversation_poll_interval: 1,
    conversation_poll_debug: false,
    smart_resume_timeout: 30,
    max_song_index: 10000,
    ai_config: defaultAIConfig(),
  };
}

/** 默认 AI 配置 */
function defaultAIConfig(): AIConfig {
  return {
    enabled: false,
    api_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    api_key: '',
    model: 'qwen-flash',
    timeout: 6,
  };
}

/**
 * 配置管理器
 * 使用 songloft.storage API（异步）实现分键持久化存储
 */
export class ConfigManager {

  // ===== 热路径内存缓存 =====
  // 仅缓存每秒轮询 / 每条语音消息都会读的 config 与 accounts 两个 key，
  // 其余 key 不缓存（非热路径，避免过度设计）。
  //
  // 设计要点：
  // - 缓存 in-flight Promise 而非最终值，防止 async 让出期间并发读触发的
  //   「惊群」重复 storage.get。load 内部有 try/catch 不会 reject，不存在
  //   缓存到 rejected Promise 的风险。
  // - 写穿透：saveConfig/saveAccounts 写盘后直接把新值塞回缓存，写后读即新值。
  //   所有账号写入（add/update/remove/updateDevice/setLastSelectedDevice）
  //   最终都经 saveAccounts，自动失效。
  // - 引用约定：getAccounts 返回缓存数组引用。现有调用方模式均为
  //   「get → 原地改 → saveAccounts 写回」，改的就是要写回的数据，语义正确。
  //   getConfig 每次返回浅合并的新对象，不暴露缓存引用。
  private accountsCache: Promise<AccountConfig[]> | null = null;
  private configCache: Promise<Partial<PluginConfig>> | null = null;
  // 歌单进度表：每次切歌都要读改写，不缓存就是每首歌一次多余的 storage.get。
  // 与上面两个 key 同一套约定（缓存 in-flight Promise + 写穿透）。
  private playlistProgressCache: Promise<PlaylistProgressStore> | null = null;

  // ===== 通用存储读写 =====

  /** 从storage读取JSON数据，不存在则返回默认值 */
  private async load<T>(key: string, defaultValue: T): Promise<T> {
    const raw = await songloft.storage.get(key);
    if (raw === null || raw === undefined || raw === '') {
      return defaultValue;
    }
    try {
      return JSON.parse(raw as string) as T;
    } catch {
      return defaultValue;
    }
  }

  /** 将JSON数据写入storage */
  private async save<T>(key: string, value: T): Promise<void> {
    await songloft.storage.set(key, JSON.stringify(value));
  }

  // ===== 全局配置 =====

  /** 获取插件全局配置（与默认值合并，确保新增字段有默认值） */
  async getConfig(): Promise<PluginConfig> {
    if (this.configCache === null) {
      this.configCache = this.load<Partial<PluginConfig>>(STORAGE_KEY_CONFIG, {});
    }
    const stored = await this.configCache;
    const merged = { ...defaultPluginConfig(), ...stored };
    merged.voice_memory_enabled = stored.voice_memory_enabled !== false;
    merged.voice_memory_max_records = normalizeMemoryMaxRecords(stored.voice_memory_max_records);
    // 旧单值外部搜索源迁移：sources 为空时合成为 legacy 源
    merged.external_search_sources = this.normalizeSearchSources(merged);
    // 旧单值字段（external_search_url/token，已 @deprecated）一次性别名迁移落盘：
    // 只要存储里还残留旧字段就清空并写回，否则配置页删除「已迁移的搜索源」后，
    // 下一次 getConfig 又会从残留旧字段重新合成出该源——表现为删了还冒出来、
    // 只剩一个源时「删不掉必须保留一个」。合成源写入数组后成为真实条目，可正常删除。
    if ((merged.external_search_url || '').trim()) {
      const next: Partial<PluginConfig> = {
        ...stored,
        external_search_url: '',
        external_search_token: '',
        external_search_sources: merged.external_search_sources,
      };
      await this.save(STORAGE_KEY_CONFIG, next);
      this.configCache = Promise.resolve(next);
    }
    return merged;
  }

  /**
   * 归一化外部搜索源列表：清洗数组；若数组为空但存在旧单值配置，则迁移为单元素列表。
   */
  private normalizeSearchSources(cfg: PluginConfig): ExternalSearchSource[] {
    const arr = Array.isArray(cfg.external_search_sources) ? cfg.external_search_sources : [];
    const valid = arr
      .filter((s) => s && typeof s.url === 'string')
      .map((s) => ({
        id: s.id || `src_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        name: typeof s.name === 'string' ? s.name : '',
        url: (s.url || '').trim(),
        token: typeof s.token === 'string' ? s.token.trim() : '',
        enabled: s.enabled !== false,
      }))
      .filter((s) => s.url !== '');
    if (valid.length > 0) return valid;
    const legacyUrl = (cfg.external_search_url || '').trim();
    if (legacyUrl) {
      return [{
        id: 'legacy',
        name: '已迁移的搜索源',
        url: legacyUrl,
        token: (cfg.external_search_token || '').trim(),
        enabled: true,
      }];
    }
    return [];
  }

  /** 保存插件全局配置 */
  async saveConfig(config: PluginConfig): Promise<void> {
    await this.save(STORAGE_KEY_CONFIG, config);
    this.configCache = Promise.resolve(config);
  }

  // ===== 账号管理（存储层） =====

  /** 获取所有账号配置 */
  async getAccounts(): Promise<AccountConfig[]> {
    if (this.accountsCache === null) {
      this.accountsCache = this.load<AccountConfig[]>(STORAGE_KEY_ACCOUNTS, []);
    }
    return this.accountsCache;
  }

  /** 保存所有账号配置 */
  async saveAccounts(accounts: AccountConfig[]): Promise<void> {
    await this.save(STORAGE_KEY_ACCOUNTS, accounts);
    this.accountsCache = Promise.resolve(accounts);
  }

  /** 按ID获取单个账号配置 */
  async getAccount(accountId: string): Promise<AccountConfig | null> {
    const accounts = await this.getAccounts();
    return accounts.find(a => a.id === accountId) ?? null;
  }

  /** 添加账号配置（追加） */
  async addAccount(account: AccountConfig): Promise<void> {
    const accounts = await this.getAccounts();
    // 检查是否已存在
    if (accounts.some(a => a.id === account.id)) {
      throw new Error(`Account already exists: ${account.id}`);
    }
    accounts.push(account);
    await this.saveAccounts(accounts);
  }

  /** 更新账号配置（按ID匹配并合并字段） */
  async updateAccount(accountId: string, updates: Partial<AccountConfig>): Promise<void> {
    const accounts = await this.getAccounts();
    const idx = accounts.findIndex(a => a.id === accountId);
    if (idx === -1) {
      throw new Error(`Account not found: ${accountId}`);
    }
    accounts[idx] = { ...accounts[idx], ...updates, updated_at: new Date().toISOString() };
    await this.saveAccounts(accounts);
  }

  /** 删除账号配置 */
  async removeAccount(accountId: string): Promise<void> {
    const accounts = await this.getAccounts();
    const filtered = accounts.filter(a => a.id !== accountId);
    if (filtered.length === accounts.length) {
      throw new Error(`Account not found: ${accountId}`);
    }
    await this.saveAccounts(filtered);
    // 账号下所有设备的歌单进度一起清掉，否则账号删了进度还在表里占位到永远
    await this.removePlaylistProgressByAccount(accountId);
  }

  // ===== 设备管理（存储层） =====

  /** 获取某账号的设备列表 */
  async getDevices(accountId: string): Promise<DeviceConfig[]> {
    const account = await this.getAccount(accountId);
    return account?.devices ?? [];
  }

  /** 更新某账号下特定设备的配置 */
  async updateDevice(accountId: string, deviceId: string, updates: Partial<DeviceConfig>): Promise<void> {
    const accounts = await this.getAccounts();
    const accIdx = accounts.findIndex(a => a.id === accountId);
    if (accIdx === -1) {
      throw new Error(`Account not found: ${accountId}`);
    }
    const devIdx = accounts[accIdx].devices.findIndex(d => d.device_id === deviceId);
    if (devIdx === -1) {
      throw new Error(`Device not found: ${deviceId}`);
    }
    accounts[accIdx].devices[devIdx] = { ...accounts[accIdx].devices[devIdx], ...updates };
    accounts[accIdx].updated_at = new Date().toISOString();
    await this.saveAccounts(accounts);
  }

  /** 设置账号最后选中的设备 */
  async setLastSelectedDevice(accountId: string, deviceId: string): Promise<void> {
    await this.updateAccount(accountId, { last_selected_device_id: deviceId });
  }

  // ===== 歌单播放进度（每设备 × 每歌单） =====

  /**
   * 读取整张进度表。返回缓存引用（与 getAccounts 同约定）：调用方原地改完必须走
   * savePlaylistProgressStore 写回。存储内容被写坏（不是对象）时退回空表，不污染调用方。
   */
  private async getPlaylistProgressStore(): Promise<PlaylistProgressStore> {
    if (this.playlistProgressCache === null) {
      this.playlistProgressCache = this.load<PlaylistProgressStore>(STORAGE_KEY_PLAYLIST_PROGRESS, {});
    }
    const store = await this.playlistProgressCache;
    if (!store || typeof store !== 'object' || Array.isArray(store)) {
      const empty: PlaylistProgressStore = {};
      this.playlistProgressCache = Promise.resolve(empty);
      return empty;
    }
    return store;
  }

  private async savePlaylistProgressStore(store: PlaylistProgressStore): Promise<void> {
    await this.save(STORAGE_KEY_PLAYLIST_PROGRESS, store);
    this.playlistProgressCache = Promise.resolve(store);
  }

  /** 读取某设备在某歌单的播放进度；无有效记录返回 null */
  async getPlaylistProgress(scopeKey: string, playlistId: number): Promise<PlaylistProgress | null> {
    if (!scopeKey || !playlistId || playlistId <= 0) return null;
    const store = await this.getPlaylistProgressStore();
    const list = store[scopeKey];
    if (!Array.isArray(list)) return null;
    const hit = list.find(p => p && p.playlist_id === playlistId && p.song_id > 0);
    return hit ?? null;
  }

  /** 写入某设备在某歌单的播放进度（同歌单覆盖，超出上限淘汰最久没播的） */
  async savePlaylistProgress(scopeKey: string, progress: PlaylistProgress): Promise<void> {
    if (!scopeKey || !progress || progress.playlist_id <= 0 || progress.song_id <= 0) return;
    const store = await this.getPlaylistProgressStore();
    const kept = (Array.isArray(store[scopeKey]) ? store[scopeKey] : [])
      .filter(p => p && p.playlist_id > 0 && p.song_id > 0 && p.playlist_id !== progress.playlist_id);
    kept.push(progress);
    kept.sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
    store[scopeKey] = kept.slice(0, MAX_PLAYLIST_PROGRESS_PER_DEVICE);
    await this.savePlaylistProgressStore(store);
  }

  /** 删除某设备在某歌单的播放进度（歌单 ID 已失效时清理）；无记录则静默 */
  async removePlaylistProgress(scopeKey: string, playlistId: number): Promise<void> {
    if (!scopeKey || !playlistId || playlistId <= 0) return;
    const store = await this.getPlaylistProgressStore();
    const list = store[scopeKey];
    if (!Array.isArray(list)) return;
    const filtered = list.filter(p => !p || p.playlist_id !== playlistId);
    if (filtered.length === list.length) return;
    if (filtered.length === 0) {
      delete store[scopeKey];
    } else {
      store[scopeKey] = filtered;
    }
    await this.savePlaylistProgressStore(store);
  }

  /** 删除某账号下所有设备的歌单进度（账号被移除时调用） */
  async removePlaylistProgressByAccount(accountId: string): Promise<void> {
    if (!accountId) return;
    const store = await this.getPlaylistProgressStore();
    const prefix = accountId + ':';
    let changed = false;
    for (const key of Object.keys(store)) {
      if (key.startsWith(prefix)) {
        delete store[key];
        changed = true;
      }
    }
    if (changed) {
      await this.savePlaylistProgressStore(store);
    }
  }

  // ===== Webhook管理 =====

  /** 获取所有Webhook配置 */
  async getWebhooks(): Promise<WebhookConfig[]> {
    return this.load<WebhookConfig[]>(STORAGE_KEY_WEBHOOKS, []);
  }

  /** 保存所有Webhook配置 */
  async saveWebhooks(webhooks: WebhookConfig[]): Promise<void> {
    await this.save(STORAGE_KEY_WEBHOOKS, webhooks);
  }

  /** 添加Webhook */
  async addWebhook(webhook: WebhookConfig): Promise<void> {
    const webhooks = await this.getWebhooks();
    if (webhooks.some(w => w.id === webhook.id)) {
      throw new Error(`Webhook already exists: ${webhook.id}`);
    }
    webhooks.push(webhook);
    await this.saveWebhooks(webhooks);
  }

  /** 删除Webhook */
  async removeWebhook(webhookId: string): Promise<void> {
    const webhooks = await this.getWebhooks();
    const filtered = webhooks.filter(w => w.id !== webhookId);
    if (filtered.length === webhooks.length) {
      throw new Error(`Webhook not found: ${webhookId}`);
    }
    await this.saveWebhooks(filtered);
  }

  // ===== 搜索源候选注册表（其他插件经 comm 注册） =====

  /** 获取所有已注册的搜索源候选 */
  async getSearchProviders(): Promise<SearchProviderRegistration[]> {
    return this.load<SearchProviderRegistration[]>(STORAGE_KEY_SEARCH_PROVIDERS, []);
  }

  /**
   * 注册/更新一个搜索源候选（按 entryPath 幂等去重覆盖）。
   * entryPath 由调用方以宿主可信 from 传入，不接受 payload 伪造。
   */
  async upsertSearchProvider(reg: SearchProviderRegistration): Promise<void> {
    const entryPath = (reg.entryPath || '').trim();
    if (!entryPath) {
      throw new Error('search provider entryPath is required');
    }
    const normalized: SearchProviderRegistration = {
      entryPath,
      name: (reg.name || '').trim() || entryPath,
      searchPath: (reg.searchPath || '').trim() || DEFAULT_SEARCH_PATH,
      icon: typeof reg.icon === 'string' ? reg.icon.trim() : undefined,
    };
    const providers = await this.getSearchProviders();
    const idx = providers.findIndex(p => p.entryPath === entryPath);
    if (idx === -1) {
      providers.push(normalized);
    } else {
      providers[idx] = normalized;
    }
    await this.save(STORAGE_KEY_SEARCH_PROVIDERS, providers);
  }

  /** 注销一个搜索源候选（按 entryPath，不存在则静默） */
  async removeSearchProvider(entryPath: string): Promise<void> {
    const key = (entryPath || '').trim();
    if (!key) return;
    const providers = await this.getSearchProviders();
    const filtered = providers.filter(p => p.entryPath !== key);
    if (filtered.length !== providers.length) {
      await this.save(STORAGE_KEY_SEARCH_PROVIDERS, filtered);
    }
  }

  // ===== 语音口令 =====

  /** 获取语音口令配置，存储为空时回退到默认口令 */
  async getVoiceCommands(): Promise<VoiceCommand[]> {
    const commands = await this.load<VoiceCommand[]>(STORAGE_KEY_VOICE_COMMANDS, []);
    if (commands.length === 0) {
      return getDefaultVoiceCommands();
    }
    return commands;
  }

  /** 保存语音口令配置 */
  async saveVoiceCommands(commands: VoiceCommand[]): Promise<void> {
    await this.save(STORAGE_KEY_VOICE_COMMANDS, commands);
  }

  // ===== AI 配置 =====

  /** 获取 AI 配置 */
  async getAIConfig(): Promise<AIConfig> {
    return this.load<AIConfig>(STORAGE_KEY_AI_CONFIG, defaultAIConfig());
  }

  /** 保存 AI 配置 */
  async saveAIConfig(config: AIConfig): Promise<void> {
    await this.save(STORAGE_KEY_AI_CONFIG, config);
  }

  // ===== 定时任务 =====

  /** 获取所有定时任务 */
  async getScheduledTasks(): Promise<ScheduledTask[]> {
    return this.load<ScheduledTask[]>(STORAGE_KEY_SCHEDULED_TASKS, []);
  }

  /** 保存所有定时任务 */
  async saveScheduledTasks(tasks: ScheduledTask[]): Promise<void> {
    await this.save(STORAGE_KEY_SCHEDULED_TASKS, tasks);
  }

  /** 添加定时任务 */
  async addScheduledTask(task: ScheduledTask): Promise<void> {
    const tasks = await this.getScheduledTasks();
    if (tasks.some(t => t.id === task.id)) {
      throw new Error(`Scheduled task already exists: ${task.id}`);
    }
    tasks.push(task);
    await this.saveScheduledTasks(tasks);
  }

  /** 更新定时任务（按ID匹配并合并字段） */
  async updateScheduledTask(taskId: string, updates: Partial<ScheduledTask>): Promise<void> {
    const tasks = await this.getScheduledTasks();
    const idx = tasks.findIndex(t => t.id === taskId);
    if (idx === -1) {
      throw new Error(`Scheduled task not found: ${taskId}`);
    }
    tasks[idx] = { ...tasks[idx], ...updates, updated_at: new Date().toISOString() };
    await this.saveScheduledTasks(tasks);
  }

  /** 删除定时任务 */
  async removeScheduledTask(taskId: string): Promise<void> {
    const tasks = await this.getScheduledTasks();
    const filtered = tasks.filter(t => t.id !== taskId);
    if (filtered.length === tasks.length) {
      throw new Error(`Scheduled task not found: ${taskId}`);
    }
    await this.saveScheduledTasks(filtered);
  }

  // ===== 执行日志 =====

  /** 获取所有执行日志 */
  async getScheduleLogs(): Promise<TaskLog[]> {
    return this.load<TaskLog[]>(STORAGE_KEY_SCHEDULE_LOGS, []);
  }

  /** 添加执行日志（环形缓冲，最多200条，超出删除最旧的） */
  async addScheduleLog(log: TaskLog): Promise<void> {
    const logs = await this.getScheduleLogs();
    logs.push(log);
    // 超过上限时移除最旧的条目
    while (logs.length > MAX_SCHEDULE_LOGS) {
      logs.shift();
    }
    await this.save(STORAGE_KEY_SCHEDULE_LOGS, logs);
  }

  // ===== 设备分组 =====

  /** 获取所有设备分组 */
  async getDeviceGroups(): Promise<DeviceGroup[]> {
    return this.load<DeviceGroup[]>(STORAGE_KEY_DEVICE_GROUPS, []);
  }

  /** 保存所有设备分组 */
  async saveDeviceGroups(groups: DeviceGroup[]): Promise<void> {
    await this.save(STORAGE_KEY_DEVICE_GROUPS, groups);
  }

  /**
   * 从一批组里剔除指定成员（保证一个设备只属于一个组）。
   * 返回剔除后的新数组（不修改入参元素引用外的结构）。
   */
  private stripMembersFromGroups(
    groups: DeviceGroup[],
    members: DeviceTargetRef[],
    exceptGroupId?: string,
  ): DeviceGroup[] {
    const claimed = new Set(members.map(m => `${m.account_id}:${m.device_id}`));
    for (const g of groups) {
      if (exceptGroupId && g.id === exceptGroupId) continue;
      g.members = g.members.filter(m => !claimed.has(`${m.account_id}:${m.device_id}`));
    }
    return groups;
  }

  /** 添加设备分组（成员互斥：从其它组剔除本组成员） */
  async addDeviceGroup(group: DeviceGroup): Promise<void> {
    const groups = await this.getDeviceGroups();
    if (groups.some(g => g.id === group.id)) {
      throw new Error(`Device group already exists: ${group.id}`);
    }
    this.stripMembersFromGroups(groups, group.members);
    groups.push(group);
    await this.saveDeviceGroups(groups);
  }

  /** 更新设备分组（按ID匹配并合并字段；改动成员时同样保证互斥） */
  async updateDeviceGroup(groupId: string, updates: Partial<DeviceGroup>): Promise<void> {
    const groups = await this.getDeviceGroups();
    const idx = groups.findIndex(g => g.id === groupId);
    if (idx === -1) {
      throw new Error(`Device group not found: ${groupId}`);
    }
    groups[idx] = { ...groups[idx], ...updates, id: groupId, updated_at: new Date().toISOString() };
    if (updates.members) {
      this.stripMembersFromGroups(groups, groups[idx].members, groupId);
    }
    await this.saveDeviceGroups(groups);
  }

  /** 删除设备分组 */
  async removeDeviceGroup(groupId: string): Promise<void> {
    const groups = await this.getDeviceGroups();
    const filtered = groups.filter(g => g.id !== groupId);
    if (filtered.length === groups.length) {
      throw new Error(`Device group not found: ${groupId}`);
    }
    await this.saveDeviceGroups(filtered);
  }

  /** 查找包含指定设备的分组（单组语义，取第一个命中；无则返回 null） */
  async findDeviceGroup(accountId: string, deviceId: string): Promise<DeviceGroup | null> {
    const groups = await this.getDeviceGroups();
    return groups.find(g =>
      g.members.some(m => m.account_id === accountId && m.device_id === deviceId),
    ) || null;
  }
}
