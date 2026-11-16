export function volumeBounds(
  track: { top: number; height: number },
  root: { top: number },
  web: boolean,
) {
  // Native detail.y is plugin-page-relative; native boundingClientRect includes
  // the embedding host/status-bar offset. Web clientY already matches its rect.
  return { top: web ? track.top : track.top - root.top, height: track.height };
}
export function volumeFromY(y: number, top: number, height: number) {
  if (![y, top, height].every(Number.isFinite) || height <= 0) return null;
  return Math.round(Math.max(0, Math.min(1, 1 - (y - top) / height)) * 100);
}
// Buffer input while native measurement is pending. Only release commits;
// cancellation/unmount invalidates late measurements and duplicate mouse-up.
export function createVerticalDrag(
  measure: () => Promise<{ top: number; height: number }>,
  preview: (v: number) => void,
  commit: (v: number) => void,
) {
  let generation = 0,
    active = false,
    released = false;
  let bounds: { top: number; height: number } | null = null,
    y = 0;
  function apply() {
    if (!bounds) return;
    const value = volumeFromY(y, bounds.top, bounds.height);
    if (value === null) return;
    preview(value);
    if (released) {
      released = false;
      commit(value);
    }
  }
  return {
    start(value: number) {
      if (!Number.isFinite(value)) return;
      active = true;
      released = false;
      bounds = null;
      y = value;
      const token = ++generation;
      void measure()
        .then((rect) => {
          if (token === generation) {
            bounds = rect;
            apply();
          }
        })
        .catch(() => {
          if (token === generation) active = false;
        });
    },
    move(value: number) {
      if (active && Number.isFinite(value)) {
        y = value;
        apply();
      }
    },
    end(value?: number) {
      if (!active) return;
      if (value !== undefined && Number.isFinite(value)) y = value;
      active = false;
      released = true;
      apply();
    },
    cancel() {
      generation++;
      active = false;
      released = false;
      bounds = null;
    },
  };
}
