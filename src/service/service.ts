// MIoT 智能音箱插件 - 设备控制服务
// 翻译自 Go 源码: plugins/songloft-plugin-xiaomi/service/service.go
// 协调 AccountManager 和 MinaHTTPClient，提供设备管理与播放控制的高层封装

/// <reference types="@songloft/plugin-sdk" />

import { AccountManager } from '../account/manager';
import { ConfigManager } from '../config/manager';
import { MinaHTTPClient } from '../mina/client';
import type { DeviceConfig, MinaDevice } from '../types';

// ===== 导出类型 =====

/** 设备信息（合并了API数据和本地配置） */
export interface DeviceInfo {
  deviceID: string;
  name: string;
  model: string;
  hardware: string;
  alias: string;
  presence: string;
  managed: boolean;
  volume: number;
  play_mode: string;
  playlist_id: number;
  current_song_index: number;
  last_selected_at: string;
}

// ===== 服务实现 =====

/**
 * MinaService - 小爱音箱设备控制服务
 * 提供设备列表获取、播放控制、音量设置、TTS等高层操作
 */
export class MinaService {
  private accountManager: AccountManager;
  private configManager: ConfigManager;
  /** 缓存设备ID → 设备硬件型号 */
  private deviceModelCache: Map<string, string>;

  constructor(accountManager: AccountManager, configManager: ConfigManager) {
    this.accountManager = accountManager;
    this.configManager = configManager;
    this.deviceModelCache = new Map();
  }

  // ===== 设备列表 =====

  /**
   * 获取设备列表（从小米API刷新，合并本地管理状态）
   * - 调用 client.getDeviceList() 获取最新设备列表
   * - 调用 accountManager.updateDeviceList() 合并到本地配置
   * - 返回合并后的设备信息（含 managed/volume/playMode 等本地设置）
   * - 如果API调用失败，返回本地缓存的设备列表
   */
  async getDevices(accountId: string): Promise<DeviceInfo[]> {
    const client = this.getClient(accountId);

    // 如果客户端不可用，回退到本地缓存
    if (!client) {
      songloft.log.warn('[MinaService] No client for account, returning cached devices: ' + accountId);
      return this.buildDeviceInfoFromLocal(accountId);
    }

    let apiDevices: MinaDevice[];
    try {
      apiDevices = await client.getDeviceList();
    } catch (e) {
      songloft.log.error('[MinaService] Failed to get device list from API: ' + String(e));
      return this.buildDeviceInfoFromLocal(accountId);
    }

    if (!apiDevices || apiDevices.length === 0) {
      // API返回空列表，仍使用本地缓存
      return this.buildDeviceInfoFromLocal(accountId);
    }

    // 更新设备型号缓存
    for (const dev of apiDevices) {
      this.deviceModelCache.set(dev.deviceID, dev.hardware);
    }

    // 合并到本地配置
    try {
      await this.accountManager.updateDeviceList(accountId, apiDevices);
    } catch (e) {
      songloft.log.error('[MinaService] Failed to update device list in config: ' + String(e));
    }

    // 从已合并的本地配置中构建返回结果（包含presence在线状态）
    return this.buildDeviceInfoMerged(accountId, apiDevices);
  }

  // ===== 播放控制 =====

  /**
   * 播放指定URL
   * 先暂停当前播放（防止声音叠加），再根据设备型号选择播放接口
   */
  async playURL(accountId: string, deviceId: string, url: string, songName?: string): Promise<boolean> {
    const client = this.getClient(accountId);
    if (!client) {
      songloft.log.warn('[MinaService] playURL: no client for account: ' + accountId);
      return false;
    }

    try {
      // 播放前先暂停当前播放，防止小爱音箱出现两个声音叠加
      await client.playerPause(deviceId);
    } catch (e) {
      songloft.log.warn('[MinaService] Pre-pause before play failed, continuing: ' + String(e));
    }

    try {
      // 获取设备硬件型号用于选择播放接口
      const hardware = await this.getDeviceHardware(client, deviceId);
      const config = await this.configManager.getConfig();
      const extraModels = config.extra_music_api_models || [];
      const keepLight = !!config.indicator_light_enabled;
      const customAudioId = config.default_cover_id;
      const lyricsEnabled = !!config.touchscreen_lyrics_enabled;
      return await client.playByUrl(deviceId, url, hardware, extraModels, keepLight, customAudioId,
        { enabled: lyricsEnabled, songName: songName || '' });
    } catch (e) {
      songloft.log.error('[MinaService] playURL failed: ' + String(e));
      return false;
    }
  }

