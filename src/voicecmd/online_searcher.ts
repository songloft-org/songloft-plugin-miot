// MIoT 智能音箱插件 - 在线歌曲搜索器
// 当本地索引找不到歌曲时，调用用户配置的外部搜索 API 搜索并推送到音箱

/// <reference types="@songloft/plugin-sdk" />

import { MinaService } from '../service/service';
import { getHostAPIBaseUrl } from '../utils/http';
import { URLBuilder } from '../player/url_builder';
import { ConfigManager } from '../config/manager';
import { IndexingManager } from '../indexing/manager';
import { GroupCoordinator } from '../group/coordinator';
import type { ExternalSearchSource, PlayMode } from '../types';
import type { PlaylistManager } from '../player/manager';

// 外部搜索 API 请求体
interface SearchOneRequest {
  keyword: string;
  hint?: { title?: string; artist?: string; duration?: number };
  quality?: string;
}

// 外部搜索 API 成功响应 data（provider 中立，不解读内部字段）
export interface OnlineSearchResult {
  title: string;
  artist: string;
  album?: string;
  duration?: number;
  cover_url?: string;
  url?: string;                                      // 直链型 provider 提供
  plugin_entry_path?: string;                        // provider 自身 entryPath；缺省纯外链
  source_data?: string | Record<string, unknown>;   // 不透明；对象则由 MIoT 序列化
  dedup_key?: string;
  lyric?: string;
  lyric_source?: string;
}

// 外部搜索 API 响应
interface SearchOneResponse {
  code: number;
  msg: string;
  data: OnlineSearchResult | null;
}

// songloft /api/v1/songs/remote 请求体（provider 中立）
interface RemoteSongItem {
  title: string;
  artist: string;
  album: string;
  cover_url: string;
  duration: number;
  url: string;               // 直链型 provider 有；解析型为空
  plugin_entry_path: string; // provider 自身 entryPath；缺省 '' 表示纯外链
  source_data: string;
  dedup_key: string;
  lyric?: string;
  lyric_source?: string;
}

// songloft /api/v1/songs/remote 响应
interface RemoteSongsResponse {
  count: number;
  songs: Array<{
    id: number;
    type: string;
    title: string;
    artist: string;
    album: string;
    duration: number;
    url: string;
    cover_url: string;
    plugin_entry_path: string;
    source_data: string;
    dedup_key: string;
  }>;
}

/**
 * 在线歌曲搜索器
 * 封装对用户配置的外部搜索 API（topone）的调用。
 * MIoT 作为中立消费方，不解读 source_data 内部结构，不写死任何插件名。
 */
export class OnlineSearcher {
  private configManager: ConfigManager;
  private groupCoordinator?: GroupCoordinator;

  constructor(configManager: ConfigManager, groupCoordinator?: GroupCoordinator) {
    this.configManager = configManager;
    this.groupCoordinator = groupCoordinator;
  }

  /**
   * 检查是否配置了外部搜索源（总开关开启且至少有一个启用且有 url 的源）
   */
  async isExternalSearchConfigured(): Promise<boolean> {
    const sources = await this.getEnabledSources();
    return sources.length > 0;
  }

  /**
   * 获取当前生效的外部搜索源列表（总开关关闭返回空；数组顺序即优先级）
   */
  private async getEnabledSources(): Promise<ExternalSearchSource[]> {
    const config = await this.configManager.getConfig();
    if (!config.external_search_enabled) return [];
    return config.external_search_sources.filter((s) => s.enabled && (s.url || '').trim() !== '');
  }

  /**
   * 解析单个源的完整地址
   * 支持两种输入：
   * 1. 完整 URL（以 http:// 或 https:// 开头）直接返回
   * 2. 相对路径（以 / 开头）拼接宿主 loopback 地址（调用其他已安装插件）
   */
  private async resolveSourceUrl(source: ExternalSearchSource): Promise<string> {
    const searchUrl = (source.url || '').trim();
    if (!searchUrl) return '';
    if (searchUrl.startsWith('http://') || searchUrl.startsWith('https://')) {
      return searchUrl;
    }
    // 相对路径 = 内部插件/宿主接口，走 loopback API 地址（避免 hairpin NAT）
    const host = await getHostAPIBaseUrl();
    return host + searchUrl;
  }

  /**
   * 解析单个源的认证 Token
   * 源自定义的 token 优先，否则使用插件 token
   */
  private async resolveSourceToken(source: ExternalSearchSource): Promise<string> {
    const userToken = (source.token || '').trim();
    if (userToken) {
      return userToken;
    }
    const pluginToken = await songloft.plugin.getToken();
    return `Bearer ${pluginToken}`;
  }

