import { PluginSocket as WebSocket } from './socket';
import { get, query, pluginWebSocketUrl } from './api';
import { state } from './store';
let chatSocket: WebSocket | null = null;
let chatRetry: ReturnType<typeof setTimeout> | undefined;
let chatOpenTimer: ReturnType<typeof setTimeout> | undefined;
let chatVersion = 0;
let chatVisible = true;
export function setChatVisible(visible: boolean) {
  chatVisible = visible;
  if (visible) connectChatSocket();
  else stopChatSocket();
}
export function stopChatSocket() {
  chatVersion++;
  clearTimeout(chatRetry);
  clearTimeout(chatOpenTimer);
  chatRetry = undefined;
  chatOpenTimer = undefined;
  if (chatSocket) {
    chatSocket.onclose = null;
    chatSocket.onerror = null;
    try {
      chatSocket.close(1000, 'device changed');
    } catch {}
    chatSocket = null;
  }
}
export function connectChatSocket() {
  stopChatSocket();
  state.chatStatus = null;
  const account = state.currentAccountId,
    device = state.currentDeviceId;
  if (!chatVisible || !account || !device) return;
  const version = chatVersion,
    params = { account_id: account, device_id: device };
  let attempt = 0;
  const connect = () => {
    if (version !== chatVersion) return;
    const requestAttempt = ++attempt;
    let received = false,
      abandoned = false;
    void get<any>('/chat/status' + query(params))
      .then((status) => {
        if (version === chatVersion && requestAttempt === attempt && !received)
          state.chatStatus = status;
      })
      .catch(() => {});
    let socket: WebSocket;
    const current = () =>
      version === chatVersion && chatSocket === socket && !abandoned;
    const retry = () => {
      if (!current()) return;
      abandoned = true;
      clearTimeout(chatOpenTimer);
      socket.onclose = null;
      socket.onerror = null;
      try {
        socket.close(1000, 'reconnect');
      } catch {}
      chatRetry = setTimeout(connect, 3000);
    };
    try {
      socket = new WebSocket(pluginWebSocketUrl('/chat/ws' + query(params)));
    } catch {
      chatRetry = setTimeout(connect, 3000);
      return;
    }
    chatSocket = socket;
    chatOpenTimer = setTimeout(retry, 10000);
    socket.onopen = () => {
      if (current()) clearTimeout(chatOpenTimer);
    };
    socket.onmessage = (event) => {
      if (!current()) return;
      try {
        const frame = JSON.parse(event.data);
        if (frame.type === 'chat_status') {
          received = true;
          state.chatStatus = frame.data;
        }
      } catch {}
    };
    socket.onerror = retry;
    socket.onclose = retry;
  };
  connect();
}
