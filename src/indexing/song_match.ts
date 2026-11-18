import { segmentQuery, toPinyin } from './segmenter';
import { traditionalToSimplifiedMap } from '../data/traditional-to-simplified-map';

/** Voice matching score, not a statistical probability. */
export const DEFAULT_SONG_MATCH_THRESHOLD = 70;

export function normalizeSongMatchThreshold(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(100, value)) : DEFAULT_SONG_MATCH_THRESHOLD;
}

function normalize(text: string): string {
  const digits: Record<string, string> = { '零': '0', '〇': '0', '一': '1', '二': '2', '两': '2', '三': '3', '四': '4', '五': '5', '六': '6', '七': '7', '八': '8', '九': '9' };
  return Array.from(text || '', ch => traditionalToSimplifiedMap[ch] ?? ch).join('')
    .toLowerCase().replace(/[零〇一二两三四五六七八九]/g, ch => digits[ch])
    .replace(/[\s\p{P}\p{S}]/gu, '');
}

function similarity(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 0;i < a.length;i++) {
    const next = [i + 1];
    for (let j = 0;j < b.length;j++) {
      next.push(Math.min(next[j] + 1, row[j + 1] + 1, row[j] + (a[i] === b[j] ? 0 : 1)));
    }
    row = next;
  }
  return 1 - row[b.length] / Math.max(a.length, b.length);
}

function fieldScore(query: string, field: string, phonetics: Map<string, string[]>): number {
  if (!query || !field) return 0;
  if (query === field) return 100;
  if (field.includes(query)) return 95;
  const q = Array.from(query), f = Array.from(field);
  // A returned short title must cover the requested title, rather than win by substring alone.
  if (query.includes(field)) return 90 * f.length / q.length;
  if (q.length < 2 || f.length < 2) return 0;
  const literal = similarity(q, f) * 100;
  // Compare syllables rather than letters so unrelated pinyin prefixes cannot inflate the score.
  const syllables = (text: string): string[] => {
    let value = phonetics.get(text);
    if (!value) { value = toPinyin(text).split(' '); phonetics.set(text, value); }
    return value;
  };
  const phonetic = similarity(syllables(query), syllables(field)) * 95;
  return Math.max(literal, phonetic);
}

export function prepareSongMatch(query: string): (title: string, artist: string) => number {
  const tokens = segmentQuery(query).map(normalize).filter(Boolean);
  const wholeQuery = normalize(query);
  const phonetics = new Map<string, string[]>();
  return (title, artist) => {
    if (!tokens.length) return 0;
    const t = normalize(title), a = normalize(artist);
    if (wholeQuery === t || (a && (wholeQuery === t + a || wholeQuery === a + t))) return 100;
    let total = 0;
    for (const token of tokens) {
      const combined = a && (token === t + a || token === a + t) ? 95 : 0;
      const score = token === t ? 100 : Math.max(fieldScore(token, t, phonetics), fieldScore(token, a, phonetics) * 0.9, combined);
      if (score === 0 && Array.from(token).length >= 2) return 0;
      total += score;
    }
    return total / tokens.length;
  };
}

export function songMatchScore(query: string, title: string, artist: string = ''): number {
  return prepareSongMatch(query)(title, artist);
}

/** 最多尝试三个连接词位置；原始标题优先，保留“的”属于歌名的可能。 */
export function artistTitleQueries(text: string): { artist: string; title: string }[] {
  const result: { artist: string; title: string }[] = [];
  if (text.length > 120) return result;
  for (let i = 1; i < text.length - 1 && result.length < 3; i++) {
    if (text[i] !== '的') continue;
    const artist = text.slice(0, i).trim(), title = text.slice(i + 1).trim();
    if (artist && title) result.push({ artist, title });
  }
  return result;
}
