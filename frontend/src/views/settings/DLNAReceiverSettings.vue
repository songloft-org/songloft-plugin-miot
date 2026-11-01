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
  enabled: boolean; name: string; base_url: string; enabled_ids: string[];
  running: boolean; host_supported: boolean; error: string;
  receivers: Array<{ id: string; enabled: boolean; available: boolean; account_id: string; device_id: string; name: string; running: boolean; state: string; error: string; group_id: string; members: Array<{ account_id: string; device_id: string }> }>;
}
const form = reactive({ enabled: false, name: 'Songloft 小爱音箱', base_url: '', enabled_ids: [] as string[] });
const status = ref<ReceiverStatus | null>(null);
const saving = ref(false);
const error = ref('');
let timer: ReturnType<typeof setTimeout> | null = null;
let disposed = false;
const label = computed(() => !status.value?.enabled ? '已关闭' : status.value.running ? `${status.value.receivers.filter(r => r.running).length} 个接收器已开启` : status.value.error ? '启动失败' : status.value.enabled_ids.length ? '暂无可运行的接收器' : '请为音箱或分组开启插件 DLNA');
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
      form.enabled_ids = result.enabled_ids.slice();
      form.name = result.name;
      form.base_url = result.base_url || state.config.server_host;
    }
  } catch (cause) { if (!disposed && current === revision) error.value = messageOf(cause); }
  if (!disposed && current === revision) timer = setTimeout(() => { void refresh(); }, 5000);
}
function selectReceiver(id: string, enabled: boolean): void {
  form.enabled_ids = enabled ? [...new Set([...form.enabled_ids, id])] : form.enabled_ids.filter(value => value !== id);
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
  <SectionCard title="DLNA 接收器" icon="speaker_group" description="按需为音箱或分组提供 DLNA 入口。原生支持 DLNA 的音箱可关闭插件入口，避免重复显示。">
    <SettingRow title="插件 DLNA 总开关" :subtitle="label">
      <SlSwitch v-model="form.enabled" :disabled="saving || (!status?.host_supported && !form.enabled)" aria-label="启用 DLNA 接收器" />
    </SettingRow>
    <SettingRow title="接收器名称前缀" subtitle="在前缀后显示音箱或分组名称，便于在投放列表中区分。">
      <SlInput v-model="form.name" :disabled="saving" aria-label="DLNA 接收器名称" />
    </SettingRow>
    <SettingRow title="服务器局域网地址" subtitle="填写手机和音箱都能访问的 HTTP IPv4 地址，可包含部署子路径。">
      <SlInput v-model="form.base_url" :disabled="saving" placeholder="http://192.168.1.10:58091" aria-label="DLNA 服务器地址" />
    </SettingRow>
    <div class="form-body">
      <p v-if="status && !status.host_supported" role="alert">请升级 Songloft 宿主以支持 DLNA 接收。</p>
      <p v-if="error" role="alert">{{ error }}</p>
      <p>新增音箱和分组默认关闭，请逐项选择并保存。分组成员不重复显示；分组需至少两台且全部成员已启用管理。独立音箱与分组的开关分别保存，退组后恢复音箱原来的选择。共用 Songloft HTTP 端口和 UDP 1900，无需为每个音箱分配端口。</p>
      <p v-if="status && !status.receivers.length">暂无可用的音箱或分组，请先启用音箱管理。</p>
      <div v-for="receiver in status?.receivers || []" :key="receiver.id" class="receiver-status">
        <SettingRow :title="receiver.name" subtitle="保存后生效；关闭插件入口不影响音箱的原生 DLNA。">
          <SlSwitch :model-value="form.enabled_ids.includes(receiver.id)" :disabled="saving || !status?.host_supported || (!receiver.available && !form.enabled_ids.includes(receiver.id))" :aria-label="`为 ${receiver.name} 启用插件 DLNA`" @update:model-value="selectReceiver(receiver.id, $event)" />
        </SettingRow>
        <p v-if="receiver.group_id">分组 · {{ receiver.members.length }} 台音箱；进度和查询音量以首台音箱为参考。</p>
        <p>{{ receiver.running ? playbackLabel(receiver.state) : !receiver.enabled ? '插件入口已关闭' : !status?.enabled ? '总开关已关闭' : receiver.available ? '未运行' : '不可用' }}</p>
        <p v-if="receiver.error" role="alert">{{ receiver.error }}</p>
      </div>
      <SlButton :disabled="saving || !status" variant="filled" :label="saving ? '正在保存…' : '保存接收器设置'" @click="save" />
    </div>
  </SectionCard>
</template>
