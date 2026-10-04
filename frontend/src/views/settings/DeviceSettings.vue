<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import SectionCard from '../../ui/SectionCard.vue';
import SettingRow from '../../ui/SettingRow.vue';
import SlButton from '../../ui/SlButton.vue';
import SlCheckbox from '../../ui/SlCheckbox.vue';
import SlInput from '../../ui/SlInput.vue';
import SlSelect from '../../ui/SlSelect.vue';
import SlSwitch from '../../ui/SlSwitch.vue';
import SlDisclosure from '../../ui/SlDisclosure.vue';
import DLNAReceiverSettings from './DLNAReceiverSettings.vue';
import { postEnvelope } from '../../api';
import { navigation } from '../../runtime';
import { deviceId, deviceName, confirmAction, deleteGroup, loadAccountsAndDevices, loadGroups, messageOf, saveConfig, saveGroup, state, toggleManaged, notify } from '../../store';
import type { DeviceGroup, DeviceMember, SelectOption } from '../../types';

const authTab = ref<'qrcode' | 'password' | 'token'>('qrcode');
const serverChoice = ref(state.config.server_host || '');
const customHost = ref('');
const username = ref('');
const password = ref('');
const tokenUserId = ref('');
const passToken = ref('');
const captcha = ref('');
const captchaImage = ref('');
const verifyCode = ref('');
const verifyUrl = ref('');
const loginAccountId = ref('');
const loginBusy = ref(false);
const loginMessage = ref('');
const qrUrl = ref('');
const qrStatus = ref('');
const qrBusy = ref(false);
const groupEditor = ref(false);
const editGroupId = ref('');
const groupName = ref('');
const selectedMembers = ref<string[]>([]);
let qrTimer: ReturnType<typeof setTimeout> | null = null;
// 每次 startQr 自增的代次；旧 pollQrOnce 发现 gen 不匹配即退出，
// 避免用户连点"获取二维码"时旧轮询链劫持新一轮（旧链 resolved 后用旧 account_id 重排）。
let qrGen = 0;

const hostOptions = computed<SelectOption[]>(() => [
  ...(Array.isArray(state.config.suggested_addresses) ? state.config.suggested_addresses : []).map((value) => ({ value, label: value })),
  { value: '__custom__', label: '自定义地址' },
]);
const isCustomHost = computed(() => serverChoice.value === '__custom__');
const managed = computed(() => state.devices.flatMap((account) => account.devices.filter((device) => device.managed).map((device) => ({ accountId: account.account_id, device }))));
const accountStatuses = computed(() => state.accounts);
function isDeviceOnline(device: { online?: boolean; presence?: string }): boolean { return device.online === true || device.presence === 'online'; }

onMounted(() => {
  const suggested = Array.isArray(state.config.suggested_addresses) ? state.config.suggested_addresses : [];
  serverChoice.value = suggested.includes(state.config.server_host) ? state.config.server_host : (state.config.server_host ? '__custom__' : '');
  customHost.value = state.config.server_host;
  void Promise.all([loadAccountsAndDevices(), loadGroups()]);
});
watch(groupEditor, (open) => { navigation.editorOpen = open; });
onUnmounted(() => {
  navigation.editorOpen = false;
  qrGen++; // 让任何在飞的 pollQrOnce 因 gen 不匹配而退出
  stopQrPolling();
});

