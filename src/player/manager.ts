// MIoT 智能音箱插件 - 歌单播放管理器
// 翻译自 Go 源码: plugins/songloft-plugin-xiaomi/player/playlist_manager.go
// 管理播放状态机、播放模式切换、自动切歌

/// <reference types="@songloft/plugin-sdk" />

import { ConfigManager, playlistProgressScope } from '../config/manager';
import { MinaService } from '../service/service';
import { URLBuilder, playbackOptionsOf, playbackOptionsFromConfig } from './url_builder';
import { hasLostDeviceMedia, isDeviceIdle, isDeviceStatusKnown } from '../playback/device_state';
import { getHostBaseUrl, callHostAPI } from '../utils/http';
import { isDebugLog } from '../utils/debug';
import type { PlayState, PlayMode, PlayerStatus, DeviceTargetRef, DeviceGroup } from '../types';

/** 分配临时歌单唯一负数 ID（每个设备/歌手各一个，互不冲突） */
let nextTempPlaylistId = -1;
function allocTempPlaylistId(): number {
  return nextTempPlaylistId--;
}

/**
 * 外部停止探测参数（songloft-org/songloft#408）。
 * 自动切歌定时器纯按 wall-clock 驱动，对"设备被外部真正停止"（如语音"关机"未被
 * ConversationMonitor 捕获、且网页/App 已关闭没有轮询校准）完全不知情，到期会无条件
 * 给设备推下一首，表现为"关机后隔一段时间又自动播放"。
 */
/**
 * 重载续播锚点的最长有效期（songloft-org/songloft-plugin-miot#96）。
 * 热重载只花一两秒，正常场景远小于这个值。超过就认为「不是同一次会话」——
 * 例如服务停了一夜、第二天有人打开网页才建 manager，此时绝不该把音箱叫起来放歌。
 */
const RESUME_ANCHOR_MAX_AGE_MS = 5 * 60 * 1000;

/** 探测间隔：歌曲播放期间每隔这么久查一次设备真实播放状态 */
const EXTERNAL_STOP_POLL_INTERVAL_MS = 20000;
/** 距歌曲自然结束前这段时间内停止探测：设备放完最后一段本身也会短暂上报 stopped/idle，
 * 与"被外部真的停止"无法区分（同类风险见 handlers/playlist.ts syncManagerFromDeviceState 注释） */
const EXTERNAL_STOP_TAIL_GUARD_SEC = 15;
/** 连续命中"未在播放"多少次才判定为真实外部停止，抵御小爱偶发误报（单次误报会被下一轮探测纠正） */
const EXTERNAL_STOP_CONFIRM_COUNT = 2;
/**
 * 两次探测间设备位置推进多少秒才算「其实还在播放」（songloft-org/songloft#449）。
 *
 * 小爱在推流播放下会把正常播放**连续**误报成 status=2，两次确认根本挡不住：#449 的日志里
 * 起播后第 1、2 次探测都报 status=2，插件据此下发 pause+stop，把在放的音频真停了；
 * 而同一份上报里的 position 一路推进到 43s（恰好是下发 stop 的时刻），证明 status 在骗人、
 * position 是准的。所以 status 不再是唯一判据：位置明显推进就判定 status 误报。
 *
 * 探测间隔 20s，真在播放时位置会推进约 20s，取 5s 阈值容忍上报抖动与网络延迟。
 * 设备真停了位置会冻结或归零，都不满足推进，仍走原来的两次确认。
 *
 * 位置基线只在**连续「未在播放」上报的序列内部**有效，一旦读到 status=1 就清空：跨越
 * 一次正常上报去比位置，会把「上一轮还在播、本轮真被停在更靠后的位置」当成推进而放过，
 * 真实外部停止的确认要多等两轮（#408 那类「关机后又自动播放」就有机会复发）。
 */
const EXTERNAL_STOP_POSITION_ADVANCE_MIN_SEC = 5;

/**
 * 外部恢复探测参数（songloft-org/songloft-plugin-miot#95）。
 * 与 EXTERNAL_STOP_* 对称：stop 在 playing 态探测设备停止，resume 在 stopped 态探测设备恢复。
 * 覆盖无 Web 前端连接时用户通过音箱物理按键恢复播放的场景。
 */
/** 探测间隔 */
const EXTERNAL_RESUME_POLL_INTERVAL_MS = 15000;
/** 最长探测时间，超时后放弃（设备真的关机时不必永久轮询） */
const EXTERNAL_RESUME_POLL_MAX_MS = 600000;
/** 连续命中"设备在播放"多少次才确认为真实恢复（与 EXTERNAL_STOP_CONFIRM_COUNT 对称） */
const EXTERNAL_RESUME_CONFIRM_COUNT = 2;

/**
 * URL 下发「假失败」核实参数（songloft-org/songloft-plugin-miot#98）。
 *
 * 小米云端抖动时 ubus 会返回 `code=101` + `device_data code=3012 远程控制超时`——
 * 那只说明**云端没等到设备回执**，指令往往已经到设备并正常起播了。旧实现把它当硬失败，
 * advanceToNext 重试一次、跳一首、再失败就 state='stopped'，切歌定时器从此不再注册，
 * 音箱把当前这首播完就再没有下一首，表现为「歌单还有歌但播完某首就停」。
 *
 * 与 verifyResumeOrRepush 是对称的两半：那边防「ubus 说成功但没真播上」，
 * 这边防「ubus 说失败但其实已播上」。
 *
 * 探测窗口需要覆盖设备端云侧秒级抖动：`play-url` 和 `getPlayState` 走同一云端，
 * 抖动期两个调用会同时不通，`status<0` 短路会让核实立刻失败（songloft-org/songloft-player#45）。
 * 因此把 `status<0` 从「立即判失败」放宽为「本轮无信号，继续下一轮」，配合更大的探测次数
 * 争取云端恢复的那一次响应；总窗口 ~6s，仍远小于用户可感知的静默。
 */
const PUSH_VERIFY_ATTEMPTS = 5;
const PUSH_VERIFY_DELAY_MS = 1200;
/**
 * 「刚起播」窗口：核实时设备的流内位置必须还落在流开头，否则不认这次下发已生效。
 *
 * 两个作用：① 设备不上报流长（matchDeviceStream 只能返回 'unknown'，见 #60 机型）时它是
 * 唯一判据；② 挡掉流长身份校验放过的「上一首还在播」——那道校验的容差是「5 秒或 5%」的大者，
 * 相邻两首时长接近时（#98 日志里 247s 与 253s，容差 12.65s）会被判成 'ours'。
 *
 * 取 30s：真落地的推流从设备起播到这里最多几秒（play-url 超时余量 ~3.5s + 核实 1.2s），
 * 余量充足；而上一首若还在播，位置通常已在几十秒开外。
 */
const PUSH_VERIFY_START_WINDOW_SEC = 30;

/** 续播位置允许五秒流内误差，容忍设备取整、缓冲与本地计时偏差。 */
const RESUME_POSITION_TOLERANCE_SEC = 5;

/**
 * duration==0 时的兜底切歌探测参数（songloft-org/songloft#437）。
 *
 * 歌曲元数据 duration==0 是常态（远程/插件歌曲元数据未刷新，见后端 seek_stream.go 注释），
 * playCurrent 的正常分支拿不到 duration 就无法注册切歌定时器，onSongFinished 永不触发，
 * 音箱自然播完会反复重拉同一 URL，表现为「单曲循环、不推进列表」。
 * 兜底：开播后轮询 getPlayState() 读设备上报的流长，据此注册正常定时器；
 * 设备不上报流长（部分机型，见 #60）则退化为「循环回零」探测——position 曾推进到阈值
 * 以上又落回近 0，即视为音箱重拉同一 URL（自然播完），触发 onSongFinished。
 */
/** 兜底探测轮询间隔 */
const DURATION_PROBE_INTERVAL_MS = 5000;
/** position 须曾推进到该值（墙钟秒）以上，回零才算「播完」而非首播抖动/短暂 rebuffer */
const LOOP_DETECT_MIN_ADVANCE_SEC = 10;
/** position 落到该值以下视为回零（音箱从头重拉同一 URL） */
const LOOP_DETECT_RESET_THRESHOLD_SEC = 3;

/**
 * duration>0 正常路径的「尾部设备进度校验」参数（songloft-org/songloft#481）。
 *
 * 自动切歌是纯 wall-clock 定时器（startCheckTimer），时长写死为元数据
 * `song.duration + offset`，从不看设备真实进度。当设备实际音频比元数据短（转码差异、
 * 元数据取整、起播缓冲未计入锚点），设备会先自己播完 → 循环重拉同一 URL 或停滞在结尾，
 * 而插件仍死等定时器到点，用户听到「一首播完又重播/停滞 1~2 秒才切歌」。靠调负 offset
 * 只能盲盖固定差值：小了盖不全、大了误切尾部（#481 用户实测 -2 仍有残留）。
 *
 * 主定时器到点也核对设备进度（#495）：设备仍未播完时延后，查询失败时重试后再兜底。
 * 始终不上报进度的设备仍按歌曲时长切歌，不额外等待结束确认宽限期（#124）。
 * 另在最后一段窗口内起一轮轻量探测，一旦读到设备**真实已结束**的证据就提前切歌，
 * 缩短已循环/停滞到切歌的窗口。复用 duration==0 兜底探测里已验证的「循环回零」判据，
 * 另补「设备已停」和「结尾停滞」两条，覆盖 #481 描述的两种表现（重播 / 停滞）。
 */
/** 进入歌曲最后这段窗口（曲内秒）才启动尾部探测；与 EXTERNAL_STOP_TAIL_GUARD_SEC 的盲区对齐，
 * 恰好接管那段「主定时器主动关掉外部停止探测」的尾部盲区 */
const TAIL_PROBE_WINDOW_SEC = 15;
/** 本地检查间隔；普通采样五秒，确认尾部后有限次缩到一秒，缓存不作为新证据。 */
const TAIL_PROBE_INTERVAL_MS = 1000;
/** 与 Mina 的 HTTP 超时对齐，避免正常的秒级云端响应尚未返回就切歌。 */
const DEADLINE_QUERY_WAIT_MS = 5000;
const DEADLINE_RETRY_MS = 5000;
/** 连续有效进度刷新宽限；证据中断后最多重试这段时间，避免无限阻塞队列。 */
const DEADLINE_GRACE_MS = 30000;
/** 设备进度保留毫秒：流内推进 100ms 即视为在播放，容忍少量上报抖动。 */
const TAIL_STALL_ADVANCE_MIN_SEC = 0.1;
/** 持续停滞的最低墙钟时长：保留原来 3 秒 × 2 轮的等待，不能随轮询加速缩短 */
const TAIL_STALL_CONFIRM_MS = 6000;
/** 仅容忍设备秒级取整；距结尾尚有十几秒的缓冲不能当作播完（#495）。 */
const TAIL_STALL_NEAR_END_SEC = 2;
/** 尾部 stopped/paused 需连续确认，且位置不能仍在推进。 */
const TAIL_STOP_CONFIRM_COUNT = 2;

type DevicePlayState = Awaited<ReturnType<MinaService['getPlayState']>>;

interface DeadlineTailEvidence {
  position: number;
  duration: number;
  sampledAt: number;
  confirmed: boolean;
  interrupted: boolean;
  stopHits: number;
}

/** 仅在服务器本地时间整点后 90 秒内识别；不按时钟无条件推歌。 */
const HOURLY_RESUME_WINDOW_MS = 90000;
const HOURLY_RESUME_POLL_MS = 3000;
const HOURLY_RESUME_FAST_POLL_MS = 1000;
const HOURLY_RESUME_FAST_QUERIES = 4;

interface HourlyResumeTask {
  position: number;
  startedAt: number;
  waiting: boolean;
  cancelled: boolean;
  isCurrent: () => boolean;
}

/**
 * 起播确认探测参数（songloft-org/songloft#466）。
 *
 * ubus `code=0` 只代表「云端把消息代理给了设备」，不代表设备真的拉到了流。
 * 音源解析失败（例如 lxmusic 所有音源全崩，后端 /songs/{id}/play 返回 502）时，
 * 音箱拉流失败会 TTS「播放失败，换一首试试吧」并停下——而 checkExternalStop 要 20s
 * 才轮询一次、判定后走 stop() 只取消定时器不推进队列，表现为整个歌单彻底停摆。
 * 这里在下发成功后另起一次「起播确认」：等设备起播缓冲窗口过去再回读 status/position，
 * 两次仍读到 status!=1 就判为未起播，走 advanceToNext 直接跳下一首。
 *
 * 与 verifyPushLanded 的分工：那边在 ubus 报失败时救「假失败」（云端超时但设备实播），
 * 这边在 ubus 报成功时抓「假成功」（云端应答成功但设备没起播）。节奏也刻意错开：
 * 那边 1.2s×2 抢时效（要早于 advanceToNext 重试链），这边 10+8s 容忍慢网络与冷启动。
 */
const LANDING_VERIFY_FIRST_DELAY_MS = 10000;
const LANDING_VERIFY_RETRY_DELAY_MS = 8000;
const LANDING_VERIFY_ATTEMPTS = 2;

/**
 * 起播确认的「状态盲区」参数（songloft-org/songloft-plugin-miot#129）。
 *
 * 部分机型（OH2 等 Music API/代理播放设备）正常出声时，`player_get_play_status`
 * 仍持续返回 status=0、position=0、duration=0。此时状态既不能证明起播成功，
 * 也不能证明失败：
 * - 先对当前流做一次 HEAD 探测：后端明确 404/410/5xx 才是真不可播，继续跳歌；
 * - 流可拉取、或探测无法下结论（超时/外链）时，最多观察
 *   LANDING_BLIND_ACCEPT_ATTEMPTS 轮，随后接受这条流并按元数据定时器播放，
 *   不把「设备不上报」当成起播失败。
 * 一旦拿到正进度或流长，立即退出盲区，恢复原有严格判定。
 */
const LANDING_BLIND_ACCEPT_ATTEMPTS = 2;
const LANDING_STREAM_PROBE_TIMEOUT_MS = 5000;

/**
 * 状态盲区设备的尾部兜底窗口（#129）。
 * 整首都没上报过正进度/流长时，到点校验不再多等三十秒「暂时缺失」宽限，
 * 直接按元数据时长切歌（与 #124 无进度设备按时切歌一致）。
 * 六十秒足以排除刚起播的正常缓冲；单次有效 0 仍不等同于「设备不支持进度」。
 */
const STREAM_BLIND_METADATA_FALLBACK_MS = 60000;

/**
 * 连续起播失败的熔断阈值：达到即停播并 TTS 提示，避免整个音源都挂时把整个歌单跳完。
 * 计数在任何一次起播确认成功（status=1）后清零。
 */
const LANDING_FAILURE_CIRCUIT_BREAK = 3;

/** 临时失败只跳过五分钟，网络或音源恢复后允许重新尝试（songloft-org/songloft#494）。 */
export const UNPLAYABLE_SONG_TTL_MS = 5 * 60 * 1000;

type SongFailureReason = 'prefetch' | 'landing' | 'early-stop';

/**
 * 「外部停止 + 位置极早」→ 起播失败等价情形（#466）。
 * checkExternalStop 确认外部停止时若 position 落在起播早期窗口内，语义等同「刚下发的
 * 这首没真播上」，走 handleLandingFailure（跳下一首 + TTS）而不是 stop(false)。
 * 起播确认漏网（首查恰好 status=1、随后 502）由这条兜住。
 */
const LANDING_EARLY_STOP_SEC = 15;

/** 连续失败熔断 TTS 文案 */
const LANDING_CIRCUIT_BREAK_TTS_TEXT = '当前多首歌曲无法播放，请稍后再试';
/** 电台/单曲播放起播失败 TTS 文案（无「下一首」可跳，直接停播） */
const LANDING_TERMINAL_FAILURE_TTS_TEXT = '当前歌曲暂时无法播放，请稍后再试';

/** 判断 playlistId 是否为临时歌单 */
export function isTempPlaylistId(id: number): boolean {
  return id < 0;
}

/**
 * 解析「这台设备上次在该歌单播到哪」，供语音「播放歌单X」、定时任务
 * `start_position=resume`、网页「继续播放」三条路共用同一份口径。
 *
 * 先查每歌单进度表；表里没有时做一次惰性兜底：老版本只有 DeviceConfig 那**一个**歌单槽位，
 * 若它记的正好是同一个歌单，就拿它合成一份（只读不写盘，用户升级后第一次仍能续上，
 * 不需要迁移脚本）。返回 null 表示没有可续播的进度，调用方从歌单头部开始。
 *
 * `primary` 必须传 `PlaylistManager.getPrimary()`：分组设备的进度记在主设备名下，
 * 用户点的那台不一定是主设备。
 */
export async function resolvePlaylistResumeStart(
  configManager: ConfigManager,
  primary: DeviceTargetRef,
  playlistId: number,
): Promise<{ songId: number; songIndex: number } | null> {
  if (!playlistId || playlistId <= 0) return null;
  try {
    const progress = await configManager.getPlaylistProgress(
      playlistProgressScope(primary.account_id, primary.device_id),
      playlistId,
    );
    if (progress) {
      return { songId: progress.song_id, songIndex: Math.max(0, progress.song_index || 0) };
    }
    const devices = await configManager.getDevices(primary.account_id);
    const devCfg = devices.find(d => d.device_id === primary.device_id);
    if (devCfg && devCfg.playlist_id === playlistId) {
      const songId = devCfg.resume_song_id || 0;
      const songIndex = Math.max(0, devCfg.current_song_index || 0);
      if (songId > 0 || songIndex > 0) {
        return { songId, songIndex };
      }
    }
  } catch (e) {
    songloft.log.warn('[PlaylistManager] resolvePlaylistResumeStart failed: ' + String(e));
  }
  return null;
}

/** 统一播放模式，并兼容旧版 Web 前端曾写入的别名。 */
export function normalizePlayMode(mode: unknown, fallback: PlayMode = 'order'): PlayMode {
  switch (String(mode || '')) {
    case 'order':
      return 'order';
    case 'loop':
      return 'loop';
    case 'single':
    case 'repeat_one':
      return 'single';
    case 'singlePlay':
    case 'single_play':
    case 'single-play':
    case 'single-once':
      return 'singlePlay';
    case 'random':
    case 'shuffle':
      return 'random';
    default:
      return fallback;
  }
}

// ===== 歌曲类型 =====

/** 歌曲信息（从宿主API返回） */
interface Song {
  id: number;
  type: string;       // "local" | "remote" | "radio"
  title: string;
  artist: string;
  album: string;
  duration: number;   // 秒
  file_path: string;
  url: string;
  cover_path: string;
  cover_url: string;
  lyric_url: string;  // 歌词URL（后端统一端点）
  file_size: number;
  format: string;
  bit_rate: number;
  sample_rate: number;
  is_live: boolean;
  cache_hash: string;
}

/** 宿主API歌单歌曲响应 */
interface PlaylistSongsResponse {
  code: number;
  data: {
    songs: Song[];
    total: number;
  };
}

// ===== PlaylistManager - 单设备播放管理器 =====

/**
 * PlaylistManager - 管理单个设备的歌单播放
 * 实现播放状态机、播放模式切换、定时切歌
 */
export class PlaylistManager {
  private accountId: string;
  private deviceId: string;
  private minaService: MinaService;
  private configManager: ConfigManager;

  private state: PlayState = 'idle';
  private playMode: PlayMode = 'order';
  private playlistId: number = 0;
  private songs: Song[] = [];
  private currentIndex: number = 0;
  private checkTimer: any = null;       // 定时器ID（基于歌曲时长的切歌定时器）
  private checkTimerDeadlineMs: number = 0; // 尾部校准只提前结束校验，不推迟已有兜底
  private checkTimerFallbackDeadlineMs: number = 0; // 提前校验拿不到结束证据时，仍等原有截止时间
  private checkTimerGeneration: number = 0; // 每次清理定时器递增，使在途查询在同曲重播/续播后失效
  private stopPollTimer: any = null;    // 定时器ID（后台探测外部停止，见 EXTERNAL_STOP_* 常量）
  private stopPollScheduleVersion: number = 0;
  private stopPollFastConfirmationUsed: boolean = false;
  private stopPollMisses: number = 0;   // 连续探测到设备"未在播放"的次数
  private stopPollLastPosition: number = -1; // 上次探测读到的设备流内位置（秒），-1 = 还没有基线
  private stopPollMaxPosition: number = 0; // 外部停止探测期间见过的最大设备流内位置（秒），
  // 用于区分「自然播完 position 回零」与「起播即失败」(#114)：曾推进到起播窗口之外又落回近 0
  // 配合尾部位置/时间证据识别自然结束；中途回零视作中断，不走起播失败的跳歌级联
  private stopPollDeadlineMs: number = 0; // 外部停止探测的绝对截止墙钟（ms），按实际墙钟判定是否
  // 继续下一轮，避免按调度间隔递减、不计云端查询耗时导致 stop-poll 漏进尾部窗口与 tail-probe 竞态(#114)
  private stopPollLastSampleAt: number = -1;
  private stopPollResumePosition: number | null = null;
  private stopPollFirstStopAtMs: number = 0;
  private playbackConfirmed: boolean = false;
  private streamStartedAtMs: number = 0;
  private hourlyResumeTask: HourlyResumeTask | null = null;
  private hourlyResumeTimer: any = null;
  private hourlyResumeWake: (() => void) | null = null;
  private lastHourlyResumeHour: number = -1;
  private hourlyResumeCancelVersion: number = 0;
  private resumePollTimer: any = null;  // 定时器ID（后台探测外部恢复，见 EXTERNAL_RESUME_* 常量）
  private resumePollStartedAt: number = 0;
  private resumePollHits: number = 0;   // 连续探测到设备"在播放"的次数
  private durationProbeTimer: any = null; // 定时器ID（duration==0 时兜底切歌探测，见 DURATION_PROBE_* 常量）
  private maxProbePosition: number = 0;   // 循环回零探测：本轮见过的最大设备 position，用于判定是否回零
  private tailProbeTimer: any = null;     // 定时器ID（duration>0 尾部设备进度校验，见 TAIL_PROBE_* 常量，#481）
  private tailProbeMaxPosition: number = 0; // 尾部探测：最大设备流内位置，seek 起点不参与回零判定
  private tailProbeLastPosition: number = -1; // 尾部探测：上一轮流内位置，-1=无基线
  private tailProbeLastCheckedAtMs: number = 0;
  private tailProbeLastSampleAt: number = -1;
  private tailProbeStallStartedAtMs: number | null = null; // 连续未推进的墙钟起点
  private tailProbeStopMisses: number = 0;
  private tailProbeQuery: Promise<DevicePlayState> | null = null; // 尾部探测与到点校验共享在途查询
  private cancelDeadlineQuery: (() => void) | null = null;
  private deadlineLastPosition: number = -1; // 上次延期位置，重复的冻结上报不能无限延期
  private deadlineSamplePosition: number = -1;
  private deadlineSampleAtMs: number = -1;
  private deadlineGraceDeadlineMs: number = 0;
  private deadlineTailEvidence: DeadlineTailEvidence | null = null;
  private tailLoopSample: { position: number; duration: number; sampledAt: number } | null = null;
  // 已由连续尾部采样确认的当前流特征；恢复身份使用，不能当作准确时长/结束证据。
  private confirmedTailStream: { songId: number; seek: number; speed: number; duration: number } | null = null;
  private devicePositionObserved: boolean = false; // 当前流曾收到有效进度，软续播保留、重新推流清空
  // 当前流是否出现过正进度/正流长。与 devicePositionObserved（包含有效的零）不同：
  // OH2 等全零设备需要把「整条流从未上报」与「单次暂时缺失」区分开（#129）。
  private streamEvidenceObserved: boolean = false;
  private streamPositionObserved: boolean = false;
  private blindIdleNoticeLogged: boolean = false; // 当前流已记录过「全零 idle，忽略外停探测」
  private landingVerifyTimer: any = null; // 定时器ID（起播确认探测，见 LANDING_VERIFY_* 常量）
  private landingFailureCount: number = 0; // 连续起播失败次数（#466 熔断），任何一次确认成功即清零
  private unplayableSongs = new Map<number, { reason: SongFailureReason; expiresAt: number }>();
  // 每首歌只接受最新预取的结果；起播、成功确认和手动清除会作废旧请求。
  private prefetchRequests = new Map<number, object>();
  private totalSongs: number = 0;
  private playStartTimeMs: number = 0;  // 当前歌曲开始播放的时间戳(ms)
  private randomPlayed: Set<number> = new Set(); // 随机模式已播放索引
  // 已定好的下一首索引，-1 = 还没定。随机模式下 getNextIndex() 每次调用都重新摇骰子，
  // 于是「预热的那首」和「真正播的那首」是两首不同的歌，预热等于白做
  // （songloft-org/songloft-plugin-miot#61：开了音量均衡后每首歌都要冷启动整首 loudnorm，
  // 表现为前 20 多秒空白 + 尾部被砍）。改为先定后用：reserveNextIndex() 定一次，
  // 预热与自动切歌共用同一个结果。
  private pendingNextIndex: number = -1;
  private voiceSuspendedPosition = 0;
  private voiceSuspendedAt: number = 0; // suspendForVoiceInteraction 首次调用时间戳
  private tempPlaylistName: string = ''; // 临时歌单名称（如"歌手: 周杰伦"），playlistId < 0 时有效
  private readonly tempId: number; // 该 manager 的固定临时歌单 ID（构造时分配，生命周期内复用）
  private tempArtistQuery: string = ''; // 临时歌手歌单的原始搜索词，用于持久化和恢复
  private tempArtistExact = false;
  private tempStartSongId = 0;
  private pendingTempArtist: string = ''; // 待恢复的临时歌手名（索引就绪后自动恢复）
  private _lastLoadNotFound: boolean = false; // 上次 loadPlaylistSongs 失败是否因歌单不存在(ID 过期)
  private hardStopped: boolean = false; // 上次暂停被设备忽略而升级为 stop：设备端已无媒体上下文，续播需重推 URL
  private pausedPositionSec: number = 0; // 暂停瞬间的曲内位置，硬停后据此重推带 seek 的 URL 续播
  private transitionOffset: number = 0;  // 当前歌曲的 song_transition_offset（playCurrent 时缓存，负值=提前切歌）
  // 当前推给设备的流从歌曲第几秒开始。带 seek 的流对音箱是「从 0 开始的新流」，
  // 它上报的 position 只是流内偏移；加上本值才是曲内绝对位置（消费点见 handlers/playlist.ts）。
  private streamSeekOffsetSec: number = 0;
  // 当前推给设备的流的播放倍速。倍速流对音箱是「从 0 开始、已被时间压缩/拉伸过的新流」，
  // 它正常速度播放，上报的流内偏移要乘以本值才是曲内秒；与 streamSeekOffsetSec 一起参与换算。
  // 默认 1.0（不变速），seek 续播/切歌后随 playCurrent 一起重置。
  private playbackSpeed: number = 1.0;
  // 输出目标设备集合：独立设备时仅含自身；分组时含组内全部成员。
  // 一个分组共用一个 PlaylistManager（同一套队列/索引/播放模式/定时器/随机数），
  // 播放/暂停/停止/切歌等指令统一下发给 targets 里的所有音箱，从根本上保证多房间同步、随机不跑偏。
  // accountId/deviceId 仍作为「主设备」用于持久化、日志与自动切歌定时器的进度校准参考。
  private targets: DeviceTargetRef[];
  private onAdvanceHook?: () => boolean;
  private announceOnSongChange: boolean = false;

