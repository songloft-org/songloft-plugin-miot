<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import SectionCard from '../../ui/SectionCard.vue';
import SettingRow from '../../ui/SettingRow.vue';
import SlButton from '../../ui/SlButton.vue';
import SlCheckbox from '../../ui/SlCheckbox.vue';
import SlInput from '../../ui/SlInput.vue';
import SlSelect from '../../ui/SlSelect.vue';
import SlSlider from '../../ui/SlSlider.vue';
import SlSwitch from '../../ui/SlSwitch.vue';
import SlDisclosure from '../../ui/SlDisclosure.vue';
import SlEmptyState from '../../ui/SlEmptyState.vue';
import { get } from '../../api';
import { navigation } from '../../runtime';
import { confirmAction, deleteSchedule, loadScheduleLogs, loadSchedules, managedDevices, messageOf, notify, playlistLabel, saveConfig, saveSchedule, state, toggleSchedule } from '../../store';
import { openSelect } from '../../ui/selectState';
import type { ScheduleType, ScheduledTask, SelectOption, Song } from '../../types';

const editor = ref(false);
const editingId = ref('');
const name = ref('');
const action = ref('play_playlist');
const playlistId = ref('');
const songId = ref('');
const playMode = ref('');
const startPosition = ref('first');
const volume = ref(50);
// 预设播放音量：只在 play_playlist(_from) 用；开关关闭时不带 volume 参数，保持原有行为
const presetVolumeEnabled = ref(false);
// 播放时长（分钟，字符串以配合 SlInput 的 v-model）；空串或 0 表示不启用
// 有效范围 1-999，与 voiceEngine.setSleepTimer('time') 对齐
const stopAfterMinutes = ref('');
const scheduleType = ref<ScheduleType>('weekly');
const time = ref('08:00');
const weekdays = ref<number[]>([1, 2, 3, 4, 5]);
const monthdays = ref<number[]>([1]);
const holidayMode = ref('ignore');
const allManaged = ref(true);
const targetMembers = ref<string[]>([]);

const actionOptions: SelectOption[] = [
  { value: 'play_playlist', label: '播放歌单' },
  { value: 'play_playlist_from', label: '播放歌单（指定位置）' },
  { value: 'stop', label: '停止播放' },
  { value: 'set_play_mode', label: '设置播放模式' },
  { value: 'set_volume', label: '设置音量' },
  { value: 'enable_monitor', label: '开启对话监听' },
  { value: 'disable_monitor', label: '关闭对话监听' },
];
const typeOptions: SelectOption[] = [{ value: 'weekly', label: '每周' }, { value: 'monthly', label: '每月' }];
const modeOptions: SelectOption[] = [{ value: '', label: '跟随上次设置' }, { value: 'order', label: '顺序播放' }, { value: 'loop', label: '列表循环' }, { value: 'single', label: '单曲循环' }, { value: 'random', label: '随机播放' }, { value: 'singlePlay', label: '单曲播放' }];
const positionOptions: SelectOption[] = [{ value: 'first', label: '从第一首开始' }, { value: 'resume', label: '从上次进度继续' }, { value: 'random', label: '随机位置' }];
// 全局动作（不绑定设备）：编辑器隐藏目标设备区，提交时 target 走 all_managed 占位，后端跳过设备校验
const globalActions = ['enable_monitor', 'disable_monitor'];
const isGlobalAction = computed(() => globalActions.includes(action.value));
function actionLabel(value: string) { return actionOptions.find((option) => option.value === value)?.label || value; }
const playlistOptions = computed(() => state.playlists.map((playlist) => ({ value: String(playlist.id), label: playlistLabel(playlist), searchText: playlist.name })));
// 编辑器里正在编辑任务对应的歌单曲目，独立于主页 state.songs 存取：
// 主页 selectPlaylist() 拉取的是「用户当前浏览的歌单」，与定时任务里选的可能是两个歌单，
// 直接复用会让「起始歌曲」下拉一直显示主页那个歌单的曲子（songloft-org/songloft#473）。
const editorSongs = ref<Song[]>([]);
const editorSongsLoading = ref(false);
let editorSongsRequest = 0;
async function loadEditorSongs(id: string) {
  editorSongsRequest += 1;
  const request = editorSongsRequest;
  if (!id) {
    editorSongs.value = [];
    editorSongsLoading.value = false;
    return;
  }
  editorSongsLoading.value = true;
  try {
    const songs = await get<Song[]>(`/playlists/${encodeURIComponent(id)}/songs`);
    if (request === editorSongsRequest) editorSongs.value = songs || [];
  } catch (error) {
    if (request === editorSongsRequest) { editorSongs.value = []; notify(messageOf(error), 'error'); }
  } finally {
    if (request === editorSongsRequest) editorSongsLoading.value = false;
  }
}
// 用户在编辑器里切换歌单：清掉之前那首起始歌曲、按新歌单重取候选。
// 不用 watch(playlistId)：editTask 回填时需要保留任务里保存的 song_id，
// watch 上加一次性跳过标志在「重编辑同一任务导致 playlistId 未变」时会残留脏状态。
function onPlaylistChange(next: string) {
  playlistId.value = next;
  songId.value = '';
  void loadEditorSongs(next);
}
const songOptions = computed(() => editorSongs.value.map((song) => ({ value: String(song.id), label: `${song.title}${song.artist ? ` · ${song.artist}` : ''}` })));

