// MIoT 智能音箱插件 - 在线歌曲搜索器
// 当本地索引找不到歌曲时，调用用户配置的外部搜索 API 搜索并推送到音箱

/// <reference types="@songloft/plugin-sdk" />

import { MinaService } from '../service/service';
import { getHostBaseUrl } from '../utils/http';
import { URLBuilder } from '../player/url_builder';
import { ConfigManager } from '../config/manager';

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

  constructor(configManager: ConfigManager) {
    this.configManager = configManager;
  }

  /**
   * 检查是否配置了外部搜索 API
   */
  async isExternalSearchConfigured(): Promise<boolean> {
    const config = await this.configManager.getConfig();
    return config.external_search_enabled && !!config.external_search_url && config.external_search_url.trim() !== '';
  }

  /**
   * 获取外部搜索 API 的完整地址
   * 支持两种输入：
   * 1. 完整 URL（以 http:// 或 https:// 开头）直接返回
   * 2. 相对路径（以 / 开头）拼接服务器地址
   */
  private async getSearchBaseUrl(): Promise<string> {
    const config = await this.configManager.getConfig();
    const searchUrl = config.external_search_url?.trim() || '';

    if (!searchUrl) {
      return '';
    }

    if (searchUrl.startsWith('http://') || searchUrl.startsWith('https://')) {
      return searchUrl;
    }

    // 相对路径，拼接服务器地址
    const host = getHostBaseUrl();
    return host + searchUrl;
  }

  /**
   * 获取认证 Token
   * 用户配置的 token 优先，否则使用插件 token
   */
  private async getAuthToken(): Promise<string> {
    const config = await this.configManager.getConfig();
    const userToken = config.external_search_token?.trim();
    if (userToken) {
      return userToken;
    }
    const pluginToken = await songloft.plugin.getToken();
    return `Bearer ${pluginToken}`;
  }

  /**
   * 在线搜索歌曲，仅返回 provider 给出的候选，不导入也不播放。
   *
   * @param keyword       搜索关键词
   * @param hint         可选的歌曲提示（title/artist/duration）
   * @returns 搜索候选，未命中或请求失败返回 null
   */
  async search(
    keyword: string,
    hint: { title: string; artist?: string; duration?: number } | null,
  ): Promise<OnlineSearchResult | null> {
    const reqBody: SearchOneRequest = {
      keyword,
      hint: hint || undefined,
      quality: '320k',
    };

    let resp: SearchOneResponse | null = null;

    const config = await this.configManager.getConfig();
    const timeoutSec = config.external_search_timeout > 0 ? config.external_search_timeout : 6;
    const timeoutMs = timeoutSec * 1000;

    // 带超时的 fetch（用 Promise.race 替代 AbortController，兼容 QuickJS）
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('AbortError')), timeoutMs);
    });

    try {
      const baseUrl = await this.getSearchBaseUrl();
      const authToken = await this.getAuthToken();
      const fetchPromise = fetch(baseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: authToken },
        body: JSON.stringify(reqBody),
      });
      const fetchResp = await Promise.race([fetchPromise, timeoutPromise]);

      const text = await fetchResp.text();
      try {
        resp = JSON.parse(text) as SearchOneResponse;
      } catch {
        songloft.log.warn('[OnlineSearcher] Failed to parse search/topone response: ' + text);
        return null;
      }
    } catch (e: any) {
      if (e.message === 'AbortError') {
        songloft.log.warn(`[OnlineSearcher] Search/topone timeout (>${timeoutSec}s) for keyword: ` + keyword);
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
  ): Promise<boolean> {
    const config = await this.configManager.getConfig();

    // 同步导入到 songloft 数据库，直接拿到 songloft 分配的 id 和 url
    const imported = await this.importSong(song);
    if (!imported) {
      songloft.log.error('[OnlineSearcher] Failed to import song, cannot play: ' + song.title);
      return false;
    }

    // 入库后追加到目标歌单（可选，由配置决定）
    const pid = config.external_search_playlist_id;
    if (pid) {
      try {
        const plToken = await songloft.plugin.getToken();
        await fetch(`${getHostBaseUrl()}/api/v1/playlists/${pid}/songs`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${plToken}` },
          body: JSON.stringify({ song_ids: [imported.id] }),
        });
      } catch (e) { songloft.log.warn(`[OnlineSearcher] 追加歌单失败: ${String(e)}`); }
    }

    // 用返回的 url 构造完整播放 URL（相对路径，URLBuilder 会拼接 server_host 和 token）
    const playUrl = await URLBuilder.buildSongURL({ id: imported.id, url: imported.url});
    if (!playUrl) {
      songloft.log.error('[OnlineSearcher] Failed to build URL for song id=' + imported.id);
      return false;
    }

    // 推送 URL 到音箱（传「歌名-歌手」供触屏歌词模式匹配曲库）
    const songName = song.artist ? `${song.title}-${song.artist}` : song.title;
    const played = await minaService.playURL(accountId, deviceId, playUrl, songName);
    if (!played) {
      songloft.log.error('[OnlineSearcher] Failed to push URL to device: ' + playUrl);
      return false;
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
      const serverHost = getHostBaseUrl();
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