  /**
   * 停止播放
   */
  async stopPlay(accountId: string, deviceId: string): Promise<boolean> {
    const client = this.getClient(accountId);
    if (!client) {
      songloft.log.warn('[MinaService] stopPlay: no client for account: ' + accountId);
      return false;
    }

    try {
      return await client.playerStop(deviceId);
    } catch (e) {
      songloft.log.error('[MinaService] stopPlay failed: ' + String(e));
      return false;
    }
  }

  /**
   * 暂停播放
   */
  async pausePlay(accountId: string, deviceId: string): Promise<boolean> {
    const client = this.getClient(accountId);
    if (!client) {
      songloft.log.warn('[MinaService] pausePlay: no client for account: ' + accountId);
      return false;
    }

    try {
      return await client.playerPause(deviceId);
    } catch (e) {
      songloft.log.error('[MinaService] pausePlay failed: ' + String(e));
      return false;
    }
  }

  /**
   * 恢复播放
   */
  async resumePlay(accountId: string, deviceId: string): Promise<boolean> {
    const client = this.getClient(accountId);
    if (!client) {
      songloft.log.warn('[MinaService] resumePlay: no client for account: ' + accountId);
      return false;
    }

    try {
      return await client.playerResume(deviceId);
    } catch (e) {
      songloft.log.error('[MinaService] resumePlay failed: ' + String(e));
      return false;
    }
  }

  // ===== 音量 =====

  /**
   * 设置音量 (0-100)
   * 成功后更新本地配置 deviceConfig.volume
   */
  async setVolume(accountId: string, deviceId: string, volume: number): Promise<boolean> {
    const client = this.getClient(accountId);
    if (!client) {
      songloft.log.warn('[MinaService] setVolume: no client for account: ' + accountId);
      return false;
    }

    try {
      const ok = await client.setVolume(deviceId, volume);
      if (ok) {
        // 成功后更新本地配置
        try {
          await this.accountManager.updateDeviceConfig(accountId, deviceId, { volume });
        } catch (e) {
          songloft.log.warn('[MinaService] Failed to save volume to config: ' + String(e));
        }
      }
      return ok;
    } catch (e) {
      songloft.log.error('[MinaService] setVolume failed: ' + String(e));
      return false;
    }
  }

  /**
   * 获取设备音量
   * @returns 音量 (0-100)，失败返回 -1
   */
  async getVolume(accountId: string, deviceId: string): Promise<number> {
    const client = this.getClient(accountId);
    if (!client) {
      songloft.log.warn('[MinaService] getVolume: no client for account: ' + accountId);
      return -1;
    }

    try {
      return await client.getVolume(deviceId);
    } catch (e) {
      songloft.log.error('[MinaService] getVolume failed: ' + String(e));
      return -1;
    }
  }

  // ===== TTS =====

  /**
   * TTS语音播报
   */
  async textToSpeech(accountId: string, deviceId: string, text: string): Promise<boolean> {
    const client = this.getClient(accountId);
    if (!client) {
      songloft.log.warn('[MinaService] textToSpeech: no client for account: ' + accountId);
      return false;
    }

    try {
      return await client.textToSpeech(deviceId, text);
    } catch (e) {
      songloft.log.error('[MinaService] textToSpeech failed: ' + String(e));
      return false;
    }
  }

  // ===== 设备状态管理 =====

  /**
   * 更新设备管理状态（是否被本插件管理）
   * 仅更新本地配置，不需要调用远程API
   */
  async updateManagedStatus(accountId: string, deviceId: string, managed: boolean): Promise<boolean> {
    if (!accountId || !deviceId) {
      songloft.log.warn('[MinaService] updateManagedStatus: accountId and deviceId cannot be empty');
      return false;
    }

    try {
      await this.accountManager.updateDeviceConfig(accountId, deviceId, { managed });
      return true;
    } catch (e) {
      songloft.log.error('[MinaService] updateManagedStatus failed: ' + String(e));
      return false;
    }
  }

