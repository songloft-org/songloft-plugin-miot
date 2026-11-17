# 设置页显示排查（2026-11-17）

## 对象与范围

仓库 `songloft-org/songloft-plugin-miot`，基线 `2b21e3c754e7fdc1ee685e984caae402362ab331` 加本次未提交工作树；首轮内容指纹见 `/tmp/miot-settings-20261117/verification.json`，说明交互优化指纹见 `verification-description.json`，最新按需折叠与冷启动布局指纹见 `verification-overflow.json`。Linux amd64、Node 22.17.1、Docker Chromium 121；使用现有 `.songloft-dev.json` 的本机 Docker，只读业务接口。`npm run dev` 按用户要求构建、上传并热重载插件 id=35；没有修改定时任务或音箱播放状态，没有提交或发布。

## 定时任务

本机 `/api/schedules` 成功返回 1 条任务。在正常 Chromium 的独立插件页和主程序嵌入页，均能显示这条任务，不能据此认定原生端正常。

`ScheduleSettings` 的 `logTimeFormatter` 是计算属性。`usePageState` 在调用 mounted 回调之前会遍历计算属性，因此即使没有日志，也会先创建 `Intl.DateTimeFormat`。旧实现捕获异常后再次调用同一个 API；没有 Intl、缺少构造器的原生运行环境会再次抛错，阻断任务加载。

修复只替换失败兜底：支持 Intl 时继续按配置时区显示日志；不可用或时区不受支持时，显示带明确 `UTC` 后缀的 ISO 时间。任务列表的存储、调度与执行不变。

- `frontend/tests/schedule_settings.test.mjs`：无 Intl、部分 Intl、无效时区、正常时区与无效日期共 4 项；隔离基线源码有 3 项按目标行为失败，修复后全通过。
- `frontend/tests/schedule-settings.browser.cjs`：在真实插件的背景 Worker 中移除 Intl，再从界面进入定时设置，按只读接口的任务名称/数量核对渲染；不输出任务名称或凭证。隔离构建基线 Web bundle 并拦截替换后，等待任务显示超时；当前 dev bundle 显示 1/1 条本机任务。
- 上述证明缺少 Intl 时的初始化缺陷及修复；用户所用客户端尚待确认，不能把隔离环境直接当作报告人现场取证。

## 播放设置重叠

用户随后指出右上角「说明／收起」使文字看起来被挡住。代码原本将窄屏长说明裁为两行，控制按钮与标题、自动保存标记共占一行，未明确提示还有更多内容。

共用 SectionCard 现在将操作移到说明下方的独立行，文案改为「展开说明／收起说明」并配方向箭头；两行预览明确显示省略号，按钮高度为 44px。展开时显示全部说明，后续卡片按正文高度向下移动；桌面仍直接显示完整说明。标题和说明头部不参与纵向压缩。

`frontend/tests/section-description.browser.cjs` 在真实 Docker 的只读页面检查 320/390/1100px × 亮暗主题，共 6 组、两张播放设置卡片：手机展开/收起、按钮与正文/卡片的边界及 44px 热区均通过。隔离旧 bundle 在「操作位于说明下方」的检查失败；这是交互结构的回归，不把旧两行预览直接描述为已证实的像素覆盖。日志 `description-before-final.log`、`description-after-final.log`，截图在 Docker `/tmp/miot-section-descriptions/`。首轮桌面断言错误要求完整说明高于两行，实际文字可以两行内显示；已修正为完整显示与边界检查后重跑，不作为产品缺陷。

说明优化后，前端类型、116 项测试、隔离双 bundle / QuickJS 构建及包校验通过（`description-{typecheck,tests,build,validate}.log`）；无 Intl 的本机任务显示回归再次通过（`description-schedule-regression.log`）。实际主程序嵌入页同样通过上述 6 组检查（`description-nested.log`）。开发包由原有 dev 进程自动上传，已安装的两份 bundle 与本地产物一致（`dev-installed-description.json`），未操作任务与音箱。

## 说明按需折叠与冷启动设备行补充

用户指出 URL 说明已经显示完整，仍出现「展开说明」。此前 `description.length > 40` 按字符数判断，与实际行数不等价。SectionCard 现在用相同宽度、字体的独立全文节点测量；该不可见节点不占正常布局、不响应点击，也不进入无障碍朗读。仅全文高度超出两行 18px（另容许 0.5px 舍入误差）时允许折叠。测量与可见预览分离，避免预览裁成两行后又误判为已完整、反复切换；宽度与内容改变会重测。测量未知时保持全文可读。最初直接依赖文本 layout 事件的方案未通过当前 Web 折叠检查，已替换为独立布局测量，不记为通过。

首页始终渲染 72px 播放状态区域，包括设备数据尚未到达时；最长的当前状态文案也使用该区域，状态出现和切换不再挤窄设备选择框。设备和播放状态语义不变。

- 前端类型和 119 项测试通过（`overflow-typecheck.log`、`overflow-tests.log`）。新增 3 项覆盖超过 40 字但完整显示、真实溢出的展开/收起/宽度变化以及说明替换；隔离上一实现时「完整显示不出现按钮」断言失败（`overflow-unit-before.log`）。
- `section-description.browser.cjs` 增加实际 URL 说明和宽度切换检查，连同原有长说明覆盖三宽度亮暗主题 6 组；URL 在 320/390/1100px 均完整显示且没有按钮，长说明仍可展开（`overflow-browser.log`）。
- `device-header.browser.cjs` 挂起配置、设备和首次状态 HTTP 响应，仅使用确定性夹具。320/390/1100px 下，选择框在初始空状态、连接中、已暂停、播放中、状态暂不可用各阶段分别稳定为 164/234/320px，状态槽始终 72px（`header-after.log`）。上一 bundle 的 320px 选择框从 244px 缩为 203px（`header-before.log`）。未向真实音箱下发命令。
- 最新构建、校验、实际主程序嵌入页与已安装 bundle 检查分别见 `overflow-build.log`、`overflow-validate.log`、`overflow-nested.log`、`dev-installed-overflow.json`。后端业务自 1499 项通过后未改变，不重复执行；原生 UI 边界仍如下。

Android API 34 模拟器可启动，但进入 Lynx App 后宿主模拟器进程反复退出 139；因此原生播放设置与原生任务页验收没有完成，不记为通过。相关日志保留为 `emulator-*-failed.log`。

## 验证

日志目录 `/tmp/miot-settings-20261117/`：

- 前端类型检查及 116 项测试通过：`frontend-typecheck-final.log`、`frontend-tests-final.log`。
- 插件类型检查及 1499 项测试通过：`backend-typecheck.log`、`backend-tests.log`。
- 隔离 `npm run build` / `npm run validate` 通过：`build-final.log`、`validate-final.log`。dev 双 bundle / QuickJS 构建、自动上传、包校验亦通过：`dev.log`、`validate.log`；`dev-installed.json` 确认已安装的两份 bundle 与本地 dev 产物一致。
- 反向检查：`schedule-before-final.log`、`browser-before-final.log`；正向检查：`schedule-after.log`、`browser-after.log`。
- 隔离基线首轮前端构建因未复制共享后端类型/工具函数失败；补齐源码后 `baseline-build-fixed.log` 构建通过。该依赖缺失不计为产品回归失败。

Not run：Android/iOS/HarmonyOS 原生 UI 验收、真实音箱发声、远端 CI/正式发布；本次未改宿主或后端业务，不重复父仓库 Go 检查。播放说明的网页交互已验证，原生验收仍未完成。
