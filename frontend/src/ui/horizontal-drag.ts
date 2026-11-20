export function horizontalSliderBounds(
  track: { left: number; width: number },
  root: { left: number },
  web: boolean,
) {
  // Native touch detail.x is relative to the plugin page, while boundingClientRect
  // includes the host frame offset. Web clientX already shares the rect coordinate.
  return { left: web ? track.left : track.left - root.left, width: track.width };
}

export function horizontalSliderValue(
  x: number,
  left: number,
  width: number,
  min: number,
  max: number,
) {
  if (![x, left, width, min, max].every(Number.isFinite) || width <= 0) {
    return null;
  }
  const ratio = Math.max(0, Math.min(1, (x - left) / width));
  return min + ratio * (max - min);
}

export function createHorizontalDrag(
  measure: () => Promise<{ left: number; width: number }>,
  valueFromX: (x: number, bounds: { left: number; width: number }) => number | null,
  preview: (value: number) => void,
  commit: (value: number) => void,
) {
  let generation = 0;
  let active = false;
  let released = false;
  let bounds: { left: number; width: number } | null = null;
  let x = 0;

  function apply() {
    if (!bounds) return;
    const value = valueFromX(x, bounds);
    if (value === null) return;
    preview(value);
    if (released) {
      released = false;
      commit(value);
    }
  }

  return {
    start(nextX: number) {
      if (!Number.isFinite(nextX)) return;
      active = true;
      released = false;
      bounds = null;
      x = nextX;
      const token = ++generation;
      void measure()
        .then((nextBounds) => {
          if (token === generation) {
            bounds = nextBounds;
            apply();
          }
        })
        .catch(() => {
          if (token === generation) active = false;
        });
    },
    move(nextX: number) {
      if (active && Number.isFinite(nextX)) {
        x = nextX;
        apply();
      }
    },
    end(nextX?: number) {
      if (!active) return;
      if (nextX !== undefined && Number.isFinite(nextX)) x = nextX;
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
