import { toPinyin } from '../indexing/segmenter';

const PREFIXES = [
  '帮我播放一下',
  '帮我放一下',
  '给我播放一下',
  '给我播放',
  '我想听',
  '我要听',
  '来一首',
  '放一首',
  '听一下',
  '播放一下',
  '播放',
  '来首',
  '放一下',
  '放',
].sort((a, b) => Array.from(b).length - Array.from(a).length);

const SUFFIXES = ['可以吗', '好吗', '谢谢', '一下吧']
  .sort((a, b) => Array.from(b).length - Array.from(a).length);

function foldFullWidth(value: string): string {
  return Array.from(value || '').map(ch => {
    const code = ch.charCodeAt(0);
    if (code === 0x3000) return ' ';
    if (code >= 0xff01 && code <= 0xff5e) {
      return String.fromCharCode(code - 0xfee0);
    }
    return ch;
  }).join('');
}

/** Stable text key for known song and artist entities. Keeps meaningful Chinese characters such as "的". */
export function normalizeEntityText(value: string): string {
  return foldFullWidth(value)
    .toLowerCase()
    .replace(/[\s　《》【】「」『』〔〕〈〉（）()\[\]{}，,。.、·!！?？~～—\-_:：;；'"`“”‘’…]/g, '')
    .trim();
}

export interface NormalizedMemoryQuery {
  originalQuery: string;
  semanticText: string;
  wrapperStripped: boolean;
  pinyin: string;
}

/** Removes only anchored, explicit playback wrappers. It never globally removes words or the character "的". */
export function normalizeMemoryQuery(query: string): NormalizedMemoryQuery {
  const originalQuery = query || '';
  let semanticText = normalizeEntityText(originalQuery);
  let wrapperStripped = false;

  for (const prefix of PREFIXES) {
    const normalizedPrefix = normalizeEntityText(prefix);
    if (semanticText.startsWith(normalizedPrefix) && semanticText.length > normalizedPrefix.length) {
      semanticText = semanticText.slice(normalizedPrefix.length);
      wrapperStripped = true;
      break;
    }
  }

  for (const suffix of SUFFIXES) {
    const normalizedSuffix = normalizeEntityText(suffix);
    if (semanticText.endsWith(normalizedSuffix) && semanticText.length > normalizedSuffix.length) {
      semanticText = semanticText.slice(0, -normalizedSuffix.length);
      wrapperStripped = true;
      break;
    }
  }

  return {
    originalQuery,
    semanticText,
    wrapperStripped,
    pinyin: compactPinyin(semanticText),
  };
}

export function compactPinyin(value: string): string {
  return toPinyin(value).replace(/\s+/g, '').toLowerCase();
}

export function isChineseName(value: string): boolean {
  const chars = Array.from(value);
  return chars.length >= 3 && chars.every(ch => /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(ch));
}

export function readableKeyPart(value: string): string {
  return encodeURIComponent(value).replace(/%/g, '~');
}
