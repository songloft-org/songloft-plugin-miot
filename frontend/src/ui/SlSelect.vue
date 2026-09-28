<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import type { SelectOption } from '../types';
import SlButton from './SlButton.vue';
import SlIcon from './SlIcon.vue';
import SlInput from './SlInput.vue';
import { nextSelectId, openSelect } from './selectState';

const props = withDefaults(
  defineProps<{
    modelValue: string;
    options: SelectOption[];
    placeholder?: string;
    ariaLabel?: string;
    allowEmpty?: boolean;
    disabled?: boolean;
    /**
     * 面板顶部显示搜索框，按关键词过滤选项（songloft-org/songloft#410）。
     * 走自绘面板；非 searchable 走原生 `<select>`，浏览器自带键入跳转。
     */
    searchable?: boolean;
    /** 搜索框占位文案。`ariaLabel` 是「选择歌单」这种动宾短语，拼进去会变「搜索选择歌单」。 */
    searchPlaceholder?: string;
  }>(),
  { placeholder: '请选择', allowEmpty: false, searchable: false, searchPlaceholder: '搜索' },
);
const emit = defineEmits<{ 'update:modelValue': [string] }>();
const wrapper = ref<HTMLElement | null>(null);
const panel = ref<HTMLElement | null>(null);
const panelStyle = ref<Record<string, string>>({});
const scrollStyle = ref<Record<string, string>>({});
const id = nextSelectId();
// positionPanel 内部滚动让位时置位，用来吞掉由此产生的 scroll 回调，避免自激
let repositioning = false;
const opened = computed(() => openSelect.value === id);
const label = computed(
  () => props.options.find((option) => option.value === props.modelValue)?.label || props.placeholder,
);

// 选项少到一屏能看完时，搜索框只是白占一行，在 APP 上还多一个误触输入法的入口。
const SEARCH_MIN_OPTIONS = 5;
const query = ref('');
const showSearch = computed(() => props.searchable && props.options.length > SEARCH_MIN_OPTIONS);
const keyword = computed(() => (showSearch.value ? query.value.trim().toLowerCase() : ''));
const filtered = computed(() =>
  keyword.value
    ? props.options.filter((option) =>
        // `||` 而不是 `??`：searchText 为空串时该回退到 label，否则这一项永远搜不到
        (option.searchText || option.label).toLowerCase().includes(keyword.value),
      )
    : props.options,
);
const rows = computed(() =>
  // 搜索中不再挂占位行：用户已经在找具体某一项了，"请选择"混在结果里只会干扰。
  props.allowEmpty && !keyword.value
    ? [{ value: '', label: props.placeholder }, ...filtered.value]
    : filtered.value,
);

const PANEL_MAX_H = 320;
// 与 style.css .sl-select-panel-search 的 height 必须一致：搜索行在滚动容器**外**，
// 面板总高和内层 maxHeight 都要按它让位。
const SEARCH_ROW_H = 48;
// .sl-select-panel 上下边框各 1px。desiredH 是面板**外**高，必须把边框算进去：
// 内层 maxHeight = height - PANEL_BORDER - searchH，少算这 2px 时哪怕只有 1 项，
// maxHeight 也会比内容需要的高度小 2px、溢出出滚动条（小屏 itemH=40 时必现）。
const PANEL_BORDER = 2;
// .sl-select-panel-scroll 的上下 padding 各 4px，是选项之外的固有高度。
const SCROLL_PAD = 8;
const PANEL_GAP = 4;
const VIEWPORT_EDGE = 8;
// 下方至少要放得下这么多项，才认为「向下展开」是有意义的
const MIN_ROWS_BELOW = 3;

// 逐级向上试着滚动，返回真正滚动了多少。刻意不用 getComputedStyle 判 overflow：
// 设置页真正的滚动容器是 .settings-scroll-body 而不是 documentElement，而「设了
// scrollTop 后值有没有变」这个判据不依赖引擎对 overflow 的计算值，更稳。
function scrollNearestBy(el: HTMLElement, delta: number): number {
  const candidates: HTMLElement[] = [];
  for (let node = el.parentElement; node; node = node.parentElement) candidates.push(node);
  candidates.push(document.documentElement, document.body);
  for (const node of candidates) {
    if (!node) continue;
    const before = node.scrollTop;
    node.scrollTop = before + delta;
    if (node.scrollTop !== before) return node.scrollTop - before;
  }
  return 0;
}

