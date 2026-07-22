// 智能音箱插件 - 设备分组协调器
//
// 分组的「同一套播放列表」由 PlaylistManagerMap 实现：一个分组共用一个 PlaylistManager，
// 其播放/暂停/停止/切歌/自动续播会一次性下发给组内所有音箱，故这些操作无需在此额外 fan-out。
//
// 本协调器只负责「不经 PlaylistManager 的设备级操作」的分组同步：
//   - 音量（/mina/volume、语音调音量、定时任务音量）
//   - 临时单曲 URL 播放（/mina/play-url、语音在线搜索的直链推送）
// 以及给定时任务提供「同组成员去重」的查询（避免同组设备被重复下发）。

/// <reference types="@songloft/plugin-sdk" />

import { PlaylistManagerMap } from '../player/manager';
import { MinaService } from '../service/service';
import { ConfigManager } from '../config/manager';
import type { DeviceTargetRef } from '../types';
import type { PlayMetadata } from '../mina/client';

export class GroupCoordinator {
  private playlistManagerMap: PlaylistManagerMap;
  private minaService: MinaService;
  private configManager: ConfigManager;

  constructor(
    playlistManagerMap: PlaylistManagerMap,
    minaService: MinaService,
    configManager: ConfigManager,
  ) {
    this.playlistManagerMap = playlistManagerMap;
    this.minaService = minaService;
    this.configManager = configManager;
  }

  /**
   * 解析组内除被操作设备外的其他成员（followers）。
   * 无组或组内仅该设备时返回空数组，fanOut* 随即成为空操作。
   */
  private async resolveFollowers(accountId: string, deviceId: string): Promise<DeviceTargetRef[]> {
    const group = await this.configManager.findDeviceGroup(accountId, deviceId);
    if (!group) return [];
    return group.members.filter(m => !(m.account_id === accountId && m.device_id === deviceId));
  }

  /**
   * 公开：返回该设备所在组的其他成员（followers），供调用方去重
   * （如定时任务批量目标：避免同组设备被重复下发）。无组时返回空数组。
   */
  async getGroupPeers(accountId: string, deviceId: string): Promise<DeviceTargetRef[]> {
    return this.resolveFollowers(accountId, deviceId);
  }

  /**
   * 对每个 follower 执行 fn，单独 try/catch：某个成员离线/失败仅告警并继续，
   * 绝不让它拖垮主控设备的请求。并发下发（底层已按 deviceId 串行排队）。
   */
  private async forEachFollower(
    accountId: string,
    deviceId: string,
    label: string,
    fn: (m: DeviceTargetRef) => Promise<void>,
  ): Promise<void> {
    const followers = await this.resolveFollowers(accountId, deviceId);
    if (followers.length === 0) return;
    await Promise.all(followers.map(async (m) => {
      try {
        await fn(m);
      } catch (e) {
        songloft.log.warn(`[GroupCoordinator] fanOut ${label} failed for ${m.account_id}:${m.device_id}: ${String(e)}`);
      }
    }));
  }

  /** 设置组内其他成员的音量（音量是设备级属性，不经 PlaylistManager，需在此 fan-out）。 */
  async fanOutSetVolume(accountId: string, deviceId: string, volume: number): Promise<void> {
    await this.forEachFollower(accountId, deviceId, 'setVolume', async (m) => {
      await this.minaService.setVolume(m.account_id, m.device_id, volume);
    });
  }

  /**
   * 让组内其他成员播放同一个 URL（用于 /mina/play-url、语音在线搜索直链推送这类
   * 不经歌单队列的临时单曲播放，无共享 manager 队列可依赖，直接镜像 URL 到各成员）。
   */
  async fanOutPlayURL(
    accountId: string,
    deviceId: string,
    url: string,
    song?: string | PlayMetadata,
  ): Promise<void> {
    await this.forEachFollower(accountId, deviceId, 'playURL', async (m) => {
      await this.minaService.playURL(m.account_id, m.device_id, url, song);
    });
  }
}
