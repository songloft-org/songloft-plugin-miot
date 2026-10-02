// MIoT 智能音箱插件 - 对话监听器
// 翻译自 Go 源码: plugins/songloft-plugin-xiaomi/conversation/monitor.go
// 定时轮询设备对话记录，支持回调通知和 Webhook 推送

/// <reference types="@songloft/plugin-sdk" />

import { AccountManager } from '../account/manager';
import { ConfigManager } from '../config/manager';
import type { ConversationMessage, AskMessage, WebhookConfig } from '../types';
import { MinaHTTPClient } from '../mina/client';
import { isDebugLog } from '../utils/debug';

// ===== 常量 =====

/** 时钟偏移告警阈值：服务端时间戳超前本地时间超过此值即告警 */
const CLOCK_SKEW_WARN_MS = 5 * 60 * 1000;

// ===== 类型定义 =====

/** 内部回调函数类型 */
export type ConversationCallback = (msg: ConversationMessage) => void | Promise<void>;

/** 设备监听状态 */
interface DeviceMonitorState {
  accountId: string;
  deviceId: string;
  deviceName: string;
  hardware: string;
  /**
   * 去重基线，取自**平台服务端**返回的对话时间戳（`record.time`），
   * 绝不能用本地 `Date.now()` 初始化 —— 见 primed 注释
   */
  lastTimestampMs: number;
  /**
   * 是否已建立去重基线。
   *
   * false 时首轮 poll 只用返回结果建立基线，**不触发**回调 / Webhook / 消息缓冲。
   * 这样基线与被比较的时间戳同源（都来自平台服务端），彻底不依赖本地系统时钟：
   * - 旧实现用 `Date.now()` 当基线，系统时钟超前 N 时长 → 该时长内所有对话被静默丢弃，
   *   语音指令完全无响应，日志只有 "after filter: 0 new"，几乎无法归因
   * - 系统时钟落后 → 启动瞬间把最近 5 条历史对话当成新消息，重放旧语音指令
   */
  primed: boolean;
  isRunning: boolean;
  /** 连续失败时的退避间隔；成功后归零。 */
  retryDelayMs: number;
  nextPollAt: number;
}

/** 监听器状态（与 WASM 版 MonitorStatus 一致） */
export interface MonitorStatus {
  is_enabled: boolean;
  device_count: number;
  devices: DeviceMonitorStatusItem[];
  webhook_count: number;
  message_count: number;
}

/** 设备监听状态项（与 WASM 版 DeviceMonitorStatusItem 一致） */
export interface DeviceMonitorStatusItem {
  account_id: string;
  device_id: string;
  device_name: string;
  is_running: boolean;
  /** 去重基线（平台服务端时间戳）；0 = 首轮尚未建立基线 */
  last_timestamp_ms: number;
  /** 是否已建立去重基线（诊断用） */
  primed: boolean;
}

// ===== ConversationMonitor =====

/**
 * ConversationMonitor - 对话记录监听器
 * 定时轮询所有 managed 设备的对话记录，检测新消息并触发回调/Webhook
 */
export class ConversationMonitor {
  private accountManager: AccountManager;
  private configManager: ConfigManager;

  /** 环形消息缓冲区 */
  private messages: ConversationMessage[] = [];
  private maxMessages: number = 200;

  /** 轮询定时器 */
  private pollTimer: any = null;
  private pollInterval: number = 1000; // 默认1秒，从配置读取

  /** 设备监听状态: "accountId:deviceId" → DeviceMonitorState */
  private devices: Map<string, DeviceMonitorState> = new Map();

  /** 内部回调（观察者模式） */
  private callbacks: Map<string, ConversationCallback> = new Map();

  /** 是否启用 */
  private enabled: boolean = false;

  /** 停止/重启后旧异步任务不能再修改当前监听状态。 */
  private generation = 0;
  private startPromise: Promise<void> | null = null;
  /** 跨启停保留，旧请求结束前同一设备不能再发起请求。 */
  private inFlight = new Set<string>();

  constructor(accountManager: AccountManager, configManager: ConfigManager) {
    this.accountManager = accountManager;
    this.configManager = configManager;
  }

  // ===== 公开方法 =====

