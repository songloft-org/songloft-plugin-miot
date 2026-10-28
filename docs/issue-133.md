# Issue #133：AI 网关自定义请求头

- Issue：[songloft-org/songloft-plugin-miot#133](https://github.com/songloft-org/songloft-plugin-miot/issues/133)。正文报告 OpenCode 网关返回 `MissingSessionID`；调查时 open、无评论、无关联修复。基线远端与本地均为 `af05c60c1a1504b98dfad2ad955df374100f9dbf`，父仓库 `4b9b6961967e8ea9560461e00a8736f6ad13e24b`，开始时工作树干净。
- 根因：问答客户端、两处模型列表及口令分析分别固定构造请求头；默认/独立连接均无配置入口，`chatConnection` 也未传递额外头。
- 实现：采用 Issue 的通用方案 A，新增 `custom_headers` 字符串对象与设置页 JSON 输入。复用默认连接时沿用默认头，独立连接使用自己的头；模型列表、流式/普通问答、摘要、记忆和分析共用构造函数。旧配置不添加额外头；留空或 `{}` 清除。参数校验与凭据脱敏见 [AI 对话](ai-chat.md#自定义请求头)。不自动生成或轮换会话值。

## 验证

2026-10-28，Linux x86_64 / Node 22.17.1 / TypeScript / Docker Chrome 121。验证对象为上述插件基线加本次未提交工作树，差异及未跟踪文件的 SHA-256 记录于 `/tmp/miot-133-20261028/verification.json`。

| 检查 | 结果与证据（均在 `/tmp/miot-133-20261028/`） |
| --- | --- |
| `npx tsc --noEmit` | 通过，`typecheck-final.log` |
| `node --experimental-strip-types --test tests/*.test.mjs` | 1327 项通过，`tests-final.log` |
| 前端 `npm run typecheck`、`npm test` | 通过，76 项测试，`frontend-typecheck-final.log`、`frontend-tests-final.log` |
| `npm run build` | 前端与 QuickJS 字节码构建通过，`build-final.log` |
| `npm run validate` | 通过，`validate-final.log` |
| 新回归置于隔离旧源码 | 23 项均因缺少目标行为失败；涵盖配置持久化/连接选择、请求透传、非法配置、凭据脱敏，`negative-final.log` |
| Docker Chrome 实际界面 | 1200px / 390px 均通过保存、刷新、模型检测、独立连接、不覆盖旧配置和清空；`browser-result.json`、`browser-1200.png`、`browser-390.png` |
| 格式化、自审、`git diff --check` | 通过；自审四处请求、流式传输、后台请求、连接隔离与迟到模型结果 |

浏览器使用真实构建产物、配置/模型列表 handler 与 ConfigManager，临时文件保存配置，核对 `browser-storage.json` 和 `upstream.json` 中实际发送的头；网关响应及其他页面 API 为夹具，不代表真实服务或设备验收。

Not run：真实 OpenCode 网关（未提供专用测试凭据）、OH2/S12 实机播报和原生 WebView、长期运行；主仓库 Go 检查（宿主未修改）；远端修复 CI（尚未提交/推送，基线 SHA 未查到运行）。

## 测试截图

以下为上述真实浏览器操作采集的原始截图，网关为测试夹具。

![桌面 AI 设置（1200px）](images/issue-133/ai-settings-1200.png)

![手机 AI 设置（390px）](images/issue-133/ai-settings-390.png)

本记录描述提交前的验证对象。用户已授权提交、推送和带截图回复 Issue；后续提交、自动发布与 CI 结果以 GitHub 对应 SHA 的记录和 Issue 回复为准。父仓库在子仓库提交后同步 gitlink。
