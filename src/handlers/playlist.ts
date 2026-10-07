// MIoT 智能音箱插件 - 歌单播放 Handler
// 翻译自 Go 源码: plugins/songloft-plugin-xiaomi/handlers/playlist_handler.go

import { jsonResponse, parseQuery } from '@songloft/plugin-sdk';
import type { Router, HTTPRequest } from '@songloft/plugin-sdk';
import { PlaylistManagerMap, isTempPlaylistId, normalizePlayMode, resolvePlaylistResumeStart } from '../player/manager';
import type { PlaylistManager } from '../player/manager';
import { MinaService } from '../service/service';
import { ConfigManager, playlistProgressScope } from '../config/manager';
import { callHostAPI } from '../utils/http';
import { findFavoritesPlaylist } from '../utils/favorites';
import type { PlayMode, PlayState } from '../types';

/** 解析请求体（兼容 Uint8Array 和 string） */
function parseBody(req: HTTPRequest): any {
  if (!req.body) return {};
  try {
    const str = typeof req.body === 'string'
      ? req.body
      : String.fromCharCode.apply(null, Array.from(req.body as Uint8Array));
    return JSON.parse(str);
  } catch {
    return {};
  }
}

/** 判断是否为本地回环地址 */
function isLoopbackAddress(host: string): boolean {
  if (!host) return false;
  let hostname = host;
  const protoIdx = host.indexOf('://');
  if (protoIdx >= 0) {
    const rest = host.slice(protoIdx + 3);
    const slashIdx = rest.indexOf('/');
    const colonIdx = rest.indexOf(':');
    hostname = rest.slice(0, slashIdx >= 0 ? slashIdx : (colonIdx >= 0 ? colonIdx : undefined));
  }
  hostname = hostname.toLowerCase().trim();
  return hostname === 'localhost' || hostname.startsWith('127.') || hostname === '::1';
}

/** 设备播放状态缓存（避免多调用方重复查询设备） */
interface DeviceStatusCache {
  volume: number;
  state: string;
  position: number;  // 秒
  duration: number;  // 秒
  timestamp: number;
  volumeLockedUntil: number;  // 用户显式设置音量后锁定期截止时间戳
  // position 是否真的来自设备的 play_song_detail（而非本地推算/动作后的乐观写入）。
  // 只有设备实测位置才允许回写本地进度，见 syncManagerFromDeviceState。
  positionFromDevice: boolean;
  // 设备上报的当前媒体**流长**（秒，0 = 未上报）。与 duration 不同：duration 会被本地歌曲
  // 时长覆盖（本地元数据更可靠），这里保留设备原值，用于判断音箱在放的是不是我们推的流
  // （PlaylistManager.matchDeviceStream，songloft-org/songloft-plugin-miot#96）。
  streamDuration: number;
}
const deviceStatusCache: Map<string, DeviceStatusCache> = new Map();
const deviceStatusInflight: Map<string, Promise<any>> = new Map();
const playerStatusInflight = new Map<string, Promise<Record<string, any>>>();
export const DEVICE_STATUS_TTL = 4000; // 4秒缓存，略短于前端5秒轮询间隔

/** 主动更新设备状态缓存（供外部调用，如 playURL 成功后刷新） */
export function updateDeviceStatusCache(accountId: string, deviceId: string, data: Partial<DeviceStatusCache> & { lockVolume?: boolean }): void {
  const key = accountId + ':' + deviceId;
  const existing = deviceStatusCache.get(key);
  deviceStatusCache.set(key, {
    volume: data.volume ?? existing?.volume ?? -1,
    state: data.state ?? existing?.state ?? 'idle',
    position: data.position ?? existing?.position ?? 0,
    duration: data.duration ?? existing?.duration ?? 0,
    timestamp: Date.now(),
    volumeLockedUntil: data.lockVolume ? Date.now() + 10000 : (existing?.volumeLockedUntil ?? 0),
    // 外部写入（播放/暂停/停止动作后的乐观刷新）给的都是本地推算位置，不是设备实测
    positionFromDevice: data.positionFromDevice ?? false,
    // 不继承旧的 streamDuration：外部写入多发生在刚推完一条新流之后，旧流长已失效，
    // 留着会让身份校验拿过期流长误判。0 = 未知，校验方会退回保守行为。
    streamDuration: data.streamDuration ?? 0,
  });
}

/** 获取设备状态缓存 */
export function getDeviceStatusCache(accountId: string, deviceId: string): DeviceStatusCache | undefined {
  return deviceStatusCache.get(accountId + ':' + deviceId);
}

/** 同一设备的远程状态探针 in-flight 去重，避免并发轮询刷爆 Mina ubus。 */
export async function getOrFetchDeviceStatus(accountId: string, deviceId: string, fetcher: () => Promise<any>): Promise<any> {
  const key = accountId + ':' + deviceId;
  const existing = deviceStatusInflight.get(key);
  if (existing) {
    return existing;
  }

  const inflight = fetcher().finally(() => {
    if (deviceStatusInflight.get(key) === inflight) {
      deviceStatusInflight.delete(key);
    }
  });
  deviceStatusInflight.set(key, inflight);
  return inflight;
}

