import { useContext, useEffect, useRef, useState } from "@lynx-js/react";
import { Input, TextArea } from "@lynx-js/lynx-ui-input";
import {
  SliderIndicator,
  SliderRoot,
  SliderThumb,
  SliderTrack,
} from "@lynx-js/lynx-ui-slider";
import { classes, DisabledContext } from "../page-state";
import { parseAIHeaders } from "../../../src/utils/ai_headers";
import { iconAscent, iconPaths, iconViewBox } from "./icons";
import { navigation } from "../runtime";
import { Overlay } from "./Overlay";
import { measurePopover } from "./position";
import { VerticalVolume } from "./VerticalVolume";
import { ThemeContext } from "./theme";

type Props = Record<string, any>;
let selectSequence = 0;
let buttonSequence = 0;
export function SlIcon({ name, size = 20, color: requestedColor }: Props) {
  const theme = useContext(ThemeContext);
  const color =
    requestedColor && requestedColor !== "primary" && requestedColor !== "muted"
      ? requestedColor
      : requestedColor === "muted"
        ? theme === "dark"
          ? "#C4C6D0"
          : "#44474E"
        : theme === "dark"
          ? "#0091FF"
          : "#0088FF";
  return (
    <svg
      className="sl-icon"
      event-through
      style={{ width: `${size}px`, height: `${size}px` }}
      content={`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${iconViewBox}"><path fill="${color}" transform="translate(0 ${iconAscent}) scale(1 -1)" d="${iconPaths[name] || iconPaths.info}"/></svg>`}
    />
  );
}
export function SlButton({
  label,
  icon,
  disabled,
  onClick,
  variant,
  children,
  ...props
}: Props) {
  const inheritedDisabled = useContext(DisabledContext);
  const theme = useContext(ThemeContext);
  const ownId = useRef(`miot-button-${++buttonSequence}`);
  disabled = disabled || inheritedDisabled;
  const kind = variant || (icon && !label ? "icon" : "text");
  return (
    <view
      id={props.id || ownId.current}
      className={classes([
        "sl-button",
        `sl-button-${kind}`,
        kind === "filled" && "filled",
        props.block && "sl-button-block",
        disabled && "disabled",
        props.className,
      ])}
      accessibility-label={props["aria-label"] || label || props.title}
      bindtap={
        disabled
          ? undefined
          : (event: any) => {
              if (props.popupTrigger)
                navigation.playerPopupAnchor = props.id || ownId.current;
              void onClick?.(event);
            }
      }
    >
      {icon && (
        <SlIcon
          name={icon}
          size={props.iconSize || (kind === "icon" ? 22 : 18)}
          color={
            props.iconColor ||
            (kind === "filled"
              ? theme === "dark"
                ? "#FFFFFF"
                : "#ffffff"
              : undefined)
          }
        />
      )}{" "}
      {label && kind !== "icon" && <text>{label}</text>}
      {children}
    </view>
  );
}
export function SlInput({
  modelValue = "",
  inputKey,
  disabled,
  type,
  placeholder,
  onUpdateModelValue,
  onChange,
  onSubmit,
  ...props
}: Props) {
  const inheritedDisabled = useContext(DisabledContext);
  disabled = disabled || inheritedDisabled;
  const focused = useRef(false),
    draft = useRef(String(modelValue)),
    committed = useRef(String(modelValue));
  const commit = () => {
    if (draft.current !== committed.current) {
      committed.current = draft.current;
      onChange?.();
    }
  };
  const [initial, setInitial] = useState(String(modelValue));
  useEffect(() => {
    if (!focused.current && String(modelValue) !== draft.current) {
      draft.current = String(modelValue);
      committed.current = String(modelValue);
      setInitial(String(modelValue));
    }
  }, [modelValue]);
  return (
    <Input
      key={inputKey ?? initial}
      className={classes(["sl-input", props.className])}
      style={props.style}
      accessibility-label={props["aria-label"] || props.ariaLabel}
      defaultValue={initial}
      readonly={disabled}
      type={type === "password" ? "password" : "text"}
      maxLength={Number(props.maxlength || 20000)}
      placeholder={placeholder || ""}
      onFocus={() => {
        focused.current = true;
      }}
      onInput={(value: string) => {
        focused.current = true;
        draft.current = value;
        onUpdateModelValue?.(value);
      }}
      onBlur={() => {
        focused.current = false;
        commit();
      }}
      onConfirm={() => {
        commit();
        onSubmit?.();
      }}
    />
  );
}
export function SlSwitch({
  modelValue,
  disabled,
  onUpdateModelValue,
  ...props
}: Props) {
  const inheritedDisabled = useContext(DisabledContext);
  disabled = disabled || inheritedDisabled;
  return (
    <view
      className={classes([
        "sl-switch",
        modelValue && "active",
        disabled && "disabled",
      ])}
      accessibility-role="switch"
      accessibility-label={props["aria-label"]}
      accessibility-checked={!!modelValue}
      bindtap={disabled ? undefined : () => onUpdateModelValue?.(!modelValue)}
    >
      <view className="switch-thumb" />
    </view>
  );
}
export function SlCheckbox(props: Props) {
  const inheritedDisabled = useContext(DisabledContext);
  const disabled = props.disabled || inheritedDisabled;
  return (
    <view
      className={classes(["sl-checkbox", props.modelValue && "active"])}
      bindtap={
        disabled
          ? undefined
          : () => props.onUpdateModelValue?.(!props.modelValue)
      }
    >
      <text>{props.modelValue ? "✓" : ""}</text>
    </view>
  );
}
export function SlSlider({
  modelValue = 0,
  min = 0,
  max = 100,
  disabled,
  onUpdateModelValue,
  onChange,
  onCommit,
  onDragStart,
  ...props
}: Props) {
  const inheritedDisabled = useContext(DisabledContext);
  disabled = disabled || inheritedDisabled;
  const [draft, setDraft] = useState<number | null>(null);
  const normalize = (ratio: number) =>
    Math.round(Number(min) + ratio * (Number(max) - Number(min)));
  return (
    <SliderRoot
      className="sl-slider"
      value={
        (Number(draft ?? modelValue) - Number(min)) /
        Math.max(1, Number(max) - Number(min))
      }
      disabled={disabled}
      step={1 / Math.max(1, Number(max) - Number(min))}
      onDragging={(ratio: number) => {
        if (draft === null) onDragStart?.();
        setDraft(normalize(ratio));
      }}
      onValueCommit={(ratio: number) => {
        const value = normalize(ratio);
        setDraft(null);
        onUpdateModelValue?.(value);
        onChange?.(value);
        onCommit?.(value);
      }}
    >
      <view className="slider-rail">
        <SliderTrack className="slider-track">
          <SliderIndicator className="slider-indicator" />
          <SliderThumb className="slider-thumb" />
        </SliderTrack>
      </view>
    </SliderRoot>
  );
}
export function SlSelect({
  modelValue,
  options = [],
  placeholder = "请选择",
  onUpdateModelValue,
  disabled,
  allowEmpty,
  searchable,
  searchPlaceholder,
  ...props
}: Props) {
  const inheritedDisabled = useContext(DisabledContext);
  disabled = disabled || inheritedDisabled;
  const [open, setOpen] = useState(false),
    [search, setSearch] = useState(""),
    [limit, setLimit] = useState(40);
  const triggerId = useRef(`miot-select-${++selectSequence}`);
  const [anchor, setAnchor] = useState<Record<string, string> | null>(null);
  const [placementReady, setPlacementReady] = useState(false);
  const measurement = useRef(0);
  function measureMenu() {
    const token = ++measurement.current;
    const height = Math.max(
      96,
      Math.min(
        320,
        (Math.min(options.length, 40) + (allowEmpty ? 1 : 0)) * 44 +
          (searchable ? 56 : 0) +
          8,
      ),
    );
    void measurePopover("#" + triggerId.current, null, height, true)
      .then((position) => {
        if (token === measurement.current) setAnchor(position);
      })
      .catch(() => {})
      .finally(() => {
        if (token === measurement.current) setPlacementReady(true);
      });
  }
  useEffect(
    () => () => {
      measurement.current++;
    },
    [],
  );
  const selected = options.find(
    (option: any) => String(option.value) === String(modelValue),
  );
  const filtered = options.filter((option: any) =>
    String(option.searchText || option.label)
      .toLowerCase()
      .includes(search.trim().toLowerCase()),
  );
  useEffect(() => {
    if (open) navigation.selectOpen = true;
    return () => {
      if (open) navigation.selectOpen = false;
    };
  }, [open]);
  useEffect(() => {
    if (!navigation.selectOpen) setOpen(false);
  });
  const close = () => {
    measurement.current++;
    navigation.selectOpen = false;
    setOpen(false);
  };
  return (
    <view className="sl-select-wrap">
      <view
        id={triggerId.current}
        className={classes(["sl-select", disabled && "disabled"])}
        bindtap={
          disabled
            ? undefined
            : () => {
                setOpen(true);
                setSearch("");
                setLimit(40);
                setAnchor(null);
                setPlacementReady(false);
                measureMenu();
              }
        }
      >
        {(props.leadingIcon || props["leading-icon"]) && (
          <SlIcon name={props.leadingIcon || props["leading-icon"]} />
        )}
        <text className="sl-select-label" text-maxline="1">
          {selected?.label || placeholder}
        </text>
        <SlIcon name="expand_more" color="muted" />
      </view>
      {open && placementReady && (
        <Overlay>
          <view
            flatten={false}
            className={classes([
              "modal-mask",
              "select-overlay",
              anchor && "select-mask",
            ])}
            catchtap={close}
          >
            <view
              flatten={false}
              className={classes(["modal-card", anchor && "select-popup"])}
              style={anchor || undefined}
              catchtap={() => {}}
            >
              {!anchor && (
                <text className="section-title">
                  {props["aria-label"] || placeholder}
                </text>
              )}
              {searchable && (
                <view className="select-search">
                  <SlIcon name="search" color="muted" size={18} />
                  <SlInput
                    modelValue={search}
                    aria-label={searchPlaceholder || "搜索选项"}
                    placeholder={searchPlaceholder || "搜索"}
                    onUpdateModelValue={(value: string) => {
                      setSearch(value);
                      setLimit(40);
                    }}
                  />
                </view>
              )}
              <scroll-view
                className="select-options"
                style={
                  anchor
                    ? {
                        height: `${Math.min(300, parseFloat(anchor.height) - (searchable ? 64 : 8))}px`,
                      }
                    : undefined
                }
                scroll-y
              >
                {allowEmpty && (
                  <SlButton
                    label="不选择"
                    onClick={() => {
                      onUpdateModelValue?.("");
                      close();
                    }}
                  />
                )}
                {filtered.slice(0, limit).map((option: any) => (
                  <view
                    key={option.value}
                    flatten={false}
                    className={classes([
                      "select-option",
                      String(option.value) === String(modelValue) && "selected",
                    ])}
                    catchtap={() => {
                      onUpdateModelValue?.(String(option.value));
                      close();
                    }}
                  >
                    <text>{option.label}</text>
                  </view>
                ))}
                {filtered.length > limit && (
                  <SlButton
                    label="显示更多"
                    onClick={() => setLimit((n) => n + 40)}
                  />
                )}
              </scroll-view>
              {!anchor && <SlButton label="取消" onClick={close} />}
            </view>
          </view>
        </Overlay>
      )}
    </view>
  );
}
export function SectionCard({
  title,
  icon,
  description,
  children,
  slots,
  tone,
}: Props) {
  return (
    <view className={classes(["miot-section", tone && `miot-section-${tone}`])}>
      <view className="section-heading">
        {icon && (
          <view className="section-heading-icon">
            <SlIcon name={icon} color="muted" />
          </view>
        )}
        <view className="section-heading-copy">
          <text className="section-title">{title}</text>
          {description && (
            <text className="section-description">{description}</text>
          )}
        </view>
        {slots?.actions}
      </view>
      <view className="card miot-card">{children}</view>
    </view>
  );
}
export function SettingRow({
  title,
  subtitle,
  children,
  slots,
  icon,
  stacked,
  disabled,
}: Props) {
  return (
    <view
      className={classes([
        "setting-row",
        stacked && "setting-row-stacked",
        disabled && "disabled",
      ])}
    >
      {(icon || slots?.leading) && (
        <view className="setting-row-leading">
          {slots?.leading || <SlIcon name={icon} color="muted" />}
        </view>
      )}
      <view className="setting-row-copy">
        <text className="setting-row-title">{title}</text>
        {subtitle && <text className="setting-row-subtitle">{subtitle}</text>}
        {slots?.detail}
      </view>
      <view className="setting-row-control">{children}</view>
    </view>
  );
}
export function SlDisclosure({
  title,
  description,
  children,
  icon,
  open: initial = false,
}: Props) {
  const [open, setOpen] = useState(initial);
  return (
    <view className="sl-disclosure">
      <view
        className="disclosure-heading"
        bindtap={() => setOpen((value) => !value)}
      >
        {icon && (
          <view className="sl-disclosure-icon">
            <SlIcon name={icon} size={19} color="muted" />
          </view>
        )}
        <view className="section-heading-copy" event-through>
          <text className="section-title">{title}</text>
          {description && (
            <text className="section-description">{description}</text>
          )}
        </view>
        <SlIcon name={open ? "expand_less" : "expand_more"} color="muted" />
      </view>
      {open && <view className="sl-disclosure-content">{children}</view>}
    </view>
  );
}
export function SlStatusChip({ label, tone }: Props) {
  return <text className={classes(["chip", tone])}>{label}</text>;
}
export function SlEmptyState({
  title,
  description,
  children,
  icon,
  compact,
}: Props) {
  return (
    <view
      className={classes(["empty-state", compact && "empty-state-compact"])}
    >
      {icon && (
        <view className="empty-state-icon">
          <SlIcon name={icon} size={36} color="muted" />
        </view>
      )}
      <text className="empty-state-title">{title}</text>
      {description && <text className="muted">{description}</text>}
      {children}
    </view>
  );
}
export function AIHeadersField(props: Props) {
  let error = "";
  try {
    parseAIHeaders(props.modelValue);
  } catch (cause) {
    error = String(cause);
  }
  return (
    <view className="field">
      <text>自定义请求头（JSON 对象）</text>
      <SlTextArea {...props} />
      {error && <text className="error">{error}</text>}
    </view>
  );
}

