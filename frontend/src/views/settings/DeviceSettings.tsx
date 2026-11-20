import {
  displayText,
  usePageState,
  NativeView,
  classes,
  styleObject,
  renderItems,
} from "../../page-state";
import { computed, onMounted, onUnmounted, ref, watch } from "../../page-state";
import SectionCard from "../../ui/SectionCard.tsx";
import SettingRow from "../../ui/SettingRow.tsx";
import SlButton from "../../ui/SlButton.tsx";
import SlCheckbox from "../../ui/SlCheckbox.tsx";
import SlInput from "../../ui/SlInput.tsx";
import SlSelect from "../../ui/SlSelect.tsx";
import SlSwitch from "../../ui/SlSwitch.tsx";
import SlDisclosure from "../../ui/SlDisclosure.tsx";
import DLNAReceiverSettings from "./DLNAReceiverSettings.tsx";
import { del, postEnvelope } from "../../api";
import { serverUrl, openExternal, navigation } from "../../runtime";
import {
  deviceId,
  deviceName,
  confirmAction,
  deleteGroup,
  deleteProgressGroup,
  loadAccountsAndDevices,
  loadGroups,
  loadProgressGroups,
  messageOf,
  saveConfig,
  saveGroup,
  saveProgressGroup,
  state,
  toggleManaged,
  notify,
} from "../../store";
import type { DeviceGroup, DeviceMember, ProgressGroup, SelectOption } from "../../types";
interface MusicApiModelRow {
  hardware: string;
  deviceName: string;
  inDefaults: boolean;
}
const pageState = {
  name: "DeviceSettings",
  createState(input, {}) {
    const authTab = ref<"qrcode" | "password" | "token">("qrcode");
    const serverChoice = ref(state.config.server_host || "");
    const customHost = ref("");
    const username = ref("");
    const password = ref("");
    const tokenUserId = ref("");
    const passToken = ref("");
    const captcha = ref("");
    const captchaImage = ref("");
    const verifyCode = ref("");
    const verifyUrl = ref("");
    const loginAccountId = ref("");
    const loginBusy = ref(false);
    const loginMessage = ref("");
    const qrUrl = ref("");
    const qrStatus = ref("");
    const qrBusy = ref(false);
    const groupEditor = ref(false);
    const editGroupId = ref("");
    const groupName = ref("");
    const selectedMembers = ref<string[]>([]);
    const progressGroupEditor = ref(false);
    const editProgressGroupId = ref("");
    const progressGroupName = ref("");
    const selectedProgressMembers = ref<string[]>([]);
    let qrTimer: ReturnType<typeof setTimeout> | null = null;
    // 每次 startQr 自增的代次；旧 pollQrOnce 发现 gen 不匹配即退出，
    // 避免用户连点"获取二维码"时旧轮询链劫持新一轮（旧链 resolved 后用旧 account_id 重排）。
    let qrGen = 0;
    const hostOptions = computed<SelectOption[]>(() => [
      ...(Array.isArray(state.config.suggested_addresses)
        ? state.config.suggested_addresses
        : []
      ).map((value) => ({ value, label: value })),
      { value: "__custom__", label: "自定义地址" },
    ]);
    const isCustomHost = computed(() => serverChoice.value === "__custom__");
    const managed = computed(() =>
      state.devices.flatMap((account) =>
        account.devices
          .filter((device) => device.managed)
          .map((device) => ({ accountId: account.account_id, device })),
      ),
    );
    const accountStatuses = computed(() => state.accounts);
    function isDeviceOnline(device: {
      online?: boolean;
      presence?: string;
    }): boolean {
      return device.online === true || device.presence === "online";
    }
    onMounted(() => {
      const suggested = Array.isArray(state.config.suggested_addresses)
        ? state.config.suggested_addresses
        : [];
      serverChoice.value = suggested.includes(state.config.server_host)
        ? state.config.server_host
        : state.config.server_host
          ? "__custom__"
          : "";
      customHost.value = state.config.server_host;
      if (input.active !== false) void refreshDevices();
    });
    function refreshDevices() {
      return Promise.all([loadAccountsAndDevices(), loadGroups(), loadProgressGroups()]).catch(
        (error) => notify(messageOf(error), "error"),
      );
    }
    watch(
      () => input.active,
      (active) => {
        if (active === false) {
          stopQrPolling();
          return;
        }
        void refreshDevices();
        scheduleQrPoll(0);
      },
    );
    watch(groupEditor, (open) => {
      navigation.editorOpen = open;
    });
    watch(
      () => navigation.editorOpen,
      (open) => {
        if (!open) groupEditor.value = false;
      },
    );
    onUnmounted(() => {
      navigation.editorOpen = false;
      qrGen++; // 让任何在飞的 pollQrOnce 因 gen 不匹配而退出
      stopQrPolling();
    });
    async function saveServerHost() {
      const host = (
        isCustomHost.value ? customHost.value : serverChoice.value
      ).trim();
      if (!host) {
        notify("请选择或填写服务器地址", "warning");
        return;
      }
      await saveConfig({ server_host: host });
      state.config.server_host_status =
        host.includes("localhost") || host.includes("127.0.0.1")
          ? "loopback"
          : "ok";
    }
    async function autoFill() {
      const origin = serverUrl();
      console.log("[autoFill] browser origin:", origin);
      if (!origin || origin === "null") {
        console.warn("[autoFill] cannot detect browser origin");
        notify("未检测到浏览器地址", "warning");
        return;
      }
      // 如果 origin 不在下拉列表的可选项中，切到自定义地址
      const suggested = Array.isArray(state.config.suggested_addresses)
        ? state.config.suggested_addresses
        : [];
      console.log("[autoFill] suggested addresses:", suggested);
      if (suggested.includes(origin)) {
        serverChoice.value = origin;
      } else {
        serverChoice.value = "__custom__";
      }
      customHost.value = origin;
      const isLoopback =
        origin.includes("localhost") ||
        origin.includes("127.0.0.1") ||
        origin.includes("::1") ||
        origin.includes("[::1]");
      if (isLoopback) {
        notify(
          "已填入浏览器地址，但 localhost/127.0.0.1 仅限本机调试，音箱无法访问",
          "warning",
        );
      } else {
        notify("已填入浏览器地址", "info");
      }
    }
    async function submitPassword() {
      if (!username.value.trim() || !password.value) {
        notify("请填写用户名和密码", "warning");
        return;
      }
      loginBusy.value = true;
      try {
        const result = await postEnvelope<Record<string, unknown>>(
          "/auth/login",
          { username: username.value.trim(), password: password.value },
        );
        loginAccountId.value = String(
          result.account_id || username.value.trim(),
        );
        loginMessage.value = String(result.message || "");
        if (result.state === "need_captcha" || result.state === 1) {
          captchaImage.value = String(result.captcha_url || "");
          captcha.value = "";
          loginMessage.value = captchaImage.value
            ? "请输入图形验证码"
            : "需要图形验证码，但未获取到验证码图片（见插件日志）";
        } else if (result.state === "need_verify" || result.state === 2) {
          verifyUrl.value = String(result.verify_url || "");
          verifyCode.value = "";
          loginMessage.value = "请完成二次验证后输入验证码";
        } else if (result.state === "success" || result.state === 0) {
          notify("账号登录成功", "success");
          username.value = "";
          password.value = "";
          captchaImage.value = "";
          loginMessage.value = "";
          await loadAccountsAndDevices();
        } else {
          loginMessage.value = String(result.message || "登录失败");
          notify(loginMessage.value, "error");
        }
      } catch (error) {
        loginMessage.value = messageOf(error);
        notify(loginMessage.value, "error");
      } finally {
        loginBusy.value = false;
      }
    }
    async function submitCaptcha() {
      if (!captcha.value) return;
      try {
        const result = await postEnvelope<Record<string, unknown>>(
          "/auth/captcha",
          { account_id: loginAccountId.value, captcha: captcha.value },
        );
        loginMessage.value = String(result.message || "");
        if (result.state === "need_captcha" || result.state === 1) {
          captchaImage.value = String(result.captcha_url || "");
          captcha.value = "";
          loginMessage.value = captchaImage.value
            ? "验证码错误，请重新输入"
            : "验证码错误，且未获取到新图片（见插件日志）";
        } else if (result.state === "need_verify" || result.state === 2) {
          verifyUrl.value = String(result.verify_url || "");
          loginMessage.value = "请完成二次验证后输入验证码";
        } else if (result.state === "success" || result.state === 0) {
          captchaImage.value = "";
          captcha.value = "";
          loginMessage.value = "";
          notify("登录成功", "success");
          await loadAccountsAndDevices();
        } else {
          loginMessage.value = String(result.message || "验证失败");
          notify(loginMessage.value, "error");
        }
      } catch (error) {
        loginMessage.value = messageOf(error);
        notify(loginMessage.value, "error");
      }
    }
    async function submitVerify() {
      if (!verifyCode.value) return;
      try {
        const result = await postEnvelope<Record<string, unknown>>(
          "/auth/verify",
          { account_id: loginAccountId.value, code: verifyCode.value },
        );
        loginMessage.value = String(result.message || "");
        notify("登录成功", "success");
        await loadAccountsAndDevices();
      } catch (error) {
        notify(messageOf(error), "error");
      }
    }
    function openVerifyPage() {
      if (verifyUrl.value) void openExternal(verifyUrl.value);
    }
    async function addToken() {
      if (!tokenUserId.value.trim() || !passToken.value.trim()) {
        notify("请填写 User ID 和 Pass Token", "warning");
        return;
      }
      try {
        await postEnvelope("/auth/token", {
          user_id: tokenUserId.value.trim(),
          pass_token: passToken.value.trim(),
        });
        notify("Token 账号添加成功", "success");
        tokenUserId.value = "";
        passToken.value = "";
        await loadAccountsAndDevices();
      } catch (error) {
        notify(messageOf(error), "error");
      }
    }
    let qrWaiting = false;
    let qrPollingGeneration: number | undefined;
    function scheduleQrPoll(delay: number) {
      if (
        input.active === false ||
        !qrWaiting ||
        qrTimer ||
        qrPollingGeneration === qrGen
      )
        return;
      const gen = qrGen;
      qrTimer = setTimeout(() => {
        qrTimer = null;
        void pollQrOnce(gen);
      }, delay);
    }
    function stopQrPolling() {
      if (qrTimer) {
        clearTimeout(qrTimer);
        qrTimer = null;
      }
    }
    async function pollQrOnce(gen: number) {
      if (gen !== qrGen || input.active === false) return;
      qrPollingGeneration = gen;
      try {
        const poll = await postEnvelope<Record<string, unknown>>(
          "/auth/qrcode/poll",
          { account_id: loginAccountId.value },
        );
        if (gen !== qrGen) return; // await 期间被取代，丢弃这一轮结果
        if (poll.state === "success") {
          stopQrPolling();
          qrWaiting = false;
          if (poll.account_id) loginAccountId.value = String(poll.account_id);
          qrStatus.value = "登录成功";
          notify("扫码登录成功", "success");
          if (input.active !== false) await loadAccountsAndDevices();
        } else if (
          poll.state === "expired" ||
          poll.state === "timeout" ||
          poll.state === "error"
        ) {
          stopQrPolling();
          qrWaiting = false;
          qrStatus.value = String(poll.message || "二维码已过期");
        }
        // state === 'waiting'：继续轮询
      } catch {
        /* 瞬时错误：继续轮询，不打断 */
      } finally {
        if (qrPollingGeneration === gen) qrPollingGeneration = undefined;
        if (gen === qrGen) scheduleQrPoll(3000);
      }
    }
    async function startQr() {
      stopQrPolling();
      const gen = ++qrGen;
      qrWaiting = false;
      qrBusy.value = true;
      qrStatus.value = "正在获取二维码";
      qrUrl.value = "";
      try {
        const result = await postEnvelope<Record<string, unknown>>(
          "/auth/qrcode",
          {},
        );
        if (gen !== qrGen) return; // 取二维码期间用户又点了一次，让最后那次主导
        loginAccountId.value = String(result.account_id || "");
        qrUrl.value = String(result.qrcode_url || "");
        qrStatus.value = "请使用米家 App 扫码";
        qrBusy.value = false;
        // 首次延迟 1.5s，之后 pollQrOnce 串行自驱动（上一轮结束 → 3s 后下一轮）
        qrWaiting = true;
        scheduleQrPoll(1500);
      } catch (error) {
        if (gen === qrGen) {
          qrBusy.value = false;
          qrStatus.value = messageOf(error);
          notify(qrStatus.value, "error");
        }
      }
    }
    async function relogin(id: string) {
      try {
        await postEnvelope("/auth/relogin", { account_id: id });
        notify("重新登录成功", "success");
        await loadAccountsAndDevices();
      } catch (error) {
        notify(messageOf(error), "warning");
      }
    }
    async function removeAccount(id: string) {
      if (
        (
          await confirmAction(
            "删除账号",
            `确定删除账号“${id}”吗？此操作不可撤销。`,
            "删除",
            true,
          )
        ).confirmed
      ) {
        try {
          await del(`/account?account_id=${encodeURIComponent(id)}`);
          notify("账号已删除", "success");
          await loadAccountsAndDevices();
        } catch (error) {
          notify(messageOf(error), "error");
        }
      }
    }
    async function setManaged(accountId: string, id: string, value: boolean) {
      try {
        await toggleManaged(accountId, id, value);
      } catch (error) {
        notify(messageOf(error), "error");
      }
    }
    function openGroup(group?: DeviceGroup) {
      groupEditor.value = true;
      editGroupId.value = group?.id || "";
      groupName.value = group?.name || "";
      selectedMembers.value = (group?.members || []).map(
        (member) => `${member.account_id}:${member.device_id}`,
      );
    }
    function closeGroup() {
      groupEditor.value = false;
    }
    async function saveCurrentGroup() {
      if (!groupName.value.trim() || selectedMembers.value.length < 2) {
        notify("请输入分组名称并至少选择两台设备", "warning");
        return;
      }
      const members: DeviceMember[] = selectedMembers.value.map((value) => {
        const [account_id, device_id] = value.split(":");
        return { account_id, device_id };
      });
      try {
        await saveGroup({
          id: editGroupId.value || undefined,
          name: groupName.value.trim(),
          members,
        });
        closeGroup();
      } catch (error) {
        notify(messageOf(error), "error");
      }
    }
    async function removeGroup(id: string) {
      if (
        (
          await confirmAction(
            "删除设备分组",
            "删除后成员会恢复为独立设备播放。",
            "删除",
            true,
          )
        ).confirmed
      ) {
        try {
          await deleteGroup(id);
        } catch (error) {
          notify(messageOf(error), "error");
        }
      }
    }
    function openProgressGroup(group?: ProgressGroup) {
      progressGroupEditor.value = true;
      editProgressGroupId.value = group?.id || "";
      progressGroupName.value = group?.name || "";
      selectedProgressMembers.value = (group?.members || []).map(
        (member) => `${member.account_id}:${member.device_id}`,
      );
    }
    function closeProgressGroup() {
      progressGroupEditor.value = false;
    }
    async function saveCurrentProgressGroup() {
      if (!progressGroupName.value.trim() || selectedProgressMembers.value.length < 2) {
        notify("请输入共享组名称并至少选择两台设备", "warning");
        return;
      }
      const members: DeviceMember[] = selectedProgressMembers.value.map((value) => {
        const separator = value.indexOf(":");
        return { account_id: value.slice(0, separator), device_id: value.slice(separator + 1) };
      });
      try {
        await saveProgressGroup({
          id: editProgressGroupId.value || undefined,
          name: progressGroupName.value.trim(),
          members,
        });
        closeProgressGroup();
      } catch (error) {
        notify(messageOf(error), "error");
      }
    }
    async function removeProgressGroup(id: string) {
      if (!(await confirmAction("删除播放进度共享组", "成员会恢复为各自独立进度。", "删除", true)).confirmed) return;
      try {
        await deleteProgressGroup(id);
      } catch (error) {
        notify(messageOf(error), "error");
      }
    }
    // 用户账号下所有设备去重后的型号（hardware 优先）。设置项以设备实际存在的型号为主，
    // 未在设备列表中出现的默认清单项以徽章形式提示。
    const musicApiModelRows = computed<MusicApiModelRow[]>(() => {
      const rows = new Map<string, MusicApiModelRow>();
      for (const account of state.devices) {
        for (const device of account.devices) {
          const hw = (device.hardware || device.model || "")
            .trim()
            .toUpperCase();
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
      return Array.from(rows.values()).sort((a, b) =>
        a.hardware.localeCompare(b.hardware),
      );
    });
    const defaultsMissingFromDevices = computed(() => {
      const seen = new Set(musicApiModelRows.value.map((row) => row.hardware));
      return (state.config.music_api_model_defaults || []).filter(
        (hw) => !seen.has(hw),
      );
    });
    function isMusicApiEnabled(hardware: string): boolean {
      const disabled = state.config.music_api_model_disabled || [];
      if (disabled.includes(hardware)) return false;
      return (state.config.music_api_model_defaults || []).includes(hardware);
    }
    async function toggleMusicApi(
      hardware: string,
      enabled: boolean,
    ): Promise<void> {
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
    const bindings = {
      authTab,
      serverChoice,
      customHost,
      username,
      password,
      tokenUserId,
      passToken,
      captcha,
      captchaImage,
      verifyCode,
      verifyUrl,
      loginAccountId,
      loginBusy,
      loginMessage,
      qrUrl,
      qrStatus,
      qrBusy,
      groupEditor,
      editGroupId,
      groupName,
      selectedMembers,
      progressGroupEditor,
      editProgressGroupId,
      progressGroupName,
      selectedProgressMembers,
      get qrTimer() {
        return qrTimer;
      },
      set qrTimer(v) {
        qrTimer = v;
      },
      get qrGen() {
        return qrGen;
      },
      set qrGen(v) {
        qrGen = v;
      },
      hostOptions,
      isCustomHost,
      managed,
      accountStatuses,
      isDeviceOnline,
      saveServerHost,
      autoFill,
      submitPassword,
      submitCaptcha,
      submitVerify,
      openVerifyPage,
      addToken,
      stopQrPolling,
      pollQrOnce,
      startQr,
      relogin,
      removeAccount,
      setManaged,
      openGroup,
      closeGroup,
      saveCurrentGroup,
      removeGroup,
      openProgressGroup,
      closeProgressGroup,
      saveCurrentProgressGroup,
      removeProgressGroup,
      musicApiModelRows,
      defaultsMissingFromDevices,
      isMusicApiEnabled,
      toggleMusicApi,
      SectionCard,
      SettingRow,
      SlButton,
      SlCheckbox,
      SlInput,
      SlSelect,
      SlSwitch,
      SlDisclosure,
      DLNAReceiverSettings,
      get deviceId() {
        return deviceId;
      },
      get deviceName() {
        return deviceName;
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
export default function DeviceSettings(props: any) {
  const vm = usePageState(pageState, props);
  return (
    <>
      <SectionCard
        title="服务器配置"
        saveMode="manual"
        icon="dns"
        description="音箱必须能访问这里填写的地址；localhost 和 127.0.0.1 只适合浏览器本机调试。"
      >
        <NativeView className="form-body">
          <NativeView className="field">
            <NativeView className="field-label">
              <text>服务器地址</text>
            </NativeView>
            <SlSelect
              modelValue={vm.serverChoice}
              onUpdateModelValue={($event: any) => {
                vm.serverChoice = $event;
              }}
              options={vm.hostOptions}
              placeholder="选择服务器地址"
              allowEmpty
              aria-label="服务器地址"
            ></SlSelect>
            {vm.isCustomHost ? (
              <SlInput
                modelValue={vm.customHost}
                onUpdateModelValue={($event: any) => {
                  vm.customHost = $event;
                }}
                style={styleObject("margin-top:12px")}
                placeholder="例如 http://192.168.1.100:58091"
                aria-label="自定义服务器地址"
              ></SlInput>
            ) : null}
          </NativeView>
          {vm.state.config.server_host_status !== "ok" ? (
            <NativeView className="field-help">
              <text>
                {displayText(
                  vm.state.config.server_host_status === "loopback"
                    ? "当前地址为本地回环地址，音箱无法访问。"
                    : "尚未配置可用地址。",
                )}
              </text>
            </NativeView>
          ) : null}
          <NativeView className="field-actions">
            <SlButton
              variant="text"
              label="自动填充"
              icon="auto_fix_high"
              onClick={($event: any) => {
                void vm.autoFill($event);
              }}
            ></SlButton>
            <SlButton
              variant="filled"
              label="保存"
              icon="save"
              onClick={($event: any) => {
                void vm.saveServerHost($event).catch(() => {});
              }}
            ></SlButton>
          </NativeView>
        </NativeView>
      </SectionCard>
      <SectionCard
        title="添加账号"
        icon="person_add"
        description="支持扫码、账号密码和手动 Token 三种登录方式。"
      >
        <NativeView className="tab-strip">
          <NativeView
            className={classes({ active: vm.authTab === "qrcode" })}
            bindtap={($event: any) => {
              vm.authTab = "qrcode";
            }}
            button
          >
            <text>扫码登录</text>
          </NativeView>
          <NativeView
            className={classes({ active: vm.authTab === "password" })}
            bindtap={($event: any) => {
              vm.authTab = "password";
            }}
            button
          >
            <text>账号密码</text>
          </NativeView>
          <NativeView
            className={classes({ active: vm.authTab === "token" })}
            bindtap={($event: any) => {
              vm.authTab = "token";
            }}
            button
          >
            <text>手动 Token</text>
          </NativeView>
        </NativeView>
        <NativeView className="form-body">
          {vm.authTab === "qrcode" ? (
            <>
              <NativeView className="field-help">
                <text>使用米家 App 扫描二维码，扫码成功后会自动创建账号。</text>
              </NativeView>
              <SlButton
                variant="filled"
                block
                label="获取二维码"
                icon="qr_code_2"
                disabled={vm.qrBusy}
                onClick={($event: any) => {
                  void vm.startQr($event);
                }}
              ></SlButton>
              {vm.qrUrl ? (
                <NativeView className="qr-box">
                  <image src={vm.qrUrl}></image>
                  <NativeView>
                    <text>{displayText(vm.qrStatus)}</text>
                  </NativeView>
                </NativeView>
              ) : vm.qrStatus ? (
                <NativeView className="field-help">
                  <text>{displayText(vm.qrStatus)}</text>
                </NativeView>
              ) : null}
            </>
          ) : vm.authTab === "password" ? (
            <>
              <NativeView className="field">
                <NativeView className="field-label">
                  <text>用户名</text>
                </NativeView>
                <SlInput
                  modelValue={vm.username}
                  onUpdateModelValue={($event: any) => {
                    vm.username = $event;
                  }}
                  placeholder="手机号或邮箱"
                  aria-label="用户名"
                ></SlInput>
              </NativeView>
              <NativeView className="field">
                <NativeView className="field-label">
                  <text>密码</text>
                </NativeView>
                <SlInput
                  modelValue={vm.password}
                  onUpdateModelValue={($event: any) => {
                    vm.password = $event;
                  }}
                  type="password"
                  placeholder="密码"
                  aria-label="密码"
                  onSubmit={($event: any) => {
                    void vm.submitPassword($event);
                  }}
                ></SlInput>
              </NativeView>
              <SlButton
                variant="filled"
                block
                label="登录并添加"
                icon="login"
                disabled={vm.loginBusy}
                onClick={($event: any) => {
                  void vm.submitPassword($event);
                }}
              ></SlButton>
              {vm.loginMessage ? (
                <NativeView className="field-help">
                  <text>{displayText(vm.loginMessage)}</text>
                </NativeView>
              ) : null}
              {vm.loginMessage.includes("验证码") ? (
                <NativeView className="sub-panel">
                  {vm.captchaImage ? (
                    <image
                      src={"data:image/png;base64," + vm.captchaImage}
                      className="captcha-img"
                    ></image>
                  ) : null}
                  <SlInput
                    modelValue={vm.captcha}
                    onUpdateModelValue={($event: any) => {
                      vm.captcha = $event;
                    }}
                    placeholder="输入图形验证码"
                    aria-label="验证码"
                  ></SlInput>
                  <SlButton
                    variant="filled"
                    label="提交验证码"
                    onClick={($event: any) => {
                      void vm.submitCaptcha($event);
                    }}
                  ></SlButton>
                </NativeView>
              ) : null}
              {vm.verifyUrl || vm.loginMessage.includes("二次") ? (
                <NativeView className="sub-panel">
                  <SlButton
                    variant="outlined"
                    label="打开验证页面"
                    icon="open_in_new"
                    onClick={($event: any) => {
                      void vm.openVerifyPage($event);
                    }}
                  ></SlButton>
                  <NativeView
                    className="inline-fields"
                    style={styleObject("margin-top:8px")}
                  >
                    <SlInput
                      modelValue={vm.verifyCode}
                      onUpdateModelValue={($event: any) => {
                        vm.verifyCode = $event;
                      }}
                      placeholder="验证码"
                      aria-label="二次验证码"
                    ></SlInput>
                    <SlButton
                      variant="filled"
                      label="提交"
                      onClick={($event: any) => {
                        void vm.submitVerify($event);
                      }}
                    ></SlButton>
                  </NativeView>
                </NativeView>
              ) : null}
            </>
          ) : (
            <>
              <NativeView className="field-help">
                <text>
                  从浏览器 Cookie 中获取 userId 和 passToken。凭据只发送给 MIoT
                  插件，不会显示在日志中。
                </text>
              </NativeView>
              <NativeView className="field">
                <NativeView className="field-label">
                  <text>User ID</text>
                </NativeView>
                <SlInput
                  modelValue={vm.tokenUserId}
                  onUpdateModelValue={($event: any) => {
                    vm.tokenUserId = $event;
                  }}
                  placeholder="Cookie 中的 userId"
                  aria-label="User ID"
                ></SlInput>
              </NativeView>
              <NativeView className="field">
                <NativeView className="field-label">
                  <text>Pass Token</text>
                </NativeView>
                <SlInput
                  modelValue={vm.passToken}
                  onUpdateModelValue={($event: any) => {
                    vm.passToken = $event;
                  }}
                  type="password"
                  placeholder="Cookie 中的 passToken"
                  aria-label="Pass Token"
                ></SlInput>
              </NativeView>
              <SlButton
                variant="filled"
                block
                label="添加账号"
                icon="key"
                onClick={($event: any) => {
                  void vm.addToken($event);
                }}
              ></SlButton>
            </>
          )}
        </NativeView>
      </SectionCard>
      <SectionCard title="已登录账号" icon="group">
        <NativeView className="form-body">
          {!vm.accountStatuses.length ? (
            <NativeView className="empty-state">
              <text>暂无账号，请先添加</text>
            </NativeView>
          ) : null}
          {renderItems(vm.accountStatuses, (account) => (
            <NativeView key={account.id} className="list-item">
              <NativeView className="list-item-copy">
                <NativeView className="list-item-title">
                  <text>
                    {displayText(
                      account.account_name || account.account || account.id,
                    )}
                  </text>
                </NativeView>
                <NativeView className="list-item-subtitle">
                  <text>
                    {displayText(
                      account.logged_in && account.is_valid !== false
                        ? "已登录"
                        : "需要重新登录",
                    )}
                  </text>
                  {account.user_id ? (
                    <NativeView>
                      <text> · User ID {displayText(account.user_id)}</text>
                    </NativeView>
                  ) : null}
                </NativeView>
              </NativeView>
              <NativeView
                className={classes([
                  "chip",
                  classes(
                    account.logged_in && account.is_valid !== false
                      ? "chip-success"
                      : "chip-warning",
                  ),
                ])}
              >
                <text>
                  {displayText(
                    account.logged_in && account.is_valid !== false
                      ? "正常"
                      : "待处理",
                  )}
                </text>
              </NativeView>
              <SlButton
                variant="icon"
                icon="refresh"
                title="重新登录"
                onClick={($event: any) => {
                  vm.relogin(account.id);
                }}
              ></SlButton>
              <SlButton
                variant="icon"
                icon="delete"
                title="删除账号"
                onClick={($event: any) => {
                  vm.removeAccount(account.id);
                }}
              ></SlButton>
            </NativeView>
          ))}
        </NativeView>
      </SectionCard>
      <SectionCard
        title="设备管理"
        icon="speaker_group"
        description="新发现的设备默认全部勾选。可取消勾选不需要管理的设备，已有选择会保留；仅勾选的设备参与语音监听，并显示在播放选择器、分组和定时任务中。"
      >
        <NativeView className="form-body">
          {!vm.state.devices.length ? (
            <NativeView className="empty-state">
              <text>暂无设备，请先登录账号并刷新。</text>
            </NativeView>
          ) : null}
          {renderItems(vm.state.devices, (account) => (
            <NativeView key={account.account_id} className="device-account">
              <NativeView className="card-title">
                <text>
                  {displayText(account.account_name || account.account_id)}
                </text>
              </NativeView>
              {renderItems(account.devices, (device) => (
                <NativeView
                  key={vm.deviceId(device)}
                  className="device-check-row"
                >
                  <SlCheckbox
                    modelValue={!!device.managed}
                    ariaLabel={`管理 ${vm.deviceName(device)}`}
                    onUpdateModelValue={($event: any) => {
                      vm.setManaged(
                        account.account_id,
                        vm.deviceId(device),
                        $event,
                      );
                    }}
                  ></SlCheckbox>
                  <NativeView className="device-check-copy">
                    <NativeView>
                      <text>{displayText(vm.deviceName(device))}</text>
                    </NativeView>
                    <NativeView>
                      <text>
                        {displayText(
                          device.model || device.hardware || "未知型号",
                        )}{" "}
                        ·{" "}
                        {displayText(
                          vm.isDeviceOnline(device) ? "在线" : "离线",
                        )}
                      </text>
                    </NativeView>
                  </NativeView>
                  <NativeView
                    className={classes([
                      "chip",
                      classes(
                        vm.isDeviceOnline(device)
                          ? "chip-success"
                          : "chip-warning",
                      ),
                    ])}
                  >
                    <text>
                      {displayText(vm.isDeviceOnline(device) ? "在线" : "离线")}
                    </text>
                  </NativeView>
                </NativeView>
              ))}
            </NativeView>
          ))}
        </NativeView>
      </SectionCard>
      <SectionCard
        title="设备分组"
        icon="speaker_group"
        description="组内设备共享队列、播放模式和控制操作；一台设备只能属于一个组。"
      >
        <NativeView className="form-body">
          <SlButton
            variant="filled"
            block
            label="新建分组"
            icon="add"
            onClick={($event: any) => {
              vm.openGroup();
            }}
          ></SlButton>
          {vm.groupEditor ? (
            <NativeView className="sub-panel">
              <NativeView className="field">
                <NativeView className="field-label">
                  <text>分组名称</text>
                </NativeView>
                <SlInput
                  modelValue={vm.groupName}
                  onUpdateModelValue={($event: any) => {
                    vm.groupName = $event;
                  }}
                  placeholder="例如 客厅 + 卧室"
                  aria-label="分组名称"
                ></SlInput>
              </NativeView>
              <NativeView className="field-label">
                <text>选择至少两台已管理设备</text>
              </NativeView>
              {renderItems(vm.managed, (item) => (
                <NativeView
                  key={`${item.accountId}:${vm.deviceId(item.device)}`}
                  className="device-check-row"
                >
                  <SlCheckbox
                    modelValue={vm.selectedMembers.includes(
                      `${item.accountId}:${vm.deviceId(item.device)}`,
                    )}
                    onUpdateModelValue={(value) =>
                      value
                        ? vm.selectedMembers.push(
                            `${item.accountId}:${vm.deviceId(item.device)}`,
                          )
                        : (vm.selectedMembers = vm.selectedMembers.filter(
                            (key) =>
                              key !==
                              `${item.accountId}:${vm.deviceId(item.device)}`,
                          ))
                    }
                  ></SlCheckbox>
                  <NativeView className="device-check-copy">
                    <NativeView>
                      <text>{displayText(vm.deviceName(item.device))}</text>
                    </NativeView>
                    <NativeView>
                      <text>{displayText(item.accountId)}</text>
                    </NativeView>
                  </NativeView>
                </NativeView>
              ))}
              <NativeView className="field-actions">
                <SlButton
                  variant="text"
                  label="取消"
                  onClick={($event: any) => {
                    void vm.closeGroup($event);
                  }}
                ></SlButton>
                <SlButton
                  variant="filled"
                  label="保存"
                  icon="save"
                  onClick={($event: any) => {
                    void vm.saveCurrentGroup($event);
                  }}
                ></SlButton>
              </NativeView>
            </NativeView>
          ) : null}
          {!vm.state.groups.length && !vm.groupEditor ? (
            <NativeView className="empty-state">
              <text>暂无分组</text>
            </NativeView>
          ) : null}
          {renderItems(vm.state.groups, (group) => (
            <NativeView key={group.id} className="list-item">
              <NativeView className="list-item-copy">
                <NativeView className="list-item-title">
                  <text>{displayText(group.name)}</text>
                </NativeView>
                <NativeView className="list-item-subtitle">
                  <text>{displayText(group.members.length)} 台设备</text>
                </NativeView>
              </NativeView>
              <SlButton
                variant="icon"
                icon="edit"
                title="编辑分组"
                onClick={($event: any) => {
                  vm.openGroup(group);
                }}
              ></SlButton>
              <SlButton
                variant="icon"
                icon="delete"
                title="删除分组"
                onClick={($event: any) => {
                  vm.removeGroup(group.id);
                }}
              ></SlButton>
            </NativeView>
          ))}
        </NativeView>
      </SectionCard>
      <SectionCard
        title="播放进度共享"
        icon="queue_music"
        description="把指定设备放入同一组后，播放歌单会从最近一次进度继续。未加入共享组的设备保持独立。"
      >
        <NativeView className="form-body">
          <SlButton
            variant="filled"
            block
            label="新建共享组"
            icon="add"
            onClick={($event: any) => {
              vm.openProgressGroup();
            }}
          ></SlButton>
          {vm.progressGroupEditor ? (
            <NativeView className="sub-panel">
              <NativeView className="field">
                <NativeView className="field-label">
                  <text>共享组名称</text>
                </NativeView>
                <SlInput
                  modelValue={vm.progressGroupName}
                  onUpdateModelValue={($event: any) => {
                    vm.progressGroupName = $event;
                  }}
                  placeholder="例如 故事播放"
                  aria-label="共享组名称"
                ></SlInput>
              </NativeView>
              <NativeView className="field-label">
                <text>选择至少两台设备</text>
              </NativeView>
              {renderItems(vm.managed, (item) => {
                const key = `${item.accountId}:${vm.deviceId(item.device)}`;
                return (
                  <NativeView key={key} className="device-check-row">
                    <SlCheckbox
                      modelValue={vm.selectedProgressMembers.includes(key)}
                      onUpdateModelValue={(value) =>
                        value
                          ? vm.selectedProgressMembers.push(key)
                          : (vm.selectedProgressMembers = vm.selectedProgressMembers.filter(
                              (member) => member !== key,
                            ))
                      }
                    ></SlCheckbox>
                    <NativeView className="device-check-copy">
                      <NativeView>
                        <text>{displayText(vm.deviceName(item.device))}</text>
                      </NativeView>
                      <NativeView>
                        <text>{displayText(item.accountId)}</text>
                      </NativeView>
                    </NativeView>
                  </NativeView>
                );
              })}
              <NativeView className="field-actions">
                <SlButton
                  variant="text"
                  label="取消"
                  onClick={($event: any) => {
                    vm.closeProgressGroup();
                  }}
                ></SlButton>
                <SlButton
                  variant="filled"
                  label="保存"
                  icon="save"
                  onClick={($event: any) => {
                    void vm.saveCurrentProgressGroup();
                  }}
                ></SlButton>
              </NativeView>
            </NativeView>
          ) : null}
          {!vm.state.progressGroups.length && !vm.progressGroupEditor ? (
            <NativeView className="empty-state">
              <text>暂无共享组，设备会各自保存进度</text>
            </NativeView>
          ) : null}
          {renderItems(vm.state.progressGroups, (group) => (
            <NativeView key={group.id} className="list-item">
              <NativeView className="list-item-copy">
                <NativeView className="list-item-title">
                  <text>{displayText(group.name)}</text>
                </NativeView>
                <NativeView className="list-item-subtitle">
                  <text>{displayText(group.members.length)} 台设备共享进度</text>
                </NativeView>
              </NativeView>
              <SlButton
                variant="icon"
                icon="edit"
                title="编辑共享组"
                onClick={($event: any) => {
                  vm.openProgressGroup(group);
                }}
              ></SlButton>
              <SlButton
                variant="icon"
                icon="delete"
                title="删除共享组"
                onClick={($event: any) => {
                  void vm.removeProgressGroup(group.id);
                }}
              ></SlButton>
            </NativeView>
          ))}
        </NativeView>
      </SectionCard>
      <DLNAReceiverSettings active={props.active} />
      <SlDisclosure
        title="高级设备兼容"
        icon="speaker"
        description="按设备型号调整 Music API 与指示灯行为。"
      >
        <NativeView className="form-body">
          <NativeView className="field-label">
            <text>按型号选择 Music API 播放</text>
          </NativeView>
          <NativeView className="field-help">
            <text>
              勾选使用 Music API，取消勾选使用直链播放。部分型号需要 Music API
              才能正常发声，兼容性取决于设备固件。
            </text>
          </NativeView>
          <NativeView className="field-help">
            <text>
              遇到歌尾复播或切歌异常时，可尝试取消勾选；若取消后无声，请重新勾选。
            </text>
          </NativeView>
          <NativeView className="field-help">
            <text>
              保存后，下次下发歌曲时生效，当前播放不会立即切换；同一型号的所有设备共用此设置。
            </text>
          </NativeView>
          {!vm.musicApiModelRows.length ? (
            <NativeView className="field-help">
              <text>
                尚未识别到任何设备型号，登录并开启设备管理后会出现在这里。
              </text>
            </NativeView>
          ) : null}
          {renderItems(vm.musicApiModelRows, (row) => (
            <NativeView key={row.hardware} className="device-check-row">
              <SlCheckbox
                modelValue={vm.isMusicApiEnabled(row.hardware)}
                disabled={!row.inDefaults}
                ariaLabel={`使用 Music API 播放 ${row.hardware}`}
                onUpdateModelValue={($event: any) => {
                  vm.toggleMusicApi(row.hardware, $event);
                }}
              ></SlCheckbox>
              <NativeView className="device-check-copy">
                <NativeView>
                  <text>{displayText(row.hardware)}</text>
                </NativeView>
                <NativeView>
                  <text>{displayText(row.deviceName)}</text>
                </NativeView>
                <NativeView>
                  <text>
                    当前设置：
                    {displayText(
                      vm.isMusicApiEnabled(row.hardware)
                        ? "Music API"
                        : "直链播放",
                    )}
                  </text>
                </NativeView>
              </NativeView>
              {row.inDefaults ? (
                <NativeView className="chip chip-success">
                  <text>默认</text>
                </NativeView>
              ) : null}
            </NativeView>
          ))}
          {vm.defaultsMissingFromDevices.length ? (
            <NativeView className="field-help">
              <text> 默认清单中未在当前账号出现的型号： </text>
              {renderItems(vm.defaultsMissingFromDevices, (hw) => (
                <NativeView
                  key={hw}
                  className="chip"
                  style={styleObject("margin-left:6px")}
                >
                  <text>{displayText(hw)}</text>
                </NativeView>
              ))}
            </NativeView>
          ) : null}
        </NativeView>
        <SettingRow
          title="播放时保持指示灯"
          subtitle="关闭后播放时音箱指示灯不亮，适合夜间使用"
        >
          <SlSwitch
            modelValue={vm.state.config.indicator_light_enabled}
            aria-label="播放时保持指示灯"
            onUpdateModelValue={($event: any) => {
              vm.saveConfig({ indicator_light_enabled: $event });
            }}
          ></SlSwitch>
        </SettingRow>
      </SlDisclosure>
    </>
  );
}