function syncManagerFromDeviceState(
  manager: PlaylistManager,
  localState: PlayState,
  deviceState: string,
  devicePosition: number,
  deviceReportsProgress: boolean,
  deviceStreamDuration: number,
  deviceProgressAdvanced: boolean,
): void {
  // 小爱在 URL/MUSIC 播放模式下会偶发把正常播放的流上报成 paused/stopped。
  // 读状态接口不能因此清掉本地自动切歌定时器；只有设备确认在播放时才用它校准恢复。
  if (localState === 'paused' && deviceState === 'playing') {
    // 只认「设备真的在推进」的上报。部分型号暂停后会持续上报 status=1 且不带
    // play_song_detail（位置退化为 0），此时校准会把已暂停播放器的 playStartTimeMs 改写成「现在」，
    // 导致网页进度条归零、续播位置算错（songloft-org/songloft-plugin-miot#60）。
    if (deviceReportsProgress) {
      manager.resetAutoNextTimer(devicePosition);
    }
  } else if (localState === 'playing' && deviceState === 'playing' && manager.isVoiceSuspended()) {
    // 语音交互挂起期间设备「在播放」，可能是小爱在放它自己的内容而不是我们的流。
    // 拿它的进度重锚定时器 = 把小爱内容的位置当成我们歌的位置，剩余时长直接算错，
    // 到点就跳歌（songloft-org/songloft-plugin-miot#96）。认出是外来媒体就不校准，
    // 交给 smartResume 去重推 URL；'unknown'（设备不报流长）保持旧行为。
    if (manager.matchDeviceStream({ status: 1, duration: deviceStreamDuration }) !== 'foreign') {
      manager.resetAutoNextTimer(devicePosition);
    } else {
      songloft.log.warn(`[player/status] Voice-suspended but speaker plays foreign media (deviceDuration=${deviceStreamDuration}s), skip timer calibration`);
    }
  } else if (localState === 'playing' && deviceState === 'playing') {
    // 远程歌曲需要缓冲时间，本地定时器从发送 URL 就开始计时，
    // 但设备要等缓冲完成才开始播放，导致本地位置显著超前设备实际位置。
    // 只在播放早期用设备实际位置校准定时器，防止歌曲提前切歌。
    // 歌曲接近结束后设备可能重拉同一首并上报小进度，此时不能回拨定时器，
    // 否则自动下一首会被无限推迟。
    const localPosition = manager.getPosition();
    if (deviceReportsProgress && deviceProgressAdvanced && localPosition - devicePosition >= 5 &&
      manager.matchDeviceStream({ status: 1, duration: deviceStreamDuration }) !== 'foreign' &&
      manager.canCalibrateAutoNextTimer(devicePosition)) {
      manager.resetAutoNextTimer(devicePosition);
    }
  } else if (localState === 'stopped' && deviceState === 'playing' && deviceReportsProgress) {
    // 插件已 stopped 但设备在播放：用户通过物理按键或其他外部途径恢复了播放。
    // 重新接管自动切歌，避免歌曲播完后音箱单曲循环（songloft-org/songloft-plugin-miot#95）。
    manager.handleExternalResume(devicePosition);
  }
}

function resolveReportState(localState: PlayState, deviceState: string): string {
  if (localState === 'stopped') {
    return 'stopped';
  }
  if (localState === 'playing' && (deviceState === 'paused' || deviceState === 'stopped')) {
    return 'playing';
  }
  return deviceState;
}

function resolveReportPosition(localState: PlayState, deviceState: string, localPosition: number, devicePosition: number): number {
  if (localState === 'stopped') {
    return 0;
  }
  if (localState === 'playing' && deviceState !== 'playing') {
    return localPosition;
  }
  return devicePosition;
}

/**
 * 解析设备的播放状态（本地播放状态优先，设备数据用于音量/进度校准）。
 *
 * 抽取自原 `GET /player/status` handler，供 HTTP 端点与 WebSocket 推送循环
 * 共用同一份状态融合逻辑，避免两条链路结果漂移。返回的对象即前端消费的 `data`
 * 负载：`{ ...localStatus, state, position, duration, volume }`。
 */
export async function resolvePlayerStatus(
  playlistManagerMap: PlaylistManagerMap,
  minaService: MinaService,
  account_id: string,
  device_id: string,
): Promise<Record<string, any>> {
  const key = account_id + ':' + device_id;
  const existing = playerStatusInflight.get(key);
  if (existing) return existing;
  // 不仅共用 HTTP 请求，也只处理一次采样和定时器校准。
  const pending = resolvePlayerStatusOnce(playlistManagerMap, minaService, account_id, device_id).finally(() => {
    if (playerStatusInflight.get(key) === pending) playerStatusInflight.delete(key);
  });
  playerStatusInflight.set(key, pending);
  return pending;
}