async function saveServerHost() {
  const host = (isCustomHost.value ? customHost.value : serverChoice.value).trim();
  if (!host) { notify('请选择或填写服务器地址', 'warning'); return; }
  await saveConfig({ server_host: host });
  state.config.server_host_status = host.includes('localhost') || host.includes('127.0.0.1') ? 'loopback' : 'ok';
}
async function autoFill() {
  const origin = window.location.origin || `${window.location.protocol}//${window.location.host}`;
  console.log('[autoFill] browser origin:', origin);
  if (!origin || origin === 'null') {
    console.warn('[autoFill] cannot detect browser origin');
    notify('未检测到浏览器地址', 'warning');
    return;
  }
  // 如果 origin 不在下拉列表的可选项中，切到自定义地址
  const suggested = Array.isArray(state.config.suggested_addresses) ? state.config.suggested_addresses : [];
  console.log('[autoFill] suggested addresses:', suggested);
  if (suggested.includes(origin)) {
    serverChoice.value = origin;
  } else {
    serverChoice.value = '__custom__';
  }
  customHost.value = origin;
  const isLoopback = origin.includes('localhost') || origin.includes('127.0.0.1') || origin.includes('::1') || origin.includes('[::1]');
  if (isLoopback) {
    notify('已填入浏览器地址，但 localhost/127.0.0.1 仅限本机调试，音箱无法访问', 'warning');
  } else {
    notify('已填入浏览器地址', 'info');
  }
}
async function submitPassword() {
  if (!username.value.trim() || !password.value) { notify('请填写用户名和密码', 'warning'); return; }
  loginBusy.value = true;
  try {
    const result = await postEnvelope<Record<string, unknown>>('/auth/login', { username: username.value.trim(), password: password.value });
    loginAccountId.value = String(result.account_id || username.value.trim());
    loginMessage.value = String(result.message || '');
    if (result.state === 'need_captcha' || result.state === 1) {
      captchaImage.value = String(result.captcha_url || '');
      captcha.value = '';
      loginMessage.value = captchaImage.value ? '请输入图形验证码' : '需要图形验证码，但未获取到验证码图片（见插件日志）';
    }
    else if (result.state === 'need_verify' || result.state === 2) { verifyUrl.value = String(result.verify_url || ''); verifyCode.value = ''; loginMessage.value = '请完成二次验证后输入验证码'; }
    else if (result.state === 'success' || result.state === 0) { notify('账号登录成功', 'success'); username.value = ''; password.value = ''; captchaImage.value = ''; loginMessage.value = ''; await loadAccountsAndDevices(); }
    else { loginMessage.value = String(result.message || '登录失败'); notify(loginMessage.value, 'error'); }
  } catch (error) { loginMessage.value = messageOf(error); notify(loginMessage.value, 'error'); }
  finally { loginBusy.value = false; }
}
async function submitCaptcha() {
  if (!captcha.value) return;
  try {
    const result = await postEnvelope<Record<string, unknown>>('/auth/captcha', { account_id: loginAccountId.value, captcha: captcha.value });
    loginMessage.value = String(result.message || '');
    if (result.state === 'need_captcha' || result.state === 1) {
      captchaImage.value = String(result.captcha_url || '');
      captcha.value = '';
      loginMessage.value = captchaImage.value ? '验证码错误，请重新输入' : '验证码错误，且未获取到新图片（见插件日志）';
    }
    else if (result.state === 'need_verify' || result.state === 2) { verifyUrl.value = String(result.verify_url || ''); loginMessage.value = '请完成二次验证后输入验证码'; }
    else if (result.state === 'success' || result.state === 0) { captchaImage.value = ''; captcha.value = ''; loginMessage.value = ''; notify('登录成功', 'success'); await loadAccountsAndDevices(); }
    else { loginMessage.value = String(result.message || '验证失败'); notify(loginMessage.value, 'error'); }
  } catch (error) { loginMessage.value = messageOf(error); notify(loginMessage.value, 'error'); }
}
async function submitVerify() {
  if (!verifyCode.value) return;
  try { const result = await postEnvelope<Record<string, unknown>>('/auth/verify', { account_id: loginAccountId.value, code: verifyCode.value }); loginMessage.value = String(result.message || ''); notify('登录成功', 'success'); await loadAccountsAndDevices(); } catch (error) { notify(messageOf(error), 'error'); }
}
function openVerifyPage() {
  if (verifyUrl.value) window.open(verifyUrl.value, '_blank', 'noopener,noreferrer');
}
async function addToken() {
  if (!tokenUserId.value.trim() || !passToken.value.trim()) { notify('请填写 User ID 和 Pass Token', 'warning'); return; }
  try { await postEnvelope('/auth/token', { user_id: tokenUserId.value.trim(), pass_token: passToken.value.trim() }); notify('Token 账号添加成功', 'success'); tokenUserId.value = ''; passToken.value = ''; await loadAccountsAndDevices(); } catch (error) { notify(messageOf(error), 'error'); }
}
function stopQrPolling() {
  if (qrTimer) { clearTimeout(qrTimer); qrTimer = null; }
}
async function pollQrOnce(gen: number) {
  if (gen !== qrGen) return; // 已被新的 startQr 或卸载取代
  let keepGoing = true;
  try {
    const poll = await postEnvelope<Record<string, unknown>>('/auth/qrcode/poll', { account_id: loginAccountId.value });
    if (gen !== qrGen) return; // await 期间被取代，丢弃这一轮结果
    if (poll.state === 'success') {
      stopQrPolling(); keepGoing = false;
      if (poll.account_id) loginAccountId.value = String(poll.account_id);
      qrStatus.value = '登录成功'; notify('扫码登录成功', 'success'); await loadAccountsAndDevices();
    } else if (poll.state === 'expired' || poll.state === 'timeout' || poll.state === 'error') {
      stopQrPolling(); keepGoing = false;
      qrStatus.value = String(poll.message || '二维码已过期');
    }
    // state === 'waiting'：继续轮询
  } catch { /* 瞬时错误：继续轮询，不打断 */ }
  if (keepGoing && gen === qrGen) {
    // 串行：上一轮完全结束后再排下一轮，避免并发长轮询把小米 lp 端点打成“已过期”
    qrTimer = setTimeout(() => pollQrOnce(gen), 3000);
  }
}
async function startQr() {
  stopQrPolling();
  const gen = ++qrGen;
  qrBusy.value = true; qrStatus.value = '正在获取二维码'; qrUrl.value = '';
  try {
    const result = await postEnvelope<Record<string, unknown>>('/auth/qrcode', {});
    if (gen !== qrGen) return; // 取二维码期间用户又点了一次，让最后那次主导
    loginAccountId.value = String(result.account_id || ''); qrUrl.value = String(result.qrcode_url || ''); qrStatus.value = '请使用米家 App 扫码'; qrBusy.value = false;
    // 首次延迟 1.5s，之后 pollQrOnce 串行自驱动（上一轮结束 → 3s 后下一轮）
    qrTimer = setTimeout(() => pollQrOnce(gen), 1500);
  } catch (error) { if (gen === qrGen) { qrBusy.value = false; qrStatus.value = messageOf(error); notify(qrStatus.value, 'error'); } }
}
async function relogin(id: string) { try { await postEnvelope('/auth/relogin', { account_id: id }); notify('重新登录成功', 'success'); await loadAccountsAndDevices(); } catch (error) { notify(messageOf(error), 'warning'); } }
async function removeAccount(id: string) { if ((await confirmAction('删除账号', `确定删除账号“${id}”吗？此操作不可撤销。`, '删除', true)).confirmed) { try { await import('../../api').then(({ del }) => del(`/account?account_id=${encodeURIComponent(id)}`)); notify('账号已删除', 'success'); await loadAccountsAndDevices(); } catch (error) { notify(messageOf(error), 'error'); } } }
async function setManaged(accountId: string, id: string, value: boolean) { try { await toggleManaged(accountId, id, value); } catch (error) { notify(messageOf(error), 'error'); } }

