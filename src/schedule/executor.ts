// MIoT 智能音箱插件 - 定时任务执行器
// 翻译自 Go 源码: plugins/songloft-plugin-xiaomi/schedule/executor.go
// 解析目标设备，执行 play_playlist/play_playlist_from/stop/set_volume/set_play_mode 动作

/// <reference types="@songloft/plugin-sdk" />

import { ConfigManager } from '../config/manager';
import { AccountManager } from '../account/manager';
import { MinaService } from '../service/service';
import { PlaylistManagerMap } from '../player/manager';
import { IndexingManager } from '../indexing/manager';
import { ConversationMonitor } from '../conversation/monitor';
import type { ScheduledTask, TaskLog, TaskTarget, TaskParams, PlayMode } from '../types';

/** 解析后的单个目标设备 */
interface DeviceTarget {
  accountId: string;
  deviceId: string;
  deviceName: string;
}

/**
 * TaskExecutor - 定时任务执行器
 * 负责解析目标设备、执行具体动作，返回执行日志
 */
export class TaskExecutor {
  private configManager: ConfigManager;
  private accountManager: AccountManager;
  private minaService: MinaService;
  private playlistManagerMap: PlaylistManagerMap;
  private indexingManager: IndexingManager;
  private conversationMonitor: ConversationMonitor;

  constructor(
    configManager: ConfigManager,
    accountManager: AccountManager,
    minaService: MinaService,
    playlistManagerMap: PlaylistManagerMap,
    indexingManager: IndexingManager,
    conversationMonitor: ConversationMonitor,
  ) {
    this.configManager = configManager;
    this.accountManager = accountManager;
    this.minaService = minaService;
    this.playlistManagerMap = playlistManagerMap;
    this.indexingManager = indexingManager;
    this.conversationMonitor = conversationMonitor;
  }

  /**
   * 执行定时任务，返回每个设备的执行日志
   */
  async execute(task: ScheduledTask): Promise<TaskLog[]> {
    if (task.action === 'enable_monitor' || task.action === 'disable_monitor') {
      return [await this.executeGlobalAction(task)];
    }

    const targets = await this.resolveTargetDevices(task.target);
    if (targets.length === 0) {
      songloft.log.warn(`[TaskExecutor] 定时任务无目标设备 task_id=${task.id} name=${task.name}`);
      return [{
        task_id: task.id,
        task_name: task.name,
        action: task.action,
        success: false,
        message: '无可用的目标设备',
        executed_at: new Date().toISOString(),
      }];
    }

    const logs: TaskLog[] = [];
    for (const target of targets) {
      const log = await this.executeOnDevice(task, target);
      logs.push(log);
    }
    return logs;
  }

  /**
   * 解析目标设备列表
   * - all_managed = true: 获取所有账号下的 managed 设备
   * - 否则使用 devices 列表中的 device_id，遍历所有账号查找对应关系
   */
  private async resolveTargetDevices(target: TaskTarget): Promise<DeviceTarget[]> {
    if (target.all_managed) {
      return this.getAllManagedDevices();
    }

    if (!target.devices || target.devices.length === 0) {
      return [];
    }

    // devices 是 [{account_id, device_id}] 对象数组
    const results: DeviceTarget[] = [];
    const accounts = await this.configManager.getAccounts();

    for (const dev of target.devices) {
      const { device_id: deviceId, account_id: accountId } = dev;
      if (!deviceId) {
        continue;
      }

      let found = false;

      if (accountId) {
        // 有 account_id，直接在指定账号下查找设备
        const account = accounts.find(a => a.id === accountId);
        if (account) {
          const device = account.devices.find(d => d.device_id === deviceId);
          if (device) {
            results.push({
              accountId: account.id,
              deviceId: device.device_id,
              deviceName: device.device_name || device.device_id,
            });
            found = true;
          }
        }
      }

      if (!found) {
        // account_id 未指定或未找到，遍历所有账号查找
        for (const account of accounts) {
          const device = account.devices.find(d => d.device_id === deviceId);
          if (device) {
            results.push({
              accountId: account.id,
              deviceId: device.device_id,
              deviceName: device.device_name || device.device_id,
            });
            found = true;
            break;
          }
        }
      }

      if (!found) {
        songloft.log.warn(`[TaskExecutor] 未找到设备 device_id=${deviceId}`);
      }
    }

    return results;
  }

