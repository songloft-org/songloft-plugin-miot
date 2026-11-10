/// <reference types="@songloft/plugin-sdk" />

// 固定虚拟身份：不占用数据库歌单，也不与设备临时队列的负数 ID 混用。
export const ALL_SONGS_PLAYLIST_ID = Number.MAX_SAFE_INTEGER;
export const ALL_SONGS_PLAYLIST_NAME = '全部歌曲';
const PAGE_SIZE = 1000;

export function isAllSongsPlaylist(id: number): boolean {
  return id === ALL_SONGS_PLAYLIST_ID;
}

export function allSongsPlaylist(songCount = 0) {
  return {
    id: ALL_SONGS_PLAYLIST_ID,
    name: ALL_SONGS_PLAYLIST_NAME,
    song_count: songCount,
    type: 'normal',
    is_virtual: true,
  };
}

/** 按稳定 ID 分页读取完整曲库；本地和网络歌曲都保留，电台不进入队列。 */
export async function loadAllSongs(isCurrent: () => boolean = () => true) {
  const songs: Awaited<ReturnType<typeof songloft.songs.list>> = [];
  for (let offset = 0; isCurrent(); offset += PAGE_SIZE) {
    const page = await songloft.songs.list({
      limit: PAGE_SIZE,
      offset,
      orderBy: 'id',
      order: 'asc',
    } as any);
    if (!isCurrent()) return [];
    if (!Array.isArray(page)) throw new Error('Invalid library songs response');
    songs.push(...page.filter((song) => song.type !== 'radio'));
    if (page.length < PAGE_SIZE) return songs;
  }
  return [];
}
