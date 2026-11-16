import { callHostAPI } from "../utils/http";
import { isAllSongsPlaylist } from "../player/library_playlist";
import type { PlaylistManagerMap } from "../player/manager";

export async function playlistPage(
  id: number,
  query: Record<string, string>,
  managers: PlaylistManagerMap,
) {
  const limit = Math.min(
    200,
    Math.max(1, Math.floor(Number(query.limit) || 100)),
  );
  const offset = Math.max(0, Math.floor(Number(query.offset) || 0));
  const keyword = (query.keyword || "").trim();
  const args = `limit=${limit}&offset=${offset}&keyword=${encodeURIComponent(keyword)}`;
  let page: { songs: any[]; total: number };
  if (isAllSongsPlaylist(id)) {
    page = await callHostAPI(
      "GET",
      `/api/v1/songs?${args}&sort=id&order=asc&exclude_playlist_labels=none`,
    );
  } else if (id < 0) {
    const rows = managers.findByPlaylistId(id)?.getSongs() || [];
    const filtered = keyword
      ? rows.filter((song) =>
          [song.title, song.artist, song.album].some((value) =>
            String(value || "")
              .toLowerCase()
              .includes(keyword.toLowerCase()),
          ),
        )
      : rows;
    page = {
      songs: filtered.slice(offset, offset + limit),
      total: filtered.length,
    };
  } else {
    const playlist: any = await songloft.playlists.getById(id);
    page = await callHostAPI(
      "GET",
      `/api/v1/playlists/${id}/songs?${args}&sort=${encodeURIComponent(playlist?.sort_by || "position")}&order=${encodeURIComponent(playlist?.sort_order || "asc")}`,
    );
  }
  if (!Array.isArray(page?.songs)) throw new Error("Invalid song page");
  const next = offset + page.songs.length;
  return {
    songs: page.songs
      .filter((song) => !isAllSongsPlaylist(id) || song.type !== "radio")
      .map((song) => ({
        id: song.id,
        title: song.title,
        artist: song.artist,
        album: song.album,
        duration: song.duration,
        cover_url: song.cover_url,
        lyric_url: song.lyric_url,
        is_live: song.is_live,
      })),
    total: page.total,
    next_offset: next,
    has_more: page.songs.length > 0 && next < page.total,
  };
}
