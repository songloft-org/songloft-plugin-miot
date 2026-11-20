import { readFileSync } from "node:fs";
import ts from "typescript";
export function controls({
  measurePopover = () => Promise.reject(),
  navigation = {},
  compactSettings = false,
} = {}) {
  const compactContext = {};
  const themeContext = {};
  const values = [];
  let cursor = 0;
  const counts = new Map();
  const pendingEffects = [];
  const hooks = {
    useContext(context) {
      cursor++;
      if (context === themeContext) return "light";
      return context === compactContext ? compactSettings : false;
    },
    useEffect(callback, deps) {
      const index = cursor++,
        old = values[index];
      if (
        !old ||
        !deps ||
        deps.some((value, i) => !Object.is(value, old.deps[i]))
      ) {
        values[index] = { deps };
        pendingEffects.push(() => {
          old?.cleanup?.();
          values[index].cleanup = callback();
        });
      }
    },
    useState(initial) {
      const key = cursor++;
      if (!(key in values)) values[key] = initial;
      return [
        values[key],
        (value) => {
          values[key] =
            typeof value === "function" ? value(values[key]) : value;
        },
      ];
    },
    useRef(initial) {
      const key = cursor++;
      return values[key] || (values[key] = { current: initial });
    },
  };
  const jsx = (type, props, key) => ({ type, props, key });
  const source = readFileSync(
    new URL("../src/ui/native.tsx", import.meta.url),
    "utf8",
  );
  const js = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      jsx: ts.JsxEmit.ReactJSX,
      jsxImportSource: "@lynx-js/react",
    },
  }).outputText;
  const exports = {};
  new Function("require", "exports", js)((name) => {
    if (name === "@lynx-js/react") return hooks;
    if (name === "@lynx-js/react/jsx-runtime") return { jsx, jsxs: jsx };
    if (name === "@lynx-js/lynx-ui-input")
      return { Input: "input", TextArea: "textarea" };
    if (name === "@lynx-js/lynx-ui-slider")
      return {
        SliderRoot: "slider",
        SliderTrack: "track",
        SliderIndicator: "indicator",
        SliderThumb: "thumb",
      };
    if (name === "../page-state")
      return { classes: (values) => values.filter(Boolean).join(" ") };
    if (name === "./icons") return { iconPaths: {}, lynxIcons: {} };
    if (name === "./Overlay") return { Overlay: "overlay" };
    if (name === "./PopupMaterial") return { PopupMaterial: "popup-material" };
    if (name === "./position") return { measurePopover };
    if (name === "./VerticalVolume")
      return { VerticalVolume: "vertical-volume" };
    if (name === "./horizontal-drag")
      return {
        createHorizontalDrag: () => ({ cancel() {} }),
        horizontalSliderBounds: () => ({ left: 0, width: 1 }),
        horizontalSliderValue: () => 0,
      };
    if (name === "@songloft/lynx-plugin-sdk")
      return { getTheme: () => "light" };
    if (name === "../runtime") return { navigation };
    if (name === "./theme")
      return {
        ThemeContext: themeContext,
        CompactSettingsContext: compactContext,
        themeColors: {
          light: { accent: "#0088ff", muted: "#666670", onAccent: "#ffffff" },
        },
      };
    if (name.endsWith("ai_headers")) return { parseAIHeaders: JSON.parse };
    throw new Error(name);
  }, exports);
  return {
    flushEffects() {
      for (const callback of pendingEffects.splice(0)) callback();
    },
    render(name, props) {
      cursor = 0;
      const result = exports[name](props);
      if (counts.has(name) && counts.get(name) !== cursor)
        throw new Error("hook order changed");
      counts.set(name, cursor);
      return result;
    },
  };
}
