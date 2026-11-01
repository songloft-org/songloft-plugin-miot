# #136：语音停止后间歇性自动播放（调查）

对应 [songloft-org/songloft-plugin-miot#136](https://github.com/songloft-org/songloft-plugin-miot/issues/136) 及[日志评论](https://github.com/songloft-org/songloft-plugin-miot/issues/136#issuecomment-6556355696)。[English](en/issue-136.md)。

## 日志证据与结论

附件 `songloft-logs-20261101-175002.zip`，SHA-256 `701a9ffc8cf386242b845d2109f7b5a98424947a81c6c4123904736d4617ba9c`。以下均为 2026-11-01 北京时间，行号对应解压后的 `backend.log`。

| 时间 | 日志行 | 行为 |
| --- | --- | --- |
| 12:35:54–12:35:55 | 655–692 | 元数据截止，从 index=92 切至 93，注册 226 秒计时器；截图中的推流来自自动切歌 |
| 12:39:42–12:40:12 | 741–766 | 设备播放约 60 秒的外来媒体，队列经过 30 秒宽限仍推进；外来媒体本身不能证明当前歌曲已结束 |
| 12:40:14 | 805 | 为 index=94 注册 211 秒计时器 |
| 12:40:25 | 815 | `status=3, position=0, duration=0, playable=true`，按状态盲区接受起播 |
| 12:40:35 | 820 | `External stop ignored: device reports no usable state`，忽略全零详情的 idle |
| 12:43:46 | 869–908 | `status=3, hasPosition=false`，元数据截止后实际推送下一首 |
| 12:45:45 | 973 | 后端启动版本为 `v2.11.6`，commit `c5df438` |
| 16:57:09–17:00:49 | 9625、9669–9701 | 再次忽略 `status=3`，到期推送下一首；重启后的暂时缓解不代表修复 |

已确认“设备状态被忽略 → 切歌计时器保留 → 到期推送下一首”的插件路径。HEAD 成功只证明服务器有流可提供，不证明设备实际发声。

可见的新增对话是点歌和设置提醒，没有捕获到停止口令，也没有这些区间内成功执行插件 `stop()` 的记录。部分早期日志仅保留 WARN，且缺少原始设备响应。因此停止原话、时间、为何未进入插件，以及 S12 正常播放时是否也持续返回 3，仍待取证。不能仅凭日志中的 `status=3` 确认当时实际停止。

## 历史与源码核对

检索了主仓库和插件全部 Issue 列表（分别 522、105 条），读取本地 AGENTS 回归清单的相关正文和全部评论，包括父仓库 #408/#449/#495/#503/#533 和插件 #95/#96/#103/#124/#129。

- [父仓库 #408](https://github.com/songloft-org/songloft/issues/408#issuecomment-5356048192)：部分“关机”不出现在云端对话记录，原修复以后台设备状态探测取消切歌。
- [父仓库 #449](https://github.com/songloft-org/songloft/issues/449#issuecomment-5580502985)：设备会连续误报停止，必须保留位置推进保护。
- [插件 #129](https://github.com/songloft-org/songloft-plugin-miot/issues/129#issuecomment-6357481641)：OH2 正常发声也持续上报全零。`2fce927` / v2026.10.23.0 的 `isBlindIdleState()` 接受 idle 0/2/3，当前流从未上报正位置或正流长时，外停探测跳过确认。该回复已明确说明全零外停与正常播放无法区别、仍按元数据计时的限制；当前 main 判据相同。
- 当前 `MusicCommandService.executeStop()` 会取消语音恢复和睡眠定时，再由 `PlaylistManager.stop()` 清理切歌检测及续播锚点。原生音箱停止与插件实际执行停止必须分开核对。

本次命中了 #129 的兼容分支，但不能直接撤销全零兼容、全局将 3 当作可靠停止，或从单条 playing 推断后续状态可靠。须先采集同设备正常播放与主动停止的原始响应对照。本轮未改生产逻辑。

## 语音延迟单独判断

后端 `v2.11.6 / c5df438` 的 `runTimerProcessor()` 仍使用固定 500ms ticker，未包含 `32ff4ca` 的句柄修复和 `5d2368d` 的事件驱动 pump；可能增加后台异步等待，但不是全部延迟的已证实根因。

16:29:47–16:29:55 点歌经历本地及在线未命中，搜索约八秒；16:30:17–16:30:27 在线搜索约 10.5 秒；16:31:14 本地命中后搜索至下发约 2.5 秒。17:03 后还有状态超时及推流核验失败。搜索、云端、宿主调度与实际发声分别取证，HTTP 成功或 206 不证明已发声。

2026-11-01 查询正式发布为 [Songloft v2.13.7](https://github.com/songloft-org/songloft/releases/tag/v2.13.7) 与 [MIoT v2026.11.1.1](https://github.com/songloft-org/songloft-plugin-miot/releases/tag/v2026.11.1.1)。插件更新不更新宿主；升级宿主能取得既有运行时修复，但没有证据表明升级可消除全零状态的停止歧义。

## 验证与边界

- 时间、环境：2026-11-01，Linux amd64 / Node 22.17.1。
- 插件基线及只读核对的远端 main：`3f7a5420186b3756f078427e1c5aa6fc98d1f576`；父仓库：`57543b788b1be6ec4f37a2c28c481ec3707f287e`。本次仅增加调查和经验文档，源码及入库测试不变。
- 仓库外复制 `player_failures.test.mjs` 运行器，加载基线源码。四项调查覆盖全零 idle 0/3：未收到插件停止时，211 秒截止前保持同曲，到点实际推送下一首；显式 `stop()` 后十分钟不再推流。断言队列、失败标记、TTS、定时器清理。

| 命令 | 结果 |
| --- | --- |
| `node --experimental-strip-types --test --test-name-pattern='issue 136 investigation\|issue 129' /tmp/songloft-miot-136-20261101/repro/tests/player_failures.test.mjs` | 10 项通过，含四项调查及六项既有 #129 用例；证明当前行为，非修复验收 |
| `node --experimental-strip-types --test tests/player_failures.test.mjs tests/player_transition.test.mjs tests/player_status.test.mjs tests/mina_status.test.mjs` | 649 项通过 |
| 前端 `node --test tests/slider_drag.test.mjs tests/status_recovery.test.mjs tests/playback_failures.test.mjs` | 16 项通过 |

证据位于 `/tmp/songloft-miot-136-20261101/`：附件、历史 Issue 快照、隔离复现、`repro.log`、`playback-regression.log`、`frontend-playback.log`。原始附件不入库，不复制凭证或设备身份。

Not run：S12 真机、固件原始状态对照、实际停止原话/发声时间、长期运行；全量测试、类型检查、构建/包校验、父仓库 Go 检查、浏览器 UI（本轮没有生产代码或 UI 变化）。未提交、推送或发布。当前版本提交没有查到直接绑定其 SHA 的 Actions 运行，不作为 CI 通过证明。

## 初始回复草稿与实际交付

目标 `songloft-org/songloft-plugin-miot#136`，Issue 保持打开。

2026-11-01，用户明确授权回复后，重新核对最新评论及两个最新正式版本，已[发表并回读核对回复](https://github.com/songloft-org/songloft-plugin-miot/issues/136#issuecomment-6556651500)：引导分别更新 Songloft v2.13.7 和 MIoT v2026.11.1.1，确认实际运行版本，开启调试日志并记录停止原话与复现时间。说明升级不等于已修复，保留 Issue 打开。以下为此前草稿；实际发送正文见链接，证据见 `/tmp/songloft-miot-136-20261101/reply-published.json`。

> 日志已找到自动播放的路径：12:40:35 音箱返回停止/空闲且媒体详情全零，插件将其视为不可靠状态保留计时器，12:43:46 到期推送下一首。这与 10 月 23 日的全零音箱兼容有关；部分设备正常播放也只返回全零，不能直接改成见到全零就停止。
>
> 日志还显示后端为 **Songloft v2.11.6**。请分别更新后端与 MIoT 插件后复测；插件更新不会带上后端的异步调度修复，但升级本身也不代表上述停止问题已解决。
>
> 请在插件「语音设置 → 调试日志」开启日志，记录正常播放、说出停止口令、再次自动播放的准确时间，补充停止原话、音箱固件及升级后的后端/插件版本，同时核对插件对话记录是否出现该停止口令。当前附件没有捕获到口令，尚无法判断是未收到还是后续执行失败。
>
> 临时可以在 MIoT 播放页面点击停止：插件显式停止会清理自动切歌计时器，本地模拟对照通过，S12 真机仍待复验。问题先保持打开。