// 面板用 position: fixed + JS 坐标，逃逸滚动容器裁切。
//
// allowScroll 只在「刚打开」时为 true：APP 里插件视口只有 ~520 逻辑 px 高（宿主
// appbar + 底部导航吃掉其余），表单靠下的下拉一定满足 spaceBelow < 320，旧逻辑会
// 无条件翻到上方、把整个表单盖住，看起来就是「列表飘在控件上面」
// （songloft-org/songloft-plugin-miot#80）。所以这里先滚动让出下方空间再定位。
// 面板打开期间的 resize/scroll 重定位传 false —— 否则用户每次滚动都会被我们反向
// 拽回去，跟手势打架。
function positionPanel(allowScroll = false): void {
  const el = wrapper.value;
  if (!el) return;
  const itemH = window.innerWidth < 600 ? 40 : 44;
  const searchH = showSearch.value ? SEARCH_ROW_H : 0;
  const desiredH = Math.min(
    PANEL_MAX_H,
    Math.max(itemH, rows.value.length * itemH + SCROLL_PAD) + searchH + PANEL_BORDER,
  );
  const minBelowH = Math.min(desiredH, itemH * MIN_ROWS_BELOW + SCROLL_PAD + searchH + PANEL_BORDER);

  let rect = el.getBoundingClientRect();
  // 播放条 fixed 在视口底部时要从可用空间中扣掉（songloft-org/songloft#432）
  const playerBar = document.querySelector<HTMLElement>('.player-bar-shell');
  const bottomEdge = playerBar ? playerBar.getBoundingClientRect().top : window.innerHeight;
  let spaceBelow = bottomEdge - rect.bottom - PANEL_GAP - VIEWPORT_EDGE;
  if (allowScroll && spaceBelow < minBelowH) {
    // 滚动会触发已注册的 scroll 监听 → handleViewportChange → positionPanel，挡掉自激
    repositioning = true;
    try {
      if (scrollNearestBy(el, minBelowH - spaceBelow) > 0) {
        rect = el.getBoundingClientRect();
        spaceBelow = bottomEdge - rect.bottom - PANEL_GAP - VIEWPORT_EDGE;
      }
    } finally {
      repositioning = false;
    }
  }
  const spaceAbove = rect.top - PANEL_GAP - VIEWPORT_EDGE;
  const placeBelow = spaceBelow >= minBelowH || spaceBelow >= spaceAbove;
  // 高度必须夹到该侧真实可用空间：旧逻辑恒用 320，超出的部分要么被视口裁掉、
  // 要么盖住上方内容
  // 下界必须把搜索行算进去。否则空间被挤到极小时（小屏 + 输入法弹起）height 会被钳到
  // itemH，内层的 `height - 2 - searchH` 变负数 —— 负 max-height 是无效声明、会被忽略，
  // 内层回落到 style.css 里的 318px，再被外层 overflow:hidden 裁掉，选项既看不见也滚不到。
  // searchH 为 0 时与原来的 Math.max(itemH, ...) 完全等价。
  const height = Math.max(itemH + searchH, Math.min(desiredH, placeBelow ? spaceBelow : spaceAbove));
  const top = placeBelow
    ? rect.bottom + PANEL_GAP
    : Math.max(VIEWPORT_EDGE, rect.top - height - PANEL_GAP);
  const left = Math.max(
    VIEWPORT_EDGE,
    Math.min(rect.left, window.innerWidth - rect.width - VIEWPORT_EDGE),
  );
  panelStyle.value = {
    left: `${Math.round(left)}px`,
    top: `${Math.round(top)}px`,
    width: `${Math.round(rect.width)}px`,
  };
  // 高度给内层滚动容器，不能给 fixed 的外层（见 style.css .sl-select-panel 注释）。
  // 减 PANEL_BORDER 是外层的上下边框、再减搜索行。desiredH 已把边框算进面板外高，
  // 这里减回去后 maxHeight 恰好等于「选项 + 滚动容器 padding」，1 项也不会溢出出滚动条。
  scrollStyle.value = { maxHeight: `${Math.round(height) - PANEL_BORDER - searchH}px` };
}

function toggle() {
  if (props.disabled) return;
  if (opened.value) {
    openSelect.value = null;
    return;
  }
  // 每次打开都从空关键词开始。搜索框本体随面板 v-if 销毁重建，所以只需复位这个 ref
  // ——不必像 SlInput 的 inputKey 那样强行重建原生输入框。
  query.value = '';
  openSelect.value = id;
  nextTick(() => positionPanel(true));
}
function select(value: string) {
  openSelect.value = null;
  query.value = '';
  emit('update:modelValue', value);
}

