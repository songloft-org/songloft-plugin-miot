import { ref } from "@vue/reactivity";
import { parseLrc } from "./lyrics";
import type { LyricLine } from "./lyrics";
export function createPlayerDetails(
  get: <T>(path: string) => Promise<T>,
  currentSongId: () => number | undefined,
  cache = new Map<number, LyricLine[]>(),
) {
  const lyrics = ref<LyricLine[]>([]),
    lyricLoading = ref(false),
    lyricError = ref(""),
    isFavorite = ref(false);
  let generation = 0;
  let favoriteRevision = 0;
  function setFavorite(value: boolean) {
    favoriteRevision++;
    isFavorite.value = value;
  }
  async function loadLyrics(id: number, current: number, refresh = false) {
    const cached = cache.get(id);
    if (!refresh && cached) {
      lyrics.value = cached;
      return;
    }
    lyricLoading.value = true;
    lyricError.value = "";
    try {
      const result = await get<Record<string, string>>(
        `/lyric?song_id=${id}${refresh ? "&refresh=1" : ""}`,
      );
      if (current !== generation || currentSongId() !== id) return;
      lyrics.value = parseLrc(
        String(
          result.lyric ||
            result.lxlyric ||
            result.tlyric ||
            result.rlyric ||
            "",
        ),
      );
      cache.set(id, lyrics.value);
    } catch {
      if (current === generation && currentSongId() === id)
        lyricError.value = "歌词获取失败，请重试";
    } finally {
      if (current === generation) lyricLoading.value = false;
    }
  }
  async function loadSongDetails(includeLyrics = true) {
    const current = ++generation,
      id = currentSongId();
    const favoriteRequest = ++favoriteRevision;
    lyrics.value = [];
    lyricError.value = "";
    lyricLoading.value = false;
    isFavorite.value = false;
    if (!id) return;
    await Promise.allSettled([
      ...(includeLyrics ? [loadLyrics(id, current)] : []),
      get<{ is_favorited: boolean }>(
        `/player/favorite/status?song_id=${id}`,
      ).then((result) => {
        if (
          current === generation &&
          currentSongId() === id &&
          favoriteRequest === favoriteRevision
        )
          isFavorite.value = result.is_favorited;
      }),
    ]);
  }
  function ensureLyrics() {
    const id = currentSongId();
    if (id && !lyricLoading.value && !lyricError.value && !lyrics.value.length)
      return loadLyrics(id, generation);
  }
  async function retryLyrics() {
    const id = currentSongId();
    if (id && !lyricLoading.value) await loadLyrics(id, generation, true);
  }
  function dispose() {
    generation++;
  }
  return {
    lyrics,
    lyricLoading,
    lyricError,
    isFavorite,
    loadSongDetails,
    ensureLyrics,
    retryLyrics,
    dispose,
    setFavorite,
  };
}
