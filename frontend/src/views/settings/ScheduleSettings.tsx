import {
  displayText,
  usePageState,
  NativeView,
  classes,
  styleObject,
  renderItems,
} from '../../page-state';
import { computed, onMounted, ref, watch } from '../../page-state';
import SectionCard from '../../ui/SectionCard.tsx';
import SettingRow from '../../ui/SettingRow.tsx';
import SlButton from '../../ui/SlButton.tsx';
import SlCheckbox from '../../ui/SlCheckbox.tsx';
import SlInput from '../../ui/SlInput.tsx';
import SlSelect from '../../ui/SlSelect.tsx';
import SlSlider from '../../ui/SlSlider.tsx';
import SlSwitch from '../../ui/SlSwitch.tsx';
import SlDisclosure from '../../ui/SlDisclosure.tsx';
import SlEmptyState from '../../ui/SlEmptyState.tsx';
import { get } from '../../api';
import { navigation } from '../../runtime';
import {
  confirmAction,
  deleteSchedule,
  loadScheduleLogs,
  loadSchedules,
  managedDevices,
  messageOf,
  notify,
  playlistLabel,
  saveConfig,
  saveSchedule,
  state,
  toggleSchedule,
} from '../../store';
import type {
  ScheduleType,
  ScheduledTask,
  SelectOption,
  Song,
} from '../../types';
const pageState = {
  name: 'ScheduleSettings',
  createState(input, {}) {
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
    const typeOptions: SelectOption[] = [
      { value: 'weekly', label: '每周' },
      { value: 'monthly', label: '每月' },
    ];
    const modeOptions: SelectOption[] = [
      { value: '', label: '跟随上次设置' },
      { value: 'order', label: '顺序播放' },
      { value: 'loop', label: '列表循环' },
      { value: 'single', label: '单曲循环' },
      { value: 'random', label: '随机播放' },
      { value: 'singlePlay', label: '单曲播放' },
    ];
    const positionOptions: SelectOption[] = [
      { value: 'first', label: '从第一首开始' },
      { value: 'resume', label: '从上次进度继续' },
      { value: 'random', label: '随机位置' },
    ];
    // 全局动作（不绑定设备）：编辑器隐藏目标设备区，提交时 target 走 all_managed 占位，后端跳过设备校验
    const globalActions = ['enable_monitor', 'disable_monitor'];
    const isGlobalAction = computed(() => globalActions.includes(action.value));
    function actionLabel(value: string) {
      return (
        actionOptions.find((option) => option.value === value)?.label || value
      );
    }
    const playlistOptions = computed(() =>
      state.playlists.map((playlist) => ({
        value: String(playlist.id),
        label: playlistLabel(playlist),
        searchText: playlist.name,
      })),
    );
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
        const songs = await get<Song[]>(
          `/playlists/${encodeURIComponent(id)}/songs`,
        );
        if (request === editorSongsRequest) editorSongs.value = songs || [];
      } catch (error) {
        if (request === editorSongsRequest) {
          editorSongs.value = [];
          notify(messageOf(error), 'error');
        }
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
    const songOptions = computed(() =>
      editorSongs.value.map((song) => ({
        value: String(song.id),
        label: `${song.title}${song.artist ? ` · ${song.artist}` : ''}`,
      })),
    );
    onMounted(() => {
      void Promise.all([loadSchedules(), loadScheduleLogs()]);
    });
    watch(editor, (open) => {
      navigation.editorOpen = open;
      if (!open) navigation.selectOpen = false;
    });
    // consumeBack() 置 navigation.editorOpen = false 时反向同步，确保编辑器真正关闭
    watch(
      () => navigation.editorOpen,
      (open) => {
        if (!open && editor.value) editor.value = false;
      },
    );
    function resetEditor() {
      editingId.value = '';
      name.value = '';
      action.value = 'play_playlist';
      playlistId.value = '';
      songId.value = '';
      playMode.value = '';
      startPosition.value = 'first';
      volume.value = 50;
      presetVolumeEnabled.value = false;
      stopAfterMinutes.value = '';
      scheduleType.value = 'weekly';
      time.value = '08:00';
      weekdays.value = [1, 2, 3, 4, 5];
      monthdays.value = [1];
      holidayMode.value = 'ignore';
      allManaged.value = true;
      targetMembers.value = [];
      editorSongs.value = [];
      editor.value = true;
    }
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
      const isPlayAction =
        task.action === 'play_playlist' || task.action === 'play_playlist_from';
      presetVolumeEnabled.value =
        isPlayAction && typeof task.params.volume === 'number';
      stopAfterMinutes.value =
        typeof task.params.stop_after_minutes === 'number' &&
        task.params.stop_after_minutes > 0
          ? String(task.params.stop_after_minutes)
          : '';
      scheduleType.value = task.schedule.type;
      time.value = task.schedule.time;
      weekdays.value = [...(task.schedule.weekdays || [])];
      monthdays.value = [...(task.schedule.monthdays || [])];
      holidayMode.value = task.schedule.holiday_mode || 'ignore';
      allManaged.value = !!task.target.all_managed;
      targetMembers.value = (task.target.devices || []).map(
        (item) => `${item.account_id}:${item.device_id}`,
      );
      void loadEditorSongs(playlistId.value);
      editor.value = true;
    }
    function toggleDay(list: number[], day: number) {
      const index = list.indexOf(day);
      if (index >= 0) list.splice(index, 1);
      else list.push(day);
    }
    function targetDevices() {
      return targetMembers.value.map((value) => {
        const [account_id, device_id] = value.split(':');
        return { account_id, device_id };
      });
    }
    async function saveCurrent() {
      // 全局动作不绑定设备也不需要参数：切换动作前残留的歌单/歌曲/播放模式一律不带上
      const global = isGlobalAction.value;
      const isPlayAction =
        action.value === 'play_playlist' ||
        action.value === 'play_playlist_from';
      // 播放时长仅播放动作可用；范围与 voiceEngine.setSleepTimer('time') 的 1-999 对齐
      const stopMinutesRaw = Number.parseInt(
        String(stopAfterMinutes.value).trim(),
        10,
      );
      const stopMinutes =
        isPlayAction &&
        Number.isFinite(stopMinutesRaw) &&
        stopMinutesRaw >= 1 &&
        stopMinutesRaw <= 999
          ? stopMinutesRaw
          : 0;
      const task: ScheduledTask = {
        id: editingId.value || undefined,
        name: name.value.trim(),
        enabled: true,
        action: action.value,
        schedule: {
          type: scheduleType.value,
          time: time.value,
          weekdays:
            scheduleType.value === 'weekly' ? weekdays.value : undefined,
          monthdays:
            scheduleType.value === 'monthly' ? monthdays.value : undefined,
          holiday_mode: holidayMode.value,
        },
        target: global
          ? { all_managed: true, devices: [] }
          : {
              all_managed: allManaged.value,
              devices: allManaged.value ? [] : targetDevices(),
            },
        params: global
          ? {}
          : {
              ...(playlistId.value
                ? { playlist_id: Number(playlistId.value) }
                : {}),
              ...(songId.value ? { song_id: Number(songId.value) } : {}),
              ...(playMode.value ? { play_mode: playMode.value } : {}),
              ...(action.value === 'play_playlist'
                ? { start_position: startPosition.value }
                : {}),
              ...(action.value === 'set_volume'
                ? { volume: volume.value }
                : {}),
              ...(isPlayAction && presetVolumeEnabled.value
                ? { volume: volume.value }
                : {}),
              ...(stopMinutes > 0 ? { stop_after_minutes: stopMinutes } : {}),
            },
      };
      if (!task.name) {
        notify('请输入任务名称', 'warning');
        return;
      }
      if (!global && !allManaged.value && !targetMembers.value.length) {
        notify('请至少选择一个目标设备', 'warning');
        return;
      }
      try {
        await saveSchedule(task);
        editor.value = false;
      } catch (error) {
        notify(messageOf(error), 'error');
      }
    }
    // 列表副标题追加预设音量 / 播放时长提示；仅在数值合法时展示
    function taskExtras(task: ScheduledTask): string {
      const isPlay =
        task.action === 'play_playlist' || task.action === 'play_playlist_from';
      const parts: string[] = [];
      const v = task.params.volume;
      if (isPlay && typeof v === 'number' && v >= 0 && v <= 100)
        parts.push(`音量 ${v}`);
      const m = task.params.stop_after_minutes;
      if (isPlay && typeof m === 'number' && m >= 1 && m <= 999)
        parts.push(`${m} 分钟后停`);
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
        return new Intl.DateTimeFormat('zh-CN', {
          ...options,
          timeZone: state.config.timezone,
        });
      } catch {
        // Native Lynx engines may omit Intl entirely. Do not call it again in
        // the fallback: computed bindings are evaluated before tasks are loaded.
        return {
          format: (date: Date) =>
            `${date.toISOString().slice(0, 19).replace('T', ' ')} UTC`,
        };
      }
    });
    function formatLogTime(executedAt: string | undefined): string {
      if (!executedAt) return '时间未知';
      const date = new Date(executedAt);
      return Number.isNaN(date.getTime())
        ? '时间未知'
        : logTimeFormatter.value.format(date);
    }
    async function removeTask(id?: string) {
      if (
        !id ||
        !(await confirmAction('删除定时任务', '删除后无法恢复。', '删除', true))
          .confirmed
      )
        return;
      try {
        await deleteSchedule(id);
      } catch (error) {
        notify(messageOf(error), 'error');
      }
    }
    async function toggle(task: ScheduledTask, enabled: boolean) {
      try {
        await toggleSchedule(task, enabled);
      } catch (error) {
        notify(messageOf(error), 'error');
      }
    }
    const bindings = {
      editor,
      editingId,
      name,
      action,
      playlistId,
      songId,
      playMode,
      startPosition,
      volume,
      presetVolumeEnabled,
      stopAfterMinutes,
      scheduleType,
      time,
      weekdays,
      monthdays,
      holidayMode,
      allManaged,
      targetMembers,
      actionOptions,
      typeOptions,
      modeOptions,
      positionOptions,
      globalActions,
      isGlobalAction,
      actionLabel,
      playlistOptions,
      editorSongs,
      editorSongsLoading,
      get editorSongsRequest() {
        return editorSongsRequest;
      },
      set editorSongsRequest(v) {
        editorSongsRequest = v;
      },
      loadEditorSongs,
      onPlaylistChange,
      songOptions,
      resetEditor,
      editTask,
      toggleDay,
      targetDevices,
      saveCurrent,
      taskExtras,
      logTimeFormatter,
      formatLogTime,
      removeTask,
      toggle,
      SectionCard,
      SettingRow,
      SlButton,
      SlCheckbox,
      SlInput,
      SlSelect,
      SlSlider,
      SlSwitch,
      SlDisclosure,
      SlEmptyState,
      get loadScheduleLogs() {
        return loadScheduleLogs;
      },
      get managedDevices() {
        return managedDevices;
      },
      get saveConfig() {
        return saveConfig;
      },
      get state() {
        return state;
      },
    };
    return bindings;
  },
};
export default function ScheduleSettings(props: any) {
  const vm = usePageState(pageState, props);
  return (
    <>
      <SectionCard
        title="时区设置"
        icon="schedule"
        description="定时任务使用插件配置的时区解释执行时间。"
      >
        <NativeView className="form-body">
          <NativeView className="field">
            <NativeView className="field-label">
              <text>时区</text>
            </NativeView>
            <SlInput
              modelValue={vm.state.config.timezone}
              placeholder="Asia/Shanghai"
              onUpdateModelValue={($event: any) => {
                vm.state.config.timezone = $event;
              }}
              onChange={($event: any) => {
                vm.saveConfig({ timezone: vm.state.config.timezone });
              }}
            ></SlInput>
            <NativeView className="field-help">
              <text>例如 Asia/Shanghai、Asia/Tokyo、America/Los_Angeles。</text>
            </NativeView>
          </NativeView>
        </NativeView>
      </SectionCard>
      <SectionCard
        title="定时任务"
        icon="schedule"
        description="支持每周和每月调度、法定节假日规则以及指定设备。"
      >
        <SettingRow title="启用定时任务" subtitle="全局关闭后所有任务暂停执行">
          <SlSwitch
            aria-label="启用定时任务"
            modelValue={vm.state.config.scheduled_tasks_enabled}
            onUpdateModelValue={($event: any) => {
              vm.saveConfig({ scheduled_tasks_enabled: $event });
            }}
          ></SlSwitch>
        </SettingRow>
        <NativeView className="form-body">
          <NativeView
            className="field-actions"
            style={styleObject('justify-content:space-between')}
          >
            <NativeView className="field-help">
              <text>{displayText(vm.state.schedules.length)} 个任务</text>
            </NativeView>
            <SlButton
              variant="filled"
              label="新建任务"
              icon="add"
              onClick={($event: any) => {
                void vm.resetEditor($event);
              }}
            ></SlButton>
          </NativeView>
          <NativeView
            visible={!!vm.editor}
            className="sub-panel schedule-editor"
          >
            <NativeView className="field">
              <NativeView className="field-label">
                <text>任务名称</text>
              </NativeView>
              <SlInput
                modelValue={vm.name}
                onUpdateModelValue={($event: any) => {
                  vm.name = $event;
                }}
                placeholder="例如：早上播放音乐"
                aria-label="任务名称"
              ></SlInput>
            </NativeView>
            <NativeView className="field">
              <NativeView className="field-label">
                <text>动作</text>
              </NativeView>
              <SlSelect
                modelValue={vm.action}
                onUpdateModelValue={($event: any) => {
                  vm.action = $event;
                }}
                options={vm.actionOptions}
                aria-label="动作类型"
              ></SlSelect>
            </NativeView>
            {vm.action === 'play_playlist' ||
            vm.action === 'play_playlist_from' ? (
              <NativeView className="field-grid">
                <NativeView className="field">
                  <NativeView className="field-label">
                    <text>歌单</text>
                  </NativeView>
                  <SlSelect
                    modelValue={vm.playlistId}
                    options={vm.playlistOptions}
                    placeholder="选择歌单"
                    allowEmpty
                    searchable
                    searchPlaceholder="搜索歌单"
                    aria-label="选择歌单"
                    onUpdateModelValue={($event: any) => {
                      void vm.onPlaylistChange($event);
                    }}
                  ></SlSelect>
                </NativeView>
                {vm.action === 'play_playlist_from' ? (
                  <NativeView className="field">
                    <NativeView className="field-label">
                      <text>起始歌曲</text>
                    </NativeView>
                    <SlSelect
                      modelValue={vm.songId}
                      onUpdateModelValue={($event: any) => {
                        vm.songId = $event;
                      }}
                      options={vm.songOptions}
                      placeholder={
                        vm.editorSongsLoading ? '加载中…' : '从第一首开始'
                      }
                      allowEmpty
                      searchable
                      searchPlaceholder="搜索歌曲"
                      aria-label="起始歌曲"
                    ></SlSelect>
                  </NativeView>
                ) : null}
              </NativeView>
            ) : null}
            {vm.action === 'play_playlist' ? (
              <NativeView className="field">
                <NativeView className="field-label">
                  <text>起始位置</text>
                </NativeView>
                <SlSelect
                  modelValue={vm.startPosition}
                  onUpdateModelValue={($event: any) => {
                    vm.startPosition = $event;
                  }}
                  options={vm.positionOptions}
                  aria-label="起始位置"
                ></SlSelect>
              </NativeView>
            ) : null}
            {vm.action === 'play_playlist' ||
            vm.action === 'play_playlist_from' ||
            vm.action === 'set_play_mode' ? (
              <NativeView className="field">
                <NativeView className="field-label">
                  <text>播放模式</text>
                </NativeView>
                <SlSelect
                  modelValue={vm.playMode}
                  onUpdateModelValue={($event: any) => {
                    vm.playMode = $event;
                  }}
                  options={vm.modeOptions}
                  aria-label="播放模式"
                ></SlSelect>
              </NativeView>
            ) : null}
            {vm.action === 'set_volume' ? (
              <NativeView className="field">
                <NativeView className="field-label">
                  <text>音量 {displayText(vm.volume)}%</text>
                </NativeView>
                <SlSlider
                  modelValue={vm.volume}
                  onUpdateModelValue={($event: any) => {
                    vm.volume = $event;
                  }}
                  max={100}
                  aria-label="定时任务音量"
                ></SlSlider>
              </NativeView>
            ) : null}
            {vm.action === 'play_playlist' ||
            vm.action === 'play_playlist_from' ? (
              <>
                <SettingRow
                  title="播放前预设音量"
                  subtitle="任务触发时先把设备（含分组成员）音量调到指定值再开播"
                >
                  <SlSwitch
                    modelValue={vm.presetVolumeEnabled}
                    onUpdateModelValue={($event: any) => {
                      vm.presetVolumeEnabled = $event;
                    }}
                    aria-label="播放前预设音量"
                  ></SlSwitch>
                </SettingRow>
                {vm.presetVolumeEnabled ? (
                  <NativeView className="field">
                    <NativeView className="field-label">
                      <text>音量 {displayText(vm.volume)}%</text>
                    </NativeView>
                    <SlSlider
                      modelValue={vm.volume}
                      onUpdateModelValue={($event: any) => {
                        vm.volume = $event;
                      }}
                      max={100}
                      aria-label="预设播放音量"
                    ></SlSlider>
                  </NativeView>
                ) : null}
                <NativeView className="field">
                  <NativeView className="field-label">
                    <text>播放时长（分钟，1-999，0 不启用）</text>
                  </NativeView>
                  <SlInput
                    modelValue={vm.stopAfterMinutes}
                    onUpdateModelValue={($event: any) => {
                      vm.stopAfterMinutes = $event;
                    }}
                    type="number"
                    min={0}
                    max={999}
                    step={1}
                    unit="分钟"
                    placeholder="0"
                    aria-label="播放时长"
                  ></SlInput>
                  <NativeView className="field-help">
                    <text>
                      播放开始后 N 分钟自动停止；语音「取消定时」可撤销。
                    </text>
                  </NativeView>
                </NativeView>
              </>
            ) : null}
            <NativeView className="field-grid">
              <NativeView className="field">
                <NativeView className="field-label">
                  <text>调度类型</text>
                </NativeView>
                <SlSelect
                  modelValue={vm.scheduleType}
                  onUpdateModelValue={($event: any) => {
                    vm.scheduleType = $event;
                  }}
                  options={vm.typeOptions}
                  aria-label="调度类型"
                ></SlSelect>
              </NativeView>
              <NativeView className="field">
                <NativeView className="field-label">
                  <text>执行时间</text>
                </NativeView>
                <SlInput
                  modelValue={vm.time}
                  onUpdateModelValue={($event: any) => {
                    vm.time = $event;
                  }}
                  placeholder="08:00"
                  aria-label="执行时间"
                ></SlInput>
              </NativeView>
            </NativeView>
            {vm.scheduleType === 'weekly' ? (
              <>
                <NativeView className="field-label">
                  <text>选择星期</text>
                </NativeView>
                <NativeView className="day-grid">
                  {renderItems([1, 2, 3, 4, 5, 6, 0], (day) => (
                    <SlButton
                      key={day}
                      label={['日', '一', '二', '三', '四', '五', '六'][day]}
                      variant={vm.weekdays.includes(day) ? 'filled' : 'outlined'}
                      onClick={() => vm.toggleDay(vm.weekdays, day)}
                    />
                  ))}
                </NativeView>
                <NativeView className="field-actions">
                  <SlButton
                    variant="text"
                    label="每天"
                    onClick={($event: any) => {
                      vm.weekdays = [0, 1, 2, 3, 4, 5, 6];
                    }}
                  ></SlButton>
                  <SlButton
                    variant="text"
                    label="工作日"
                    onClick={($event: any) => {
                      vm.weekdays = [1, 2, 3, 4, 5];
                    }}
                  ></SlButton>
                </NativeView>
                <NativeView
                  className="field"
                  style={styleObject('margin-top:12px')}
                >
                  <NativeView className="field-label">
                    <text>节假日模式</text>
                  </NativeView>
                  <SlSelect
                    modelValue={vm.holidayMode}
                    onUpdateModelValue={($event: any) => {
                      vm.holidayMode = $event;
                    }}
                    options={[
                      { value: 'ignore', label: '忽略节假日' },
                      { value: 'only_holiday', label: '仅法定节假日触发' },
                      {
                        value: 'exclude_holiday',
                        label: '跳过节假日，含调休补班',
                      },
                    ]}
                    aria-label="节假日模式"
                  ></SlSelect>
                </NativeView>
              </>
            ) : (
              <>
                <NativeView className="field-label">
                  <text>选择日期</text>
                </NativeView>
                <NativeView
                  className="day-grid"
                  style={styleObject('grid-template-columns:repeat(7,1fr)')}
                >
                  {renderItems(31, (day) => (
                    <SlButton
                      key={day}
                      label={displayText(day)}
                      variant={vm.monthdays.includes(day) ? 'filled' : 'outlined'}
                      onClick={() => vm.toggleDay(vm.monthdays, day)}
                    />
                  ))}
                </NativeView>
              </>
            )}
            {!vm.isGlobalAction ? (
              <>
                <NativeView
                  className="field-label"
                  style={styleObject('margin-top:16px')}
                >
                  <text>目标设备</text>
                </NativeView>
                <SettingRow title="所有受管理设备">
                  <SlSwitch
                    modelValue={vm.allManaged}
                    onUpdateModelValue={($event: any) => {
                      vm.allManaged = $event;
                    }}
                    aria-label="所有受管理设备"
                  ></SlSwitch>
                </SettingRow>
              </>
            ) : null}
            {!vm.isGlobalAction && !vm.allManaged ? (
              <NativeView className="sub-panel">
                {renderItems(vm.managedDevices, (item) => (
                  <NativeView
                    key={`${item.accountId}:${item.device.device_id || item.device.deviceID}`}
                    className="device-check-row"
                  >
                    <SlCheckbox
                      modelValue={vm.targetMembers.includes(
                        `${item.accountId}:${item.device.device_id || item.device.deviceID}`,
                      )}
                      onUpdateModelValue={(value) =>
                        value
                          ? vm.targetMembers.push(
                              `${item.accountId}:${item.device.device_id || item.device.deviceID}`,
                            )
                          : (vm.targetMembers = vm.targetMembers.filter(
                              (id) =>
                                id !==
                                `${item.accountId}:${item.device.device_id || item.device.deviceID}`,
                            ))
                      }
                    ></SlCheckbox>
                    <NativeView className="device-check-copy">
                      <NativeView>
                        <text>{displayText(item.device.name)}</text>
                      </NativeView>
                      <NativeView>
                        <text>{displayText(item.accountName)}</text>
                      </NativeView>
                    </NativeView>
                  </NativeView>
                ))}
              </NativeView>
            ) : null}
            <NativeView className="field-actions schedule-editor-actions">
              <SlButton
                variant="text"
                label="取消"
                onClick={($event: any) => {
                  vm.editor = false;
                }}
              ></SlButton>
              <SlButton
                variant="filled"
                label="保存任务"
                icon="save"
                onClick={($event: any) => {
                  void vm.saveCurrent($event);
                }}
              ></SlButton>
            </NativeView>
          </NativeView>
          {renderItems(vm.state.schedules, (task) => (
            <NativeView key={task.id} className="list-item schedule-task-row">
              <NativeView className="list-item-copy">
                <NativeView className="list-item-title">
                  <text>{displayText(task.name)}</text>
                </NativeView>
                <NativeView className="list-item-subtitle">
                  <text>
                    {displayText(
                      task.schedule.type === 'weekly' ? '每周' : '每月',
                    )}
                    {displayText(task.schedule.time)} ·{' '}
                    {displayText(vm.actionLabel(task.action))}
                    {displayText(vm.taskExtras(task))}
                  </text>
                </NativeView>
              </NativeView>
              <SlSwitch
                modelValue={task.enabled}
                ariaLabel={`${task.name}启用状态`}
                onUpdateModelValue={($event: any) => {
                  vm.toggle(task, $event);
                }}
              ></SlSwitch>
              <SlButton
                variant="icon"
                icon="edit"
                title="编辑任务"
                onClick={($event: any) => {
                  vm.editTask(task);
                }}
              ></SlButton>
              <SlButton
                variant="icon"
                icon="delete"
                title="删除任务"
                onClick={($event: any) => {
                  vm.removeTask(task.id);
                }}
              ></SlButton>
            </NativeView>
          ))}
          {!vm.state.schedules.length && !vm.editor ? (
            <SlEmptyState
              compact
              title="还没有定时任务"
              description="创建任务后可按星期、日期和节假日自动控制音箱。"
            >
              <SlButton
                variant="tonal"
                label="新建任务"
                icon="add"
                onClick={($event: any) => {
                  void vm.resetEditor($event);
                }}
              ></SlButton>
            </SlEmptyState>
          ) : null}
        </NativeView>
      </SectionCard>
      <SlDisclosure
        title="执行日志"
        icon="terminal"
        description="查看最近 50 条任务执行结果。"
      >
        <NativeView className="form-body">
          <NativeView className="field-actions">
            <SlButton
              variant="text"
              label="刷新日志"
              icon="refresh"
              onClick={($event: any) => {
                void vm.loadScheduleLogs($event);
              }}
            ></SlButton>
          </NativeView>
          {renderItems(vm.state.scheduleLogs, (log, index) => (
            <NativeView
              key={`${log.task_id}:${log.executed_at}:${index}`}
              className="list-item"
            >
              <NativeView className="list-item-copy">
                <NativeView className="list-item-title">
                  <text>{displayText(log.task_name || log.task_id)}</text>
                </NativeView>
                <NativeView className="list-item-subtitle">
                  <text>
                    {displayText(log.message || '无消息')} ·{' '}
                    {displayText(vm.formatLogTime(log.executed_at))}
                  </text>
                </NativeView>
              </NativeView>
              <NativeView
                className={classes([
                  'chip',
                  classes(log.success ? 'chip-success' : 'chip-error'),
                ])}
              >
                <text>{displayText(log.success ? '成功' : '失败')}</text>
              </NativeView>
            </NativeView>
          ))}
          {!vm.state.scheduleLogs.length ? (
            <NativeView className="empty-state">
              <text>暂无执行日志</text>
            </NativeView>
          ) : null}
        </NativeView>
      </SlDisclosure>
    </>
  );
}
