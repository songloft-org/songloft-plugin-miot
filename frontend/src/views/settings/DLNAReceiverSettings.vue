<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue';
import { get, put } from '../../api';
import { messageOf, notify, state } from '../../store';
import SectionCard from '../../ui/SectionCard.vue';
import SettingRow from '../../ui/SettingRow.vue';
import SlButton from '../../ui/SlButton.vue';
import SlInput from '../../ui/SlInput.vue';
import SlSwitch from '../../ui/SlSwitch.vue';

interface ReceiverStatus {
  enabled: boolean; name: string; base_url: string;
  running: boolean; host_supported: boolean; error: string;
  receivers: Array<{ id: string; account_id: string; device_id: string; name: string; running: boolean; state: string; error: string }>;
}
const form = reactive({ enabled: false, name: 'Songloft 小爱音箱', base_url: '' });
const status = ref<ReceiverStatus | null>(null);
const saving = ref(false);
const error = ref('');
let timer: ReturnType<typeof setTimeout> | null = null;
let disposed = false;
const label = computed(() => !status.value?.enabled ? '已关闭' : status.value.running ? `${status.value.receivers.filter(r => r.running).length} 个接收器已开启` : status.value.error ? '启动失败' : '暂无可用的独立音箱');
function playbackLabel(value: string): string { return ({ PLAYING: '播放中', PAUSED_PLAYBACK: '已暂停', STOPPED: '已停止', NO_MEDIA_PRESENT: '等待投放' } as Record<string, string>)[value] || value; }
let revision = 0;
async function refresh(initial = false) {
  const current = revision;
  try {
    const result = await get<ReceiverStatus>('/receiver/config');
    if (disposed || current !== revision) return;
    status.value = result;
    error.value = result.error;
    if (initial) {
      form.enabled = result.enabled;
      form.name = result.name;
      form.base_url = result.base_url || state.config.server_host;
    }
  } catch (cause) { if (!disposed && current === revision) error.value = messageOf(cause); }
  if (!disposed && current === revision) timer = setTimeout(() => { void refresh(); }, 5000);
}
async function save() {
  revision++;
  if (timer !== null) clearTimeout(timer);
  saving.value = true;
  try {
    const result = await put<ReceiverStatus>('/receiver/config', { ...form });
    if (disposed) return;
    status.value = result;
    error.value = status.value.error;
    notify(form.enabled ? 'DLNA 接收器已开启' : 'DLNA 接收器已关闭', 'success');
  } catch (cause) { if (!disposed) { error.value = messageOf(cause); notify(error.value, 'error'); } }
  finally { saving.value = false; if (!disposed) timer = setTimeout(() => { void refresh(); }, 5000); }
}
onMounted(() => { void refresh(true); });
onUnmounted(() => { disposed = true; if (timer !== null) clearTimeout(timer); });
</script>

<template>
  <SectionCard title="DLNA 接收器" icon="speaker_group" description="每个已启用管理的独立音箱都有一个 DLNA 入口，可在投放列表中分别选择并独立播放 MP3。">
    <SettingRow title="启用接收器" :subtitle="label">
      <SlSwitch v-model="form.enabled" :disabled="saving || (!status?.host_supported && !form.enabled)" aria-label="启用 DLNA 接收器" />
    </SettingRow>
    <SettingRow title="接收器名称前缀" subtitle="在前缀后显示各音箱名称，便于在投放列表中区分。">
      <SlInput v-model="form.name" :disabled="saving" aria-label="DLNA 接收器名称" />
    </SettingRow>
    <SettingRow title="服务器局域网地址" subtitle="填写手机和音箱都能访问的 HTTP IPv4 地址，可包含部署子路径。">
      <SlInput v-model="form.base_url" :disabled="saving" placeholder="http://192.168.1.10:58091" aria-label="DLNA 服务器地址" />
    </SettingRow>
    <div class="form-body">
      <p v-if="status && !status.host_supported" role="alert">请升级 Songloft 宿主以支持 DLNA 接收。</p>
      <p v-if="error" role="alert">{{ error }}</p>
      <p>自动包含所有已启用管理的独立音箱；设备分组内的音箱不提供独立接收器。共用 Songloft HTTP 端口和 UDP 1900，无需为每个音箱分配端口。</p>
      <p v-if="status && !status.receivers.length">暂无可用的独立音箱，请先启用音箱管理并将目标音箱移出设备分组。</p>
      <div v-for="receiver in status?.receivers || []" :key="receiver.id" class="receiver-status">
        <strong>{{ receiver.name }}</strong>
        <p>{{ receiver.running ? playbackLabel(receiver.state) : status?.enabled ? '启动失败' : '已关闭' }}</p>
        <p v-if="receiver.error" role="alert">{{ receiver.error }}</p>
      </div>
      <SlButton :disabled="saving || !status" variant="filled" :label="saving ? '正在保存…' : '保存接收器设置'" @click="save" />
    </div>
  </SectionCard>
</template>
