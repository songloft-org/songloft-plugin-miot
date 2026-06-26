// MIoT 智能音箱插件 - 设备控制 Handler
// 翻译自 Go 源码: plugins/songloft-plugin-xiaomi/handlers/device_handler.go

import { jsonResponse, parseQuery } from '@songloft/plugin-sdk';
import type { Router, HTTPRequest } from '@songloft/plugin-sdk';
import { MinaService } from '../service/service';
import { AccountManager } from '../account/manager';
import { updateDeviceStatusCache, getDeviceStatusCache, DEVICE_STATUS_TTL } from './playlist';

/** 解析请求体（兼容 Uint8Array 和 string） */
function parseBody(req: HTTPRequest): any {
  if (!req.body) return {};
  try {
    const str = typeof req.body === 'string'
      ? req.body
      : String.fromCharCode.apply(null, Array.from(req.body as Uint8Array));
    return JSON.parse(str);
  } catch {
    return {};
  }
}

/**
 * 注册设备控制相关路由
 * GET  /mina/devices         → 获取设备列表
 * POST /mina/volume          → 设置音量
 * POST /mina/play-url        → 播放URL
 * POST /mina/pause           → 暂停播放
 * POST /mina/resume          → 恢复播放
 * POST /mina/device/managed  → 更新管理状态
 * POST /mina/last_selection  → 记录最后选中设备
 */