  /**
   * 启动对话监听
   * 遍历所有 managed 设备，启动定时轮询
   * 回调通过 registerCallback() 独立注册，start() 只管启停
   *
   * 返回 Promise：await 后设备列表已初始化完成、定时器已就绪，
   * 调用方随后查询 getStatus() 即可拿到真实设备数量（修复首次开启显示 0 台设备）。
   */
  async start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    if (this.enabled && this.pollTimer !== null) return;

    this.enabled = true;
    const generation = ++this.generation;
    const promise = this.startSession(generation);
    this.startPromise = promise;
    try {
      await promise;
    } finally {
      if (this.startPromise === promise) this.startPromise = null;
    }
  }

  private async startSession(generation: number): Promise<void> {
    try {
      // 从配置读取轮询间隔
      const config = await this.configManager.getConfig();
      // getConfig 可能耗时，其间若被 stop()，则放弃启动
      if (!this.isCurrent(generation)) return;

      const intervalSec = Math.max(1, Math.min(30, config.conversation_poll_interval ?? 1));
      this.pollInterval = intervalSec * 1000;

      // 等待设备列表刷新完成，确保 getStatus() 能读到真实设备数
      await this.refreshDevices(generation);
      if (!this.isCurrent(generation)) return;

      // 注意：这里**不能**用 Date.now() 预置 lastTimestampMs（本地时钟与平台服务端
      // 时间戳不同轴）。基线交给首轮 poll 用服务端返回值建立，见 pollDevice 的 primed 分支
      for (const dm of this.devices.values()) {
        dm.isRunning = true;
      }
      // devices=0 是典型的踩坑现场（开关打开但没在设备设置勾选任何音箱），INFO 混在启动噪声里
      // 用户导日志时几乎注意不到，升为 WARN 并给出下一步（songloft-org/songloft-plugin-miot#104）
      if (this.devices.size === 0) {
        songloft.log.warn(`[ConversationMonitor] Started with 0 managed devices — 请到"设备设置"勾选要监听的音箱，否则对话监听不会工作 (callbacks=${this.callbacks.size} interval=${intervalSec}s)`);
      } else {
        songloft.log.info(`[ConversationMonitor] Started, devices=${this.devices.size} callbacks=${this.callbacks.size} interval=${intervalSec}s`);
      }

      // 先同步跑一轮把基线建起来，再装定时器。
      // 基线只能由首轮 poll 从服务端返回值建立；若等到第一个 tick（间隔可配到 30s），
      // 这段窗口内发生的对话会被吞进基线而不投递。提前做掉，把窗口压到一次请求的时间。
      // 独立 try/catch：建基线失败绝不能阻止下面的定时器安装，否则监听彻底不工作
      try {
        await this.pollAll(generation);
      } catch (e) {
        songloft.log.warn('[ConversationMonitor] Initial priming failed: ' + String(e));
      }
      // 建基线期间可能被 stop()
      if (!this.isCurrent(generation)) return;

      if (this.pollTimer !== null) {
        clearInterval(this.pollTimer);
      }
      this.pollTimer = setInterval(() => {
        this.pollAll(generation).catch(e => {
          songloft.log.error('[ConversationMonitor] pollAll error: ' + String(e));
        });
      }, this.pollInterval);
    } catch (e) {
      songloft.log.error('[ConversationMonitor] start error: ' + String(e));
    }
  }

  /**
   * 停止对话监听
   */
  stop(): void {
    if (!this.enabled && this.pollTimer === null) {
      return;
    }

    this.enabled = false;
    this.generation++;
    this.startPromise = null;

    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    // 清空设备列表：下次 start() 会重新刷新，避免残留旧状态导致
    // 「首次开启显示 0 台、需重新开关才恢复」的表象误判
    this.devices.clear();

    songloft.log.info(`[ConversationMonitor] Stopped`);
  }

  /**
   * 刷新设备列表：停止已移除设备的监听，启动新增设备的监听
   */
  async refresh(): Promise<void> {
    if (!this.enabled) {
      return;
    }
    await this.refreshDevices(this.generation);
  }

  /**
   * 注册内部回调（观察者模式）
   */
  registerCallback(name: string, cb: ConversationCallback): void {
    this.callbacks.set(name, cb);
    songloft.log.info(`[ConversationMonitor] Callback registered: ${name}`);
  }

  /**
   * 取消内部回调
   */
  unregisterCallback(name: string): void {
    this.callbacks.delete(name);
    songloft.log.info(`[ConversationMonitor] Callback unregistered: ${name}`);
  }

  /**
   * 获取消息记录（最近N条）
   * @param limit - 返回条数限制（默认50）
   * @param sinceTimestampMs - 只返回此时间戳之后的消息（默认0=全部）
   */
  getMessages(limit: number = 50, sinceTimestampMs: number = 0): ConversationMessage[] {
    let result = this.messages;

    // 按时间戳过滤
    if (sinceTimestampMs > 0) {
      result = result.filter(msg => msg.message.timestamp_ms > sinceTimestampMs);
    }

    // 限制返回条数（取最新的）
    if (limit > 0 && result.length > limit) {
      result = result.slice(result.length - limit);
    }

    songloft.log.info(`[ConversationMonitor] getMessages total_stored=${this.messages.length} returning=${result.length} (limit=${limit} sinceTs=${sinceTimestampMs})`);
    return result;
  }

  /**
   * 获取监听器状态（与 WASM 版一致）
   */
  async getStatus(): Promise<MonitorStatus> {
    const webhooks = await this.configManager.getWebhooks();
    const devices: DeviceMonitorStatusItem[] = [];
    for (const dm of this.devices.values()) {
      devices.push({
        account_id: dm.accountId,
        device_id: dm.deviceId,
        device_name: dm.deviceName,
        is_running: dm.isRunning,
        last_timestamp_ms: dm.lastTimestampMs,
        primed: dm.primed,
      });
    }
    return {
      is_enabled: this.enabled,
      device_count: this.devices.size,
      devices,
      webhook_count: webhooks.length,
      message_count: this.messages.length,
    };
  }

  /**
   * 是否已启用
   */
  isEnabled(): boolean {
    return this.enabled;
  }

  // ===== 私有方法 =====

  /**
   * 刷新设备监听列表
   * 合并所有账号的 managed 设备
   */
  private async refreshDevices(generation: number): Promise<void> {
    const accounts = await this.accountManager.getAccounts();

    // 构建当前 managed 设备的 key 集合
    const managedKeys = new Set<string>();
    const newDevices: Array<{ accountId: string; deviceId: string; deviceName: string; hardware: string }> = [];

    for (const acc of accounts) {
      const managed = await this.accountManager.getManagedDevices(acc.id);
      for (const dev of managed) {
        const key = this.makeKey(acc.id, dev.device_id);
        managedKeys.add(key);
        if (!this.devices.has(key)) {
          newDevices.push({
            accountId: acc.id,
            deviceId: dev.device_id,
            deviceName: dev.device_name,
            hardware: dev.hardware,
          });
        }
      }
    }

    if (!this.isCurrent(generation)) return;

    // 移除不再 managed 的设备
    for (const key of this.devices.keys()) {
      if (!managedKeys.has(key)) {
        this.devices.delete(key);
        songloft.log.info(`[ConversationMonitor] Device removed from monitoring: ${key}`);
      }
    }

    // 添加新的 managed 设备
    for (const dev of newDevices) {
      const key = this.makeKey(dev.accountId, dev.deviceId);
      this.devices.set(key, {
        accountId: dev.accountId,
        deviceId: dev.deviceId,
        deviceName: dev.deviceName,
        hardware: dev.hardware,
        // 基线留给首轮 poll 从服务端返回值建立，不用本地时钟
        lastTimestampMs: 0,
        primed: false,
        isRunning: true,
        retryDelayMs: 0,
        nextPollAt: 0,
      });
      songloft.log.info(`[ConversationMonitor] Device added to monitoring: ${dev.deviceName} (${key})`);
    }
  }

  private isCurrent(generation: number, dm?: DeviceMonitorState): boolean {
    return this.enabled && this.generation === generation &&
      (!dm || this.devices.get(this.makeKey(dm.accountId, dm.deviceId)) === dm);
  }

  /** 轮询所有设备，同一设备不重叠，不同设备互不阻塞。 */
  private async pollAll(generation: number): Promise<void> {
    if (!this.isCurrent(generation)) return;
    // 每台设备独立推进，慢设备不阻塞其他音箱；同一设备最多一个任务。
    await Promise.all(Array.from(this.devices.values(), async dm => {
      const key = this.makeKey(dm.accountId, dm.deviceId);
      if (!dm.isRunning || this.inFlight.has(key) || Date.now() < dm.nextPollAt) return;
      this.inFlight.add(key);
      try {
        await this.pollDevice(dm, generation);
      } finally {
        this.inFlight.delete(key);
      }
    }));
  }

  private deferFailedPoll(dm: DeviceMonitorState): void {
    dm.retryDelayMs = Math.min(30000, Math.max(this.pollInterval * 2, dm.retryDelayMs * 2));
    dm.nextPollAt = Date.now() + dm.retryDelayMs;
  }

  /**
   * 轮询单个设备
   * 获取对话记录 → 时间戳去重 → 触发回调 → 推送 Webhook
   */
  private async pollDevice(dm: DeviceMonitorState, generation: number): Promise<void> {
    // 获取 MinaHTTPClient
    const client = this.accountManager.getMinaClient(dm.accountId) as MinaHTTPClient | null;
    if (!client) {
      return;
    }

    // 获取对话记录（null = 取记录失败，[] = 确实没有记录，两者不可混淆）
    let askMessages: AskMessage[] | null;
    try {
      askMessages = await client.getLatestAskFromXiaoai(dm.deviceId, dm.hardware, 5);
    } catch (e) {
      if (!this.isCurrent(generation, dm)) return;
      this.deferFailedPoll(dm);
      songloft.log.warn(`[ConversationMonitor] Failed to get conversations: ${dm.deviceId} ${String(e)}`);
      return;
    }

    if (!this.isCurrent(generation, dm)) return;

    // 取记录失败：跳过本轮。既不动基线也不建基线——拿失败当「没有记录」去建基线，
    // 会让基线停在 0，等取记录恢复后整批历史对话被当成新消息重放
    if (askMessages === null) {
      this.deferFailedPoll(dm);
      if (isDebugLog()) songloft.log.info(`[ConversationMonitor] pollDevice device=${dm.deviceId} fetch failed, skip round (primed=${dm.primed})`);
      return;
    }

    dm.retryDelayMs = 0;
    dm.nextPollAt = 0;

    // 打印返回的消息数量和内容摘要（稳态无消息时不打，避免每 tick 构造字符串+刷屏）
    // localNowMs 一并打出，便于目测本地时钟与服务端时间戳的偏移
    const msgCount = askMessages.length;
    if (isDebugLog() && msgCount > 0) {
      const summary = askMessages.map(m => {
        const q = m.response?.answer?.[0]?.question ?? '?';
        return `[ts=${m.timestamp_ms} q="${q.substring(0, 50)}"]`;
      }).join(', ');
      songloft.log.info(`[ConversationMonitor] pollDevice device=${dm.deviceId} localNowMs=${Date.now()} returned ${msgCount} messages: ${summary}`);
    }

    // 首轮：只用服务端返回值建立去重基线，不当作新消息（不触发回调 / Webhook / 缓冲）
    if (!dm.primed) {
      this.primeDevice(dm, askMessages);
      return;
    }

    if (askMessages.length === 0) {
      return;
    }

    // 按时间戳去重：只保留比 lastTimestampMs 更新的消息
    const newMessages: ConversationMessage[] = [];
    let maxTimestamp = dm.lastTimestampMs;

    for (const askMsg of askMessages) {
      if (askMsg.timestamp_ms > dm.lastTimestampMs) {
        // 构造完整的 ConversationMessage（与 WASM 版一致）
        const convMsg: ConversationMessage = {
          account_id: dm.accountId,
          device_id: dm.deviceId,
          device_name: dm.deviceName,
          message: askMsg,
        };
        newMessages.push(convMsg);
        if (askMsg.timestamp_ms > maxTimestamp) {
          maxTimestamp = askMsg.timestamp_ms;
        }
      }
    }

    // 打印过滤结果（稳态无新消息时不打）
    if (isDebugLog()) songloft.log.info(`[ConversationMonitor] pollDevice device=${dm.deviceId} after filter: ${newMessages.length} new (lastTimestampMs=${dm.lastTimestampMs})`);

    if (newMessages.length === 0) {
      return;
    }

    // 更新最后时间戳
    dm.lastTimestampMs = maxTimestamp;

    // 追加到全局消息缓冲区
    for (const msg of newMessages) {
      const q = msg.message?.response?.answer?.[0]?.question ?? '?';
      const a = msg.message?.response?.answer?.[0]?.content ?? '?';
      songloft.log.info(`[ConversationMonitor] addMessage ts=${msg.message.timestamp_ms} q="${q.substring(0, 80)}" a="${a.substring(0, 80)}"`);
      this.addMessage(msg);
    }

    songloft.log.info(`[ConversationMonitor] New messages account=${dm.accountId} device=${dm.deviceId} count=${newMessages.length}`);

    // 触发所有内部回调
    await this.notifyCallbacks(newMessages, () => this.isCurrent(generation, dm));

    // 向所有 Webhook 推送
    await this.triggerWebhooks(dm.accountId, dm.deviceId, dm.deviceName, newMessages, () => this.isCurrent(generation, dm));
  }

  /**
   * 建立设备的去重基线（首轮 poll 专用）
   *
   * 基线取本批返回记录的最大服务端时间戳，与后续比较的时间戳同源，
   * 因此完全不依赖本地系统时钟是否准确。
   *
   * 空数组（该设备确实没有对话记录）时基线保持 0，之后任何一条记录都算新消息——
   * 这对「全新设备无历史」是正确的，且此处已排除了「取记录失败」的情况。
   */
  private primeDevice(dm: DeviceMonitorState, askMessages: AskMessage[]): void {
    let batchMax = 0;
    for (const askMsg of askMessages) {
      if (askMsg.timestamp_ms > batchMax) {
        batchMax = askMsg.timestamp_ms;
      }
    }

    dm.lastTimestampMs = batchMax;
    dm.primed = true;

    songloft.log.info(`[ConversationMonitor] Baseline primed device=${dm.deviceId} name=${dm.deviceName} lastTimestampMs=${batchMax} (from ${askMessages.length} records, not delivered as new)`);

    // 时钟偏移告警：只有「服务端时间戳超前本地时间」这一个方向能确诊——对话不可能
    // 发生在未来。反方向（本地时钟超前）无法从这里判断，因为「最新一条对话是几天前」
    // 本身就完全正常，会误报。
    if (batchMax > 0) {
      const skewMs = batchMax - Date.now();
      if (skewMs > CLOCK_SKEW_WARN_MS) {
        songloft.log.warn(`[ConversationMonitor] 本地系统时钟可能落后约 ${Math.round(skewMs / 1000)}s：设备 ${dm.deviceName} 最新对话的服务端时间戳比本地当前时间还晚。请校准服务器时间（NTP）。对话监听本身不受影响（基线取自服务端），但 token 有效期判断等依赖本地时钟的逻辑会出错。`);
      }
    }
  }

  /**
   * 添加消息到环形缓冲区
   */
  private addMessage(msg: ConversationMessage): void {
    this.messages.push(msg);
    // 超过容量时移除最旧的消息
    if (this.messages.length > this.maxMessages) {
      this.messages = this.messages.slice(this.messages.length - this.maxMessages);
    }
  }

  /**
   * 触发所有已注册的内部回调
   */
  private async notifyCallbacks(messages: ConversationMessage[], isCurrent: () => boolean): Promise<void> {
    for (const [name, cb] of this.callbacks.entries()) {
      try {
        for (const msg of messages) {
          if (!isCurrent()) return;
          await cb(msg);
        }
      } catch (e) {
        songloft.log.error(`[ConversationMonitor] Callback error name=${name}: ${String(e)}`);
      }
    }
  }

  /**
   * 触发 Webhook 推送
   * 向所有已注册的 Webhook URL 发送 POST 请求
   */
  private async triggerWebhooks(accountId: string, deviceId: string, deviceName: string, messages: ConversationMessage[], isCurrent: () => boolean): Promise<void> {
    if (!isCurrent()) return;
    const webhooks = await this.configManager.getWebhooks();
    if (webhooks.length === 0) {
      return;
    }

    const payload = JSON.stringify({
      account_id: accountId,
      device_id: deviceId,
      device_name: deviceName,
      messages,
    });

    for (const wh of webhooks) {
      if (!isCurrent()) return;
      await this.sendWebhook(wh, payload);
    }
  }

  /**
   * 向单个 Webhook URL 发送 POST 请求
   */
  private async sendWebhook(wh: WebhookConfig, payload: string): Promise<void> {
    try {
      await fetch(wh.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
      });
      songloft.log.info(`[ConversationMonitor] Webhook sent id=${wh.id} url=${wh.url}`);
    } catch (e) {
      songloft.log.warn(`[ConversationMonitor] Webhook failed id=${wh.id} url=${wh.url}: ${String(e)}`);
    }
  }

  /**
   * 生成设备唯一键
   */
  private makeKey(accountId: string, deviceId: string): string {
    return accountId + ':' + deviceId;
  }
}
