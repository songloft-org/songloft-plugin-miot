import { useEffect, useRef, useState } from "@lynx-js/react";
import { getGlobalProps, invokeHost, onPush } from "@songloft/lynx-plugin-sdk";
import type { Song } from "./types";
import { SlIcon } from "./ui/native";

// A virtual row can be unmounted while its bitmap is still in the native cache.
// Keep successfully loaded addresses so remounting never paints a false fallback.
const loadedSources = new Map<string, string>();
const MAX_LOADED_SOURCES = 256;
const MAX_SOURCE_LENGTH = 8192;
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
export function CoverPlaceholder() {
  return (
    <view className="cover-placeholder">
      <SlIcon name="music_note" size={24} color="muted" />
    </view>
  );
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
  const path = song?.cover_url?.trim() || "";
  const key = JSON.stringify([
    String((getGlobalProps() as Record<string, unknown>).serverUrl || ""),
    song?.id,
    path,
    width,
  ]);
  const cachedSource = path.startsWith("data:")
    ? path
    : loadedSources.get(key) || "";
  const sourceOwner = useRef(key),
    currentKey = useRef(key);
  currentKey.current = key;
  const release = useRef<() => void>(() => {}),
    retries = useRef(0),
    needsRecovery = useRef(false);
  useEffect(() => {
    retries.current = 0;
  }, [song?.id, song?.cover_url]);
  const [source, setSource] = useState(cachedSource),
    [nonce, setNonce] = useState(0),
    [failed, setFailed] = useState(false);
  const currentSource = sourceOwner.current === key ? source : cachedSource;
  const currentFailed = sourceOwner.current === key && failed;
  useEffect(
    () =>
      onPush((event, raw) => {
        if (event !== "lifecycle") return;
        if (
          JSON.parse(String(raw)).state === "resumed" &&
          needsRecovery.current
        ) {
          needsRecovery.current = false;
          retries.current = 0;
          setNonce((n) => n + 1);
        }
      }),
    [],
  );
  useEffect(() => {
    needsRecovery.current = false;
    const sameSource = sourceOwner.current === key;
    sourceOwner.current = key;
    if (!path) {
      setSource("");
      setFailed(false);
      return;
    }
    if (cachedSource && nonce === 0) {
      setSource(cachedSource);
      setFailed(false);
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
    if (!sameSource || failed) setSource("");
    void reservation.ready
      .then(async () => {
        if (!alive) return;
        timer = setTimeout(() => {
          needsRecovery.current = true;
          finish();
        }, 6000);
        let url = path;
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
        if (!alive) return;
        setSource(url);
        if (!url) {
          needsRecovery.current = true;
          setFailed(true);
          finish();
        }
      })
      .catch(() => {
        if (alive) {
          needsRecovery.current = true;
          setFailed(true);
        }
        finish();
      });
    return () => {
      alive = false;
      finish();
    };
  }, [key, nonce]);
  return (
    <view className={"cover-frame " + className} style={style}>
      {currentSource && !currentFailed ? (
        <image
          key={currentSource + ":" + nonce}
          className="cover-image"
          src={currentSource}
          mode="aspectFill"
          blur-radius={blur ? `${blur}px` : undefined}
          bindload={() => {
            if (currentKey.current !== key) return;
            if (
              !currentSource.startsWith("data:") &&
              currentSource.length <= MAX_SOURCE_LENGTH
            ) {
              loadedSources.delete(key);
              loadedSources.set(key, currentSource);
              if (loadedSources.size > MAX_LOADED_SOURCES)
                loadedSources.delete(loadedSources.keys().next().value!);
            }
            needsRecovery.current = false;
            retries.current = 0;
            release.current();
          }}
          binderror={() => {
            if (currentKey.current !== key) return;
            if (loadedSources.get(key) === currentSource)
              loadedSources.delete(key);
            needsRecovery.current = true;
            release.current();
            const retry = retries.current++ < 2;
            setFailed(!retry);
            if (retry) {
              setSource("");
              setNonce((n) => n + 1);
            }
          }}
        />
      ) : !path || currentFailed ? (
        <CoverPlaceholder />
      ) : null}
    </view>
  );
}