function openGroup(group?: DeviceGroup) { groupEditor.value = true; editGroupId.value = group?.id || ''; groupName.value = group?.name || ''; selectedMembers.value = (group?.members || []).map((member) => `${member.account_id}:${member.device_id}`); }
function closeGroup() { groupEditor.value = false; }
async function saveCurrentGroup() { if (!groupName.value.trim() || selectedMembers.value.length < 2) { notify('请输入分组名称并至少选择两台设备', 'warning'); return; } const members: DeviceMember[] = selectedMembers.value.map((value) => { const [account_id, device_id] = value.split(':'); return { account_id, device_id }; }); try { await saveGroup({ id: editGroupId.value || undefined, name: groupName.value.trim(), members }); closeGroup(); } catch (error) { notify(messageOf(error), 'error'); } }
async function removeGroup(id: string) { if ((await confirmAction('删除设备分组', '删除后成员会恢复为独立设备播放。', '删除', true)).confirmed) { try { await deleteGroup(id); } catch (error) { notify(messageOf(error), 'error'); } } }

// 用户账号下所有设备去重后的型号（hardware 优先）。设置项以设备实际存在的型号为主，
// 未在设备列表中出现的默认清单项以徽章形式提示。
interface MusicApiModelRow { hardware: string; deviceName: string; inDefaults: boolean; }
const musicApiModelRows = computed<MusicApiModelRow[]>(() => {
  const rows = new Map<string, MusicApiModelRow>();
  for (const account of state.devices) {
    for (const device of account.devices) {
      const hw = (device.hardware || device.model || '').trim().toUpperCase();
      if (!hw) continue;
      if (!rows.has(hw)) {
        rows.set(hw, {
          hardware: hw,
          deviceName: deviceName(device),
          inDefaults: state.config.music_api_model_defaults.includes(hw),
        });
      }
    }
  }
  return Array.from(rows.values()).sort((a, b) => a.hardware.localeCompare(b.hardware));
});
const defaultsMissingFromDevices = computed(() => {
  const seen = new Set(musicApiModelRows.value.map((row) => row.hardware));
  return (state.config.music_api_model_defaults || []).filter((hw) => !seen.has(hw));
});
function isMusicApiEnabled(hardware: string): boolean {
  const disabled = state.config.music_api_model_disabled || [];
  if (disabled.includes(hardware)) return false;
  return (state.config.music_api_model_defaults || []).includes(hardware);
}
async function toggleMusicApi(hardware: string, enabled: boolean): Promise<void> {
  const defaults = state.config.music_api_model_defaults || [];
  const current = new Set(state.config.music_api_model_disabled || []);
  if (enabled) {
    current.delete(hardware);
  } else if (defaults.includes(hardware)) {
    // 默认启用的型号才需要显式禁用；不在默认里的型号本就不走 Music API，不用记录。
    current.add(hardware);
  }
  await saveConfig({ music_api_model_disabled: Array.from(current) });
}
</script>

