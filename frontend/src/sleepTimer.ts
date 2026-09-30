import type { SleepTimerStatus } from './types';

/** 延迟停止剩余量文案。按歌曲显示首数，按时长显示分钟（不足 1 分钟按 1 分钟）。
 *  播放栏工具区、延迟停止浮层、「更多」菜单的菜单项都要显示同一句话，
 *  所以抽在这里，避免三处各写一遍后慢慢写歪。 */
export function sleepTimerLabel(status: SleepTimerStatus): string {
  if (!status.active) return '';
  if (status.mode === 'songs') return `还剩 ${status.remaining} 首`;
  return `还剩 ${Math.max(1, Math.ceil(status.remaining / 60000))} 分钟`;
}