  /**
   * 获取所有账号下的受管理设备（跨账号）
   */
  private async getAllManagedDevices(): Promise<DeviceTarget[]> {
    const results: DeviceTarget[] = [];
    const accounts = await this.configManager.getAccounts();

    for (const account of accounts) {
      for (const device of account.devices) {
        if (device.managed) {
          results.push({
            accountId: account.id,
            deviceId: device.device_id,
            deviceName: device.device_name || device.device_id,
          });
        }
      }
    }
    return results;
  }

  /**
   * 执行全局动作（不绑定设备）
   */
  private async executeGlobalAction(task: ScheduledTask): Promise<TaskLog> {
    const log: TaskLog = {
      task_id: task.id,
      task_name: task.name,
      action: task.action,
      success: false,
      message: '',
      executed_at: new Date().toISOString(),
    };

    try {
      const config = await this.configManager.getConfig();
      const enable = task.action === 'enable_monitor';

      config.conversation_monitor_enabled = enable;
      await this.configManager.saveConfig(config);

      if (enable) {
        this.conversationMonitor.stop();
        await this.conversationMonitor.start();
      } else {
        this.conversationMonitor.stop();
      }

      log.success = true;
      log.message = enable ? '对话监听已开启' : '对话监听已关闭';
      songloft.log.info(`[TaskExecutor] ${log.message} task_id=${task.id}`);
    } catch (e) {
      log.message = e instanceof Error ? e.message : String(e);
      songloft.log.error(`[TaskExecutor] 全局动作执行失败 task_id=${task.id} error=${log.message}`);
    }

    return log;
  }

  /**
   * 在单个设备上执行任务
   */
  private async executeOnDevice(task: ScheduledTask, target: DeviceTarget): Promise<TaskLog> {
    const log: TaskLog = {
      task_id: task.id,
      task_name: task.name,
      action: task.action,
      success: false,
      message: '',
      executed_at: new Date().toISOString(),
    };

    songloft.log.info(
      `[TaskExecutor] 执行定时任务 task_id=${task.id} action=${task.action} account=${target.accountId} device=${target.deviceId}`
    );

    try {
      let message: string;

      switch (task.action) {
        case 'play_playlist':
          message = await this.executePlayPlaylist(target, task.params, false);
          break;
        case 'play_playlist_from':
          message = await this.executePlayPlaylist(target, task.params, true);
          break;
        case 'stop':
          message = await this.executeStop(target);
          break;
        case 'set_volume':
          message = await this.executeSetVolume(target, task.params);
          break;
        case 'set_play_mode':
          message = await this.executeSetPlayMode(target, task.params);
          break;
        default:
          throw new Error(`未知的动作类型: ${task.action}`);
      }

      log.success = true;
      log.message = message;
      songloft.log.info(`[TaskExecutor] 定时任务执行成功 task_id=${task.id} device=${target.deviceId}`);
    } catch (e) {
      log.success = false;
      log.message = e instanceof Error ? e.message : String(e);
      songloft.log.error(
        `[TaskExecutor] 定时任务执行失败 task_id=${task.id} device=${target.deviceId} error=${log.message}`
      );
    }

    return log;
  }