  constructor(
    accountId: string,
    deviceId: string,
    minaService: MinaService,
    configManager: ConfigManager,
  ) {
    this.accountId = accountId;
    this.deviceId = deviceId;
    this.targets = [{ account_id: accountId, device_id: deviceId }];
    this.minaService = minaService;
    this.configManager = configManager;
    this.tempId = allocTempPlaylistId();
  }

  // ===== 公开方法 =====

  private interactionGuard?: () => void;
  setInteractionGuard(callback: (() => void) | undefined): () => void {
    this.interactionGuard = callback;
    return () => { if (this.interactionGuard === callback) this.interactionGuard = undefined; };
  }
  private invalidateInteraction(): void {
    const callback = this.interactionGuard; this.interactionGuard = undefined; callback?.();
  }
  getInteractionPosition(): number { return this.state === 'paused' ? this.pausedPositionSec : this.getPosition(); }
  reserveForVoiceInteraction(): void {
    if (this.isPlaying()) this.suspendForVoiceInteraction();
    else this.stopCheckTimer();
  }
  async holdAfterInteraction(position: number): Promise<void> {
    this.stopCheckTimer(); this.clearVoiceSuspend(); this.state = 'paused'; this.hardStopped = true;
    this.pausedPositionSec = position; await this.persistState();
  }

  private externalPlayback = false;
  private externalRelease: (() => void) | null = null;
  private playbackEpoch = 0;
  private pendingPlayback = new Set<Promise<unknown>>();
  private externalOperations = new Set<Promise<unknown>>();

  /** DLNA 接管前作废歌单驱动，并等已在途的推送结束，避免云端请求反向覆盖。 */
  async beginExternalPlayback(onRelease: () => void): Promise<boolean> {
    this.invalidateInteraction();
    this.minaService.notifyControl?.(this.accountId, this.deviceId);
    this.externalPlayback = true;
    this.externalRelease = onRelease;
    const epoch = ++this.playbackEpoch;
    this.cleanup();
    this.clearVoiceSuspend();
    this.state = 'stopped';
    await Promise.allSettled(Array.from(this.pendingPlayback));
    if (!this.externalPlayback || epoch !== this.playbackEpoch) return false;
    this.cleanup();
    this.state = 'stopped';
    this.playStartTimeMs = 0;
    await this.persistState();
    return this.externalPlayback && epoch === this.playbackEpoch;
  }

  /** 结束外部接管后仍保持歌单停止；只有新的用户播放操作才恢复驱动。 */
  endExternalPlayback(): void {
    this.invalidateInteraction();
    if (!this.externalPlayback) return;
    this.externalPlayback = false;
    this.playbackEpoch++;
    const release = this.externalRelease;
    this.externalRelease = null;
    release?.();
  }

  isExternalPlayback(): boolean { return this.externalPlayback; }

