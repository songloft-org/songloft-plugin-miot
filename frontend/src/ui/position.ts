export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}
export function placePopover(
  root: Rect,
  trigger: Rect,
  width: number,
  height: number,
  align: "center" | "start" | "end" = "center",
) {
  const margin = 8,
    gap = 6;
  width = Math.max(1, Math.min(width, root.width - margin * 2));
  const x = trigger.left - root.left,
    y = trigger.top - root.top;
  const above = Math.max(0, y - gap - margin);
  const below = Math.max(0, root.height - y - trigger.height - gap - margin);
  const upward = above >= height || above >= below;
  height = Math.max(1, Math.min(height, upward ? above : below));
  const offset = align === "start" ? 0 : align === "end" ? 1 : 0.5;
  const left = Math.max(
    margin,
    Math.min(x + (trigger.width - width) * offset, root.width - width - margin),
  );
  const top = Math.max(
    margin,
    Math.min(
      upward ? y - gap - height : y + trigger.height + gap,
      root.height - height - margin,
    ),
  );
  return {
    left: `${left}px`,
    top: `${top}px`,
    width: `${width}px`,
    height: `${height}px`,
    maxHeight: `${height}px`,
  };
}
function rect(selector: string): Promise<Rect> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("measurement timeout")),
      1000,
    );
    try {
      lynx
        .createSelectorQuery()
        .select(selector)
        .invoke({
          method: "boundingClientRect",
          success: (value: any) => {
            clearTimeout(timer);
            if (!(value?.width > 0 && value?.height > 0))
              return reject(new Error("unmeasured element"));
            resolve({
              left: value.left ?? value.x ?? 0,
              top: value.top ?? value.y ?? 0,
              width: value.width,
              height: value.height,
            });
          },
          fail: (error: any) => {
            clearTimeout(timer);
            reject(error);
          },
        })
        .exec();
    } catch (error) {
      clearTimeout(timer);
      reject(error);
    }
  });
}
export async function measurePopover(
  selector: string,
  width: number | null,
  height: number,
  align: "center" | "start" | "end" = "center",
) {
  const [root, trigger] = await Promise.all([
    rect("#miot-app"),
    rect(selector),
  ]);
  return placePopover(root, trigger, width ?? trigger.width, height, align);
}
