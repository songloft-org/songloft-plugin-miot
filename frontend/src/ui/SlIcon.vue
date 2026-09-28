<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{ name: string; size?: number; playerIcon?: boolean }>();

// 播放器图标：沿用自带 `material-icons-player.otf`，
// 收藏 favorite/favorite_border 为两个不同码点，无需依赖 FILL 变量轴即可区分填充/描边。
const playerIconCodePoints: Record<string, number> = {
  alarm: 0xf553,
  alarm_on: 0xf552,
  edit: 0xf6fb,
  equalizer: 0xf711,
  favorite: 0xe25b,
  favorite_border: 0xe25c,
  format_list_numbered: 0xf793,
  keyboard_arrow_down: 0xf82b,
  looks_one: 0xf19e,
  music_note: 0xf8ed,
  pause: 0xf0056,
  play_arrow: 0xf00a0,
  queue_music: 0xf00d0,
  repeat: 0xf00f7,
  repeat_one: 0xf00f6,
  schedule: 0xf012b,
  shuffle: 0xf0177,
  skip_next: 0xf0192,
  skip_previous: 0xf0193,
  stop: 0xf01dc,
  volume_down: 0xf0297,
  volume_mute: 0xf0298,
  volume_off: 0xf0299,
  volume_up: 0xf029a,
};

// 通用 UI 图标：子集自官方 Material Symbols Outlined，按码点渲染。
const uiIconCodePoints: Record<string, number> = {
  add: 0xe145,
  alarm: 0xe855,
  alarm_on: 0xe858,
  arrow_back: 0xe5c4,
  artist: 0xe01a,
  audio_file: 0xeb82,
  auto_awesome: 0xe65f,
  auto_fix_high: 0xe663,
  bedtime: 0xf159,
  campaign: 0xef49,
  check: 0xe668,
  chevron_right: 0xe5cc,
  close: 0xe5cd,
  construction: 0xea3c,
  database: 0xf20e,
  delete: 0xe92e,
  delete_sweep: 0xe16b,
  dns: 0xe875,
  download: 0xf090,
  edit: 0xf097,
  equalizer: 0xe01d,
  expand_less: 0xe5ce,
  expand_more: 0xe5cf,
  favorite: 0xe87e,
  favorite_border: 0xe87e,
  format_list_numbered: 0xe242,
  group: 0xea21,
  info: 0xe88e,
  key: 0xe73c,
  keyboard_arrow_down: 0xe313,
  label: 0xe893,
  link: 0xe250,
  login: 0xea77,
  looks_one: 0xe400,
  lyrics: 0xec0b,
  memory: 0xe322,
  mic: 0xe31d,
  music_note: 0xe405,
  my_location: 0xe55c,
  open_in_new: 0xe89e,
  pause: 0xe034,
  person_add: 0xea4d,
  play_arrow: 0xe037,
  qr_code_2: 0xe00a,
  queue_music: 0xe03d,
  record_voice_over: 0xe91f,
  refresh: 0xe5d5,
  remove: 0xe15b,
  repeat: 0xe040,
  repeat_one: 0xe041,
  restart_alt: 0xf053,
  save: 0xe161,
  schedule: 0xefd6,
  science: 0xea4b,
  search: 0xef7a,
  settings: 0xe8b8,
  shuffle: 0xe043,
  skip_next: 0xe044,
  skip_previous: 0xe045,
  speaker: 0xe32d,
  speaker_group: 0xe32e,
  stop: 0xe047,
  swap_horiz: 0xe8d4,
  terminal: 0xeb8e,
  timer: 0xe425,
  timer_off: 0xe426,
  volume_down: 0xe04d,
  volume_mute: 0xe04e,
  volume_off: 0xe04f,
  volume_up: 0xe050,
  warning: 0xf083,
};

const codePoint = computed(() => {
  const map = props.playerIcon ? playerIconCodePoints : uiIconCodePoints;
  return map[props.name];
});
const glyph = computed(() =>
  codePoint.value === undefined ? props.name : String.fromCodePoint(codePoint.value),
);
const fontClass = computed(() => (props.playerIcon ? 'sl-icon-material-player' : 'sl-icon-ui'));

const style = computed(() => {
  const value: Record<string, string> = {};
  if (props.size) value.fontSize = `${props.size}px`;
  return value;
});
</script>

<template>
  <span
    class="material-symbols-outlined sl-icon"
    :class="fontClass"
    aria-hidden="true"
    :style="style"
  >{{ glyph }}</span>
</template>