  /**
   * 在线搜索歌曲：并发向所有启用源派发请求，但严格按列表顺序采纳结果
   * （源0 命中即用源0，否则看源1……）。仅返回候选，不导入也不播放。
   *
   * @param keyword       搜索关键词
   * @param hint         可选的歌曲提示（title/artist/duration）
   * @returns 搜索候选，全部未命中或请求失败返回 null
   */
  async search(
    keyword: string,
    hint: { title: string; artist?: string; duration?: number } | null,
  ): Promise<OnlineSearchResult | null> {
    const sources = await this.getEnabledSources();
    if (sources.length === 0) return null;

    const config = await this.configManager.getConfig();
    const timeoutSec = config.external_search_timeout > 0 ? config.external_search_timeout : 6;
    const timeoutMs = timeoutSec * 1000;

    // 立即并发派发所有源；searchOne 内部 catch，绝不 reject
    const tasks = sources.map((s) => this.searchOne(s, keyword, hint, timeoutMs));

    // 按优先级顺序消费：命中即返回（只等到该源），未命中再看下一个
    for (let i = 0; i < tasks.length; i++) {
      const r = await tasks[i];
      if (r) {
        songloft.log.info(`[OnlineSearcher] Hit from source[${i}] "${sources[i].name || sources[i].url}" for keyword: ${keyword}`);
        return r;
      }
    }
    songloft.log.warn('[OnlineSearcher] No source matched for keyword: ' + keyword);
    return null;
  }

