import { createContext } from "@lynx-js/react";
export const ThemeContext = createContext<"light" | "dark">("light");

export const CompactSettingsContext = createContext(false);

// Inline SVG content lives outside the Lynx CSS variable cascade.
export const themeColors = {
  light: {
    label: "#000000",
    muted: "#666670",
    accent: "#0088ff",
    onAccent: "#ffffff",
  },
  dark: {
    label: "#ffffff",
    muted: "#a1a1aa",
    accent: "#0091ff",
    onAccent: "#ffffff",
  },
} as const;
