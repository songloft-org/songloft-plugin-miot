// MIoT 智能音箱插件 - 定时任务执行器
// 翻译自 Go 源码: plugins/songloft-plugin-xiaomi/schedule/executor.go
// 解析目标设备，执行 play_playlist/play_playlist_from/stop/set_volume/set_play_mode 动作

/// <reference types="@songloft/plugin-sdk" />

import { ConfigManager } from '../config/manager';
import { AccountManager } from '../account/manager';
import { MinaService } from '../service/service';
import { PlaylistManagerMap, parsePlayMode, resolvePlaylistResumeStart } from '../player/manager';
import { IndexingManager } from '../indexing/manager';
import type { IndexedPlaylist } from '../indexing/manager';
import { ConversationMonitor } from '../conversation/monitor';
import { GroupCoordinator } from '../group/coordinator';
import type { VoiceEngine } from '../voicecmd/engine';
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
  private groupCoordinator?: GroupCoordinator;
  // VoiceEngine 持有跨调用生命周期的 SleepTimer 注册表；定时播放的「播放时长限制」
  // 复用它挂表，语音"取消定时"/"还剩多久停"能直接接管，无需另建一套。
  private voiceEngine?: VoiceEngine;

  constructor(
    configManager: ConfigManager,
    accountManager: AccountManager,
    minaService: MinaService,
    playlistManagerMap: PlaylistManagerMap,
    indexingManager: IndexingManager,
    conversationMonitor: ConversationMonitor,
    groupCoordinator?: GroupCoordinator,
    voiceEngine?: VoiceEngine,
  ) {
    this.configManager = configManager;
    this.accountManager = accountManager;
    this.minaService = minaService;
    this.playlistManagerMap = playlistManagerMap;
    this.indexingManager = indexingManager;
    this.conversationMonitor = conversationMonitor;
    this.groupCoordinator = groupCoordinator;
    this.voiceEngine = voiceEngine;
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
    // 去重：若多个目标设备同属一个组，处理首个目标时 GroupCoordinator 已 fan-out 给
    // 组内其他成员，后续再把这些成员作为独立目标处理会重复下发，故跳过已被带动的设备。
    const covered = new Set<string>();
    for (const target of targets) {
      const key = target.accountId + ':' + target.deviceId;
      if (covered.has(key)) {
        songloft.log.info(`[TaskExecutor] 跳过已被同组带动的目标设备 device=${target.deviceId}`);
        continue;
      }
      const log = await this.executeOnDevice(task, target);
      logs.push(log);
      covered.add(key);
      // 仅当本设备执行成功（fan-out 确实发生过）才把同组其他成员标记为已覆盖；
      // 若本设备失败（离线/出错），fan-out 未执行，组内其他成员仍需作为独立目标各自尝试，
      // 否则会因误标记 covered 而被跳过，导致整组静默。
      if (log.success && this.groupCoordinator) {
        try {
          const peers = await this.groupCoordinator.getGroupPeers(target.accountId, target.deviceId);
          for (const p of peers) covered.add(p.account_id + ':' + p.device_id);
        } catch (e) {
          songloft.log.warn(`[TaskExecutor] 读取分组成员失败 device=${target.deviceId}: ${String(e)}`);
        }
      }
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
   *
   * 起始位置（play_playlist，由 params.start_position 决定）：
   * - first  : 从第一首开始（默认，兼容旧任务）
   * - resume : 沿用设备持久化的 current_song_index（仅当上次播的就是同一歌单）
   * - random : 每次执行随机挑一首作为起点
   * 播放模式：params.play_mode 指定则用它；为空时由播放器按目标歌单的记录和标签决定。
   */
  private async executePlayPlaylist(target: DeviceTarget, params: TaskParams, withSong: boolean): Promise<string> {
    if (!params.playlist_name && !params.playlist_id) {
      throw new Error('未指定歌单名称');
    }

    if (!this.indexingManager.isIndexReady()) {
      throw new Error('歌曲索引尚未就绪，请确保已刷新索引');
    }

    // 通过名称或 ID 查找歌单（前端选择器产出 playlist_id，语音口令产出 playlist_name）。
    // miss 时按需刷新索引，捡回运行期间新建/变更的歌单（#83, #84）。
    let playlist: IndexedPlaylist | null = null;
    if (params.playlist_name) {
      playlist = await this.indexingManager.findPlaylistByNameWithRefresh(params.playlist_name);
    } else {
      playlist = await this.indexingManager.getPlaylistByIdWithRefresh(params.playlist_id!);
    }
    if (!playlist) {
      throw new Error(`未找到匹配的歌单: ${params.playlist_name || params.playlist_id}`);
    }

    songloft.log.info(`[TaskExecutor] 匹配到歌单 name=${params.playlist_name || ''} id=${playlist.id} matched=${playlist.name}`);

    const playMode = parsePlayMode(params.play_mode);

    // 计算给定歌单 ID 下的起始位置（歌单 ID 失效重试时会用新 ID 再算一次）
    // songId：有明确目标歌曲时返回其 ID，供 playPlaylistFromSong 按 ID 精确定位（#420）。
    const resolveStart = async (pid: number): Promise<{ startIndex: number; randomStart: boolean; songId?: number }> => {
      if (withSong) {
        // play_playlist_from：按 song_name 或 song_id 定位起始歌曲
        if (params.song_name) {
          const result = await this.indexingManager.findSongInPlaylist(pid, params.song_name);
          if (result.found) {
            songloft.log.info(`[TaskExecutor] 匹配到歌曲 song_name=${params.song_name} index=${result.index} songId=${result.songId}`);
            return { startIndex: result.index, randomStart: false, songId: result.songId };
          }
          songloft.log.warn(`[TaskExecutor] 未找到匹配的歌曲，从第一首开始 song_name=${params.song_name}`);
        } else if (params.song_id) {
          const result = await this.indexingManager.findSongIndexInPlaylistById(pid, params.song_id);
          if (result.found) {
            songloft.log.info(`[TaskExecutor] 匹配到歌曲 song_id=${params.song_id} index=${result.index}`);
          } else {
            songloft.log.warn(`[TaskExecutor] 未找到匹配的歌曲，从第一首开始 song_id=${params.song_id}`);
          }
          return { startIndex: result.found ? result.index : 0, randomStart: false, songId: params.song_id };
        }
        return { startIndex: 0, randomStart: false };
      }

      switch (params.start_position) {
        case 'random':
          return { startIndex: 0, randomStart: true };
        case 'resume': {
          // 查「每设备 × 每歌单」的进度表：中途切去别的歌单也不影响这个歌单自己的进度。
          // 拿到 songId 就交给 playPlaylistFromSong 按 ID 定位，歌单增删歌后不会串歌。
          const resume = await resolvePlaylistResumeStart(this.configManager, pm.getPrimary(), pid);
          if (resume) {
            songloft.log.info(`[TaskExecutor] 从上次进度继续 playlistId=${pid} songId=${resume.songId} index=${resume.songIndex}`);
            return {
              startIndex: resume.songIndex,
              randomStart: false,
              songId: resume.songId > 0 ? resume.songId : undefined,
            };
          }
          songloft.log.info(`[TaskExecutor] 无可续播进度（首次播放该歌单），从第一首开始 playlistId=${pid}`);
          return { startIndex: 0, randomStart: false };
        }
        default:
          return { startIndex: 0, randomStart: false };
      }
    };

    // 描述起始位置（用于返回给日志/前端的友好文案）
    const describeStart = (start: { startIndex: number; randomStart: boolean; songId?: number }): string => {
      if (withSong && (params.song_name || params.song_id)) return `（从「${params.song_name || '#' + params.song_id}」开始）`;
      if (start.randomStart) return '（随机起始）';
      // songId 也要看：上次正好停在第一首时 startIndex 为 0，但确实是续播
      if (params.start_position === 'resume' && (start.startIndex > 0 || (start.songId ?? 0) > 0)) return '（从上次进度继续）';
      return '';
    };

    // 描述附加选项（预设音量 / 播放时长）；仅在实际生效时展示
    const describeExtras = (p: TaskParams, timerActive: boolean): string => {
      const parts: string[] = [];
      if (typeof p.volume === 'number' && p.volume >= 0 && p.volume <= 100) {
        parts.push(`音量 ${p.volume}`);
      }
      if (timerActive && typeof p.stop_after_minutes === 'number') {
        parts.push(`${p.stop_after_minutes} 分钟后停`);
      }
      return parts.length > 0 ? `（${parts.join('，')}）` : '';
    };

    // 获取或创建设备的播放管理器并开始播放
    const pm = await this.playlistManagerMap.getOrCreate(target.accountId, target.deviceId);

    // 播放前预设音量（可选）：先落目标设备，再 fan-out 分组成员；失败仅告警不阻断，
    // 用户更在意「歌先响起来」，音量兜底会有下次调整
    await this.applyPresetVolume(target, params);

    const start = await resolveStart(playlist.id);
    // 有明确目标歌曲时按 songId 定位：缓存 index 可能因歌单增删歌曲而错位（#420）
    const ok = start.songId
      ? await pm.playPlaylistFromSong(playlist.id, start.songId, playMode, start.startIndex)
      : await pm.play(playlist.id, start.startIndex, playMode, { randomStart: start.randomStart });
    if (!ok) {
      // 歌单 ID 已失效（扫描后 auto-create 歌单 ID 变化）：刷新索引后重试一次
      if (pm.isLastPlayNotFound()) {
        songloft.log.warn(`[TaskExecutor] 歌单 ID ${playlist.id} 已失效，刷新索引后重试`);
        await this.indexingManager.refresh();
        // 用已匹配到的规范歌单名精确重查（比原始参数更稳，能命中改了 ID 的同名歌单）
        const newPlaylist = this.indexingManager.findPlaylistByName(playlist.name);
        if (!newPlaylist) {
          throw new Error(`刷新索引后仍未找到歌单: ${playlist.name}`);
        }
        const retryStart = await resolveStart(newPlaylist.id);
        const retryOk = retryStart.songId
          ? await pm.playPlaylistFromSong(newPlaylist.id, retryStart.songId, playMode, retryStart.startIndex)
          : await pm.play(newPlaylist.id, retryStart.startIndex, playMode, { randomStart: retryStart.randomStart });
        if (!retryOk) {
          throw new Error(`播放歌单失败(重试后): ${newPlaylist.name}`);
        }
        const retryExtras = await this.applyStopTimer(target, params);
        return `播放歌单「${newPlaylist.name}」${describeStart(retryStart)}${describeExtras(params, retryExtras)}成功`;
      }
      throw new Error(`播放歌单失败: ${playlist.name}`);
    }

    const extras = await this.applyStopTimer(target, params);
    return `播放歌单「${playlist.name}」${describeStart(start)}${describeExtras(params, extras)}成功`;
  }

  /**
   * 播放前预设目标设备音量（可选）：仅在 params.volume 有值且合法时执行；
   * fan-out 到分组成员，失败仅告警不阻断播放。
   */
  private async applyPresetVolume(target: DeviceTarget, params: TaskParams): Promise<void> {
    const v = params.volume;
    if (v === undefined || v === null) return;
    if (typeof v !== 'number' || v < 0 || v > 100) {
      songloft.log.warn(`[TaskExecutor] 预设音量越界忽略 device=${target.deviceId} volume=${v}`);
      return;
    }
    try {
      const ok = await this.minaService.setVolume(target.accountId, target.deviceId, v);
      if (!ok) {
        songloft.log.warn(`[TaskExecutor] 预设音量失败 device=${target.deviceId} volume=${v}`);
        return;
      }
      await this.groupCoordinator?.fanOutSetVolume(target.accountId, target.deviceId, v);
      songloft.log.info(`[TaskExecutor] 已预设播放音量 device=${target.deviceId} volume=${v}`);
    } catch (e) {
      songloft.log.warn(`[TaskExecutor] 预设音量异常 device=${target.deviceId}: ${String(e)}`);
    }
  }

  /**
   * 播放成功后挂 SleepTimer（可选）：复用 VoiceEngine 的注册表，语音「取消定时」/
   * 「还剩多久停」可直接接管；分组场景下 SleepTimer 到期由 pm.stop() 走 fan-out 覆盖组员，
   * 因此只需给「本次目标设备」挂一次表。
   * 返回是否成功挂表，供文案渲染判断。
   */
  private async applyStopTimer(target: DeviceTarget, params: TaskParams): Promise<boolean> {
    const m = params.stop_after_minutes;
    if (m === undefined || m === null) return false;
    if (!Number.isInteger(m) || m < 1 || m > 999) {
      songloft.log.warn(`[TaskExecutor] 播放时长越界忽略 device=${target.deviceId} minutes=${m}`);
      return false;
    }
    if (!this.voiceEngine) {
      songloft.log.warn(`[TaskExecutor] 未注入 VoiceEngine，无法挂播放时长 device=${target.deviceId}`);
      return false;
    }
    try {
      this.voiceEngine.setSleepTimer(target.accountId, target.deviceId, 'time', m);
      songloft.log.info(`[TaskExecutor] 已挂播放时长 device=${target.deviceId} minutes=${m}`);
      return true;
    } catch (e) {
      songloft.log.warn(`[TaskExecutor] 挂播放时长失败 device=${target.deviceId}: ${String(e)}`);
      return false;
    }
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

    await this.groupCoordinator?.fanOutSetVolume(target.accountId, target.deviceId, volume);
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

    // 用 getOrCreate 解析到（分组则为共享）manager，保证分组下模式落到共享 manager 及其主设备配置。
    const pm = await this.playlistManagerMap.getOrCreate(target.accountId, target.deviceId);
    await pm.setPlayMode(playMode as PlayMode);

    return `设置播放模式为 ${playMode} 成功`;
  }
}