<template>
  <SectionCard title="服务器配置" icon="dns" description="音箱必须能访问这里填写的地址；localhost 和 127.0.0.1 只适合浏览器本机调试。">
    <div class="form-body">
      <div class="field"><label class="field-label">服务器地址</label><SlSelect v-model="serverChoice" :options="hostOptions" placeholder="选择服务器地址" allow-empty aria-label="服务器地址" /><SlInput v-if="isCustomHost" v-model="customHost" style="margin-top:8px" placeholder="例如 http://192.168.1.100:58091" aria-label="自定义服务器地址" /></div>
      <div v-if="state.config.server_host_status !== 'ok'" class="field-help">{{ state.config.server_host_status === 'loopback' ? '当前地址为本地回环地址，音箱无法访问。' : '尚未配置可用地址。' }}</div>
      <div class="field-actions"><SlButton variant="text" label="自动填充" icon="auto_fix_high" @click="autoFill" /><SlButton variant="filled" label="保存" icon="save" @click="saveServerHost" /></div>
    </div>
  </SectionCard>

  <SectionCard title="添加账号" icon="person_add" description="支持扫码、账号密码和手动 Token 三种登录方式。">
    <div class="tab-strip"><button :class="{ active: authTab === 'qrcode' }" @click="authTab = 'qrcode'">扫码登录</button><button :class="{ active: authTab === 'password' }" @click="authTab = 'password'">账号密码</button><button :class="{ active: authTab === 'token' }" @click="authTab = 'token'">手动 Token</button></div>
    <div class="form-body">
      <template v-if="authTab === 'qrcode'"><p class="field-help">使用米家 App 扫描二维码，扫码成功后会自动创建账号。</p><SlButton variant="filled" block label="获取二维码" icon="qr_code_2" :disabled="qrBusy" @click="startQr" /><div v-if="qrUrl" class="qr-box"><img :src="qrUrl" alt="登录二维码" /><p>{{ qrStatus }}</p></div><p v-else-if="qrStatus" class="field-help">{{ qrStatus }}</p></template>
      <template v-else-if="authTab === 'password'"><div class="field"><label class="field-label">用户名</label><SlInput v-model="username" placeholder="手机号或邮箱" aria-label="用户名" /></div><div class="field"><label class="field-label">密码</label><SlInput v-model="password" type="password" placeholder="密码" aria-label="密码" @submit="submitPassword" /></div><SlButton variant="filled" block label="登录并添加" icon="login" :disabled="loginBusy" @click="submitPassword" /><p v-if="loginMessage" class="field-help">{{ loginMessage }}</p><div v-if="loginMessage.includes('验证码')" class="sub-panel"><img v-if="captchaImage" :src="'data:image/png;base64,' + captchaImage" alt="图形验证码" class="captcha-img" /><SlInput v-model="captcha" placeholder="输入图形验证码" aria-label="验证码" /><SlButton variant="filled" label="提交验证码" @click="submitCaptcha" /></div><div v-if="verifyUrl || loginMessage.includes('二次')" class="sub-panel"><SlButton variant="outlined" label="打开验证页面" icon="open_in_new" @click="openVerifyPage" /><div class="inline-fields" style="margin-top:8px"><SlInput v-model="verifyCode" placeholder="验证码" aria-label="二次验证码" /><SlButton variant="filled" label="提交" @click="submitVerify" /></div></div></template>
      <template v-else><p class="field-help">从浏览器 Cookie 中获取 userId 和 passToken。凭据只发送给 MIoT 插件，不会显示在日志中。</p><div class="field"><label class="field-label">User ID</label><SlInput v-model="tokenUserId" placeholder="Cookie 中的 userId" aria-label="User ID" /></div><div class="field"><label class="field-label">Pass Token</label><SlInput v-model="passToken" type="password" placeholder="Cookie 中的 passToken" aria-label="Pass Token" /></div><SlButton variant="filled" block label="添加账号" icon="key" @click="addToken" /></template>
    </div>
  </SectionCard>

  <SectionCard title="已登录账号" icon="group">
    <div class="form-body"><div v-if="!accountStatuses.length" class="empty-state">暂无账号，请先添加</div><div v-for="account in accountStatuses" :key="account.id" class="list-item"><div class="list-item-copy"><strong class="list-item-title">{{ account.account_name || account.account || account.id }}</strong><span class="list-item-subtitle">{{ account.logged_in && account.is_valid !== false ? '已登录' : '需要重新登录' }}<span v-if="account.user_id"> · User ID {{ account.user_id }}</span></span></div><span class="chip" :class="account.logged_in && account.is_valid !== false ? 'chip-success' : 'chip-warning'">{{ account.logged_in && account.is_valid !== false ? '正常' : '待处理' }}</span><SlButton variant="icon" icon="refresh" title="重新登录" @click="relogin(account.id)" /><SlButton variant="icon" icon="delete" title="删除账号" @click="removeAccount(account.id)" /></div></div>
  </SectionCard>

  <SectionCard title="设备管理" icon="speaker_group" description="开启管理后，设备才会出现在播放选择器、分组和定时任务中。">
    <div class="form-body"><div v-if="!state.devices.length" class="empty-state">暂无设备，请先登录账号并刷新。</div><div v-for="account in state.devices" :key="account.account_id" class="device-account"><h3 class="card-title">{{ account.account_name || account.account_id }}</h3><div v-for="device in account.devices" :key="deviceId(device)" class="device-check-row"><SlCheckbox :model-value="!!device.managed" :aria-label="`管理 ${deviceName(device)}`" @update:model-value="setManaged(account.account_id, deviceId(device), $event)" /><div class="device-check-copy"><strong>{{ deviceName(device) }}</strong><small>{{ device.model || device.hardware || '未知型号' }} · {{ isDeviceOnline(device) ? '在线' : '离线' }}</small></div><span class="chip" :class="isDeviceOnline(device) ? 'chip-success' : 'chip-warning'">{{ isDeviceOnline(device) ? '在线' : '离线' }}</span></div></div></div>
  </SectionCard>

  <SectionCard title="设备分组" icon="speaker_group" description="组内设备共享队列、播放模式和控制操作；一台设备只能属于一个组。">
    <div class="form-body"><SlButton variant="filled" block label="新建分组" icon="add" @click="openGroup()" /><div v-if="groupEditor" class="sub-panel"><div class="field"><label class="field-label">分组名称</label><SlInput v-model="groupName" placeholder="例如 客厅 + 卧室" aria-label="分组名称" /></div><label class="field-label">选择至少两台已管理设备</label><div v-for="item in managed" :key="`${item.accountId}:${deviceId(item.device)}`" class="device-check-row"><SlCheckbox :model-value="selectedMembers.includes(`${item.accountId}:${deviceId(item.device)}`)" @update:model-value="(value) => value ? selectedMembers.push(`${item.accountId}:${deviceId(item.device)}`) : selectedMembers = selectedMembers.filter((key) => key !== `${item.accountId}:${deviceId(item.device)}`)" /><div class="device-check-copy"><strong>{{ deviceName(item.device) }}</strong><small>{{ item.accountId }}</small></div></div><div class="field-actions"><SlButton variant="text" label="取消" @click="closeGroup" /><SlButton variant="filled" label="保存" icon="save" @click="saveCurrentGroup" /></div></div><div v-if="!state.groups.length && !groupEditor" class="empty-state">暂无分组</div><div v-for="group in state.groups" :key="group.id" class="list-item"><div class="list-item-copy"><strong class="list-item-title">{{ group.name }}</strong><span class="list-item-subtitle">{{ group.members.length }} 台设备</span></div><SlButton variant="icon" icon="edit" title="编辑分组" @click="openGroup(group)" /><SlButton variant="icon" icon="delete" title="删除分组" @click="removeGroup(group.id)" /></div></div>
  </SectionCard>

  <DLNAReceiverSettings />

  <SlDisclosure title="高级设备兼容" icon="speaker" description="按设备型号调整 Music API 与指示灯行为。">
    <div class="form-body">
      <label class="field-label">按型号选择播放方式</label>
      <p v-if="!musicApiModelRows.length" class="field-help">尚未识别到任何设备型号，登录并开启设备管理后会出现在这里。</p>
      <div v-for="row in musicApiModelRows" :key="row.hardware" class="device-check-row">
        <SlCheckbox :model-value="isMusicApiEnabled(row.hardware)" :disabled="!row.inDefaults" :aria-label="`使用 Music API 播放 ${row.hardware}`" @update:model-value="toggleMusicApi(row.hardware, $event)" />
        <div class="device-check-copy">
          <strong>{{ row.hardware }}</strong>
          <small>{{ row.deviceName }}{{ row.inDefaults ? ' · 默认使用 Music API' : ' · 默认使用直链播放' }}</small>
        </div>
        <span v-if="row.inDefaults" class="chip chip-success">默认</span>
      </div>
      <p v-if="defaultsMissingFromDevices.length" class="field-help">
        默认清单中未在当前账号出现的型号：
        <span v-for="hw in defaultsMissingFromDevices" :key="hw" class="chip" style="margin-left:6px">{{ hw }}</span>
      </p>
    </div>
    <SettingRow title="播放时保持指示灯" subtitle="关闭后播放时音箱指示灯不亮，适合夜间使用"><SlSwitch v-model="state.config.indicator_light_enabled" aria-label="播放时保持指示灯" @update:model-value="saveConfig({ indicator_light_enabled: $event })" /></SettingRow>
  </SlDisclosure>
</template>