  /** 新歌单必须等外部在途控制结束后再推送，保证最后一次用户操作获胜。 */
  runExternalPlayback<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.externalPlayback) return Promise.reject(new Error('External playback superseded'));
    const pending = operation();
    this.externalOperations.add(pending);
    void pending.then(() => this.externalOperations.delete(pending), () => this.externalOperations.delete(pending));
    return pending;
  }

  private trackPlayback<T>(operation: () => Promise<T>): Promise<T> {
    const pending = operation();
    this.pendingPlayback.add(pending);
    void pending.then(() => this.pendingPlayback.delete(pending), () => this.pendingPlayback.delete(pending));
    return pending;
  }

  /**
   * 设置切歌前的 hook 回调。返回 true 表示拦截切歌并停止播放。
   * 用于 SleepTimer 曲目模式：每切一首递减计数，归零时拦截。
   */
  setOnAdvanceHook(hook: (() => boolean) | undefined): void {
    this.onAdvanceHook = hook;
  }

  setAnnounceOnSongChange(enabled: boolean): void {
    this.announceOnSongChange = enabled;
  }

  /**
   * 播放歌单
   * @param playlistId - 歌单ID
   * @param startIndex - 起始歌曲索引（默认0）
   * @param mode - 播放模式（默认order）
   * @param opts.randomStart - 忽略 startIndex，加载歌单后随机挑一首作为起点
   * @returns 是否成功
   */
  async play(playlistId: number, startIndex?: number, mode?: PlayMode, opts?: { randomStart?: boolean; isCurrent?: () => boolean }): Promise<boolean> {
    if (opts?.isCurrent?.() === false) return false;
    this.endExternalPlayback();
    // 立即停止定时器和重置状态，防止 loadPlaylistSongs 期间旧定时器触发 onSongFinished
    this.stopCheckTimer();
    this.state = 'idle';
    this.playStartTimeMs = 0;
    this._lastLoadNotFound = false;

    // 加载歌单歌曲
    const loaded = await this.loadPlaylistSongs(playlistId, opts?.isCurrent);
    if (!loaded) {
      songloft.log.error('[PlaylistManager] play: loadPlaylistSongs returned false, playlistId=' + playlistId);
      return false;
    }

    if (this.songs.length === 0) {
      songloft.log.warn('[PlaylistManager] Playlist is empty: ' + playlistId);
      return false;
    }

    // 设置播放参数
    this.playlistId = playlistId;
    this.tempPlaylistName = '';
    this.tempArtistQuery = '';
    this.pendingTempArtist = '';
    if (opts?.randomStart && this.songs.length > 0) {
      this.currentIndex = Math.floor(Math.random() * this.songs.length);
    } else {
      this.currentIndex = (startIndex !== undefined && startIndex >= 0 && startIndex < this.songs.length)
        ? startIndex : 0;
    }
    this.playMode = normalizePlayMode(mode);
    this.randomPlayed = new Set();
    this.clearPendingNextIndex();

    // 开始播放当前歌曲
    const ok = await this.playCurrent({ isCurrent: opts?.isCurrent });
    if (!ok) {
      songloft.log.error('[PlaylistManager] Failed to play current song');
      return false;
    }

    // 持久化播放状态到设备配置
    await this.persistState();

    songloft.log.info(`[PlaylistManager] Playlist started id=${playlistId} index=${this.currentIndex} mode=${this.playMode} total=${this.songs.length}`);
    return true;
  }

  /**
   * 播放歌单并从指定歌曲 ID 开始播放
   * 用于外部搜索导入并追加到歌单后，接管为「完整歌单播放」，
   * 使歌曲播完后由切歌定时器自动续播歌单其余歌曲（issue #53）；
   * 也用于网页端点列表播放——按歌曲 ID 定位比按下标可靠，前端列表与
   * 服务端刚拉取的歌单顺序不一致时不会串歌（#59）。
   * 找不到该歌曲时回退到 fallbackIndex（未传则歌单头部）。
   * @param playlistId - 歌单ID
   * @param songId - 起始歌曲ID（通常是刚追加到歌单末尾的那首）
   * @param mode - 播放模式（默认order）
   * @param fallbackIndex - 歌单内找不到 songId 时的兜底起始下标
   * @returns 是否成功
   */
  async playPlaylistFromSong(playlistId: number, songId: number, mode?: PlayMode, fallbackIndex?: number, isCurrent?: () => boolean): Promise<boolean> {
    if (isCurrent?.() === false) return false;
    this.endExternalPlayback();
    // 立即停止定时器和重置状态，防止 loadPlaylistSongs 期间旧定时器触发 onSongFinished
    this.stopCheckTimer();
    this.state = 'idle';
    this.playStartTimeMs = 0;
    this._lastLoadNotFound = false;

    const loaded = await this.loadPlaylistSongs(playlistId, isCurrent);
    if (!loaded) {
      songloft.log.error('[PlaylistManager] playPlaylistFromSong: loadPlaylistSongs returned false, playlistId=' + playlistId);
      return false;
    }

    if (this.songs.length === 0) {
      songloft.log.warn('[PlaylistManager] Playlist is empty: ' + playlistId);
      return false;
    }

    // 定位目标歌曲索引；追加的歌曲通常在末尾，找不到时回退到 fallbackIndex（默认歌单头部）
    let startIndex = this.songs.findIndex(s => s.id === songId);
    if (startIndex < 0) {
      startIndex = (fallbackIndex !== undefined && fallbackIndex >= 0 && fallbackIndex < this.songs.length)
        ? fallbackIndex : 0;
      songloft.log.warn(`[PlaylistManager] Song ${songId} not found in playlist ${playlistId}, falling back to index ${startIndex}`);
    }

    this.playlistId = playlistId;
    this.tempPlaylistName = '';
    this.tempArtistQuery = '';
    this.pendingTempArtist = '';
    this.currentIndex = startIndex;
    this.playMode = normalizePlayMode(mode);
    this.randomPlayed = new Set();
    this.clearPendingNextIndex();

    const ok = await this.playCurrent({ isCurrent: isCurrent });
    if (!ok) {
      songloft.log.error('[PlaylistManager] playPlaylistFromSong: Failed to play current song');
      return false;
    }

    await this.persistState();

    songloft.log.info(`[PlaylistManager] Playlist started from song id=${songId} playlistId=${playlistId} index=${startIndex} mode=${this.playMode} total=${this.songs.length}`);
    return true;
  }

  /**
   * 播放预构建的歌曲列表（无需歌单ID）。
   * 用于"播放歌手XX的歌"等场景，将跨歌单收集的歌曲作为虚拟播放列表。
   * @param artistQuery - 歌手搜索词，用于重启后恢复
   */
  async playWithSongs(songs: Song[], startIndex: number, mode: PlayMode, label?: string, artistQuery?: string, isCurrent?: () => boolean, exactArtist?: boolean): Promise<boolean> {
    if (isCurrent?.() === false) return false;
    this.endExternalPlayback();
    this.stopCheckTimer();
    this.state = 'idle';
    this.playStartTimeMs = 0;
    this._lastLoadNotFound = false;
    this.pendingTempArtist = '';

    if (!songs || songs.length === 0) {
      songloft.log.warn('[PlaylistManager] playWithSongs: empty song list');
      return false;
    }

    this.songs = songs;
    this.totalSongs = songs.length;
    this.playlistId = this.tempId;
    this.tempPlaylistName = label || '';
    this.tempArtistQuery = artistQuery !== undefined ? artistQuery : this.tempArtistQuery;
    // 页面在同一临时列表里选曲时不传 artistQuery，保留队列来源与初始顺序。
    this.tempArtistExact = exactArtist ?? (artistQuery === undefined && this.tempArtistExact);
    this.tempStartSongId = this.tempArtistExact ? (artistQuery === undefined ? this.tempStartSongId : songs[0].id) : 0;
    this.currentIndex = (startIndex >= 0 && startIndex < songs.length) ? startIndex : 0;
    this.playMode = normalizePlayMode(mode);
    this.randomPlayed = new Set();
    this.clearPendingNextIndex();

    const ok = await this.playCurrent({ isCurrent: isCurrent });
    if (!ok) {
      songloft.log.error('[PlaylistManager] playWithSongs: failed to play current song');
      return false;
    }

    await this.persistState();
    songloft.log.info(`[PlaylistManager] playWithSongs started id=${this.playlistId} label="${this.tempPlaylistName}" index=${this.currentIndex} mode=${this.playMode} total=${this.songs.length}`);
    return true;
  }

  /** 点播独立歌曲时，先播放命中歌曲，再续播曲库中同歌手的歌曲。 */
  async playStandaloneSong(
    song: Song,
    indexingManager: import('../indexing/manager').IndexingManager,
    taskCurrent?: () => boolean,
  ): Promise<boolean> {
    const revision = this.getPlaybackRevision();
    const epoch = this.playbackEpoch;
    const isCurrent = () =>
      taskCurrent?.() !== false && revision === this.getPlaybackRevision() && epoch === this.playbackEpoch;
    let mode: PlayMode = 'order';
    try {
      const devices = await this.configManager.getDevices(this.accountId);
      mode = normalizePlayMode(devices.find((device) => device.device_id === this.deviceId)?.play_mode);
    } catch (e) {
      songloft.log.warn('[PlaylistManager] Failed to read standalone play mode: ' + String(e));
    }
    if (!isCurrent()) return false;
    const artist = song.type === 'radio' ? '' : (song.artist || '').trim();
    let others: Song[] = [];
    if (artist && song.type !== 'radio') {
      try {
        others = await indexingManager.loadLibrarySongsByArtist(artist, isCurrent);
      } catch (e) {
        songloft.log.warn('[PlaylistManager] Failed to build artist queue: ' + String(e));
      }
    }
    if (!isCurrent()) return false;
    const seen = new Set([song.id]);
    const queue = [
      song,
      ...others.filter((candidate) => {
        if (seen.has(candidate.id)) return false;
        seen.add(candidate.id);
        return true;
      }),
    ];
    // playWithSongs 会改变 revision，传入的任务守卫仍由它贯穿实际推流。
    // 不入库的临时直链可能过期，不持久化它的歌手队列恢复标记。
    return this.playWithSongs(
      queue,
      0,
      mode,
      artist ? '歌手: ' + artist : '单曲: ' + song.title,
      song.id > 0 ? artist : '',
      taskCurrent,
      true,
    );
  }

  /**
   * 对所有输出目标设备并发执行同一设备操作，单个失败仅告警不影响其它成员。
   * 返回是否「至少一台」成功（用于 play/resume 判定整体是否成功）。
   */
  private async forEachTarget(
    label: string,
    fn: (t: DeviceTargetRef) => Promise<boolean>,
  ): Promise<boolean> {
    const results = await Promise.all(this.targets.map(async (t) => {
      try {
        return await fn(t);
      } catch (e) {
        songloft.log.warn(`[PlaylistManager] ${label} failed for ${t.account_id}:${t.device_id}: ${String(e)}`);
        return false;
      }
    }));
    return results.some(r => r);
  }

  /**
   * 暂停播放（保持状态，可恢复）
   *
   * 逐台核验暂停是否真的生效：部分型号会受理 pause 却继续出声，此时底层已升级为 stop。
   * 只要有一台被硬停，就记下 hardStopped——设备端媒体上下文已丢失，续播必须重推 URL。
   */
  async pause(isCurrent?: () => boolean): Promise<void> {
    if (isCurrent?.() === false) return;
    this.invalidateInteraction();
    return this.trackPlayback(() => this.pauseInternal(isCurrent));
  }

  private async pauseInternal(isCurrent?: () => boolean): Promise<void> {
    // 先抓位置：getPosition() 在 state !== 'playing' 时恒返回 0，改状态之后就取不到了。
    // 硬停续播靠它跳回原处（songloft-org/songloft-plugin-miot#60）。
    // 判 playing 是为了让重复暂停不把已记下的位置擦成 0。
    if (this.state === 'playing') {
      this.pausedPositionSec = this.getPosition();
    }

    this.stopCheckTimer();
    this.clearVoiceSuspend();
    this.state = 'paused';
    // 不重置 playStartTimeMs，保持当前播放进度

    // 暂停所有目标设备（分组时为组内全部音箱）
    const results = await Promise.all(this.targets.map(async (t) => {
      try {
        return await this.minaService.pausePlayVerified(t.account_id, t.device_id, isCurrent);
      } catch (e) {
        songloft.log.warn(`[PlaylistManager] pause failed for ${t.account_id}:${t.device_id}: ${String(e)}`);
        return 'failed' as const;
      }
    }));
    this.hardStopped = this.hardStopped || results.includes('stopped');

    songloft.log.info(`[PlaylistManager] Playback paused results=${results.join(',')} hardStopped=${this.hardStopped} position=${this.pausedPositionSec.toFixed(1)}s`);

    // 落盘暂停位置：不写的话重载续播会拿着「暂停前那个 playing 锚点」外推，
    // 把暂停这段时长也算成已播时长（#96）
    await this.persistState();
  }

  /**
   * 停止播放
   *
   * @param pushToDevice - 是否向设备下发 stop 指令。默认 true（用户/语音/定时等主动停止）。
   *   外部停止探测传 false：那条路径的前提是「设备已经自己停了」，下发 pause+stop 在判断
   *   正确时是多余动作，判断错误时会把正在播放的音频真停掉（#449）。本地状态、续播锚点、
   *   外部恢复探测等收尾动作与主动停止完全一致。
   */
  async stop(pushToDevice = true, isCurrent?: () => boolean): Promise<void> {
    if (isCurrent?.() === false) return;
    this.invalidateInteraction();
    return this.trackPlayback(() => this.stopInternal(pushToDevice, isCurrent));
  }

  private async stopInternal(pushToDevice: boolean, isCurrent?: () => boolean): Promise<void> {
    this.stopCheckTimer();
    this.clearVoiceSuspend();
    this.confirmedTailStream = null;
    this.state = 'stopped';
    this.playStartTimeMs = 0;
    this.pausedPositionSec = 0;
    this.streamSeekOffsetSec = 0;
    this.transitionOffset = 0;

    if (pushToDevice) {
      await this.forEachTarget('stop', t => this.minaService.stopPlay(t.account_id, t.device_id, isCurrent));
    }

    songloft.log.info(`[PlaylistManager] Playback stopped pushToDevice=${pushToDevice}`);

    // 清掉重载续播锚点：停止之后重载不该再自动出声（#96）
    await this.persistState();

    this.startResumePoll();
  }

  /**
   * 下一首
   * @returns 是否成功
   */
  async next(isCurrent?: () => boolean): Promise<boolean> {
    if (isCurrent?.() === false) return false;
    this.endExternalPlayback();
    this.stopCheckTimer();
    if (this.songs.length === 0) {
      songloft.log.warn('[PlaylistManager] No playlist loaded for next');
      return false;
    }

    // 单曲播放只限制自然播完后的推进，手动下一首仍按队列顺序切换。
    // 其它模式用已定好的那首：随机模式下它已经被 prefetchNextSong 预热过。
    const nextIdx = this.playMode === 'singlePlay'
      ? (this.currentIndex < this.songs.length - 1 ? this.currentIndex + 1 : -1)
      : this.reserveNextIndex();
    if (nextIdx < 0) {
      songloft.log.info('[PlaylistManager] No next song, stopping');
      await this.stop();
      return false;
    }

    this.currentIndex = nextIdx;
    const ok = await this.playCurrent({ isCurrent: isCurrent });
    if (ok) {
      await this.persistState();
    }
    return ok;
  }

  /**
   * 上一首
   * @returns 是否成功
   */
  async previous(isCurrent?: () => boolean): Promise<boolean> {
    if (isCurrent?.() === false) return false;
    this.endExternalPlayback();
    this.stopCheckTimer();
    if (this.songs.length === 0) {
      songloft.log.warn('[PlaylistManager] No playlist loaded for previous');
      return false;
    }

    const prevIdx = this.getPreviousIndex();
    if (prevIdx < 0) {
      songloft.log.info('[PlaylistManager] No previous song');
      return false;
    }

    this.currentIndex = prevIdx;
    const ok = await this.playCurrent({ isCurrent: isCurrent });
    if (ok) {
      await this.persistState();
    }
    return ok;
  }

  /**
   * 跳到当前歌单/临时列表的第 index 首（0 起）。
   * 不重载歌单、不改播放模式，仅移动 currentIndex 并 playCurrent；
   * 越界或没有歌单时返回 false，由调用方决定给不给 TTS。
   */
  async playAtIndex(index: number, isCurrent?: () => boolean): Promise<boolean> {
    if (isCurrent?.() === false) return false;
    this.endExternalPlayback();
    this.stopCheckTimer();
    if (this.songs.length === 0) {
      songloft.log.warn('[PlaylistManager] playAtIndex: no playlist loaded');
      return false;
    }
    if (index < 0 || index >= this.songs.length) {
      songloft.log.warn(`[PlaylistManager] playAtIndex: index ${index} out of range (total=${this.songs.length})`);
      return false;
    }
    // 已定好的下一首是按旧下标算的，跳位后必须作废重算，避免自动切歌时又跳回去。
    this.clearPendingNextIndex();
    this.currentIndex = index;
    this.state = 'idle';
    this.playStartTimeMs = 0;
    const ok = await this.playCurrent({ isCurrent: isCurrent });
    if (ok) {
      await this.persistState();
    }
    return ok;
  }

  /**
   * 设置播放模式
   */
  async setPlayMode(mode: PlayMode): Promise<void> {
    const normalizedMode = normalizePlayMode(mode);
    this.playMode = normalizedMode;
    // 已定好的下一首是按旧模式算的，换模式后必须作废重算（如 order → random）
    this.clearPendingNextIndex();

    // 切换到随机模式时重置已播放记录
    if (normalizedMode === 'random') {
      this.randomPlayed = new Set();
    }

    // 持久化到设备配置
    try {
      await this.configManager.updateDevice(this.accountId, this.deviceId, {
        play_mode: normalizedMode,
      });
    } catch (e) {
      songloft.log.warn('[PlaylistManager] Failed to save play mode: ' + String(e));
    }

    songloft.log.info('[PlaylistManager] Play mode set to ' + normalizedMode);
  }

  /**
   * 设置输出目标设备集合（分组时为组内全部成员；独立时为自身）。
   * 由 PlaylistManagerMap 在解析分组后注入/刷新。空集合时回退为主设备自身，避免无目标。
   */
  setTargets(targets: DeviceTargetRef[]): void {
    this.targets = (targets && targets.length > 0)
      ? targets.slice()
      : [{ account_id: this.accountId, device_id: this.deviceId }];
  }

  /** 主设备（分组时为成员列表第一个）：用于持久化与自动切歌定时器的进度校准参考。 */
  getPrimary(): DeviceTargetRef {
    return { account_id: this.accountId, device_id: this.deviceId };
  }

  /**
   * 获取播放状态
   */
  getStatus(): PlayerStatus {
    let currentSong: { id: number; title: string; artist: string; cover_url?: string; lyric_url?: string } | undefined;
    let duration = 0;
    if (this.currentIndex >= 0 && this.currentIndex < this.songs.length) {
      const song = this.songs[this.currentIndex];
      currentSong = { id: song.id, title: song.title, artist: song.artist, cover_url: song.cover_url, lyric_url: song.lyric_url };
      duration = song.duration;
    }

    return {
      state: this.state,
      play_mode: this.playMode,
      playlist_id: this.playlistId,
      current_index: this.currentIndex,
      current_song: currentSong,
      position: this.getPosition(),
      duration: duration,
      is_playing: this.state === 'playing',
      playlist_name: this.tempPlaylistName || undefined,
      speed: this.playbackSpeed,
    };
  }

  /** 状态采样跨越暂停、切歌或重新计时后失效，不能用于回写新的播放上下文。 */
  getPlaybackRevision(): number {
    return this.checkTimerGeneration;
  }

  /** 返回当前加载的歌曲列表（临时歌单/真实歌单均可），供 handler 读取 */
  getSongs(): any[] {
    return this.songs;
  }

  /**
   * 从内存队列里移除一首歌，把 currentIndex 和随机模式记录调整过来。
   *
   * 只改内存不发设备指令：调用方（POST /player/song/remove handler）负责先决定
   * 「删的是不是正在播的那首」——若是，要先切下一首（next() 会持久化并推 URL），
   * 再回来调本方法把它从队列删掉。这样自动切歌与队列一致性由持久化收口负责，
   * 本方法不重复触发。
   *
   * pendingNextIndex 里可能指向旧下标，必须清；randomPlayed 记的是**下标**而非
   * 歌曲 id，删掉一首后所有位于其后的下标都要减 1，否则随机模式下的"已播过"判断
   * 会错位。
   *
   * 删完必须重新 persistState：调用方若刚 next() 过（删的是正播那首），持久化里存的
   * 还是**旧队列**的下标，不重存的话热重载后 restoreFromConfig 会恢复到错一位的歌。
   * 返回 true 表示确有一首被删。
   */
  async removeSongFromMemory(songId: number): Promise<boolean> {
    const idx = this.songs.findIndex(s => s.id === songId);
    if (idx < 0) return false;
    this.songs.splice(idx, 1);
    if (this.currentIndex > idx) {
      this.currentIndex -= 1;
    } else if (this.currentIndex === idx) {
      this.currentIndex = Math.min(this.currentIndex, Math.max(0, this.songs.length - 1));
    }
    this.totalSongs = this.songs.length;
    if (this.randomPlayed.size > 0) {
      const remapped = new Set<number>();
      for (const played of this.randomPlayed) {
        if (played < idx) remapped.add(played);
        else if (played > idx) remapped.add(played - 1);
      }
      this.randomPlayed = remapped;
    }
    this.clearPendingNextIndex();
    await this.persistState();
    return true;
  }

  /** 返回该 manager 的固定临时歌单 ID */
  getTempId(): number {
    return this.tempId;
  }

  /**
   * 获取当前歌曲
   */
  getCurrentSong(): Song | null {
    if (this.currentIndex >= 0 && this.currentIndex < this.songs.length) {
      return this.songs[this.currentIndex];
    }
    return null;
  }

  /**
   * 是否有播放列表
   */
  hasPlaylist(): boolean {
    return this.songs.length > 0;
  }

  /**
   * 当前歌单/临时列表的歌曲总数
   */
  getTotalSongs(): number {
    return this.songs.length;
  }

  /**
   * 是否正在播放
   */
  isPlaying(): boolean {
    return this.state === 'playing';
  }

  /**
   * 是否仍处于允许用设备进度校准本地自动切歌定时器的窗口。
   * 仅用于播放刚开始的缓冲修正；歌曲接近结束后不允许设备端小进度回拨定时器，
   * 否则某些音箱循环拉同一 URL 时会把自动下一首无限推迟。
   */
  canCalibrateAutoNextTimer(devicePositionSec: number): boolean {
    const song = this.getCurrentSong();
    if (this.state !== 'playing' || !song || song.duration <= 0 || this.playStartTimeMs <= 0) {
      return false;
    }

    const elapsedSec = (Date.now() - this.playStartTimeMs) / 1000;
    const remainingSec = song.duration - elapsedSec;
    if (remainingSec <= 15 || elapsedSec >= Math.max(45, song.duration * 0.5)) {
      return false;
    }

    // 播放一段时间后设备又回到开头，通常表示音箱在重拉同一首，不应用它重置自动切歌。
    if (elapsedSec > 15 && devicePositionSec < 3) {
      return false;
    }

    return true;
  }

  /**
   * 判断设备上正在播放的媒体，是不是本插件推给它的那条流。
   *
   * 为什么需要：`getPlayState().status === 1` 只代表**音箱在放某个东西**。用户对小爱说话后，
   * 小爱可能用 `REPLACE_ALL` 把播放项换成它自己的内容（音乐/电台），此时 status 恒为 1。
   * 旧代码把 status=1 一律当成「我们的歌在放」，于是：
   *   - smartResume 走「设备已自动恢复」分支，只把定时器重锚到**小爱内容的进度**上；
   *   - verifyResumeOrRepush 直接判定续播成功，不重推我们的 URL；
   *   - /player/status 的设备校准把小爱的 position 当成我们歌的位置。
   * 结果就是用户报的「调完音量后没续播，还提前切了歌」（songloft-org/songloft-plugin-miot#96）。
   *
   * 判据用**流长**：我们推的流长度是可推算的（歌曲时长扣掉 seek 起点、再按倍速压缩），
   * 小爱自己的内容几乎不可能落在同一区间。位置对不上不能单独作为判据——缓冲、重拉都会让它漂。
   *
   * 三态而非布尔：设备不上报 `play_song_detail`（部分机型，见 #60）时无法判定，
   * 必须退回调用方原有的保守行为，不能误判成 'foreign' 把好端端在放的歌打断重推。
   *
   * @param state getPlayState() 的返回值（duration 为设备上报的流长，秒）
   * @param expect 期望的流参数；缺省取当前已生效的 streamSeekOffsetSec / playbackSpeed。
   *   verifyPushLanded 必须显式传入本次下发的值——它在 playCurrent 的失败分支里调用，
   *   那两个字段还停在**上一首**的值上（只有成功分支才赋新值），不传就会算错期望流长。
   * @returns 'ours' 我们的流 / 'foreign' 被别的媒体接管 / 'unknown' 信息不足
   */
  matchDeviceStream(
    state: { status: number; duration: number },
    expect?: { seekSeconds?: number; speed?: number },
  ): 'ours' | 'foreign' | 'unknown' {
    const song = this.getCurrentSong();
    if (state.status !== 1 || !song || song.duration <= 0 || state.duration <= 0) {
      return 'unknown';
    }

    const seekOffset = typeof expect?.seekSeconds === 'number' ? expect.seekSeconds : this.streamSeekOffsetSec;
    const speed = typeof expect?.speed === 'number' && expect.speed > 0 ? expect.speed : this.playbackSpeed;

    // 我们推的流：从 seekOffset 开始、按 speed 压缩后的长度
    const expected = (song.duration - seekOffset) / speed;
    if (expected <= 0) return 'unknown';

    // 容差取「5 秒或 5%」的大者：转码取整、倍速换算、设备四舍五入都会带来几秒误差。
    // 宁可放过一次接管（退化为旧行为），也不要误判导致正常播放被无谓重推。
    const tolerance = Math.max(5, expected * 0.05);
    return Math.abs(state.duration - expected) <= tolerance ? 'ours' : 'foreign';
  }

  /** 恢复时允许识别已确认过的失准流；普通切歌仍使用原始时长判据（#495）。 */
  matchResumeDeviceStream(state: { status: number; duration: number }): 'ours' | 'foreign' | 'unknown' {
    if (state.status === 1 && this.matchesConfirmedTailStream(state)) return 'ours';
    return this.matchDeviceStream(state);
  }

  private matchesConfirmedTailStream(state: { duration: number }): boolean {
    const known = this.confirmedTailStream;
    return !!known && known.songId === this.getCurrentSong()?.id &&
      known.seek === this.streamSeekOffsetSec && known.speed === this.playbackSpeed &&
      Number.isFinite(state.duration) && state.duration > 0 &&
      Math.abs(state.duration - known.duration) <= Math.max(1, known.duration * 0.01);
  }

  /**
   * 设备进度是否明显落在续播锚点之前（songloft-org/songloft#516）。
   * position 推进只能证明音频在播放，不能证明它从原位置继续；固件重载同一 URL 后
   * 也会从零推进。明显落后也可能是缓冲，不能仅凭这个比较重推。
   * 先换成曲内绝对位置，再比较，避免把带 seek/倍速的正常流当成重播。
   * 该判据必须与新采样、流身份及连续进度证据一起使用，不能单凭本地计时重推。
   */
  hasDevicePositionRegressed(devicePositionSec: number, resumePositionSec: number): boolean {
    if (!Number.isFinite(devicePositionSec) || devicePositionSec < 0 ||
      !Number.isFinite(resumePositionSec) || resumePositionSec < 0) return false;
    const songPosition = devicePositionSec * this.playbackSpeed + this.streamSeekOffsetSec;
    return songPosition < resumePositionSec - RESUME_POSITION_TOLERANCE_SEC * this.playbackSpeed;
  }

  /** 回零证据限定为流开头三秒；正常播放在中途落后本地计时不是重播。 */
  isDeviceAtRestartPosition(devicePositionSec: number, resumePositionSec: number): boolean {
    return devicePositionSec <= LOOP_DETECT_RESET_THRESHOLD_SEC &&
      this.hasDevicePositionRegressed(devicePositionSec, resumePositionSec);
  }

  /** 自动续播落在最后三秒时，用保护区之前的最后一个整数秒，避免 seek 被丢弃后整首重播。 */
  getSafeResumePosition(positionSec: number): number {
    const song = this.getCurrentSong();
    if (Number.isFinite(positionSec) && positionSec > 0 && song && song.type !== 'radio' && song.duration > 0) {
      return Math.min(positionSec, Math.max(0, Math.ceil(song.duration - 3) - 1));
    }
    return positionSec;
  }

  /**
   * 恢复播放（使用 play 接口继续，不重发 URL）
   * 用于语音命令（如调音量）中断 URL 播放后恢复
   * 同时重置切歌定时器以补偿暂停时间
   *
   * play 指令下发成功 **不等于** 播放真的续上了：校验放在后台异步做（见 verifyResumeOrRepush），
   * 没续上就带位置重推 URL。**不能**让调用方同步等这个校验——网页端的播放按钮
   * （`POST /player/toggle` → handlers/playlist.ts）会跟着从 ~100ms 变成 ~1.3s，手感明显发木。
   */
  async resumePlayback(opts?: { positionSec?: number; isCurrent?: () => boolean }): Promise<boolean> {
    if (!opts?.isCurrent) { this.invalidateInteraction(); this.minaService.notifyControl?.(this.accountId, this.deviceId); }
    if (this.externalPlayback) return false;
    return this.trackPlayback(() => this.resumePlaybackInternal(opts));
  }

  private async resumePlaybackInternal(opts?: { positionSec?: number; isCurrent?: () => boolean }): Promise<boolean> {
    const epoch = this.playbackEpoch;
    const generation = this.checkTimerGeneration;
    const isCurrent = () => !this.externalPlayback && epoch === this.playbackEpoch &&
      generation === this.checkTimerGeneration && opts?.isCurrent?.() !== false;
    if ((this.state !== 'playing' && this.state !== 'paused') || this.songs.length === 0) {
      return false;
    }
    if (!isCurrent()) return false;

    // 上次暂停被设备忽略而升级为 stop：设备端已无媒体上下文，play 指令续不回来，
    // 只能重推 URL。带上 seek 让服务端产出以暂停位置为开头的流，听感即「原位续播」
    // （songloft-org/songloft-plugin-miot#60）。分组时哪怕只有一台被硬停也全组重推，
    // 让本来正常 paused 的成员一起对齐到同一位置——多房间同步优先于少一次重推。
    if (this.hardStopped) {
      songloft.log.info(`[PlaylistManager] Resume after hard stop, replay with seek=${this.pausedPositionSec.toFixed(1)}s`);
      return this.playCurrent({ seekSeconds: this.pausedPositionSec, skipAnnouncement: true, isCurrent: opts?.isCurrent });
    }

    // 续播位置在改 state 之前算：getPosition() 在非 playing 态恒返回 0
    // 语音恢复可传入挂起时的位置，不能把播报/轮询耗时算成已听内容。
    const resumeFromSec = typeof opts?.positionSec === 'number' && Number.isFinite(opts.positionSec) && opts.positionSec >= 0
      ? opts.positionSec : this.state === 'paused' ? this.pausedPositionSec : this.getPosition();

    const ok = await this.forEachTarget('resume', t => this.minaService.resumePlay(t.account_id, t.device_id, isCurrent));
    if (!isCurrent()) return false;
    if (!ok) {
      songloft.log.warn('[PlaylistManager] resumePlay failed');
      return false;
    }

    this.stopCheckTimer(opts?.isCurrent);
    this.clearVoiceSuspend();
    this.state = 'playing';
    // 已知/未知时长共用续播锚点，排除暂停、播报和轮询耗时（#404）。
    this.playStartTimeMs = Date.now() - (resumeFromSec / this.playbackSpeed) * 1000;

    const song = this.getCurrentSong();
    if (song && song.duration > 0) {
      // 以真实曲内位置重锚 playStartTimeMs：暂停期间 playStartTimeMs 一直停在歌曲起播时刻，
      // 直接用它算 elapsed 会把暂停时长也算进已播时长，长暂停后 remaining 为负 → 不注册定时器 →
      // 歌曲自然播完时 onSongFinished 不触发，音箱循环重拉同一 URL，表现为「单曲循环、不推进列表」
      // (songloft-org/songloft#404)。与 resetAutoNextTimer 同源：按 1/speed 反向缩放锚点。
      const remaining = song.duration + this.transitionOffset - resumeFromSec;
      if (remaining > 0) {
        this.startCheckTimer(remaining / this.playbackSpeed, opts?.isCurrent);
        songloft.log.info(`[PlaylistManager] Timer reset after resume: remaining=${remaining.toFixed(1)}s position=${resumeFromSec.toFixed(1)}s`);
      } else {
        // 已到尾部（暂停在曲末）：立即触发自动切歌，避免续播后无定时器推进
        this.startCheckTimer(0.1, opts?.isCurrent);
        songloft.log.info(`[PlaylistManager] Timer reset after resume: song at tail (remaining=${remaining.toFixed(1)}s), triggering auto-next`);
      }
    } else if (song) {
      // duration==0：无法按曲长注册定时器，改启动设备流长探测兜底（#437）。
      // playStartTimeMs 已在上方按 resumeFromSec 重锚，探测读到流长后会据此 resetAutoNextTimer。
      this.scheduleDurationProbe(opts?.isCurrent);
      songloft.log.info(`[PlaylistManager] Duration unknown after resume, starting device duration probe`);
    }

    // 定时器建好后再捕获校验版本；网页按钮不用等待后台回读。
    void this.verifyResumeOrRepush(resumeFromSec, opts?.isCurrent).catch(e => {
      songloft.log.warn('[PlaylistManager] Resume verify failed: ' + String(e));
    });
    return true;
  }

  /**
   * 后台校验 resume 是否真的生效，没生效就带位置重推 URL。
   *
   * 为什么必须校验：`player_play_operation` 的 ubus 应答是
   * `code=0 message="Msg has been successfully proxy to the device"`——它只说明**云端把消息代理给了设备**，
   * 与播放是否续上无关。被小爱语音唤醒打断后设备端媒体上下文往往已失效，一条裸 play 续不回来，
   * 而旧实现看到 ubus 成功就返回 true，于是本地状态停在 playing、切歌定时器照跑，
   * 用户听到的是「播放继续数秒但没声音，直到切歌才有声音」（songloft-org/songloft-plugin-miot#61 问题 3）。
   *
   * 最多探 3 次（间隔 1s）：有进度时必须看到两次新采样推进，不能把 status=1 的冻结进度当作续播。
   * 不上报进度的老设备仍使用 status 和流长判据；探失败的代价只是多一次带位置的重推
   * （听感是一下小卡顿），远小于让用户干等整首歌的静音。
   * 只查主设备：分组成员各自的媒体上下文无法逐台补救，主设备没续上就整组重推 URL 对齐。
   * status 拿不到（-1，网络抖动 / 云端 502）时放弃本次校验，不宣称已续播——宁可少一次重推，也不要
   * 因为一次查询失败就把好端端在放的歌打断重来。
   *
   * status=1 也**不足以**判定成功：小爱接管播它自己的内容时 status 同样是 1，裸 play 恢复的
   * 是音箱当前媒体（已被 REPLACE_ALL 换掉），永远回不到我们的歌。所以还要过一道流长身份校验
   * （matchDeviceStream），认定被接管就立刻重推 URL（songloft-org/songloft-plugin-miot#96）。
   *
   * @param resumeFromSec 恢复时的曲内位置，重推不加校验耗时，避免跳过尚未听到的内容。
   */
  private async verifyResumeOrRepush(resumeFromSec: number, taskIsCurrent?: () => boolean): Promise<void> {
    // 记下当时在放哪一首：校验期间用户可能切歌/换歌单，那就不该再插一脚
    const indexAtResume = this.currentIndex;
    const songIdAtResume = this.getCurrentSong()?.id ?? 0;
    const generationAtResume = this.checkTimerGeneration;
    const startedAt = Date.now();
    const isCurrent = () => this.state === 'playing' && this.currentIndex === indexAtResume &&
      (this.getCurrentSong()?.id ?? 0) === songIdAtResume && this.checkTimerGeneration === generationAtResume &&
      taskIsCurrent?.() !== false;
    let lastPosition = -1;
    let lastSampleAt = -1;
    let idleHits = 0;
    let repushReason = '';

    for (let i = 0; i < 3; i++) {
      await new Promise(r => setTimeout(r, 1000));
      // 期间被别的操作接管（暂停 / 切歌 / 停止）就不必再验
      if (!isCurrent()) return;

      const state = await this.minaService.getPlayState(this.accountId, this.deviceId, { verify: true });
      if (!isCurrent()) return;
      if (state.status < 0) {
        songloft.log.warn('[PlaylistManager] Resume verify: device status unavailable, playback not verified');
        return;
      }
      const sampleAt = state.sampledAt ?? Date.now();
      if (sampleAt < startedAt || sampleAt <= lastSampleAt) {
        repushReason = '';
        continue;
      }
      lastSampleAt = sampleAt;
      this.recordDevicePosition(state);
      const stream = this.matchResumeDeviceStream({ ...state, status: 1 });
      // #449：status 可能连续误报 paused/stopped；当前流的进度推进比状态码更可靠。
      if (isDeviceStatusKnown(state.status) && state.hasPosition && stream !== 'foreign') {
        if (lastPosition >= 0 && state.position - lastPosition + 1e-6 >= 0.1) {
          if (stream === 'ours' && (this.isDeviceAtRestartPosition(state.position, resumeFromSec) ||
            this.isDeviceAtRestartPosition(lastPosition, resumeFromSec))) {
            repushReason = `device restarted media (position=${state.position}s resumePosition=${resumeFromSec}s)`;
            break;
          }
          return;
        }
      } else {
        lastPosition = -1;
      }
      if (state.status === 1) {
        idleHits = 0;
        if (stream === 'foreign') {
          repushReason = `device playing foreign media (deviceDuration=${state.duration}s devicePosition=${state.position}s)`;
          break;
        }
        if (!state.hasPosition) return; // 无进度的老设备保留原兼容行为
        if (lastPosition >= 0) {
          repushReason = `device progress frozen (position=${state.position}s)`;
          // 保留最后一轮：短缓冲可能两次读到相同进度，不能立刻重推。
        } else {
          repushReason = '';
        }
        lastPosition = state.position;
      } else if (isDeviceIdle(state.status)) {
        lastPosition = state.hasPosition && stream !== 'foreign' ? state.position : -1;
        idleHits++;
        repushReason = idleHits >= 2 ? `device not playing (status=${state.status})` : '';
        if (idleHits >= 2) break;
      } else {
        return;
      }
    }

    if (!repushReason) return;

    // 需要重推：先再确认一次上下文没变（最后一次查询也可能耗掉几百毫秒）
    if (!isCurrent()) return;
    const replayPosition = this.getSafeResumePosition(resumeFromSec);
    songloft.log.warn(`[PlaylistManager] Resume verify failed: ${repushReason}, re-pushing URL with seek=${replayPosition.toFixed(1)}s`);
    await this.replayCurrent(replayPosition, taskIsCurrent ?? (() => true));
  }

  /**
   * 获取当前播放位置（秒，曲内绝对位置）
   *
   * 倍速下「墙钟经过秒数」不等于「曲内经过秒数」：1.5x 流播放 1 墙钟秒 = 1.5 曲内秒。
   * playStartTimeMs 在 playCurrent 里按 1/speed 反向缩放锚定（见那处的注释），
   * 这里要再按 speed 正向缩放回来，得到「从 seekSeconds 起、按 speed 倍速流逝」的曲内绝对位置。
   */
  getPosition(): number {
    if (this.state !== 'playing' || this.playStartTimeMs === 0) {
      return 0;
    }
    if (this.voiceSuspendedAt > 0) return this.voiceSuspendedPosition;
    if (this.hourlyResumeTask?.waiting) return this.hourlyResumeTask.position;
    const elapsed = ((Date.now() - this.playStartTimeMs) / 1000) * this.playbackSpeed;
    const song = this.getCurrentSong();
    if (song && song.duration > 0 && elapsed > song.duration) {
      return song.duration;
    }
    return elapsed;
  }

  /**
   * 清理定时器
   */
  cleanup(): void {
    this.stopCheckTimer();
    this.resetStreamEvidence();
    this.confirmedTailStream = null;
    this.stopResumePoll();
    this.clearPlaybackFailures();
  }

  /** 新流开始、重推或销毁时清空当前流的进度证据。 */
  private resetStreamEvidence(): void {
    this.devicePositionObserved = false;
    this.streamEvidenceObserved = false;
    this.streamPositionObserved = false;
    this.blindIdleNoticeLogged = false;
  }

  private pruneSongFailures(): void {
    const now = Date.now();
    for (const [songId, failure] of this.unplayableSongs) {
      if (failure.expiresAt <= now) this.unplayableSongs.delete(songId);
    }
  }

  private markSongUnplayable(songId: number, reason: SongFailureReason): void {
    if (songId <= 0) return;
    this.pruneSongFailures();
    this.prefetchRequests.delete(songId);
    this.unplayableSongs.set(songId, { reason, expiresAt: Date.now() + UNPLAYABLE_SONG_TTL_MS });
    songloft.log.warn(`[PlaylistManager] Song temporarily unplayable id=${songId} reason=${reason} ttl=${UNPLAYABLE_SONG_TTL_MS}ms`);
  }

  private isSongUnplayable(songId: number): boolean {
    const failure = this.unplayableSongs.get(songId);
    if (!failure) return false;
    if (failure.expiresAt <= Date.now()) {
      this.unplayableSongs.delete(songId);
      return false;
    }
    return true;
  }

  private clearSongFailure(songId: number): void {
    this.unplayableSongs.delete(songId);
    this.prefetchRequests.delete(songId);
  }

  private confirmSongPlayback(songId: number): void {
    if (this.getCurrentSong()?.id === songId) this.playbackConfirmed = true;
    this.clearSongFailure(songId);
    this.landingFailureCount = 0;
  }

  /** 清除临时失败标记并作废仍在等待的预取；不改变播放、队列或熔断计数。 */
  clearPlaybackFailures(): number {
    this.pruneSongFailures();
    const cleared = this.unplayableSongs.size;
    this.unplayableSongs.clear();
    this.prefetchRequests.clear();
    return cleared;
  }

  /**
   * 准备播放新内容：立即清除定时器并重置状态
   * 用于 VoiceEngine 在 interruptBroadcast 之前调用，
   * 防止搜索/加载期间旧定时器触发 onSongFinished
   */
  prepareForNewPlayback(): void {
    this.endExternalPlayback();
    this.stopCheckTimer();
    this.resetStreamEvidence();
    this.confirmedTailStream = null;
    this.stopResumePoll();
    this.clearVoiceSuspend();
    this.state = 'idle';
    this.playStartTimeMs = 0;
    this.pausedPositionSec = 0;
    this.streamSeekOffsetSec = 0;
    this.clearPendingNextIndex();
  }

  /**
   * 挂起播放：停止切歌定时器但保持 playing 状态
   * 用于语音交互打断时，防止定时器在 AI 响应期间触发 onSongFinished，
   * 同时保持状态为 playing 以便后续 resumePlayback() 恢复。
   */
  suspendForVoiceInteraction(): void {
    this.stopCheckTimer();
    if (this.voiceSuspendedAt === 0) {
      this.voiceSuspendedPosition = this.getPosition();
      this.voiceSuspendedAt = Date.now();
    }
  }

  isVoiceSuspended(): boolean {
    return this.voiceSuspendedAt > 0;
  }

  isVoiceSuspendStale(): boolean {
    return !this.interactionGuard && this.voiceSuspendedAt > 0 && (Date.now() - this.voiceSuspendedAt) > 60000;
  }

  private clearVoiceSuspend(): void {
    this.voiceSuspendedAt = 0;
  }

  /**
   * 仅重置切歌定时器（不发送任何设备命令）
   * 用于设备已自动恢复播放的场景，避免多余的 play 命令导致歌曲从头播放
   * @param devicePositionSec - 设备实际播放位置（秒），优先使用；未提供时回退到挂钟时间
   * @param deviceReportsProgress - 位置来自真实设备进度；外推位置或缺少进度的流长探测传 false
   */
  resetAutoNextTimer(devicePositionSec?: number, deviceReportsProgress = true): void {
    if (this.externalPlayback) return;
    if (this.state !== 'playing') return;
    // /player/status 也会调用本方法；不能先用归零进度清掉挂起锚点和续播任务版本。
    // 保留挂起状态，让智能续播通过新采样和流身份确认是否需要带位置重推。
    if (this.isVoiceSuspended() && typeof devicePositionSec === 'number' &&
      devicePositionSec <= this.streamSeekOffsetSec + LOOP_DETECT_RESET_THRESHOLD_SEC * this.playbackSpeed &&
      devicePositionSec < this.voiceSuspendedPosition - RESUME_POSITION_TOLERANCE_SEC * this.playbackSpeed) return;
    this.stopCheckTimer();
    if (deviceReportsProgress && typeof devicePositionSec === 'number' &&
      Number.isFinite(devicePositionSec) && devicePositionSec >= 0) {
      this.devicePositionObserved = true;
      if (devicePositionSec > 0) {
        this.streamEvidenceObserved = true;
        this.streamPositionObserved = true;
      }
    }
    this.clearVoiceSuspend();
    const song = this.getCurrentSong();
    if (!song) return;
    if (song.duration <= 0) {
      if (typeof devicePositionSec === 'number' && Number.isFinite(devicePositionSec) && devicePositionSec >= 0) {
        this.playStartTimeMs = Date.now() - (devicePositionSec / this.playbackSpeed) * 1000;
      }
      this.scheduleDurationProbe();
      return;
    }

    let remaining: number;
    if (typeof devicePositionSec === 'number' && devicePositionSec >= 0) {
      // devicePositionSec 是曲内绝对位置（调用方已把设备流内偏移按 speed 换算好）。
      // 锚点要按 1/speed 反向缩放：倍速下 playStartTimeMs 到 now 的墙钟差 × speed 才等于曲内位置。
      this.playStartTimeMs = Date.now() - (devicePositionSec / this.playbackSpeed) * 1000;
      remaining = song.duration + this.transitionOffset - devicePositionSec;
    } else if (this.playStartTimeMs > 0) {
      const elapsedSec = ((Date.now() - this.playStartTimeMs) / 1000) * this.playbackSpeed;
      remaining = song.duration + this.transitionOffset - elapsedSec;
    } else {
      return;
    }

    if (remaining > 0) {
      // remaining 是曲内剩余秒数，定时器要按墙钟等：倍速下曲内 N 秒只需 N/speed 墙钟秒走完。
      this.startCheckTimer(remaining / this.playbackSpeed);
      songloft.log.info(`[PlaylistManager] Timer reset: remaining=${remaining.toFixed(1)}s (wall ${((remaining / this.playbackSpeed).toFixed(1))}s speed=${this.playbackSpeed})`);
    } else {
      this.startCheckTimer(0.1);
      songloft.log.info(`[PlaylistManager] Timer reset: song ended (remaining=${remaining.toFixed(1)}s), triggering auto-next`);
    }
  }

  /**
   * 重新推送当前歌曲 URL 到设备（用于语音打断后恢复）
   * 与 resumePlayback() 不同，这里重新发送 URL 而非简单 resume，
   * 因为被语音唤醒打断后设备的 URL 播放状态已被清除。
   * @param seekSeconds 曲内起播位置；传 0/省略即从头重播（旧行为）
   */
  async replayCurrent(seekSeconds = 0, isCurrent?: () => boolean): Promise<boolean> {
    if (isCurrent?.() === false) return false;
    if (!isCurrent) this.endExternalPlayback();
    return this.playCurrent({ seekSeconds, skipAnnouncement: true, isCurrent });
  }

  /** 当前推给设备的流从歌曲第几秒开始（设备上报的 position 需加此值才是曲内绝对位置） */
  getStreamSeekOffsetSec(): number {
    return this.streamSeekOffsetSec;
  }

  /** 当前推给设备的流的播放倍速（设备上报的流内偏移需乘此值才是曲内秒） */
  getPlaybackSpeed(): number {
    return this.playbackSpeed;
  }

  /**
   * 设置播放倍速并立即对正在播放的音频生效。
   *
   * 与 setPlayMode 不同：play_mode 只影响「下一首怎么选」，可静默改状态不动当前播放；
   * 倍速必须让正在播的音频立即变速，所以触发一次 playCurrent——以当前曲内位置为起点、
   * 新倍速重推一条流，直接复用 seek 已经打好的「重推 URL 模拟续播」骨架
   * （暂停态保持、播放态不重复起播等分支逻辑不用重写）。
   *
   * 停止/空闲态下只更新字段与持久化，下次 playCurrent 自然带上新倍速，不强行起播。
   */
  async setPlaybackSpeed(speed: number): Promise<boolean> {
    this.invalidateInteraction(); this.minaService.notifyControl?.(this.accountId, this.deviceId);
    const generation = this.checkTimerGeneration;
    const clamped = Math.max(0.5, Math.min(2, speed));
    const wasPaused = this.state === 'paused';
    const wasStopped = this.state === 'stopped' || this.state === 'idle';
    this.playbackSpeed = clamped;

    // 持久化到设备配置（与 setPlayMode 一致）
    try {
      await this.configManager.updateDevice(this.accountId, this.deviceId, {
        play_speed: clamped,
      });
    } catch (e) {
      songloft.log.warn('[PlaylistManager] Failed to save playback speed: ' + String(e));
    }

    if (generation !== this.checkTimerGeneration) return false;
    songloft.log.info(`[PlaylistManager] Playback speed set to ${clamped}`);

    // 停止/空闲态：不强行起播，等下次 play 带上新倍速。
    if (wasStopped || !this.getCurrentSong()) {
      return true;
    }

    // 以当前曲内位置为起点重推一条新倍速的流
    const position = wasPaused ? this.pausedPositionSec : this.getPosition();
    const ok = await this.playCurrent({ seekSeconds: position, speed: clamped, skipAnnouncement: true });
    if (ok && wasPaused) {
      // 暂停态切倍速：重推后立即暂停，保持暂停态（与 /player/seek 的语义一致）
      await this.pause();
    }
    return ok;
  }

  /**
   * 使用已有歌曲列表初始化播放列表（恢复用）
   */
  initWithSongs(songs: Song[], startIndex: number, playMode: PlayMode, playlistId: number): void {
    this.resetStreamEvidence();
    this.confirmedTailStream = null;
    this.deadlineTailEvidence = null;
    this.tailLoopSample = null;
    this.songs = songs;
    this.totalSongs = songs.length;
    this.currentIndex = (startIndex >= 0 && startIndex < songs.length) ? startIndex : 0;
    this.playMode = normalizePlayMode(playMode);
    this.playlistId = playlistId;
    this.state = 'idle';
    this.randomPlayed = new Set();
    this.clearPendingNextIndex();
  }

  /**
   * 用歌手歌曲列表初始化临时歌单（恢复用，不自动播放）
   */
  initWithTempArtist(songs: Song[], artistName: string, playMode: PlayMode, songId = 0, exactArtist = false): void {
    this.resetStreamEvidence();
    this.confirmedTailStream = null;
    this.deadlineTailEvidence = null;
    this.tailLoopSample = null;
    this.songs = songs;
    this.totalSongs = songs.length;
    this.currentIndex = Math.max(0, songs.findIndex(song => song.id === songId));
    this.playMode = normalizePlayMode(playMode);
    this.playlistId = this.tempId;
    this.tempPlaylistName = '歌手: ' + artistName;
    this.tempArtistQuery = artistName;
    this.tempArtistExact = exactArtist;
    this.tempStartSongId = exactArtist ? songs[0].id : 0;
    this.pendingTempArtist = '';
    this.state = 'idle';
    this.randomPlayed = new Set();
    this.clearPendingNextIndex();
  }

  // ===== 私有方法 =====

  /**
   * 加载歌单歌曲（通过宿主API桥接）
   * 首次返回空时延迟 500ms 重试一次（规避 SQLite WAL 长时间运行后的间歇性空返回）
   */
  private async loadPlaylistSongs(playlistId: number, taskCurrent?: () => boolean): Promise<boolean> {
    const generation = this.checkTimerGeneration, epoch = this.playbackEpoch;
    const isCurrent = () => taskCurrent?.() !== false && generation === this.checkTimerGeneration && epoch === this.playbackEpoch && !this.externalPlayback;
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
      songloft.log.warn(`[PlaylistManager] loadPlaylistSongs: getById for sort failed playlistId=${playlistId}: ${String(e)}`);
    }

    const attempt = async (retry: boolean): Promise<boolean> => {
      try {
        const songs = await songloft.playlists.getSongs(playlistId, { limit: 100000, sort: sortBy, order: sortOrder } as any);
        const desc = songs ? (Array.isArray(songs) ? String(songs.length) : 'non-array') : 'null';
        songloft.log.info(`[PlaylistManager] loadPlaylistSongs playlistId=${playlistId} sort=${sortBy} order=${sortOrder} returned=${desc}${retry ? ' (retry)' : ''}`);
        if (!songs || !Array.isArray(songs)) {
          songloft.log.error('[PlaylistManager] Bridge returned invalid data for playlist: ' + playlistId);
          return false;
        }
        if (isCurrent?.() === false) return false;
        this.songs = songs as any;
        this.totalSongs = songs.length;
        return songs.length > 0;
      } catch (e) {
        songloft.log.error(`[PlaylistManager] loadPlaylistSongs exception playlistId=${playlistId}${retry ? ' (retry)' : ''}: ${String(e)}`);
        return false;
      }
    };

    if (isCurrent?.() === false) return false;
    const ok = await attempt(false);
    if (ok) {
      return true;
    }

    if (isCurrent?.() === false) return false;
    songloft.log.warn(`[PlaylistManager] loadPlaylistSongs empty or failed, retrying in 500ms playlistId=${playlistId}`);
    await new Promise(r => setTimeout(r, 500));
    if (isCurrent?.() === false) return false;
    const retryOk = await attempt(true);
    if (retryOk) {
      return true;
    }

    if (isCurrent?.() === false) return false;
    // retry 后仍为空/失败：检测歌单是否真的不存在（扫描后 auto-create 歌单 ID 变化会导致旧 ID 失效）。
    // 区分「歌单不存在(ID 过期)」与「歌单存在但为空」，供上层决定是否刷新索引重试。
    try {
      const pl = await songloft.playlists.getById(playlistId);
      if (!isCurrent()) return false;
      if (!pl) {
        this._lastLoadNotFound = true;
        songloft.log.warn(`[PlaylistManager] playlist ${playlistId} not found (stale ID), signaling caller to refresh index`);
        // 歌单真的不在了：顺手删掉它的进度记录，否则表里会攒下一堆永远命中不到的孤儿条目
        // （扫描 auto-create 会让歌单换 ID），把有用的进度挤出上限。
        await this.configManager
          .removePlaylistProgress(playlistProgressScope(this.accountId, this.deviceId), playlistId)
          .catch(e => songloft.log.warn('[PlaylistManager] Failed to drop stale playlist progress: ' + String(e)));
      }
    } catch (e) {
      songloft.log.warn(`[PlaylistManager] getById check failed playlistId=${playlistId}: ${String(e)}`);
    }
    return false;
  }

  /**
   * 上次播放失败是否因歌单 ID 已失效（歌单不存在）。
   * 用于上层在扫描导致 auto-create 歌单 ID 变化后，刷新索引并重试。
   */
  isLastPlayNotFound(): boolean {
    return this._lastLoadNotFound;
  }

  /**
   * 播放当前索引的歌曲
   * @param opts.seekSeconds 曲内起播位置（秒）。服务端会产出以该位置为开头的 MP3 流，
   *   用于「设备端媒体上下文已丢失、只能重推 URL」的续播场景（硬停续播、语音打断恢复）。
   *   其余调用方不传即从头播，并顺带把 seek 状态清零。
   * @param opts.speed 本次流的播放倍速。不传则沿用 this.playbackSpeed（保持上次设置）。
   *   服务端产出变速流，本机据此换算进度与自动切歌定时器。
   */
  private async announceCurrentSong(song: { title: string; artist: string }, current: () => boolean): Promise<void> {
    const config = await this.configManager.getConfig();
    if (!current() || !config.play_announcement_enabled) return;
    if (!song.title) return;

    const text = (config.play_announcement_template || '即将播放{artist}的{song}')
      .replace(/\{song\}/g, song.title)
      .replace(/\{artist\}/g, song.artist || '未知歌手');

    if (!text.trim()) return;

    songloft.log.info(`[PlaylistManager] Play announcement: "${text}" mode=${config.play_announcement_wait_mode}`);
    await this.minaService.textToSpeech(this.accountId, this.deviceId, text, current);

    switch (config.play_announcement_wait_mode) {
      case 'fixed': {
        const delay = Math.max(0, Math.min(10, config.play_announcement_delay || 3));
        await new Promise(r => setTimeout(r, delay * 1000));
        break;
      }
      case 'poll': {
        const maxWaitMs = Math.min(15000, Math.ceil(text.length / 4) * 1500 + 2000);
        const pollInterval = 800;
        const startTime = Date.now();
        await new Promise(r => setTimeout(r, 1000));
        while (Date.now() - startTime < maxWaitMs) {
          const { status } = await this.minaService.getPlayState(this.accountId, this.deviceId);
          if (status !== 1) break;
          await new Promise(r => setTimeout(r, pollInterval));
        }
        break;
      }
      case 'auto':
      default: {
        const estimatedMs = Math.ceil(text.length / 4) * 1000 + 1000;
        await new Promise(r => setTimeout(r, estimatedMs));
        break;
      }
    }
  }

  private async playCurrent(opts?: { seekSeconds?: number; speed?: number; skipAnnouncement?: boolean; isCurrent?: () => boolean }): Promise<boolean> {
    if (this.externalPlayback || opts?.isCurrent?.() === false) return false;
    if (!opts?.isCurrent) this.minaService.notifyControl?.(this.accountId, this.deviceId);
    const epoch = this.playbackEpoch;
    const generation = this.checkTimerGeneration;
    if (this.externalOperations.size) await Promise.allSettled(Array.from(this.externalOperations));
    if (this.externalPlayback || epoch !== this.playbackEpoch || opts?.isCurrent?.() === false ||
      generation !== this.checkTimerGeneration) return false;
    return this.trackPlayback(() => this.playCurrentInternal(opts));
  }

  private async playCurrentInternal(opts?: { seekSeconds?: number; speed?: number; skipAnnouncement?: boolean; isCurrent?: () => boolean }): Promise<boolean> {
    const epoch = this.playbackEpoch;
    if (this.currentIndex < 0 || this.currentIndex >= this.songs.length) {
      songloft.log.error('[PlaylistManager] Invalid current index: ' + this.currentIndex);
      return false;
    }

    this.stopCheckTimer(opts?.isCurrent);
    this.resetStreamEvidence();
    this.confirmedTailStream = null;
    this.playbackConfirmed = false;
    this.streamStartedAtMs = 0;
    // 恢复任务的回调只负责任务身份；本地版本负责捕获同曲重播、暂停等操作。
    const generationAtPlay = this.checkTimerGeneration;
    const isCurrent = () => !this.externalPlayback && epoch === this.playbackEpoch &&
      opts?.isCurrent?.() !== false && generationAtPlay === this.checkTimerGeneration;
    // 当前歌曲要变了：作废上一首定好的「下一首」，末尾的 prefetchNextSong 会基于新的
    // currentIndex 重新定一次，预热的与真会播的始终是同一首。
    this.clearPendingNextIndex();

    const song = this.songs[this.currentIndex];

    // 已进入实际起播，先作废这首歌的旧预取，避免稍后超时污染正在播放的歌曲。
    this.prefetchRequests.delete(song.id);

    if (!opts?.skipAnnouncement) {
      const scope = (await this.configManager.getConfig()).play_announcement_scope || 'voice';
      if (scope === 'all' || this.announceOnSongChange) {
        await this.announceCurrentSong(song, isCurrent);
      }
    }

    // 本次流的倍速：显式传入优先，否则沿用当前值（切歌/续播时保持上次倍速不丢）。
    const speed = typeof opts?.speed === 'number' && opts.speed > 0 ? opts.speed : this.playbackSpeed;
    // 起播位置夹到 [0, duration-3)：贴近结尾的 seek 会让服务端零输出并降级成整首重播，
    // 与服务端 parseSeekSeconds 的守卫同源。电台是直播流，没有曲内位置可言。
    let seekSeconds = Math.max(0, Math.floor(opts?.seekSeconds || 0));
    if (song.type === 'radio' || (song.duration > 0 && seekSeconds >= song.duration - 3)) {
      seekSeconds = 0;
    }
    // 电台没有倍速概念，服务端会忽略 speed；本地/网络歌曲才带。
    const effectiveSpeed = song.type === 'radio' ? 1 : speed;

    // 检查服务器地址
    const serverHost = getHostBaseUrl();
    if (!serverHost) {
      songloft.log.error('[PlaylistManager] Server host not configured');
      return false;
    }

    // 读取是否强制 MP3 / 电台转码 / 音量均衡。config 下面还要给 song_transition_offset 用，
    // 一次 getConfig 两处消费。
    const config = await this.configManager.getConfig();

    // 构造播放URL
    const songURL = await URLBuilder.buildSongURL(song, playbackOptionsOf(config, { seekSeconds, speed: effectiveSpeed }));
    if (!songURL) {
      songloft.log.error('[PlaylistManager] Failed to build song URL: ' + song.title);
      return false;
    }

    songloft.log.info(`[PlaylistManager] Playing song index=${this.currentIndex} title=${song.title} artist=${song.artist} duration=${song.duration} seek=${seekSeconds} speed=${effectiveSpeed} targets=${this.targets.length}`);

    if (this.externalPlayback || epoch !== this.playbackEpoch || !isCurrent()) return false;

    // 下发到所有目标设备（分组时为组内全部音箱；传结构化歌曲信息供触屏歌词模式匹配曲库）。
    // 至少一台成功即视为成功；个别成员离线/失败不影响整组继续（自动切歌定时器仍以本机时长驱动）。
    const ok = await this.forEachTarget('playURL', t => this.minaService.playURL(t.account_id, t.device_id, songURL, {
      title: song.title,
      artist: song.artist,
    }, isCurrent));
    if (this.externalPlayback || epoch !== this.playbackEpoch || !isCurrent()) return false;
    // 下发报失败不等于设备没播：3012「远程控制超时」是假失败，指令往往已经生效（#98）。
    // 回读设备核实，确认在播我们的流就按成功走，避免上层重试/跳歌/停摆。
    // landedPositionSec >= 0 表示「核实为假失败」，其值是设备已经播到的流内位置。
    let landedPositionSec = -1;
    if (!ok) {
      landedPositionSec = await this.verifyPushLanded(seekSeconds, effectiveSpeed);
      if (landedPositionSec < 0) {
        songloft.log.error('[PlaylistManager] Failed to play URL on any target device');
        return false;
      }
      songloft.log.warn(`[PlaylistManager] playURL reported failure but device is playing our stream (position=${landedPositionSec}s), treating as success`);
      this.confirmSongPlayback(song.id);
    }

    if (this.externalPlayback || epoch !== this.playbackEpoch || !isCurrent()) return false;
    this.clearVoiceSuspend();
    this.state = 'playing';
    this.hardStopped = false;
    this.pausedPositionSec = 0;
    this.streamSeekOffsetSec = seekSeconds;
    this.playbackSpeed = effectiveSpeed;
    // 起播基准（曲内绝对秒）：正常路径就是 seekSeconds。走了假失败核实的话，ubus 超时 3.5s
    // 加核实 2.4s 期间设备早就在播了，必须按设备实测位置前移，否则锚点和定时器都比设备真实
    // 进度早 ~6 秒（进度条超前、歌尾被截）。设备上报的 position 是流内位置，× speed 换成曲内秒。
    const startedAtSec = landedPositionSec > 0
      ? seekSeconds + landedPositionSec * effectiveSpeed
      : seekSeconds;
    // 锚点按 1/speed 反向缩放：getPosition() 里再把墙钟差 × speed 还原成曲内位置。
    // speed=1 时退化为旧式 Date.now() - startedAtSec*1000，兼容旧行为。
    this.playStartTimeMs = Date.now() - (startedAtSec / effectiveSpeed) * 1000;
    this.streamStartedAtMs = Date.now();

    // 如果歌曲时长有效，注册定时器播放下一首（seek 起播时只等剩余时长）。
    // adjustedDuration 是曲内剩余秒数，定时器按墙钟等：倍速下曲内 N 秒只需 N/speed 墙钟秒。
    const offset = config.song_transition_offset || 0;
    this.transitionOffset = offset;
    if (song.duration > 0) {
      const adjustedDuration = Math.max(1, song.duration + offset - startedAtSec);
      this.startCheckTimer(adjustedDuration / effectiveSpeed, opts?.isCurrent);
    } else {
      // duration==0 是常态（远程/插件歌曲元数据未刷新）。无法直接按曲长注册定时器，
      // 改启动设备流长探测兜底：读设备上报的流长据此注册正常切歌定时器；设备不上报时
      // 退化为循环回零探测。不兜底则音箱自然播完重拉同一 URL，表现为单曲循环（#437）。
      songloft.log.info(`[PlaylistManager] Song duration unknown, starting device duration probe: ${song.title}`);
      this.scheduleDurationProbe(opts?.isCurrent);
    }

    this.prefetchNextSong();

    // 起播确认：ubus 报成功≠设备真的拉到了流（例如音源解析失败时后端 502，音箱拉不到会 TTS
    // 「播放失败，换一首试试吧」并停下）。等一小段起播缓冲窗口后回读状态，未起播就跳下一首。
    // 电台不启用：直播流可能长时间处于起播态（duration=0、缓冲慢），误跳无意义（#466）。
    this.scheduleLandingVerify();

    return true;
  }

  /**
   * 起播确认（#466）：playCurrent 成功下发后延迟回读，确认设备真的进入播放。
   *
   * 电台、单曲播放模式不启用：电台会长时间处于起播态、singlePlay 没有下一首可跳。
   * verifyPushLanded 已在此前把「假失败」判成功——那种情况设备真在播，起播确认能过；
   * 我们要抓的是它抓不到的另一半：ubus 报成功但设备实际没起播。
   */
  private scheduleLandingVerify(): void {
    const song = this.getCurrentSong();
    if (!song || song.type === 'radio' || this.playMode === 'singlePlay') return;
    const indexAtLanding = this.currentIndex;
    const songIdAtLanding = song.id;

    this.landingVerifyTimer = setTimeout(() => {
      this.landingVerifyTimer = null;
      this.verifyPlaybackLanded(indexAtLanding, songIdAtLanding, 0).catch(e => {
        songloft.log.warn('[PlaylistManager] landing verify error: ' + String(e));
      });
    }, LANDING_VERIFY_FIRST_DELAY_MS);
  }

  /**
   * 单轮起播确认。见 scheduleLandingVerify。
   *
   * @param indexAtLanding 起播时的 currentIndex，用于识别切歌
   * @param songIdAtLanding 起播时的 song.id，索引可能因插入/删除而错位
   * @param attempt 已完成的探测次数，达到 LANDING_VERIFY_ATTEMPTS 仍未起播则判定失败
   */
  private async verifyPlaybackLanded(indexAtLanding: number, songIdAtLanding: number, attempt: number): Promise<void> {
    // 期间用户可能切歌/暂停/停止：交给触发那次操作的逻辑处理，这里不再插手
    if (this.state !== 'playing' || this.currentIndex !== indexAtLanding) return;
    if ((this.getCurrentSong()?.id ?? 0) !== songIdAtLanding) return;
    const generationAtLanding = this.checkTimerGeneration;

    let status = -1;
    let sampledState: DevicePlayState | undefined;
    try {
      const state = await this.minaService.getPlayState(this.accountId, this.deviceId);
      sampledState = state;
      status = state.status;
    } catch (e) {
      songloft.log.warn('[PlaylistManager] landing verify query failed: ' + String(e));
      // 查询失败按「未确认」处理：真起播了下一轮会读到 status=1；两轮都读不到才判失败
    }
    if (this.state !== 'playing' || this.currentIndex !== indexAtLanding || this.checkTimerGeneration !== generationAtLanding) return;
    if ((this.getCurrentSong()?.id ?? 0) !== songIdAtLanding) return;
    if (sampledState) this.recordDevicePosition(sampledState);

    if (status < 0) {
      // 网络失败、节流或退避均不证明歌曲不可播放；仅后台等待下一次有效采样。
      this.scheduleLandingRetry(indexAtLanding, songIdAtLanding, attempt);
      return;
    }

    // #449：status 可能连续误报 paused/stopped。设备已经报出当前流的正进度时，
    // 进度比状态码可靠；只要不是外来媒体的流长，就视为已起播。
    if (sampledState && status !== 1 && sampledState.hasPosition && sampledState.position > 0 &&
      this.matchDeviceStream({ ...sampledState, status: 1 }) !== 'foreign') {
      songloft.log.info(`[PlaylistManager] Landing verify: status=${status} but device position=${sampledState.position}s advanced, treating as playing`);
      this.confirmSongPlayback(songIdAtLanding);
      return;
    }

    if (status === 1) {
      // 起播成功：清零连续失败计数（熔断阈值只累计连续失败）
      this.confirmSongPlayback(songIdAtLanding);
      return;
    }

    // #129：全零 idle 不能证明起播失败（OH2 正常出声时也这样上报）。
    // 用当前流的 URL 可用性区分「音源真的坏了」与「设备只是不上报」。
    if (sampledState && this.isBlindIdleState(sampledState)) {
      const playable = await this.probeCurrentStreamPlayable();
      if (this.state !== 'playing' || this.currentIndex !== indexAtLanding || this.checkTimerGeneration !== generationAtLanding) return;
      if ((this.getCurrentSong()?.id ?? 0) !== songIdAtLanding) return;
      if (playable === false) {
        songloft.log.warn(`[PlaylistManager] Landing verify: stream probe failed for songId=${songIdAtLanding}, treating as unplayable`);
        this.failLandingVerify(songIdAtLanding, status);
        return;
      }
      const nextAttempt = attempt + 1;
      if (playable === true || nextAttempt >= LANDING_BLIND_ACCEPT_ATTEMPTS) {
        // 设备不上报状态/进度，但流可拉取：按元数据定时器继续播放，不误跳。
        // 一旦后续采样出现正进度或流长，各种判定会恢复正常。
        songloft.log.info(`[PlaylistManager] Landing verify: device reports no usable state (status=${status}, position=${sampledState.position}s, duration=${sampledState.duration}s, playable=${playable === true}), keeping playback on metadata timer`);
        this.confirmSongPlayback(songIdAtLanding);
        return;
      }
      this.scheduleLandingRetry(indexAtLanding, songIdAtLanding, nextAttempt);
      return;
    }

    const nextAttempt = attempt + 1;
    if (nextAttempt < LANDING_VERIFY_ATTEMPTS) {
      this.scheduleLandingRetry(indexAtLanding, songIdAtLanding, nextAttempt);
      return;
    }

    this.failLandingVerify(songIdAtLanding, status);
  }

  private scheduleLandingRetry(indexAtLanding: number, songIdAtLanding: number, attempt: number): void {
    this.landingVerifyTimer = setTimeout(() => {
      this.landingVerifyTimer = null;
      this.verifyPlaybackLanded(indexAtLanding, songIdAtLanding, attempt).catch(e => {
        songloft.log.warn('[PlaylistManager] landing verify error: ' + String(e));
      });
    }, LANDING_VERIFY_RETRY_DELAY_MS);
  }

  /** 起播失败：标记临时不可播、上报后端并静默跳下一首（#466/#114）。 */
  private failLandingVerify(songIdAtLanding: number, status: number): void {
    songloft.log.warn(`[PlaylistManager] Landing verify failed: status=${status}, treating as unplayable and advancing`);
    // 记为「不可播放」：避免随机模式下 reserveNextIndex 再次抽中同一首、或用户切回时反复卡住
    this.markSongUnplayable(songIdAtLanding, 'landing');
    // 上报后端：#466。当前用 played 端点 event=landing_failed；后端后续可据此做临时降权
    // （例如全歌单播放时把这首放到末尾）。端点存在容错：后端未实现该 event 时忽略即可。
    if (songIdAtLanding > 0) {
      callHostAPI('POST', `/api/v1/songs/${songIdAtLanding}/played?source=miot&event=landing_failed`, undefined, { timeoutMs: 3000 }).catch(e => {
        songloft.log.warn('[PlaylistManager] landing_failed notify failed: ' + String(e));
      });
    }
    this.handleLandingFailure({ tts: true }).catch(e => {
      songloft.log.error('[PlaylistManager] handleLandingFailure error: ' + String(e));
    });
  }

  /**
   * 成功查询却只有 idle 与全零媒体详情，且本条流从未出现过正进度/流长。
   * 这正是 OH2 等设备正常播放时的固定回报（#129）：它证明不了失败，也证明不了外部停止。
   * 只要本条流曾出现过正进度/流长，就返回 false，恢复常规判定。
   */
  private isBlindIdleState(state: DevicePlayState): boolean {
    // 只有本进程下发过的流才有起播依据；重载接管的流没有下发时间，无法证明它经历过
    // 正常起播，保持原有的 idle 判定，避免把「服务重启前就已停止」当成状态盲区。
    if (this.streamStartedAtMs <= 0) return false;
    if (!isDeviceIdle(state.status) || this.streamEvidenceObserved) return false;
    if (state.hasPosition && Number.isFinite(state.position) && state.position > 0) return false;
    return !(Number.isFinite(state.duration) && state.duration > 0);
  }

  /**
   * 用宿主 HEAD 探测当前流是否还能由服务端提供，用于区分「后端/音源真失败」与
   * 「设备不上报状态」。只信任明确的 HTTP 错误；超时、外链等无法下结论的情况返回 null，
   * 交给调用方保留播放。
   */
  private async probeCurrentStreamPlayable(): Promise<boolean | null> {
    const song = this.getCurrentSong();
    if (!song || !song.url || song.type === 'radio') return null;
    // 外链由设备直连，宿主的网络路径不代表设备侧可达性，不能据此判失败。
    if (song.url.startsWith('http://') || song.url.startsWith('https://')) return null;
    try {
      await callHostAPI('HEAD', song.url, undefined, { timeoutMs: LANDING_STREAM_PROBE_TIMEOUT_MS });
      return true;
    } catch (e) {
      const match = /Host API error (\d{3})/.exec(String(e));
      if (!match) return null;
      const status = Number(match[1]);
      return status === 404 || status === 410 || status >= 500 ? false : null;
    }
  }

  /**
   * 整点报时是已知的主动打断：此时 idle 必须继续交给智能续播链判断，
   * 不能被 #129 的状态盲区跳过，否则全零设备在报时后永远等不到续播。
   * 窗口与配置条件与 tryHourlyResume 保持一致。
   */
  private async isHourlyResumeApplicable(): Promise<boolean> {
    if (!this.playbackConfirmed || this.externalPlayback || this.isVoiceSuspended()) return false;
    const song = this.getCurrentSong();
    if (!song || song.type === 'radio') return false;
    const now = new Date(this.stopPollFirstStopAtMs || Date.now());
    const sinceHour = (now.getMinutes() * 60 + now.getSeconds()) * 1000 + now.getMilliseconds();
    const hour = now.getTime() - sinceHour;
    if (sinceHour >= HOURLY_RESUME_WINDOW_MS || hour === this.lastHourlyResumeHour) return false;
    try {
      return (await this.configManager.getConfig()).hourly_chime_resume_enabled === true;
    } catch {
      return false;
    }
  }

  /**
   * 起播失败/外部停止极早时的统一处理（#466）：
   * - 累加连续失败计数；达到熔断阈值 → TTS 提示后 stop（走 startResumePoll 兜底自愈）
   * - 未达阈值 → TTS「切换下一首」+ advanceToNext；无下一首 → TTS「稍后再试」后 stop
   *
   * 单首跳歌不发 TTS：TTS（MiIO action）与下一首的 play-url（mediaplayer ubus）是不同通道，
   * TTS 会抢断刚下发的下一首 URL，TTS 播完后设备停在空闲态、不会自动恢复下一首的流，
   * 于是下一首的起播确认读到 status!=1 又判其不可播——形成「一首失败连累下一首也跳」的
   * 级联（#114）。改为静默跳歌，让下一首不被打断、正常起播；仅连续多首失败熔断时才发 TTS
   * 提示用户是音源问题（见下方 CIRCUIT_BREAK 分支）。
   * 电台/单曲播放无下一首，TTS 不会打断谁，仍发停播提示。
   * 分组只对主设备发 TTS（forEachTarget 只处理播放/暂停/停止，textToSpeech 本身按主设备发）。
   */
  private async handleLandingFailure(opts: { tts: boolean }): Promise<void> {
    if (this.state !== 'playing') return;

    this.landingFailureCount++;
    // 熔断：连续多首无法起播 → 停播 + 长文案 TTS，让用户明确知道是音源问题而不是设备问题
    if (this.landingFailureCount >= LANDING_FAILURE_CIRCUIT_BREAK) {
      songloft.log.error(`[PlaylistManager] Landing failure circuit breaker tripped (count=${this.landingFailureCount}), stopping playback`);
      this.landingFailureCount = 0;
      if (opts.tts) {
        void this.minaService.textToSpeech(this.accountId, this.deviceId, LANDING_CIRCUIT_BREAK_TTS_TEXT).catch(() => { });
      }
      await this.stop();
      return;
    }

    // 电台/单曲播放无「下一首」语义：走终点式停播
    const song = this.getCurrentSong();
    if (song?.type === 'radio' || this.playMode === 'singlePlay') {
      if (opts.tts) {
        void this.minaService.textToSpeech(this.accountId, this.deviceId, LANDING_TERMINAL_FAILURE_TTS_TEXT).catch(() => { });
      }
      await this.stop();
      return;
    }

    // 常规跳歌：静默切下一首（不发 TTS，避免打断下一首起播造成级联，#114）。
    // 单首「这首歌暂时无法播放」提示具误导性（用户因此报 #114），跳歌本身用户可感知，无需提示。
    await this.advanceToNext();
  }

  /**
   * 回读设备，判断「下发报失败」是不是假失败（songloft-org/songloft-plugin-miot#98）。
   *
   * 为什么必须核实：ubus 的 `code=101` + `device_data code=3012 远程控制超时` 只说明
   * **云端没等到设备回执**。#98 的日志里三次 play-url 全报这个错，而音箱把最后那个 URL
   * 完整播完了——插件却已经 state='stopped'、定时器不再注册，播完就彻底没有下一首。
   *
   * status<0（查询也失败）时**继续下一轮探测**，不再立即判失败
   * （songloft-org/songloft-player#45）：`play-url` 和 `getPlayState` 走同一云端，
   * 抖动期两个调用会一起不通，早退等于本轮抖动完全没救。整个核实窗口用来等云端恢复，
   * 窗口用尽仍拿不到证据才真判失败——真漏判还有 advanceToNext 末尾的 startResumePoll 兜着。
   *
   * 只查主设备：分组成员各自的媒体上下文无法逐台核实，与 verifyResumeOrRepush 同一取舍。
   *
   * @param seekSeconds 本次下发的曲内起播位置
   * @param speed 本次下发的倍速
   * @returns 假失败时返回设备已播到的流内位置（秒，可能为 0）；判定为真失败返回 -1
   */
  private async verifyPushLanded(seekSeconds: number, speed: number): Promise<number> {
    // 记下核实开始时在放哪一首：期间用户可能切歌/换歌单，那就不该再替这次下发翻案
    const indexAtPush = this.currentIndex;
    const songIdAtPush = this.getCurrentSong()?.id ?? 0;
    const stateAtPush = this.state;
    const generationAtPush = this.checkTimerGeneration;

    for (let i = 0; i < PUSH_VERIFY_ATTEMPTS; i++) {
      await new Promise(r => setTimeout(r, PUSH_VERIFY_DELAY_MS));
      if (this.currentIndex !== indexAtPush || (this.getCurrentSong()?.id ?? 0) !== songIdAtPush ||
        this.checkTimerGeneration !== generationAtPush) {
        return -1;
      }
      // 核实要等最多 ~6s（5 × 1.2s），期间用户可能按了停止/暂停。翻案会让 playCurrent 把
      // state 改回 playing 并注册定时器，等于把用户刚停下的播放又拉起来——宁可维持失败。
      if (this.state !== stateAtPush && (this.state === 'stopped' || this.state === 'paused')) {
        songloft.log.info(`[PlaylistManager] Push verify: state changed to ${this.state} meanwhile, keeping failure`);
        return -1;
      }

      const state = await this.minaService.getPlayState(this.accountId, this.deviceId, { verify: true });
      // 回读本身也有异步窗口；过期的成功结果不能清掉新一轮起播的标记和失败计数。
      if (this.currentIndex !== indexAtPush || (this.getCurrentSong()?.id ?? 0) !== songIdAtPush ||
        this.checkTimerGeneration !== generationAtPush ||
        (this.state !== stateAtPush && (this.state === 'stopped' || this.state === 'paused'))) {
        return -1;
      }
      // status<0 = 查询也失败：`play-url` 和 `getPlayState` 走同一云端，抖动时会一起不通
      // （songloft-org/songloft-player#45）。旧实现在这里立刻返回 -1，本轮抖动就再也翻不了案。
      // 改成「本轮无信号，继续下一轮」，让整段核实窗口都用来等云端恢复。
      if (state.status < 0) {
        songloft.log.warn(`[PlaylistManager] Push verify: device status unavailable (attempt ${i + 1}/${PUSH_VERIFY_ATTEMPTS}), retrying`);
        continue;
      }
      if (state.status !== 1) continue;

      // status=1 只代表音箱在放某个东西：小爱接管播它自己的内容时同样是 1，
      // 上一首没停干净也是 1。必须过流长身份校验才能算「我们这次下发生效了」。
      const match = this.matchDeviceStream(state, { seekSeconds, speed });
      if (match === 'foreign') {
        songloft.log.warn(`[PlaylistManager] Push verify: device playing foreign media (deviceDuration=${state.duration}s), keeping failure`);
        return -1;
      }
      // 还要求「刚起播」：'unknown' 时这是唯一判据，'ours' 时它挡掉容差放过的「上一首还在播」。
      if (state.position > PUSH_VERIFY_START_WINDOW_SEC) {
        songloft.log.warn(`[PlaylistManager] Push verify: device playing at position=${state.position}s beyond start window (match=${match}), keeping failure`);
        return -1;
      }
      this.recordDevicePosition(state);
      return Math.max(0, state.position);
    }

    return -1;
  }

  /**
   * 预缓存下一首歌曲（fire-and-forget）
   * 调用后端 ?prefetch=1 端点触发异步缓存+转码，减少切歌时的冷启动延迟。
   * force_mp3 开启时给 prefetch URL 也追加 format=mp3，使预热的转码产物与真实播放 URL
   * （buildSongURL 的 &format=mp3）命中同一缓存键；否则预热的是源格式、播放要 mp3，
   * 切歌时 mp3 转码仍冷启动，预热白做。
   *
   * 走 reserveNextIndex() 而非 getNextIndex()：随机模式下后者每次调用结果都不同，
   * 预热的会是另一首歌（songloft-org/songloft-plugin-miot#61）。
   */
  private prefetchNextSong(): void {
    const nextIdx = this.reserveNextIndex();
    if (nextIdx < 0 || nextIdx === this.currentIndex) return;

    const nextSong = this.songs[nextIdx];
    if (!nextSong || !nextSong.url) return;
    // 绝对外链（未经后端代理的远程直链）不走后端 ?prefetch=1 端点，跳过。
    if (nextSong.url.startsWith('http://') || nextSong.url.startsWith('https://')) return;

    // 捕获到局部常量：跨 async 边界后 TS 不再对 nextSong.url 做非空收窄。
    const songUrl = nextSong.url;
    const title = nextSong.title;
    const isLocal = nextSong.type === 'local';
    const request = {};
    if (nextSong.id > 0) this.prefetchRequests.set(nextSong.id, request);

    void (async () => {
      try {
        // 与 playCurrent 共用同一个选项来源，保证预热的转码产物和真实播放 URL 命中同一缓存键。
        const opts = await playbackOptionsFromConfig(this.configManager);
        const forceMp3 = !!opts.forceMp3;
        const volumeNormalize = !!opts.normalize;
        // 本地歌曲已在服务端磁盘上：不开启转码选项时播放就是直接 ServeFile，无冷启动，预热无意义。
        // 但已下载的网络歌曲（MOV/MKV 等视频容器）也属于 local 类型，开启统一 MP3 / 音量均衡后
        // 播放要走 ffmpeg 转码（buildSongURL 对 local 同样追加 &format=mp3）；此时必须预热，
        // 否则切歌时才实时转码、冷启动延迟（songloft-org/songloft#324）。
        if (isLocal && !forceMp3 && !volumeNormalize) return;
        const separator = songUrl.includes('?') ? '&' : '?';
        let prefetchPath = songUrl + separator + 'prefetch=1' + (forceMp3 ? '&format=mp3' : '');
        if (volumeNormalize) {
          prefetchPath += '&normalize=1';
          if (!forceMp3) {
            prefetchPath += '&format=mp3';
          }
        }
        await callHostAPI('GET', prefetchPath, undefined, { timeoutMs: 5000 });
        songloft.log.info(`[PlaylistManager] Prefetch next song index=${nextIdx} title=${title}${forceMp3 ? ' (mp3)' : ''}`);
        // 预取成功清掉「不可播放」标记：URL 已能解析，之前的失败可能只是临时抖动（#466）
        if (this.prefetchRequests.get(nextSong.id) === request) this.clearSongFailure(nextSong.id);
      } catch (e) {
        // 预取失败大概率意味着音源解析失败（后端 502），把这首标记为「不可播放」，
        // advanceToNext 遇到直接再跳，不占用起播确认的 18s 窗口（#466）。
        if (this.prefetchRequests.get(nextSong.id) === request) this.markSongUnplayable(nextSong.id, 'prefetch');
        songloft.log.warn(`[PlaylistManager] Prefetch failed songId=${nextSong.id} title=${title}: ${String(e)}`);
      } finally {
        if (this.prefetchRequests.get(nextSong.id) === request) this.prefetchRequests.delete(nextSong.id);
      }
    })();
  }

  /**
   * 取「下一首」索引，并记住结果供后续调用复用。
   *
   * 存在的理由：随机模式下 getNextIndex() 是有随机性的，预热（prefetchNextSong）与真正切歌
   * （advanceToNext / next）各调一次就会拿到两首不同的歌，预热永远热错人
   * （songloft-org/songloft-plugin-miot#61）。先定后用把两者锁到同一首。
   *
   * 当前歌曲发生变化时必须调 clearPendingNextIndex() 作废——playCurrent 开头已统一处理。
   */
  private reserveNextIndex(): number {
    if (this.pendingNextIndex >= 0 && this.pendingNextIndex < this.songs.length) {
      return this.pendingNextIndex;
    }
    this.pendingNextIndex = this.getNextIndex();
    return this.pendingNextIndex;
  }

  /** 作废已定好的下一首（歌单 / 播放模式 / 当前索引变了就必须调） */
  private clearPendingNextIndex(): void {
    this.pendingNextIndex = -1;
  }

  /**
   * 获取下一首索引（根据播放模式）
   *
   * 注意：random 分支有随机性且会写 randomPlayed，**不要**直接调用。
   * 除 getPreviousIndex 这类不需要复用的场景外，一律走 reserveNextIndex()。
   * @returns 下一首索引，-1表示没有下一首
   */
  private getNextIndex(): number {
    const len = this.songs.length;
    if (len === 0) return -1;

    switch (this.playMode) {
      case 'order':
        // 顺序播放：到末尾停止
        if (this.currentIndex < len - 1) {
          return this.currentIndex + 1;
        }
        return -1; // 没有下一首

      case 'loop':
        // 列表循环
        return (this.currentIndex + 1) % len;

      case 'single':
        // 单曲循环：一直播放当前歌曲
        return this.currentIndex;

      case 'singlePlay':
        // 单曲播放：自然播完不预热、不自动切到下一首。
        return -1;

      case 'random':
        // 随机播放：避免重复直到全部播完
        this.randomPlayed.add(this.currentIndex);

        // 如果所有歌曲都播放过了，重置
        if (this.randomPlayed.size >= len) {
          this.randomPlayed = new Set();
        }

        // 找到未播放的歌曲
        const unplayed: number[] = [];
        for (let i = 0; i < len; i++) {
          if (!this.randomPlayed.has(i)) {
            unplayed.push(i);
          }
        }

        if (unplayed.length === 0) {
          return Math.floor(Math.random() * len);
        }

        return unplayed[Math.floor(Math.random() * unplayed.length)];

      default:
        return -1;
    }
  }

  /**
   * 获取上一首索引
   * @returns 上一首索引，-1表示没有上一首
   */
  private getPreviousIndex(): number {
    const len = this.songs.length;
    if (len === 0) return -1;

    switch (this.playMode) {
      case 'order':
        // 顺序播放：到第一首停止
        if (this.currentIndex > 0) {
          return this.currentIndex - 1;
        }
        return -1;

      case 'loop':
        // 列表循环：第一首回到最后一首
        if (this.currentIndex > 0) {
          return this.currentIndex - 1;
        }
        return len - 1;

      case 'single':
        // 单曲循环：重复当前
        return this.currentIndex;

      case 'singlePlay':
        // 单曲播放不限制手动上一首，行为与顺序播放一致。
        if (this.currentIndex > 0) {
          return this.currentIndex - 1;
        }
        return -1;

      case 'random':
        // 随机模式：简单返回前一首
        if (this.currentIndex > 0) {
          return this.currentIndex - 1;
        }
        return len - 1;

      default:
        if (this.currentIndex > 0) {
          return this.currentIndex - 1;
        }
        return -1;
    }
  }

  /**
   * 启动切歌定时器（基于歌曲时长）
   * @param durationSec - 歌曲时长（秒）
   */
  private startCheckTimer(durationSec: number, keepHourlyResume?: () => boolean): void {
    this.stopCheckTimer(keepHourlyResume);
    this.stopResumePoll();

    const delayMs = Math.max(1, Math.floor(durationSec * 1000));
    songloft.log.info('[PlaylistManager] Timer registered delayMs=' + delayMs);

    this.checkTimerFallbackDeadlineMs = Date.now() + delayMs;
    this.scheduleDeadlineCheck(delayMs);

    // 剩余时长明显长于「探测间隔 + 尾部盲区」才启动外部停止探测，
    // 避开临近自然结束时的状态歧义（songloft-org/songloft#408）
    const pollBudgetMs = delayMs - EXTERNAL_STOP_TAIL_GUARD_SEC * 1000;
    if (pollBudgetMs >= EXTERNAL_STOP_POLL_INTERVAL_MS) {
      this.stopPollMisses = 0;
      // 用绝对截止墙钟而非递减 budget：每次 getPlayState 的云端查询耗时（1-2s）不被计入，
      // 旧实现按「调度间隔」递减会让 stop-poll 比墙钟慢约 10%、漏进尾部 15s 窗口与 tail-probe
      // 竞态并抢先命中 status=3。改读 deadline 后 stop-poll 准时在尾部前停下，自然结束交给
      // tail-probe（其 maxPosition 判据能正确识别）(#114)。
      this.stopPollDeadlineMs = Date.now() + pollBudgetMs;
      this.scheduleStopPoll();
    }

    // 尾部设备进度校验（#481）：外部停止探测在结尾前 EXTERNAL_STOP_TAIL_GUARD_SEC 主动关闭，
    // 那段盲区正是「设备已播完但定时器还没到点」的窗口。接管它——进入最后 TAIL_PROBE_WINDOW_SEC
    // 才起探，读到设备真实结束证据就提前切歌。仅在 duration>0 的正常定时器路径启用：
    // duration==0 由 scheduleDurationProbe 全程兜底，无需重复。
    const tailStartDelayMs = delayMs - TAIL_PROBE_WINDOW_SEC * 1000;
    this.scheduleTailProbe(tailStartDelayMs);
  }

  /** 仅调整主计时器，保留尾部进度基线与在途查询，不重启整轮探测。 */
  private scheduleDeadlineCheck(delayMs: number): void {
    if (this.checkTimer !== null) clearTimeout(this.checkTimer);
    const delay = Math.max(1, Math.floor(delayMs));
    this.checkTimerDeadlineMs = Date.now() + delay;
    this.checkTimer = setTimeout(() => {
      this.checkTimer = null;
      songloft.log.info('[PlaylistManager] Timer fired');
      this.verifyTimerDeadline().catch(e => {
        songloft.log.error('[PlaylistManager] timer deadline error: ' + String(e));
      });
    }, delay);
  }

  /**
   * 连续有效进度将结束校验提前到实际尾部（#481），不等设备循环回零才行动。
   * 请求开始时间只用于安排更早的校验：设备采样时刻未知，绝不据此推算「已经播完」。
   * 校验仍用新鲜进度决定是否延期，保留 #495 的缓冲与设备低估流长保护。
   */
  private calibrateTailDeadline(st: DevicePlayState, queryStartedAt: number, checkedAt: number): void {
    if (this.checkTimer === null || this.transitionOffset < 0 || this.isVoiceSuspended()) return;
    if (this.deadlineGraceDeadlineMs > 0) return;
    if (!st.hasPosition || st.status < 0 || this.tailProbeLastPosition < 0 ||
      this.matchDeviceStream({ ...st, status: 1 }) === 'foreign') return;
    const advance = st.position - this.tailProbeLastPosition;
    const sampleAt = st.sampledAt ?? checkedAt;
    const elapsed = (sampleAt - this.tailProbeLastCheckedAtMs) / 1000;
    // 冻结、回拨或明显跳跃的进度不能作为新锚点；容忍旧固件整秒上报的 1s 误差。
    if (advance + 1e-6 < TAIL_STALL_ADVANCE_MIN_SEC || elapsed <= 0 || advance > elapsed + 1) return;
    const song = this.getCurrentSong();
    if (!song) return;
    const position = st.position * this.playbackSpeed + this.streamSeekOffsetSec;
    const duration = Math.max(song.duration, this.getTailDuration(st));
    const remaining = (duration + this.transitionOffset - position) / this.playbackSpeed;
    if (!Number.isFinite(remaining) || remaining <= 0 || remaining > TAIL_PROBE_WINDOW_SEC) return;
    const deadline = Math.max(checkedAt + 1, Math.min(queryStartedAt, sampleAt) + remaining * 1000);
    if (deadline >= this.checkTimerDeadlineMs - 50) return;
    this.playStartTimeMs = sampleAt - position / this.playbackSpeed * 1000;
    this.scheduleDeadlineCheck(deadline - checkedAt);
    songloft.log.info(`[PlaylistManager] Tail timer calibrated songId=${song.id} position=${position.toFixed(3)}s metadataDuration=${song.duration}s streamDuration=${st.duration}s checkInMs=${Math.floor(deadline - checkedAt)} queryMs=${checkedAt - queryStartedAt}`);
  }

  /** 尾部与主定时器同时到点时只查一次；清理定时器会使旧查询结果失效。 */
  private getTailDeviceState(verify = false): Promise<DevicePlayState> {
    if (this.tailProbeQuery) return this.tailProbeQuery;
    const sample = this.tailLoopSample;
    const song = this.getCurrentSong();
    // 只有同一流的新鲜尾部基线才申请快速查询。不能凭元数据计时、未知进度或
    // 失准流长加速；结束判据不变，冻结在最后几百毫秒仍须等实际回零/停止证据。
    const remaining = sample && song
      ? Math.max(sample.duration, (song.duration - this.streamSeekOffsetSec) / this.playbackSpeed) - sample.position
      : Infinity;
    const tail = !verify && this.transitionOffset >= 0 && !this.isVoiceSuspended() && sample !== null &&
      Date.now() - sample.sampledAt <= DEADLINE_RETRY_MS && remaining >= 0 && remaining <= TAIL_STALL_NEAR_END_SEC;
    const pending = this.minaService.getPlayState(this.accountId, this.deviceId, { verify, tail }).finally(() => {
      if (this.tailProbeQuery === pending) this.tailProbeQuery = null;
    });
    this.tailProbeQuery = pending;
    return pending;
  }

  private getDeadlineDeviceState(waitMs = DEADLINE_QUERY_WAIT_MS): Promise<DevicePlayState> {
    const pending = this.getTailDeviceState(true);
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const cleanup = () => {
        if (settled) return false;
        settled = true;
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        if (this.cancelDeadlineQuery === cancel) this.cancelDeadlineQuery = null;
        return true;
      };
      const cancel = () => {
        if (!cleanup()) return;
        resolve({ status: -1, position: 0, duration: 0, hasPosition: false });
      };
      timer = setTimeout(() => {
        // 超时已触发，旧宿主会立即复用句柄；不要再取消它。
        timer = null;
        if (!cleanup()) return;
        reject(new Error('device query exceeded deadline budget'));
      }, waitMs);
      this.cancelDeadlineQuery = cancel;
      pending.then(state => {
        if (!cleanup()) return;
        resolve(state);
      }, error => {
        if (!cleanup()) return;
        reject(error);
      });
    });
  }

  /** 包括有效的零位置；一旦上报过进度，后续缺失按暂时不可用处理（#124）。 */
  private recordDevicePosition(state: DevicePlayState): void {
    if (Number.isFinite(state.status) && state.status >= 0 && state.hasPosition &&
      Number.isFinite(state.position) && state.position >= 0) {
      this.devicePositionObserved = true;
      if (state.position > 0) {
        this.streamPositionObserved = true;
        this.streamEvidenceObserved = true;
      }
    }
    if (Number.isFinite(state.duration) && state.duration > 0) this.streamEvidenceObserved = true;
  }

  /** 同一条流的设备时长用于识别真实尾部，兼容比元数据略短或略长的音频。 */
  private getTailDuration(state: DevicePlayState): number {
    const song = this.getCurrentSong();
    if (!song) return 0;
    // stopped/paused 也可能是状态误报，流长仍应参与尾部边界计算。
    return Number.isFinite(state.duration) && this.matchDeviceStream({ ...state, status: 1 }) === 'ours'
      ? state.duration * this.playbackSpeed + this.streamSeekOffsetSec
      : song.duration;
  }

  /** 五秒共享采样可能错过回零的前三秒；用相邻新采样确认尾部到流开头的回拨。 */
  private observeTailLoop(st: DevicePlayState): boolean {
    const sampleAt = st.sampledAt ?? Date.now();
    const previous = this.tailLoopSample;
    if (previous && sampleAt <= previous.sampledAt) return false;
    if (this.isVoiceSuspended()) {
      this.tailLoopSample = null;
      return false;
    }
    if (st.status !== 1) {
      // 自然播完时设备常在尾部先报一次 idle，随后重拉同一 URL 从流开头续播。
      // idle 不是换流证据：保留尾部基线；同一流尾部的 idle 只推进采样时刻，
      // 让随后的回拨仍按相邻采样判断，而不是把 idle 等待算成长间隔。
      if (isDeviceIdle(st.status)) {
        if (previous && st.hasPosition && Number.isFinite(st.position) &&
          Number.isFinite(st.duration) && Math.abs(previous.duration - st.duration) <= 1 &&
          Math.abs(previous.position - st.position) <= TAIL_STALL_NEAR_END_SEC) {
          this.tailLoopSample = { ...previous, sampledAt: sampleAt };
        }
        return false;
      }
      this.tailLoopSample = null;
      return false;
    }
    if (!st.hasPosition || !Number.isFinite(st.position) || st.position < 0 || !Number.isFinite(st.duration) ||
      this.matchDeviceStream(st) !== 'ours') {
      this.tailLoopSample = null;
      return false;
    }
    this.tailLoopSample = { position: st.position, duration: st.duration, sampledAt: sampleAt };
    if (!previous || Math.abs(previous.duration - st.duration) > 1) return false;
    const song = this.getCurrentSong();
    if (!song) return false;
    const duration = Math.max(st.duration, (song.duration - this.streamSeekOffsetSec) / this.playbackSpeed);
    const remaining = duration - previous.position;
    const elapsed = (sampleAt - previous.sampledAt) / 1000;
    // 只扩展流长匹配的相邻尾部采样。中途回拨、长时间断采样和流长失准仍保留原有保护。
    return remaining >= -TAIL_STALL_NEAR_END_SEC && remaining <= TAIL_STALL_NEAR_END_SEC &&
      elapsed > 0 && elapsed <= (DEADLINE_QUERY_WAIT_MS + DEADLINE_RETRY_MS) / 1000 &&
      elapsed + 1 >= remaining && previous.position - st.position >= LOOP_DETECT_MIN_ADVANCE_SEC &&
      st.position <= elapsed + LOOP_DETECT_RESET_THRESHOLD_SEC;
  }

  /** 流长失准时，尾部连续进度只证明还在播放，不能用元数据截止时间证明结束。 */
  private observeDeadlineTail(st: DevicePlayState, sampleAt: number, fresh: boolean): { advancing: boolean; ended: boolean } {
    const result = { advancing: false, ended: false };
    const song = this.getCurrentSong();
    if (!song || this.isVoiceSuspended()) {
      this.deadlineTailEvidence = null;
      return result;
    }
    if (!fresh) return result;
    const previous = this.deadlineTailEvidence;
    // 部分设备自然结束后删掉 play_song_detail（#495）。确认过的当前尾部流，
    // 连续两份新鲜 idle 响应是停止证据；缺失进度的兜底零本身仍不是回零证据。
    // 只接纳没有流长的 idle，保留外来媒体、查询失败和 playing 下缓冲的宽限。
    if (previous?.confirmed && isDeviceIdle(st.status) && st.hasPosition === false && st.duration === 0 &&
      sampleAt > previous.sampledAt && sampleAt - previous.sampledAt <= DEADLINE_GRACE_MS &&
      previous.position * this.playbackSpeed + this.streamSeekOffsetSec >= song.duration - TAIL_STALL_NEAR_END_SEC) {
      previous.interrupted = true;
      previous.stopHits++;
      return { advancing: false, ended: previous.stopHits >= TAIL_STOP_CONFIRM_COUNT };
    }
    if (!st.hasPosition || !Number.isFinite(st.position) || st.position < 0 ||
      !Number.isFinite(st.duration) || st.duration <= 0 ||
      !isDeviceStatusKnown(st.status)) {
      // 短暂缺失后可重新采样确认原流；缺失本身不刷新宽限，也不证明回零/结束。
      if (previous?.confirmed) {
        previous.interrupted = true;
        previous.stopHits = 0;
      } else {
        this.deadlineTailEvidence = null;
      }
      return result;
    }
    const position = st.position * this.playbackSpeed + this.streamSeekOffsetSec;
    if (!previous) {
      // 新流只在元数据尾部附近建证据；恢复时可在已确认过的流上重建，仍需下一份推进。
      if (st.status === 1 && position >= song.duration - TAIL_PROBE_WINDOW_SEC &&
        (position <= song.duration + TAIL_PROBE_WINDOW_SEC || this.matchesConfirmedTailStream(st))) {
        this.deadlineTailEvidence = {
          position: st.position, duration: st.duration, sampledAt: sampleAt,
          confirmed: false, interrupted: false, stopHits: 0,
        };
      }
      return result;
    }
    const elapsed = (sampleAt - previous.sampledAt) / 1000;
    const advance = st.position - previous.position;
    const stableDuration = Math.abs(st.duration - previous.duration) <= Math.max(1, previous.duration * 0.01);
    if (!stableDuration || elapsed <= 0 || elapsed > DEADLINE_GRACE_MS / 1000) {
      this.deadlineTailEvidence = null;
      return result;
    }
    if (previous.interrupted) {
      // 恢复的第一份采样可暂时冻结；保留已确认的流，重新建立基线，等下一份推进再刷新宽限。
      // 回拨或明显跳跃仍使旧流失效，不能把中断后的零位置当作自然结束。
      if (advance >= -1e-6 && advance <= elapsed + 1) {
        previous.position = st.position;
        previous.sampledAt = sampleAt;
        previous.interrupted = false;
        previous.stopHits = 0;
      } else {
        this.deadlineTailEvidence = null;
      }
      return result;
    }
    // 已确认尾部的同一流回零是自然结束；中断后的回零仍不能确认，避免旧采样误切。
    if (previous.confirmed && previous.position >= LOOP_DETECT_MIN_ADVANCE_SEC &&
      st.position < LOOP_DETECT_RESET_THRESHOLD_SEC) {
      return { advancing: false, ended: true };
    }
    if (advance + 1e-6 >= TAIL_STALL_ADVANCE_MIN_SEC && advance <= elapsed + 1 &&
      (st.status === 1 || previous.confirmed)) {
      previous.position = st.position;
      previous.sampledAt = sampleAt;
      previous.confirmed = true;
      previous.stopHits = 0;
      this.confirmedTailStream = {
        songId: song.id, seek: this.streamSeekOffsetSec, speed: this.playbackSpeed, duration: st.duration,
      };
      return { advancing: true, ended: false };
    }
    if (previous.confirmed && Math.abs(advance) < TAIL_STALL_ADVANCE_MIN_SEC) {
      previous.position = st.position;
      previous.sampledAt = sampleAt;
      previous.stopHits = st.status === 1 ? 0 : previous.stopHits + 1;
      // 流长失准时，playing 下的冻结可能是缓冲，交给 30 秒宽限而非 6 秒停滞判据。
      return { advancing: false, ended: position >= song.duration - TAIL_STALL_NEAR_END_SEC &&
        previous.stopHits >= TAIL_STOP_CONFIRM_COUNT };
    }
    // 位置跳跃、回拨或未确认前的停止打断连续性，不能延长旧流宽限。
    this.deadlineTailEvidence = null;
    return result;
  }

  /** 定时器到点不等于设备播完：核对实际位置，不确定时有限重试（#495）。 */
  private async verifyTimerDeadline(): Promise<void> {
    if (this.state !== 'playing') return;
    const song = this.getCurrentSong();
    if (!song) return;
    const indexAtCheck = this.currentIndex;
    const generationAtCheck = this.checkTimerGeneration;
    const fallbackAtCheck = this.checkTimerFallbackDeadlineMs;
    const lastPosition = this.tailProbeLastPosition;
    const maxPosition = Math.max(this.tailProbeMaxPosition, this.stopPollMaxPosition);
    let reason = 'no device progress';
    let deviceEnded = false;
    let useMetadataFallback = false;

    // 负偏移是用户显式要求提前切歌，不用设备结尾反过来覆盖这个配置。
    if (this.transitionOffset >= 0 &&
      (this.deadlineGraceDeadlineMs === 0 || Date.now() < this.deadlineGraceDeadlineMs)) {
      try {
        const waitMs = this.deadlineGraceDeadlineMs > 0
          ? Math.min(DEADLINE_QUERY_WAIT_MS, this.deadlineGraceDeadlineMs - Date.now())
          : DEADLINE_QUERY_WAIT_MS;
        const st = await this.getDeadlineDeviceState(waitMs);
        if (this.state !== 'playing' || this.currentIndex !== indexAtCheck || this.checkTimerGeneration !== generationAtCheck) return;
        this.recordDevicePosition(st);
        const validPosition = st.hasPosition && Number.isFinite(st.position) && st.position >= 0;
        const looped = this.observeTailLoop(st) ||
          (maxPosition >= LOOP_DETECT_MIN_ADVANCE_SEC && st.position < LOOP_DETECT_RESET_THRESHOLD_SEC);
        const advancing = lastPosition >= 0 && st.position > lastPosition;
        const stillPlaying = st.status === 1 || (st.status >= 0 && advancing);
        const progressedSinceDeadline = this.deadlineLastPosition < 0 || st.position > this.deadlineLastPosition;
        const devicePosition = st.position * this.playbackSpeed + this.streamSeekOffsetSec;
        // 仍在播放时取较长者：设备也可能低估流长，不能据此把音频硬截短。
        const duration = Math.max(song.duration, this.getTailDuration(st));
        const remaining = duration + this.transitionOffset - devicePosition;
        const streamMatch = this.matchDeviceStream({ ...st, status: 1 });
        const sampleAt = st.sampledAt ?? Date.now();
        const fresh = sampleAt > this.deadlineSampleAtMs;
        // 成功响应但整轮从未上报进度的设备，等待也拿不到结束证据；保留原时长兜底。
        // 查询失败、旧采样、外来媒体及曾有进度后暂时缺失，仍走有界重试（#495）。
        // #129：OH2 这类整条流只回全零（位置 0、流长 0）的设备永远等不到结束证据，
        // 超过盲区窗口后直接按元数据切歌，不再附加三十秒宽限。没有下发时间的流无法证明
        // 已经播了多久，退回原宽限逻辑。
        const streamAgeMs = this.streamStartedAtMs > 0 ? Date.now() - this.streamStartedAtMs : 0;
        const longBlindStream = !this.streamPositionObserved && streamAgeMs >= STREAM_BLIND_METADATA_FALLBACK_MS;
        const onlyZeroPosition = !st.hasPosition ||
          (Number.isFinite(st.position) && st.position === 0);
        useMetadataFallback = fresh && isDeviceStatusKnown(st.status) && streamMatch !== 'foreign' &&
          ((st.hasPosition === false && !this.devicePositionObserved) ||
            (longBlindStream && !(Number.isFinite(st.duration) && st.duration > 0) && onlyZeroPosition));
        const uncertainDuration = streamMatch === 'foreign' ||
          (streamMatch === 'unknown' && this.deadlineTailEvidence !== null);
        if (!uncertainDuration) this.deadlineTailEvidence = null;
        const tail = uncertainDuration
          ? this.observeDeadlineTail(st, sampleAt, fresh)
          : { advancing: false, ended: false };
        if (fresh) {
          this.deadlineSamplePosition = validPosition && st.status === 1 ? st.position : -1;
          this.deadlineSampleAtMs = sampleAt;
        }
        deviceEnded = tail.ended || (fresh && validPosition && st.status >= 0 && !uncertainDuration &&
          (looped || devicePosition >= duration));
        if (tail.advancing) {
          // 持续推进可以超过元数据与最初的宽限截止时间；只从最后一份有效证据计宽限。
          this.deadlineGraceDeadlineMs = Math.min(sampleAt, Date.now()) + DEADLINE_GRACE_MS;
          this.scheduleDeadlineCheck(DEADLINE_RETRY_MS);
          songloft.log.info(`[PlaylistManager] Timer deferred: devicePosition=${devicePosition.toFixed(1)}s remaining=${remaining.toFixed(1)}s speed=${this.playbackSpeed} streamDuration=${st.duration}s continuousTail=true`);
          return;
        }
        if (fresh && validPosition && stillPlaying && !looped && progressedSinceDeadline &&
          !uncertainDuration && devicePosition < duration && remaining > 0) {
          this.playStartTimeMs = Date.now() - devicePosition / this.playbackSpeed * 1000;
          const samplePosition = this.deadlineSamplePosition;
          const sampleTime = this.deadlineSampleAtMs;
          const loopSample = this.tailLoopSample;
          this.startCheckTimer(remaining / this.playbackSpeed);
          this.checkTimerFallbackDeadlineMs = Math.max(this.checkTimerFallbackDeadlineMs, fallbackAtCheck);
          this.deadlineLastPosition = st.position;
          this.deadlineSamplePosition = samplePosition;
          this.deadlineSampleAtMs = sampleTime;
          this.tailLoopSample = loopSample;
          this.tailProbeMaxPosition = Math.max(maxPosition, st.position);
          songloft.log.info(`[PlaylistManager] Timer deferred: devicePosition=${devicePosition.toFixed(1)}s remaining=${remaining.toFixed(1)}s speed=${this.playbackSpeed}`);
          return;
        }
        reason = `status=${st.status} streamPosition=${st.position}s streamDuration=${st.duration}s streamMatch=${streamMatch} hasPosition=${st.hasPosition} remaining=${remaining.toFixed(1)}s looped=${looped} progressed=${progressedSinceDeadline} fresh=${fresh} continuousTail=${tail.advancing} tailConfirmed=${this.deadlineTailEvidence?.confirmed ?? false} tailInterrupted=${this.deadlineTailEvidence?.interrupted ?? false} tailEnded=${tail.ended}`;
      } catch (e) {
        if (this.state !== 'playing' || this.currentIndex !== indexAtCheck || this.checkTimerGeneration !== generationAtCheck) return;
        this.deadlineSamplePosition = -1;
        this.tailLoopSample = null;
        if (this.deadlineTailEvidence?.confirmed) {
          this.deadlineTailEvidence.interrupted = true;
          this.deadlineTailEvidence.stopHits = 0;
        } else {
          this.deadlineTailEvidence = null;
        }
        reason = 'device query failed: ' + String(e);
      }
    } else if (this.transitionOffset < 0) {
      reason = 'configured negative transition offset';
    } else {
      reason = 'device end verification grace expired';
    }

    if (this.state !== 'playing' || this.currentIndex !== indexAtCheck || this.checkTimerGeneration !== generationAtCheck) return;
    if (!deviceEnded && Date.now() < fallbackAtCheck) {
      // 尾部校准仅提前「校验」；失败、冻结或外来媒体上报不能把原兜底提前成切歌。
      this.scheduleDeadlineCheck(fallbackAtCheck - Date.now());
      songloft.log.info(`[PlaylistManager] Early check waiting for fallback: ${reason}`);
      return;
    }
    if (!deviceEnded && !useMetadataFallback && this.transitionOffset >= 0) {
      if (this.deadlineGraceDeadlineMs === 0) this.deadlineGraceDeadlineMs = Date.now() + DEADLINE_GRACE_MS;
      const graceLeft = this.deadlineGraceDeadlineMs - Date.now();
      if (graceLeft > 0) {
        this.scheduleDeadlineCheck(Math.min(DEADLINE_RETRY_MS, graceLeft));
        songloft.log.info(`[PlaylistManager] Timer retry: graceRemainingMs=${graceLeft} ${reason}`);
        return;
      }
    }
    songloft.log.info('[PlaylistManager] Timer advancing: ' + (useMetadataFallback ? 'device has no position, using metadata deadline; ' : '') + reason);
    this.stopCheckTimer();
    await this.onSongFinished();
  }

  /**
   * 启动 duration==0 的兜底切歌探测（#437）。见 DURATION_PROBE_* 常量注释。
   * 由 playCurrent 在 song.duration<=0 时调用；生命周期随 stopCheckTimer 统一清理
   * （暂停/切歌/停止/外部停止等都会经 stopCheckTimer 终止本探测）。
   */
  private scheduleDurationProbe(keepHourlyResume?: () => boolean): void {
    // 清掉上一首可能残留的切歌/停止探测定时器（如长歌的 stopPollTimer），避免悬空定时器在切歌后误触。
    this.stopCheckTimer(keepHourlyResume);
    this.maxProbePosition = 0;
    this.durationProbeTimer = setTimeout(() => {
      this.durationProbeTimer = null;
      this.probeDeviceDuration().catch(e => {
        songloft.log.warn('[PlaylistManager] duration probe error: ' + String(e));
      });
    }, DURATION_PROBE_INTERVAL_MS);
  }

  /**
   * 单轮兜底探测：读设备真实播放状态。
   * 优先：设备上报流长(duration>0) → 算出有效曲长写回内存歌曲，再 resetAutoNextTimer
   *   注册正常切歌定时器（复用既有换算：流长是墙钟秒，曲内秒 = 流长×speed+seekOffset）。
   * 兜底：设备不上报流长(#60) → 跟踪 position，曾推进到阈值以上又落回近 0 即视为
   *   音箱重拉同一 URL（自然播完），直接触发 onSongFinished 推进队列。
   */
  private async probeDeviceDuration(): Promise<void> {
    if (this.state !== 'playing') return;
    const indexAtCheck = this.currentIndex;
    const generationAtCheck = this.checkTimerGeneration;
    const speed = this.playbackSpeed;

    try {
      const st = await this.minaService.getPlayState(this.accountId, this.deviceId);
      // 探测期间状态已变化（暂停/切歌/停止）：交给那次操作处理，这里不再插手
      if (this.state !== 'playing' || this.currentIndex !== indexAtCheck || this.checkTimerGeneration !== generationAtCheck) return;
      const song = this.getCurrentSong();
      if (!song) return;
      this.recordDevicePosition(st);

      // 优先路径：拿到设备上报的流长，据此注册正常切歌定时器
      if (st.status === 1 && st.duration > 0) {
        const effectiveDuration = st.duration * speed + this.streamSeekOffsetSec;
        song.duration = effectiveDuration; // 写回内存歌曲，使 getPosition/matchDeviceStream/getStatus 一致
        const deviceSongPos = st.position * speed + this.streamSeekOffsetSec;
        songloft.log.info(`[PlaylistManager] Duration probed from device: songDuration=${effectiveDuration.toFixed(1)}s streamLen=${st.duration}s pos=${st.position}s`);
        this.resetAutoNextTimer(deviceSongPos, st.hasPosition); // 内部 stopCheckTimer 会清掉本探测，注册 checkTimer
        return;
      }

      // 兜底路径：设备不上报流长，用「循环回零」判定自然播完
      if (st.status === 1 && st.position >= 0 && st.hasPosition) {
        if (st.position > this.maxProbePosition) this.maxProbePosition = st.position;
        if (this.maxProbePosition >= LOOP_DETECT_MIN_ADVANCE_SEC && st.position < LOOP_DETECT_RESET_THRESHOLD_SEC) {
          songloft.log.info(`[PlaylistManager] Loop detected (position reset ${this.maxProbePosition.toFixed(1)}s→${st.position}s), triggering auto-next`);
          this.maxProbePosition = 0;
          this.onSongFinished().catch(e => {
            songloft.log.error('[PlaylistManager] onSongFinished error: ' + String(e));
          });
          return;
        }
      }
      // status != 1 或未上报 position：不计入，等下一轮
    } catch (e) {
      songloft.log.warn('[PlaylistManager] duration probe query failed: ' + String(e));
    }

    if (this.state !== 'playing' || this.currentIndex !== indexAtCheck || this.checkTimerGeneration !== generationAtCheck) return;
    this.durationProbeTimer = setTimeout(() => {
      this.durationProbeTimer = null;
      this.probeDeviceDuration().catch(e => {
        songloft.log.warn('[PlaylistManager] duration probe error: ' + String(e));
      });
    }, DURATION_PROBE_INTERVAL_MS);
  }

  /**
   * 调度 duration>0 正常路径的尾部设备进度校验（#481）。见 TAIL_PROBE_* 常量注释。
   * 由 startCheckTimer 在注册主定时器时按「进入尾部窗口还剩多久」延迟启动；
   * 生命周期随 stopCheckTimer 统一清理（暂停/切歌/停止/续播/重锚等都会经它终止）。
   * @param tailStartDelayMs - 距「进入尾部窗口」的墙钟毫秒，<=0 表示已在窗口内立即起探。
   */
  private scheduleTailProbe(tailStartDelayMs: number): void {
    this.tailProbeMaxPosition = 0;
    this.tailProbeLastPosition = -1;
    this.tailProbeLastCheckedAtMs = 0;
    this.tailProbeLastSampleAt = -1;
    this.tailProbeStallStartedAtMs = null;
    this.tailProbeStopMisses = 0;
    const delay = Math.max(1, Math.floor(tailStartDelayMs));
    this.tailProbeTimer = setTimeout(() => {
      this.tailProbeTimer = null;
      this.tailProbe().catch(e => {
        songloft.log.warn('[PlaylistManager] tail probe error: ' + String(e));
      });
    }, delay);
  }

  /**
   * 单轮尾部探测：读设备真实播放状态，命中任一「设备已结束」证据就提前切歌，
   * 缩短元数据时长比设备实际音频长导致的复播/停滞窗口（#481）。
   * 三条判据，命中任一即触发提前 onSongFinished：
   *   1. 循环回零：流内位置曾推进到阈值以上又落回近 0 → 音箱重拉同一 URL（自然播完）。
   *   2. 设备已停：结尾附近连续未在播放且位置不推进，单次状态误报不算播完。
   *   3. 结尾停滞：位置已到元数据结尾附近且持续至少 6 秒不推进。
   * 拿不到结束证据就继续下一轮，保留原有主定时器（checkTimer）兜底。
   */
  private async tailProbe(): Promise<void> {
    if (this.state !== 'playing') return;
    const indexAtCheck = this.currentIndex;
    const generationAtCheck = this.checkTimerGeneration;
    const song = this.getCurrentSong();
    if (!song || song.duration <= 0) return;
    const queryStartedAt = Date.now();

    try {
      const st = await this.getTailDeviceState();
      // 探测期间状态已变化（暂停/切歌/停止）：交给那次操作处理，这里不再插手
      if (this.state !== 'playing' || this.currentIndex !== indexAtCheck || this.checkTimerGeneration !== generationAtCheck) return;

      this.recordDevicePosition(st);
      const checkedAt = Date.now();
      const sampleAt = st.sampledAt ?? checkedAt;
      if (isDebugLog()) {
        songloft.log.info(`[PlaylistManager] Tail probe sample songId=${song.id} status=${st.status} streamPosition=${st.position}s hasPosition=${st.hasPosition} streamDuration=${st.duration}s seek=${this.streamSeekOffsetSec}s speed=${this.playbackSpeed} queryMs=${checkedAt - queryStartedAt}`);
      }

      // 设备上报的 position 是流内偏移，× speed + seek 起点才是曲内绝对秒
      const devicePos = st.position >= 0
        ? st.position * this.playbackSpeed + this.streamSeekOffsetSec
        : -1;
      const sampledLoop = this.observeTailLoop(st);

      if (st.sampledAt !== undefined && st.sampledAt <= this.tailProbeLastSampleAt) {
        // 缓存只供展示，重复读取不累加 stopped 命中或停滞时间，也不重锚主定时器。
      } else if (st.status >= 0 && Number.isFinite(devicePos) && devicePos >= 0 && st.hasPosition &&
        !(this.deadlineTailEvidence?.confirmed && (!Number.isFinite(st.duration) || st.duration <= 0)) &&
        this.matchDeviceStream({ ...st, status: 1 }) !== 'foreign') {
        if (st.sampledAt !== undefined) this.tailProbeLastSampleAt = st.sampledAt;
        if (st.position > this.tailProbeMaxPosition) this.tailProbeMaxPosition = st.position;

        // 判据 1：循环回零（复用兜底探测同源阈值）
        if (sampledLoop || (this.tailProbeMaxPosition >= LOOP_DETECT_MIN_ADVANCE_SEC && st.position < LOOP_DETECT_RESET_THRESHOLD_SEC)) {
          const rewind = sampledLoop ? `sampled tail rewind to ${st.position.toFixed(1)}s`
            : `stream position reset ${this.tailProbeMaxPosition.toFixed(1)}s→${st.position.toFixed(1)}s`;
          this.triggerTailAdvance(`loop detected (${rewind}, seek=${this.streamSeekOffsetSec}s)`, indexAtCheck);
          return;
        }

        // 判据 3：结尾停滞——已到元数据结尾附近且连续多轮位置不推进
        const nearEnd = devicePos >= this.getTailDuration(st) - TAIL_STALL_NEAR_END_SEC;
        const advanced = this.tailProbeLastPosition >= 0
          && st.position - this.tailProbeLastPosition + 1e-6 >= TAIL_STALL_ADVANCE_MIN_SEC;
        if (st.status === 1 || advanced) {
          this.tailProbeStopMisses = 0;
        } else {
          this.tailProbeStopMisses++;
          if (nearEnd && this.tailProbeStopMisses >= TAIL_STOP_CONFIRM_COUNT &&
            this.tailProbeMaxPosition >= LOOP_DETECT_MIN_ADVANCE_SEC) {
            this.triggerTailAdvance(`device stopped at tail (status=${st.status}, position=${devicePos.toFixed(1)}s)`, indexAtCheck);
            return;
          }
        }
        if (nearEnd && this.tailProbeLastPosition >= 0) {
          if (advanced) {
            this.tailProbeStallStartedAtMs = null;
          } else {
            if (this.tailProbeStallStartedAtMs === null) {
              this.tailProbeStallStartedAtMs = this.tailProbeLastCheckedAtMs;
            }
            const stalledMs = sampleAt - this.tailProbeStallStartedAtMs;
            if (stalledMs >= TAIL_STALL_CONFIRM_MS) {
              this.triggerTailAdvance(`stalled at tail (position ${devicePos.toFixed(1)}s/${song.duration}s, stalledMs=${stalledMs})`, indexAtCheck);
              return;
            }
          }
        } else {
          // 还没进结尾附近：不累计停滞，只更新基线
          this.tailProbeStallStartedAtMs = null;
        }
        this.calibrateTailDeadline(st, queryStartedAt, checkedAt);
        this.tailProbeLastPosition = st.position;
        this.tailProbeLastCheckedAtMs = sampleAt;
      } else {
        // 未知状态/位置、外来媒体不能证明当前歌结束；查询恢复后重新建立基线。
        this.tailProbeLastPosition = -1;
        this.tailProbeStallStartedAtMs = null;
        this.tailProbeStopMisses = 0;
      }
    } catch (e) {
      if (this.checkTimerGeneration !== generationAtCheck) return;
      this.tailLoopSample = null;
      this.tailProbeLastPosition = -1;
      this.tailProbeStallStartedAtMs = null;
      this.tailProbeStopMisses = 0;
      songloft.log.warn('[PlaylistManager] tail probe query failed: ' + String(e));
    }

    if (this.state !== 'playing' || this.currentIndex !== indexAtCheck || this.checkTimerGeneration !== generationAtCheck) return;
    this.tailProbeTimer = setTimeout(() => {
      this.tailProbeTimer = null;
      this.tailProbe().catch(e => {
        songloft.log.warn('[PlaylistManager] tail probe error: ' + String(e));
      });
    }, TAIL_PROBE_INTERVAL_MS);
  }

  /**
   * 尾部探测命中「设备已结束」证据：清掉主定时器后提前触发 onSongFinished。
   * onSongFinished → advanceToNext → playCurrent 会经 stopCheckTimer 清掉本探测，不会重入。
   */
  private triggerTailAdvance(reason: string, indexAtCheck: number): void {
    if (this.state !== 'playing' || this.currentIndex !== indexAtCheck) return;
    songloft.log.info(`[PlaylistManager] Tail probe advancing early: ${reason}`);
    this.stopCheckTimer();
    this.onSongFinished().catch(e => {
      songloft.log.error('[PlaylistManager] onSongFinished error: ' + String(e));
    });
  }

  /**
   * 安排下一次外部停止探测。每次重新校准自动切歌定时器（resetAutoNextTimer / 续播等）
   * 都会经 startCheckTimer 重走这里，探测计划随之刷新，与切歌定时器保持同源。
   *
   * 按 stopPollDeadlineMs（绝对截止墙钟）决定是否继续以及等多久：旧实现把剩余预算按
   * 「调度间隔」递减、不计 getPlayState 的云端查询耗时，导致 stop-poll 比墙钟慢约 10%，
   * 漏进尾部 15s 窗口与 tail-probe 竞态。改读 deadline 后准时停(#114)。
   */
  private async scheduleStopPoll(): Promise<void> {
    const scheduleVersion = ++this.stopPollScheduleVersion;
    const generation = this.checkTimerGeneration;
    if (this.stopPollTimer !== null) clearTimeout(this.stopPollTimer);
    this.stopPollTimer = null;
    let hourlyEnabled = false;
    try {
      hourlyEnabled = (await this.configManager.getConfig()).hourly_chime_resume_enabled === true;
    } catch (e) {
      songloft.log.warn('[PlaylistManager] Stop poll config unavailable: ' + String(e));
    }
    // 配置查询也可能跨过暂停、换歌或重新校准，不能注册旧流的探测。
    if (scheduleVersion !== this.stopPollScheduleVersion || generation !== this.checkTimerGeneration ||
      this.state !== 'playing' || this.isVoiceSuspended() || this.isHourlyResumePending()) return;
    const remainingMs = this.stopPollDeadlineMs - Date.now();
    if (remainingMs <= 0) return;
    let interval = EXTERNAL_STOP_POLL_INTERVAL_MS;
    let verify = false;
    let maxAgeMs: number | undefined;
    const song = this.getCurrentSong();
    if (hourlyEnabled && this.playbackConfirmed && !this.externalPlayback && song?.type !== 'radio') {
      const now = new Date(Date.now());
      const sinceHour = (now.getMinutes() * 60 + now.getSeconds()) * 1000 + now.getMilliseconds();
      const hour = now.getTime() - sinceHour;
      if (sinceHour < HOURLY_RESUME_WINDOW_MS && hour !== this.lastHourlyResumeHour) {
        // 报时没有对话事件。先缩短发现中断的等待；仍须设备证据，不按整点直接重推。
        verify = this.stopPollMisses === 1 && !this.stopPollFastConfirmationUsed;
        interval = verify ? HOURLY_RESUME_FAST_POLL_MS : HOURLY_RESUME_POLL_MS;
        maxAgeMs = HOURLY_RESUME_POLL_MS;
      } else {
        const nextHour = new Date(now);
        nextHour.setHours(nextHour.getHours() + 1, 0, 0, 0);
        interval = Math.min(interval, nextHour.getTime() - now.getTime());
      }
    }
    const wait = Math.min(interval, remainingMs);
    this.stopPollTimer = setTimeout(() => {
      this.stopPollTimer = null;
      if (verify) this.stopPollFastConfirmationUsed = true;
      this.checkExternalStop(verify, maxAgeMs).catch(e => {
        songloft.log.warn('[PlaylistManager] checkExternalStop error: ' + String(e));
      });
    }, wait);
  }

  /**
   * 查询设备真实播放状态，捕获自动切歌定时器无法感知的外部停止
   * （如语音"关机"未被 ConversationMonitor 捕获、且网页/App 已关闭没有客户端轮询校准）。
   *
   * 小爱在 URL/MUSIC 模式下会偶发把正常播放误报成 stopped/paused（同类风险见
   * handlers/playlist.ts 的 syncManagerFromDeviceState 注释），而且会**连续**误报，两次确认
   * 挡不住（#449）。因此 status 不是唯一判据：连续两次「未在播放」上报之间 position 若明显
   * 推进，说明设备其实在播，按 status 误报处理并清零计数
   * （见 EXTERNAL_STOP_POSITION_ADVANCE_MIN_SEC）。
   */
  private async checkExternalStop(verify: boolean = false, maxAgeMs?: number): Promise<void> {
    if (this.state !== 'playing' || this.isHourlyResumePending()) return;
    const indexAtCheck = this.currentIndex;
    const generationAtCheck = this.checkTimerGeneration;
    const cancelVersion = this.hourlyResumeCancelVersion;
    const isCurrent = () => this.state === 'playing' && this.currentIndex === indexAtCheck &&
      this.checkTimerGeneration === generationAtCheck;

    try {
      const st = await this.minaService.getPlayState(this.accountId, this.deviceId, { verify, maxAgeMs });
      if (!isCurrent()) return;
      if (cancelVersion !== this.hourlyResumeCancelVersion) {
        this.scheduleStopPoll();
        return;
      }
      this.recordDevicePosition(st);
      const { status, position } = st;
      const sampleAt = st.sampledAt ?? Date.now();
      const fresh = status >= 0 && sampleAt > this.stopPollLastSampleAt;
      if (fresh) {
        this.stopPollLastSampleAt = sampleAt;
        const blindIdle = this.isBlindIdleState(st);
        const hourlyArmed = blindIdle && await this.isHourlyResumeApplicable();
        if (!isCurrent()) return;
        const blind = blindIdle && !hourlyArmed;
        const hasPosition = st.hasPosition === true && Number.isFinite(position) && position >= 0;
        const stream = this.matchDeviceStream({ ...st, status: 1 });
        if (blind) {
          // #129：这条流从起播起就只有 idle + 全零详情（OH2 正常出声也如此）。
          // status 证明不了外部停止；保留播放，交给元数据定时器继续。
          if (!this.blindIdleNoticeLogged) {
            songloft.log.info(`[PlaylistManager] External stop ignored: device reports no usable state (status=${status}, position=${position}s, duration=${st.duration}s), relying on metadata timer`);
            this.blindIdleNoticeLogged = true;
          }
          this.stopPollMisses = 0;
          this.stopPollLastPosition = -1;
          this.stopPollResumePosition = null;
        } else {
          if (hasPosition && stream !== 'foreign') {
            this.stopPollMaxPosition = Math.max(this.stopPollMaxPosition, position);
          }
          if (status === 1 && stream !== 'foreign') {
            this.playbackConfirmed = true;
            this.stopPollMisses = 0;
            this.stopPollLastPosition = -1;
            this.stopPollResumePosition = null;
          } else if (isDeviceIdle(status) || (status === 1 && stream === 'foreign')) {
            const advanced = hasPosition && stream !== 'foreign' && this.stopPollLastPosition >= 0 &&
              position - this.stopPollLastPosition >= (verify ? TAIL_STALL_ADVANCE_MIN_SEC : EXTERNAL_STOP_POSITION_ADVANCE_MIN_SEC);
            this.stopPollLastPosition = hasPosition && stream !== 'foreign' ? position : -1;
            if (advanced) {
              songloft.log.info(`[PlaylistManager] External stop ignored: status=${status} but position advanced to ${position}s, device still playing`);
              this.playbackConfirmed = true;
              this.stopPollMisses = 0;
              this.stopPollResumePosition = null;
            } else {
              if (this.stopPollMisses === 0) {
                this.stopPollFirstStopAtMs = Date.now();
                // 报时通常在整点开始；无设备位置时以整点锚定，避免把探测延迟算成已听内容。
                const now = new Date(Date.now());
                const sinceHour = (now.getMinutes() * 60 + now.getSeconds()) + now.getMilliseconds() / 1000;
                this.stopPollResumePosition = hasPosition && position > 0 && stream === 'ours'
                  ? position * this.playbackSpeed + this.streamSeekOffsetSec
                  : Math.max(this.streamSeekOffsetSec, this.getPosition() - (sinceHour < 90 ? sinceHour * this.playbackSpeed : 0));
              }
              this.stopPollMisses++;
              if (this.stopPollMisses >= EXTERNAL_STOP_CONFIRM_COUNT) {
                const song = this.getCurrentSong();
                const nearStart = !!song && hasPosition && stream !== 'foreign' && position < LANDING_EARLY_STOP_SEC;
                // 重载接管的流没有本次下发时间；缺失时间不能证明它刚起播。
                const streamAge = this.streamStartedAtMs > 0 ? Date.now() - this.streamStartedAtMs : Infinity;
                // 起播确认成功或已经离开起播墙钟窗口后，回零不能再证明歌曲不可播放。
                if (nearStart && !this.playbackConfirmed && this.stopPollMaxPosition < LANDING_EARLY_STOP_SEC &&
                  streamAge <= 60000) {
                  songloft.log.warn(`[PlaylistManager] External stop early (status=${status}, position=${position}s), treating as landing failure`);
                  this.markSongUnplayable(song!.id, 'early-stop');
                  await this.handleLandingFailure({ tts: true });
                  return;
                }
                const nearEnd = !!song && song.duration > 0 &&
                  (this.stopPollMaxPosition * this.playbackSpeed + this.streamSeekOffsetSec >= song.duration - EXTERNAL_STOP_TAIL_GUARD_SEC ||
                    this.getPosition() >= song.duration - EXTERNAL_STOP_TAIL_GUARD_SEC);
                if (nearStart && this.stopPollMaxPosition >= LANDING_EARLY_STOP_SEC && nearEnd) {
                  songloft.log.info(`[PlaylistManager] External stop at song tail, advancing as natural end (status=${status}, position=${position}s)`);
                  this.stopCheckTimer();
                  void this.onSongFinished().catch(e => {
                    songloft.log.error('[PlaylistManager] onSongFinished error: ' + String(e));
                  });
                  return;
                }
                const recoveryIsCurrent = () => isCurrent() && cancelVersion === this.hourlyResumeCancelVersion;
                if (await this.tryHourlyResume(this.stopPollResumePosition ?? this.getPosition(), recoveryIsCurrent)) {
                  if (isCurrent() && cancelVersion !== this.hourlyResumeCancelVersion) this.scheduleStopPoll();
                  return;
                }
                if (!isCurrent()) return;
                if (stream === 'foreign') {
                  // 不在整点恢复范围内的外来媒体交给原有语音交互处理，不抢占或推送下一首。
                  this.stopPollMisses = 0;
                } else {
                  songloft.log.info(`[PlaylistManager] External stop confirmed (status=${status}, position=${position}s), cancelling auto-next`);
                  await this.stop(false);
                  return;
                }
              }
            }
          } else {
            this.stopPollMisses = 0;
            this.stopPollLastPosition = -1;
            this.stopPollResumePosition = null;
          }
        }
      } else if (status < 0) {
        // 查询失败打断连续确认；缺失进度也不能作为回零或推进的证据。
        this.stopPollMisses = 0;
        this.stopPollLastPosition = -1;
        this.stopPollResumePosition = null;
      }
    } catch (e) {
      if (isCurrent()) {
        this.stopPollMisses = 0;
        this.stopPollLastPosition = -1;
        this.stopPollResumePosition = null;
      }
      songloft.log.warn('[PlaylistManager] checkExternalStop query failed: ' + String(e));
    }

    if (this.stopPollMisses === 0) this.stopPollFastConfirmationUsed = false;
    if (isCurrent() && Date.now() < this.stopPollDeadlineMs) void this.scheduleStopPoll();
  }

  isHourlyResumePending(): boolean {
    return this.hourlyResumeTask?.waiting === true;
  }

  /** 新对话或配置关闭时取消等待；设备筛选覆盖共享分组成员。 */
  cancelHourlyResume(deviceId?: string): void {
    if (deviceId && !this.targets.some(t => t.device_id === deviceId)) return;
    // 配置/设备状态查询仍在等待时也要失效，不能等任务建好才取消。
    this.hourlyResumeCancelVersion++;
    if (this.stopPollMisses > 0) {
      // 新对话接手后，快速探测不能把同一轮旧中断重新建成报时恢复任务。
      const now = new Date(this.stopPollFirstStopAtMs || Date.now());
      this.lastHourlyResumeHour = now.getTime() -
        (now.getMinutes() * 60 + now.getSeconds()) * 1000 - now.getMilliseconds();
    }
    this.clearHourlyResume(true);
  }

  private clearHourlyResume(restoreTimer: boolean): void {
    const task = this.hourlyResumeTask;
    if (!task) return;
    const position = task.waiting ? task.position : this.getPosition();
    task.cancelled = true;
    this.hourlyResumeTask = null;
    if (this.hourlyResumeTimer !== null) clearTimeout(this.hourlyResumeTimer);
    this.hourlyResumeTimer = null;
    this.hourlyResumeWake?.();
    this.hourlyResumeWake = null;
    if ((task.waiting || restoreTimer) && this.state === 'playing') {
      this.playStartTimeMs = Date.now() - position / this.playbackSpeed * 1000;
      if (restoreTimer) this.resetAutoNextTimer(position, false);
    }
  }

  private async tryHourlyResume(position: number, isCurrent: () => boolean): Promise<boolean> {
    if (!this.playbackConfirmed || this.isVoiceSuspended() || this.externalPlayback) return false;
    const now = new Date(this.stopPollFirstStopAtMs || Date.now());
    const sinceHour = (now.getMinutes() * 60 + now.getSeconds()) * 1000 + now.getMilliseconds();
    const hour = now.getTime() - sinceHour;
    if (sinceHour >= HOURLY_RESUME_WINDOW_MS || hour === this.lastHourlyResumeHour) return false;
    const config = await this.configManager.getConfig();
    if (!isCurrent()) return true;
    if (config.hourly_chime_resume_enabled !== true) return false;
    const song = this.getCurrentSong();
    if (!song || song.type === 'radio' || (song.duration > 0 && position >= song.duration - EXTERNAL_STOP_TAIL_GUARD_SEC)) return false;

    this.stopCheckTimer();
    this.lastHourlyResumeHour = hour;
    const task: HourlyResumeTask = {
      position, startedAt: Date.now(), waiting: true, cancelled: false,
      isCurrent: () => !task.cancelled && this.hourlyResumeTask === task && this.state === 'playing' && !this.externalPlayback,
    };
    this.hourlyResumeTask = task;
    songloft.log.info(`[PlaylistManager] Hourly chime interruption, waiting to resume at ${position.toFixed(1)}s`);
    void this.waitHourlyResume(task, config.smart_resume_timeout ?? 30).catch(e => {
      songloft.log.warn('[PlaylistManager] Hourly resume failed: ' + String(e));
      if (task.isCurrent()) void this.stop(false).catch(() => { });
    });
    return true;
  }

  private async waitHourlyResume(task: HourlyResumeTask, timeoutSec: number): Promise<void> {
    const timeoutMs = Math.max(5, Math.min(120, Number.isFinite(timeoutSec) ? timeoutSec : 30)) * 1000;
    let lastSampleAt = task.startedAt - 1;
    let lastPosition = -1;
    let idleHits = 0;
    let fastQueries = 0;
    let idleConfirmationQueries = 0;
    while (task.isCurrent() && Date.now() - task.startedAt < timeoutMs) {
      const config = await this.configManager.getConfig();
      if (!task.isCurrent()) return;
      if (config.hourly_chime_resume_enabled !== true) { this.cancelHourlyResume(); return; }
      const confirmIdle = idleHits === 1 && idleConfirmationQueries < 1;
      const fast = fastQueries < HOURLY_RESUME_FAST_QUERIES || confirmIdle;
      if (fastQueries < HOURLY_RESUME_FAST_QUERIES) fastQueries++;
      else if (confirmIdle) idleConfirmationQueries++;
      const st = await this.minaService.getPlayState(this.accountId, this.deviceId, { verify: fast, maxAgeMs: HOURLY_RESUME_POLL_MS });
      if (!task.isCurrent()) return;
      if (Date.now() - task.startedAt >= timeoutMs) break;
      const sampleAt = st.sampledAt ?? Date.now();
      if (st.status < 0) {
        fastQueries = HOURLY_RESUME_FAST_QUERIES;
        idleConfirmationQueries = 1;
        idleHits = 0;
        lastPosition = -1;
      } else if (sampleAt > lastSampleAt && sampleAt >= task.startedAt) {
        lastSampleAt = sampleAt;
        this.recordDevicePosition(st);
        const stream = this.matchResumeDeviceStream({ ...st, status: 1 });
        const positionMatches = stream === 'ours' || (stream === 'unknown' &&
          st.position * this.playbackSpeed + this.streamSeekOffsetSec >= task.position - 5 * this.playbackSpeed);
        if (st.hasPosition && Number.isFinite(st.position) && st.position >= 0 && positionMatches) {
          if (lastPosition >= 0 && st.position - lastPosition >= TAIL_STALL_ADVANCE_MIN_SEC) {
            const position = st.position * this.playbackSpeed + this.streamSeekOffsetSec;
            songloft.log.info('[PlaylistManager] Hourly chime auto-resumed, progress confirmed');
            this.resetAutoNextTimer(position);
            return;
          }
          lastPosition = st.position;
        } else lastPosition = -1;
        idleHits = isDeviceIdle(st.status) ? idleHits + 1 : 0;
        if (idleHits >= 2) {
          // 只有新鲜的连续 idle 才发恢复指令，播报中、重复缓存或未知状态都不重推。
          const latestConfig = await this.configManager.getConfig();
          if (!task.isCurrent()) return;
          if (latestConfig.hourly_chime_resume_enabled !== true) { this.cancelHourlyResume(); return; }
          task.waiting = false;
          this.playStartTimeMs = Date.now() - task.position / this.playbackSpeed * 1000;
          // L15A 停止后媒体详情已丢失：裸 play 无法恢复，直接重推以省掉无效指令和校验等待。
          const resumed = !hasLostDeviceMedia(st) &&
            await this.resumePlayback({ positionSec: task.position, isCurrent: task.isCurrent });
          if (!resumed && task.isCurrent()) {
            const replayed = await this.replayCurrent(this.getSafeResumePosition(task.position), task.isCurrent);
            if (!replayed && task.isCurrent()) await this.stop(false);
          }
          return;
        }
      }
      await new Promise<void>(resolve => {
        this.hourlyResumeWake = resolve;
        this.hourlyResumeTimer = setTimeout(() => {
          this.hourlyResumeTimer = null;
          this.hourlyResumeWake = null;
          resolve();
        },
          Math.min(fastQueries < HOURLY_RESUME_FAST_QUERIES || (idleHits === 1 && idleConfirmationQueries < 1)
            ? HOURLY_RESUME_FAST_POLL_MS : HOURLY_RESUME_POLL_MS, timeoutMs - (Date.now() - task.startedAt)));
      });
    }
    if (task.isCurrent()) {
      songloft.log.warn('[PlaylistManager] Hourly resume timed out without idle/progress evidence');
      await this.stop(false);
    }
  }

  /**
   * 停止定时器
   */
  private stopCheckTimer(keepHourlyResume?: () => boolean): void {
    if (!keepHourlyResume || this.hourlyResumeTask?.isCurrent !== keepHourlyResume) this.clearHourlyResume(false);
    this.checkTimerGeneration++;
    this.cancelDeadlineQuery?.();
    this.checkTimerDeadlineMs = 0;
    this.checkTimerFallbackDeadlineMs = 0;
    if (this.checkTimer !== null) {
      clearTimeout(this.checkTimer);
      this.checkTimer = null;
    }
    if (this.stopPollTimer !== null) {
      clearTimeout(this.stopPollTimer);
      this.stopPollTimer = null;
    }
    this.stopPollMisses = 0;
    this.stopPollFastConfirmationUsed = false;
    this.stopPollLastPosition = -1;
    this.stopPollLastSampleAt = -1;
    this.stopPollResumePosition = null;
    this.stopPollFirstStopAtMs = 0;
    this.stopPollMaxPosition = 0;
    this.stopPollDeadlineMs = 0;
    if (this.durationProbeTimer !== null) {
      clearTimeout(this.durationProbeTimer);
      this.durationProbeTimer = null;
    }
    this.maxProbePosition = 0;
    if (this.tailProbeTimer !== null) {
      clearTimeout(this.tailProbeTimer);
      this.tailProbeTimer = null;
    }
    this.tailProbeMaxPosition = 0;
    this.tailProbeLastPosition = -1;
    this.tailProbeLastCheckedAtMs = 0;
    this.tailProbeLastSampleAt = -1;
    this.tailProbeStallStartedAtMs = null;
    this.tailProbeStopMisses = 0;
    this.tailProbeQuery = null;
    this.deadlineLastPosition = -1;
    this.deadlineSamplePosition = -1;
    this.deadlineSampleAtMs = -1;
    this.deadlineGraceDeadlineMs = 0;
    this.deadlineTailEvidence = null;
    this.tailLoopSample = null;
    if (this.landingVerifyTimer !== null) {
      clearTimeout(this.landingVerifyTimer);
      this.landingVerifyTimer = null;
    }
  }

  // ===== 外部恢复探测（stopped 态检测设备恢复播放） =====

  /**
   * 外部恢复：设备端被物理按键或其他途径恢复播放，插件从 stopped 态重新接管自动切歌。
   * 由 checkExternalResume（无 Web 前端）和 syncManagerFromDeviceState（有 Web 前端）共同调用。
   */
  handleExternalResume(devicePositionSec: number): void {
    if (this.externalPlayback) return;
    if (this.state !== 'stopped' || this.songs.length === 0) return;
    const song = this.getCurrentSong();
    if (!song) return;

    this.state = 'playing';
    this.hardStopped = false;
    if (Number.isFinite(devicePositionSec) && devicePositionSec >= 0) {
      this.devicePositionObserved = true;
      if (devicePositionSec > 0) {
        this.streamEvidenceObserved = true;
        this.streamPositionObserved = true;
      }
    }
    if (song.duration > 0) {
      this.playStartTimeMs = Date.now() - (devicePositionSec / this.playbackSpeed) * 1000;
      const remaining = song.duration - devicePositionSec;
      if (remaining > 0) {
        this.startCheckTimer(remaining / this.playbackSpeed);
      } else {
        this.startCheckTimer(0.1);
      }
      songloft.log.info(`[PlaylistManager] External resume detected: position=${devicePositionSec.toFixed(1)}s remaining=${remaining.toFixed(1)}s`);
    } else {
      // duration==0：改启动设备流长探测兜底（#437）。首轮读到流长后由 resetAutoNextTimer
      // 按 device position 重锚 playStartTimeMs，这里先粗锚一份避免中间态 getPosition 恒为 0。
      this.playStartTimeMs = Date.now();
      this.scheduleDurationProbe();
      songloft.log.info(`[PlaylistManager] External resume detected, duration unknown, starting device duration probe`);
    }
  }

  private startResumePoll(): void {
    this.stopResumePoll();
    if (this.externalPlayback) return;
    if (this.songs.length === 0) return;
    this.resumePollStartedAt = Date.now();
    this.resumePollHits = 0;
    this.scheduleResumePoll();
  }

  private stopResumePoll(): void {
    if (this.resumePollTimer !== null) {
      clearTimeout(this.resumePollTimer);
      this.resumePollTimer = null;
    }
    this.resumePollStartedAt = 0;
    this.resumePollHits = 0;
  }

  private scheduleResumePoll(): void {
    this.resumePollTimer = setTimeout(() => {
      this.resumePollTimer = null;
      this.checkExternalResume().catch(e => {
        songloft.log.warn('[PlaylistManager] checkExternalResume error: ' + String(e));
      });
    }, EXTERNAL_RESUME_POLL_INTERVAL_MS);
  }

  private async checkExternalResume(): Promise<void> {
    if (this.state !== 'stopped' || this.songs.length === 0) return;

    if (Date.now() - this.resumePollStartedAt > EXTERNAL_RESUME_POLL_MAX_MS) {
      songloft.log.info('[PlaylistManager] Resume poll timed out, giving up');
      return;
    }

    try {
      const deviceState = await this.minaService.getPlayState(this.accountId, this.deviceId);
      const { status, position } = deviceState;
      if (this.state !== 'stopped') return;

      if (status === 1) {
        // status=1 不足以接管：小爱在放它自己的内容时同样是 1，误判会在一个曲长后强推下一首
        // 把它打断（#408 那类「停了之后又自动播放」）。物理按键恢复的正常场景放的是我们的流，
        // 'ours'/'unknown' 都放过，只挡明确认定被接管的 'foreign'。
        if (this.matchDeviceStream(deviceState) === 'foreign') {
          songloft.log.info(`[PlaylistManager] Resume poll: device playing foreign media (deviceDuration=${deviceState.duration}s), not taking over`);
          this.resumePollHits = 0;
        } else {
          this.resumePollHits++;
          if (this.resumePollHits >= EXTERNAL_RESUME_CONFIRM_COUNT) {
            this.handleExternalResume(position);
            return;
          }
        }
      } else if (status >= 0) {
        this.resumePollHits = 0;
      }
    } catch (e) {
      songloft.log.warn('[PlaylistManager] checkExternalResume query failed: ' + String(e));
    }

    if (this.state === 'stopped') {
      this.scheduleResumePoll();
    }
  }

  /**
   * 歌曲播放结束回调
   */
  private async onSongFinished(): Promise<void> {
    if (this.state !== 'playing') {
      songloft.log.info('[PlaylistManager] Not playing, skip auto-next');
      return;
    }
    // 分组共用一个 PlaylistManager：这里的切歌会经 playCurrent 一次性下发给组内所有音箱，
    // 只有一份队列/随机数/定时器，天然全组同一首，无需组长选举或成员间同步。
    const song = this.getCurrentSong();
    // 结束也可能仅来自元数据定时器：清除旧标记，但连续失败只由设备确认成功来重置。
    if (song) this.clearSongFailure(song.id);
    await this.advanceToNext();
  }

  /**
   * 切到下一首并播放（自动续播核心）。playCurrent 会把新歌下发给全部目标设备。
   */
  private async advanceToNext(): Promise<void> {
    if (this.externalPlayback) return;
    return this.trackPlayback(() => this.advanceToNextInternal());
  }

  private async advanceToNextInternal(): Promise<void> {
    songloft.log.info(`[PlaylistManager] Song finished, advancing from index=${this.currentIndex}`);

    if (this.onAdvanceHook && this.onAdvanceHook()) {
      songloft.log.info('[PlaylistManager] onAdvanceHook returned true, stopping playback');
      await this.stop();
      return;
    }

    // 通知后端当前歌曲播放完成（触发 JS 插件播放事件广播）
    const finishedSong = this.songs[this.currentIndex];
    if (finishedSong && finishedSong.id > 0) {
      callHostAPI('POST', `/api/v1/songs/${finishedSong.id}/played?source=miot`, undefined, { timeoutMs: 3000 }).catch(e => {
        songloft.log.warn('[PlaylistManager] songPlayed notify failed: ' + String(e));
      });
    }

    if (this.playMode === 'singlePlay') {
      // 与主程序一致：自然播放结束后停在当前歌曲，不循环也不推进。
      // 标记为 hardStopped，使用户再次点击播放时直接从头重推 URL，避免对已结束的
      // 设备媒体上下文发送 resume 后出现无声播放。
      this.clearPendingNextIndex();
      this.state = 'paused';
      this.playStartTimeMs = 0;
      this.pausedPositionSec = 0;
      this.streamSeekOffsetSec = 0;
      this.hardStopped = true;
      songloft.log.info('[PlaylistManager] Single-play completed, pausing on current song');
      return;
    }

    // 必须是 prefetchNextSong 预热过的那首（reserveNextIndex 已把两者锁到同一首），
    // 否则随机模式下播的永远是没预热的歌，开了音量均衡就要冷启动整首 loudnorm。
    // 跳过仍在冷却期的歌曲，最多扫描 songs.length 次。候选全部被标记时重试原定下一首，
    // 让暂时抖动有恢复机会；真正持续起播失败仍由连续失败熔断保护（#494）。
    let nextIdx = this.reserveNextIndex();
    const firstCandidate = nextIdx;
    const randomPlayedBeforeSkips = this.playMode === 'random' &&
      this.isSongUnplayable(this.songs[nextIdx]?.id ?? 0) ? new Set(this.randomPlayed) : null;
    let unplayableSkips = 0;
    while (nextIdx >= 0 && this.isSongUnplayable(this.songs[nextIdx]?.id ?? 0)) {
      if (unplayableSkips >= this.songs.length || (this.playMode === 'single' && unplayableSkips > 0)) {
        nextIdx = -1;
        break;
      }
      const skipped = this.songs[nextIdx];
      songloft.log.info(`[PlaylistManager] Skipping known-unplayable song index=${nextIdx} id=${skipped?.id} title=${skipped?.title}`);
      this.currentIndex = nextIdx;
      this.clearPendingNextIndex();
      nextIdx = this.reserveNextIndex();
      unplayableSkips++;
    }
    if (nextIdx < 0 && unplayableSkips > 0) {
      songloft.log.warn(`[PlaylistManager] All next candidates temporarily unplayable, retrying index=${firstCandidate} after ${unplayableSkips} skips`);
      nextIdx = firstCandidate;
      if (randomPlayedBeforeSkips) this.randomPlayed = randomPlayedBeforeSkips;
      this.clearPendingNextIndex();
    }
    if (nextIdx < 0) {
      songloft.log.info('[PlaylistManager] No next song, playback complete');
      this.state = 'stopped';
      this.playStartTimeMs = 0;
      return;
    }

    this.currentIndex = nextIdx;
    const ok = await this.playCurrent();
    if (ok) {
      await this.persistState();
      return;
    }

    // 常见于设备超时 code=3012。云端秒级抖动通常持续 10~60s，单次 3s 重试命中率过低
    // （songloft-org/songloft-player#45）：改指数退避多轮，给云端恢复的机会，仍失败才跳下一首。
    const retryIndex = this.currentIndex;
    const AUTO_NEXT_RETRY_DELAYS_MS = [3000, 8000];
    let retryOk = false;
    for (let attempt = 0; attempt < AUTO_NEXT_RETRY_DELAYS_MS.length; attempt++) {
      const delayMs = AUTO_NEXT_RETRY_DELAYS_MS[attempt];
      songloft.log.warn(`[PlaylistManager] Auto-next play failed, retrying in ${delayMs}ms (attempt ${attempt + 1}/${AUTO_NEXT_RETRY_DELAYS_MS.length})`);
      await new Promise(r => setTimeout(r, delayMs));
      if (this.state !== 'playing' || this.currentIndex !== retryIndex) return;

      if (await this.playCurrent({ skipAnnouncement: true })) {
        retryOk = true;
        break;
      }
    }
    if (retryOk) {
      await this.persistState();
      return;
    }

    // 重试仍失败，尝试跳到下一首（上一句 playCurrent 已把 pending 清掉，这里会重新定一首）
    const skipIdx = this.reserveNextIndex();
    if (skipIdx >= 0 && skipIdx !== this.currentIndex) {
      songloft.log.warn('[PlaylistManager] Retry failed, skipping to next song');
      this.currentIndex = skipIdx;
      const skipOk = await this.playCurrent();
      if (skipOk) {
        await this.persistState();
        return;
      }
    }

    songloft.log.error('[PlaylistManager] Auto-next failed after retry, stopping');
    // 熔断计数：多首连续硬失败达阈值时给用户 TTS 提示（#466）
    this.landingFailureCount++;
    if (this.landingFailureCount >= LANDING_FAILURE_CIRCUIT_BREAK) {
      this.landingFailureCount = 0;
      void this.minaService.textToSpeech(this.accountId, this.deviceId, LANDING_CIRCUIT_BREAK_TTS_TEXT).catch(() => { });
    }
    this.state = 'stopped';
    this.playStartTimeMs = 0;
    // 张开外部恢复兜底网：下发失败可能仍是假失败（#98），而 playCurrent 的核实也有漏判的可能
    // （设备既不上报流长、位置又超出起播窗口）。轮询发现设备其实在放我们的流就重新接管切歌，
    // 否则这里就是播放的终点。stop() 一直有这一步，这条失败路径此前漏了。
    this.startResumePoll();
  }

  /**
   * 生成「插件重载后续播」所需的锚点字段。
   *
   * 只存一个「某时刻播到某位置」的锚点，不做周期性写盘：连续播放时位置可以由
   * `锚点位置 + 经过墙钟时间 × 倍速` 精确外推，而每一次暂停 / 续播 / 切歌 / 改倍速
   * 都会重新调用 persistState 把锚点打新，所以锚点不会长期失真。
   *
   * 非播放态（stopped/idle）显式写空值而不是留着旧锚点：留旧值会让下一次重载
   * 误以为「刚才还在放」，凭空把音箱叫起来。
   */
  private buildResumeAnchor(): {
    resume_state: string;
    resume_position_sec: number;
    resume_at_ms: number;
    resume_song_id: number;
    resume_seek_offset_sec: number;
  } {
    const song = this.getCurrentSong();
    if (!song || (this.state !== 'playing' && this.state !== 'paused')) {
      return { resume_state: '', resume_position_sec: 0, resume_at_ms: 0, resume_song_id: 0, resume_seek_offset_sec: 0 };
    }
    // getPosition() 在非 playing 态恒返回 0，暂停位置只能从 pausedPositionSec 取
    const position = this.state === 'paused' ? this.pausedPositionSec : this.getPosition();
    return {
      resume_state: this.state,
      resume_position_sec: Math.max(0, position),
      resume_at_ms: Date.now(),
      resume_song_id: song.id,
      resume_seek_offset_sec: this.streamSeekOffsetSec,
    };
  }

  /**
   * 持久化播放状态到设备配置
   */
  private async persistState(): Promise<void> {
    const anchor = this.buildResumeAnchor();
    if (isTempPlaylistId(this.playlistId)) {
      try {
        await this.configManager.updateDevice(this.accountId, this.deviceId, {
          playlist_id: 0,
          temp_artist: this.tempArtistQuery,
          temp_artist_exact: this.tempArtistExact,
          temp_song_id: this.getCurrentSong()?.id || 0,
          temp_start_song_id: this.tempStartSongId,
          play_mode: this.playMode,
          // 临时歌手歌单要等索引就绪才由 restoreTempPlaylists 重建，重载续播覆盖不到它。
          // 锚点必须清空：否则 restoreFromConfig 会拿它去续播 playlist_id 里那个**旧**歌单。
          resume_state: '',
          resume_position_sec: 0,
          resume_at_ms: 0,
          resume_song_id: 0,
          resume_seek_offset_sec: 0,
        });
      } catch (e) {
        songloft.log.warn('[PlaylistManager] Failed to persist temp artist: ' + String(e));
      }
      return;
    }
    try {
      await this.configManager.updateDevice(this.accountId, this.deviceId, {
        playlist_id: this.playlistId,
        current_song_index: this.currentIndex,
        play_mode: this.playMode,
        temp_artist: '',
        temp_artist_exact: false,
        temp_song_id: 0,
        temp_start_song_id: 0,
        ...anchor,
      });
    } catch (e) {
      songloft.log.warn('[PlaylistManager] Failed to persist state: ' + String(e));
    }
    await this.persistPlaylistProgress();
  }

  /**
   * 记录「本歌单最后播到哪一首」。
   *
   * 上面写的 DeviceConfig 只有一个歌单槽位，切歌单就被覆盖；这里按歌单单独存一份，
   * 于是切走再切回来时每个歌单都能回到自己上次的位置（语音「播放歌单X」、定时任务
   * `start_position=resume`、网页「继续播放」三条路都读它）。
   *
   * 挂在 persistState 里而不是各调用点：persistState 是 play / pause / stop / next /
   * previous / 自动切歌的唯一收口，跟着它走就不会有哪条路漏记。
   * 停止态也照记（要的就是「停在哪首」），只是曲内位置归零。
   */
  private async persistPlaylistProgress(): Promise<void> {
    const song = this.getCurrentSong();
    if (!song || song.id <= 0 || this.playlistId <= 0) return;
    let positionSec = 0;
    if (this.state === 'playing') {
      positionSec = Math.max(0, Math.floor(this.getPosition()));
    } else if (this.state === 'paused') {
      positionSec = Math.max(0, Math.floor(this.pausedPositionSec));
    }
    try {
      await this.configManager.savePlaylistProgress(
        playlistProgressScope(this.accountId, this.deviceId),
        {
          playlist_id: this.playlistId,
          song_id: song.id,
          song_index: this.currentIndex,
          position_sec: positionSec,
          updated_at: Date.now(),
        },
      );
    } catch (e) {
      songloft.log.warn('[PlaylistManager] Failed to persist playlist progress: ' + String(e));
    }
  }

  /**
   * 插件重载后按持久化锚点把播放接回来。
   *
   * 背景：热重载销毁 JS 环境时，自动切歌定时器一起消失，而音箱那条流还在放。
   * 旧实现只恢复歌单和索引（注释里写着"不自动播放"），于是当前这首放完后没有任何人
   * 推进队列，用户听到的就是"播着播着突然停了"（songloft-org/songloft-plugin-miot#96）。
   *
   * 三种情况分开处理：
   *   1. 音箱还在放我们那条流 → **只把定时器接回来**，一个设备指令都不发，听感完全无缝。
   *      这是自动更新场景下的绝大多数情况（重载只花一秒左右）。
   *   2. 设备状态查不到（网络抖动）→ 按外推位置重建定时器。宁可少一次干预，
   *      也不要把好端端在放的歌打断重推。
   *   3. 音箱确实停了 / 在放别的媒体 → 带外推位置重推我们的 URL。
   *
   * 外推位置已超过曲末时不特殊处理：交给 resetAutoNextTimer，它对 remaining<=0 会
   * 立即触发一次正常的自动切歌，播放模式语义（顺序/随机/单曲）由既有逻辑负责。
   */
  async resumeAfterReload(anchor: {
    state: string;
    positionSec: number;
    atMs: number;
    songId: number;
    seekOffsetSec: number;
  }): Promise<void> {
    if (this.externalPlayback) return;
    return this.trackPlayback(() => this.resumeAfterReloadInternal(anchor));
  }

  private async resumeAfterReloadInternal(anchor: {
    state: string;
    positionSec: number;
    atMs: number;
    songId: number;
    seekOffsetSec: number;
  }): Promise<void> {
    const epoch = this.playbackEpoch;
    const song = this.getCurrentSong();
    if (!song || song.id !== anchor.songId) {
      return;
    }

    // 锚点太旧说明中间隔了很久（例如服务重启后过了几小时才有人访问），不该再把音箱叫起来
    const ageMs = Date.now() - anchor.atMs;
    if (anchor.atMs <= 0 || ageMs < 0 || ageMs > RESUME_ANCHOR_MAX_AGE_MS) {
      return;
    }

    this.streamSeekOffsetSec = anchor.seekOffsetSec;

    if (anchor.state === 'paused') {
      // 暂停态不碰设备，只把状态摆回去，让网页进度条和「继续播放」按钮行为正确。
      // 刻意不持久化 hardStopped：重载后它归零，若当时其实是「暂停被设备升级成 stop」，
      // 续播会先走裸 play 这条路。那条路有 verifyResumeOrRepush 兜底（约 2.4 秒后带 seek
      // 重推 URL），代价是慢一点而不是续不上，不值得为它多加一个持久化字段。
      this.state = 'paused';
      this.pausedPositionSec = anchor.positionSec;
      songloft.log.info(`[PlaylistManager] Restored paused state after reload position=${anchor.positionSec.toFixed(1)}s song=${song.title}`);
      return;
    }
    if (anchor.state !== 'playing') {
      return;
    }

    // 重载耗掉的墙钟时间要按倍速换算成曲内秒
    const estimated = anchor.positionSec + (ageMs / 1000) * this.playbackSpeed;
    this.state = 'playing';
    this.playStartTimeMs = Date.now() - (estimated / this.playbackSpeed) * 1000;

    if (song.duration <= 0) {
      // duration==0：重载后无法按曲长注册定时器，改启动设备流长探测兜底（#437）。
      // 探测首轮读到设备流长后由 resetAutoNextTimer 按 device position 重锚并注册定时器。
      songloft.log.info(`[PlaylistManager] Resume after reload: duration unknown, starting device duration probe at ${estimated.toFixed(1)}s song=${song.title}`);
      this.scheduleDurationProbe();
      return;
    }

    const deviceState = await this.minaService.getPlayState(this.accountId, this.deviceId);
    if (this.externalPlayback || epoch !== this.playbackEpoch) return;
    this.recordDevicePosition(deviceState);
    if (deviceState.status < 0) {
      songloft.log.warn(`[PlaylistManager] Resume after reload: device status unavailable, rebuilding timer at ${estimated.toFixed(1)}s`);
      this.resetAutoNextTimer(estimated, false);
      return;
    }

    if (deviceState.status === 1 && this.matchDeviceStream(deviceState) !== 'foreign') {
      this.playbackConfirmed = true;
      // 设备实测位置优先（它才知道缓冲耗了多久）；没上报就用外推值
      const devicePosition = deviceState.position > 0
        ? deviceState.position * this.playbackSpeed + this.streamSeekOffsetSec
        : estimated;
      songloft.log.info(`[PlaylistManager] Resume after reload: our stream still playing, timer taken over at ${devicePosition.toFixed(1)}s song=${song.title}`);
      this.resetAutoNextTimer(devicePosition, deviceState.hasPosition && deviceState.position > 0);
      return;
    }

    if (estimated >= song.duration) {
      songloft.log.info(`[PlaylistManager] Resume after reload: song already finished during reload (estimated=${estimated.toFixed(1)}s/${song.duration}s), advancing`);
      this.resetAutoNextTimer(estimated, false);
      return;
    }

    songloft.log.info(`[PlaylistManager] Resume after reload: device not playing our stream (status=${deviceState.status} deviceDuration=${deviceState.duration}s), re-pushing seek=${estimated.toFixed(1)}s song=${song.title}`);
    const ok = await this.playCurrent({ seekSeconds: estimated, skipAnnouncement: true });
    if (!ok) {
      songloft.log.warn('[PlaylistManager] Resume after reload failed, staying stopped');
      this.state = 'stopped';
      this.playStartTimeMs = 0;
      // 与 advanceToNext 的失败收尾同源：重推失败可能是 3012 假失败且核实漏判（#98），
      // 留一张外部恢复兜底网，别让重载后的一次下发失败变成永久停摆。
      this.startResumePoll();
    }
  }
}

