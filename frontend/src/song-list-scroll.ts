import { useEffect, useState } from "@lynx-js/react";

/** Keep the virtual window and explicit scroll requests separate from gestures. */
export function useSongListScroll({
  rowHeight,
  playlistId,
  search,
  ready,
}: {
  rowHeight: number;
  playlistId: string;
  search: string;
  ready: boolean;
}) {
  const [start, setStart] = useState(0);
  const [request, setRequest] = useState<{ top: number } | null>(null);

  useEffect(() => {
    setStart(0);
    setRequest({ top: 0 });
  }, [playlistId, search]);

  useEffect(() => {
    if (!ready || !request) return;
    // Run after the new rows/spacers commit. A fresh request also scrolls when
    // the destination equals the previous locate, after the user moved away.
    lynx
      .createSelectorQuery()
      .select("#miot-song-list")
      .invoke({
        method: "scrollTo",
        params: { index: 0, offset: request.top, smooth: false },
      })
      .exec();
  }, [request, ready]);

  return {
    start,
    onScroll(top: number) {
      setStart(Math.max(0, Math.floor(top / rowHeight) - 5));
    },
    locate(index: number) {
      setStart(Math.max(0, index - 5));
      setRequest({ top: Math.max(0, index * rowHeight - 120) });
    },
  };
}