async function resolvePlayerStatusOnce(
  playlistManagerMap: PlaylistManagerMap,
  minaService: MinaService,
  account_id: string,
  device_id: string,
): Promise<Record<string, any>> {
  const manager = await playlistManagerMap.getOrCreate(account_id, device_id);
  const localStatus = manager.getStatus();
  const cacheKey = account_id + ':' + device_id;
  const now = Date.now();

  // 带 seek 的续播流对设备是「从 0 开始的新流」，它上报的 position 只是流内偏移；
  // 加上偏移才是曲内绝对位置。不补的话续播后进度条会掉回 0（songloft-org/songloft-plugin-miot#60）。
  // 倍速流下流内偏移还要乘以 speed：设备以原速播放「被压缩过的」流，流内 1 秒 = speed 曲内秒。
  // speed=1 时退化为只加 seekOffset，兼容旧逻辑。
  const seekOffset = manager.getStreamSeekOffsetSec();
  const speed = manager.getPlaybackSpeed();

  // 检查设备状态缓存（4秒内直接复用，避免多调用方重复查询设备）
  const cached = deviceStatusCache.get(cacheKey);
  if (cached && (now - cached.timestamp) < DEVICE_STATUS_TTL) {
    const duration = localStatus.duration > 0 ? localStatus.duration : cached.duration;
    // 设备实测的流内偏移要 × speed + seekOffset 才是曲内绝对位置；非设备实测值（乐观写入）已是绝对位置。
    const cachedAbsPosition = cached.positionFromDevice ? cached.position * speed + seekOffset : cached.position;

    // 播放中时用缓存位置 + 已过墙钟时间推算当前位置，避免返回过时进度。
    // 倍速下墙钟 1 秒 = speed 曲内秒，故 elapsed 也要 × speed。
    let position = cachedAbsPosition;
    if (cached.state === 'playing' && duration > 0) {
      const elapsed = (now - cached.timestamp) / 1000;
      position = Math.min(cachedAbsPosition + elapsed * speed, duration);
    }

    // 缓存只用于展示，不拿旧采样反复回拨切歌定时器。

    // 本地已 stop 时，不让设备残留的播放状态覆盖，避免前端进度条跳动
    const reportState = resolveReportState(localStatus.state, cached.state);
    const reportPosition = resolveReportPosition(localStatus.state, cached.state, localStatus.position, position);

    return { ...localStatus, state: reportState, position: reportPosition, duration, volume: cached.volume };
  }

  // 缓存过期，从设备获取真实播放状态
  let volume = cached?.volume ?? -1;
  let realPosition = localStatus.position;
  let realDuration = localStatus.duration;
  let realState = localStatus.state;
  let devicePosition = -1; // 设备 play_song_detail 上报的流内位置，-1 = 未上报
  let deviceStreamDuration = 0; // 设备上报的当前媒体流长（秒），0 = 未上报；不被本地时长覆盖
  try {
    const raw = await getOrFetchDeviceStatus(account_id, device_id, () => minaService.getPlayerStatus(account_id, device_id));
    const info = raw?.data?.info;
    if (typeof info === 'string') {
      const parsed = JSON.parse(info);
      if (typeof parsed.volume === 'number') {
        if (!cached?.volumeLockedUntil || Date.now() > cached.volumeLockedUntil) {
          volume = parsed.volume;
        }
      }
      if (parsed.status === 1) realState = 'playing';
      else if (parsed.status === 2) realState = 'paused';
      else if (parsed.status === 0) realState = 'stopped';
      if (parsed.play_song_detail) {
        const d = parsed.play_song_detail;
        if (typeof d.position === 'number' && Number.isFinite(d.position) && d.position >= 0) {
          devicePosition = Math.floor(d.position / 1000);
          // seek/倍速流对设备是「从 0 开始的新流」，设备给的是流内偏移：
          // 乘以 speed 还原成曲内秒，再加 seekOffset 得曲内绝对位置。
          realPosition = devicePosition * speed + seekOffset;
        }
        if (typeof d.duration === 'number') {
          deviceStreamDuration = Math.floor(d.duration / 1000);
          realDuration = deviceStreamDuration;
        }
      }
    }
  } catch (e: any) {
    songloft.log.warn('[player/status] getPlayerStatus failed: ' + String(e));
  }

  // 本地歌曲 duration（来自文件元数据）比设备报告的更可靠，
  // 设备在 MUSIC 模式（keepLight=true）下经常报告错误的 duration
  if (localStatus.duration > 0) {
    realDuration = localStatus.duration;
  }

  // 更新缓存。position 存设备原始的流内偏移（未加 seekOffset）：偏移会随下一次重推变化，
  // 缓存里留裸值、读取时再补，才不会在切歌/续播后拿到被旧偏移污染的位置。
  deviceStatusCache.set(cacheKey, {
    volume,
    state: realState,
    position: devicePosition >= 0 ? devicePosition : realPosition,
    duration: realDuration,
    timestamp: Date.now(),
    volumeLockedUntil: cached?.volumeLockedUntil ?? 0,
    positionFromDevice: devicePosition >= 0,
    streamDuration: deviceStreamDuration,
  });

  const progressAdvanced = !cached?.positionFromDevice || devicePosition > cached.position;
  syncManagerFromDeviceState(manager, localStatus.state, realState, realPosition,
    devicePosition > 0, deviceStreamDuration, progressAdvanced);

  // 本地已 stop 时，不让设备残留的播放状态覆盖
  const reportState = resolveReportState(localStatus.state, realState);
  const reportPosition = resolveReportPosition(localStatus.state, realState, localStatus.position, realPosition);

  return { ...localStatus, state: reportState, position: reportPosition, duration: realDuration, volume };
}

