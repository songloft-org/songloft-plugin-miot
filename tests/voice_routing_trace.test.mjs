import assert from 'node:assert/strict';
import test from 'node:test';
import { load, storageOf } from './chat_fixture.mjs';
const { traceConversation, setConversationTraceListener } = load(
  '../src/conversation/query.ts',
);
const { toConversationViewModel } = load('../src/conversation/viewmodel.ts');
const { initConversationStream, handleConversationWebSocket } = load(
  '../src/ws/conversation-stream.ts',
);
test('routing diagnostics are bounded and streamed as scoped record updates', async (t) => {
  storageOf(t);
  const callbacks = new Map(),
    frames = [];
  const message = {
    account_id: 'a',
    device_id: 'd',
    device_name: '音箱',
    message: {
      request_id: 'r',
      timestamp_ms: 1,
      response: { answer: [{ question: '请播放菊花台' }] },
    },
  };
  const monitor = {
    registerCallback: (key, fn) => callbacks.set(key, fn),
    unregisterCallback: (key) => callbacks.delete(key),
    getMessages: () => [message],
  };
  let close;
  const socket = {
    OPEN: 1,
    readyState: 1,
    send: async (text) => frames.push(JSON.parse(text)),
    onClose: (fn) => {
      close = fn;
    },
    onError() {},
    onMessage() {},
  };
  initConversationStream(monitor);
  await handleConversationWebSocket({ query: '' }, socket);
  t.after(() => {
    close();
    setConversationTraceListener();
  });
  traceConversation(message, '聊天触发词：请问');
  assert.equal(frames.at(-1).type, 'update');
  assert.deepEqual(frames.at(-1).data.routing_trace, ['聊天触发词：请问']);
  assert.equal(frames.at(-1).data.device_id, 'd');
  const snapshot = toConversationViewModel(message);
  for (let i = 0; i < 30; i++) traceConversation(message, 'x'.repeat(300));
  assert.equal(message.routing_trace.length, 24);
  assert.equal(message.routing_trace[1].length, 240);
  assert.equal(
    snapshot.routing_trace.length,
    1,
    'view models do not retain a mutable array',
  );
  close();
  const count = frames.length;
  traceConversation({ ...message, routing_trace: [] }, 'after close');
  assert.equal(frames.length, count);
  assert.equal(callbacks.size, 0);
});
