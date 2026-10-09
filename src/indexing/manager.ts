// MIoT 智能音箱插件 - 索引管理模块
// 从 Songloft 主程序API获取歌曲/歌单数据，建立内存索引，提供模糊搜索

/// <reference types="@songloft/plugin-sdk" />

import { segmentQuery, toPinyin } from './segmenter';
import { traditionalToSimplifiedMap } from '../data/traditional-to-simplified-map';

// ===== 类型定义 =====

/** 索引中的歌曲信息 */
export interface IndexedSong {
  id: number;
  title: string;
  artist: string;
  album: string;
  titleLower: string;   // 归一化匹配键（简体+小写+剥装饰标点），字段名沿用 Lower
  artistLower: string;  // 归一化匹配键
  albumLower: string;   // 归一化匹配键
  titlePinyin: string;  // 拼音（无声调、空格分隔）用于同音字匹配
  artistPinyin: string;
  albumPinyin: string;
}

/** 按歌手搜索的歌曲位置信息 */
export interface ArtistSongLocation {
  songId: number;
  playlistId: number;
  songTitle: string;
  artist: string;
}

/** 歌曲在歌单中的位置信息（用于语音口令播放歌曲） */
export interface SongLocation {
  songId?: number;
  playlistId: number;
  playlistName: string;
  songIndex: number;
  songTitle: string;
  artist: string;
}

/** 索引中的歌单信息 */
export interface IndexedPlaylist {
  id: number;
  name: string;
  nameLower: string;    // 小写化用于搜索
  songCount: number;
}

/** 歌单内歌曲缓存条目（预建小写字段供搜歌热路径复用，避免逐首 toLowerCase） */
interface CachedPlaylistSong {
  id: number;
  title: string;
  artist: string;
  album: string;
  titleLower: string;
  artistLower: string;
  albumLower: string;
  titlePinyin: string;
  artistPinyin: string;
  albumPinyin: string;
}

/** 索引状态（字段名使用蛇形式，与 WASM 版保持一致） */
export interface IndexStatus {
  ready: boolean;
  song_count: number;
  playlist_count: number;
  last_refresh_time: string;
  is_refreshing: boolean;
  /** 歌单歌曲缓存（歌曲→所在歌单位置）是否已完整跑过一轮 */
  playlist_cache_ready: boolean;
  /** 已加载进缓存的歌单数（诊断用：与 playlist_count 对比可看加载进度） */
  playlist_cache_loaded: number;
}

type RefreshResult = { success: boolean; songCount: number; playlistCount: number };

/** 模糊搜索评分结果（内部使用） */
interface ScoredResult<T> {
  item: T;
  score: number;
}

// ===== 模糊搜索算法 =====

/**
 * 编辑距离核心：接收已 Array.from 的 rune 数组，使用两行滚动数组优化空间。
 * 热路径调用方（歌曲搜索）预先拆好 rune 数组复用，避免每次比较重复 Array.from。
 */
function levenshteinRunes(ra: string[], rb: string[]): number {
  const la = ra.length;
  const lb = rb.length;

  if (la === 0) return lb;
  if (lb === 0) return la;

  let prev = new Array<number>(lb + 1);
  let curr = new Array<number>(lb + 1);

  for (let j = 0; j <= lb; j++) {
    prev[j] = j;
  }

  for (let i = 1; i <= la; i++) {
    curr[0] = i;
    for (let j = 1; j <= lb; j++) {
      const cost = ra[i - 1] === rb[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1] + 1,   // 删除
        prev[j] + 1,       // 插入
        prev[j - 1] + cost, // 替换
      );
    }
    // 交换行
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }

  return prev[lb];
}

/**
 * 计算两个已小写化字符串的相似度 (0.0 ~ 1.0)
 * similarity = 1 - distance / max(len(a), len(b))
 * 各 Array.from 一次并复用给编辑距离，避免原实现里 toLowerCase/Array.from 各 4 次。
 */
function similarityLower(aLower: string, bLower: string): number {
  const ra = Array.from(aLower);
  const rb = Array.from(bLower);
  const maxLen = Math.max(ra.length, rb.length);
  if (maxLen === 0) return 1.0;
  return 1.0 - levenshteinRunes(ra, rb) / maxLen;
}

/**
 * 三级模糊搜索评分（参考Go实现的 fuzzySearch）
 *
 * 1. 精确匹配（忽略大小写）：得分 100
 * 2. 包含匹配（忽略大小写）：
 *    - 候选项包含关键词：50 + 1/rune长度
 *    - 关键词包含候选项：40 + 1/rune长度
 * 3. 编辑距离模糊匹配：similarity > 0.5 时得分 similarity * 30
 *
 * @returns 得分，0 表示不匹配
 */
function fuzzyScoreLower(keywordLower: string, candidateLower: string): number {
  if (!keywordLower || !candidateLower) return 0;

  // 第一级：精确匹配
  if (candidateLower === keywordLower) {
    return 100.0;
  }

  // 第二级：包含匹配
  if (candidateLower.includes(keywordLower)) {
    const runeLen = Array.from(candidateLower).length;
    return runeLen > 0 ? 50.0 + 1.0 / runeLen : 50.0;
  }

  // 第二级变体：关键词包含候选项
  if (keywordLower.includes(candidateLower)) {
    const runeLen = Array.from(candidateLower).length;
    return runeLen > 0 ? 40.0 + 1.0 / runeLen : 40.0;
  }

  // 第三级：编辑距离模糊匹配
  const sim = similarityLower(keywordLower, candidateLower);
  if (sim > 0.5) {
    return sim * 30.0;
  }

  return 0;
}

/**
 * 对候选列表进行模糊搜索，支持分词（空格分隔的所有词都需匹配）
 * 返回按得分降序排列的匹配结果
 */
function fuzzySearchList<T>(
  query: string,
  items: T[],
  getText: (item: T) => string,
  limit: number,
  normalizeText: (text: string) => string = text => text.toLowerCase(),
): T[] {
  if (!query || items.length === 0) return [];

  const queryTrimmed = query.trim();
  if (!queryTrimmed) return [];

  // 分词：按空格与中文标点分词（不分"的"，因其常是歌名/歌单名的一部分）
  const terms = queryTrimmed.split(/[\s，,、]+/).filter(t => t.length > 0);
  if (terms.length === 0) return [];

  const scored: ScoredResult<T>[] = [];

  for (const item of items) {
    const textLower = normalizeText(getText(item));

    if (terms.length === 1) {
      // 单词直接评分
      const score = fuzzyScoreLower(normalizeText(terms[0]), textLower);
      if (score > 0) {
        scored.push({ item, score });
      }
    } else {
      // 多词搜索：所有词都需要在目标中出现（子串包含），取最低分
      let allMatch = true;
      let minScore = Infinity;

      for (const term of terms) {
        const termLower = normalizeText(term);
        if (!textLower.includes(termLower)) {
          allMatch = false;
          break;
        }
        const s = fuzzyScoreLower(termLower, textLower);
        if (s < minScore) minScore = s;
      }

      if (allMatch && minScore > 0) {
        scored.push({ item, score: minScore });
      }
    }
  }

  // 按得分降序排列
  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, limit).map(s => s.item);
}