/**
 * 注册歌单播放相关路由
 * GET  /playlists              → 获取歌单列表
 * GET  /playlists/:id/songs    → 获取歌单歌曲
 * GET  /playlists/:id/progress → 该设备在该歌单上次播到哪一首
 * POST /player/play            → 播放歌单（start_position: first/resume/random）
 * POST /player/stop          → 停止播放
 * POST /player/previous      → 上一首
 * POST /player/next          → 下一首
 * POST /player/seek          → 跳转播放进度
 * POST /player/speed         → 设置播放倍速
 * POST /player/mode          → 设置播放模式
 * GET  /player/status        → 获取播放状态
 * POST /player/failures/clear → 清除所有设备及分组的临时播放失败标记
 */
export function registerPlaylistHandlers(
  router: Router,
  playlistManagerMap: PlaylistManagerMap,
  minaService: MinaService,
  configManager: ConfigManager,
): void {

  // POST /player/failures/clear - 只清除内存标记，不中断或重新启动播放。
  router.post('/player/failures/clear', async (_req: HTTPRequest) => {
    return jsonResponse({ cleared: playlistManagerMap.clearPlaybackFailures() });
  });

  // GET /playlists - 获取歌单列表
  router.get('/playlists', async (req: HTTPRequest) => {
    try {
      const config = await configManager.getConfig();
      if (!config.server_host) {
        // 未配置服务器地址时返回空列表（附带提示信息），而不是 400 错误
        return jsonResponse({ success: true, data: [], message: '未配置服务器地址，请先在「设置」中配置服务器地址。' });
      }
      if (isLoopbackAddress(config.server_host)) {
        // 回环地址时返回空列表（附带提示信息），而不是 400 错误
        return jsonResponse({ success: true, data: [], message: '服务器地址为本地回环地址（localhost/127.0.0.1），MIoT 智能音箱无法访问。请在「设置」中修改为局域网 IP 地址。' });
      }
      const playlists = await songloft.playlists.list();
      const tempPlaylists = playlistManagerMap.getTempPlaylists();
      const allPlaylists = [
        ...(playlists || []),
        ...tempPlaylists.map(tp => ({ id: tp.id, name: tp.name, song_count: tp.songCount })),
      ];
      return jsonResponse({ success: true, data: allPlaylists });
    } catch (e: any) {
      return jsonResponse({ success: false, error: e.message || String(e) });
    }
  });

  // GET /playlists/:id/songs - 获取歌单歌曲
  router.get('/playlists/:id/songs', async (req: HTTPRequest, params: Record<string, string>) => {
    try {
      const playlistId = Number(params.id);
      if (!playlistId || isNaN(playlistId)) {
        return jsonResponse({ success: false, error: 'invalid playlist id' });
      }
      if (isTempPlaylistId(playlistId)) {
        const manager = playlistManagerMap.findByPlaylistId(playlistId);
        if (!manager) {
          return jsonResponse({ success: true, data: [], expired: true });
        }
        return jsonResponse({ success: true, data: manager.getSongs() });
      }
      // 获取歌单排序偏好
      let sortBy = '';
      let sortOrder = '';
      try {
        const pl: any = await songloft.playlists.getById(playlistId);
        if (pl && pl.sort_by) {
          sortBy = pl.sort_by;
          sortOrder = pl.sort_order || 'asc';
        }
      } catch (e) {
        songloft.log.warn(`[playlists/:id/songs] getById for sort failed: ${String(e)}`);
      }
      const songs = await songloft.playlists.getSongs(playlistId, { limit: 100000, brief: true, sort: sortBy, order: sortOrder } as any);
      return jsonResponse({ success: true, data: songs });
    } catch (e: any) {
      return jsonResponse({ success: false, error: e.message || String(e) });
    }
  });

  // GET /playlists/:id/progress - 查询某设备在该歌单上次播到哪一首（每设备 × 每歌单各一份）
  router.get('/playlists/:id/progress', async (req: HTTPRequest, params: Record<string, string>) => {
    try {
      const query = parseQuery(req.query);
      const { account_id, device_id } = query;
      if (!account_id || !device_id) {
        return jsonResponse({ success: false, error: 'account_id and device_id are required' });
      }
      const playlistId = Number(params.id);
      if (!playlistId || isNaN(playlistId)) {
        return jsonResponse({ success: false, error: 'invalid playlist id' });
      }
      // 临时歌单（语音「播放歌手XX」等）只活在内存里，本来就不记进度
      if (isTempPlaylistId(playlistId)) {
        return jsonResponse({ success: true, data: null });
      }

      // 分组设备的进度记在主设备名下；resolvePrimary 是同步只读解析，不会顺手建 manager
      const primary = playlistManagerMap.resolvePrimary(account_id, device_id);
      const stored = await configManager.getPlaylistProgress(
        playlistProgressScope(primary.account_id, primary.device_id),
        playlistId,
      );
      if (stored) {
        return jsonResponse({ success: true, data: stored });
      }
      // 表里没有时走同一套惰性兜底（老版本只有 DeviceConfig 那一个歌单槽位）
      const resume = await resolvePlaylistResumeStart(configManager, primary, playlistId);
      if (!resume || resume.songId <= 0) {
        return jsonResponse({ success: true, data: null });
      }
      return jsonResponse({
        success: true,
        data: {
          playlist_id: playlistId,
          song_id: resume.songId,
          song_index: resume.songIndex,
          position_sec: 0,
          updated_at: 0,
        },
      });
    } catch (e: any) {
      return jsonResponse({ success: false, error: e.message || String(e) });
    }
  });

  // POST /player/play - 播放歌单
  router.post('/player/play', async (req: HTTPRequest) => {
    try {
      const body = parseBody(req);
      const { account_id, device_id, playlist_id, start_index, play_mode, song_id, start_position } = body;

      if (!account_id) {
        return jsonResponse({ success: false, error: 'account_id is required' });
      }
      if (!device_id) {
        return jsonResponse({ success: false, error: 'device_id is required' });
      }
      if (!playlist_id) {
        return jsonResponse({ success: false, error: 'playlist_id is required' });
      }

      // 检查服务器地址
      const config = await configManager.getConfig();
      if (!config.server_host) {
        return jsonResponse({ success: false, error: '未配置服务器地址，请先在「设置」中配置服务器地址。' });
      }
      if (isLoopbackAddress(config.server_host)) {
        return jsonResponse({ success: false, error: '服务器地址为本地回环地址，MIoT 智能音箱无法访问。请在「设置」中修改为局域网 IP 地址。' });
      }

      const manager = await playlistManagerMap.getOrCreate(account_id, device_id);
      const mode = normalizePlayMode(play_mode);
      const playlistId = Number(playlist_id);
      const startIndex = Number(start_index) || 0;
      const songId = Number(song_id) || 0;

      // 起始位置：显式 song_id > start_position > start_index。
      // start_position 与定时任务的同名参数同一套取值（'first' | 'resume' | 'random'），
      // 缺省 'first' 即旧行为，老前端不传就一点没变。
      const startPosition = typeof start_position === 'string' ? start_position : '';

      // 起始歌曲优先按 song_id 定位：调用方（网页列表）的下标可能基于一份已过期的歌单快照，
      // 与服务端此刻拉到的顺序错位就会播成邻近的歌（#59）。song_id 找不到时才退回下标。
      manager.setAnnounceOnSongChange(false);
      let ok: boolean;
      if (isTempPlaylistId(playlistId)) {
        // 临时歌单（语音「播放歌手XX」等）只存在于内存，没法按 ID 重新拉取
        const localStatus = manager.getStatus();
        const songs = manager.getSongs();
        if (!songs || songs.length === 0 || localStatus.playlist_id !== playlistId) {
          return jsonResponse({ success: false, error: 'temp playlist expired, please re-issue voice command' });
        }
        const idx = songId > 0 ? songs.findIndex((s: any) => s.id === songId) : -1;
        ok = await manager.playWithSongs(songs as any, idx >= 0 ? idx : startIndex, mode, localStatus.playlist_name);
      } else if (songId > 0) {
        ok = await manager.playPlaylistFromSong(playlistId, songId, mode, startIndex);
      } else if (startPosition === 'resume') {
        // 网页「继续播放」：回到这个歌单上次播到的那一首（每设备 × 每歌单各记一份，
        // 中途切去别的歌单也不影响），没有记录就从头播
        const resume = await resolvePlaylistResumeStart(configManager, manager.getPrimary(), playlistId);
        ok = resume && resume.songId > 0
          ? await manager.playPlaylistFromSong(playlistId, resume.songId, mode, resume.songIndex)
          : await manager.play(playlistId, resume ? resume.songIndex : 0, mode);
      } else if (startPosition === 'random') {
        ok = await manager.play(playlistId, 0, mode, { randomStart: true });
      } else {
        ok = await manager.play(playlistId, startIndex, mode);
      }
      if (!ok) {
        return jsonResponse({ success: false, error: 'failed to start playlist' });
      }

      return jsonResponse({
        success: true,
        data: {
          message: 'playlist started',
          playlist_id: playlistId,
          play_mode: mode,
          // 前端据此纠正高亮/列表：与请求的 start_index 不一致说明本地列表已过期
          current_index: manager.getStatus().current_index,
          current_song: manager.getCurrentSong(),
        },
      });
    } catch (e: any) {
      return jsonResponse({ success: false, error: e.message || String(e) });
    }
  });

  // POST /player/stop - 停止播放
  router.post('/player/stop', async (req: HTTPRequest) => {
    try {
      const body = parseBody(req);
      const query = parseQuery(req.query);
      const account_id = body.account_id || query.account_id;
      const device_id = body.device_id || query.device_id;

      if (!account_id || !device_id) {
        return jsonResponse({ success: false, error: 'account_id and device_id are required' });
      }

      const manager = playlistManagerMap.get(account_id, device_id);
      if (!manager) {
        return jsonResponse({ success: false, error: 'no active playlist for this device' });
      }
      const lastPosition = manager.getStatus().position;
      await manager.stop();
      updateDeviceStatusCache(account_id, device_id, { state: 'stopped', position: lastPosition });
      return jsonResponse({ success: true, data: { message: 'playlist stopped' } });
    } catch (e: any) {
      return jsonResponse({ success: false, error: e.message || String(e) });
    }
  });

  // POST /player/toggle - 切换播放/暂停状态
  router.post('/player/toggle', async (req: HTTPRequest) => {
    try {
      const body = parseBody(req);
      const query = parseQuery(req.query);
      const account_id = body.account_id || query.account_id;
      const device_id = body.device_id || query.device_id;

      if (!account_id || !device_id) {
        return jsonResponse({ success: false, error: 'account_id and device_id are required' });
      }

      const manager = await playlistManagerMap.getOrCreate(account_id, device_id);
      const status = manager.getStatus();

      if (manager.isPlaying()) {
        // 正在播放，暂停
        const lastPosition = manager.getStatus().position;
        await manager.pause();
        updateDeviceStatusCache(account_id, device_id, { state: 'paused', position: lastPosition });
        return jsonResponse({ success: true, data: { message: 'playlist paused', state: 'paused' } });
      }

      if (!manager.hasPlaylist()) {
        return jsonResponse({ success: false, error: 'no playlist loaded, please select a playlist first' });
      }

      // 检查是否处于 paused 状态，如果是则恢复
      if (status.state === 'paused') {
        const ok = await manager.resumePlayback();
        if (ok) {
          updateDeviceStatusCache(account_id, device_id, { state: 'playing', position: manager.getStatus().position });
          return jsonResponse({
            success: true,
            data: {
              message: 'playlist resumed',
              state: 'playing',
              current_song: manager.getCurrentSong(),
            },
          });
        }
        // 如果 resumePlayback 失败，回退到重新播放
      }

      // 检查服务器地址
      const config = await configManager.getConfig();
      if (!config.server_host) {
        return jsonResponse({ success: false, error: '未配置服务器地址，请先在「设置」中配置服务器地址。' });
      }
      if (isLoopbackAddress(config.server_host)) {
        return jsonResponse({ success: false, error: '服务器地址为本地回环地址，MIoT 智能音箱无法访问。请在「设置」中修改为局域网 IP 地址。' });
      }

      // 处于 stopped 状态或 resumePlayback 失败，重新播放
      manager.setAnnounceOnSongChange(false);
      if (isTempPlaylistId(status.playlist_id)) {
        // 临时歌单：内存中歌曲列表仍在，直接重放
        const songs = manager.getSongs();
        if (!songs || songs.length === 0) {
          return jsonResponse({ success: false, error: 'temp playlist expired, please re-issue voice command' });
        }
        const ok = await manager.playWithSongs(songs as any, status.current_index, status.play_mode as PlayMode, status.playlist_name);
        if (!ok) {
          return jsonResponse({ success: false, error: 'failed to resume temp playlist' });
        }
      } else {
        const ok = await manager.play(status.playlist_id, status.current_index, status.play_mode as PlayMode);
        if (!ok) {
          return jsonResponse({ success: false, error: 'failed to resume playback' });
        }
      }

      updateDeviceStatusCache(account_id, device_id, { state: 'playing', position: 0 });
      return jsonResponse({
        success: true,
        data: {
          message: 'playlist resumed',
          state: 'playing',
          current_song: manager.getCurrentSong(),
        },
      });
    } catch (e: any) {
      return jsonResponse({ success: false, error: e.message || String(e) });
    }
  });

  // POST /player/previous - 上一首
  router.post('/player/previous', async (req: HTTPRequest) => {
    try {
      const body = parseBody(req);
      const query = parseQuery(req.query);
      const account_id = body.account_id || query.account_id;
      const device_id = body.device_id || query.device_id;

      if (!account_id || !device_id) {
        return jsonResponse({ success: false, error: 'account_id and device_id are required' });
      }

      const manager = playlistManagerMap.get(account_id, device_id);
      if (!manager) {
        return jsonResponse({ success: false, error: 'no active playlist for this device' });
      }

      manager.setAnnounceOnSongChange(false);
      const ok = await manager.previous();
      if (!ok) {
        return jsonResponse({ success: false, error: 'failed to play previous' });
      }
      return jsonResponse({ success: true, data: { message: 'playing previous song', current_song: manager.getCurrentSong() } });
    } catch (e: any) {
      return jsonResponse({ success: false, error: e.message || String(e) });
    }
  });

  // POST /player/next - 下一首
  router.post('/player/next', async (req: HTTPRequest) => {
    try {
      const body = parseBody(req);
      const query = parseQuery(req.query);
      const account_id = body.account_id || query.account_id;
      const device_id = body.device_id || query.device_id;

      if (!account_id || !device_id) {
        return jsonResponse({ success: false, error: 'account_id and device_id are required' });
      }

      const manager = playlistManagerMap.get(account_id, device_id);
      if (!manager) {
        return jsonResponse({ success: false, error: 'no active playlist for this device' });
      }

      manager.setAnnounceOnSongChange(false);
      const ok = await manager.next();
      if (!ok) {
        const status = manager.getStatus();
        if (status.state === 'stopped') {
          updateDeviceStatusCache(account_id, device_id, { state: 'stopped', position: status.position });
          return jsonResponse({ success: true, data: { message: 'playlist completed', state: 'stopped', current_song: status.current_song } });
        }
        return jsonResponse({ success: false, error: 'failed to play next' });
      }
      return jsonResponse({ success: true, data: { message: 'playing next song', current_song: manager.getCurrentSong() } });
    } catch (e: any) {
      return jsonResponse({ success: false, error: e.message || String(e) });
    }
  });

  // POST /player/seek - 跳转播放进度
  router.post('/player/seek', async (req: HTTPRequest) => {
    try {
      const body = parseBody(req);
      const query = parseQuery(req.query);
      const account_id = body.account_id || query.account_id;
      const device_id = body.device_id || query.device_id;
      const requestedPosition = Number(body.position);

      if (!account_id || !device_id) {
        return jsonResponse({ success: false, error: 'account_id and device_id are required' });
      }
      if (!Number.isFinite(requestedPosition) || requestedPosition < 0) {
        return jsonResponse({ success: false, error: 'position must be a non-negative number' });
      }

      const manager = playlistManagerMap.get(account_id, device_id);
      const song = manager?.getCurrentSong();
      if (!manager || !song) {
        return jsonResponse({ success: false, error: 'no active song for this device' });
      }
      if (song.type === 'radio' || !song.duration || song.duration <= 0) {
        return jsonResponse({ success: false, error: 'current song does not support seeking' });
      }

      // playCurrent 会把靠近结尾的 seek 退化为整首重播，因此在端点处显式夹到安全范围。
      const position = Math.min(Math.floor(requestedPosition), Math.max(0, song.duration - 3));
      const wasPaused = manager.getStatus().state === 'paused';
      const ok = await manager.replayCurrent(position);
      if (!ok) {
        return jsonResponse({ success: false, error: 'failed to seek current song' });
      }
      if (wasPaused) {
        await manager.pause();
      }

      const state = wasPaused ? 'paused' : 'playing';
      updateDeviceStatusCache(account_id, device_id, { state, position });
      return jsonResponse({ success: true, data: { message: 'playback position updated', state, position } });
    } catch (e: any) {
      return jsonResponse({ success: false, error: e.message || String(e) });
    }
  });

  // POST /player/speed - 设置播放倍速
  router.post('/player/speed', async (req: HTTPRequest) => {
    try {
      const body = parseBody(req);
      const query = parseQuery(req.query);
      const account_id = body.account_id || query.account_id;
      const device_id = body.device_id || query.device_id;
      const speed = Number(body.speed);

      if (!account_id || !device_id) {
        return jsonResponse({ success: false, error: 'account_id and device_id are required' });
      }
      if (!Number.isFinite(speed) || speed < 0.5 || speed > 2.0) {
        return jsonResponse({ success: false, error: 'speed must be a number in [0.5, 2.0]' });
      }

      const manager = playlistManagerMap.get(account_id, device_id);
      if (!manager) {
        return jsonResponse({ success: false, error: 'no active playlist for this device' });
      }
      const song = manager.getCurrentSong();
      if (song && (song.type === 'radio' || !song.duration || song.duration <= 0)) {
        // 电台/无时长歌曲不支持变速：仍持久化设置（切到普通歌曲后生效），但不重推流。
        songloft.log.info(`[player/speed] current song does not support speed, persisted only speed=${speed}`);
        return jsonResponse({ success: true, data: { message: 'speed persisted but current song does not support seeking', speed } });
      }

      const ok = await manager.setPlaybackSpeed(speed);
      if (!ok) {
        return jsonResponse({ success: false, error: 'failed to set playback speed' });
      }

      const state = manager.getStatus().state;
      const position = manager.getStatus().position;
      updateDeviceStatusCache(account_id, device_id, { state, position });
      return jsonResponse({ success: true, data: { message: 'playback speed set', state, speed } });
    } catch (e: any) {
      return jsonResponse({ success: false, error: e.message || String(e) });
    }
  });

  // POST /player/mode - 设置播放模式
  router.post('/player/mode', async (req: HTTPRequest) => {
    try {
      const body = parseBody(req);
      const query = parseQuery(req.query);
      const account_id = body.account_id || query.account_id;
      const device_id = body.device_id || query.device_id;
      const play_mode = body.play_mode;

      if (!account_id || !device_id) {
        return jsonResponse({ success: false, error: 'account_id and device_id are required' });
      }
      if (!play_mode) {
        return jsonResponse({ success: false, error: 'play_mode is required' });
      }

      const manager = playlistManagerMap.get(account_id, device_id);
      if (!manager) {
        return jsonResponse({ success: false, error: 'no active playlist for this device' });
      }

      const mode = normalizePlayMode(play_mode);
      await manager.setPlayMode(mode);
      return jsonResponse({ success: true, data: { message: 'play mode set', play_mode: mode } });
    } catch (e: any) {
      return jsonResponse({ success: false, error: e.message || String(e) });
    }
  });

  // GET /player/status - 获取播放状态（本地播放状态优先，设备数据用于音量/进度校准）
  router.get('/player/status', async (req: HTTPRequest) => {
    try {
      const query = parseQuery(req.query);
      const { account_id, device_id } = query;

      if (!account_id || !device_id) {
        return jsonResponse({ success: false, error: 'account_id and device_id are required' });
      }

      const data = await resolvePlayerStatus(playlistManagerMap, minaService, account_id, device_id);
      return jsonResponse({ success: true, data });
    } catch (e: any) {
      return jsonResponse({ success: false, error: e.message || String(e) });
    }
  });

  // GET /player/favorite/status - 查询歌曲是否已收藏
  router.get('/player/favorite/status', async (req: HTTPRequest) => {
    try {
      const query = parseQuery(req.query);
      const songId = Number(query.song_id);
      if (!songId || isNaN(songId)) {
        return jsonResponse({ success: false, error: 'song_id is required' });
      }
      const playlists = await songloft.playlists.list();
      const favPlaylist = findFavoritesPlaylist(playlists);
      if (!favPlaylist) {
        return jsonResponse({ success: true, data: { is_favorited: false } });
      }
      const songs = await songloft.playlists.getSongs(favPlaylist.id, { limit: 100000 });
      const isFavorited = songs.some(song => Number(song.id) === songId);
      return jsonResponse({ success: true, data: { is_favorited: isFavorited, playlist_id: favPlaylist.id } });
    } catch (e: any) {
      return jsonResponse({ success: false, error: e.message || String(e) });
    }
  });

  // POST /player/favorite/toggle - 收藏/取消收藏歌曲
  router.post('/player/favorite/toggle', async (req: HTTPRequest) => {
    try {
      const body = parseBody(req);
      const songId = Number(body.song_id);
      const action = body.action; // 'add' | 'remove'
      if (!songId || isNaN(songId)) {
        return jsonResponse({ success: false, error: 'song_id is required' });
      }
      if (action !== 'add' && action !== 'remove') {
        return jsonResponse({ success: false, error: 'action must be "add" or "remove"' });
      }
      const playlists = await songloft.playlists.list();
      const favPlaylist = findFavoritesPlaylist(playlists);
      if (!favPlaylist) {
        return jsonResponse({ success: false, error: '未找到收藏歌单' });
      }
      if (action === 'add') {
        await songloft.playlists.addSongs(favPlaylist.id, [songId]);
      } else {
        await songloft.playlists.removeSongs(favPlaylist.id, [songId]);
      }
      return jsonResponse({ success: true, data: { is_favorited: action === 'add' } });
    } catch (e: any) {
      return jsonResponse({ success: false, error: e.message || String(e) });
    }
  });

  // POST /player/song/remove - 从歌单删除歌曲（可选：同时从曲库删除）
  //
  // 语音场景需求（songloft-org/songloft#465）：用户听音箱时不想的歌不必切回本地
  // 歌单模式再删。此端点做两件事：
  //   1) 从传入的歌单里移除该歌曲（临时歌单不涉盘，只改内存；真实歌单调 bridge）
  //   2) 可选：同时把歌曲从曲库物理删除（含封面/缓存清理，songs.write 权限）
  // 若删的正是本设备当前在播的那首，先切下一首（next() 会推 URL + 持久化），
  // 再从内存队列摘掉它，避免"删完后音箱还继续播那首已消失的歌"。
  router.post('/player/song/remove', async (req: HTTPRequest) => {
    try {
      const body = parseBody(req);
      const playlistId = Number(body.playlist_id);
      const songId = Number(body.song_id);
      const fromLibrary = body.from_library === true;
      const account_id = String(body.account_id || '');
      const device_id = String(body.device_id || '');
      if (!playlistId || isNaN(playlistId)) {
        return jsonResponse({ success: false, error: 'playlist_id is required' });
      }
      if (!songId || isNaN(songId)) {
        return jsonResponse({ success: false, error: 'song_id is required' });
      }

      // 1) 从歌单删除。临时歌单没有持久化记录，跳过 bridge；bridge 内部把
      // 「歌曲本不在歌单里」当幂等成功，重复点击不会报错。
      if (!isTempPlaylistId(playlistId)) {
        await songloft.playlists.removeSongs(playlistId, [songId]);
      }

      // 2) 若这台设备在这个歌单上正播的就是被删的这首，先切下一首。
      // 只考虑请求里指定的设备：其它设备各自的队列由自己的下次拉取来更新。
      if (account_id && device_id) {
        const manager = playlistManagerMap.get(account_id, device_id);
        if (manager) {
          const status = manager.getStatus();
          const managerPlaylistMatches = status.playlist_id === playlistId;
          if (managerPlaylistMatches) {
            const currentSongId = status.current_song?.id;
            if (currentSongId === songId) {
              // next() 内部：若队列还剩其它歌就切并推 URL，否则 stop
              await manager.next();
            }
            await manager.removeSongFromMemory(songId);
          }
        }
      }

      // 3) 可选：从曲库物理删除。收藏歌单不会自动把「已收藏」标记清掉——
      // 这里删的是歌曲本体，收藏列表里那条记录随着歌曲的消失自然失效。
      if (fromLibrary) {
        try {
          await songloft.songs.delete(songId);
        } catch (e: any) {
          // 歌曲不在曲库不算错（可能之前已被别处删过）；其它错误按原样上抛。
          const msg = e?.message || String(e);
          if (!/not found/i.test(msg)) {
            return jsonResponse({ success: false, error: msg });
          }
        }
      }

      return jsonResponse({ success: true, data: { removed: true, from_library: fromLibrary } });
    } catch (e: any) {
      return jsonResponse({ success: false, error: e.message || String(e) });
    }
  });
}
