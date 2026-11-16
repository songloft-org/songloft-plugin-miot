import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from '@lynx-js/react';
import { openExternal } from './runtime';
import {
  effect,
  effectScope,
  isRef,
  proxyRefs,
  reactive,
  stop,
  watch as observe,
} from '@vue/reactivity';
export { computed, reactive, ref } from '@vue/reactivity';
export type { Ref, ComputedRef } from '@vue/reactivity';

// Keep the existing domain actions and observable drafts independent of rendering.
// React owns every element and mounts/disposes each reactive effect scope.
type Lifecycle = { mounted: Array<() => void>; unmounted: Array<() => void> };
let lifecycle: Lifecycle | null = null;
export function onMounted(callback: () => void) {
  lifecycle?.mounted.push(callback);
}
export function onUnmounted(callback: () => void) {
  lifecycle?.unmounted.push(callback);
}
export function nextTick(callback?: () => void) {
  return Promise.resolve().then(callback);
}
export function watch(source: any, callback: any, options: any = {}) {
  return observe(source, callback, {
    deep: options.deep,
    immediate: options.immediate,
  });
}
function traverse(value: any, seen = new Set<any>()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (isRef(value)) traverse(value.value, seen);
  else for (const key of Object.keys(value)) traverse(value[key], seen);
}
export function usePageState(component: any, props: any) {
  const [, update] = useState(0);
  const latest = useRef(props);
  latest.current = props;
  const instance = useMemo(() => {
    const scope = effectScope(),
      hooks: Lifecycle = { mounted: [], unmounted: [] };
    const input = reactive({ ...props });
    for (const [key, spec] of Object.entries(component.props || {}) as any) {
      if (input[key] === undefined && spec.default !== undefined)
        input[key] =
          typeof spec.default === 'function' && spec.type !== Function
            ? spec.default()
            : spec.default;
    }
    const before = lifecycle;
    lifecycle = hooks;
    let result: any;
    try {
      result = scope.run(() =>
        component.createState(input, {
          expose() {},
          emit(name: string, ...args: any[]) {
            const key =
              'on' +
              name.replace(
                /(^|[:-])([a-z])/g,
                (_: string, _a: string, b: string) => b.toUpperCase(),
              );
            latest.current[key]?.(...args);
          },
        }),
      );
    } finally {
      lifecycle = before;
    }
    const context = proxyRefs(
      reactive({ ...input, ...result, $slots: props.slots || {} }),
    );
    return { scope, hooks, context, input };
  }, []);
  useEffect(() => {
    Object.assign(instance.input, props);
    Object.assign(instance.context, props);
  }, [props]);
  useEffect(() => {
    let alive = true,
      queued = false,
      initial = true;
    const tracker = effect(() => {
      traverse(instance.context);
      if (!initial && !queued) {
        queued = true;
        void Promise.resolve().then(() => {
          queued = false;
          if (alive) update((n) => n + 1);
        });
      }
      initial = false;
    });
    for (const callback of instance.hooks.mounted) callback();
    return () => {
      alive = false;
      for (const callback of instance.hooks.unmounted) callback();
      stop(tracker);
      instance.scope.stop();
    };
  }, []);
  return instance.context;
}
export function classes(value: any): string {
  if (Array.isArray(value)) return value.map(classes).filter(Boolean).join(' ');
  if (value && typeof value === 'object')
    return Object.keys(value)
      .filter((key) => value[key])
      .join(' ');
  return value ? String(value) : '';
}
export function styleObject(value: any): any {
  if (typeof value !== 'string') return value;
  return Object.fromEntries(
    value
      .split(';')
      .filter((part) => part.includes(':'))
      .map((part) => {
        const index = part.indexOf(':');
        return [
          part
            .slice(0, index)
            .trim()
            .replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()),
          part.slice(index + 1).trim(),
        ];
      }),
  );
}
export function renderItems(value: any, render: (...args: any[]) => ReactNode) {
  if (typeof value === 'number')
    return Array.from({ length: value }, (_, i) => render(i + 1, i));
  if (Array.isArray(value))
    return value.map((item, index) => render(item, index));
  return Object.entries(value || {}).map(([key, item], index) =>
    render(item, key, index),
  );
}
export const DisabledContext = createContext(false);
export function NativeView({
  visible = true,
  button,
  disabled,
  bindtap,
  href,
  children,
  className,
  ...props
}: any) {
  const inherited = useContext(DisabledContext);
  if (!visible) return null;
  return (
    <DisabledContext.Provider value={!!disabled || inherited}>
      <view
        {...props}
        className={classes([
          className,
          button && 'native-button',
          disabled && 'disabled',
        ])}
        bindtap={
          disabled || inherited
            ? undefined
            : bindtap ||
              (href
                ? () => {
                    void openExternal(href).catch(() => {});
                  }
                : undefined)
        }
      >
        {children}
      </view>
    </DisabledContext.Provider>
  );
}
export function useObserved(...values: any[]) {
  const [, update] = useState(0);
  useEffect(() => {
    let alive = true,
      initial = true,
      queued = false;
    const tracker = effect(() => {
      values.forEach((value) => traverse(value));
      if (!initial && !queued) {
        queued = true;
        void Promise.resolve().then(() => {
          queued = false;
          if (alive) update((n) => n + 1);
        });
      }
      initial = false;
    });
    return () => {
      alive = false;
      stop(tracker);
    };
  }, values);
}

export function displayText(value: unknown) {
  return value == null ? '' : String(value);
}