onMounted(() => { void Promise.all([loadSchedules(), loadScheduleLogs()]); });
watch(editor, (open) => { navigation.editorOpen = open; if (!open) openSelect.value = null; });
// consumeBack() 置 navigation.editorOpen = false 时反向同步，确保编辑器真正关闭
watch(() => navigation.editorOpen, (open) => { if (!open && editor.value) editor.value = false; });
function resetEditor() { editingId.value = ''; name.value = ''; action.value = 'play_playlist'; playlistId.value = ''; songId.value = ''; playMode.value = ''; startPosition.value = 'first'; volume.value = 50; presetVolumeEnabled.value = false; stopAfterMinutes.value = ''; scheduleType.value = 'weekly'; time.value = '08:00'; weekdays.value = [1, 2, 3, 4, 5]; monthdays.value = [1]; holidayMode.value = 'ignore'; allManaged.value = true; targetMembers.value = []; editorSongs.value = []; editor.value = true; }
function editTask(task: ScheduledTask) {
  editingId.value = task.id || '';
  name.value = task.name;
  action.value = task.action;
  playlistId.value = String(task.params.playlist_id || '');
  songId.value = String(task.params.song_id || '');
  playMode.value = String(task.params.play_mode || '');
  startPosition.value = String(task.params.start_position || 'first');
  volume.value = Number(task.params.volume ?? 50);
  // 预设音量开关：仅在播放动作 + 参数里存有 volume 时视为开启；set_volume 动作沿用 volume 但不打开开关
  const isPlayAction = task.action === 'play_playlist' || task.action === 'play_playlist_from';
  presetVolumeEnabled.value = isPlayAction && typeof task.params.volume === 'number';
  stopAfterMinutes.value = typeof task.params.stop_after_minutes === 'number' && task.params.stop_after_minutes > 0
    ? String(task.params.stop_after_minutes)
    : '';
  scheduleType.value = task.schedule.type;
  time.value = task.schedule.time;
  weekdays.value = [...(task.schedule.weekdays || [])];
  monthdays.value = [...(task.schedule.monthdays || [])];
  holidayMode.value = task.schedule.holiday_mode || 'ignore';
  allManaged.value = !!task.target.all_managed;
  targetMembers.value = (task.target.devices || []).map((item) => `${item.account_id}:${item.device_id}`);
  void loadEditorSongs(playlistId.value);
  editor.value = true;
}
function toggleDay(list: number[], day: number) { const index = list.indexOf(day); if (index >= 0) list.splice(index, 1); else list.push(day); }
function targetDevices() { return targetMembers.value.map((value) => { const [account_id, device_id] = value.split(':'); return { account_id, device_id }; }); }
async function saveCurrent() {
  // 全局动作不绑定设备也不需要参数：切换动作前残留的歌单/歌曲/播放模式一律不带上
  const global = isGlobalAction.value;
  const isPlayAction = action.value === 'play_playlist' || action.value === 'play_playlist_from';
  // 播放时长仅播放动作可用；范围与 voiceEngine.setSleepTimer('time') 的 1-999 对齐
  const stopMinutesRaw = Number.parseInt(String(stopAfterMinutes.value).trim(), 10);
  const stopMinutes = isPlayAction && Number.isFinite(stopMinutesRaw) && stopMinutesRaw >= 1 && stopMinutesRaw <= 999
    ? stopMinutesRaw
    : 0;
  const task: ScheduledTask = {
    id: editingId.value || undefined,
    name: name.value.trim(),
    enabled: true,
    action: action.value,
    schedule: { type: scheduleType.value, time: time.value, weekdays: scheduleType.value === 'weekly' ? weekdays.value : undefined, monthdays: scheduleType.value === 'monthly' ? monthdays.value : undefined, holiday_mode: holidayMode.value },
    target: global ? { all_managed: true, devices: [] } : { all_managed: allManaged.value, devices: allManaged.value ? [] : targetDevices() },
    params: global ? {} : {
      ...(playlistId.value ? { playlist_id: Number(playlistId.value) } : {}),
      ...(songId.value ? { song_id: Number(songId.value) } : {}),
      ...(playMode.value ? { play_mode: playMode.value } : {}),
      ...(action.value === 'play_playlist' ? { start_position: startPosition.value } : {}),
      ...(action.value === 'set_volume' ? { volume: volume.value } : {}),
      ...(isPlayAction && presetVolumeEnabled.value ? { volume: volume.value } : {}),
      ...(stopMinutes > 0 ? { stop_after_minutes: stopMinutes } : {}),
    },
  };
  if (!task.name) { notify('请输入任务名称', 'warning'); return; }
  if (!global && !allManaged.value && !targetMembers.value.length) { notify('请至少选择一个目标设备', 'warning'); return; }
  try { await saveSchedule(task); editor.value = false; } catch (error) { notify(messageOf(error), 'error'); }
}
// 列表副标题追加预设音量 / 播放时长提示；仅在数值合法时展示
function taskExtras(task: ScheduledTask): string {
  const isPlay = task.action === 'play_playlist' || task.action === 'play_playlist_from';
  const parts: string[] = [];
  const v = task.params.volume;
  if (isPlay && typeof v === 'number' && v >= 0 && v <= 100) parts.push(`音量 ${v}`);
  const m = task.params.stop_after_minutes;
  if (isPlay && typeof m === 'number' && m >= 1 && m <= 999) parts.push(`${m} 分钟后停`);
  return parts.length ? ` · ${parts.join(' · ')}` : '';
}
const logTimeFormatter = computed(() => {
  const options: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  };
  try {
    return new Intl.DateTimeFormat('zh-CN', { ...options, timeZone: state.config.timezone });
  } catch {
    return new Intl.DateTimeFormat('zh-CN', options);
  }
});
function formatLogTime(executedAt: string | undefined): string {
  if (!executedAt) return '时间未知';
  const date = new Date(executedAt);
  return Number.isNaN(date.getTime()) ? '时间未知' : logTimeFormatter.value.format(date);
}
async function removeTask(id?: string) { if (!id || !(await confirmAction('删除定时任务', '删除后无法恢复。', '删除', true)).confirmed) return; try { await deleteSchedule(id); } catch (error) { notify(messageOf(error), 'error'); } }
async function toggle(task: ScheduledTask, enabled: boolean) { try { await toggleSchedule(task, enabled); } catch (error) { notify(messageOf(error), 'error'); } }
</script>

