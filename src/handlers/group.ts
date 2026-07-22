// 智能音箱插件 - 设备分组 Handler
// 分组的增删改查；分组内成员的播放同步由 GroupCoordinator 在各命令入口处实现。

import { jsonResponse, parseQuery } from '@songloft/plugin-sdk';
import type { Router, HTTPRequest } from '@songloft/plugin-sdk';
import { ConfigManager } from '../config/manager';
import { PlaylistManagerMap } from '../player/manager';
import type { DeviceGroup, DeviceTargetRef } from '../types';

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

/** 规范化并校验成员数组；非法返回错误字符串，合法返回去重后的成员列表 */
function normalizeMembers(raw: any): { members?: DeviceTargetRef[]; error?: string } {
  if (!Array.isArray(raw)) {
    return { error: 'members 必须是数组' };
  }
  const seen = new Set<string>();
  const members: DeviceTargetRef[] = [];
  for (const m of raw) {
    if (!m || typeof m.account_id !== 'string' || typeof m.device_id !== 'string' || !m.account_id || !m.device_id) {
      return { error: '每个成员需包含非空的 account_id 与 device_id' };
    }
    const key = `${m.account_id}:${m.device_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    members.push({ account_id: m.account_id, device_id: m.device_id });
  }
  return { members };
}

export function registerGroupHandlers(
  router: Router,
  configManager: ConfigManager,
  playlistManagerMap: PlaylistManagerMap,
): void {

  // GET /groups - 列出所有设备分组
  router.get('/groups', async (_req: HTTPRequest) => {
    try {
      const groups = await configManager.getDeviceGroups();
      return jsonResponse({ success: true, data: groups });
    } catch (e: any) {
      return jsonResponse({ success: false, error: e.message || String(e) });
    }
  });

  // POST /groups - 新建设备分组
  router.post('/groups', async (req: HTTPRequest) => {
    try {
      const body = parseBody(req);
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!name) {
        return jsonResponse({ success: false, error: '分组名称不能为空' });
      }
      const { members, error } = normalizeMembers(body.members ?? []);
      if (error) {
        return jsonResponse({ success: false, error });
      }

      const now = new Date().toISOString();
      const group: DeviceGroup = {
        id: 'grp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
        name,
        members: members!,
        created_at: now,
        updated_at: now,
      };
      await configManager.addDeviceGroup(group);
      await playlistManagerMap.refreshGroups(); // 成员归属可能变化，令共享 manager 按新成员重建
      return jsonResponse({ success: true, data: group });
    } catch (e: any) {
      return jsonResponse({ success: false, error: e.message || String(e) });
    }
  });

  // POST /groups/update - 更新设备分组
  router.post('/groups/update', async (req: HTTPRequest) => {
    try {
      const body = parseBody(req);
      const { id } = body;
      if (!id) {
        return jsonResponse({ success: false, error: '缺少分组 ID' });
      }

      const updates: Partial<DeviceGroup> = {};
      if (body.name !== undefined) {
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        if (!name) {
          return jsonResponse({ success: false, error: '分组名称不能为空' });
        }
        updates.name = name;
      }
      if (body.members !== undefined) {
        const { members, error } = normalizeMembers(body.members);
        if (error) {
          return jsonResponse({ success: false, error });
        }
        updates.members = members!;
      }

      await configManager.updateDeviceGroup(id, updates);
      await playlistManagerMap.refreshGroups(); // 成员变化，令共享 manager 按新成员重建
      const groups = await configManager.getDeviceGroups();
      const updated = groups.find(g => g.id === id);
      return jsonResponse({ success: true, data: updated });
    } catch (e: any) {
      return jsonResponse({ success: false, error: e.message || String(e) });
    }
  });

  // DELETE /groups?id=... - 删除设备分组
  router.delete('/groups', async (req: HTTPRequest) => {
    try {
      const query = parseQuery(req.query);
      const id = query.id;
      if (!id) {
        return jsonResponse({ success: false, error: '缺少分组 ID 参数' });
      }
      await configManager.removeDeviceGroup(id);
      await playlistManagerMap.refreshGroups(); // 分组解散，令成员恢复为独立 manager
      return jsonResponse({ success: true, data: { message: 'group deleted' } });
    } catch (e: any) {
      return jsonResponse({ success: false, error: e.message || String(e) });
    }
  });
}
