// MIoT 智能音箱插件 - URL构造器
// 翻译自 Go 源码: plugins/songloft-plugin-xiaomi/player/url_builder.go

import { getHostBaseUrl } from '../utils/http';

function isLoopbackUrl(url: string): boolean {
  const protoIdx = url.indexOf('://');
  if (protoIdx < 0) return false;
  const rest = url.slice(protoIdx + 3);
  const slashIdx = rest.indexOf('/');
  const colonIdx = rest.indexOf(':');
  const host = rest.slice(0, slashIdx >= 0 ? Math.min(slashIdx, colonIdx >= 0 ? colonIdx : slashIdx) : (colonIdx >= 0 ? colonIdx : undefined)).toLowerCase();
  return host === 'localhost' || host.startsWith('127.') || host === '::1';
}

/** buildSongURL 的选项。baseUrl 见 buildSongURL 的 @param 说明。 */
export interface PlaybackURLOptions {
  forceMp3?: boolean;
  radioForceMp3?: boolean;
  normalize?: boolean;
  seekSeconds?: number;
  speed?: number;
  baseUrl?: string;
}

/**
 * 从插件配置推导播放 URL 选项（同步版，已经有 config 对象时用）。
 *
 * 所有把 URL 推给音箱的地方都必须经这里，不要各自手写读 config——独立歌曲直推路径
 * 当初就是漏了 force_mp3，音箱拿到不能解码的流后亮灯不出声
 * （songloft-org/songloft-plugin-miot#62）。
 */
export function playbackOptionsOf(
  config: { force_mp3?: boolean; radio_force_mp3?: boolean; volume_normalize?: boolean },
  extra?: { seekSeconds?: number; speed?: number },
): PlaybackURLOptions {
  return {
    forceMp3: !!config.force_mp3,
    radioForceMp3: !!config.radio_force_mp3,
    normalize: !!config.volume_normalize,
    seekSeconds: extra?.seekSeconds,
    speed: extra?.speed,
  };
}

/**
 * 从 ConfigManager 读取播放 URL 选项（异步版）。
 * 读配置失败按全 false：宁可播源格式，也不要因为读配置失败而播不出声。
 */
export async function playbackOptionsFromConfig(
  configManager: { getConfig(): Promise<any> },
  extra?: { seekSeconds?: number; speed?: number },
): Promise<PlaybackURLOptions> {
  try {
    return playbackOptionsOf(await configManager.getConfig(), extra);
  } catch (e) {
    songloft.log.warn('[URLBuilder] 读取播放选项失败，按源格式播放: ' + String(e));
    return { seekSeconds: extra?.seekSeconds, speed: extra?.speed };
  }
}

/**
 * URL构造器 - 构造歌曲和封面的播放URL
 */
export class URLBuilder {
  /**
   * 构造歌曲播放URL（带access_token认证）
   *
   * song.url 由后端提供。普通歌曲使用 /play，电台还可能使用 /play.flv 或 /play.m3u8。
   *
   * @param song 歌曲对象（需要 id 和 url 字段；type 用于电台转码判定）
   * @param options.forceMp3 是否追加 format=mp3 强制服务端转码（本地/网络歌曲）
   * @param options.radioForceMp3 通过 /play.mp3 让服务端把电台流实时转码为 MP3。
   * @param options.seekSeconds 从第 N 秒起播：追加 seek=N，服务端产出以该位置为开头的 MP3 流。
   *   音箱只会从头拉 URL，续播位置只能这样表达（songloft-org/songloft-plugin-miot#60）。
   *   电台（直播）无位置概念，自动忽略。
   * @param options.speed 播放倍速 [0.5, 2.0]，追加 speed=N，服务端用 ffmpeg atempo 滤镜实时变速
   *   不变调。1.0 或缺省不追加（避免给不支持的后端塞噪音参数）。电台、电台直播流无倍速概念，忽略。
   * @param options.baseUrl 覆盖服务器地址。默认用 getHostBaseUrl()（用户配的 server_host，
   *   那是给**音箱**访问用的局域网/公网地址）。插件自己要发请求时必须传本机 API 地址
   *   （getHostAPIBaseUrl()），否则外网部署下会变成一次 hairpin NAT 出网回环
   *   （songloft-org/songloft-plugin-miot#62 的 URL 体检就是这么失败的）。
   * @returns 播放 URL（相对路径会自动附加 access_token）
   */
  static async buildSongURL(song: {
    id?: number;
    url?: string;
    type?: string;
  }, options?: PlaybackURLOptions): Promise<string> {
    const songUrl = song.url || '';

    if (!songUrl) {
      return '';
    }

    // 外部 URL 直接返回
    if (songUrl.startsWith('http://') || songUrl.startsWith('https://')) {
      return songUrl;
    }

    // access_token 放在首位，供服务端还原 MiNA 下发时以 %20 分隔的附加选项。
    const serverHost = options?.baseUrl ?? getHostBaseUrl();
    const accessToken = await songloft.plugin.getToken();
    const radioForceMp3 = options?.radioForceMp3 && song.type === 'radio';
    const playPath = radioForceMp3
      ? songUrl.replace(/^(\/api\/v1\/songs\/\d+\/play)(?:\.flv|\.m3u8)?$/, '$1.mp3')
      : songUrl;
    const separator = playPath.includes('?') ? '&' : '?';
    let url = serverHost + playPath + separator + 'access_token=' + accessToken;
    if (!radioForceMp3 && options?.forceMp3) {
      url += '&format=mp3';
    }
    // 音量均衡：服务端 loudnorm 滤镜统一音量，需要转码（未指定 format 时服务端默认 mp3）。
    if (!radioForceMp3 && options?.normalize) {
      url += '&normalize=1';
      if (!options?.forceMp3) {
        url += '&format=mp3';
      }
    }
    // 起播位置：整数秒，避免小数点掺进上述「& 被替换成空格后按 k=v 还原」的解析。
    // 电台是直播流，服务端也会忽略，这里就不往 URL 里塞无效参数。
    const seek = Math.floor(options?.seekSeconds || 0);
    if (seek > 0 && song.type !== 'radio') {
      url += '&seek=' + seek;
    }
    // 倍速：同 seek 走服务端实时转码（atempo 滤镜）。1.0/缺省不追加，减少 URL 噪音，
    // 也避免给不支持 speed 参数的旧后端塞一个会被忽略但没必要存在的参数。电台忽略。
    const speed = options?.speed;
    if (speed && speed !== 1 && song.type !== 'radio') {
      url += '&speed=' + speed;
    }

    // 诊断：把音箱被指向的 host 落日志，配合后端是否出现 /songs/{id}/play 访问行，
    // 即可判定音箱是否真的拉到了该地址（songloft-org/songloft#405）。仅 host 基址，不含 token。
    if (!options?.baseUrl) {
      songloft.log.info('[URLBuilder] speaker play host=' + serverHost + ' loopback=' + isLoopbackUrl(url) + ' songId=' + (song.id ?? ''));
    }

    // 回环告警只对「给音箱用的地址」有意义；显式覆盖成本机地址时（插件自己发请求）回环是正常的。
    if (!options?.baseUrl && isLoopbackUrl(url)) {
      songloft.log.warn('[URLBuilder] 播放 URL 包含回环地址，MIoT 音箱无法访问。请在插件配置中设置正确的局域网地址（如 http://192.168.x.x:58091）');
    }

    return url;
  }
}
