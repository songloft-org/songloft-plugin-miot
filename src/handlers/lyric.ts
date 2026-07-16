// MIoT 智能音箱插件 - 歌词代理 Handler
//
// 背景：主程序对 remote 歌曲即使暂无歌词也会返回 lyric_url（指向
// /api/v1/songs/{id}/lyric），用于触发歌词插件的懒搜索；当确实搜不到歌词时，
// 该端点按设计返回 404。若前端直接 fetch 这个 404，浏览器会把它记为网络错误
// 打到控制台（window.fetch 原生行为，JS 的 try/catch 无法抑制）。
//
// 本 handler 在插件后端代理该请求：把「无歌词」的 404 归一化为 200 空 payload，
// 前端只与本插件端点（始终 200）通信，从而消除控制台的 404 噪音，同时保持主程序
// 的 404-by-design 语义不变。

import { jsonResponse, parseQuery } from '@songloft/plugin-sdk';
import type { Router, HTTPRequest } from '@songloft/plugin-sdk';
import { callHostAPI } from '../utils/http';

interface HostLyricPayload {
  lyric?: string;
  tlyric?: string;
  rlyric?: string;
  lxlyric?: string;
}

/**
 * 注册歌词代理路由
 * GET /lyric?song_id=123 → 代理主程序 /api/v1/songs/{id}/lyric
 * 返回 { success: true, lyric, tlyric, rlyric, lxlyric }；无歌词/失败时 lyric 为空。
 */
export function registerLyricHandlers(router: Router): void {
  router.get('/lyric', async (req: HTTPRequest) => {
    const query = parseQuery(req.query);
    const songId = query.song_id;
    if (!songId) {
      return jsonResponse({ success: false, error: '缺少 song_id' }, 400);
    }

    try {
      const payload = await callHostAPI<HostLyricPayload>(
        'GET',
        `/api/v1/songs/${encodeURIComponent(songId)}/lyric`,
        undefined,
        { timeoutMs: 8000 },
      );
      return jsonResponse({
        success: true,
        lyric: payload?.lyric || '',
        tlyric: payload?.tlyric || '',
        rlyric: payload?.rlyric || '',
        lxlyric: payload?.lxlyric || '',
      });
    } catch (e: any) {
      // 404 表示该歌曲无歌词（主程序设计如此），静默归一化为空歌词。
      // 其他错误同样降级为空歌词以避免前端报错，但记录 warn 便于排查。
      const msg = String(e?.message || e);
      if (!/\b404\b/.test(msg)) {
        songloft.log.warn('[lyric] fetch lyric failed song_id=' + songId + ': ' + msg);
      }
      return jsonResponse({ success: true, lyric: '', tlyric: '', rlyric: '', lxlyric: '' });
    }
  });
}