<template>
  <SectionCard title="时区设置" icon="schedule" description="定时任务使用插件配置的时区解释执行时间。">
    <div class="form-body"><div class="field"><label class="field-label">时区</label><SlInput :model-value="state.config.timezone" placeholder="Asia/Shanghai" @update:model-value="state.config.timezone = $event" @change="saveConfig({ timezone: state.config.timezone })" /><p class="field-help">例如 Asia/Shanghai、Asia/Tokyo、America/Los_Angeles。</p></div></div>
  </SectionCard>

  <SectionCard title="定时任务" icon="schedule" description="支持每周和每月调度、法定节假日规则以及指定设备。">
    <SettingRow title="启用定时任务" subtitle="全局关闭后所有任务暂停执行"><SlSwitch aria-label="启用定时任务" :model-value="state.config.scheduled_tasks_enabled" @update:model-value="saveConfig({ scheduled_tasks_enabled: $event })" /></SettingRow>
    <div class="form-body"><div class="field-actions" style="justify-content:space-between"><span class="field-help">{{ state.schedules.length }} 个任务</span><SlButton variant="filled" label="新建任务" icon="add" @click="resetEditor" /></div><div v-show="editor" class="sub-panel schedule-editor"><div class="field"><label class="field-label">任务名称</label><SlInput v-model="name" placeholder="例如：早上播放音乐" aria-label="任务名称" /></div><div class="field"><label class="field-label">动作</label><SlSelect v-model="action" :options="actionOptions" aria-label="动作类型" /></div><div v-if="action === 'play_playlist' || action === 'play_playlist_from'" class="field-grid"><div class="field"><label class="field-label">歌单</label><SlSelect :model-value="playlistId" :options="playlistOptions" placeholder="选择歌单" allow-empty searchable search-placeholder="搜索歌单" aria-label="选择歌单" @update:model-value="onPlaylistChange" /></div><div v-if="action === 'play_playlist_from'" class="field"><label class="field-label">起始歌曲</label><SlSelect v-model="songId" :options="songOptions" :placeholder="editorSongsLoading ? '加载中…' : '从第一首开始'" allow-empty searchable search-placeholder="搜索歌曲" aria-label="起始歌曲" /></div></div><div v-if="action === 'play_playlist'" class="field"><label class="field-label">起始位置</label><SlSelect v-model="startPosition" :options="positionOptions" aria-label="起始位置" /></div><div v-if="action === 'play_playlist' || action === 'play_playlist_from' || action === 'set_play_mode'" class="field"><label class="field-label">播放模式</label><SlSelect v-model="playMode" :options="modeOptions" aria-label="播放模式" /></div><div v-if="action === 'set_volume'" class="field"><label class="field-label">音量 {{ volume }}%</label><SlSlider v-model="volume" :max="100" aria-label="定时任务音量" /></div><template v-if="action === 'play_playlist' || action === 'play_playlist_from'"><SettingRow title="播放前预设音量" subtitle="任务触发时先把设备（含分组成员）音量调到指定值再开播"><SlSwitch v-model="presetVolumeEnabled" aria-label="播放前预设音量" /></SettingRow><div v-if="presetVolumeEnabled" class="field"><label class="field-label">音量 {{ volume }}%</label><SlSlider v-model="volume" :max="100" aria-label="预设播放音量" /></div><div class="field"><label class="field-label">播放时长（分钟，1-999，0 不启用）</label><SlInput v-model="stopAfterMinutes" type="number" placeholder="0" aria-label="播放时长" /><p class="field-help">播放开始后 N 分钟自动停止；语音「取消定时」可撤销。</p></div></template><div class="field-grid"><div class="field"><label class="field-label">调度类型</label><SlSelect v-model="scheduleType" :options="typeOptions" aria-label="调度类型" /></div><div class="field"><label class="field-label">执行时间</label><SlInput v-model="time" placeholder="08:00" aria-label="执行时间" /></div></div><template v-if="scheduleType === 'weekly'"><label class="field-label">选择星期</label><div class="day-grid"> <button v-for="day in [1,2,3,4,5,6,0]" :key="day" type="button" :class="{ active: weekdays.includes(day) }" @click="toggleDay(weekdays, day)">{{ ['日','一','二','三','四','五','六'][day] }}</button></div><div class="field-actions"><SlButton variant="text" label="每天" @click="weekdays = [0,1,2,3,4,5,6]" /><SlButton variant="text" label="工作日" @click="weekdays = [1,2,3,4,5]" /></div><div class="field" style="margin-top:12px"><label class="field-label">节假日模式</label><SlSelect v-model="holidayMode" :options="[{ value: 'ignore', label: '忽略节假日' }, { value: 'only_holiday', label: '仅法定节假日触发' }, { value: 'exclude_holiday', label: '跳过节假日，含调休补班' }]" aria-label="节假日模式" /></div></template><template v-else><label class="field-label">选择日期</label><div class="day-grid" style="grid-template-columns:repeat(7,1fr)"><button v-for="day in 31" :key="day" type="button" :class="{ active: monthdays.includes(day) }" @click="toggleDay(monthdays, day)">{{ day }}</button></div></template><template v-if="!isGlobalAction"><label class="field-label" style="margin-top:16px">目标设备</label><SettingRow title="所有受管理设备"><SlSwitch v-model="allManaged" aria-label="所有受管理设备" /></SettingRow></template><div v-if="!isGlobalAction && !allManaged" class="sub-panel"><div v-for="item in managedDevices" :key="`${item.accountId}:${item.device.device_id || item.device.deviceID}`" class="device-check-row"><SlCheckbox :model-value="targetMembers.includes(`${item.accountId}:${item.device.device_id || item.device.deviceID}`)" @update:model-value="(value) => value ? targetMembers.push(`${item.accountId}:${item.device.device_id || item.device.deviceID}`) : targetMembers = targetMembers.filter((id) => id !== `${item.accountId}:${item.device.device_id || item.device.deviceID}`)" /><div class="device-check-copy"><strong>{{ item.device.name }}</strong><small>{{ item.accountName }}</small></div></div></div><div class="field-actions schedule-editor-actions"><SlButton variant="text" label="取消" @click="editor = false" /><SlButton variant="filled" label="保存任务" icon="save" @click="saveCurrent" /></div></div><div v-for="task in state.schedules" :key="task.id" class="list-item schedule-task-row"><div class="list-item-copy"><strong class="list-item-title">{{ task.name }}</strong><span class="list-item-subtitle">{{ task.schedule.type === 'weekly' ? '每周' : '每月' }} {{ task.schedule.time }} · {{ actionLabel(task.action) }}{{ taskExtras(task) }}</span></div><SlSwitch :model-value="task.enabled" :aria-label="`${task.name}启用状态`" @update:model-value="toggle(task, $event)" /><SlButton variant="icon" icon="edit" title="编辑任务" @click="editTask(task)" /><SlButton variant="icon" icon="delete" title="删除任务" @click="removeTask(task.id)" /></div><SlEmptyState v-if="!state.schedules.length && !editor" compact title="还没有定时任务" description="创建任务后可按星期、日期和节假日自动控制音箱。"><SlButton variant="tonal" label="新建任务" icon="add" @click="resetEditor" /></SlEmptyState></div>
  </SectionCard>

  <SlDisclosure title="执行日志" icon="terminal" description="查看最近 50 条任务执行结果。"><div class="form-body"><div class="field-actions"><SlButton variant="text" label="刷新日志" icon="refresh" @click="loadScheduleLogs" /></div><div v-for="(log, index) in state.scheduleLogs" :key="`${log.task_id}:${log.executed_at}:${index}`" class="list-item"><div class="list-item-copy"><strong class="list-item-title">{{ log.task_name || log.task_id }}</strong><span class="list-item-subtitle">{{ log.message || '无消息' }} · {{ formatLogTime(log.executed_at) }}</span></div><span class="chip" :class="log.success ? 'chip-success' : 'chip-error'">{{ log.success ? '成功' : '失败' }}</span></div><div v-if="!state.scheduleLogs.length" class="empty-state">暂无执行日志</div></div></SlDisclosure>
</template>
