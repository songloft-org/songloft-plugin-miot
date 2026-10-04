<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue';
import { get, put } from '../../api';
import { deviceName, messageOf, notify, state } from '../../store';
import SectionCard from '../../ui/SectionCard.vue';
import SettingRow from '../../ui/SettingRow.vue';
import SlButton from '../../ui/SlButton.vue';
import SlInput from '../../ui/SlInput.vue';
import SlSelect from '../../ui/SlSelect.vue';
import SlSwitch from '../../ui/SlSwitch.vue';

interface ReceiverStatus {
  enabled: boolean; name: string; base_url: string; account_id: string; device_id: string;
  running: boolean; host_supported: boolean; error: string; state: string;
}
const form = reactive({ enabled: false, name: 'Songloft 小爱音箱', base_url: '' });
const selected = ref('');
const status = ref<ReceiverStatus | null>(null);
const saving = ref(false);
const error = ref('');
let timer: ReturnType<typeof setTimeout> | null = null;
let disposed = false;
const options = computed(() => state.devices.flatMap(account => account.devices
  .filter(device => device.managed && !state.groups.some(group => group.members.some(member => member.account_id === account.account_id && member.device_id === deviceIdOf(device))))
  .map(device => ({ value: JSON.stringify([account.account_id, deviceIdOf(device)]), label: deviceName(device) }))));
function deviceIdOf(device: { device_id?: string; deviceID?: string }): string { return device.device_id || device.deviceID || ''; }
const label = computed(() => status.value?.running ? '正在接收投放' : status.value?.enabled ? '启动失败' : '已关闭');
const playbackLabel = computed(() => ({ PLAYING: '播放中', PAUSED_PLAYBACK: '已暂停', STOPPED: '已停止', NO_MEDIA_PRESENT: '等待投放' } as Record<string, string>)[status.value?.state || '']);
async function refresh(initial = false) {
  try {
    const result = await get<ReceiverStatus>('/receiver/config');
    if (disposed) return;
    status.value = result;
    error.value = result.error;
    if (initial) {
      form.enabled = result.enabled;
      form.name = result.name;
      form.base_url = result.base_url || state.config.server_host;
      selected.value = result.account_id && result.device_id ? JSON.stringify([result.account_id, result.device_id]) : '';
    }
  } catch (cause) { if (!disposed) error.value = messageOf(cause); }
  if (!disposed) timer = setTimeout(() => { void refresh(); }, 5000);
}
async function save() {
  saving.value = true;
  try {
    const [account_id, device_id] = selected.value ? JSON.parse(selected.value) : ['', ''];
    status.value = await put<ReceiverStatus>('/receiver/config', { ...form, account_id, device_id });
    error.value = status.value.error;
    notify(form.enabled ? 'DLNA 接收器已开启' : 'DLNA 接收器已关闭', 'success');
  } catch (cause) { error.value = messageOf(cause); notify(error.value, 'error'); }
  finally { saving.value = false; }
}
onMounted(() => { void refresh(true); });
onUnmounted(() => { disposed = true; if (timer !== null) clearTimeout(timer); });
</script>

<template>
  <SectionCard title="DLNA 接收器" icon="speaker_group" description="让手机或电脑上的 DLNA 应用将 MP3 音乐投放到指定的小爱音箱。">
    <SettingRow title="启用接收器" :subtitle="label">
      <SlSwitch v-model="form.enabled" :disabled="saving || (!status?.host_supported && !form.enabled)" aria-label="启用 DLNA 接收器" />
    </SettingRow>
    <SettingRow title="接收器名称" subtitle="显示在发送端应用的投放设备列表中。">
      <SlInput v-model="form.name" :disabled="saving" aria-label="DLNA 接收器名称" />
    </SettingRow>
    <SettingRow title="目标音箱" subtitle="选择已启用管理的独立音箱；首版不支持设备分组。">
      <SlSelect v-model="selected" :options="options" :disabled="saving" aria-label="DLNA 目标音箱" />
    </SettingRow>
    <SettingRow title="服务器局域网地址" subtitle="填写手机和音箱都能访问的 HTTP IPv4 地址，可包含部署子路径。">
      <SlInput v-model="form.base_url" :disabled="saving" placeholder="http://192.168.1.10:58091" aria-label="DLNA 服务器地址" />
    </SettingRow>
    <div class="form-body">
      <p v-if="status && !status.host_supported" role="alert">请升级 Songloft 宿主以支持 DLNA 接收。</p>
      <p v-if="error" role="alert">{{ error }}</p>
      <p v-if="status?.running">播放状态：{{ playbackLabel || status.state }}</p>
      <SlButton :disabled="saving || !status" variant="filled" :label="saving ? '正在保存…' : '保存接收器设置'" @click="save" />
    </div>
  </SectionCard>
</template>
