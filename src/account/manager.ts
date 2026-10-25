// MIoT 智能音箱插件 - 账号管理器
// 管理多个平台账号的生命周期、登录状态和设备列表

import type {
  AccountConfig,
  DeviceConfig,
  MinaDevice,
  XiaomiTokenInfo,
} from '../types';
import { ConfigManager } from '../config/manager';

/**
 * 账号管理器
 * 管理多个平台账号的创建、删除、登录状态和设备列表
 */
export class AccountManager {
  private configManager: ConfigManager;
  /** accountId → MinaHTTPClient 实例（运行时，不持久化） */
  private minaClients: Map<string, any>;

  constructor(configManager: ConfigManager) {
    this.configManager = configManager;
    this.minaClients = new Map();
  }

  // ===== 账号生命周期 =====

  /**
   * 创建新账号（与 Go 版本 CreateAccount(id, name) 一致，由调用方指定 ID）
   * 支持两种调用方式：
   * - 3参数: createAccount(id, account, authType) — AuthService 使用
   * - 2参数: createAccount(account, authType) — Handler 使用，account 同时作为 id
   * @returns 新创建的 AccountConfig
   */
  async createAccount(idOrAccount: string, accountOrAuthType: string, authType?: string): Promise<AccountConfig> {
    let id: string;
    let account: string;
    let finalAuthType: string;

    if (authType !== undefined) {
      // 3-arg call: createAccount(id, account, authType)
      id = idOrAccount;
      account = accountOrAuthType;
      finalAuthType = authType;
    } else {
      // 2-arg call: createAccount(account, authType) — handler pattern
      id = idOrAccount;
      account = idOrAccount;
      finalAuthType = accountOrAuthType;
    }

    const now = new Date().toISOString();
    const newAccount: AccountConfig = {
      id,
      account,
      auth_type: finalAuthType,
      login_method: finalAuthType,
      password: '',
      pass_token: '',
      user_id: '',
      services: {},
      devices: [],
      last_selected_device_id: '',
      created_at: now,
      updated_at: now,
    };
    await this.configManager.addAccount(newAccount);
    return newAccount;
  }

  /**
   * 删除账号
   * 同时清除运行时的MinaClient实例
   */
  async deleteAccount(accountId: string): Promise<void> {
    this.minaClients.delete(accountId);
    await this.configManager.removeAccount(accountId);
  }

  /** 获取单个账号配置 */
  async getAccount(accountId: string): Promise<AccountConfig | null> {
    return this.configManager.getAccount(accountId);
  }

  /** 获取所有账号配置 */
  async getAccounts(): Promise<AccountConfig[]> {
    return this.configManager.getAccounts();
  }

  // ===== 登录状态 =====

  /**
   * 标记账号为已登录
   * 保存Token信息到持久化存储
   */
  async setAccountLoggedIn(accountId: string, tokenInfo: XiaomiTokenInfo): Promise<void> {
    await this.configManager.updateAccount(accountId, {
      user_id: tokenInfo.user_id,
      services: tokenInfo.services,
      auth_type: 'token',
    });
  }

  /**
   * 标记账号为已登出
   * 清除Token信息和运行时客户端
   */
  async setAccountLoggedOut(accountId: string): Promise<void> {
    this.minaClients.delete(accountId);
    await this.configManager.updateAccount(accountId, {
      services: {},
      pass_token: '',
    });
  }

  /**
   * 检查账号是否已登录
   * 判断依据：至少有一个service token存在
   */
  async isAccountLoggedIn(accountId: string): Promise<boolean> {
    const account = await this.configManager.getAccount(accountId);
    if (!account) return false;
    return Object.keys(account.services).length > 0;
  }

  // ===== Mina客户端管理（运行时） =====

  /** 获取账号的MinaHTTPClient实例 */
  getMinaClient(accountId: string): any | null {
    return this.minaClients.get(accountId) ?? null;
  }

  /** 设置账号的MinaHTTPClient实例 */
  setMinaClient(accountId: string, client: any): void {
    this.minaClients.set(accountId, client);
  }

  /** 移除账号的MinaHTTPClient实例 */
  removeMinaClient(accountId: string): void {
    this.minaClients.delete(accountId);
  }

  // ===== 设备管理 =====

  /**
   * 更新设备列表
   * 合并API返回的设备信息和本地已有配置
   * 保留本地设置（managed/volume/playMode等），更新设备基本信息
   */
  async updateDeviceList(accountId: string, devices: MinaDevice[]): Promise<void> {
    const account = await this.configManager.getAccount(accountId);
    if (!account) {
      throw new Error(`Account not found: ${accountId}`);
    }

    // 构建现有设备配置的映射
    const existingMap = new Map<string, DeviceConfig>();
    for (const dev of account.devices) {
      existingMap.set(dev.device_id, dev);
    }

    // 合并：API设备信息 + 本地持久化设置
    const mergedDevices: DeviceConfig[] = devices.map(apiDev => {
      const existing = existingMap.get(apiDev.deviceID);
      return {
        device_id: apiDev.deviceID,
        device_name: apiDev.name,
        model: apiDev.model || '',
        hardware: apiDev.hardware || '',
        alias: apiDev.alias || '',
        // 新设备默认全部启用管理，保留用户已保存的取消勾选。
        managed: existing?.managed ?? true,
        volume: existing?.volume ?? 0,
        play_mode: existing?.play_mode ?? 'order',
        play_speed: existing?.play_speed ?? 1,
        playlist_id: existing?.playlist_id ?? 0,
        current_song_index: existing?.current_song_index ?? 0,
        last_selected_at: existing?.last_selected_at ?? '',
      };
    });

    await this.configManager.updateAccount(accountId, { devices: mergedDevices });
  }

  /**
   * 获取受管理的设备列表
   * 过滤 managed === true 的设备
   */
  async getManagedDevices(accountId: string): Promise<DeviceConfig[]> {
    const devices = await this.configManager.getDevices(accountId);
    return devices.filter(d => d.managed);
  }

  /** 更新特定设备的配置 */
  async updateDeviceConfig(accountId: string, deviceId: string, updates: Partial<DeviceConfig>): Promise<void> {
    await this.configManager.updateDevice(accountId, deviceId, updates);
  }

  /** 设置最后选中的设备 */
  async setLastSelectedDevice(accountId: string, deviceId: string): Promise<void> {
    await this.configManager.setLastSelectedDevice(accountId, deviceId);
  }

  /** 获取最后选中的设备ID */
  async getLastSelectedDevice(accountId: string): Promise<string | null> {
    const account = await this.configManager.getAccount(accountId);
    if (!account) return null;
    return account.last_selected_device_id || null;
  }

  // ===== 初始化 =====

  /**
   * 从storage恢复账号数据
   * 加载所有已保存的账号配置，但不自动重建MinaHTTPClient
   * MinaHTTPClient需要后续认证模块根据Token有效性来决定是否重建
   */
  async init(): Promise<void> {
    // 从storage加载账号列表，确认数据可读
    const accounts = await this.configManager.getAccounts();
    // 清除可能残留的运行时客户端引用
    this.minaClients.clear();

    // 日志：已加载的账号数量（QuickJS环境使用console.log）
    if (accounts.length > 0) {
      console.log(`[AccountManager] Loaded ${accounts.length} account(s) from storage`);
    }
  }
}
