// MIoT 智能音箱插件 - 配置管理器
// 基于 songloft.storage API 实现配置持久化（异步桥接）

/// <reference types="@songloft/plugin-sdk" />

import type {
  PluginConfig,
  AccountConfig,
  DeviceConfig,
  WebhookConfig,
  VoiceCommand,
  ScheduledTask,
  TaskLog,
  AIConfig,
} from '../types';

// ===== 存储键常量 =====
const STORAGE_KEY_CONFIG = 'config';
const STORAGE_KEY_ACCOUNTS = 'accounts';
const STORAGE_KEY_WEBHOOKS = 'webhooks';
const STORAGE_KEY_VOICE_COMMANDS = 'voice_commands';
const STORAGE_KEY_SCHEDULED_TASKS = 'scheduled_tasks';
const STORAGE_KEY_SCHEDULE_LOGS = 'schedule_logs';
const STORAGE_KEY_AI_CONFIG = 'ai_config';

/** 日志最大条数（环形缓冲） */
const MAX_SCHEDULE_LOGS = 200;

/** 默认插件配置 */
function defaultPluginConfig(): PluginConfig {
  return {
    version: '1.0',
    server_host: '',
    timezone: 'Asia/Shanghai',
    conversation_monitor_enabled: false,
    voice_command_enabled: false,
    scheduled_tasks_enabled: false,
    force_mp3: false,
    external_search_enabled: false,
    external_search_url: '',
    external_search_token: '',
    external_search_playlist_id: '',
    external_search_timeout: 6,
    search_priority: 'parallel',
    indicator_light_enabled: true,
    default_cover_id: '1732418460076477549',
    touchscreen_lyrics_enabled: false,
    interrupt_tts_hint_enabled: false,
    interrupt_tts_hint_text: '正在搜索，请稍候',
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
    return { ...defaultPluginConfig(), ...stored };
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

  // ===== 语音口令 =====

  /** 获取语音口令配置 */
  async getVoiceCommands(): Promise<VoiceCommand[]> {
    return this.load<VoiceCommand[]>(STORAGE_KEY_VOICE_COMMANDS, []);
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
}
