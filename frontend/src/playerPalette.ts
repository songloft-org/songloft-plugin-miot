import type { CSSProperties } from 'vue';
import type { Song } from './types';

export interface PlayerPalette {
  dominant: string;
  vibrant: string;
  darkMuted: string;
  onImage: '#ffffff' | '#111111';
}

const PALETTE_SAMPLE_SIZE = 48;
const MAX_CACHE_SIZE = 20;
const paletteCache = new Map<string, PlayerPalette>();

interface RGB {
  r: number;
  g: number;
  b: number;
}

interface HSL {
  h: number;
  s: number;
  l: number;
}

interface Bucket {
  count: number;
  red: number;
  green: number;
  blue: number;
  saturation: number;
  luminance: number;
}

function clamp(value: number, min = 0, max = 1): number {
  return Math.min(max, Math.max(min, value));
}

function componentToHex(value: number): string {
  return Math.round(clamp(value, 0, 255)).toString(16).padStart(2, '0');
}

function rgbToHex(color: RGB): string {
  return `#${componentToHex(color.r)}${componentToHex(color.g)}${componentToHex(color.b)}`;
}

function rgbToHsl(color: RGB): HSL {
  const red = color.r / 255;
  const green = color.g / 255;
  const blue = color.b / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const delta = max - min;
  let hue = 0;

  if (delta > 0) {
    if (max === red) hue = ((green - blue) / delta) % 6;
    else if (max === green) hue = (blue - red) / delta + 2;
    else hue = (red - green) / delta + 4;
    hue *= 60;
    if (hue < 0) hue += 360;
  }

  const lightness = (max + min) / 2;
  const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1));
  return { h: hue, s: saturation, l: lightness };
}

function hslToHex({ h, s, l }: HSL): string {
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const section = ((h % 360) + 360) % 360 / 60;
  const x = chroma * (1 - Math.abs((section % 2) - 1));
  let red = 0;
  let green = 0;
  let blue = 0;

  if (section < 1) [red, green] = [chroma, x];
  else if (section < 2) [red, green] = [x, chroma];
  else if (section < 3) [green, blue] = [chroma, x];
  else if (section < 4) [green, blue] = [x, chroma];
  else if (section < 5) [red, blue] = [x, chroma];
  else [red, blue] = [chroma, x];

  const match = l - chroma / 2;
  return rgbToHex({
    r: (red + match) * 255,
    g: (green + match) * 255,
    b: (blue + match) * 255,
  });
}

function tune(color: RGB, saturation: number, lightness: number): string {
  const hsl = rgbToHsl(color);
  return hslToHex({
    h: hsl.h,
    s: clamp(Math.max(hsl.s, saturation)),
    l: clamp(lightness),
  });
}

