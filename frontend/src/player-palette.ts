import type { Song } from "./types";
export interface PlayerPalette {
  dominant: string;
  vibrant: string;
  darkMuted: string;
  onImage: string;
}
interface HSL {
  h: number;
  s: number;
  l: number;
}

function rgbToHex({ r, g, b }: { r: number; g: number; b: number }) {
  return (
    "#" +
    [r, g, b]
      .map((v) =>
        Math.round(Math.max(0, Math.min(255, v)))
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")
  );
}
function hslToHex({ h, s, l }: HSL): string {
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const section = (((h % 360) + 360) % 360) / 60;
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

function fnv1a32(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/** 与主程序一致：没有可读封面时，根据歌曲元数据生成稳定配色。 */
export function paletteFromMetadata(
  song: Song | null | undefined,
): PlayerPalette | null {
  if (!song) return null;
  const hue = fnv1a32(`${song.id}|${song.title}|${song.artist || ""}`) % 360;
  return {
    dominant: hslToHex({ h: hue, s: 0.5, l: 0.4 }),
    vibrant: hslToHex({ h: hue, s: 0.7, l: 0.5 }),
    darkMuted: hslToHex({ h: hue, s: 0.3, l: 0.2 }),
    onImage: "#ffffff",
  };
}
