// MIoT 智能音箱插件 - 播放状态 WebSocket 推送
//
// 用长连接推送替代前端每秒 HTTP 轮询 `/player/status`：
//   - 前端订阅 `wss?://.../api/v1/jsplugin/miot/status/ws?account_id=..&device_id=..&access_token=..`
//   - 同一设备的多个客户端共享一个后台推送循环（按 account_id:device_id 聚合）
//   - 无订阅者时不启循环，避免无人观看时 24/7 空拉云端
//   - 状态与 HTTP 端点共用 `resolvePlayerStatus`，两条链路结果不漂移
//
// 云端采样由 Mina 客户端统一去重、五秒节流和失败退避；状态融合在后台刷新，
// 每秒推送本地计时进度，云端慢请求不会卡住推送。

import { parseQuery } from '@songloft/plugin-sdk';
import type { WebSocketRequest, InboundWebSocket } from '@songloft/plugin-sdk';
import type { PlaylistManagerMap } from '../player/manager';
import type { MinaService } from '../service/service';
import { resolvePlayerStatus } from '../handlers/playlist';

/** 前端约定的状态订阅 WebSocket 子路径（onWebSocket 收到的 req.path） */
export const WS_STATUS_PATH = '/status/ws';

/** 推送 tick 间隔，对齐原前端 1s 轮询 UX */
const PUSH_INTERVAL_MS = 1000;

/** 单个设备的推送器：一个后台定时器 + 该设备的所有订阅连接 */
interface DevicePusher {
  timer: ReturnType<typeof setInterval> | null;
  sockets: Set<InboundWebSocket>;
  lastFrame: string; // 上次推送的帧 JSON，用于 diff（无变化不重复推）
  inFlight: Promise<void> | null;
}

let playlistManagerMap: PlaylistManagerMap | null = null;
let minaService: MinaService | null = null;

/** 按 account_id:device_id 聚合的推送器 */
const pushers = new Map<string, DevicePusher>();

/** 在 onInit 中注入依赖（懒加载恢复时也需重新调用） */
export function initStatusStream(pm: PlaylistManagerMap, ms: MinaService): void {
  playlistManagerMap = pm;
  minaService = ms;
}

function deviceKey(accountId: string, deviceId: string): string {
  return accountId + ':' + deviceId;
}

/** 拉取一次融合状态并推送给该设备的所有订阅者；force=false 时无变化不推 */
async function pushOnce(accountId: string, deviceId: string, pusher: DevicePusher, force: boolean): Promise<void> {
  if (pusher.inFlight) {
    if (!force) return;
    await pusher.inFlight;
    // 新连接仍需首帧，即使查询结果与上次完全相同。
    if (force) await pushOnce(accountId, deviceId, pusher, true);
    return;
  }
  const pending = pushStatus(accountId, deviceId, pusher, force);
  pusher.inFlight = pending;
  try {
    await pending;
  } finally {
    if (pusher.inFlight === pending) pusher.inFlight = null;
  }
}

async function pushStatus(accountId: string, deviceId: string, pusher: DevicePusher, force: boolean): Promise<void> {
  if (!playlistManagerMap || !minaService || pusher.sockets.size === 0) return;

  let data: Record<string, any>;
  try {
    data = await resolvePlayerStatus(playlistManagerMap, minaService, accountId, deviceId);
  } catch (e: any) {
    songloft.log.warn('[ws/status] resolvePlayerStatus failed: ' + String(e));
    return;
  }

  const frame = JSON.stringify({ type: 'status', data });
  if (!force && frame === pusher.lastFrame) return;
  pusher.lastFrame = frame;

  for (const socket of pusher.sockets) {
    if (socket.readyState !== socket.OPEN) continue;
    socket.send(frame).catch((e: any) => {
      songloft.log.warn('[ws/status] send failed: ' + String(e));
    });
  }
}

/**
 * 处理一条状态订阅 WebSocket 连接。由 main.ts 的 onWebSocket 在 req.path 匹配时调用。
 */
export async function handleStatusWebSocket(req: WebSocketRequest, socket: InboundWebSocket): Promise<void> {
  const query = parseQuery(req.query);
  const accountId = query.account_id;
  const deviceId = query.device_id;
  if (!accountId || !deviceId) {
    await socket.close(1008, 'account_id and device_id are required');
    return;
  }

  const key = deviceKey(accountId, deviceId);
  let pusher = pushers.get(key);
  if (!pusher) {
    pusher = { timer: null, sockets: new Set(), lastFrame: '', inFlight: null };
    pushers.set(key, pusher);
  }
  pusher.sockets.add(socket);

  // 断开 / 出错 → 注销该连接；该设备最后一个连接断开时停循环、释放推送器
  const cleanup = () => {
    const p = pushers.get(key);
    if (!p) return;
    p.sockets.delete(socket);
    if (p.sockets.size === 0) {
      if (p.timer) { clearInterval(p.timer); p.timer = null; }
      pushers.delete(key);
    }
  };
  socket.onClose(() => cleanup());
  socket.onError(() => cleanup());

  // 客户端可发 {type:'refresh'} 请求立即刷新（如刚点过播放/暂停）
  socket.onMessage((ev) => {
    try {
      const raw = typeof ev.data === 'string' ? ev.data : '';
      const msg = raw ? JSON.parse(raw) : null;
      if (msg && msg.type === 'refresh') {
        const p = pushers.get(key);
        if (p) void pushOnce(accountId, deviceId, p, true);
      }
    } catch {
      // 忽略非法消息
    }
  });

  // 立即推送首帧快照
  await pushOnce(accountId, deviceId, pusher, true);

  // 启动后台推送循环（同设备仅一个）
  if (pushers.get(key) === pusher && pusher.sockets.size > 0 && !pusher.timer) {
    pusher.timer = setInterval(() => {
      const p = pushers.get(key);
      if (!p) return;
      void pushOnce(accountId, deviceId, p, false);
    }, PUSH_INTERVAL_MS);
  }
}