// ===== PlaylistManagerMap - 多设备播放管理器集合 =====

/**
 * PlaylistManagerMap - 管理多个设备的播放管理器实例
 * key格式: "accountId:deviceId"
 */
export class PlaylistManagerMap {
  // key: 分组用 'grp:<groupId>'，独立设备用 '<accountId>:<deviceId>'。一个分组共用一个 manager。
  private managers: Map<string, PlaylistManager> = new Map();
  // 分组快照（仅含 ≥2 成员的组）：同步可读，避免 get()/getOrCreate 每次读存储、也避免惰性索引过期。
  // 由 refreshGroups() 在启动与分组增删改时刷新。
  private groupsSnapshot: DeviceGroup[] = [];
  private minaService: MinaService;
  private configManager: ConfigManager;

  constructor(minaService: MinaService, configManager: ConfigManager) {
    this.minaService = minaService;
    this.configManager = configManager;
  }

  /**
   * 刷新分组快照（启动时与分组增删改后调用）。除更新快照外，还处理因成员归属变化而失效的 manager：
   * - 组 manager（key=groupId，无冒号）：组已删除/成员<2 → 清理；主设备仍是成员首位 → 刷新成员列表；
   *   主设备变化（首位换人/被移出，primary 不可变）→ 清理待重建。
   * - 独立 manager（key='acct:dev'，含冒号）：其设备现已并入某组 → 清理（交给共享 manager，避免双份定时器）。
   * 说明：组 manager 的 key 即 groupId（形如 'grp_<ts>_<rand>'，不含冒号），与独立 key 靠是否含冒号区分，
   *      不会与 account_id 恰为某值时的独立 key 冲突。
   */
  async refreshGroups(): Promise<void> {
    try {
      const groups = await this.configManager.getDeviceGroups();
      this.groupsSnapshot = groups.filter(g => g.members && g.members.length >= 2);
    } catch (e) {
      songloft.log.warn('[PlaylistManagerMap] refreshGroups failed: ' + String(e));
      return;
    }
    for (const [key, manager] of Array.from(this.managers.entries())) {
      if (!key.includes(':')) {
        // 组 manager：key 即 groupId
        const group = this.groupsSnapshot.find(g => g.id === key);
        if (!group) {
          manager.endExternalPlayback();
          manager.cleanup();
          this.managers.delete(key);
          continue;
        }
        const p = manager.getPrimary();
        const head = group.members[0];
        if (p.account_id === head.account_id && p.device_id === head.device_id) {
          manager.setTargets(group.members.slice()); // 主设备不变：仅刷新成员，保留播放状态
        } else {
          manager.endExternalPlayback();
          manager.cleanup(); // 主设备变了（primary 不可变）→ 丢弃，下次 getOrCreate 以新首位重建
          this.managers.delete(key);
        }
      } else {
        // 独立 manager：若其设备现已属某分组，则应由共享 manager 接管
        const p = manager.getPrimary();
        if (!this.resolveTargetSync(p.account_id, p.device_id).managerKey.includes(':')) {
          manager.endExternalPlayback();
          manager.cleanup();
          this.managers.delete(key);
        }
      }
    }
  }

