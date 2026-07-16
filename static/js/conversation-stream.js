/**
 * 对话记录 WebSocket 客户端 + 轮询兜底协调
 *
 * 优先用 WebSocket 订阅后端的对话记录推送（替代每 2 秒 HTTP 轮询 /conversation/messages）：
 *   - 建连时后端先推一帧快照（最近 N 条），随后有新对话即增量推送单条。
 *   - WS 建连失败 / 断线且重连不上时，自动降级回每 2 秒调用 loadConversationMessages() 轮询。
 * 渲染逻辑复用 config.js 中的 renderConversationSnapshot / renderConversationItem，两条链路一致。
 */

import { renderConversationSnapshot, renderConversationItem, loadConversationMessages } from './config.js';

const POLL_INTERVAL_MS = 2000;        // 兜底轮询间隔（对齐原行为）
const SNAPSHOT_LIMIT = 50;            // 建连快照条数
const MAX_RECONNECT_DELAY_MS = 15000; // 重连退避上限

let ws = null;
let manualClose = false;            // 主动断开（停用），不触发重连
let connected = false;
let reconnectAttempts = 0;
let reconnectTimer = null;
let pollingTimer = null;

/** 构造对话订阅 WebSocket 绝对 URL（保留 BASE_PATH 子路径前缀，带 access_token 握手鉴权） */
function buildWsUrl() {
    const loc = window.location;
    const proto = loc.protocol === 'https:' ? 'wss:' : 'ws:';

    // 插件页面 pathname 形如 [<base_path>]/api/v1/jsplugin/miot；WebSocket 需绝对 URL，
    // 从中截取到插件根再拼 /conversation/ws，兼容子路径部署。
    const marker = '/api/v1/jsplugin/miot';
    const idx = loc.pathname.indexOf(marker);
    const base = idx >= 0 ? loc.pathname.slice(0, idx + marker.length) : marker;

    let token = '';
    try {
        if (window.SongloftPlugin && typeof SongloftPlugin.getAuthToken === 'function') {
            token = SongloftPlugin.getAuthToken() || '';
        }
    } catch (_) { /* ignore */ }

    const q = 'limit=' + SNAPSHOT_LIMIT +
              (token ? '&access_token=' + encodeURIComponent(token) : '');
    return proto + '//' + loc.host + base + '/conversation/ws?' + q;
}

function startPolling() {
    if (pollingTimer) return;
    loadConversationMessages(); // 立即拉一次，避免等首个 tick
    pollingTimer = setInterval(() => loadConversationMessages(), POLL_INTERVAL_MS);
}

function stopPolling() {
    if (pollingTimer) {
        clearInterval(pollingTimer);
        pollingTimer = null;
    }
}

function scheduleReconnect() {
    if (manualClose || reconnectTimer) return;
    const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), MAX_RECONNECT_DELAY_MS);
    reconnectAttempts++;
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        openSocket();
    }, delay);
}

function openSocket() {
    // 环境不支持 WS：直接走兜底轮询
    if (typeof WebSocket === 'undefined') {
        startPolling();
        return;
    }

    let socket;
    try {
        socket = new WebSocket(buildWsUrl());
    } catch (e) {
        console.warn('[conversation-stream] WebSocket 建连异常，降级轮询', e);
        startPolling();
        scheduleReconnect();
        return;
    }
    ws = socket;

    socket.onopen = () => {
        connected = true;
        reconnectAttempts = 0;
        stopPolling(); // WS 上线，停止兜底轮询
    };

    socket.onmessage = (ev) => {
        try {
            const msg = JSON.parse(ev.data);
            if (!msg) return;
            if (msg.type === 'snapshot' && Array.isArray(msg.data)) {
                renderConversationSnapshot(msg.data);
            } else if (msg.type === 'message' && msg.data) {
                renderConversationItem(msg.data);
            }
        } catch (_) { /* 忽略非法帧 */ }
    };

    socket.onerror = () => {
        // onerror 后浏览器通常紧跟 onclose，统一在 onclose 里处理降级/重连
        try { socket.close(); } catch (_) { /* ignore */ }
    };

    socket.onclose = () => {
        if (ws === socket) ws = null;
        connected = false;
        if (!manualClose) {
            startPolling();     // 断线立即用轮询兜住
            scheduleReconnect();
        }
    };
}

/** 连接对话记录推送（WebSocket 优先，失败降级轮询）。重复调用幂等。 */
export function connectConversationStream() {
    if (connected || ws || reconnectTimer) {
        return; // 已在连接/重连中
    }
    manualClose = false;
    reconnectAttempts = 0;
    openSocket();
}

/** 主动断开连接并停止兜底轮询（关闭对话监听时调用） */
export function disconnectConversationStream() {
    manualClose = true;
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    if (ws) {
        try { ws.close(); } catch (_) { /* ignore */ }
        ws = null;
    }
    connected = false;
    stopPolling();
}
