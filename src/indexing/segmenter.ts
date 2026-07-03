// MIoT 智能音箱插件 - 中文分词 + 拼音封装
// 隔离 NLP 依赖（segmentit 分词 / pinyin-pro 拼音），供索引与口令搜索复用。
// 设计原则：重 NLP（分词/拼音）在索引构建期做一次并预计算，查询期只对短 query 现算。

/// <reference types="@songloft/plugin-sdk" />

// 直接引 ESM 构建产物：plugin-builder(esbuild) 用 platform:neutral，不解析 segmentit 的 main 字段
import { Segment, useDefault, POSTAG } from 'segmentit/dist/esm/segmentit.js';
import { pinyin } from 'pinyin-pro';

// segmentit 单例：懒初始化，累积加载通用词典 + 曲库自建词典
let segInstance: Segment | null = null;

function getSegment(): Segment {
  if (!segInstance) {
    segInstance = useDefault(new Segment());
  }
  return segInstance;
}

/**
 * 口语停用词/助词：分词后剔除。
 * segmentit 自带停用词偏书面，这里补口令场景常见的动词/量词/助词，
 * 避免「放一下周杰伦那首晴天」里的「放/一下/那首」污染匹配。
 * 注意：故意不含「的」交给覆盖逻辑，也不含可能是歌名一部分的字。
 */
const EXTRA_STOPWORDS = new Set<string>([
  '我', '你', '他', '她', '想', '要', '听', '想听', '放', '播', '播放',
  '来', '点', '首', '那', '这', '那首', '这首', '一首', '一下', '一',
  '了', '吧', '啊', '嘛', '呢', '请', '帮', '帮我', '给', '给我',
  '唱', '歌', '歌曲', '音乐', '换', '再', '给我来', '来一首', '来首',
  // 单字功能词：作为独立 token 无意义（成词的一部分不受影响，分词器不会切开）
  '的', '和', '与', '跟', '或', '着', '把',
]);

/**
 * 把曲库词汇注入分词器自定义词典，让冷门歌名/歌手（如「孤勇者」「單依純」）正确成词。
 * segmentit loadDict 行格式：`词|词性|词频`。每次索引刷新调用；词典按词去重累积（幂等）。
 * @param words - title/artist/album 原始值集合（可含重复）
 */
export function loadDomainDict(words: string[]): void {
  const seg = getSegment();
  const posNoun = POSTAG.D_N; // 名词
  const seen = new Set<string>();
  const lines: string[] = [];

  for (const raw of words) {
    const w = (raw || '').trim();
    // 单字不注入（噪声）；含分隔符/换行会破坏 loadDict 行格式，跳过
    if (w.length < 2) continue;
    if (w.includes('|') || w.includes('\n') || w.includes('\r')) continue;
    if (seen.has(w)) continue;
    seen.add(w);
    lines.push(`${w}|${posNoun}|100`);
  }

  if (lines.length > 0) {
    seg.loadDict(lines.join('\n'));
  }
}

/**
 * 对 query 分词并剔除口语停用词，返回有意义 token 列表。
 * 分词失败或结果全被过滤时回退为「按空格/中文标点切分」，保证不返回空。
 */
export function segmentQuery(query: string): string[] {
  const q = (query || '').trim();
  if (!q) return [];

  let words: string[];
  try {
    words = getSegment().doSegment(q, { simple: true, stripPunctuation: true });
  } catch (e) {
    songloft.log.warn('[segmenter] doSegment failed, fallback to split: ' + String(e));
    words = q.split(/[\s，,、]+/);
  }

  const out: string[] = [];
  for (const w of words) {
    const t = (w || '').trim();
    if (!t || EXTRA_STOPWORDS.has(t)) continue;
    out.push(t);
  }

  // 全是停用词（如纯口语）时回退原始分词，避免 query 变空导致零命中
  if (out.length === 0) {
    return words.map(w => (w || '').trim()).filter(w => w.length > 0);
  }
  return out;
}

/**
 * 转拼音（无声调，音节以空格分隔，小写）。非中文原样保留。
 * 用于索引期预计算字段拼音与查询期 token 拼音，做同音字模糊匹配。
 * @returns 拼音串，失败返回空串
 */
export function toPinyin(text: string): string {
  const t = (text || '').trim();
  if (!t) return '';
  try {
    const arr = pinyin(t, { toneType: 'none', type: 'array', nonZh: 'consecutive' }) as string[];
    return arr.join(' ').trim().toLowerCase();
  } catch (e) {
    songloft.log.warn('[segmenter] toPinyin failed: ' + String(e));
    return '';
  }
}
