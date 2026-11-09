# #137：无触发词接管确认与设置说明

对应 [songloft-org/songloft-plugin-miot#137](https://github.com/songloft-org/songloft-plugin-miot/issues/137)。[English](en/issue-137.md)。

## 最新确认与本地调整（2026-11-09）

报告人在[复测确认](https://github.com/songloft-org/songloft-plugin-miot/issues/137#issuecomment-6738703661)中明确表示，仅勾选「音乐口令未命中后交给 AI」会出现无触发词接管；[随后补充](https://github.com/songloft-org/songloft-plugin-miot/issues/137#issuecomment-6738782369)，原名称容易理解为点歌查询未命中才交给 AI。至此，先前调查中的配置入口已由报告人确认，不再等待相同配置截图。

分流实际判断的是语音是否被音乐服务识别处理，并非歌曲搜索有无结果。普通天气、闲聊未被识别为音乐指令时，开启该选项就会进入聊天；固定控制和已识别的音乐请求仍优先，已识别但播放失败不会再转为聊天。「所有语音都交给 AI」描述了报告人的体验，不能外推为音乐控制失去优先级。

本地将该项改名为「无需触发词也交给 AI」，从模型高级设置移到「AI 对话」的触发词、连续追问旁，说明天气、闲聊与窗口限制。保留配置键 `fallback_enabled`、默认关闭及旧值；未更改运行时分流。中英 AI 对话文档同步说明：仅通过触发词进入 AI 时，同时关闭此项和「允许连续追问」。

验证对象：插件基线 `a161d3a1d6cc3159219b15f215d0c3f865442c85` + 本次未提交工作树；父仓库基线 `b35fc09e52bf4404ba9dfb1e7e999066ae844b1d`，父指针未变化。环境 Linux x86_64、Node 22.17.1、Docker Chrome 121。源码文件 SHA-256 和命令结果见 `/tmp/miot137-wording-20261109/verification.json`，同目录保留日志与截图。

| 命令 / 场景 | 结果 |
| --- | --- |
| `npx tsc --noEmit` | 通过 |
| `node --experimental-strip-types --test tests/*.test.mjs` | 1,423 项通过，无失败/跳过 |
| frontend：`npm run typecheck`、`npm test`、`npm run build` | 通过，84 项测试无失败/跳过 |
| `npm run build`、`npm run validate`；最终 `npm --ignore-scripts run build`、`npm run validate` | QuickJS 字节码构建与包校验通过；首次 prebuild 自动下载的无关节假日变更已还原，最终构建使用仓库数据 |
| Docker Chrome 121，1200px / 390px | 无需展开高级设置即可看到新名称及说明；切换、保存、刷新后状态一致；连续追问保持关闭；两项均关闭时显示每轮需触发词；无横向溢出或页面异常 |
| `git diff --check` | 通过 |

浏览器使用真实配置 handler、ConfigManager 和独立磁盘存储；账号、模型、设备接口为夹具，不调用真实设备或模型。此轮为界面语义调整，不新增文案断言测试。Not run：真实音箱发声、原生 WebView、长期运行、父仓库 Go 检查（公共宿主未改），以及本次远端 CI/发布（尚未提交或推送）。历史首次回访证据和已发表回复保留如下。

待回复草稿（未获本轮评论授权，未发表；目标 `songloft-org/songloft-plugin-miot#137`）：

> 确认了，旧名称确实容易理解成“点歌查询失败才交给 AI”。实际行为是：开启后，天气、闲聊等未被识别为音乐指令的语音，无需触发词就会进入 AI；已经识别的音乐指令仍优先处理。
>
> 如果只希望说“我要你……”才进入 AI，请关闭「音乐口令未命中后交给 AI」和「允许连续追问」并保存。你已确认关闭后按触发词工作，这条配置入口现已确认。
>
> 我已在本地把它改名为「无需触发词也交给 AI」，移到触发词、连续追问旁，并补充说明。插件 1,423 项测试、前端 84 项测试、类型检查、构建、包校验及桌面/手机浏览器保存刷新检查通过；尚未提交、发布或进行真实音箱验收。

## 首次回访：结论与现场证据（确认前）

报告人称已升级至 `v2026.11.9.0`，分别询问「今天天气怎么样」「明天会下雨吗」，小爱回答中途被插件接管。截图显示两条 AI 历史：07:31:29 已取消、07:39:34 已完成，相隔 485 秒。截图没有升级后保存的触发词、连续追问和兜底配置，也没有此前完整记录或日志，尚不能确认现场的具体入口。

两开关关闭的本地对照未复现；开启「音乐口令未命中后交给 AI」可使这两句都进入聊天。这是可复现的配置路径，**不能据此认定报告人开启了兜底**。旧配置仍保留原追问偏好，仅升级版本不会自动关闭；追问窗口从回答完成时计算，不能只凭历史创建时间差排除窗口路径。

当前代码的语音入口在 `src/voicecmd/dispatcher.ts`：

- 命中句首触发词直接提交聊天。
- 未命中音乐口令时，只有开启兜底，或开启连续追问且窗口仍有效，才提交聊天。
- 上一轮仍在生成或播报，只会被打断，不单独授权新聊天。

页面手动提交 `/chat/messages` 是另一个入口，不要求语音触发词。现场称使用语音，未将其当作本次根因。

## 版本与验证

2026-11-09，只读核对远端 main 和本地插件均为 `a161d3a1d6cc3159219b15f215d0c3f865442c85`；父仓库为 `b35fc09e52bf4404ba9dfb1e7e999066ae844b1d`。首次回访只改调查与经验文档，没有修改生产代码或入库测试。

前次修复 [0d8f7b7a7ccea8986568817214b98a6f7c2885df](https://github.com/songloft-org/songloft-plugin-miot/commit/0d8f7b7a7ccea8986568817214b98a6f7c2885df) 的 [Release Plugin](https://github.com/songloft-org/songloft-plugin-miot/actions/runs/42525964553) 成功，[v2026.11.9.0](https://github.com/songloft-org/songloft-plugin-miot/releases/tag/v2026.11.9.0) 的发布说明引用该源码 SHA。此核对不证明报告人的实际安装包或真机行为。

环境：Linux x86_64，Node 22.17.1；真实 ConfigManager 存储序列化/读取、VoiceDispatcher、MusicCommandService 默认规则、AIChatService 与 PlaybackCoordinator；内存存储、模拟模型和设备，不调用真实云端。关闭点歌记忆与 AI 口令分析，隔离聊天分流；已有回归另外覆盖口令分析失败及聊天接手。

| 对照配置/状态 | 两句天气提问的结果 |
| --- | --- |
| 显式关闭追问和兜底 | 零模型请求、零新接管、无天气聊天历史 |
| 旧配置零窗口 | 同上 |
| 旧配置缺省/正窗口，但没有上一轮聊天 | 同上；迁移成开启追问不会凭空产生窗口 |
| 兜底开启、追问关闭 | 两次模型请求、两次接管，均写入历史 |
| 仅追问开启，已有刚完成回答 | 第一句进入 AI，485 秒后第二句不进入 |
| 仅追问开启，最大 300 秒窗口已过期 | 两句均不进入 AI |
| 上一轮生成/播报中，分别开启/关闭追问，兜底关闭 | 打断旧回答，两句均不产生新模型请求或新接管 |

证据目录 `/tmp/miot137-followup-20261109/`：

| 命令 | 结果 |
| --- | --- |
| `node --experimental-strip-types --test /tmp/miot137-followup-20261109/investigate.test.mjs` | 11 项调查通过，`investigate.log`、`outcomes.json` |
| `node --experimental-strip-types --test tests/chat.test.mjs tests/chat_followup.test.mjs tests/chat_scenarios.test.mjs tests/chat_contracts.test.mjs tests/voice_takeover.test.mjs tests/voice_analysis_failure.test.mjs` | 256 项回归通过，`regression.log` |
| `git diff --check` | 通过 |

Issue、全部三条评论、发布与 CI 快照分别保存为 `issue.json`、`comments.json`、`release.json`、`ci.json`。最新评论截图 SHA-256：`754dceaa1eb42702f1747e438c52dd26c5303399e5627fabcb31c530dc8ff6e4`。

本轮是行为调查，没有新修复，不把旧代码通过这些检查称为修复验收。Not run：真实音箱、固件、实际发声、原生 WebView、长期运行和现场配置复现；无相应设备/配置。全量测试、类型检查、构建/包校验、浏览器 UI、父仓库 Go 检查未重跑，本轮无生产代码或 UI 变化。

## 回复与实际交付

目标 `songloft-org/songloft-plugin-miot#137`。2026-11-09 用户授权回复后，重新核对全部最新评论，已[发表并回读核对以下回复](https://github.com/songloft-org/songloft-plugin-miot/issues/137#issuecomment-6732464560)，Issue 保持打开。回读正文与草稿一致，证据为 `/tmp/miot137-followup-20261109/reply-published.json`。

> 收到，升级后的这两次仍被接管，问题还不能算解决。我用这两句原话做了对照：关闭「允许连续追问」和「音乐口令未命中后交给 AI」时未进入 AI；开启后者，两句都会被接管。现在还不能确认你这里的具体入口。
>
> 请到「设置 → AI 设置」，关闭「允许连续追问」，并关闭高级设置中的「音乐口令未命中后交给 AI」，点击保存后刷新，确认两个开关仍关闭、触发词仍为「我要你」，再复测。这两个开关独立生效，升级会保留旧配置。
>
> 如果仍复现，请补充刷新后这两个开关和触发词的截图，在「语音设置 → 调试日志」开启日志，记录复现时间并附上前后几轮对话记录及对应后端日志。截图中的聊天历史还不足以确认触发入口；日志请先去掉密钥、Token 等敏感信息。真实音箱本轮尚未验证，暂不关闭 Issue。
