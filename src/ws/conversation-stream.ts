// MIoT 智能音箱插件 - 对话记录 WebSocket 推送
//
// 用长连接推送替代前端每 2 秒 HTTP 轮询 `/conversation/messages`：
//   - 前端订阅 `wss?://.../api/v1/jsplugin/miot/conversation/ws?access_token=..&limit=50`
//   - 所有订阅者共享一份对话缓冲：建连先推一帧快照（最近 N 条），随后有新对话即增量推送
//   - 复用 ConversationMonitor 的观察者回调：monitor 每 tick 检测到新消息即触发回调，
//     无需额外定时器，也不额外增加对小米云的轮询压力
//   - 无订阅者时注销 monitor 回调，避免无人观看时空转推送
//
// 与 status-stream 的差异：状态推送需按设备聚合、定时拉取融合状态；对话推送是全局广播、
// 事件驱动（monitor 回调），故无需 per-device pusher / setInterval。

import { parseQuery } from '@songloft/plugin-sdk';
import type { WebSocketRequest, InboundWebSocket } from '@songloft/plugin-sdk';
import type { ConversationMonitor } from '../conversation/monitor';
import type { ConversationMessage } from '../types';

/** 前端约定的对话订阅 WebSocket 子路径（onWebSocket 收到的 req.path） */
export const WS_CONVERSATION_PATH = '/conversation/ws';

/** 注册到 ConversationMonitor 的回调名 */
const CALLBACK_NAME = 'ws_conversation_stream';

/** 建连快照默认条数（前端未传 limit 时） */
const DEFAULT_SNAPSHOT_LIMIT = 50;

let conversationMonitor: ConversationMonitor | null = null;

/** 当前所有订阅连接 */
const sockets = new Set<InboundWebSocket>();

/** 是否已向 monitor 注册回调（有订阅者才注册） */
let callbackRegistered = false;

/** 在 onInit 中注入依赖（懒加载恢复时也需重新调用） */
export function initConversationStream(cm: ConversationMonitor): void {
  conversationMonitor = cm;
}

/** 向所有在线订阅者广播一帧 */
function broadcast(frame: Record<string, any>): void {
  if (sockets.size === 0) return;
  const json = JSON.stringify(frame);
  for (const socket of sockets) {
    if (socket.readyState !== socket.OPEN) continue;
    socket.send(json).catch((e: any) => {
      songloft.log.warn('[ws/conversation] send failed: ' + String(e));
    });
  }
}

/** 有订阅者时向 monitor 注册增量回调；幂等 */
function ensureCallback(): void {
  if (callbackRegistered || !conversationMonitor) return;
  conversationMonitor.registerCallback(CALLBACK_NAME, (msg: ConversationMessage) => {
    broadcast({ type: 'message', data: msg });
  });
  callbackRegistered = true;
}

/** 无订阅者时注销 monitor 回调，避免空转推送 */
function releaseCallbackIfIdle(): void {
  if (sockets.size > 0) return;
  if (callbackRegistered && conversationMonitor) {
    conversationMonitor.unregisterCallback(CALLBACK_NAME);
  }
  callbackRegistered = false;
}

/**
 * 处理一条对话订阅 WebSocket 连接。由 main.ts 的 onWebSocket 在 req.path 匹配时调用。
 */
export async function handleConversationWebSocket(req: WebSocketRequest, socket: InboundWebSocket): Promise<void> {
  if (!conversationMonitor) {
    await socket.close(1011, 'conversation monitor not ready');
    return;
  }

  const query = parseQuery(req.query);
  const limit = query.limit ? Number(query.limit) : DEFAULT_SNAPSHOT_LIMIT;

  sockets.add(socket);
  ensureCallback();

  // 断开 / 出错 → 注销该连接；最后一个连接断开时注销 monitor 回调
  const cleanup = () => {
    sockets.delete(socket);
    releaseCallbackIfIdle();
  };
  socket.onClose(() => cleanup());
  socket.onError(() => cleanup());

  // 客户端可发 {type:'refresh'} 请求重新拉取快照（如切换 tab 回来）
  socket.onMessage((ev) => {
    try {
      const raw = typeof ev.data === 'string' ? ev.data : '';
      const msg = raw ? JSON.parse(raw) : null;
      if (msg && msg.type === 'refresh') {
        sendSnapshot(socket, limit);
      }
    } catch {
      // 忽略非法消息
    }
  });

  // 立即推送首帧快照（最近 limit 条对话）
  sendSnapshot(socket, limit);
}

/** 向单个连接推送快照帧 */
function sendSnapshot(socket: InboundWebSocket, limit: number): void {
  if (!conversationMonitor || socket.readyState !== socket.OPEN) return;
  const messages = conversationMonitor.getMessages(limit, 0);
  socket.send(JSON.stringify({ type: 'snapshot', data: messages, count: messages.length })).catch((e: any) => {
    songloft.log.warn('[ws/conversation] snapshot send failed: ' + String(e));
  });
}
