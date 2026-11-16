import { createPortal, useMemo, type ReactNode } from "@lynx-js/react";

// Native scroll-views can clip fixed descendants or keep them in the parent's
// compositing layer. Every popup belongs beside the page, outside the scroller.
export function Overlay({ children }: { children: ReactNode }) {
  const target = useMemo(
    () => lynx.createSelectorQuery().select("#miot-app"),
    [],
  );
  // The runtime exposes a Preact VNode while ReactLynx JSX uses ReactNode types.
  return createPortal(children, target) as unknown as ReactNode;
}