// 点外部 / Esc 关闭：自绘下拉需要这些处理，打开后点别处面板才会消失。
function onPointerDown(event: PointerEvent) {
  if (!opened.value) return;
  const target = event.target as Node | null;
  if (wrapper.value?.contains(target) || panel.value?.contains(target)) return;
  openSelect.value = null;
}
function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && opened.value) openSelect.value = null;
}
function handleViewportChange() {
  if (!opened.value || repositioning) return;
  positionPanel(false);
}
// scroll 不冒泡，但 window 上的 capture 监听照样能收到后代元素的 scroll。面板内部
// 滚动不该触发重定位：位置本来就没变，白跑一次还会跟滚动手势抖动。
// 单独一个 handler 而不是在 handleViewportChange 里判 target —— resize 的 target 是
// window，不是 Node，喂给 contains() 不安全。
function onViewportScroll(event: Event) {
  const target = event.target as Node | null;
  if (target && panel.value?.contains(target)) return;
  handleViewportChange();
}

// 过滤后行数变了要重算高度：向上展开的面板若不重定位，`top` 还按旧的高行数算，
// 面板与触发器之间会裂开一道空隙。传 false —— 这里不能再去抢用户的滚动位置。
watch(keyword, () => {
  if (!opened.value) return;
  void nextTick(() => positionPanel(false));
});
watch(opened, (isOpen) => {
  if (isOpen) {
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeydown, true);
    window.addEventListener('resize', handleViewportChange);
    window.addEventListener('scroll', onViewportScroll, true);
  } else {
    document.removeEventListener('pointerdown', onPointerDown, true);
    document.removeEventListener('keydown', onKeydown, true);
    window.removeEventListener('resize', handleViewportChange);
    window.removeEventListener('scroll', onViewportScroll, true);
  }
});
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onPointerDown, true);
  document.removeEventListener('keydown', onKeydown, true);
  window.removeEventListener('resize', handleViewportChange);
  window.removeEventListener('scroll', onViewportScroll, true);
  if (openSelect.value === id) openSelect.value = null;
});
</script>

<template>
  <!-- searchable 的下拉走自绘面板：原生 `<select>` 塞不进搜索框，只有浏览器自带的
       「键入跳到首字母匹配项」，那是跳转而不是过滤，对中文歌单名基本不工作。
       代价：这几个下拉失去原生方向键选择与手机浏览器的系统选择器。

       条件用 `searchable` 而不是 `showSearch`：后者会让同一个下拉在选项数跨过 5 时
       在原生 select 与自绘面板之间来回换渲染分支、外观跳变。用 `searchable` 则规则
       完全对称 —— 选项少时同样是自绘面板、同样没有搜索行。 -->
  <div
    v-if="searchable"
    ref="wrapper"
    class="sl-select-wrap"
    :class="{ 'sl-select-wrap-open': opened }"
  >
    <SlButton
      :key="modelValue"
      class="sl-select-trigger"
      variant="tonal"
      :label="label"
      trailing-icon="expand_more"
      :disabled="disabled"
      @click="toggle"
    />
    <div
      v-if="opened"
      class="sl-select-backdrop"
      @click="openSelect = null"
    ></div>
    <div
      v-if="opened"
      ref="panel"
      class="sl-select-panel sl-select-panel-fixed"
      :style="panelStyle"
    >
      <!-- 刻意不 autofocus：打开下拉就调起输入法会把面板压缩到不便选择，
           旧版原生前端（static/js/playlist.js）也是这么权衡的。 -->
      <div v-if="showSearch" class="sl-select-panel-search">
        <SlIcon name="search" :size="18" />
        <SlInput
          :model-value="query"
          :placeholder="searchPlaceholder"
          :aria-label="searchPlaceholder"
          @update:model-value="(value) => (query = value)"
        />
      </div>
      <div
        class="sl-select-panel-scroll"
        role="listbox"
        :aria-label="ariaLabel || undefined"
        :style="scrollStyle"
      >
        <div
          v-for="option in rows"
          :key="option.value"
          class="sl-select-option"
          :class="{ 'sl-select-option-on': option.value === modelValue }"
          role="option"
          :aria-selected="option.value === modelValue"
          @click="select(option.value)"
        >
          {{ option.label }}
        </div>
        <div v-if="!rows.length" class="sl-select-empty">无匹配项</div>
      </div>
    </div>
  </div>
  <select
    v-else
    class="sl-select"
    :value="modelValue"
    :disabled="disabled"
    :aria-label="ariaLabel"
    @change="emit('update:modelValue', ($event.target as HTMLSelectElement).value)"
  >
    <option v-if="allowEmpty" value="">{{ placeholder }}</option>
    <option v-for="option in options" :key="option.value" :value="option.value">
      {{ option.label }}
    </option>
  </select>
</template>