// ===== 索引管理器 =====

/** 搜索结果最大返回数 */
const MAX_SEARCH_RESULTS = 10;

/** 最低匹配分数阈值 — 低于此分数的模糊匹配视为无效（编辑距离噪声最高约 30，子串匹配 40+） */
const MIN_MATCH_SCORE = 40;

/** 歌曲三字段在综合评分中的权重（标题最重，专辑最轻） */
const FIELD_WEIGHT = { title: 1.0, artist: 0.85, album: 0.7 } as const;

/** 单 token 参与拼音/编辑距离模糊匹配的最小 rune 长度（单字太短，同音/编辑噪声高） */
const TOKEN_FUZZY_MIN_LEN = 2;

/** 轻量索引构建分片大小：只做字段整理/小写，批量让出 QuickJS VM。 */
const LIGHT_INDEX_BATCH_SIZE = 300;

/** 歌单歌曲预拉并发数，避免一次性 Promise.all 压垮低配机器。 */
const PLAYLIST_FETCH_CONCURRENCY = 3;

/**
 * 搜歌热路径等待「歌单歌曲缓存首次加载完成」的预算。
 * 只在插件启动后第一次搜歌前生效（闩锁一旦翻转就永久为 true），所以这笔延迟是一次性的。
 * 不要设得比 INDEX_READY_WAIT_MS 大——语音口令的总响应预算有限。
 */
const PLAYLIST_CACHE_WAIT_MS = 3000;

/** 独立歌曲 miss 后的全量刷新冷却，避免每条未命中口令都重建索引。 */
const STANDALONE_REFRESH_COOLDOWN_MS = 60_000;

/** 歌单 miss 后的全量刷新冷却，避免每条未命中口令都重建索引（与独立歌曲路径对称）。 */
const PLAYLIST_REFRESH_COOLDOWN_MS = 60_000;

/** 进程内拼音缓存：跨 refresh 复用，避免同一歌手/歌名反复转拼音。 */
const PINYIN_CACHE_LIMIT = 20000;

const CHINESE_DIGIT_MAP: Record<string, string> = {
  '〇': '0', '零': '0', '一': '1', '二': '2', '三': '3',
  '四': '4', '五': '5', '六': '6', '七': '7', '八': '8', '九': '9',
  '两': '2',
};

function normalizeChineseDigits(s: string): string {
  return Array.from(s).map(ch => CHINESE_DIGIT_MAP[ch] ?? ch).join('');
}
const pinyinCache = new Map<string, string>();

/** query 分词结果（token + 预转拼音，len<2 的 token 拼音留空不参与拼音匹配） */
interface QueryTokens {
  tokens: string[];
  pys: string[];
}

