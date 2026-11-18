import { useContext } from "@lynx-js/react";
import type { BlurViewProps } from "@lynx-js/types";
import { ThemeContext } from "./theme";

// The standalone Lynx Web fallback registers web-core's prefixed element.
declare module "@lynx-js/types" {
  interface IntrinsicElements {
    "x-blur-view": BlurViewProps;
  }
}

export function PopupMaterial({ captureTarget }: { captureTarget: string }) {
  const theme = useContext(ThemeContext);
  const platform = String(SystemInfo.platform).toLowerCase();
  const nativeBlur = parseInt(SystemInfo.engineVersion, 10) >= 4;
  const glass = platform === "ios" && parseInt(SystemInfo.osVersion, 10) >= 26;

  return (
    <>
      {platform === "web" ? (
        <x-blur-view
          className="popup-blur"
          blur-radius="20px"
          accessibility-element={false}
          event-through
        />
      ) : nativeBlur ? (
        <blur-view
          className="popup-blur"
          blur-radius="20px"
          blur-effect={glass ? "glass" : theme}
          glass-style={glass ? "regular" : undefined}
          android-capture-target={captureTarget}
          ios-user-interface-style={theme}
          accessibility-element={false}
          event-through
        />
      ) : null}
      <view
        className="popup-tint"
        accessibility-element={false}
        event-through
      />
    </>
  );
}
