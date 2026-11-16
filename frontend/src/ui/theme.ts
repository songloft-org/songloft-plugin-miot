import { createContext } from "@lynx-js/react";
export const ThemeContext = createContext<"light" | "dark">("light");

export const CompactSettingsContext = createContext(false);