function yieldToRuntime(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function rememberPinyin(key: string, value: string): void {
  if (pinyinCache.size >= PINYIN_CACHE_LIMIT) {
    const oldest = pinyinCache.keys().next().value;
    if (oldest !== undefined) {
      pinyinCache.delete(oldest);
    }
  }
  pinyinCache.set(key, value);
}

function getCachedPinyin(text: string): string {
  const key = (text || '').trim();
  if (!key) return '';

  const cached = pinyinCache.get(key);
  if (cached !== undefined) {
    return cached;
  }

  const value = toPinyin(key);
  rememberPinyin(key, value);
  return value;
}

/**
 * 匹配用归一化：繁体折叠为简体、转小写并剥离空格、装饰性括号与标点。
 * 查询与索引使用同一静态字表，避免简繁差异被字面校验拒绝；不放宽同音字匹配。
 * 使「明天，你好」「《明天你好》」「【Hi-res】」这类装饰标题能与纯歌名 query 连续子串比对
 * （例如外部搜索导入的 B 站装饰标题）。只用于生成匹配字段，不影响展示用的原始 title。
 */
function normalizeForMatch(s: string): string {
  return Array.from(s || '', ch => traditionalToSimplifiedMap[ch] ?? ch).join('')
    .toLowerCase()
    .replace(/[\s　《》【】「」『』〔〕〈〉（）()\[\]{}，,。.、·!！?？~～—\-_:：;；'"'"…]/g, '');
}

/** 对 query 分词并预算每个 token 的拼音，供跨字段匹配复用（每次搜索算一次） */
function tokenizeQuery(query: string): QueryTokens {
  // token 与索引匹配字段用同一归一化，保证「明天你好」能命中装饰标题「明天，你好」。
  const tokens = segmentQuery(query).map(normalizeForMatch).filter(t => t.length > 0);
  const pys = tokens.map(t => (Array.from(t).length >= TOKEN_FUZZY_MIN_LEN ? getCachedPinyin(t) : ''));
  return { tokens, pys };
}

function isCJKRune(ch: string): boolean {
  const cp = ch.codePointAt(0) ?? 0;
  return (cp >= 0x3400 && cp <= 0x4dbf) || (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0xf900 && cp <= 0xfaff);
}

function isCJKDirectMatch(tokens: string[], titleLower: string, artistLower: string): boolean {
  const directText = titleLower + artistLower;
  for (const token of tokens) {
    for (const ch of Array.from(token)) {
      if (isCJKRune(ch) && !directText.includes(ch)) {
        return false;
      }
    }
  }
  return true;
}

/**
 * 单个 token 对单个字段的匹配强度（0..1，未含字段权重）。
 * 逐级：完全相等 → 字段含 token → token 含字段 → 编辑距离模糊 → 拼音。
 */
function matchTokenStrength(token: string, tokenPy: string, fieldLower: string, fieldPy: string): number {
  if (!fieldLower || !token) return 0;

  if (fieldLower === token) return 1.0;
  if (fieldLower.includes(token)) return 0.9;

  const isFuzzyable = Array.from(token).length >= TOKEN_FUZZY_MIN_LEN;

  if (isFuzzyable && Array.from(fieldLower).length >= 2 && token.includes(fieldLower)) {
    return 0.7;
  }

  if (isFuzzyable) {
    // 编辑距离模糊（错别字，如"稻香"↔"到香"）
    const sim = similarityLower(token, fieldLower);
    if (sim >= 0.6) return sim * 0.7;

    // 拼音层：主要服务 xiaoyu 这类拉丁拼音输入；中文 query 会先经过字面校验，避免同音字误播。
    if (tokenPy && fieldPy) {
      if (fieldPy.includes(tokenPy)) return 0.62;
      const simPy = similarityLower(tokenPy, fieldPy);
      if (simPy >= 0.75) return simPy * 0.55;
    }
  }

  return 0;
}

/**
 * token 跨字段覆盖评分（0..100）。
 *
 * 对每个 token 取 title/artist/album 三字段加权后的最佳命中；语义为"有意义 token 全命中"（AND）：
 * - 任一 rune 长度 ≥2 的 token 完全落空 → 判该歌不匹配返回 0（精度优先，天然排除"林俊杰 她说"误匹配"小酒窝"）
 * - 单字 token 落空不否决（多为口语残余）
 * 最终得分 = 命中 token 的加权强度按 token 总数平均 ×100。
 *
 * 由此天然支持：歌手+歌名连读（分词切开）、词序颠倒（跨字段各自命中）、只说歌手（token 全落 artist 即命中）。
 */
function scoreSongTokens(
  q: QueryTokens,
  titleLower: string, artistLower: string, albumLower: string,
  titlePy: string, artistPy: string, albumPy: string,
): number {
  const { tokens, pys } = q;
  if (tokens.length === 0) return 0;
  if (!isCJKDirectMatch(tokens, titleLower, artistLower)) return 0;

  let weightedSum = 0;
  let matched = 0;

  for (let i = 0; i < tokens.length; i++) {
    const tk = tokens[i];
    const py = pys[i];
    const st = Math.max(
      FIELD_WEIGHT.title * matchTokenStrength(tk, py, titleLower, titlePy),
      FIELD_WEIGHT.artist * matchTokenStrength(tk, py, artistLower, artistPy),
      FIELD_WEIGHT.album * matchTokenStrength(tk, py, albumLower, albumPy),
    );
    if (st > 0) {
      matched++;
      weightedSum += st;
    } else if (Array.from(tk).length >= TOKEN_FUZZY_MIN_LEN) {
      return 0; // 有意义 token 落空 → AND 语义拒绝
    }
  }

  if (matched === 0) return 0;
  return (weightedSum / tokens.length) * 100;
}

/**
 * 索引管理器
 * 从 Songloft 宿主API获取歌曲/歌单数据，建立内存索引，提供模糊搜索
 */
export class IndexingManager {
  private configManager: import('../config/manager').ConfigManager | null;
  private songs: IndexedSong[] = [];
  private playlists: IndexedPlaylist[] = [];
  private playlistSongsCache: Map<number, CachedPlaylistSong[]> = new Map();
  private lastRefreshTime: number = 0;
  private isRefreshing: boolean = false;
  private indexReady: boolean = false;
  private lastStandaloneRefreshTime: number = 0;
  private lastPlaylistRefreshTime: number = 0;
  private pendingRefreshPromise: Promise<RefreshResult> | null = null;

  // ===== 歌单歌曲缓存的加载状态机 =====
  // 加载轮次刻意与 refresh 解耦：旧实现把缓存加载挂在 refresh 代际（refreshGeneration）上，
  // 任何一次新 refresh 都会把在飞的加载整轮丢弃重来，而 findStandaloneSongByName 每次 miss
  // 都会 refresh 一次 → 大曲库/低配机上缓存永远加载不完
  // （songloft-org/songloft-plugin-miot#62 的活锁）。
  /** 当前生效的加载轮次；旧轮次发现 token 变了就自行退出。 */
  private playlistCacheToken: number = 0;
  private playlistCacheLoading: boolean = false;
  /** 「至少完整跑过一轮」的闩锁，一旦 true 不再回落（否则搜歌会反复白等）。 */
  private playlistCacheReady: boolean = false;
  private playlistCacheLoadedIds: Set<number> = new Set();
  /** 启动本轮加载时的歌单 id 集合指纹，用于判定「在飞的加载还算不算数」。 */
  private playlistCacheSignature: string = '';
  /** 加载期间又来了 refresh：跑完后补一轮，把期间的变更捡回来。 */
  private playlistCacheRevalidate: boolean = false;

  constructor(configManager?: import('../config/manager').ConfigManager) {
    this.configManager = configManager ?? null;
  }

  private async buildSongIndex(rawSongs: any[]): Promise<IndexedSong[]> {
    const out: IndexedSong[] = [];
    for (let i = 0; i < rawSongs.length; i++) {
      const song = rawSongs[i];
      const title = song.title ?? '';
      const artist = song.artist ?? '';
      const album = song.album ?? '';
      const titleNorm = normalizeForMatch(title);
      const artistNorm = normalizeForMatch(artist);
      const albumNorm = normalizeForMatch(album);
      out.push({
        id: song.id,
        title,
        artist,
        album,
        titleLower: titleNorm,
        artistLower: artistNorm,
        albumLower: albumNorm,
        titlePinyin: getCachedPinyin(titleNorm),
        artistPinyin: getCachedPinyin(artistNorm),
        albumPinyin: getCachedPinyin(albumNorm),
      });

      if (i > 0 && i % LIGHT_INDEX_BATCH_SIZE === 0) {
        await yieldToRuntime();
      }
    }
    return out;
  }

  private async buildCachedPlaylistSongs(rawSongs: any[]): Promise<CachedPlaylistSong[]> {
    const out: CachedPlaylistSong[] = [];
    for (let i = 0; i < rawSongs.length; i++) {
      const s = rawSongs[i];
      const title = (s as any).title ?? '';
      const artist = (s as any).artist ?? '';
      const album = (s as any).album ?? '';
      const titleNorm = normalizeForMatch(title);
      const artistNorm = normalizeForMatch(artist);
      const albumNorm = normalizeForMatch(album);
      out.push({
        id: s.id,
        title,
        artist,
        album,
        titleLower: titleNorm,
        artistLower: artistNorm,
        albumLower: albumNorm,
        titlePinyin: getCachedPinyin(titleNorm),
        artistPinyin: getCachedPinyin(artistNorm),
        albumPinyin: getCachedPinyin(albumNorm),
      });

      if (i > 0 && i % LIGHT_INDEX_BATCH_SIZE === 0) {
        await yieldToRuntime();
      }
    }
    return out;
  }

  /**
   * 把已不存在的歌单从缓存里剪掉。
   * 增量提交后缓存不再被整体替换，失效条目只能这样显式收敛。
   */
  private prunePlaylistCache(playlists: IndexedPlaylist[]): void {
    const alive = new Set(playlists.map(p => p.id));
    for (const id of Array.from(this.playlistSongsCache.keys())) {
      if (!alive.has(id)) {
        this.playlistSongsCache.delete(id);
        this.playlistCacheLoadedIds.delete(id);
      }
    }
  }

  /**
   * 逐歌单加载并**增量提交**进正在使用的缓存。
   *
   * 刻意不用「影子 Map 加载完再整体替换」：那样中途被取代就一个歌单也留不下，
   * 而搜歌恰好需要「有多少用多少」。增量提交后即使这一轮被打断，已提交的歌单继续可命中。
   */
  private async runPlaylistCacheLoad(token: number, playlists: IndexedPlaylist[]): Promise<void> {
    const start = Date.now();
    let loaded = 0;
    let failed = 0;
    let next = 0;
    const workerCount = Math.min(PLAYLIST_FETCH_CONCURRENCY, Math.max(1, playlists.length));

    const worker = async (): Promise<void> => {
      while (true) {
        if (token !== this.playlistCacheToken) return;  // 歌单集合已变，本轮作废
        const idx = next++;
        if (idx >= playlists.length) return;

        const pl = playlists[idx];
        try {
          const plSongs = (await songloft.playlists.getSongs(pl.id, { limit: 100000, brief: true } as any)) ?? [];
          if (token !== this.playlistCacheToken) return;
          this.playlistSongsCache.set(pl.id, await this.buildCachedPlaylistSongs(plSongs));
          this.playlistCacheLoadedIds.add(pl.id);
          loaded++;
        } catch (e) {
          failed++;
          songloft.log.warn(`歌单歌曲缓存: 获取歌单歌曲失败 playlist_id=${pl.id}: ${e instanceof Error ? e.message : String(e)}`);
        }
        await yieldToRuntime();
      }
    };

    try {
      await Promise.all(Array.from({ length: workerCount }, () => worker()));
    } finally {
      // 收尾只有仍是当前轮次才做。被取代的旧轮次绝不能把 playlistCacheLoading 置回 false——
      // 新轮次正在跑，擦掉标志会让 waitForPlaylistCache 的兜底重复启动加载。
      if (token === this.playlistCacheToken) {
        this.prunePlaylistCache(playlists);

        // 只有「跑完了一遍当前已知的歌单集合」才算就绪。空集合 + 索引还没建起来
        // （playlists 尚未从宿主拉到）不能 latch：否则闩锁提前翻转，之后 refresh 带来
        // 真正的歌单时搜歌不再等待，又会退化成独立歌曲直推。
        // 空曲库（refresh 完确实零歌单）仍要 latch，否则每次搜歌白等满预算。
        const coveredKnownSet = playlists.length > 0 || this.indexReady;
        const firstReady = coveredKnownSet && !this.playlistCacheReady;
        if (coveredKnownSet) {
          this.playlistCacheReady = true;
        }
        this.playlistCacheLoading = false;

        const line = `歌单歌曲缓存加载完成: playlists=${this.playlistSongsCache.size} loaded=${loaded} failed=${failed} pinyinCache=${pinyinCache.size} (${Date.now() - start}ms)`;
        // 首次就绪是个关键里程碑（本地搜歌从此刻起才能定位歌单位置），提到 warn 让
        // log level=warn 的用户也能看到；后续 revalidate 保持 info 不刷屏。
        if (firstReady) songloft.log.warn(line + ' [首次就绪]');
        else songloft.log.info(line);

        if (this.playlistCacheRevalidate) {
          this.playlistCacheRevalidate = false;
          this.schedulePlaylistCacheLoad(this.playlists);
        }
      }
    }
  }

  /**
   * 调度一轮歌单歌曲缓存加载。
   * 歌单集合未变且已有加载在飞 → 只标记「跑完补一轮」，**不重启**。
   */
  private schedulePlaylistCacheLoad(playlists: IndexedPlaylist[]): void {
    const signature = playlists.map(p => p.id).sort((a, b) => a - b).join(',');

    if (this.playlistCacheLoading) {
      if (signature === this.playlistCacheSignature) {
        this.playlistCacheRevalidate = true;
        songloft.log.info('歌单歌曲缓存: 已有加载在进行且歌单集合未变，跑完后补一轮');
        return;
      }
      songloft.log.info('歌单歌曲缓存: 歌单集合已变，作废在飞加载并重启（已提交条目原地保留）');
    }

    this.playlistCacheSignature = signature;
    this.playlistCacheLoading = true;
    // 新一轮本身就会覆盖全部歌单，清掉待补标记；否则「A 在飞 → schedule(同指纹) 置位
    // → schedule(异指纹) 起 B」之后，B 收尾还会白跑一整轮 C。
    this.playlistCacheRevalidate = false;
    const token = ++this.playlistCacheToken;
    this.runPlaylistCacheLoad(token, playlists).catch(e => {
      songloft.log.warn(`歌单歌曲缓存后台加载异常: ${e instanceof Error ? e.message : String(e)}`);
      if (token === this.playlistCacheToken) {
        this.playlistCacheLoading = false;
      }
    });
  }

  /**
   * 刷新索引（从宿主API获取最新数据）
   * @returns 刷新结果
   */
  async refresh(): Promise<RefreshResult> {
    if (this.pendingRefreshPromise) {
      return this.pendingRefreshPromise;
    }

    const promise = this.doRefresh();
    this.pendingRefreshPromise = promise;
    try {
      return await promise;
    } finally {
      if (this.pendingRefreshPromise === promise) {
        this.pendingRefreshPromise = null;
      }
    }
  }

  private async doRefresh(): Promise<RefreshResult> {
    this.isRefreshing = true;
    try {
      // 1. 获取歌单列表（桥接直接返回数组）
      const rawPlaylists = (await songloft.playlists.list()) ?? [];

      // 2. 获取歌曲列表（桥接直接返回数组）
      let songLimit = 10000;
      if (this.configManager) {
        try {
          const cfg = await this.configManager.getConfig();
          songLimit = Math.max(1000, Math.min(100000, cfg.max_song_index ?? 10000));
        } catch {}
      }
      const rawSongs = (await songloft.songs.list({ limit: songLimit })) ?? [];

      // 3. 构建轻量歌单/歌曲索引。这里只做字段整理与小写化，确保低配机器先 ready。
      const newPlaylists: IndexedPlaylist[] = rawPlaylists.map(pl => ({
        id: pl.id,
        name: pl.name,
        nameLower: pl.name.toLowerCase(),
        songCount: (pl as any).song_count ?? (pl as any).songCount ?? 0,
      }));
      const newSongs = await this.buildSongIndex(rawSongs);

      // 4. 歌曲列表到达后立即 ready；歌单歌曲缓存改为后台加载，避免低配设备长时间阻塞。
      this.playlists = newPlaylists;
      this.songs = newSongs;
      this.lastRefreshTime = Date.now();
      this.indexReady = true;

      // 已删除的歌单立刻从缓存里剪掉。改成增量提交后缓存不再被整体替换，若只等轮次收尾
      // 才收敛，findSongsByArtist / findSongByName 会在整轮加载期间一直返回失效歌单的位置。
      this.prunePlaylistCache(newPlaylists);
      this.schedulePlaylistCacheLoad(newPlaylists);

      songloft.log.info(`轻量索引构建完成: playlists=${newPlaylists.length} songs=${newSongs.length}, 歌单歌曲缓存后台加载已启动`);
      return { success: true, songCount: newSongs.length, playlistCount: newPlaylists.length };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      songloft.log.warn(`索引刷新失败: ${msg}`);
      if (this.songs.length === 0 && this.playlists.length === 0) {
        this.indexReady = false;
      }
      return { success: false, songCount: this.songs.length, playlistCount: this.playlists.length };
    } finally {
      this.isRefreshing = false;
    }
  }

  async waitForReady(timeoutMs = 5000): Promise<boolean> {
    if (this.indexReady) {
      return true;
    }

    const deadline = Date.now() + Math.max(0, timeoutMs);
    if (!this.pendingRefreshPromise) {
      void this.refresh();
    }

    while (!this.indexReady && Date.now() < deadline) {
      const remaining = deadline - Date.now();
      await sleep(Math.min(100, Math.max(1, remaining)));
    }

    return this.indexReady;
  }

  /**
   * 等歌单歌曲缓存首次加载完成。
   *
   * 「歌曲 → 所在歌单第几首」只能靠这份缓存回答。缓存未就绪时 findSongByName 会把
   * 「查不到位置」误判成「这首歌不在任何歌单」，从而把一首本地歌当独立远程歌曲直推
   * （songloft-org/songloft-plugin-miot#62）。所以凡是依赖歌单位置的路径都要先等一等。
   *
   * 零歌单时一轮加载瞬间完成并 latch ready，不会让空曲库每次搜歌白等满预算。
   */
  async waitForPlaylistCache(timeoutMs = PLAYLIST_CACHE_WAIT_MS): Promise<boolean> {
    if (this.playlistCacheReady) return true;
    if (!this.playlistCacheLoading) {
      this.schedulePlaylistCacheLoad(this.playlists);
    }

    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (!this.playlistCacheReady && Date.now() < deadline) {
      const remaining = deadline - Date.now();
      await sleep(Math.min(50, Math.max(1, remaining)));
    }

    if (!this.playlistCacheReady) {
      songloft.log.warn(`[IndexingManager] 歌单歌曲缓存等待超时(${timeoutMs}ms) loaded=${this.playlistCacheLoadedIds.size}/${this.playlists.length}，本轮歌曲定位可能退化为独立歌曲直推`);
    }
    return this.playlistCacheReady;
  }

  /** 歌单歌曲缓存是否已完整跑过一轮 */
  isPlaylistCacheReady(): boolean {
    return this.playlistCacheReady;
  }

  /**
   * 缓存是否覆盖了**当前**这批歌单。
   *
   * 与 playlistCacheReady 的区别：后者是只升不降的闩锁，用于决定「要不要等」；
   * 而「歌单集合变更后正在重新加载」或「某个歌单一直拉取失败」时闩锁仍为 true、
   * 覆盖却是不完整的。判断「查不到位置到底是因为不在歌单里，还是因为缓存没到」
   * 必须用这个，否则会打出「不在任何歌单」这种说反话的诊断日志（#62 就是被误导卡住的）。
   */
  private isPlaylistCacheComplete(): boolean {
    return this.playlistCacheReady && this.playlistCacheLoadedIds.size >= this.playlists.length;
  }

  /**
   * 获取索引状态
   */
  getStatus(): IndexStatus {
    return {
      ready: this.indexReady,
      song_count: this.songs.length,
      playlist_count: this.playlists.length,
      last_refresh_time: this.lastRefreshTime > 0
        ? new Date(this.lastRefreshTime).toISOString()
        : '',
      is_refreshing: this.isRefreshing,
      playlist_cache_ready: this.playlistCacheReady,
      playlist_cache_loaded: this.playlistCacheLoadedIds.size,
    };
  }

  /**
   * 模糊搜索歌单（用于语音口令匹配）
   * 按匹配度排序：精确匹配 > 开头匹配 > 包含匹配
   * @param query - 搜索关键词
   * @returns 最多10个匹配结果
   */
  searchPlaylist(query: string): IndexedPlaylist[] {
    // 空查询视为「列出全部歌单」：无歌单名口令（"放音乐"/"放歌单"）用它挑默认歌单。
    // 不能交给 fuzzySearchList——它对空 query 直接返回 []，导致冷启动、无活跃歌单时
    // 口令必报「No playlists available」（songloft-org/songloft-plugin-miot#113）。
    if (!query || !query.trim()) {
      return this.playlists.slice(0, MAX_SEARCH_RESULTS);
    }
    return fuzzySearchList(
      query,
      this.playlists,
      pl => pl.name,
      MAX_SEARCH_RESULTS,
    );
  }

  /**
   * 模糊搜索歌曲（匹配标题或歌手）
   * @param query - 搜索关键词
   * @returns 最多10个匹配结果
   */
  searchSong(query: string): IndexedSong[] {
    if (!query || !query.trim()) return [];

    const q = tokenizeQuery(query);
    if (q.tokens.length === 0) return [];

    const scored: ScoredResult<IndexedSong>[] = [];
    for (const song of this.songs) {
      const score = scoreSongTokens(
        q,
        song.titleLower, song.artistLower, song.albumLower,
        song.titlePinyin, song.artistPinyin, song.albumPinyin,
      );
      if (score > 0) {
        scored.push({ item: song, score });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, MAX_SEARCH_RESULTS).map(s => s.item);
  }

  /**
   * 精确匹配歌单名（忽略大小写）
   * 如果精确匹配失败，回退到模糊搜索返回第一个结果
   * @param name - 歌单名称
   * @returns 匹配到的歌单，未找到返回 null
   */
  findPlaylistByName(name: string): IndexedPlaylist | null {
    if (!name) return null;

    const nameLower = name.toLowerCase();

    // 精确匹配
    const exact = this.playlists.find(pl => pl.nameLower === nameLower);
    if (exact) return exact;

    // 中文数字归一化匹配（语音识别常把阿拉伯数字转写为中文数字，如 "946" → "九四六"）
    const nameDigitNorm = normalizeChineseDigits(nameLower);
    const digitMatch = this.playlists.find(pl => {
      const plNorm = normalizeChineseDigits(pl.nameLower);
      return plNorm === nameDigitNorm && pl.nameLower !== nameLower;
    });
    if (digitMatch) return digitMatch;

    // 回退到模糊搜索
    const results = this.searchPlaylist(name);
    return results.length > 0 ? results[0] : null;
  }

  /**
   * 带按需刷新的歌单查找。
   *
   * 歌单内存索引只在插件启动时构建一次，运行期间新建的歌单不在索引里，
   * 语音口令会误报「未找到歌单」（songloft-org/songloft-plugin-miot#84）。
   * 先查内存索引，miss 时触发一次带冷却的全量刷新再重试，捡回新建歌单。
   *
   * 与 findStandaloneSongByName 的刷新策略对称：只有真 miss 才 refresh，
   * 且带冷却，避免每条未命中口令都重建索引。
   *
   * @param name - 歌单名称
   * @returns 匹配到的歌单，未找到返回 null
   */
  async findPlaylistByNameWithRefresh(name: string): Promise<IndexedPlaylist | null> {
    if (!name) return null;

    let result = this.findPlaylistByName(name);
    if (result) return result;

    // 内存索引确实没有这个歌单，才值得为「刚被新建、索引还没见过」重建（仍带冷却）。
    const now = Date.now();
    if (!this.isRefreshing && now - this.lastPlaylistRefreshTime >= PLAYLIST_REFRESH_COOLDOWN_MS) {
      this.lastPlaylistRefreshTime = now;
      songloft.log.warn(`[IndexingManager] findPlaylistByNameWithRefresh: 内存索引未命中「${name}」，触发全量刷新`);
      await this.refresh();
      result = this.findPlaylistByName(name);
    } else {
      const remainingMs = Math.max(0, PLAYLIST_REFRESH_COOLDOWN_MS - (now - this.lastPlaylistRefreshTime));
      songloft.log.info(`[IndexingManager] findPlaylistByNameWithRefresh: skip refresh (refreshing=${this.isRefreshing}, cooldown=${remainingMs}ms)`);
    }

    return result;
  }

  /**
   * 按ID获取歌单
   * @param id - 歌单ID
   * @returns 歌单信息，未找到返回 null
   */
  getPlaylistById(id: number): IndexedPlaylist | null {
    return this.playlists.find(pl => pl.id === id) ?? null;
  }

  /**
   * 带按需刷新的歌单 ID 查找。
   *
   * 与 findPlaylistByNameWithRefresh 对称：按 ID 查找歌单，miss 时触发一次带冷却的
   * 全量刷新再重试。解决定时任务引用已过期歌单 ID 的问题
   * （songloft-org/songloft-plugin-miot#83）。
   *
   * @param id - 歌单ID
   * @returns 匹配到的歌单，未找到返回 null
   */
  async getPlaylistByIdWithRefresh(id: number): Promise<IndexedPlaylist | null> {
    if (!id || isNaN(id)) return null;

    let result = this.getPlaylistById(id);
    if (result) return result;

    // 内存索引确实没有这个歌单 ID，才值得刷新（捡回扫描后 auto-create 的新 ID 等）
    const now = Date.now();
    if (!this.isRefreshing && now - this.lastPlaylistRefreshTime >= PLAYLIST_REFRESH_COOLDOWN_MS) {
      this.lastPlaylistRefreshTime = now;
      songloft.log.warn(`[IndexingManager] getPlaylistByIdWithRefresh: 内存索引未命中 id=${id}，触发全量刷新`);
      await this.refresh();
      result = this.getPlaylistById(id);
    } else {
      const remainingMs = Math.max(0, PLAYLIST_REFRESH_COOLDOWN_MS - (now - this.lastPlaylistRefreshTime));
      songloft.log.info(`[IndexingManager] getPlaylistByIdWithRefresh: skip refresh (refreshing=${this.isRefreshing}, cooldown=${remainingMs}ms)`);
    }

    return result;
  }

  /**
   * 在指定歌单中按歌曲名称查找索引位置
   * 先精确匹配（忽略大小写），再回退模糊搜索
   * @param playlistId - 歌单ID
   * @param songName - 歌曲名称
   * @returns { index, found }，index 为歌曲在歌单中的位置
   */
  async findSongInPlaylist(playlistId: number, songName: string): Promise<{ index: number; found: boolean; songId?: number }> {
    if (!this.indexReady || !songName) {
      return { index: 0, found: false };
    }

    // 同 findSongByName：位置信息只能靠这份缓存，没到位就等一等（#62）。
    const cacheReady = await this.waitForPlaylistCache();

    const songs = this.playlistSongsCache.get(playlistId) ?? [];
    if (songs.length === 0) {
      // 「歌单真的空」与「缓存还没加载到这个歌单」表现相同，但后者是个 bug 现场，要能区分。
      if (!cacheReady || !this.playlistCacheLoadedIds.has(playlistId)) {
        songloft.log.warn(`[IndexingManager] findSongInPlaylist: 歌单 ${playlistId} 的歌曲缓存未就绪，无法定位「${songName}」，将从第 0 首开始`);
      }
      return { index: 0, found: false };
    }

    const candidates = songs.map((s, i) => ({ title: s.title, index: i, id: s.id }));

    const matched = fuzzySearchList(
      songName,
      candidates,
      c => c.title,
      1,
      normalizeForMatch,
    );

    if (matched.length > 0) {
      return { index: matched[0].index, found: true, songId: matched[0].id };
    }

    return { index: 0, found: false };
  }

  /**
   * 按歌曲 ID 在指定歌单中查找索引位置
   */
  async findSongIndexInPlaylistById(playlistId: number, songId: number): Promise<{ index: number; found: boolean }> {
    if (!this.indexReady || !songId) {
      return { index: 0, found: false };
    }

    await this.waitForPlaylistCache();

    const songs = this.playlistSongsCache.get(playlistId) ?? [];
    const idx = songs.findIndex(s => s.id === songId);
    if (idx >= 0) {
      return { index: idx, found: true };
    }
    return { index: 0, found: false };
  }

  /**
   * 按歌曲名称模糊匹配，返回歌曲位置信息（歌单ID + 索引）
   * 参考 Go 版本: indexing/manager.go FindSongByName
   * @param songName - 歌曲名称关键词
   * @returns 匹配到的歌曲位置，未找到返回 null
   */
  async findSongByName(songName: string): Promise<SongLocation | null> {
    if (!this.indexReady || !songName) return null;

    // 歌单位置只能靠 playlistSongsCache 回答；缓存没到位就等一等，否则会把「查不到位置」
    // 误判成「不在任何歌单」（#62）。闩锁翻转后这里是零成本。
    const cacheReady = await this.waitForPlaylistCache();

    const startMs = Date.now();

    // 分词一次，供全局搜索与歌单内直接评分复用
    const q = tokenizeQuery(songName);

    // 1. 用内存歌曲索引模糊搜索匹配歌曲（按评分降序）
    const matchedSongs = this.searchSong(songName);
    const matchedSongIds = new Set(matchedSongs.map(s => s.id));

    songloft.log.info(`[IndexingManager] findSongByName query="${songName}" indexMatches=${matchedSongs.length}`);

    // 2. 遍历缓存的歌单歌曲，同时做两件事：
    //    a) 收集全局索引命中歌曲的位置
    //    b) 对歌单内歌曲直接模糊评分，记录最佳匹配（兜底用）
    const songLocationMap = new Map<number, SongLocation>();
    let bestDirectLoc: SongLocation | null = null;
    let bestDirectScore = 0;

    for (const pl of this.playlists) {
      const plSongs = this.playlistSongsCache.get(pl.id) ?? [];
      for (let idx = 0; idx < plSongs.length; idx++) {
        const s = plSongs[idx];

        // a) 全局索引命中
        if (matchedSongIds.has(s.id) && !songLocationMap.has(s.id)) {
          songLocationMap.set(s.id, {
            songId: s.id,
            playlistId: pl.id,
            playlistName: pl.name,
            songIndex: idx,
            songTitle: s.title,
            artist: s.artist,
          });
        }

        // b) 直接模糊评分（联合标题+歌手+专辑）
        const score = scoreSongTokens(
          q,
          s.titleLower, s.artistLower, s.albumLower,
          s.titlePinyin, s.artistPinyin, s.albumPinyin,
        );
        if (score >= MIN_MATCH_SCORE && score > bestDirectScore) {
          bestDirectScore = score;
          bestDirectLoc = {
            songId: s.id,
            playlistId: pl.id,
            playlistName: pl.name,
            songIndex: idx,
            songTitle: s.title,
            artist: s.artist,
          };
        }
      }
    }

    const elapsedMs = Date.now() - startMs;

    // 3. 优先返回全局索引命中（保持 searchSong 的评分排序）
    for (let i = 0; i < matchedSongs.length; i++) {
      const loc = songLocationMap.get(matchedSongs[i].id);
      if (loc) {
        // 最佳全局匹配不在歌单但分数明显优于当前歌单匹配时，放弃歌单匹配，
        // 让 findStandaloneSongByName 播放最佳匹配（songloft-org/songloft#412）
        if (i > 0) {
          const bestScore = scoreSongTokens(q,
            matchedSongs[0].titleLower, matchedSongs[0].artistLower, matchedSongs[0].albumLower,
            matchedSongs[0].titlePinyin, matchedSongs[0].artistPinyin, matchedSongs[0].albumPinyin);
          const thisScore = scoreSongTokens(q,
            matchedSongs[i].titleLower, matchedSongs[i].artistLower, matchedSongs[i].albumLower,
            matchedSongs[i].titlePinyin, matchedSongs[i].artistPinyin, matchedSongs[i].albumPinyin);
          if (bestScore > thisScore + 5) {
            songloft.log.warn(
              `[IndexingManager] findSongByName: 最佳全局匹配 "${matchedSongs[0].title}" (score=${bestScore.toFixed(1)}) 不在歌单，` +
              `跳过低分歌单匹配 "${matchedSongs[i].title}" (score=${thisScore.toFixed(1)})，转独立歌曲路径`);
            break;
          }
        }
        songloft.log.info(`[IndexingManager] findSongByName done (${elapsedMs}ms) → "${loc.songTitle}" by "${loc.artist}" in playlist="${loc.playlistName}" (globalRank=#${i + 1})`);
        return loc;
      }
    }

    // 4a. 全局索引有高质量命中但不在任何歌单中 → 返回 null 让调用方走独立歌曲路径
    if (matchedSongs.length > 0) {
      const bestGlobal = matchedSongs[0];
      const bestGlobalScore = scoreSongTokens(
        q,
        bestGlobal.titleLower, bestGlobal.artistLower, bestGlobal.albumLower,
        bestGlobal.titlePinyin, bestGlobal.artistPinyin, bestGlobal.albumPinyin,
      );
      if (bestGlobalScore >= MIN_MATCH_SCORE) {
        // 两种情形要分清：缓存覆盖不全时我们其实**不知道**这首歌在不在歌单里，
        // 只是拿不出更好的答案；日志必须说明白，否则下次排查又要从零猜（#62）。
        // 判据用「覆盖是否完整」而不是 cacheReady——闩锁只升不降，歌单集合变更后
        // 正在重新加载、或某个歌单一直拉取失败时它仍是 true。
        if (!this.isPlaylistCacheComplete()) {
          songloft.log.warn(
            `[IndexingManager] findSongByName (${elapsedMs}ms) 全局命中 "${bestGlobal.title}" 但歌单缓存覆盖不全` +
            `(loaded=${this.playlistCacheLoadedIds.size}/${this.playlists.length}, waited=${cacheReady})：无法确认是否在歌单中，退化为独立歌曲直推（无自动续播）`
          );
        } else {
          songloft.log.warn(
            `[IndexingManager] findSongByName (${elapsedMs}ms) 全局命中 "${bestGlobal.title}" by "${bestGlobal.artist}" ` +
            `(score=${bestGlobalScore.toFixed(1)}) 不在任何歌单，转独立歌曲路径`
          );
        }
        return null;
      }
    }

    // 4b. 无高质量全局匹配，使用歌单内直接模糊匹配的最佳结果（已有 MIN_MATCH_SCORE 阈值保护）
    if (bestDirectLoc) {
      songloft.log.info(`[IndexingManager] findSongByName done (${elapsedMs}ms) → fallback "${bestDirectLoc.songTitle}" in playlist="${bestDirectLoc.playlistName}" (score=${bestDirectScore.toFixed(1)})`);
    } else {
      songloft.log.info(`[IndexingManager] findSongByName done (${elapsedMs}ms) → no match (bestDirectScore=${bestDirectScore.toFixed(1)})`);
    }
    return bestDirectLoc;
  }

  /**
   * 按歌手名称模糊匹配，返回所有歌单中该歌手的歌曲位置列表。
   * 跨歌单去重（同一首歌只返回一次），用于"播放歌手XX的歌"语音口令。
   */
  findSongsByArtist(artistName: string): ArtistSongLocation[] {
    if (!artistName || !artistName.trim()) return [];

    const queryLower = normalizeForMatch(artistName);
    if (!queryLower) return [];

    const results: ArtistSongLocation[] = [];
    const seen = new Set<number>();

    for (const [plId, songs] of this.playlistSongsCache) {
      for (const song of songs) {
        if (seen.has(song.id)) continue;
        const score = fuzzyScoreLower(queryLower, song.artistLower);
        if (score >= 50) {
          results.push({
            songId: song.id,
            playlistId: plId,
            songTitle: song.title,
            artist: song.artist,
          });
          seen.add(song.id);
        }
      }
    }

    return results;
  }

  /** 内存索引里的最佳匹配（含 MIN_MATCH_SCORE 阈值），未达标返回 null。 */
  private bestIndexedMatch(songName: string): IndexedSong | null {
    const matched = this.searchSong(songName);
    if (matched.length === 0) return null;

    const best = matched[0];
    const bestScore = scoreSongTokens(
      tokenizeQuery(songName),
      best.titleLower, best.artistLower, best.albumLower,
      best.titlePinyin, best.artistPinyin, best.albumPinyin,
    );
    if (bestScore < MIN_MATCH_SCORE) {
      songloft.log.info(`[IndexingManager] bestIndexedMatch: "${best.title}" by "${best.artist}" score=${bestScore.toFixed(1)} below threshold, skipping`);
      return null;
    }
    return best;
  }

  /**
   * 查找独立远程歌曲（不在任何歌单中）
   * 当 findSongByName 找不到时回退调用。
   *
   * **先查内存索引，只有真 miss 才 refresh**：refresh 唯一的价值是「捡回索引还不知道的新歌」，
   * 对已知歌曲纯属开销，而且每次都会扰动歌单缓存加载。旧实现无条件先 refresh，于是
   * 「miss → refresh → 作废缓存加载 → 继续 miss」形成自维持回路
   * （songloft-org/songloft-plugin-miot#62）。
   *
   * @returns 完整 Song（type/duration 供下游决定电台转码与自动切歌定时器），未找到返回 null
   */
  async findStandaloneSongByName(songName: string): Promise<any | null> {
    if (!songName) return null;

    let best = this.bestIndexedMatch(songName);

    // 内存索引确实没有这首歌，才值得为「刚被外部搜索导入、索引还没见过」重建（仍带冷却）。
    if (!best) {
      const now = Date.now();
      if (!this.isRefreshing && now - this.lastStandaloneRefreshTime >= STANDALONE_REFRESH_COOLDOWN_MS) {
        this.lastStandaloneRefreshTime = now;
        songloft.log.warn(`[IndexingManager] findStandaloneSongByName: 内存索引未命中「${songName}」，触发全量刷新`);
        await this.refresh();
        best = this.bestIndexedMatch(songName);
      } else {
        const remainingMs = Math.max(0, STANDALONE_REFRESH_COOLDOWN_MS - (now - this.lastStandaloneRefreshTime));
        songloft.log.info(`[IndexingManager] findStandaloneSongByName: skip refresh (refreshing=${this.isRefreshing}, cooldown=${remainingMs}ms)`);
      }
    }
    if (!best) return null;

    // 通过 ID 获取完整歌曲信息（含 url / type / duration）
    try {
      const fullSong = await songloft.songs.getById(best.id);
      if (fullSong && fullSong.url) {
        songloft.log.warn(`[IndexingManager] 独立歌曲路径命中: "${fullSong.title}" - ${fullSong.artist} id=${fullSong.id} type=${(fullSong as any).type} duration=${(fullSong as any).duration}`);
        return fullSong;
      }
    } catch (e) {
      songloft.log.warn('[IndexingManager] Failed to get standalone song by id: ' + String(e));
    }
    return null;
  }

  /**
   * 增量把一首刚导入的歌曲加入内存索引。
   *
   * 外部搜索导入的是一首独立远程歌曲，只影响歌曲索引本身（以及可选的单个目标歌单），
   * 无需为它重建全部歌单缓存（原先每导入一首触发一次全量 refresh，会逐首重拉所有歌单）。
   *
   * - 按 id upsert 进 this.songs，使 searchSong / findStandaloneSongByName 后续可本地命中；
   * - 仅当 playlistId 指定且该歌单缓存已加载时，把这一首追加进该歌单缓存并把 songCount +1；
   *   歌单缓存尚未加载则跳过（后台加载会从服务端拉到已追加的完整列表）。
   */
  addImportedSong(
    song: { id: number; title: string; artist?: string; album?: string },
    playlistId?: number,
  ): void {
    const title = song.title ?? '';
    const artist = song.artist ?? '';
    const album = song.album ?? '';
    const titleLower = normalizeForMatch(title);
    const artistLower = normalizeForMatch(artist);
    const albumLower = normalizeForMatch(album);
    const titlePinyin = getCachedPinyin(titleLower);
    const artistPinyin = getCachedPinyin(artistLower);
    const albumPinyin = getCachedPinyin(albumLower);

    const entry: IndexedSong = {
      id: song.id,
      title, artist, album,
      titleLower, artistLower, albumLower,
      titlePinyin, artistPinyin, albumPinyin,
    };

    const existingIdx = this.songs.findIndex(s => s.id === song.id);
    if (existingIdx >= 0) {
      this.songs[existingIdx] = entry;
    } else {
      this.songs.push(entry);
    }

    if (playlistId !== undefined && playlistId !== null && !Number.isNaN(playlistId)) {
      const cached = this.playlistSongsCache.get(playlistId);
      if (cached && !cached.some(s => s.id === song.id)) {
        cached.push({
          id: song.id,
          title, artist, album,
          titleLower, artistLower, albumLower,
          titlePinyin, artistPinyin, albumPinyin,
        });
        const pl = this.playlists.find(p => p.id === playlistId);
        if (pl) pl.songCount += 1;
      }
    }

    this.indexReady = true;
    songloft.log.info(`[IndexingManager] 增量索引: 已加入歌曲 id=${song.id} "${title}"${playlistId ? ` playlist=${playlistId}` : ''} (songs=${this.songs.length})`);
  }

  /**
   * 索引是否就绪
   */
  isIndexReady(): boolean {
    return this.indexReady;
  }
}
