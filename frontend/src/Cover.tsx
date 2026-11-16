import { useEffect, useRef, useState } from "@lynx-js/react";
import { invokeHost, onPush } from "@songloft/lynx-plugin-sdk";
import type { Song } from "./types";
let active = 0;
const queue: Array<() => void> = [];
function slot() {
  let released = false,
    granted = false;
  let grant: () => void;
  const ready = new Promise<void>((resolve) => {
    grant = () => {
      if (released) return;
      active++;
      granted = true;
      resolve();
    };
    if (active < 6) grant();
    else queue.push(grant);
  });
  return {
    ready,
    release() {
      if (released) return;
      released = true;
      if (granted) active--;
      else {
        const i = queue.indexOf(grant);
        if (i >= 0) queue.splice(i, 1);
      }
      if (active < 6) queue.shift()?.();
    },
  };
}
export function Cover({
  song,
  width = 96,
  className = "song-cover",
  blur,
  style,
}: {
  song?: Song | null;
  width?: number;
  className?: string;
  blur?: number;
  style?: Record<string, string | number>;
}) {
  const release = useRef<() => void>(() => {}),
    retries = useRef(0);
  useEffect(() => {
    retries.current = 0;
  }, [song?.id, song?.cover_url]);
  const [source, setSource] = useState(""),
    [nonce, setNonce] = useState(0),
    [failed, setFailed] = useState(false);
  useEffect(
    () =>
      onPush((event, raw) => {
        if (event !== "lifecycle") return;
        if (JSON.parse(String(raw)).state === "resumed") {
          retries.current = 0;
          setNonce((n) => n + 1);
        }
      }),
    [],
  );
  useEffect(() => {
    if (!song?.cover_url?.trim()) {
      setSource("");
      return;
    }
    let alive = true;
    const reservation = slot();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      clearTimeout(timer);
      reservation.release();
    };
    release.current = finish;
    setFailed(false);
    setSource("");
    void reservation.ready
      .then(async () => {
        if (!alive) return;
        timer = setTimeout(finish, 6000);
        let url = song.cover_url!.trim();
        if (/^\/?api\/v1\/songs\/\d+\/cover(?:\?|$)/.test(url)) {
          if (!url.startsWith("/")) url = "/" + url;
          const reply = await invokeHost("plugin", "resourceUrl", {
            path:
              url +
              (url.includes("?") ? "&" : "?") +
              "w=" +
              Math.max(1, Math.round(width)) +
              (nonce ? "&_r=" + nonce : ""),
          });
          url = reply.ok ? String(reply.data) : "";
        }
        // Data URLs and signed CDN URLs must remain byte-for-byte intact.
        if (alive) setSource(url);
        if (!url) finish();
      })
      .catch(finish);
    return () => {
      alive = false;
      finish();
    };
  }, [song?.id, song?.cover_url, width, nonce]);
  return (
    <view className={"cover-frame " + className} style={style}>
      {source && !failed ? (
        <image
          key={source + ":" + nonce}
          className="cover-image"
          src={source}
          mode="aspectFill"
          blur-radius={blur ? `${blur}px` : undefined}
          bindload={() => {
            retries.current = 0;
            release.current();
          }}
          binderror={() => {
            release.current();
            setFailed(true);
            if (retries.current++ < 2) setNonce((n) => n + 1);
          }}
        />
      ) : (
        <text className="cover-placeholder">♫</text>
      )}
    </view>
  );
}
