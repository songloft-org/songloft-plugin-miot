/// <reference types="@songloft/plugin-sdk" />

export type SleepTimerMode = 'time' | 'songs';

export interface SleepTimerState {
  active: boolean;
  mode: SleepTimerMode;
  /** time 模式：剩余毫秒；songs 模式：剩余曲目数 */
  remaining: number;
  /** 定时器创建的时间戳(ms) */
  startedAt: number;
  /** time 模式：总时长(ms)；songs 模式：总曲目数 */
  total: number;
}

/**
 * SleepTimer - 睡眠定时器
 * 支持两种模式：
 * - time：N 分钟后停止播放（基于 setTimeout）
 * - songs：再播 N 首后停止（由外部每切一首调 onSongAdvanced）
 */
export class SleepTimer {
  private timer: any = null;
  private mode: SleepTimerMode = 'time';
  private totalMs: number = 0;
  private startedAt: number = 0;
  private songsRemaining: number = 0;
  private songsTotal: number = 0;
  private active: boolean = false;
  private onExpire: () => void;

  constructor(onExpire: () => void) {
    this.onExpire = onExpire;
  }

  /**
   * 设置时间模式定时器
   * @param minutes 分钟数（>0）
   */
  setTime(minutes: number): void {
    this.cancel();
    this.mode = 'time';
    this.totalMs = minutes * 60000;
    this.startedAt = Date.now();
    this.active = true;

    this.timer = setTimeout(() => {
      this.active = false;
      this.timer = null;
      songloft.log.info(`[SleepTimer] 时间到期 (${minutes}分钟)，执行停止`);
      this.onExpire();
    }, this.totalMs);

    songloft.log.info(`[SleepTimer] 已设置时间定时器: ${minutes}分钟后停止`);
  }

  /**
   * 设置曲目模式定时器
   * @param count 曲目数（>0）
   */
  setSongs(count: number): void {
    this.cancel();
    this.mode = 'songs';
    this.songsRemaining = count;
    this.songsTotal = count;
    this.startedAt = Date.now();
    this.active = true;

    songloft.log.info(`[SleepTimer] 已设置曲目定时器: 再播${count}首后停止`);
  }

  /**
   * 切歌时调用，仅 songs 模式有效
   * @returns true 表示计数归零已到期（调用方应停止播放）
   */
  onSongAdvanced(): boolean {
    if (!this.active || this.mode !== 'songs') {
      return false;
    }

    this.songsRemaining--;
    songloft.log.info(`[SleepTimer] 曲目计数递减: 剩余${this.songsRemaining}首`);

    if (this.songsRemaining <= 0) {
      this.active = false;
      songloft.log.info(`[SleepTimer] 曲目到期，执行停止`);
      this.onExpire();
      return true;
    }
    return false;
  }

  /**
   * 取消定时器
   */
  cancel(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.active = false;
    this.songsRemaining = 0;
    this.totalMs = 0;
    this.startedAt = 0;
  }

  /**
   * 查询当前状态
   */
  getState(): SleepTimerState {
    if (!this.active) {
      return { active: false, mode: 'time', remaining: 0, startedAt: 0, total: 0 };
    }

    if (this.mode === 'time') {
      const elapsed = Date.now() - this.startedAt;
      const remaining = Math.max(0, this.totalMs - elapsed);
      return { active: true, mode: 'time', remaining, startedAt: this.startedAt, total: this.totalMs };
    }

    return { active: true, mode: 'songs', remaining: this.songsRemaining, startedAt: this.startedAt, total: this.songsTotal };
  }

  isActive(): boolean {
    return this.active;
  }
}

/**
 * 中文数字转阿拉伯数字（覆盖语音识别常见输出）
 * 支持 1-9999 范围：个/十/百/千位组合，如 "三百"、"五百二十"、"一千二百三十"。
 */
function chineseToNumber(text: string): string {
  const digitMap: Record<string, number> = {
    '零': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4,
    '五': 5, '六': 6, '七': 7, '八': 8, '九': 9,
  };
  const digitChars = '零一二两三四五六七八九';
  // 匹配一段完整的中文数字序列（可含千/百/十/个位），一次性替换为整体数值，
  // 避免"三百"被拆成"3百"、"一百二"被拆成"12"等问题。
  const segmentRe = new RegExp(`[${digitChars}十百千]+`, 'g');
  let result = text.replace(segmentRe, (seg) => {
    // 段中含 十/百/千 时整段按数值解析（"三百二十" → 320）；
    // 段中只有个位字符时按位替换（"一二三" 之类识别为逐位读法，避免被误解为 3）。
    if (/[十百千]/.test(seg)) {
      const parsed = parseChineseSegment(seg, digitMap);
      return parsed === null ? seg : String(parsed);
    }
    let per = '';
    for (const ch of seg) per += String(digitMap[ch] ?? ch);
    return per;
  });
  return result;
}

