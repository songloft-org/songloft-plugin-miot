import assert from 'node:assert/strict';
import { AIAnalyzer } from '../src/voicecmd/ai_analyzer.ts';

// Global songloft stub for logging in tests
globalThis.songloft = {
  log: {
    info: () => {},
    warn: () => {},
    error: () => {},
  },
};

const analyzer = new AIAnalyzer();

// Case 1: Pure JSON (standard)
{
  const raw = '{"action":"resume","params":{},"confidence":"high","rawText":"继续播放"}';
  const res = analyzer.parseResponse(raw);
  assert.equal(res.action, 'resume');
  assert.equal(res.confidence, 'high');
  assert.equal(res.rawText, '继续播放');
}

// Case 2: Wrapped in ```json ... ``` codeblock (Gemini / Claude / Antigravity proxy)
{
  const raw = '```json\n{"action":"unknown","params":{},"confidence":"high","rawText":"太吵了小点声"}\n```';
  const res = analyzer.parseResponse(raw);
  assert.equal(res.action, 'unknown');
  assert.equal(res.confidence, 'high');
  assert.equal(res.rawText, '太吵了小点声');
}

// Case 3: Codeblock with leading / trailing explanatory text
{
  const raw = 'Here is the analysis result:\n```json\n{"action":"set_play_mode","params":{"mode":"random"},"confidence":"high","rawText":"随机播放"}\n```\nHope it helps!';
  const res = analyzer.parseResponse(raw);
  assert.equal(res.action, 'set_play_mode');
  assert.equal(res.params.mode, 'random');
  assert.equal(res.confidence, 'high');
}

// Case 4: Output containing reasoning / thinking tags
{
  const raw = '<think>用户说太吵了，应该降低音量或者属于未分类指令</think>\n```json\n{"action":"unknown","params":{},"confidence":"medium","rawText":"太吵了"}\n```';
  const res = analyzer.parseResponse(raw);
  assert.equal(res.action, 'unknown');
  assert.equal(res.confidence, 'medium');
}

console.log('All AIAnalyzer parseResponse tests passed!');