  /**
   * 同步解析某设备应归属的 manager：在分组（≥2 成员）中则归属该组共享 manager（输出目标为全部成员，
   * 主设备取成员列表第一个）；否则为独立设备 manager（仅自身）。基于内存快照，无异步、无过期索引。
   * 组 manager 的 key 直接用 groupId（不含冒号），独立 key 为 'acct:dev'（含冒号），二者天然可区分。
   */
  private resolveTargetSync(accountId: string, deviceId: string): {
    managerKey: string;
    primary: DeviceTargetRef;
    targets: DeviceTargetRef[];
  } {
    const group = this.groupsSnapshot.find(g =>
      g.members.some(m => m.account_id === accountId && m.device_id === deviceId),
    );
    if (group) {
      return {
        managerKey: group.id,
        primary: group.members[0],
        targets: group.members.slice(),
      };
    }
    const self = { account_id: accountId, device_id: deviceId };
    return { managerKey: this.makeKey(accountId, deviceId), primary: self, targets: [self] };
  }

  /**
   * 获取或创建播放管理器。
   * 分组设备解析到该组共享的 manager（输出目标为组内全部音箱）；独立设备解析到自身 manager。
   * 若设备配置中存有 playlistId，则新建时自动恢复播放列表（不自动开始播放）。
   */
  async getOrCreate(accountId: string, deviceId: string): Promise<PlaylistManager> {
    const { managerKey, primary, targets } = this.resolveTargetSync(accountId, deviceId);

    const existing = this.managers.get(managerKey);
    if (existing) {
      existing.setTargets(targets); // 刷新成员（成员可能已变更）
      return existing;
    }

    // 组共享 manager 接管成员设备：清理这些设备遗留的独立 manager，避免重复定时器/双份队列
    if (!managerKey.includes(':')) {
      for (const t of targets) {
        const dk = this.makeKey(t.account_id, t.device_id);
        const stale = this.managers.get(dk);
        if (stale) {
          stale.endExternalPlayback();
          stale.cleanup();
          this.managers.delete(dk);
        }
      }
    }

    const manager = new PlaylistManager(primary.account_id, primary.device_id, this.minaService, this.configManager);
    manager.setTargets(targets);

    // 从主设备配置恢复播放列表状态（本身不发设备指令）
    const resumeAnchor = await this.restoreFromConfig(manager, primary.account_id, primary.device_id);

    // await 期间可能有并发 getOrCreate 建好了同 key，或 refreshGroups 令归属变化：以最新为准，
    // 避免返回「孤儿」实例造成双份驱动
    const concurrent = this.managers.get(managerKey);
    if (concurrent) {
      manager.endExternalPlayback();
      manager.cleanup();
      concurrent.setTargets(targets);
      return concurrent;
    }
    if (this.resolveTargetSync(accountId, deviceId).managerKey !== managerKey) {
      // 归属在 await 期间被改（分组增删改）→ 丢弃本实例，按最新归属重建
      manager.endExternalPlayback();
      manager.cleanup();
      return this.getOrCreate(accountId, deviceId);
    }
    this.managers.set(managerKey, manager);

    // 热重载后把播放接回来。装进 map 之后才做，确保只有「活着的」那个实例操作音箱。
    // 不 await：调用方（HTTP 请求 / 插件 onInit）不该为一次设备状态查询干等，
    // 且续播失败也不该让 getOrCreate 失败。必须自带 catch，否则游离 promise 抛出
    // 会变成 QuickJS 里的 unhandled rejection。
    if (resumeAnchor) {
      void manager.resumeAfterReload(resumeAnchor).catch(e => {
        songloft.log.warn('[PlaylistManagerMap] resumeAfterReload failed: ' + String(e));
      });
    }

    return manager;
  }

