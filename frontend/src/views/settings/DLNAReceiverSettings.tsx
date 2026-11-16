import {
  displayText,
  usePageState,
  NativeView,
  classes,
  styleObject,
  renderItems,
} from "../../page-state";
import {
  computed,
  onMounted,
  onUnmounted,
  reactive,
  ref,
} from "../../page-state";
import { get, put } from "../../api";
import { messageOf, notify, state } from "../../store";
import SectionCard from "../../ui/SectionCard.tsx";
import SettingRow from "../../ui/SettingRow.tsx";
import SlButton from "../../ui/SlButton.tsx";
import SlInput from "../../ui/SlInput.tsx";
import SlSwitch from "../../ui/SlSwitch.tsx";
interface ReceiverStatus {
  enabled: boolean;
  name: string;
  base_url: string;
  enabled_ids: string[];
  running: boolean;
  host_supported: boolean;
  error: string;
  receivers: Array<{
    id: string;
    enabled: boolean;
    available: boolean;
    account_id: string;
    device_id: string;
    name: string;
    running: boolean;
    state: string;
    error: string;
    group_id: string;
    members: Array<{
      account_id: string;
      device_id: string;
    }>;
  }>;
}
const pageState = {
  name: "DLNAReceiverSettings",
  createState(input, {}) {
    const form = reactive({
      enabled: false,
      name: "Songloft 小爱音箱",
      base_url: "",
      enabled_ids: [] as string[],
    });
    const status = ref<ReceiverStatus | null>(null);
    const saving = ref(false);
    const error = ref("");
    let timer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;
    const label = computed(() =>
      !status.value?.enabled
        ? "已关闭"
        : status.value.running
          ? `${status.value.receivers.filter((r) => r.running).length} 个接收器已开启`
          : status.value.error
            ? "启动失败"
            : status.value.enabled_ids.length
              ? "暂无可运行的接收器"
              : "请为音箱或分组开启插件 DLNA",
    );
    function playbackLabel(value: string): string {
      return (
        (
          {
            PLAYING: "播放中",
            PAUSED_PLAYBACK: "已暂停",
            STOPPED: "已停止",
            NO_MEDIA_PRESENT: "等待投放",
          } as Record<string, string>
        )[value] || value
      );
    }
    let revision = 0;
    async function refresh(initial = false) {
      const current = revision;
      try {
        const result = await get<ReceiverStatus>("/receiver/config");
        if (disposed || current !== revision) return;
        status.value = result;
        error.value = result.error;
        if (initial) {
          form.enabled = result.enabled;
          form.enabled_ids = result.enabled_ids.slice();
          form.name = result.name;
          form.base_url = result.base_url || state.config.server_host;
        }
      } catch (cause) {
        if (!disposed && current === revision) error.value = messageOf(cause);
      }
      if (!disposed && current === revision)
        timer = setTimeout(() => {
          void refresh();
        }, 5000);
    }
    function selectReceiver(id: string, enabled: boolean): void {
      form.enabled_ids = enabled
        ? [...new Set([...form.enabled_ids, id])]
        : form.enabled_ids.filter((value) => value !== id);
    }
    async function save() {
      revision++;
      if (timer !== null) clearTimeout(timer);
      saving.value = true;
      try {
        const result = await put<ReceiverStatus>("/receiver/config", {
          ...form,
        });
        if (disposed) return;
        status.value = result;
        error.value = status.value.error;
        notify(
          form.enabled ? "DLNA 接收器已开启" : "DLNA 接收器已关闭",
          "success",
        );
      } catch (cause) {
        if (!disposed) {
          error.value = messageOf(cause);
          notify(error.value, "error");
        }
      } finally {
        saving.value = false;
        if (!disposed)
          timer = setTimeout(() => {
            void refresh();
          }, 5000);
      }
    }
    onMounted(() => {
      void refresh(true);
    });
    onUnmounted(() => {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
    });
    const bindings = {
      form,
      status,
      saving,
      error,
      get timer() {
        return timer;
      },
      set timer(v) {
        timer = v;
      },
      get disposed() {
        return disposed;
      },
      set disposed(v) {
        disposed = v;
      },
      label,
      playbackLabel,
      get revision() {
        return revision;
      },
      set revision(v) {
        revision = v;
      },
      refresh,
      selectReceiver,
      save,
      SectionCard,
      SettingRow,
      SlButton,
      SlInput,
      SlSwitch,
    };
    return bindings;
  },
};
export default function DLNAReceiverSettings(props: any) {
  const vm = usePageState(pageState, props);
  return (
    <>
      <SectionCard
        title="DLNA 接收器"
        icon="speaker_group"
        description="按需为音箱或分组提供 DLNA 入口。原生支持 DLNA 的音箱可关闭插件入口，避免重复显示。"
      >
        <SettingRow title="插件 DLNA 总开关" subtitle={vm.label}>
          <SlSwitch
            modelValue={vm.form.enabled}
            onUpdateModelValue={($event: any) => {
              vm.form.enabled = $event;
            }}
            disabled={
              vm.saving || (!vm.status?.host_supported && !vm.form.enabled)
            }
            aria-label="启用 DLNA 接收器"
          ></SlSwitch>
        </SettingRow>
        <SettingRow
          title="接收器名称前缀"
          stacked
          subtitle="在前缀后显示音箱或分组名称，便于在投放列表中区分。"
        >
          <SlInput
            modelValue={vm.form.name}
            onUpdateModelValue={($event: any) => {
              vm.form.name = $event;
            }}
            disabled={vm.saving}
            aria-label="DLNA 接收器名称"
          ></SlInput>
        </SettingRow>
        <SettingRow
          title="服务器局域网地址"
          stacked
          subtitle="填写手机和音箱都能访问的 HTTP IPv4 地址，可包含部署子路径。"
        >
          <SlInput
            modelValue={vm.form.base_url}
            onUpdateModelValue={($event: any) => {
              vm.form.base_url = $event;
            }}
            disabled={vm.saving}
            placeholder="http://192.168.1.10:58091"
            aria-label="DLNA 服务器地址"
          ></SlInput>
        </SettingRow>
        <NativeView className="form-body dlna-form-body">
          {vm.status && !vm.status.host_supported ? (
            <NativeView>
              <text>请升级 Songloft 宿主以支持 DLNA 接收。</text>
            </NativeView>
          ) : null}
          {vm.error ? (
            <NativeView>
              <text>{displayText(vm.error)}</text>
            </NativeView>
          ) : null}
          <NativeView>
            <text>
              新增音箱和分组默认关闭，请逐项选择并保存。分组成员不重复显示；分组需至少两台且全部成员已启用管理。独立音箱与分组的开关分别保存，退组后恢复音箱原来的选择。共用
              Songloft HTTP 端口和 UDP 1900，无需为每个音箱分配端口。
            </text>
          </NativeView>
          {vm.status && !vm.status.receivers.length ? (
            <NativeView>
              <text>暂无可用的音箱或分组，请先启用音箱管理。</text>
            </NativeView>
          ) : null}
          {renderItems(vm.status?.receivers || [], (receiver) => (
            <NativeView key={receiver.id} className="receiver-status">
              <SettingRow
                title={receiver.name}
                subtitle="保存后生效；关闭插件入口不影响音箱的原生 DLNA。"
              >
                <SlSwitch
                  modelValue={vm.form.enabled_ids.includes(receiver.id)}
                  disabled={
                    vm.saving ||
                    !vm.status?.host_supported ||
                    (!receiver.available &&
                      !vm.form.enabled_ids.includes(receiver.id))
                  }
                  ariaLabel={`为 ${receiver.name} 启用插件 DLNA`}
                  onUpdateModelValue={($event: any) => {
                    vm.selectReceiver(receiver.id, $event);
                  }}
                ></SlSwitch>
              </SettingRow>
              <NativeView className="receiver-details">
                {receiver.group_id ? (
                  <NativeView>
                    <text>
                      分组 · {displayText(receiver.members.length)}{" "}
                      台音箱；进度和查询音量以首台音箱为参考。
                    </text>
                  </NativeView>
                ) : null}
                <NativeView>
                  <text>
                    {displayText(
                      receiver.running
                        ? vm.playbackLabel(receiver.state)
                        : !receiver.enabled
                          ? "插件入口已关闭"
                          : !vm.status?.enabled
                            ? "总开关已关闭"
                            : receiver.available
                              ? "未运行"
                              : "不可用",
                    )}
                  </text>
                </NativeView>
                {receiver.error ? (
                  <NativeView className="receiver-error">
                    <text>{displayText(receiver.error)}</text>
                  </NativeView>
                ) : null}
              </NativeView>
            </NativeView>
          ))}
          <NativeView className="field-actions">
            <SlButton
              disabled={vm.saving || !vm.status}
              variant="filled"
              label={vm.saving ? "正在保存…" : "保存接收器设置"}
              onClick={($event: any) => {
                void vm.save($event);
              }}
            ></SlButton>
          </NativeView>
        </NativeView>
      </SectionCard>
    </>
  );
}
