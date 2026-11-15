# HD 音箱的 AI 接管失败

关联 [songloft-org/songloft-plugin-miot#140](https://github.com/songloft-org/songloft-plugin-miot/issues/140)。[English](en/issue-140.md)。

## 证据与边界

2026-11-15 读取正文、截图、全部评论（当时为零）及附件日志。远端 main 与本地基线均为 `cd4921fde37f8239878cf1bb0b44fa074f6b481b`；最近业务版本为 v2026.11.12.0，修复 #138 的 CI 成功，不代表本次工作树已发布。

截图错误为「AI 对话失败 · 无法打断音箱原回答」，报告人说明实际已打断，同账号的小米 AI 音箱正常。附件中有五次 AI 任务在第一轮 stop 返回后失败，包括：

| 时间（北京时间） | 可见行为 |
| --- | --- |
| 11:54:26.696 | 已启动模型请求 |
| 11:54:27.044 | stop 外层 `code=0`，设备层 `data.code=123` |
| 11:54:27.045 | 第一轮中断失败，AI 任务失败并取消模型请求 |
| 12:48:32.451 | 另一任务的 stop 外层 `code=0`，设备层 `data.code=131`，随后同样第一轮失败 |

该设备其他停止操作还出现 `114`；对照设备的十次 stop 回执均为 `0`，其 AI 任务能进入播报并完成。代码链路为 `AIChatService → PlaybackCoordinator.prepare → MinaService.interruptAnswer → playerStopGuarded → playerOperation`：设备停止码非零立即失败，既不读回状态，也不发第二轮，随后取消模型工作。这证明软件终止点，与用户报告的实际已打断相符；不证明这些非零码的固件定义，也不证明当时已经静音。附件没有完整 HD 固件版本或原始停止后状态回执，不能推断该型号所有固件都会返回相同状态。

原始附件保留在 `/tmp/miot-140/private/`，不入库。本文不记录账号、设备 ID、凭证、网络地址或原始问题。

## 本地修复

仅为两轮回答中断启用有限回读：外层云端请求成功、停止设备码为非零有限数值时，最多取得两次新状态，间隔 700ms。两次都为已知非播放状态 `0/2/3` 且查询设备回执成功，才完成当前轮；绕过停止前缓存，不把错误码白名单化。

第一轮通过后仍等待 600ms 并发送第二轮 `pause → stop`；两轮结束后才允许提示或正式回答下发。查询失败、缺失/未知状态、仍在播放、云端失败继续失败。回读等待及请求完成后检查取消，迟到 idle 不推进旧任务。普通 stop、暂停、分组成员停止及 TTS 回执语义保持原样。状态判据复用 `isDeviceIdle`，没有增加全局后台轮询。

这允许已经停止且能回读到状态的设备继续 AI 接管。状态查询不可用或设备持续误报时仍可能失败，需要真实 HD 回执进一步确认；连续 idle 不能证明实际静音或 TTS 发声。

## 验证

2026-11-15，Linux x86_64 / Node 22.17.1 / TypeScript 5.9.3；上述插件基线加未提交工作树，父仓库 `ebdbddedde6c47dc3ec8919b9be2f4e88815faab`。源码及测试清单 SHA-256：`b8ebaf548b456f2ead85c684230ed5e98e5c97f246d26709876e1d45edc64740`；逐文件摘要与对象说明见 `/tmp/miot-140/verification.json`。

| 检查 | 结果 |
| --- | --- |
| `npx tsc --noEmit` | 通过 |
| `node --experimental-strip-types --test tests/*.test.mjs` | 1475 项通过 |
| 中断专项 | 51 项通过；在隔离基线源码中运行相同测试，21 项按预期失败 |
| `npm run build` | 通过，包含前端和 QuickJS 字节码构建 |
| 最终 `npm exec -- songloft-plugin build` | 恢复预构建下载的无关 2027 节假日变化后重新打包，通过 |
| `npm run validate` | 通过 |
| TypeScript 格式化 / `git diff --check` | 通过 |

专项交叉覆盖 `114/123/131` × `0/2/3`、playing/未知/查询失败、操作前 idle 缓存、状态回执自身失败、回读等待及两次在途请求中的取消、正常回执的原两轮路径、普通控制错误语义。真实 `AIChatService → PlaybackCoordinator → MinaService → MinaHTTPClient` 调用链在两轮验证前禁止 TTS，随后实际调用模拟 HTTP 的 `text_to_speech` 并完成任务；模型返回与播报完成使用夹具，不声称测得设备发声。专项还断言队列、任务与等待计时器释放。

证据：`/tmp/miot-140/{baseline-final,interrupt-final,tests-final,typecheck-final,build,build-final,validate-final}.log`。构建包为本地测试产物，未分配新的正式版本。

Not run：HD 真机/固件、报告人账号与云端实时请求、实际静音/TTS 发声、连续追问及音乐恢复的真机表现、长期播放；浏览器交互（未改 UI）、父仓库 Go 检查（未改宿主接口或实现）、本修复的远端 CI（尚未提交/推送）。完整插件测试保留播放、切歌、状态与恢复回归。

当前未提交、推送、发布或回复 Issue，父仓库子模块仅为 dirty。建议提交信息：`fix(chat): 回读确认异常停止回执后继续 AI 接管 (#140)`。发布后应请报告人复测 HD 的原回答停止、AI 回答发声及连续追问，保留 Issue 打开等待真机反馈。
