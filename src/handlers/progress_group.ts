import { jsonResponse, parseQuery } from '@songloft/plugin-sdk';
import type { Router, HTTPRequest } from '@songloft/plugin-sdk';
import { ConfigManager } from '../config/manager';
import type { DeviceTargetRef, ProgressGroup } from '../types';

function parseBody(req: HTTPRequest): any {
  if (!req.body) return {};
  try {
    const raw = typeof req.body === 'string'
      ? req.body
      : String.fromCharCode.apply(null, Array.from(req.body as Uint8Array));
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function normalizeMembers(raw: unknown): { members?: DeviceTargetRef[]; error?: string } {
  if (!Array.isArray(raw)) return { error: 'members 必须是数组' };
  const seen = new Set<string>();
  const members: DeviceTargetRef[] = [];
  for (const item of raw) {
    const member = item as Partial<DeviceTargetRef>;
    if (typeof member?.account_id !== 'string' || typeof member.device_id !== 'string' ||
      !member.account_id || !member.device_id) {
      return { error: '每个成员需包含非空的 account_id 与 device_id' };
    }
    const key = `${member.account_id}:${member.device_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    members.push({ account_id: member.account_id, device_id: member.device_id });
  }
  if (members.length < 2) return { error: '共享组至少需要两台设备' };
  return { members };
}

export function registerProgressGroupHandlers(router: Router, configManager: ConfigManager): void {
  router.get('/progress-groups', async () => {
    try {
      return jsonResponse({ success: true, data: await configManager.getProgressGroups() });
    } catch (e: any) {
      return jsonResponse({ success: false, error: e.message || String(e) });
    }
  });

  router.post('/progress-groups', async (req: HTTPRequest) => {
    try {
      const body = parseBody(req);
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!name) return jsonResponse({ success: false, error: '共享组名称不能为空' });
      const normalized = normalizeMembers(body.members);
      if (normalized.error) return jsonResponse({ success: false, error: normalized.error });
      const now = new Date().toISOString();
      const group: ProgressGroup = {
        id: `progress_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        name,
        members: normalized.members!,
        created_at: now,
        updated_at: now,
      };
      await configManager.addProgressGroup(group);
      return jsonResponse({ success: true, data: group });
    } catch (e: any) {
      return jsonResponse({ success: false, error: e.message || String(e) });
    }
  });

  router.post('/progress-groups/update', async (req: HTTPRequest) => {
    try {
      const body = parseBody(req);
      if (typeof body.id !== 'string' || !body.id) return jsonResponse({ success: false, error: '缺少共享组 ID' });
      const updates: Partial<ProgressGroup> = {};
      if (body.name !== undefined) {
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        if (!name) return jsonResponse({ success: false, error: '共享组名称不能为空' });
        updates.name = name;
      }
      if (body.members !== undefined) {
        const normalized = normalizeMembers(body.members);
        if (normalized.error) return jsonResponse({ success: false, error: normalized.error });
        updates.members = normalized.members;
      }
      await configManager.updateProgressGroup(body.id, updates);
      const group = (await configManager.getProgressGroups()).find(item => item.id === body.id);
      return jsonResponse({ success: true, data: group });
    } catch (e: any) {
      return jsonResponse({ success: false, error: e.message || String(e) });
    }
  });

  router.delete('/progress-groups', async (req: HTTPRequest) => {
    try {
      const id = parseQuery(req.query).id;
      if (!id) return jsonResponse({ success: false, error: '缺少共享组 ID 参数' });
      await configManager.removeProgressGroup(id);
      return jsonResponse({ success: true, data: { message: 'progress group deleted' } });
    } catch (e: any) {
      return jsonResponse({ success: false, error: e.message || String(e) });
    }
  });
}