  /**
   * 解析某设备的「主设备」（分组设备返回组内首位，独立设备返回自身）。
   * 同步、无副作用，不会像 getOrCreate 那样建 manager；供只读查询（如歌单进度）定位作用域。
   */
  resolvePrimary(accountId: string, deviceId: string): DeviceTargetRef {
    return this.resolveTargetSync(accountId, deviceId).primary;
  }

  /**
   * 获取指定设备的管理器（不存在返回null）。基于分组快照同步解析，分组设备命中共享 manager。
   */
  get(accountId: string, deviceId: string): PlaylistManager | null {
    const { managerKey } = this.resolveTargetSync(accountId, deviceId);
    return this.managers.get(managerKey) ?? null;
  }

  /**
   * 移除管理器
   */
  remove(accountId: string, deviceId: string): void {
    const key = this.makeKey(accountId, deviceId);
    const manager = this.managers.get(key);
    if (manager) {
      manager.endExternalPlayback();
      manager.cleanup();
    }
    this.managers.delete(key);
  }

  /**
   * 清理所有管理器
   */
  cleanup(): void {
    for (const manager of this.managers.values()) {
      manager.endExternalPlayback();
      manager.cleanup();
    }
    this.managers.clear();
  }

  /**
   * 获取所有管理器的设备Key列表
   */
  keys(): string[] {
    return Array.from(this.managers.keys());
  }

