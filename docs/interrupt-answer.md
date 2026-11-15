# 中断小爱回答

收到对话 webhook 后，可以调用专用接口停止指定音箱的回答：

`POST /api/v1/jsplugin/miot/mina/interrupt`

接口需要 Songloft 登录得到的 Bearer access token。请求中的 `account_id`、`device_id` 使用 webhook 推送中的对应字段，必须为非空字符串。子路径部署时，服务器地址需要带部署前缀。

```bash
curl -X POST 'http://你的Songloft服务器:58091/api/v1/jsplugin/miot/mina/interrupt' \
  -H 'Authorization: Bearer <access_token>' \
  -H 'Content-Type: application/json' \
  -d '{"account_id":"webhook中的account_id","device_id":"webhook中的device_id"}'
```

接口立即发送一轮 `pause → stop`，该轮停止成功后等待 600ms，再发送第二轮 `pause → stop`。两轮完成后才返回，因此调用耗时包含这段落定等待及设备请求时间。间隔原为 2000ms，只需覆盖固件转入媒体播放所需的落定时间，为削减 AI 问答链路的固定延迟收敛到 600ms（[Issue #119](https://github.com/songloft-org/songloft-plugin-miot/issues/119)）；第二轮仍无条件发送，不用状态回读替代——状态 0/2 可能误报（[songloft-org/songloft#449](https://github.com/songloft-org/songloft/issues/449)）。pause 是兼容性前置操作，单独拒绝 pause 时仍尝试 stop。

HD 的 stop 可能在实际停止后仍返回非零设备码（[Issue #140](https://github.com/songloft-org/songloft-plugin-miot/issues/140)）。仅在外层云端请求成功、设备停止回执非零时，每轮最多回读两次新状态，间隔 700ms；两次都为明确的非播放状态 `0/2/3` 才允许继续。回读绕过操作前缓存，查询失败、未知状态、仍在播放或设备状态回执失败均返回中断失败；云端失败和请求异常不走此回退。第一轮通过回读后仍必须发送第二轮，两轮都通过才开始 AI 提示或回答。新操作在回读等待和请求完成后仍可取消旧任务。普通停止、暂停及分组成员停止保持原错误判定。

两轮均成功时返回：

```json
{"success":true,"data":{"message":"interrupt commands accepted","stop_rounds":2,"cancelled":false}}
```

`success: true` 表示两轮停止均应答成功或通过上述新状态回读，**不证明音箱已经静音**。方案依据 L05b 在“为你找到……”播报被打断后仍继续播放故事、隔两秒再次停止才完全中断的反馈（[Issue #118](https://github.com/songloft-org/songloft-plugin-miot/issues/118)）。不同型号、固件或更晚的播放阶段仍需实机验证。

如果处理期间，同一账号、同一设备的新播放、恢复、暂停、停止、TTS 或另一次中断操作进入设备控制服务，会取消旧中断任务尚未发送的指令。队列中的指令和 token 刷新后的重发也会在发送前再次检查。宿主串行处理同一插件的 HTTP 请求，另一 HTTP 控制请求通常需等待本接口返回后才能执行；取消保护针对已经进入服务层的新操作。取消返回如下，`stop_rounds` 表示取消前已成功完成的轮数，包含通过新状态回读的轮次（可能为 0 或 1）：

```json
{"success":false,"error":"interrupt superseded by a newer operation","data":{"stop_rounds":1,"cancelled":true}}
```

已经发送的请求无法撤回。实体按键、小爱 App 或其他插件外操作无法可靠识别，仍可能受第二轮停止影响。改变音量、查询状态或操作其他账号/设备不会取消本次中断。

设备不可用或停止失败时返回 `success: false`、`error: "failed to interrupt"`，并包含 `data.stop_rounds` 和 `data.cancelled: false`。缺少或无效的 ID 返回 `success: false` 和对应字段错误。

该接口只控制指定音箱，不向设备组扩散，也不修改歌单队列或接管 DLNA 播放。应在小爱回答时调用；它不是歌单停止接口，仍在运行的歌单驱动后续可能继续推送音乐。普通 `/mina/stop` 仍只执行一轮停止；webhook 推送本身不会自动中断回答。脚本改用本接口后，无需再自行安排第二次停止。

验证命令：`npx tsc --noEmit` 和 `node --experimental-strip-types --test tests/*.test.mjs`（Node 22.17 需启用 TypeScript 类型剥离，供既有测试直接导入 `.ts` 文件）。实际中断效果需要 L05b 等真实音箱复测。
