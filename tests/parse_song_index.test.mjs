import assert from 'node:assert/strict';
import { parseSongIndex, parseSongsCount, parseTimeDuration } from '../src/sleep_timer/index.ts';

globalThis.songloft = {
  log: { info: () => { }, warn: () => { }, error: () => { } },
};

// parseSongIndex：阿拉伯数字
assert.equal(parseSongIndex('播放第300首'), 300);
assert.equal(parseSongIndex('跳到第 50 首'), 50);
assert.equal(parseSongIndex('切到第1首'), 1);
assert.equal(parseSongIndex('跳转到第500'), 500);

// parseSongIndex：中文数字（个/十/百/千）
assert.equal(parseSongIndex('播放第三首'), 3);
assert.equal(parseSongIndex('跳到第五十首'), 50);
assert.equal(parseSongIndex('播放第一百二十首'), 120);
assert.equal(parseSongIndex('跳到第三百'), 300);
assert.equal(parseSongIndex('第一千二百三十四首'), 1234);
assert.equal(parseSongIndex('第两百首'), 200);
assert.equal(parseSongIndex('请播放第三首歌。'), 3);
assert.equal(parseSongIndex('跳到第 50 首！ '), 50);

// parseSongIndex：无 "第" 锚点或无数字应返回 0
assert.equal(parseSongIndex('播放第几首'), 0);
assert.equal(parseSongIndex('随便播一首'), 0);
assert.equal(parseSongIndex(''), 0);

// 名称、非整数或无效序号不能被截取为跳播位置。
for (const text of [
  '播放歌单第一周',
  '播放歌单启蒙第一周',
  '播放第一周',
  '播放歌曲第一天',
  '播放第3周',
  '播放第三首歌的故事',
  '播放第1.5首',
  '播放第0首',
  '播放第负一首',
  '播放第9007199254740992首',
  '播放第几首然后第三首',
]) {
  assert.equal(parseSongIndex(text), 0, text);
}

// parseSongsCount 不应把 "第 300 首" 当成 300 首 —— 但既有语义是"再听 N 首"，
// 用户表达为 "3首歌"/"三首" 时才用这个函数，冲突场景由 matchCommand 优先级决定。
// 这里只保证扩展后的中文数字仍然向后兼容：
assert.equal(parseSongsCount('再听3首'), 3);
assert.equal(parseSongsCount('三首'), 3);
assert.equal(parseSongsCount('五首歌后停止'), 5);

// parseTimeDuration 向后兼容
assert.equal(parseTimeDuration('30分钟后停止播放'), 30);
assert.equal(parseTimeDuration('半小时'), 30);
assert.equal(parseTimeDuration('一个半小时'), 90);
assert.equal(parseTimeDuration('三十分钟'), 30);
assert.equal(parseTimeDuration('两个小时'), 120);

console.log('All parseSongIndex tests passed!');
