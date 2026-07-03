// MIoT 智能音箱插件 - 索引管理模块
// 从 Songloft 主程序API获取歌曲/歌单数据，建立内存索引，提供模糊搜索

/// <reference types="@songloft/plugin-sdk" />

import { loadDomainDict, segmentQuery, toPinyin } from './segmenter';

// ===== 类型定义 =====

/** 索引中的歌曲信息 */
export interface IndexedSong {
  id: number;
  title: string;
  artist: string;
  album: string;
  titleLower: string;   // 小写化用于搜索
  artistLower: string;  // 小写化用于搜索
  albumLower: string;   // 小写化用于搜索
  titlePinyin: string;  // 拼音（无声调、空格分隔）用于同音字匹配
  artistPinyin: string;
  albumPinyin: string;
}

/** 歌曲在歌单中的位置信息（用于语音口令播放歌曲） */
export interface SongLocation {
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
}

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

/** 薄包装：接收原始大小写字符串，供 playlist 等非热路径使用。 */
function fuzzyScore(keyword: string, candidate: string): number {
  if (!keyword || !candidate) return 0;
  return fuzzyScoreLower(keyword.toLowerCase(), candidate.toLowerCase());
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
): T[] {
  if (!query || items.length === 0) return [];

  const queryTrimmed = query.trim();
  if (!queryTrimmed) return [];

  // 分词：按空格与中文标点分词（不分"的"，因其常是歌名/歌单名的一部分）
  const terms = queryTrimmed.split(/[\s，,、]+/).filter(t => t.length > 0);
  if (terms.length === 0) return [];

  const scored: ScoredResult<T>[] = [];

  for (const item of items) {
    const text = getText(item);

    if (terms.length === 1) {
      // 单词直接评分
      const score = fuzzyScore(terms[0], text);
      if (score > 0) {
        scored.push({ item, score });
      }
    } else {
      // 多词搜索：所有词都需要在目标中出现（子串包含），取最低分
      const textLower = text.toLowerCase();
      let allMatch = true;
      let minScore = Infinity;

      for (const term of terms) {
        if (!textLower.includes(term.toLowerCase())) {
          allMatch = false;
          break;
        }
        const s = fuzzyScore(term, text);
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

/** query 分词结果（token + 预转拼音，len<2 的 token 拼音留空不参与拼音匹配） */
interface QueryTokens {
  tokens: string[];
  pys: string[];
}

/** 对 query 分词并预算每个 token 的拼音，供跨字段匹配复用（每次搜索算一次） */
function tokenizeQuery(query: string): QueryTokens {
  const tokens = segmentQuery(query);
  const pys = tokens.map(t => (Array.from(t).length >= TOKEN_FUZZY_MIN_LEN ? toPinyin(t) : ''));
  return { tokens, pys };
}

/**
 * 单个 token 对单个字段的匹配强度（0..1，未含字段权重）。
 * 逐级：完全相等 → 字段含 token → token 含字段 → 编辑距离模糊 → 拼音（同音字）。
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

    // 拼音层（同音字，如"青天"↔"晴天"）
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

  constructor(configManager?: import('../config/manager').ConfigManager) {
    this.configManager = configManager ?? null;
  }

  /**
   * 刷新索引（从宿主API获取最新数据）
   * @returns 刷新结果
   */
  async refresh(): Promise<{ success: boolean; songCount: number; playlistCount: number }> {
    if (this.isRefreshing) {
      return { success: false, songCount: this.songs.length, playlistCount: this.playlists.length };
    }

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

      // 3. 构建歌单索引
      const newPlaylists: IndexedPlaylist[] = rawPlaylists.map(pl => ({
        id: pl.id,
        name: pl.name,
        nameLower: pl.name.toLowerCase(),
        songCount: (pl as any).song_count ?? (pl as any).songCount ?? 0,
      }));

      // 拼音去重缓存：大量歌曲共享同一歌手/专辑，避免重复计算
      const pyCache = new Map<string, string>();
      const py = (s: string): string => {
        if (!s) return '';
        let v = pyCache.get(s);
        if (v === undefined) {
          v = toPinyin(s);
          pyCache.set(s, v);
        }
        return v;
      };

      // 4. 构建歌曲索引（同时预计算拼音，供同音字匹配）
      const newSongs: IndexedSong[] = rawSongs.map(song => {
        const title = song.title ?? '';
        const artist = song.artist ?? '';
        const album = song.album ?? '';
        return {
          id: song.id,
          title,
          artist,
          album,
          titleLower: title.toLowerCase(),
          artistLower: artist.toLowerCase(),
          albumLower: album.toLowerCase(),
          titlePinyin: py(title),
          artistPinyin: py(artist),
          albumPinyin: py(album),
        };
      });

      // 4.5 把曲库词汇注入分词器自定义词典，让冷门歌名/歌手正确成词
      const domainWords: string[] = [];
      for (const s of newSongs) {
        if (s.title) domainWords.push(s.title);
        if (s.artist) domainWords.push(s.artist);
        if (s.album) domainWords.push(s.album);
      }
      for (const pl of newPlaylists) {
        if (pl.name) domainWords.push(pl.name);
      }
      try {
        loadDomainDict(domainWords);
      } catch (e) {
        songloft.log.warn(`索引刷新: 注入曲库词典失败: ${e instanceof Error ? e.message : String(e)}`);
      }

      // 5. 预加载歌单歌曲（避免搜歌时逐个桥接调用）。
      //    并发拉取所有歌单，单歌单失败仅 warn 不中断整体。
      const newPlaylistSongsCache = new Map<number, CachedPlaylistSong[]>();
      const plSongsStart = Date.now();
      await Promise.all(newPlaylists.map(async pl => {
        try {
          const plSongs = (await songloft.playlists.getSongs(pl.id, { limit: 100000 })) ?? [];
          newPlaylistSongsCache.set(pl.id, plSongs.map(s => {
            const title = (s as any).title ?? '';
            const artist = (s as any).artist ?? '';
            const album = (s as any).album ?? '';
            return {
              id: s.id,
              title,
              artist,
              titleLower: title.toLowerCase(),
              artistLower: artist.toLowerCase(),
              albumLower: album.toLowerCase(),
              titlePinyin: py(title),
              artistPinyin: py(artist),
              albumPinyin: py(album),
            };
          }));
        } catch (e) {
          songloft.log.warn(`索引刷新: 获取歌单歌曲失败 playlist_id=${pl.id}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }));
      const plSongsMs = Date.now() - plSongsStart;

      // 6. 更新索引
      this.playlists = newPlaylists;
      this.songs = newSongs;
      this.playlistSongsCache = newPlaylistSongsCache;
      this.lastRefreshTime = Date.now();
      this.indexReady = true;

      songloft.log.info(`索引构建完成: playlists=${newPlaylists.length} songs=${newSongs.length} playlistSongs=${newPlaylistSongsCache.size} (${plSongsMs}ms)`);
      return { success: true, songCount: newSongs.length, playlistCount: newPlaylists.length };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      songloft.log.warn(`索引刷新失败: ${msg}`);
      this.indexReady = false;
      return { success: false, songCount: this.songs.length, playlistCount: this.playlists.length };
    } finally {
      this.isRefreshing = false;
    }
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
    };
  }

  /**
   * 模糊搜索歌单（用于语音口令匹配）
   * 按匹配度排序：精确匹配 > 开头匹配 > 包含匹配
   * @param query - 搜索关键词
   * @returns 最多10个匹配结果
   */
  searchPlaylist(query: string): IndexedPlaylist[] {
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

    // 回退到模糊搜索
    const results = this.searchPlaylist(name);
    return results.length > 0 ? results[0] : null;
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
   * 在指定歌单中按歌曲名称查找索引位置
   * 先精确匹配（忽略大小写），再回退模糊搜索
   * @param playlistId - 歌单ID
   * @param songName - 歌曲名称
   * @returns { index, found }，index 为歌曲在歌单中的位置
   */
  async findSongInPlaylist(playlistId: number, songName: string): Promise<{ index: number; found: boolean }> {
    if (!this.indexReady || !songName) {
      return { index: 0, found: false };
    }

    const songs = this.playlistSongsCache.get(playlistId) ?? [];
    if (songs.length === 0) {
      return { index: 0, found: false };
    }

    const candidates = songs.map((s, i) => ({ title: s.title, index: i }));

    const matched = fuzzySearchList(
      songName,
      candidates,
      c => c.title,
      1,
    );

    if (matched.length > 0) {
      return { index: matched[0].index, found: true };
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
        songloft.log.info(
          `[IndexingManager] findSongByName done (${elapsedMs}ms) → global match "${bestGlobal.title}" by "${bestGlobal.artist}" (score=${bestGlobalScore.toFixed(1)}) not in any playlist, deferring to standalone`
        );
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
   * 查找独立远程歌曲（不在任何歌单中）
   * 当 findSongByName 找不到时回退调用。
   * 先刷新索引确保包含最新导入的歌曲，然后搜索 title 匹配，通过 ID 获取完整信息。
   *
   * @returns 歌曲的 id/url/title/artist，未找到返回 null
   */
  async findStandaloneSongByName(songName: string): Promise<{ id: number; url: string; title: string; artist: string } | null> {
    if (!songName) return null;

    // 刷新索引确保包含最新导入的远程歌曲
    await this.refresh();

    // 在刷新后的索引中按 title 模糊匹配
    const matched = this.searchSong(songName);
    if (matched.length === 0) return null;

    const bestScore = scoreSongTokens(
      tokenizeQuery(songName),
      matched[0].titleLower, matched[0].artistLower, matched[0].albumLower,
      matched[0].titlePinyin, matched[0].artistPinyin, matched[0].albumPinyin,
    );
    if (bestScore < MIN_MATCH_SCORE) {
      songloft.log.info(`[IndexingManager] findStandaloneSongByName: best match "${matched[0].title}" by "${matched[0].artist}" score=${bestScore.toFixed(1)} below threshold, skipping`);
      return null;
    }

    // 通过 ID 获取完整歌曲信息（含 url）
    try {
      const fullSong = await songloft.songs.getById(matched[0].id);
      if (fullSong && fullSong.url) {
        songloft.log.info('[IndexingManager] Found standalone remote song: ' + matched[0].title + ' - ' + matched[0].artist + ', id=' + matched[0].id);
        return {
          id: fullSong.id,
          url: fullSong.url,
          title: fullSong.title,
          artist: fullSong.artist,
        };
      }
    } catch (e) {
      songloft.log.warn('[IndexingManager] Failed to get standalone song by id: ' + String(e));
    }
    return null;
  }

  /**
   * 索引是否就绪
   */
  isIndexReady(): boolean {
    return this.indexReady;
  }
}