  /** 对每个独立设备或共享分组只清除一次，不创建新的播放管理器。 */
  clearPlaybackFailures(): number {
    let cleared = 0;
    for (const manager of this.managers.values()) cleared += manager.clearPlaybackFailures();
    return cleared;
  }

  /** 作废配置关闭或新对话对应的整点续播，不创建管理器。 */
  cancelHourlyResumes(deviceId?: string): void {
    for (const manager of this.managers.values()) manager.cancelHourlyResume(deviceId);
  }

  /**
   * 是否有设备正在播放。
   * 供后端自动更新在热重载前询问：正在播放时重载会打断播放（QuickJS 环境连同
   * 自动切歌定时器一起销毁），因此让后端推迟到空闲时再重载。
   */
  busyReason(): string {
    const playing: string[] = [];
    for (const [key, manager] of this.managers.entries()) {
      if (manager.isPlaying()) {
        playing.push(key);
      }
    }
    return playing.length > 0 ? `playing on ${playing.join(', ')}` : '';
  }

  /** 通过 playlistId 查找 manager（用于临时歌单的歌曲列表查询） */
  findByPlaylistId(playlistId: number): PlaylistManager | null {
    for (const manager of this.managers.values()) {
      if (manager.getStatus().playlist_id === playlistId) {
        return manager;
      }
    }
    return null;
  }

