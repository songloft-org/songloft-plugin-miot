import { computed, onMounted, onUnmounted, shallowRef } from 'vue';

interface MaterialInput {
  fill: string;
  dark: boolean;
  reduceTransparency: boolean;
  increaseContrast: boolean;
  blurSupported: boolean;
}

/** Preserve the host tint, with a floor for readable text over unknown content. */
export function resolvePlayerMaterial(input: MaterialInput): { fill: string; blur: boolean; } {
  const match = input.fill.trim().match(/^rgba\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\)$/);
  const values = match?.slice(1).map(Number);
  if (!values || values.some(value => !Number.isFinite(value))
    || values.slice(0, 3).some(value => value < 0 || value > 255) || values[3] < 0 || values[3] > 1) {
    return { fill: 'var(--md-surface)', blur: false };
  }
  const opaque = input.reduceTransparency || input.increaseContrast || !input.blurSupported;
  const alpha = opaque ? 1 : Math.max(values[3], input.dark ? .92 : .96);
  return { fill: `rgba(${values[0]}, ${values[1]}, ${values[2]}, ${alpha})`, blur: !opaque && alpha < 1 };
}

/** Event-driven only; all host/media observers live exactly as long as the bar. */
export function usePlayerMaterial() {
  const root = document.documentElement;
  const transparency = window.matchMedia('(prefers-reduced-transparency: reduce)');
  const contrast = window.matchMedia('(prefers-contrast: more)');
  const blurSupported = typeof CSS !== 'undefined'
    && (CSS.supports('backdrop-filter', 'blur(1px)') || CSS.supports('-webkit-backdrop-filter', 'blur(1px)'));
  function read() {
    const dark = root.getAttribute('data-theme') === 'dark';
    return {
      ...resolvePlayerMaterial({
        fill: getComputedStyle(root).getPropertyValue('--sl-theme-glass-fill'), dark, blurSupported,
        reduceTransparency: root.getAttribute('data-reduce-transparency') === 'true' || transparency.matches,
        increaseContrast: root.getAttribute('data-increase-contrast') === 'true' || contrast.matches,
      }),
      highlight: dark ? 'rgba(255, 255, 255, .15)' : 'rgba(255, 255, 255, .6)',
    };
  }
  const material = shallowRef(read());
  const update = () => { material.value = read(); };
  let observer: MutationObserver | null = null;
  const events = ['songloft-theme-change', 'songloft-color-scheme-change', 'songloft-theme-appearance-change'];
  function mediaListener(media: MediaQueryList, attach: boolean): void {
    if (typeof media.addEventListener === 'function') {
      if (attach) media.addEventListener('change', update);
      else media.removeEventListener('change', update);
    } else {
      if (attach) media.addListener(update);
      else media.removeListener(update);
    }
  }
  onMounted(() => {
    events.forEach(event => document.addEventListener(event, update));
    mediaListener(transparency, true);
    mediaListener(contrast, true);
    observer = new MutationObserver(update);
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme', 'data-reduce-transparency', 'data-increase-contrast', 'style'] });
    update();
  });
  onUnmounted(() => {
    observer?.disconnect();
    events.forEach(event => document.removeEventListener(event, update));
    mediaListener(transparency, false);
    mediaListener(contrast, false);
  });
  return computed(() => ({
    '--miot-player-fill': material.value.fill,
    '--miot-player-blur': material.value.blur ? 'blur(20px)' : 'none',
    '--miot-player-highlight': material.value.highlight,
  }));
}