  /**
   * 记录最后选中的设备
   * 更新 accountManager.setLastSelectedDevice 和 deviceConfig.last_selected_at
   */
  async updateLastSelection(accountId: string, deviceId: string): Promise<boolean> {
    if (!accountId || !deviceId) {
      songloft.log.warn('[MinaService] updateLastSelection: accountId and deviceId cannot be empty');
      return false;
    }

    try {
      await this.accountManager.setLastSelectedDevice(accountId, deviceId);
      await this.accountManager.updateDeviceConfig(accountId, deviceId, {
        last_selected_at: new Date().toISOString(),
      });
      return true;
    } catch (e) {
      songloft.log.error('[MinaService] updateLastSelection failed: ' + String(e));
      return false;
    }
  }

  /**
   * 获取设备播放状态
   * @returns 播放状态对象，失败返回 null
   */
  async getPlayerStatus(accountId: string, deviceId: string): Promise<any> {
    const client = this.getClient(accountId);
    if (!client) {
      songloft.log.warn('[MinaService] getPlayerStatus: no client for account: ' + accountId);
      return null;
    }

    try {
      return await client.getPlayerStatus(deviceId);
    } catch (e) {
      songloft.log.error('[MinaService] getPlayerStatus failed: ' + String(e));
      return null;
    }
  }

  // ===== 内部辅助方法 =====

  /**
   * 获取账号对应的 MinaHTTPClient
   * 账号未登录或客户端不存在时返回 null
   */
  private getClient(accountId: string): MinaHTTPClient | null {
    const client = this.accountManager.getMinaClient(accountId);
    if (!client) {
      return null;
    }
    return client as MinaHTTPClient;
  }

  /**
   * 获取设备硬件型号（先查缓存，缓存不存在则刷新设备列表）
   */
  private async getDeviceHardware(client: MinaHTTPClient, deviceId: string): Promise<string> {
    const cached = this.deviceModelCache.get(deviceId);
    if (cached) return cached;

    // 缓存中没有，刷新设备列表
    try {
      const devices = await client.getDeviceList();
      for (const dev of devices) {
        this.deviceModelCache.set(dev.deviceID, dev.hardware);
        if (dev.deviceID === deviceId) {
          return dev.hardware;
        }
      }
    } catch (e) {
      songloft.log.warn('[MinaService] Failed to refresh device list for hardware lookup: ' + String(e));
    }

    return '';
  }

  /**
   * 从本地配置构建 DeviceInfo 列表（不含在线状态）
   */
  private async buildDeviceInfoFromLocal(accountId: string): Promise<DeviceInfo[]> {
    const devices = await this.configManager.getDevices(accountId);
    return devices.map(dev => ({
      deviceID: dev.device_id,
      name: dev.device_name,
      model: dev.model,
      hardware: dev.hardware,
      alias: dev.alias,
      presence: 'offline', // 无法获取在线状态时默认 offline
      managed: dev.managed,
      volume: dev.volume,
      play_mode: dev.play_mode,
      playlist_id: dev.playlist_id,
      current_song_index: dev.current_song_index,
      last_selected_at: dev.last_selected_at,
    }));
  }

  /**
   * 合并API设备数据和本地配置构建 DeviceInfo 列表
   * presence 字段用于判断设备是否在线
   */
  private async buildDeviceInfoMerged(accountId: string, apiDevices: MinaDevice[]): Promise<DeviceInfo[]> {
    // 从已合并的本地配置中读取（updateDeviceList 已保存）
    const localDevices = await this.configManager.getDevices(accountId);
    const localMap = new Map<string, DeviceConfig>();
    for (const dev of localDevices) {
      localMap.set(dev.device_id, dev);
    }

    return apiDevices.map(apiDev => {
      const local = localMap.get(apiDev.deviceID);
      return {
        deviceID: apiDev.deviceID,
        name: apiDev.name,
        model: apiDev.model || '',
        hardware: apiDev.hardware || '',
        alias: apiDev.alias || '',
        presence: apiDev.presence || 'offline',
        managed: local?.managed ?? false,
        volume: local?.volume ?? 0,
        play_mode: local?.play_mode ?? 'order',
        playlist_id: local?.playlist_id ?? 0,
        current_song_index: local?.current_song_index ?? 0,
        last_selected_at: local?.last_selected_at ?? '',
      };
    });
  }
}