  /**
   * 执行播放歌单动作
   * 通过歌单名称查找歌单，然后调用 PlaylistManager 播放
   * @param withSong - 是否从指定歌曲开始播放（play_playlist_from）
   */
  private async executePlayPlaylist(target: DeviceTarget, params: TaskParams, withSong: boolean): Promise<string> {
    const playlistName = params.playlist_name;
    if (!playlistName) {
      throw new Error('未指定歌单名称');
    }

    if (!this.indexingManager.isIndexReady()) {
      throw new Error('歌曲索引尚未就绪，请确保已刷新索引');
    }

    // 通过名称查找歌单
    const playlist = this.indexingManager.findPlaylistByName(playlistName);
    if (!playlist) {
      throw new Error(`未找到匹配的歌单: ${playlistName}`);
    }

    songloft.log.info(`[TaskExecutor] 匹配到歌单 name=${playlistName} matched=${playlist.name} id=${playlist.id}`);

    // 确定起始位置
    let startIndex = 0;
    if (withSong && params.song_name) {
      const result = await this.indexingManager.findSongInPlaylist(playlist.id, params.song_name);
      if (result.found) {
        startIndex = result.index;
        songloft.log.info(`[TaskExecutor] 匹配到歌曲 song_name=${params.song_name} index=${startIndex}`);
      } else {
        songloft.log.warn(`[TaskExecutor] 未找到匹配的歌曲，从第一首开始 song_name=${params.song_name}`);
      }
    }

    // 确定播放模式
    const playMode: PlayMode = (params.play_mode as PlayMode) || 'order';

    // 获取或创建设备的播放管理器并开始播放
    const pm = await this.playlistManagerMap.getOrCreate(target.accountId, target.deviceId);
    const ok = await pm.play(playlist.id, startIndex, playMode);
    if (!ok) {
      // 歌单 ID 已失效（扫描后 auto-create 歌单 ID 变化）：刷新索引后重试一次
      if (pm.isLastPlayNotFound()) {
        songloft.log.warn(`[TaskExecutor] 歌单 ID ${playlist.id} 已失效，刷新索引后重试`);
        await this.indexingManager.refresh();
        // 用已匹配到的规范歌单名精确重查（比原始参数更稳，能命中改了 ID 的同名歌单）
        const newPlaylist = this.indexingManager.findPlaylistByName(playlist.name);
        if (!newPlaylist) {
          throw new Error(`刷新索引后仍未找到歌单: ${playlistName}`);
        }
        let retryIndex = 0;
        if (withSong && params.song_name) {
          const result = await this.indexingManager.findSongInPlaylist(newPlaylist.id, params.song_name);
          if (result.found) {
            retryIndex = result.index;
          }
        }
        const retryOk = await pm.play(newPlaylist.id, retryIndex, playMode);
        if (!retryOk) {
          throw new Error(`播放歌单失败(重试后): ${newPlaylist.name}`);
        }
        if (withSong && params.song_name) {
          return `播放歌单「${newPlaylist.name}」（从「${params.song_name}」开始）成功`;
        }
        return `播放歌单「${newPlaylist.name}」成功`;
      }
      throw new Error(`播放歌单失败: ${playlist.name}`);
    }

    if (withSong && params.song_name) {
      return `播放歌单「${playlist.name}」（从「${params.song_name}」开始）成功`;
    }
    return `播放歌单「${playlist.name}」成功`;
  }

  /**
   * 执行停止播放动作
   */
  private async executeStop(target: DeviceTarget): Promise<string> {
    const pm = await this.playlistManagerMap.getOrCreate(target.accountId, target.deviceId);
    await pm.stop();
    return '停止播放成功';
  }

  /**
   * 执行设置音量动作
   */
  private async executeSetVolume(target: DeviceTarget, params: TaskParams): Promise<string> {
    const volume = params.volume;
    if (volume === undefined || volume === null) {
      throw new Error('未指定音量值');
    }
    if (volume < 0 || volume > 100) {
      throw new Error(`音量值超出范围: ${volume}`);
    }

    const ok = await this.minaService.setVolume(target.accountId, target.deviceId, volume);
    if (!ok) {
      throw new Error('设置音量失败');
    }

    return `设置音量为 ${volume} 成功`;
  }

  /**
   * 执行设置播放模式动作
   */
  private async executeSetPlayMode(target: DeviceTarget, params: TaskParams): Promise<string> {
    const playMode = params.play_mode;
    if (!playMode) {
      throw new Error('未指定播放模式');
    }

    // 优先通过现有播放管理器设置
    const pm = this.playlistManagerMap.get(target.accountId, target.deviceId);
    if (pm) {
      await pm.setPlayMode(playMode as PlayMode);
    } else {
      // 播放管理器不存在时，直接更新配置
      try {
        await this.configManager.updateDevice(target.accountId, target.deviceId, {
          play_mode: playMode,
        });
      } catch (e) {
        throw new Error(`更新播放模式配置失败: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    return `设置播放模式为 ${playMode} 成功`;
  }
}
