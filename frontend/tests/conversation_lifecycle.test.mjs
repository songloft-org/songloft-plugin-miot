import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
function fixture() {
  const text = readFileSync(
    new URL('../src/views/settings/VoiceSettings.tsx', import.meta.url),
    'utf8',
  );
  const source = ts.createSourceFile(
      'VoiceSettings.tsx',
      text,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    ),
    functions = [];
  function visit(node) {
    if (
      ts.isFunctionDeclaration(node) &&
      ['connectConversation', 'disconnectConversation'].includes(
        node.name?.text,
      )
    )
      functions.push(node.getText(source));
    ts.forEachChild(node, visit);
  }
  visit(source);
  const sockets = [],
    timers = new Set(),
    state = {
      config: { conversation_monitor_enabled: true },
      conversationMessages: [],
    },
    navigation = { page: 'settings', settingsCategory: 'voice' };
  class Socket {
    constructor() {
      sockets.push(this);
    }
    close() {
      this.closed = true;
    }
  }
  const code = ts.transpileModule(
    `let conversationSocket=null,conversationPoll=null;const conversationVisible=()=>navigation.page==='settings'&&navigation.settingsCategory==='voice';${functions.join('\n')};return {connectConversation,disconnectConversation};`,
    { compilerOptions: { target: ts.ScriptTarget.ES2020 } },
  ).outputText;
  const controls = new Function(
    'WebSocket',
    'state',
    'navigation',
    'pluginWebSocketUrl',
    'loadConversationMessages',
    'setInterval',
    'clearInterval',
    code,
  )(
    Socket,
    state,
    navigation,
    (p) => p,
    () => {},
    () => {
      const timer = {};
      timers.add(timer);
      return timer;
    },
    (timer) => timers.delete(timer),
  );
  return { ...controls, sockets, timers, state, navigation };
}
test('a closed conversation socket cannot replace a new stream or create polling', () => {
  const h = fixture();
  h.connectConversation();
  const old = h.sockets[0];
  h.connectConversation();
  const current = h.sockets[1];
  old.onclose();
  old.onmessage({
    data: JSON.stringify({ type: 'message', data: { text: 'late' } }),
  });
  assert.equal(h.timers.size, 0);
  assert.deepEqual(h.state.conversationMessages, []);
  current.onmessage({
    data: JSON.stringify({ type: 'message', data: { text: 'current' } }),
  });
  assert.equal(h.state.conversationMessages[0].text, 'current');
});
test('hidden settings do not open streams and explicit disconnect prevents fallback polling', () => {
  const h = fixture();
  h.navigation.page = 'main';
  h.connectConversation();
  assert.equal(h.sockets.length, 0);
  h.navigation.page = 'settings';
  h.connectConversation();
  const socket = h.sockets[0];
  h.disconnectConversation();
  socket.onclose();
  assert.equal(h.timers.size, 0);
  assert.equal(socket.closed, true);
});
test('active stream failure falls back to one poller until it is disposed', () => {
  const h = fixture();
  h.connectConversation();
  h.sockets[0].onclose();
  assert.equal(h.timers.size, 1);
  h.disconnectConversation();
  assert.equal(h.timers.size, 0);
});

test('routing updates replace the matching record without mixing devices or duplicating messages', () => {
  const h = fixture();
  h.connectConversation();
  const socket = h.sockets[0];
  const send = (type, data) =>
    socket.onmessage({ data: JSON.stringify({ type, data }) });
  const a = {
    id: 'same',
    timestamp: 1,
    account_id: 'a',
    device_id: 'd',
    query: '请播放菊花台',
  };
  const b = { ...a, device_id: 'e' };
  send('message', a);
  send('message', b);
  send('update', {
    ...a,
    routing_trace: ['点歌规则：播放', '本地命中：菊花台'],
  });
  assert.equal(h.state.conversationMessages.length, 2);
  assert.equal(h.state.conversationMessages[0].routing_trace, undefined);
  assert.deepEqual(h.state.conversationMessages[1].routing_trace, [
    '点歌规则：播放',
    '本地命中：菊花台',
  ]);
  send('message', { ...a, routing_trace: ['最终结果'] });
  assert.equal(h.state.conversationMessages.length, 2);
  send('update', { ...a, id: 'not-in-buffer' });
  assert.equal(h.state.conversationMessages.length, 2);
});
