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

/**
 * URL构造器 - 构造歌曲和封面的播放URL
 */
export class URLBuilder {
  /**
   * 构造歌曲播放URL（带access_token认证）
   *
   * 新架构(2026):后端 MarshalJSON 已统一处理 song.url 字段:
   * - 所有类型(local/remote/radio): /api/v1/songs/{id}/play
   *
   * @param song 歌曲对象（需要 id 和 url 字段；type 用于电台转码判定）
   * @param options.forceMp3 是否追加 format=mp3 强制服务端转码（本地/网络歌曲）
   * @param options.radioForceMp3 电台转码：仅对 type=radio 的歌曲追加 radio_transcode=mp3，
   *   让服务端把电台流实时转码为 MP3（部分音箱无法解码 AAC/HE-AAC 或不支持 HLS）。
   *   与 forceMp3 刻意分离，互不影响。
   * @returns 播放 URL（相对路径会自动附加 access_token）
   */
  static async buildSongURL(song: {
    id?: number;
    url?: string;
    type?: string;
  }, options?: { forceMp3?: boolean; radioForceMp3?: boolean }): Promise<string> {
    const songUrl = song.url || '';

    if (!songUrl) {
      return '';
    }

    // 外部 URL 直接返回
    if (songUrl.startsWith('http://') || songUrl.startsWith('https://')) {
      return songUrl;
    }

    // 相对路径（/api/v1/songs/{id}/play）需要附加 access_token。
    // 注意参数顺序：access_token 必须始终是第一个参数。部分音箱固件会把 URL 里的 & 替换成空格，
    // 导致后续参数被合并进 access_token 的值；服务端认证中间件（internal/middleware/auth.go）
    // 依赖「JWT 不含空格」按空格把 token 剥离、再逐个 k=v 还原后续参数。若把 access_token 挪到
    // 后面，这个还原前提就会被破坏。故 format / radio_transcode 等一律追加在 access_token 之后。
    const serverHost = getHostBaseUrl();
    const accessToken = await songloft.plugin.getToken();
    const separator = songUrl.includes('?') ? '&' : '?';
    let url = serverHost + songUrl + separator + 'access_token=' + accessToken;
    if (options?.forceMp3) {
      url += '&format=mp3';
    }
    // 电台转码只对电台生效：服务端 serveRadio 只认 radio_transcode，其他类型忽略此参数。
    if (options?.radioForceMp3 && song.type === 'radio') {
      url += '&radio_transcode=mp3';
    }

    if (isLoopbackUrl(url)) {
      songloft.log.warn('[URLBuilder] 播放 URL 包含回环地址，MIoT 音箱无法访问。请在插件配置中设置正确的局域网地址（如 http://192.168.x.x:58091）');
    }

    return url;
  }
}