export function VolumeControl({ value, disabled, onChange }: Props) {
  const [preview, setPreview] = useState<number | null>(null);
  const previous = useRef(50);
  const shown = preview ?? value;
  return (
    <view className="volume-control">
      <text className="volume-value">{Math.round(shown)}%</text>
      <SlButton
        label="+"
        title="音量加5"
        disabled={disabled || shown >= 100}
        onClick={() => onChange(Math.min(100, Math.round(shown) + 5))}
      />
      <VerticalVolume
        value={shown}
        disabled={disabled}
        onPreview={setPreview}
        onCommit={onChange}
      />
      <SlButton
        label="−"
        title="音量减5"
        disabled={disabled || shown <= 0}
        onClick={() => onChange(Math.max(0, Math.round(shown) - 5))}
      />
      <SlButton
        variant="icon"
        icon={shown > 0 ? "volume_up" : "volume_off"}
        title={shown > 0 ? "静音" : "取消静音"}
        disabled={disabled}
        onClick={() => {
          if (shown > 0) {
            previous.current = shown;
            onChange(0);
          } else onChange(previous.current);
        }}
      />
    </view>
  );
}

export function SlTextArea(props: Props) {
  const disabled = useContext(DisabledContext) || props.disabled;
  const focused = useRef(false),
    draft = useRef(props.modelValue || ""),
    committed = useRef(props.modelValue || "");
  const [initial, setInitial] = useState(props.modelValue || "");
  useEffect(() => {
    if (!focused.current && props.modelValue !== draft.current) {
      draft.current = props.modelValue || "";
      committed.current = draft.current;
      setInitial(draft.current);
    }
  }, [props.modelValue]);
  // Keep native editing local: echoing each background-thread update through
  // value can overwrite newer keystrokes before the next render arrives.
  return (
    <view className="sl-textarea-shell">
      <TextArea
        key={initial}
        className="sl-textarea"
        defaultValue={initial}
        readonly={disabled}
        maxLength={Number(props.maxlength || 20000)}
        placeholder={props.placeholder || ""}
        onInput={(value: string) => {
          focused.current = true;
          draft.current = value;
          props.onUpdateModelValue?.(value);
        }}
        onFocus={() => {
          focused.current = true;
        }}
        onBlur={(value: string) => {
          focused.current = false;
          if (value !== committed.current) {
            committed.current = value;
            props.onChange?.();
          }
        }}
      />
    </view>
  );
}