function relativeLuminance(color: RGB): number {
  const channel = (value: number) => {
    const normalized = value / 255;
    return normalized <= 0.03928
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  return channel(color.r) * 0.2126 + channel(color.g) * 0.7152 + channel(color.b) * 0.0722;
}

function fnv1a32(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/** 与主程序一致：没有可读封面时，根据歌曲元数据生成稳定配色。 */
export function paletteFromMetadata(song: Song | null | undefined): PlayerPalette | null {
  if (!song) return null;
  const hue = fnv1a32(`${song.id}|${song.title}|${song.artist || ''}`) % 360;
  return {
    dominant: hslToHex({ h: hue, s: 0.5, l: 0.4 }),
    vibrant: hslToHex({ h: hue, s: 0.7, l: 0.5 }),
    darkMuted: hslToHex({ h: hue, s: 0.3, l: 0.2 }),
    onImage: '#ffffff',
  };
}

function paletteFromPixels(data: Uint8ClampedArray): PlayerPalette | null {
  const buckets = new Map<number, Bucket>();
  for (let index = 0; index < data.length; index += 16) {
    const alpha = data[index + 3] ?? 0;
    if (alpha < 160) continue;
    const color = { r: data[index] ?? 0, g: data[index + 1] ?? 0, b: data[index + 2] ?? 0 };
    const hsl = rgbToHsl(color);
    if (hsl.l < 0.04 || hsl.l > 0.96) continue;
    const key = ((color.r >> 4) << 8) | ((color.g >> 4) << 4) | (color.b >> 4);
    const bucket = buckets.get(key) || {
      count: 0,
      red: 0,
      green: 0,
      blue: 0,
      saturation: 0,
      luminance: 0,
    };
    bucket.count += 1;
    bucket.red += color.r;
    bucket.green += color.g;
    bucket.blue += color.b;
    bucket.saturation += hsl.s;
    bucket.luminance += hsl.l;
    buckets.set(key, bucket);
  }

  if (buckets.size === 0) return null;
  const candidates = [...buckets.values()].map((bucket) => ({
    color: {
      r: bucket.red / bucket.count,
      g: bucket.green / bucket.count,
      b: bucket.blue / bucket.count,
    },
    count: bucket.count,
    saturation: bucket.saturation / bucket.count,
    luminance: bucket.luminance / bucket.count,
  }));
  const dominant = candidates.reduce((best, item) => (
    item.count * (0.55 + item.saturation) > best.count * (0.55 + best.saturation) ? item : best
  ));
  const vibrant = candidates.reduce((best, item) => (
    item.saturation * Math.sqrt(item.count) > best.saturation * Math.sqrt(best.count) ? item : best
  ));
  const darkMuted = candidates.reduce((best, item) => {
    const score = item.count * (1.1 - item.saturation) * (1.05 - item.luminance);
    const bestScore = best.count * (1.1 - best.saturation) * (1.05 - best.luminance);
    return score > bestScore ? item : best;
  });

  return {
    dominant: tune(dominant.color, 0.42, clamp(rgbToHsl(dominant.color).l, 0.3, 0.5)),
    vibrant: tune(vibrant.color, 0.62, clamp(rgbToHsl(vibrant.color).l, 0.42, 0.58)),
    darkMuted: tune(darkMuted.color, 0.28, 0.2),
    onImage: relativeLuminance(darkMuted.color) > 0.5 ? '#111111' : '#ffffff',
  };
}

function remember(key: string, palette: PlayerPalette): PlayerPalette {
  paletteCache.delete(key);
  paletteCache.set(key, palette);
  while (paletteCache.size > MAX_CACHE_SIZE) {
    const oldest = paletteCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    paletteCache.delete(oldest);
  }
  return palette;
}

/** 从 48×48 封面缩略图取色；跨域或解码失败时返回 null，由调用方走元数据回退。 */
export async function extractCoverPalette(url: string): Promise<PlayerPalette | null> {
  if (!url || typeof document === 'undefined') return null;
  const cacheKey = url.replace(/([?&])_r=\d+(&|$)/, (_match, prefix: string, suffix: string) => (
    suffix ? prefix : ''
  ));
  const cached = paletteCache.get(cacheKey);
  if (cached) return remember(cacheKey, cached);

  try {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.decoding = 'async';
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('cover image load failed'));
      image.src = url;
    });

    const canvas = document.createElement('canvas');
    canvas.width = PALETTE_SAMPLE_SIZE;
    canvas.height = PALETTE_SAMPLE_SIZE;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return null;
    context.drawImage(image, 0, 0, PALETTE_SAMPLE_SIZE, PALETTE_SAMPLE_SIZE);
    const palette = paletteFromPixels(
      context.getImageData(0, 0, PALETTE_SAMPLE_SIZE, PALETTE_SAMPLE_SIZE).data,
    );
    return palette ? remember(cacheKey, palette) : null;
  } catch {
    return null;
  }
}

export function paletteStyle(palette: PlayerPalette | null): CSSProperties {
  if (!palette) return {};
  const darkForeground = palette.onImage === '#111111';
  return {
    '--player-palette-dominant': palette.dominant,
    '--player-palette-vibrant': palette.vibrant,
    '--player-palette-dark': palette.darkMuted,
    '--player-palette-on-image': palette.onImage,
    '--player-palette-on-image-muted': darkForeground
      ? 'rgba(17, 17, 17, .72)'
      : 'rgba(255, 255, 255, .72)',
    '--player-palette-on-image-faint': darkForeground
      ? 'rgba(17, 17, 17, .34)'
      : 'rgba(255, 255, 255, .34)',
  } as CSSProperties;
}
