import { useEffect, useMemo, useRef, useState } from "@lynx-js/react";
import { createVerticalDrag, volumeBounds } from "./vertical-drag";
let sequence = 0;
export function VerticalVolume({
  value,
  disabled,
  onPreview,
  onCommit,
}: {
  value: number;
  disabled?: boolean;
  onPreview: (v: number | null) => void;
  onCommit: (v: number) => void;
}) {
  const id = useRef(`volume-track-${++sequence}`);
  const callbacks = useRef({ onPreview, onCommit });
  callbacks.current = { onPreview, onCommit };
  const [draft, setDraft] = useState<number | null>(null);
  const web =
    typeof SystemInfo !== "undefined" &&
    String((SystemInfo as any).platform).toLowerCase() === "web";
  const pointerY = (event: any) =>
    Number(
      web
        ? (event.clientY ??
            event.touches?.[0]?.clientY ??
            event.changedTouches?.[0]?.clientY ??
            event.detail?.y)
        : (event.detail?.y ?? event.touches?.[0]?.clientY),
    );
  const measure = (selector: string) =>
    new Promise<{ top: number; height: number }>((resolve, reject) =>
      lynx
        .createSelectorQuery()
        .select(selector)
        .invoke({
          method: "boundingClientRect",
          success: resolve as any,
          fail: reject,
        })
        .exec(),
    );
  const drag = useMemo(
    () =>
      createVerticalDrag(
        () =>
          Promise.all([measure("#" + id.current), measure("#miot-app")]).then(
            ([track, root]) => volumeBounds(track, root, web),
          ),
        (v) => {
          setDraft(v);
          callbacks.current.onPreview(v);
        },
        (v) => {
          callbacks.current.onCommit(v);
          setDraft(null);
          callbacks.current.onPreview(null);
        },
      ),
    [],
  );
  useEffect(() => () => drag.cancel(), []);
  useEffect(() => {
    if (disabled) {
      drag.cancel();
      setDraft(null);
      onPreview(null);
    }
  }, [disabled]);
  return (
    <view
      id={id.current}
      flatten={false}
      className="volume-vertical"
      accessibility-role="adjustable"
      accessibility-label="设备音量"
      consume-slide-event={[[-180, 180]]}
      catchtouchstart={disabled ? undefined : (e) => drag.start(pointerY(e))}
      catchtouchmove={disabled ? undefined : (e) => drag.move(pointerY(e))}
      catchtouchend={disabled ? undefined : (e) => drag.end(pointerY(e))}
      catchtouchcancel={() => {
        drag.cancel();
        setDraft(null);
        onPreview(null);
      }}
      catchmousedown={disabled ? undefined : (e) => drag.start(pointerY(e))}
      catchmousemove={disabled ? undefined : (e) => drag.move(pointerY(e))}
      catchmouseup={disabled ? undefined : (e) => drag.end(pointerY(e))}
      global-bindmouseup={disabled ? undefined : () => drag.end()}
    >
      <view className="volume-vertical-track">
        <view
          className="volume-vertical-fill"
          style={{ height: `${draft ?? value}%` }}
        />
        <view
          className="volume-vertical-thumb"
          style={{ bottom: `${draft ?? value}%` }}
        />
      </view>
    </view>
  );
}