/**
 * 解析一段纯中文数字（如 "三百二十"、"一千零五"）为整数；无法解析返回 null。
 */
function parseChineseSegment(seg: string, digitMap: Record<string, number>): number | null {
  let total = 0;
  let section = 0;   // 千百十以内的累计
  let current = 0;   // 当前位的数字
  let hasUnit = false; // 段内是否出现过 十/百/千 单位
  for (const ch of seg) {
    if (ch in digitMap) {
      current = digitMap[ch];
    } else if (ch === '十') {
      section += (current === 0 ? 1 : current) * 10;
      current = 0;
      hasUnit = true;
    } else if (ch === '百') {
      if (current === 0) return null;
      section += current * 100;
      current = 0;
      hasUnit = true;
    } else if (ch === '千') {
      if (current === 0) return null;
      section += current * 1000;
      current = 0;
      hasUnit = true;
    } else {
      return null;
    }
  }
  total = section + current;
  if (total === 0 && !hasUnit) return null;
  return total;
}

/**
 * 从语音文本中解析时间（分钟数）
 * 支持："30分钟"、"半小时"、"一个半小时"、"1.5小时"、"2小时"、"90分"
 * 以及中文数字："三十分钟"、"两个小时"
 * @returns 分钟数，解析失败返回 0
 */
export function parseTimeDuration(text: string): number {
  // "一个半小时" / "1个半小时" → 90
  if (/[一1]个半\s*小时/.test(text)) return 90;
  // "两个半小时" / "2个半小时" → 150
  if (/[两二2]个半\s*小时/.test(text)) return 150;
  // "半小时" / "半个小时" → 30
  if (/半个?\s*小时/.test(text)) return 30;

  // 中文数字归一化后再做正则匹配
  const normalized = chineseToNumber(text);

  // "N个小时" / "N.N小时" → N * 60
  const hourFloat = normalized.match(/(\d+(?:\.\d+)?)\s*(?:个\s*)?小时/);
  if (hourFloat) return Math.round(parseFloat(hourFloat[1]) * 60);
  // "N分钟" / "N分" → N
  const min = normalized.match(/(\d+)\s*分(?:钟)?/);
  if (min) return parseInt(min[1], 10);
  // 纯数字兜底（上下文已确认是时间类指令时）
  const num = normalized.match(/(\d+)/);
  if (num) return parseInt(num[1], 10);
  return 0;
}

/**
 * 从语音文本中解析曲目数
 * 支持："3首歌"、"再听2首"、"5首"、"三首"
 * @returns 曲目数，解析失败返回 0
 */
export function parseSongsCount(text: string): number {
  const normalized = chineseToNumber(text);
  const m = normalized.match(/(\d+)\s*首/);
  if (m) return parseInt(m[1], 10);
  return 0;
}

/**
 * 从语音文本中解析"第 N 首"里的序号（1 起）。
 * 支持：“第 300 首”、“第五十首”、“跳到第一百二十”，仅在文本包含“第”锚点时命中。
 * 序号后仅允许“首/首歌”、空白和句末标点，避免把“第一周/第一天”等名称识别为位置。
 * 与 parseSongsCount 区分语义：本函数用于跳播位置，后者用于"再听 N 首后停"。
 * @returns 序号（>=1）；未识别返回 0
 */
export function parseSongIndex(text: string): number {
  const normalized = chineseToNumber(text);
  const start = normalized.indexOf('第');
  if (start < 0) return 0;
  const m = normalized.slice(start).match(/^第\s*(\d+)\s*(?:首(?:\s*歌)?)?\s*[。！？,.!?]*\s*$/);
  if (m) {
    const index = Number(m[1]);
    return Number.isSafeInteger(index) && index > 0 ? index : 0;
  }
  return 0;
}

/**
 * 判断语音文本是时间类还是曲目类
 * @returns 'time' | 'songs' | null
 */
export function detectSleepTimerMode(text: string): SleepTimerMode | null {
  if (/首/.test(text)) return 'songs';
  if (/分钟|分|小时|半/.test(text)) return 'time';
  return null;
}

/**
 * 格式化剩余时间为友好文案
 */
export function formatRemaining(state: SleepTimerState): string {
  if (!state.active) return '当前没有定时任务';
  if (state.mode === 'songs') {
    return `还剩${state.remaining}首后停止`;
  }
  const remainMin = Math.ceil(state.remaining / 60000);
  if (remainMin >= 60) {
    const h = Math.floor(remainMin / 60);
    const m = remainMin % 60;
    return m > 0 ? `还剩${h}小时${m}分钟后停止` : `还剩${h}小时后停止`;
  }
  return `还剩${remainMin}分钟后停止`;
}