  /**
   * 向单个源发起一次搜索。内部处理超时/网络错/解析失败，全部返回 null，绝不 reject。
   */
  private async searchOne(
    source: ExternalSearchSource,
    keyword: string,
    hint: { title: string; artist?: string; duration?: number } | null,
    timeoutMs: number,
  ): Promise<OnlineSearchResult | null> {
    const reqBody: SearchOneRequest = {
      keyword,
      hint: hint || undefined,
      quality: '320k',
    };

    let resp: SearchOneResponse | null = null;

    // 带超时的 fetch（用 Promise.race 替代 AbortController，兼容 QuickJS）
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('AbortError')), timeoutMs);
    });

    try {
      const baseUrl = await this.resolveSourceUrl(source);
      if (!baseUrl) return null;
      const authToken = await this.resolveSourceToken(source);
      songloft.log.info('[OnlineSearcher] [Diag] Request POST ' + baseUrl + ' body=' + JSON.stringify(reqBody));
      const fetchPromise = fetch(baseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: authToken },
        body: JSON.stringify(reqBody),
      });
      const fetchResp = await Promise.race([fetchPromise, timeoutPromise]);

      const text = await fetchResp.text();
      songloft.log.info('[OnlineSearcher] [Diag] Response status=' + fetchResp.status + ' body=' + text);
      try {
        resp = JSON.parse(text) as SearchOneResponse;
      } catch {
        songloft.log.warn('[OnlineSearcher] Failed to parse search/topone response: ' + text);
        return null;
      }
    } catch (e: any) {
      if (e.message === 'AbortError') {
        songloft.log.warn(`[OnlineSearcher] Search/topone timeout (>${timeoutMs / 1000}s) for source "${source.name || source.url}" keyword: ` + keyword);
      } else {
        songloft.log.warn('[OnlineSearcher] Search/topone fetch error: ' + String(e));
      }
      return null;
    }

    // 解析响应
    if (!resp || resp.code !== 0 || !resp.data) {
      songloft.log.warn('[OnlineSearcher] Search/topone returned code=' + (resp?.code ?? 'null') + ' for keyword: ' + keyword);
      return null;
    }

    return resp.data;
  }

  /**
   * 将外部搜索候选导入到 Songloft，并推送到音箱播放。
   */
  async playSearchResult(
    song: OnlineSearchResult,
    accountId: string,
    deviceId: string,
    minaService: MinaService,
    indexingManager?: IndexingManager,
    pm?: PlaylistManager,
  ): Promise<boolean> {
    const config = await this.configManager.getConfig();

    // 不入库直接播放：仅对「直链型」结果生效（song.url 是 http(s) 直链）。
    // 临时链接（签名 CDN 直链）入库后很快失效、堆成死条目，此模式趁链接新鲜时把原始 URL
    // 直接推给音箱（底层 player_play_url），跳过入库/追加歌单/加索引。
    // 解析型结果（url 为空、靠 plugin_entry_path 让宿主运行时解析）无法脱离曲库播放，回退到入库。
    const directUrl = (song.url || '').trim();
    const isDirectLink = directUrl.startsWith('http://') || directUrl.startsWith('https://');
    if (config.external_search_no_import) {
      if (isDirectLink) {
        const songName = song.artist ? `${song.title}-${song.artist}` : song.title;
        songloft.log.info('[OnlineSearcher] [Diag] No-import direct push: songName="' + songName + '" url="' + directUrl + '"');
        const played = await minaService.playURL(accountId, deviceId, directUrl, {
          title: song.title,
          artist: song.artist,
        });
        if (!played) {
          songloft.log.error('[OnlineSearcher] No-import: failed to push URL to device: ' + directUrl);
          return false;
        }
        // 分组同步：让组内其他成员播放同一 URL
        await this.groupCoordinator?.fanOutPlayURL(accountId, deviceId, directUrl, {
          title: song.title,
          artist: song.artist,
        });
        songloft.log.info('[OnlineSearcher] Playing online song (no-import): ' + song.title + ' - ' + song.artist + ' url=' + directUrl);
        return true;
      }
      songloft.log.info('[OnlineSearcher] No-import enabled but result is resolution-type (no direct url), falling back to import: ' + song.title);
    }

    // 同步导入到 songloft 数据库，直接拿到 songloft 分配的 id 和 url
    const imported = await this.importSong(song);
    if (!imported) {
      songloft.log.error('[OnlineSearcher] Failed to import song, cannot play: ' + song.title);
      return false;
    }

    // 入库后追加到目标歌单（可选，由配置决定）
    const pid = config.external_search_playlist_id;
    let appendedPlaylistId: number | undefined;
    if (pid) {
      try {
        const plToken = await songloft.plugin.getToken();
        const apiBase = await getHostAPIBaseUrl();
        await fetch(`${apiBase}/api/v1/playlists/${pid}/songs`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${plToken}` },
          body: JSON.stringify({ song_ids: [imported.id] }),
        });
        const pidNum = Number(pid);
        if (!Number.isNaN(pidNum)) appendedPlaylistId = pidNum;
      } catch (e) { songloft.log.warn(`[OnlineSearcher] 追加歌单失败: ${String(e)}`); }
    }

    // 已追加到目标歌单且提供了播放管理器：接管为完整歌单播放，从这首新歌
    // 开始，播完后由 PlaylistManager 的切歌定时器自动续播歌单其余歌曲。
    // （直接 playURL 单曲推送不会注册切歌定时器，播完即停，见 issue #53）
    if (pm && appendedPlaylistId !== undefined) {
      let playMode: PlayMode = 'order';
      try {
        const devices = await this.configManager.getDevices(accountId);
        const devCfg = devices.find((d) => d.device_id === deviceId);
        if (devCfg && devCfg.play_mode) playMode = devCfg.play_mode as PlayMode;
      } catch (e) {
        songloft.log.warn('[OnlineSearcher] Failed to read play mode, fallback to order: ' + String(e));
      }

      const ok = await pm.playPlaylistFromSong(appendedPlaylistId, imported.id, playMode);
      if (ok) {
        // 增量把这首独立远程歌曲加入内存索引，避免为一首歌重建全部歌单缓存。
        if (indexingManager) {
          indexingManager.addImportedSong(
            { id: imported.id, title: song.title, artist: song.artist, album: song.album },
            appendedPlaylistId,
          );
        }
        songloft.log.info(`[OnlineSearcher] Playing online song via playlist ${appendedPlaylistId} (auto-continue): ${song.title} - ${song.artist}`);
        return true;
      }
      songloft.log.warn(`[OnlineSearcher] Playlist takeover failed for playlist ${appendedPlaylistId}, falling back to single URL push`);
    }

    // 用返回的 url 构造完整播放 URL（相对路径，URLBuilder 会拼接 server_host 和 token）
    const playUrl = await URLBuilder.buildSongURL({ id: imported.id, url: imported.url});
    if (!playUrl) {
      songloft.log.error('[OnlineSearcher] Failed to build URL for song id=' + imported.id);
      return false;
    }

    // 推送 URL 到音箱（传「歌名-歌手」供触屏歌词模式匹配曲库）
    const songName = song.artist ? `${song.title}-${song.artist}` : song.title;
    songloft.log.info('[OnlineSearcher] [Diag] Push to device: songName="' + songName + '" importedUrl="' + imported.url + '" playUrl="' + playUrl + '"');
    const played = await minaService.playURL(accountId, deviceId, playUrl, {
      title: song.title,
      artist: song.artist,
    });
    if (!played) {
      songloft.log.error('[OnlineSearcher] Failed to push URL to device: ' + playUrl);
      return false;
    }

    // 分组同步：让组内其他成员播放同一 URL
    await this.groupCoordinator?.fanOutPlayURL(accountId, deviceId, playUrl, {
      title: song.title,
      artist: song.artist,
    });

    // 增量把这首独立远程歌曲加入内存索引，避免为一首歌重建全部歌单缓存。
    if (indexingManager) {
      indexingManager.addImportedSong(
        { id: imported.id, title: song.title, artist: song.artist, album: song.album },
        appendedPlaylistId,
      );
    }

    songloft.log.info('[OnlineSearcher] Playing online song: ' + song.title + ' - ' + song.artist + ' url=' + playUrl);
    return true;
  }

  /**
   * 在线搜索歌曲并推送到音箱播放，同时导入到本地数据库
   *
   * @param keyword       搜索关键词
   * @param hint         可选的歌曲提示（title/artist/duration）
   * @param accountId    小米账号ID
   * @param deviceId     设备ID
   * @param minaService  MinaService 实例（用于推送URL）
   * @returns 是否成功推送播放
   */
  async searchAndPlay(
    keyword: string,
    hint: { title: string; artist?: string; duration?: number } | null,
    accountId: string,
    deviceId: string,
    minaService: MinaService,
  ): Promise<boolean> {
    const song = await this.search(keyword, hint);
    if (!song) {
      return false;
    }
    return await this.playSearchResult(song, accountId, deviceId, minaService);
  }

  /**
   * 导入歌曲到 songloft 数据库
   * @returns 导入成功后包含歌曲 id 和 url 的对象，失败返回 null
   */
  private async importSong(song: OnlineSearchResult): Promise<{ id: number; url: string } | null> {
    // provider 字段原样映射，不解读、不补插件名
    const remoteItem: RemoteSongItem = {
      title: song.title,
      artist: song.artist || '',
      album: song.album || '',
      cover_url: song.cover_url || '',
      duration: song.duration || 0,
      url: song.url || '',                              // 直链型 provider 有；解析型为空
      plugin_entry_path: song.plugin_entry_path || '',  // 中立缺省 ''，绝不写死任何插件名
      source_data: typeof song.source_data === 'string'
        ? song.source_data
        : (song.source_data ? JSON.stringify(song.source_data) : ''),   // 对象则序列化，不窥内部
      dedup_key: song.dedup_key || '',
      lyric: song.lyric || '',
      lyric_source: song.lyric_source || '',
    };

    try {
      const pluginToken = await songloft.plugin.getToken();
      const serverHost = await getHostAPIBaseUrl();
      const fetchResp = await fetch(serverHost + '/api/v1/songs/remote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${pluginToken}` },
        body: JSON.stringify([remoteItem]),
      });
      const text = await fetchResp.text();
      let result: RemoteSongsResponse;
      try {
        result = JSON.parse(text) as RemoteSongsResponse;
      } catch {
        songloft.log.warn('[OnlineSearcher] Failed to parse remote songs response: ' + text);
        // 导入失败（可能是 UNIQUE 约束冲突），尝试查找已存在的歌曲
        return await this.findExistingSong(song.title, song.artist);
      }

      if (!result.songs || result.songs.length === 0) {
        songloft.log.warn('[OnlineSearcher] Remote import returned no songs: ' + text);
        // 导入失败，尝试查找已存在的歌曲
        return await this.findExistingSong(song.title, song.artist);
      }

      const imported = result.songs[0];
      songloft.log.info('[OnlineSearcher] Import success: ' + song.title + ' - ' + song.artist + ', songloft id=' + imported.id);
      return { id: imported.id, url: imported.url };
    } catch (e: any) {
      songloft.log.warn('[OnlineSearcher] Remote import fetch error: ' + String(e));
      return null;
    }
  }

  /**
   * 在 Songloft 数据库中查找已存在的外部导入歌曲
   * 当 /api/v1/songs/remote 因唯一键约束冲突等无法重复导入时作为回退
   */
  private async findExistingSong(title: string, artist: string): Promise<{ id: number; url: string } | null> {
    try {
      let songLimit = 10000;
      try {
        const cfg = await this.configManager.getConfig();
        songLimit = Math.max(1000, Math.min(100000, cfg.max_song_index ?? 10000));
      } catch {}
      const allSongs = await songloft.songs.list({ limit: songLimit });
      const match = allSongs.find(s =>
        s.title === title &&
        s.artist === artist &&
        (s.type === 'remote' || s.url?.startsWith('http'))
      );
      if (match && match.id && match.url) {
        songloft.log.info('[OnlineSearcher] Found existing remote song: ' + title + ' - ' + artist + ', id=' + match.id);
        return { id: match.id, url: match.url };
      }
    } catch (e) {
      songloft.log.warn('[OnlineSearcher] Failed to search existing songs: ' + String(e));
    }
    return null;
  }
}