  /** 返回所有活跃的临时歌单信息（供歌单列表接口追加） */
  getTempPlaylists(): { id: number; name: string; songCount: number }[] {
    const result: { id: number; name: string; songCount: number }[] = [];
    for (const manager of this.managers.values()) {
      const status = manager.getStatus();
      if (isTempPlaylistId(status.playlist_id) && status.playlist_name) {
        result.push({
          id: status.playlist_id,
          name: status.playlist_name,
          songCount: manager.getSongs().length,
        });
      }
    }
    return result;
  }

  // ===== 内部方法 =====

  private makeKey(accountId: string, deviceId: string): string {
    return accountId + ':' + deviceId;
  }

  /**
   * 从配置中恢复播放列表。
   *
   * 本方法只负责「把歌单和索引摆回原位」，不发任何设备指令。若配置里还留着有效的
   * 重载续播锚点，它作为返回值交给调用方——必须等 manager 真正被装进 map 之后才能执行，
   * 否则并发 getOrCreate 丢弃的「孤儿」实例也会去操作音箱（songloft-org/songloft-plugin-miot#96）。
   *
   * @returns 需要续播时返回锚点，否则返回 null
   */
  private async restoreFromConfig(manager: PlaylistManager, accountId: string, deviceId: string): Promise<{
    state: string;
    positionSec: number;
    atMs: number;
    songId: number;
    seekOffsetSec: number;
  } | null> {
    try {
      const devices = await this.configManager.getDevices(accountId);
      const devCfg = devices.find(d => d.device_id === deviceId);
      if (!devCfg) return null;

      // 检测临时歌手歌单：记录待恢复标记，等索引就绪后由 restoreTempPlaylists 完成
      const tempArtist = devCfg.temp_artist;
      if (tempArtist && typeof tempArtist === 'string' && tempArtist.trim()) {
        (manager as any).pendingTempArtist = tempArtist.trim();
        (manager as any).pendingTempArtistExact = devCfg.temp_artist_exact === true;
        (manager as any).pendingTempSongId = devCfg.temp_song_id || 0;
        (manager as any).pendingTempStartSongId = devCfg.temp_start_song_id || 0;
        songloft.log.info(`[PlaylistManagerMap] Pending temp artist restore: "${tempArtist}" for ${deviceId}`);
        return null;
      }

      if (!devCfg.playlist_id || devCfg.playlist_id <= 0) {
        return null;
      }

      // 使用 songloft.playlists.getSongs 桥接调用加载歌单歌曲
      let songs: Song[] = [];
      let sortBy = '';
      let sortOrder = '';
      try {
        const pl: any = await songloft.playlists.getById(devCfg.playlist_id);
        if (pl && pl.sort_by) {
          sortBy = pl.sort_by;
          sortOrder = pl.sort_order || 'asc';
        }
      } catch (e) {
        songloft.log.warn(`[PlaylistManagerMap] restoreFromConfig: getById for sort failed: ${String(e)}`);
      }
      try {
        const result = await songloft.playlists.getSongs(devCfg.playlist_id, { limit: 100000, sort: sortBy, order: sortOrder } as any);
        const desc = result ? (Array.isArray(result) ? String(result.length) : 'non-array') : 'null';
        songloft.log.info(`[PlaylistManagerMap] restoreFromConfig playlistId=${devCfg.playlist_id} sort=${sortBy} order=${sortOrder} songs=${desc}`);
        if (result && Array.isArray(result)) {
          songs = result as any;
        }
      } catch (e) {
        songloft.log.warn('[PlaylistManagerMap] Failed to load songs via bridge: ' + String(e));
      }

      if (songs.length > 0) {
        const startIndex = devCfg.current_song_index || 0;
        const playMode = normalizePlayMode(devCfg.play_mode);
        manager.initWithSongs(songs, startIndex, playMode, devCfg.playlist_id);
        // 恢复持久化的倍速（缺省 1.0）。仅设字段，不触发重推——恢复时本就不在播。
        const speed = typeof devCfg.play_speed === 'number' && devCfg.play_speed > 0
          ? Math.max(0.5, Math.min(2, devCfg.play_speed))
          : 1;
        (manager as any).playbackSpeed = speed;
        songloft.log.info(`[PlaylistManagerMap] Restored playlist from config playlistId=${devCfg.playlist_id} index=${startIndex} mode=${playMode} speed=${speed}`);

        const resumeState = devCfg.resume_state || '';
        if (resumeState === 'playing' || resumeState === 'paused') {
          return {
            state: resumeState,
            positionSec: devCfg.resume_position_sec || 0,
            atMs: devCfg.resume_at_ms || 0,
            songId: devCfg.resume_song_id || 0,
            seekOffsetSec: devCfg.resume_seek_offset_sec || 0,
          };
        }
      }
    } catch (e) {
      songloft.log.warn('[PlaylistManagerMap] Failed to restore playlist from config: ' + String(e));
    }
    return null;
  }

  /**
   * 索引就绪后调用：遍历所有 manager，完成待恢复的临时歌手歌单。
   * 从索引中搜索歌手歌曲，加载完整歌曲信息，初始化临时歌单（不自动播放）。
   */
  async restoreTempPlaylists(indexingManager: import('../indexing/manager').IndexingManager): Promise<void> {
    for (const [key, manager] of Array.from(this.managers.entries())) {
      const artist = (manager as any).pendingTempArtist;
      if (!artist) continue;
      const revision = manager.getPlaybackRevision();
      const isCurrent = () => (manager as any).pendingTempArtist === artist && manager.getPlaybackRevision() === revision;
      const exactArtist = (manager as any).pendingTempArtistExact === true;

      try {
        if (exactArtist) {
          const fullSongs = await indexingManager.loadLibrarySongsByArtist(artist, isCurrent);
          if (!isCurrent()) continue;
          const playMode = await this.getDevicePlayMode(manager);
          if (!isCurrent()) continue;
          if (fullSongs.length) {
            const startIndex = fullSongs.findIndex(song => song.id === (manager as any).pendingTempStartSongId);
            const queue = startIndex > 0
              ? [fullSongs[startIndex], ...fullSongs.filter((_, index) => index !== startIndex)] : fullSongs;
            manager.initWithTempArtist(queue, artist, playMode, (manager as any).pendingTempSongId, true);
          } else {
            (manager as any).pendingTempArtist = '';
          }
          continue;
        }
        const artistLocs = indexingManager.findSongsByArtist(artist);
        if (artistLocs.length === 0) {
          songloft.log.info(`[PlaylistManagerMap] restoreTempPlaylists: no songs for "${artist}", skipping`);
          (manager as any).pendingTempArtist = '';
          continue;
        }

        const byPlaylist = new Map<number, Set<number>>();
        for (const loc of artistLocs) {
          let ids = byPlaylist.get(loc.playlistId);
          if (!ids) { ids = new Set(); byPlaylist.set(loc.playlistId, ids); }
          ids.add(loc.songId);
        }

        const fullSongs: any[] = [];
        const seenIds = new Set<number>();
        for (const [plId, songIds] of byPlaylist) {
          try {
            const plSongs = await songloft.playlists.getSongs(plId, { limit: 100000 });
            if (!plSongs || !Array.isArray(plSongs)) continue;
            for (const s of plSongs) {
              if (songIds.has(s.id) && !seenIds.has(s.id)) {
                seenIds.add(s.id);
                fullSongs.push(s);
              }
            }
          } catch (e) {
            songloft.log.warn(`[PlaylistManagerMap] restoreTempPlaylists: failed to load playlist ${plId}: ${String(e)}`);
          }
        }

        if (fullSongs.length > 0) {
          const playMode = await this.getDevicePlayMode(manager);
          if (!isCurrent()) continue;
          manager.initWithTempArtist(fullSongs as any, artist, playMode, (manager as any).pendingTempSongId);
          songloft.log.info(`[PlaylistManagerMap] Restored temp artist "${artist}" with ${fullSongs.length} songs for ${key}`);
        } else {
          (manager as any).pendingTempArtist = '';
          songloft.log.info(`[PlaylistManagerMap] restoreTempPlaylists: no playable songs for "${artist}"`);
        }
      } catch (e) {
        songloft.log.warn(`[PlaylistManagerMap] restoreTempPlaylists error for "${artist}": ${String(e)}`);
        (manager as any).pendingTempArtist = '';
      }
    }
  }

  private async getDevicePlayMode(manager: PlaylistManager): Promise<PlayMode> {
    try {
      const p = manager.getPrimary();
      const devices = await this.configManager.getDevices(p.account_id);
      const devCfg = devices.find(d => d.device_id === p.device_id);
      return normalizePlayMode(devCfg?.play_mode, 'random');
    } catch {
      return 'random';
    }
  }
}
