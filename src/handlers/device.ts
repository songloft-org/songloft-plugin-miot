// MIoT 智能音箱插件 - 设备控制 Handler
// 翻译自 Go 源码: plugins/songloft-plugin-xiaomi/handlers/device_handler.go

import { jsonResponse, parseQuery } from '@songloft/plugin-sdk';
import type { Router, HTTPRequest } from '@songloft/plugin-sdk';
import { MinaService } from '../service/service';
import { AccountManager } from '../account/manager';
import { updateDeviceStatusCache } from './playlist';

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
}