export function registerDeviceHandlers(
  router: Router,
  minaService: MinaService,
  accountManager: AccountManager,
): void {

  // GET /mina/devices - 获取设备列表（按账号分组）
  router.get('/mina/devices', async (req: HTTPRequest) => {
    try {
      const query = parseQuery(req.query);
      const accountId = query.account_id;

      if (accountId) {
        const devices = await minaService.getDevices(accountId);
        return jsonResponse({ success: true, data: [{ account_id: accountId, devices }] });
      }

      // 所有账号的设备
      const accounts = await accountManager.getAccounts();
      if (!accounts || accounts.length === 0) {
        // 未配置账号时返回空数组，不报错
        return jsonResponse({ success: true, data: [] });
      }

      const result = [];
      for (const acc of accounts) {
        result.push({
          account_id: acc.id,
          account_name: acc.account,
          devices: await minaService.getDevices(acc.id),
          last_selected_device_id: (await accountManager.getLastSelectedDevice(acc.id)) || '',
        });
      }
      return jsonResponse({ success: true, data: result });
    } catch (e: any) {
      return jsonResponse({ success: false, error: e.message || String(e) });
    }
  });

  // POST /mina/volume - 设置音量
  router.post('/mina/volume', async (req: HTTPRequest) => {
    try {
      const body = parseBody(req);
      const { account_id, device_id, volume } = body;
      if (!account_id) {
        return jsonResponse({ success: false, error: 'account_id is required' });
      }
      if (!device_id) {
        return jsonResponse({ success: false, error: 'device_id is required' });
      }
      if (volume === undefined || volume === null) {
        return jsonResponse({ success: false, error: 'volume is required' });
      }
      const vol = Number(volume);
      const ok = await minaService.setVolume(account_id, device_id, vol);
      if (!ok) {
        return jsonResponse({ success: false, error: 'failed to set volume' });
      }
      updateDeviceStatusCache(account_id, device_id, { volume: vol, lockVolume: true });
      return jsonResponse({ success: true, data: { message: 'success' } });
    } catch (e: any) {
      return jsonResponse({ success: false, error: e.message || String(e) });
    }
  });

  // POST /mina/play-url - 播放URL
  router.post('/mina/play-url', async (req: HTTPRequest) => {
    try {
      const body = parseBody(req);
      const { account_id, device_id, url } = body;
      if (!account_id) {
        return jsonResponse({ success: false, error: 'account_id is required' });
      }
      if (!device_id || !url) {
        return jsonResponse({ success: false, error: 'device_id and url are required' });
      }
      const ok = await minaService.playURL(account_id, device_id, url);
      if (!ok) {
        return jsonResponse({ success: false, error: 'failed to play url' });
      }
      return jsonResponse({ success: true, data: { message: 'playing url' } });
    } catch (e: any) {
      return jsonResponse({ success: false, error: e.message || String(e) });
    }
  });

  // POST /mina/pause - 暂停播放
  router.post('/mina/pause', async (req: HTTPRequest) => {
    try {
      const body = parseBody(req);
      const { account_id, device_id } = body;
      if (!account_id) {
        return jsonResponse({ success: false, error: 'account_id is required' });
      }
      if (!device_id) {
        return jsonResponse({ success: false, error: 'device_id is required' });
      }
      const ok = await minaService.pausePlay(account_id, device_id);
      if (!ok) {
        return jsonResponse({ success: false, error: 'failed to pause' });
      }
      updateDeviceStatusCache(account_id, device_id, { state: 'paused' });
      return jsonResponse({ success: true, data: { message: 'paused' } });
    } catch (e: any) {
      return jsonResponse({ success: false, error: e.message || String(e) });
    }
  });

  // POST /mina/resume - 恢复播放
  router.post('/mina/resume', async (req: HTTPRequest) => {
    try {
      const body = parseBody(req);
      const { account_id, device_id } = body;
      if (!account_id) {
        return jsonResponse({ success: false, error: 'account_id is required' });
      }
      if (!device_id) {
        return jsonResponse({ success: false, error: 'device_id is required' });
      }
      const ok = await minaService.resumePlay(account_id, device_id);
      if (!ok) {
        return jsonResponse({ success: false, error: 'failed to resume' });
      }
      updateDeviceStatusCache(account_id, device_id, { state: 'playing' });
      return jsonResponse({ success: true, data: { message: 'resumed' } });
    } catch (e: any) {
      return jsonResponse({ success: false, error: e.message || String(e) });
    }
  });

  // POST /mina/device/managed - 更新设备管理状态
  router.post('/mina/device/managed', async (req: HTTPRequest) => {
    try {
      const body = parseBody(req);
      const { account_id, device_id, managed } = body;
      if (!account_id) {
        return jsonResponse({ success: false, error: 'account_id is required' });
      }
      if (!device_id) {
        return jsonResponse({ success: false, error: 'device_id is required' });
      }
      const ok = await minaService.updateManagedStatus(account_id, device_id, !!managed);
      if (!ok) {
        return jsonResponse({ success: false, error: 'failed to update managed status' });
      }
      return jsonResponse({
        success: true,
        data: { message: 'device managed status updated', account_id, device_id, managed: !!managed },
      });
    } catch (e: any) {
      return jsonResponse({ success: false, error: e.message || String(e) });
    }
  });

  // POST /mina/last_selection - 记录最后选中设备
  router.post('/mina/last_selection', async (req: HTTPRequest) => {
    try {
      const body = parseBody(req);
      const { account_id, device_id } = body;
      if (!account_id) {
        return jsonResponse({ success: false, error: 'account_id is required' });
      }
      if (!device_id) {
        return jsonResponse({ success: false, error: 'device_id is required' });
      }
      const ok = await minaService.updateLastSelection(account_id, device_id);
      if (!ok) {
        return jsonResponse({ success: false, error: 'failed to update last selection' });
      }
      return jsonResponse({ success: true, data: { message: 'last selection updated', account_id, device_id } });
    } catch (e: any) {
      return jsonResponse({ success: false, error: e.message || String(e) });
    }
  });

  // =====================================================================================
  // GET /mina/status - 纯物理状态探针（与 /mina/play-url, /mina/pause 等物理层接口对称）
  // =====================================================================================
  // 用途：第三方插件（如洛雪投送插件）通过此接口获取音箱的绝对物理状态。
  //       与 /player/status 的本质区别：
  //       - 不读取 PlaylistManager（不混入本地歌单的幽灵数据）
  //       - 不执行状态掩盖（不因本地 stopped 而屏蔽真实 playing）
  //       - 不产生副作用（不触发定时器重置、语音挂起判断等）
  //
  // 返回字段：
  //   state      - 播放状态："playing" | "paused" | "stopped" | "unknown"
  //   position   - 当前播放进度（秒），缓存命中时会基于时间戳做平滑预估
  //   volume     - 当前音量（0-100），用户通过 /mina/volume 设置后有 10 秒锁定期保护
  //   is_playing - 便捷布尔值，等价于 state === "playing"
  //
  // 注：不返回 duration，因为硬件上报的 duration 极度不可靠，客户端应自行解析音频源元数据。
  // 限流：共享宿主的 4 秒物理缓存（DEVICE_STATUS_TTL），防止刷爆小米云端 API。
  // =====================================================================================
  router.get('/mina/status', async (req: HTTPRequest) => {
    try {
      const query = parseQuery(req.query);
      const { account_id, device_id } = query;
      
      if (!account_id || !device_id) {
        return jsonResponse({ success: false, error: 'account_id and device_id are required' });
      }

      // 检查 4 秒物理缓存，防止高频轮询刷爆小米云端 API
      const cached = getDeviceStatusCache(account_id, device_id);
      const now = Date.now();
      
      if (cached && (now - cached.timestamp) < DEVICE_STATUS_TTL) {
        // 命中缓存，直接返回缓存数据
        let position = cached.position;
        if (cached.state === 'playing') {
          // 基于时间戳做平滑预估，让客户端进度条更顺滑
          const elapsed = (now - cached.timestamp) / 1000;
          position = cached.position + elapsed;
        }

        // 音量锁定期保护：用户通过 /mina/volume 设置新音量后 10 秒内，
        // 云端可能还没同步，此时应返回缓存中的用户设定值，避免"回弹"
        const volume = (cached.volumeLockedUntil && now < cached.volumeLockedUntil)
          ? cached.volume
          : cached.volume;

        return jsonResponse({
          success: true,
          data: {
            state: cached.state,
            position: position,
            volume: volume,
            is_playing: cached.state === 'playing'
          }
        });
      }

      // 缓存过期，穿透到小米云端查询真实物理状态
      const raw = await minaService.getPlayerStatus(account_id, device_id);
      const info = raw?.data?.info;
      
      let state = 'unknown';
      let position = 0;
      let volume = cached?.volume ?? -1; // 保留上次已知音量作为兜底

      if (typeof info === 'string') {
        const parsed = JSON.parse(info);

        // 音量：尊重锁定期，防止用户刚设完音量就被云端旧值覆盖
        if (typeof parsed.volume === 'number') {
          if (!cached?.volumeLockedUntil || now > cached.volumeLockedUntil) {
            volume = parsed.volume;
          }
        }

        // 状态枚举映射（小米硬件底层协议：1=playing, 2=paused, 0=stopped）
        if (parsed.status === 1) state = 'playing';
        else if (parsed.status === 2) state = 'paused';
        else if (parsed.status === 0) state = 'stopped';
        
        // 播放进度（云端返回毫秒，转换为秒）
        if (parsed.play_song_detail) {
          const d = parsed.play_song_detail;
          if (typeof d.position === 'number') position = Math.floor(d.position / 1000);
        }
      }

      // 同步给宿主内部缓存（与旧接口共享同一个缓存池）
      updateDeviceStatusCache(account_id, device_id, { state, position, volume });

      return jsonResponse({
        success: true,
        data: {
          state,
          position,
          volume,
          is_playing: state === 'playing'
        }
      });
    } catch (e: any) {
      return jsonResponse({ success: false, error: e.message || String(e) });
    }
  });
}
