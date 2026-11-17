# MIoT Lynx 前端迁移验证

日期：2026-11-16。任务为参考 bili，将 miot 全前端迁移到 Lynx，保留现有布局与功能，允许同步公共宿主。后续本轮已按用户明确授权提交推送主程序（8917470）及配套客户端（02b1dba）；SDK v2.21.0 已发布；miot 与主仓库引用的最终提交见下方最新交付记录。[English](en/lynx-migration.md)。

## 验证对象

以下基线加本轮未提交工作树；最终 tracked diff 与 untracked 文件 SHA-256 清单在本机 `/tmp/miot-lynx-validation/worktree.json`。

| 仓库 | 基线 SHA |
|---|---|
| songloft | `e2bfea9b1b2ccce65176f27e9fa0968dbc14acd9` |
| songloft-player-lynx | `88e00646a6c948c3497fbf32eaab3c80f04bdd82` |
| plugin-toolchain | `08d78e9341b2f1ce7b3e3b5792959d413e7d8be0` |
| songloft-plugin-miot | `fc46bdc5a717840780d8bef6a26d3079ed2ac6b3` |

实现包括 ReactLynx 主界面、虚拟歌曲窗口、迷你/完整播放器、歌词/收藏/音量/倍速/延迟停止，以及设备、播放、语音、AI、定时、工具箱设置。`@vue/reactivity` 只管理业务状态；无 Vue 渲染器。状态、聊天及对话记录使用宿主 socket，离开/隐藏清理连接，迟到结果核对身份。外部搜索源测试移到插件后端，保留保存源认证与有限超时。HTTP 增加 `/api` 前缀别名，原路由兼容。

需要配套升级服务端及 Lynx 客户端，旧宿主不能提供新增 PUT/DELETE/socket/back 能力。插件 manifest 的旧 `minHostVersion` 仅对应服务端旧版本编号，不能表达客户端桥接能力；不能据此认为旧客户端完整兼容。没有虚构新正式版本号。当前固定使用已发布的 Lynx SDK 2.21.0 的公开 HTTP/PluginSocket 接口；本地 socket 模块仅重导出共享类。

## 自动检查

环境：Linux、Node 22、pnpm 11、Go、Android SDK；隔离 SQLite 数据库在 `/tmp/miot-lynx-validation/data/test.db`，未使用工作区业务数据。

| 范围 | 命令 | 结果 |
|---|---|---|
| 插件后端 | `npx tsc --noEmit`；`node --experimental-strip-types --test tests/*.test.mjs` | 类型通过；1495 项通过 |
| 插件前端 | `npm run typecheck`；`npm test` | 类型通过；76 项通过 |
| 插件打包 | `npm run build`；`npm run validate` | 双产物/QuickJS/ZIP 校验通过 |
| 最终插件包 | `./node_modules/.bin/songloft-plugin build`；`npm run validate` | 通过；跳过网络 prebuild，保留基线节假日数据，排除无关下载变更 |
| Lynx SDK | `pnpm --filter @songloft/lynx-plugin-sdk build` / `test` | 类型通过；9 项通过 |
| 服务端 shim | `node --test scripts/tests/lynx-plugin-fallback.test.mjs` | 3 项通过 |
| Go 插件宿主 | `CGO_ENABLED=0 go test -tags dev,lite ./internal/jsplugin` | 通过 |
| Lynx 客户端 | `pnpm exec tsc -b`；`pnpm test`；`pnpm run build`；`pnpm run build:web` | 类型、3833 项、双构建与 Web 部署通过 |
| Android | `node scripts/copy-bundle-android.mjs`；`cd android && ./gradlew --no-daemon assembleDebug` | 通过，生成 Debug APK |

输入测试覆盖拖动中状态覆盖、确认只提交一次、焦点期间不回写旧草稿、多行输入与 disabled 状态切换的 Hook 顺序。父桥另覆盖读取凭据期间的关闭取消（修复前专项 1 失败/2 通过）。对话连接测试覆盖旧连接迟到事件、隐藏不重连与轮询清理。原语音、播放状态、过期结果、失败恢复和聊天竞态用例继续保留。

## 浏览器验证

Docker 容器 `songloft-540-safari-chrome`，Chromium 121 + Puppeteer；运行真实构建入口和隔离后端。脚本不属于默认 Node 单测，以免误连运行中的业务实例。指定 `MIOT_TEST_BASE_URL` 为隔离测试地址；示例：

```bash
docker cp frontend/tests/lynx.browser.cjs songloft-540-safari-chrome:/tmp/miot-matrix.cjs
docker exec -e NODE_PATH=/usr/src/app/node_modules \
  -e MIOT_TEST_BASE_URL=http://127.0.0.1:30617 \
  songloft-540-safari-chrome node /tmp/miot-matrix.cjs
```

- `lynx.browser.cjs`：320/390/1100 × 亮/暗 × 六类设置，共 36 组；检查可滚动区域、所有可见元素/原生输入的横向边界、实际滚轮。播放配置开关经 UI 写入、后端读回并恢复。
- `interaction.browser.cjs`：真实接口新增/更新/删除定时任务，逐次读回持久状态；多行角色提示词经 PUT 保存读回；host back 依次关闭选择器、编辑器、分类、设置页。只读写隔离实例。
- `player.browser.cjs`：真实 Lynx 渲染，HTTP 设备夹具（禁用真实 WebSocket，验证 HTTP 状态兜底，避免空设备流覆盖夹具）。1000 歌单的搜索分页、1000 歌曲的滚动/搜索，确认滚动内容高度超过 70000px、最多挂载 30 歌曲行；播放模式、1.5×、收藏、歌词点击 seek、音量 +1 与延迟停止，核对请求目标和参数。夹具不证明云端控制或发声。
- 实际打开 `clients/player-lynx/web/dist`，通过已登录宿主打开嵌套 miot frame，核对同样的定时 CRUD 与多行 PUT；服务端 HTML 回退另行运行上述脚本。证据位于 `/tmp/miot-lynx-validation/`（matrix、interaction、player、web-frame 日志及截图）。

发现并修复：旧 static/index 覆盖 builder 入口；字体 webpack URL 与嵌套 frame 字体缺失（最终改用 SVG）；旧编码器不处理 media query；scroll-view 强制 flex；条件调用 useContext；textarea 内容盒越界；web-core scroll-view 委托焦点使长表单点击跳到首个密码框；受控文本回写迟到草稿导致丢字。宿主 Web 焦点修正不阻断原生文本输入，普通点击正常触发 blur。

## 样式与首次打开复验（同日补充）

用户反馈迁移后的视觉偏离原版。本轮将上述插件基线的 Vue 源码单独构建并实际打开作为参照，恢复主界面、52px 歌单/搜索控件、桌面歌曲表格、268px 设置侧栏、卡片/按钮/图标、移动端迷你播放器及封面/歌词分页、桌面双栏播放器。设备首卡在 390×800 为 `x=12,y=143,w=366,h=187`，1100×800 为 `x=292,y=247,w=784,h=187`；与旧版的位置/尺寸误差均 ≤1px。恢复 AI/聊天原 scoped 样式的间距。播放器保留元数据配色和封面模糊；原 Vue 的 canvas 封面取色没有移植到原生。

首次打开原来由 `state.loading` 阻止整页显示，2 秒配置延迟下首屏约 2259ms。现在立即显示页面框架，配置相关按钮/歌单在加载期间禁用。`frontend/tests/startup.browser.cjs` 挂起实际配置请求，确认页面已显示，再放行并确认设置可用。相同隔离环境最终对照：bili 首屏 403/247ms，miot 315ms；注入 2 秒延迟的 miot 首屏 312ms、配置就绪 2495ms。单机样本用于证明网络等待已移出首屏，不代表所有设备都与 bili 同速；miot 业务包仍较大。

父宿主对完整 `.bundle` GET 增加 gzip：本轮生产 Web bundle 约 744KB → 204KB，减少约 73%；原生 bundle 约 718KB → 237KB。压缩需要同步服务端修改。新增 Go 回归先在旧实现因缺少 gzip 失败，修复后通过，核对解压内容、Range 精确字节/Content-Range、HEAD 原长与 304；父仓库 `make check` 全量通过，增强断言后重跑 `./internal/jsplugin`。

本轮前端类型与 77 项单测、生产双 bundle/QuickJS/包校验、36 组设置页、390/1100 旧版卡片尺寸断言、手机和桌面千条列表/播放器、实际宿主嵌套 frame 的定时 CRUD/多行 PUT 全部通过。新列表行高为手机 64px、桌面 56px，千条滚动高度分别约 64000/56000px（取代上轮 70000px 阈值）。客户端代码未变，因此未重复上一轮客户端 3833 项和 Android 编译。

证据在 `/tmp/miot-style-reference/`：`capture.log` 为旧版测量，`appearance-final.log` 为新旧尺寸断言；`matrix-final.log`、`player-final.log`、`player-desktop.log`、`web-frame-final.log`、`startup-before.log`、`startup-final.log`、`startup-regression.log`、`go-check.log`、`go-plugin-final.log` 与截图记录实际结果。最终对象在 `worktree-final.json`；稳定验证包在 `build-worktree/dist/miot.jsplugin.zip`，ZIP SHA-256 为 `fd2e2f8698e031f9b229a27ef90115667fa6927780c6450fc3a054d7d2b492a9`。构建使用隔离副本，避免与用户运行中的 `npm run dev` 竞争输出目录；用户预览进程保留。

## 手机二级设置、全屏与弹层原生复验（同日再次补充）

用户继续反馈手机分类正文不可见、全屏播放器和层级异常。本轮首次实际运行 Android 14 / API 34 x86_64 模拟器中的原生 Lynx 4.0 bundle；使用独立 AVD、软件图形和临时后端/设备夹具，没有用户账号或真实音箱。模拟器通过临时 Docker 的 `/dev/kvm` 启动，避免修改宿主设备权限。先前「Android 原生 UI Not run」仅为前轮历史状态，本轮下述范围已有原生证据。

原包复现：点设备后标题变化但分类列表仍占满页面；隐藏主页文字重叠于顶部；全屏白字落在浅色背景。修复改为显式页面/移动分类/封面歌词条件渲染，设置组件直接订阅导航；保留已访问分类的草稿时使用独立容器和显式 visibility，避免隐藏节点绘制残影。背景色直接设置，不再依赖动态内联 CSS 变量。选择器锚定后卸载原居中标题/取消节点，避免文字残影。六个原生分类正文均已检查；AI 首次截图早于绘制完成，复访正文正常。虚构设备账号导致部分聊天读取失败，不把这部分记为聊天服务验收。选择器和模态框通过 ReactLynx portal 挂到 `#miot-app`，脱离滚动容器/播放器的合成上下文，明确菜单、选择器、确认框、提示的层级；弹出卡片通过遮罩 flex 对齐，避免依赖原生 fixed 的隐式起点。

原生 ADB 实际点击验证分类进入/返回、封面向左滑至歌词、模式菜单及请求、更多菜单叠加删除确认框与系统返回。截图像素复验：设备页顶部取样区的残留黑色像素从 1220 → 0；全屏背景样本从 `[219,224,236]` → `[73,66,36]`。`native-final-device.png`、`native-final-full.png`、`native-final-popup.png`、`native-final-confirm.png` 和 `native-pixel-check.json` 保留证据，截图不证明真实发声。

新增浏览器断言核对弹层直接父节点、实际命中层和屏幕边界；旧包先因「overlay must escape scroll/player stacking contexts」失败，修复后通过。36 组设置页改用手机触摸，验证分类菜单确实腾出空间；320×520、390×740、1100×800 千条列表/播放器、取消确认不删除、原生返回顺序，以及真实宿主嵌套 frame 的 CRUD/多行 PUT 均通过。配置请求挂起首屏回归、类型检查、77 项单测、双 bundle/QuickJS/包校验通过。客户端与 Go 源码本轮未变，不重复上轮全量检查。

本轮证据目录 `/tmp/miot-layers-validation/`；`before.log`、`settings.log`、`player-320.log`、`player-390.log`、`player-1100.log`、`interaction.log`、`web-frame-final.log`、`startup.log`、`frontend-tests.log`、`build.log`、`validate.log` 和 `worktree-final.json` 标识结果及未提交对象。稳定验证包 `build/dist/miot.jsplugin.zip` SHA-256：`c5e9e860e1e865b47fcceaa483a59da35985c2c1e65812d80ecb00853234c222`；复用 Android Debug APK SHA-256：`2b6c2ba7093ff7d72f437841d27cf87fe6407d0b4f0caf5681cda276b8415143`。物理手机、iOS、HarmonyOS、真实账号/音频与发声仍为 Not run。没有提交、推送或发布，用户预览进程保留。

## 弹层定位、歌单选择与主程序风格适配（同日补充）

用户允许贴近主程序风格、保留主要布局。本轮沿用设备栏 → 歌单/搜索 → 歌曲列表 → 播放器和设置分类结构，采用主程序默认蓝色主色、亮暗背景/填充层级、细边框和圆角。SVG 图标与播放器前景通过主题上下文跟随宿主 theme push；不声称同步宿主自定义主题包的全部颜色。桌面歌单框固定 320px、手机占满可用宽度，菜单宽度跟随触发框。「继续播放」移至歌单下方固定 40px 状态行，当前播放/无记录/忙碌只禁用按钮，避免状态变化造成控件消失、宽度跳动。

Android 复现旧包：点击第二歌单后菜单关闭，但没有 `/playlists/2/songs` 请求，内容仍为第一歌单。仅加 `flatten={false}`/`catchtap` 不足；原生固定遮罩内的 fixed 卡片绘制与命中坐标错位。卡片改为遮罩内 absolute，统一按根容器与触发按钮实际测量定位，自动向上/向下展开并限制屏幕边界。选择器、模式、倍速、音量、更多和睡眠弹层复用定位；原生最终包已收到第二歌单歌曲/进度请求，标题与歌曲实际更新。清空歌单同时使在途歌曲/进度请求失效，旧源码回归按预期失败。

音量恢复为窄竖直滑条、百分比、±5 和记忆静音前音量，拖动只预览，释放提交一次。Android 的触摸 `detail.y` 相对插件页面，而 `boundingClientRect.top` 包含宿主/状态栏偏移；用根容器偏移归一化后，最终包实际拖动产生 60、80 两次独立音量命令，原错误坐标会将约 80% 算为 100%。取消/卸载和测量迟到均有回归。Android 续播第二歌单实际发出 `playlist_id:2,start_position:"resume"`，随后歌曲更新、按钮留在原位并禁用。

本轮前端 `npm run typecheck` 与 `npm test`（87 项）、隔离 `songloft-plugin build`（原生/Web bundle、QuickJS）和 `npm run validate` 通过。Docker Chromium 121 的 36 组设置（320/390/1100 × 亮暗 × 六类）、三种宽度的千条列表/播放器、回退与实际主程序嵌套 frame 的定时 CRUD/多行保存/返回、挂起配置首屏回归均通过；首屏样本 360ms 且配置仍未返回。输入在 focus 回调之前到达时也会保护本地草稿，旧实现专项回归失败；浏览器脚本等待原生输入解除 readonly 后才键入，并验证第二歌单独有的歌曲标题，避免误认旧行或过早输入。

原生环境复用上一轮 Android 14/API 34 x86_64、Lynx 4.0 Debug APK（SHA-256 不变）。最终验证包 SHA-256：`95798a214bf4d66195ef60abfbb1c50692074af9a5e08c36ec52cd502d0db74e`。证据目录 `/tmp/miot-popover-validation/`：`front-tests.log`、`build.log`、`validate.log`、`settings-final.log`、`player-{320,390,1100}-final.log`、`interaction-final.log`、`web-frame-final.log`、`startup-final.log`、`theme.log`、`old-clear-regression.log`、`old-focus-regression.log`；`proxy.log` 和 `native-final-{main,menu,choice,resume,volume}.png` 记录原生请求与呈现。旧包复现见 `before-{select,choice}.png`；坐标排查见 `coordinates.log`。最终未提交对象为 `worktree-delivery-final.json`，稳定包为 `build/dist/miot.jsplugin.zip`。构建隔离于用户 dev 输出，用户预览进程保留。客户端与 Go 源码本轮未变，未重复全量客户端/Go 检查；物理手机、iOS、HarmonyOS、真实账号/音箱/发声仍为 Not run。未提交、推送或发布。

## 歌曲封面原生绘制修复（同日补充）

用户反馈封面不显示。本轮用确定的 128×128 四色 PNG 替换无封面的设备夹具，在 Android 14/API 34、Lynx 4.0 复现：列表与迷你封面正常，已收到 `w=640` 的 200 图片响应，全屏区域却只显示灰色底。大封面类的 box-shadow 直接落在 image 上，触发原生位图不绘制；此前无封面夹具只能验证占位状态，不能验收封面。

修复将圆角、裁剪、阴影、动态尺寸留在外层 view，内部 image 通过类定义铺满容器，保留原布局。封面 URL 只对宿主歌曲端点附加缩略图宽度/恢复参数并由 resourceUrl 授权；内嵌 data URL 与外部签名 URL 保持原值，避免 `_r=0` 破坏编码或签名。加载失败最多重试两次，重新进入可见期恢复预算并重建图片节点。并发槽看门狗改为实际获取槽位后启动，防止排队封面在尚未发请求时全部超时失去加载机会。

新增 `frontend/tests/covers.test.mjs` 的 5 项回归，在隔离旧 Cover 实现中全部按预期失败，当前前端类型检查与 92 项测试通过。双 bundle/QuickJS 构建与包校验通过。`covers.browser.cjs` 在 Docker Chromium 121 的 320/390/1100 宽度验证本地授权、data、签名封面实际解码、无封面占位、404 有界重试、恢复显示，以及列表/迷你/全屏尺寸；原播放器千条列表/音量/模式/倍速/收藏/seek/睡眠/确认框回归通过。实际主程序嵌套 frame 的同一封面检查亦通过。

Android 最终包实际打开列表与全屏，用相同四个采样点核对渲染：旧包全为 `[234,234,240]`，新包分别为 `[224,64,80]`、`[32,128,224]`、`[32,192,128]`、`[224,192,32]`，与 PNG 原始像素精确一致。证据目录 `/tmp/miot-cover-validation/`：`native-before-{list,full}.png`、`native-final-{list,full}.png`、`native-pixels.json`、`proxy.log`（只记授权是否存在与宽度，不打印 token）、`old-regression.log`、`frontend-tests.log`、`browser-{320,390,1100}.log`、`nested-final.log`、`player.log`、`build.log`、`validate.log`。未提交对象由 `worktree-final.json` 标识；稳定包 `build/dist/miot.jsplugin.zip` SHA-256：`8ea49e1f015cb49dd38418b2a82b0d835bbc8335cdd5ddb102a072acf4363216`。复用上一轮 APK，客户端与 Go 本轮无改动，不重复它们的全量检查。物理手机、iOS/HarmonyOS 原生封面及用户实际封面源为 Not run。用户 dev 进程保留，未提交/推送/发布。

## 真实 Docker 封面、下拉闪动和网络分页（同日补充）

本轮使用用户 `.songloft-dev.json` 指向的现有 Docker 做只读复核，不改业务数据，不停止其 `npm run dev` 自动构建上传。实际嵌套插件页旧宿主 30 行均为占位，未发起封面图片请求；运行中的桥接缺少 resourceUrl。临时按 bili 方式经插件后端返回 Base64，连续采样 30/30 解码，证明缺口；用户随后明确允许不兼容旧宿主并授权提交推送主程序，因此最终撤掉临时代理，恢复直接授权图片请求，保留六个并发槽。最终封面需要更新 Docker 中的主程序及其内嵌 Lynx Web，不能只更新插件包。

已按授权先提交推送客户端 `songloft-org/songloft-player-lynx@02b1dba`，再提交父仓库 `songloft-org/songloft@8917470` 更新指针及服务端 shim/压缩能力。miot 和 toolchain 本身仍为未提交工作树，没有提交插件或发布工具链。父仓库 make check、3 项 shim 回归通过；新直接封面 URL 断言核对认证、子路径、宽度及端点限制，旧 shim 负向检查失败。客户端类型、3833 项、双构建、实际 Web、89 项发布检查和 Android assembleDebug 通过；远端 CI 状态另按对应 SHA 记录，不把进行中的作业记为通过。

菜单闪动来自 open 先绘制居中卡片，再异步测量并切到下拉位置。现在测量完成后只绘制一次；测量失败仍能显示一次回退卡片，等待期间返回不会迟到弹出。旧实现选择器专项 2 项失败/1 项通过，新实现全部通过。浏览器 MutationObserver 检查首次卡片就有 select-popup 定位，不仅截取稳定后画面。

歌曲此前只是 UI 虚拟窗口：每个歌单请求最多 10 万条；歌单菜单还为统计「全部歌曲」读取整库。现在菜单只读 songs/stats，歌曲默认每页 100 首（接口上限 200），滚动接近底部或「加载更多」才请求下一页；新 limit 查询返回分页对象，不带参数的旧接口保持数组。普通歌单的搜索和排序在宿主分页前完成，全部歌曲保持 ID 顺序、跳过电台并按原始页游标前进，临时歌单在内存切页。前端共享在途下一页，慢页保留已加载内容；切换/搜索立即使旧页失效，搜索防抖 250ms，当前歌曲定位只加载到目标所在页，删除已加载歌曲同步调整下一页游标。实际播放队列仍由原来的后端流程管理，未把浏览列表分页冒充播放队列分页。

在真实 Docker 的只读样本中，49 个歌单元数据 142ms；全部歌曲首批 100 首/19449 bytes/95ms，普通歌单首批 100 首/20282 bytes/108ms、第二批 57ms，均有 next_offset/has_more。记录只含统计，无账号、歌曲名称或 Token；这不是跨设备性能保证。独立 Chromium 121 在 320×520、390×740、1100×800 以及实际主程序嵌套 frame 验证首批 100、阻塞第二批、去重、未加载的第 999 首服务端搜索和菜单无居中首帧。36 组设置、播放器及本地/data/签名封面/恢复检查通过；前端 99 项、后端 1499 项、额外 428 项播放回归、类型及双 bundle/QuickJS/校验通过。分页旧路由负向检查因全量加载按预期失败。

证据目录 `/tmp/miot-list-validation/`：actual-before.log、actual-after.log 为临时兼容前后 0/30 与 30/30；actual-paging.json 为真实分页统计；select-before.log、paging-before.log、shim-before.log 为负向检查；frontend-final.log、backend-final.log、playback-final.log、paging-{320,390,1100}-final.log、nested-paging.log、settings-final.log、player-final.log、covers-final.log、build.log、validate.log 标识本地检查。客户端构建和父仓库检查分别为 client-*、android-build.log、go-check.log、shim-tests.log。最终对象为 worktree-delivery.json，稳定插件包 build/dist/miot.jsplugin.zip SHA-256：`209c537742a216a044dc19f482baca69b586a480be67c2745942dd116475cc3e`。本轮未重跑 Android 原生 UI；此前相同图片节点结构的模拟器证据见上一节；物理手机、iOS/HarmonyOS 原生 UI、真实音箱发声 Not run。用户 Docker 更新由用户执行。

远端交付补充：客户端 SHA `02b1dba82bfada8c6c1567f8858bef455433a11f` 的 [CI](https://github.com/songloft-org/songloft-player-lynx/actions/runs/43851394967) 已成功，Android、iOS、HarmonyOS、两种 Web 及开发版发布均通过；这补齐了编译覆盖，不替代原生 UI/物理设备验收。父仓库 SHA `8917470b20028976cb4c5559e3c1d8053bcdca11` 的 [CI](https://github.com/songloft-org/songloft/actions/runs/43851431335) 质量和前端构建通过，Docker full 多架构 manifest 推送成功，`songloft/songloft:dev` 已发布；未操作用户的容器更新。整轮发布中的旧 Flutter Bundled Linux 任务因 tray_manager 的 app_indicator_new 弃用被 Werror 拒绝而失败，不记为整轮 CI 全绿。远端记录为 ci-server.json、ci-client.json、ci-linux.log；published-image.json 确认 linux/amd64、linux/arm64、linux/arm/v7 平台。

## 设置布局、收藏显示与 SDK 发版（同日补充）

服务器地址的下拉框与输入框确实贴在一起：SlInput 未转发调用点传入的 style。现在转发 style/className/无障碍标签，地址控件之间保留 12px。DLNA 名称/地址改为说明在上、输入在下；320px 屏幕内输入宽度由旧包的 186px 恢复到 266px，390/1100 宽度分别为 336/746px。接收器的长名称、分组说明、状态和错误收进各自卡片，保存操作与正文分开。审阅全部分类及语音四个子页面，补齐展开口令、记忆、依赖提示和搜索源的间距、换行与操作对齐。

歌单搜索采用搜索图标与独立 56px 搜索行，内部编辑器 40px，跟随下拉框宽度；主页搜索编辑器也改为 40px，避免超过外框。设备弹窗取消固定 300px 列表，按账号/设备数量和可用高度计算，上限 400px；390×740 下空列表弹窗高 174px、一台设备 210px、30 台设备 526px（内部列表高 400px）。320×520 的 30 台列表也限制在屏幕内并可滚动，桌面最大宽 420px。

收藏的两个 SVG 路径原本完全相同，已收藏时也画成空心。现在收藏为红色实心，取消后恢复轮廓，并同步按钮标签。另为收藏状态增加修订号，避免迟到的初始状态查询覆盖刚完成的加/取消收藏。旧包红心中心像素透明、旧状态竞争回归失败；修复后实际按钮 SVG 中心为不透明红色，POST 加/取消状态均正确。

验证环境为父宿主 8917470 的隔离后端 30617、Docker Chromium 121 和确定的 HTTP 夹具，未操作真实音箱。前端类型检查、101 项单测、双 bundle/QuickJS 构建和包校验通过。settings-layout.browser.cjs 验证 320/390/1100 × 亮暗 × 六类设置（语音细分四页），共 54 组，包含实际展开的 21 个口令、长记忆说法、三个 DLNA 接收器、输入最小尺寸、12px 间距、边界/滚动以及隔离配置保存与恢复。等待主题 class 和展开文字确认后才测量；x-input 为 display:contents，尺寸取 shadow root 内真实编辑器，不能把外层的零宽误判为输入不可见。三宽度播放器/歌单搜索、红心及取消收藏通过；设备 0/1/30 和手机/桌面共七组通过。分页/慢第二页/未加载歌曲搜索、定时增改删、多行输入保存和四层返回也通过。最终 UI 包 SHA-256：`2ee52f485e7ba6b44820cedb1e009b6bd3913f16c19132bb9c1f6fa7cfe1a791`，稳定包 `/tmp/miot-ui-review/build/dist/miot.jsplugin.zip`。后端业务未变，不重复前轮 1499 项；本轮 Android/iOS/HarmonyOS 原生 UI、物理设备、实际 DLNA/AI/发声为 Not run。

证据目录 `/tmp/miot-ui-review/`：settings-themed.log 为严格主题/展开检查，player-{320,390,1100}-final.log、picker-*.log、frontend-tests.log、typecheck.log、build-final.log、validate-final.log 为当前结果；favorite-before.log、favorite-race-before.log、settings-before-corrected.log、server-gap-before.log 为对应旧实现负向检查；interaction-final.log 与 paging-final.log 为交互和分页复验。最终未提交对象为 worktree-ui-sdk-pending.json。用户 dev 自动构建上传进程保持运行；只有隔离 30617 由测试脚本手动安装包，未手动上传到用户 Docker。插件和父仓库本轮未提交。

按用户新增授权，工具链功能提交 `28980b9e9c26b87d4a7889d6f7a50824d376c74b` 和统一发版提交 `2c4512212e780ed56a5ac87d3630f8c09ebfaafa` 已推送，tag 为 v2.21.0；增加 PUT/DELETE、PluginSocket，并防止关闭后的迟到失败及无效推送干扰连接。工具链构建/示例、11 项 SDK 回归和 3 项发布恢复检查通过，隔离移除两项连接防护时两项测试失败。[该 SHA 的 CI](https://github.com/songloft-org/plugin-toolchain/actions/runs/43858863167) 在 Node 18/20/22 全通过；[发布](https://github.com/songloft-org/plugin-toolchain/actions/runs/43858862982) 的六个平台 jsc 构建通过，但 npm 拒绝 @songloft/lynx-plugin-sdk 发布（E404 权限/Trusted Publisher），本机凭证 E401。已向用户请求为该包配置 songloft-org/plugin-toolchain 的 release.yml Trusted Publisher。此时 Lynx SDK 2.21.0 尚未发布，miot 仍为 2.20.0，不能把 tag/部分 npm 包成功当作完整发布或依赖已升级；配置后恢复同一 tag，再更新依赖及复验。

## SDK 正式发布与依赖升级复验

用户配置 npm Trusted Publisher 后，恢复相同 v2.21.0 tag；[恢复发布](https://github.com/songloft-org/plugin-toolchain/actions/runs/43860094887) 成功，GitHub Release 已生成，已存在的 npm 包跳过，没有另起版本。npm 在处理新包时曾短暂返回 E404/ETARGET；最终从 registry.npmjs.org 安装 `@songloft/lynx-plugin-sdk@2.21.0`，package-lock 记录正式 tarball 与 integrity。miot 前端改为 apiGet/apiPost/apiPut/apiDelete，共享 PluginSocket；原本私有 socket 适配器改为重导出，保留业务 ApiError/响应解包及连接生命周期。此次只升级对应的前端 Lynx SDK，后端 SDK/构建器保持既有依赖。

升级后重新执行前端类型检查与 101 项单测、后端类型检查与 1499 项单测、原生/Web 双 bundle、QuickJS 打包及 validate，全部通过。Chromium 121 实际验证 54 组设置布局、播放器收藏/音量/倍速/歌单搜索、分页慢页与服务端搜索、挂起配置首屏、定时 CRUD 与多行保存/返回；已构建主程序的真实嵌套 frame 也通过定时 CRUD 和多行保存。新增 socket.browser.cjs 使用 CDP Network 事件确认真实状态 WebSocket 收到首帧、隐藏关闭连接、恢复后第二条连接收到状态；账户/设备为 HTTP 夹具，未控制真实硬件。初版脚本误用了另一浏览器驱动的 websocket 事件，后改为 Puppeteer 支持的 CDP，未将该驱动错误作为产品缺陷。

证据目录 `/tmp/miot-sdk-published-validation/`：frontend-typecheck.log、frontend-tests.log、backend-typecheck.log、backend-tests.log、build.log、validate.log、settings.log、player.log、socket-final.log、interaction.log、web-frame-final.log、paging.log、startup.log；npm-sdk-final.json 与 sdk-release.json、sdk-ci-release.json 确认已发布/可安装对象。稳定本地包 build/dist/miot.jsplugin.zip SHA-256 为 `237b09c23c3d1ed992b8e014696dea8a06389c8d7285b6984d1e00d82c2dc8fd`，待提交工作树清单为 worktree-before-commit.json。本轮未再次运行 Android/iOS/HarmonyOS 原生 UI、真实云账号/音箱/发声。用户运行的 dev 自动打包上传保持开启，既有 2027 节假日数据改动不纳入本次提交。

## 本轮远端交付

SDK v2.21.0 的恢复发布和 npm 实际安装成功。miot 实现提交 `68b915e46ab989e3b904d753e0961c389d8a0a9c` 已推送，[对应 CI](https://github.com/songloft-org/songloft-plugin-miot/actions/runs/43862082872) 成功；自动版本提交 f0840ce 已拉回，正式 [v2026.11.16.0](https://github.com/songloft-org/songloft-plugin-miot/releases/tag/v2026.11.16.0) 已发布。

下载的正式 ZIP SHA-256 为 `6b23acfe751b3230708b2df3cda77cd1fd9671be44879bb3bd795ae284bfbdb6`，包内 releaseSource 与上述实现提交一致，renderEngine 为 lynx。安装到隔离后端后，真实状态连接隐藏/恢复和真实主程序嵌套 frame 的定时 CRUD/多行保存再次通过（released-socket.log、released-web-frame.log）；仍不证明物理设备发声。发布元数据见 miot-release.json/miot-ci.json。文档提交仅补充验证记录，主仓库随后同步 SDK 和 miot 的最终子模块引用。用户 dev 进程与未提交的 2027 数据保留。

## 第一批交互优化预览

用户要求先通过 npm run dev 体验，基线为 2aa138c 加未提交工作树，本轮不提交或发布。保留主布局：顶部设备名改为可点击的播放目标，桌面最大 320px，旁边单独显示播放/同步/失败状态；不会用 WebSocket 是否连接来冒充音箱在线。超过八台设备提供账号/设备名称搜索，选中设备明确标记“当前”。

自动配置保存改为设置栏内的保存中/已保存状态，失败保留待提交补丁并提供重试，不再用普通成功黑条遮住控件。失败后的新编辑合并旧补丁并优先保留最新值；提交时快照嵌套字段，回执仅更新已确认字段。服务器地址重试后同步配置提示；服务器、DLNA 与 AI 对话等手动表单有明确标记。手机重复大标题原已隐藏，本轮保持；缩小分组/正文间距，较长说明默认两行，可用“说明/收起”展开，桌面保留完整说明。

前端类型与 105 项测试通过；三项新保存队列回归在旧实现按预期失败，另覆盖地址重试提示。双 bundle、QuickJS 和包校验通过。Docker Chromium 121 用隔离 30617 检查三种宽度的设置、亮暗主题、保存故意失败→重试→持久读回、说明展开、设备搜索/选中及播放器；dev 产物另通过真实状态连接隐藏/恢复与定时 CRUD/多行保存。完整结果与截图在 /tmp/miot-first-batch，最终工作树清单为 worktree-preview.json。没有修改业务后端，未重复 1499 项后端测试；本轮原生 Android/iOS/HarmonyOS、真实音箱/发声为 Not run。

已按用户指令运行 npm run dev，通过现有 .songloft-dev.json 自动构建、上传并 hot-reloaded（id=35），持续监听供用户测试。测试手动安装仅针对隔离服务，未另行手动上传到用户 Docker；没有将账号凭证写入验证记录。

## 预览追加：播放器、删除入口、数值和分页

仍基于 2aa138c 的未提交工作树，通过 npm run dev 供用户评估，不提交/发布。移除首页重复的 MIoT 标题和常驻刷新图标，保留设置入口；内容刷新移到设置→工具箱。歌曲行使用“歌曲操作”菜单，区分从歌单移除和从曲库永久删除，各自确认；宿主 songs.delete 不删除本地原文件，文案明确保留原文件、清理封面与缓存。全屏移除复用列表操作，保持分页数量/游标一致，也不会修改正在查看的其他歌单。

手动触摸/滚轮浏览歌词时暂停跟随，点击“回到当前歌词”或点歌词跳转后恢复。数值框使用数字键盘、单位、范围和失焦修正，清空恢复上次值；负数设置提供正负号按钮。延迟停止的自定义值严格校验，非法值不会被修正为有效定时后提交。手机常用图标、播放控制、歌词切换点和下拉选项采用 44px 热区，开关保留视觉尺寸并加原生 hit-slop。

首批歌曲使用骨架屏，分页显示已加载/总数；失败保留已加载行和游标，提供行内重试并阻止自动重复请求，搜索数量按实际匹配计算。延迟停止弹层摆脱通用菜单的固定高度/右下角定位，按内容居中、最大宽 360px，四周保留 16px；展开自定义、错误提示和活动定时后自动调整，小高度时内部滚动。修复歌词切换提示文字挡住扩大后的按钮。

验证对象为本节功能代码的隔离构建（canonical zipHash 31d9022cd0005c24b94de7d01d8ce2c68fcf7951e6455a9843501fc6159e609f），基线与最终未提交差异另见 /tmp/miot-extended-preview/worktree-preview.json。两层类型、112 项前端测试、1499 项插件测试、双 bundle/QuickJS 和包校验通过；新增分页失败与播放歌单移除回归在隔离旧实现下按预期失败。Docker Chromium 121 的 320×520、390×740、740×360 横屏、1100×740 检查弹层普通/自定义/错误/活动/直播形态，实际请求证明设定与取消；还检查歌词手动滚动期间进度更新、恢复跟随、数值修正及真实后端读回。歌曲两类移除和分页失败→重试覆盖三种竖屏/桌面尺寸；横屏仅验证播放器与设置数值，不把其夹具列表点击当作覆盖。另通过 54 项亮暗主题设置布局、三尺寸千条列表/播放器、设备选择、分页慢请求和真实状态连接检查。证据在 /tmp/miot-extended-preview；真实音箱发声与原生 Android/iOS/HarmonyOS 本轮 Not run。

发现两个 dev 进程同时写 dist/_build 导致 ENOENT；退出本轮启动的重复监听，保留用户终端的 npm run dev。独立测试构建与用户 dev 使用不同目录；最终只读核对用户 Docker 的 id=35：active、entryHash/zipHash 及 Web/Lynx 两份 bundle 均与本地 dev 包一致，确认自动上传。相同 dev ZIP 安装到隔离服务后，390px 全部追加交互与真实状态连接隐藏/恢复再次通过（dev-polish.log、dev-socket.log）。未手动上传用户服务器。

## 2026-11-17 · 保留页面的封面重载

本批现已获用户提交、推送及同步父指针授权，实际 SHA、自动发包与流水线结果见 `/tmp/songloft-miot-delivery/delivery.json`；下文未提交描述保留为初次验证状态，原生验收边界继续保留。

后续当前歌曲定位空白另见[专项记录](locate-current-song.md)：旧滚动目标值复用导致虚拟行与视口脱节，改为每次显式命令；128 项前端、1499 项插件测试、双包/校验与两种宽度重复定位通过，原生未验。此补充与下文封面恢复属于同一未提交工作树，未发布。

基线 `6fba93e6f3bdb4e73c00a9a58da67475cd0519d1` 的 Cover 在每次 resumed 时清空所有 source、增加 nonce、更换 image key；本地 URL 同时追加 `_r`。即使宿主保留同一 Tab，也会重载健康图片。本批只让失败/超时封面进入恢复路径，加载中和排队任务保持，保留两次自动重试与 data/签名 URL 的原样传递。

十项封面专项在隔离旧源码中五项失败，修复后十项通过；124 项完整前端与 1499 项插件后端测试、两层类型、Lynx/Web 双包、QuickJS 与 ZIP 校验通过。证据 `/tmp/songloft-miot-reentry/`，源码摘要见 `verification.json`。完整客户端测试另有一项既有桌面 `clientUpdate.download` 缺键失败，不能记作全绿；相关导航/插件测试 112 项通过，客户端类型/双产物构建通过。

独立 SQLite/端口 30618 安装本批 ZIP，Docker Chromium 121 在 390/1100 宽度实际渲染。增加 MutationObserver/节点身份与网络请求断言：十次暂停/恢复后，前三张健康封面无节点移除或地址修改，无新增本地图片请求，原 404 封面恢复；data/签名、无封面占位及列表/迷你/全屏检查通过。日志 `browser-{390,1100}-final.log`，截图 `covers-{390,1100}-list.png`。设备/图片 API 使用夹具，未接真实音箱。

本批未提交/推送/发布或更新父指针；不沿用上文历史授权。客户端另修复首页入口未保留原生 frame 的机制。鸿蒙闪退尚无堆栈和设备复现，不能将封面重载或子引擎重建直接定为崩溃根因。Not run：HarmonyOS 真机/模拟器与原生壳重新编译、真实音箱交互；本批没有 ArkTS/Kotlin/Swift 修改。

### 内部设置与全屏往返补充

用户明确复测方式为 npm run dev 安装，闪动发生于插件内部设置或全屏播放器返回，默认封面也受影响；因此未按“插件容器必然重建”归因。`cfe970655459f540fd42a298d3fd6ffd400d8d65` 基线下，设置分支卸载整个 SongList，返回后实际封面和默认占位节点均被替换；全屏虽保留节点，但迷你播放器从文档流移除，390 宽度下列表高度 438→504→438。新 `navigation_covers.browser.cjs` 在旧包下按列表尺寸断言失败，并同时记录默认节点替换。

主列表现始终保留；设置页以有实心背景的绝对定位层覆盖，返回不重新挂载列表。播放器外层保留宽屏 90px/窄屏 66px 槽位，全屏和设置不改变列表尺寸；设置里的 Player 仍沿用卸载，避免增加播放器轮询。本批在用户原有提交推送授权下继续修复，实际交付见 `/tmp/songloft-miot-delivery/delivery.json`。

类型、128 项前端测试、双 bundle/QuickJS 与包校验通过。Docker Chromium 121 的 390/1100 宽度和 390×540 短屏检查真实封面、无封面占位、列表节点、尺寸和滚动偏移；每组设置/全屏各往返六轮，节点不移除，尺寸/偏移不变。1000 首/歌单的播放器模式、倍速、收藏、seek、音量、睡眠和最多 30 行虚拟渲染回归通过。日志 `nav-before.log`、`nav-final-{390,1100,540}.log`、`player-after-nav.log`、`nav-{types,tests,build,validate}.log`。前述恢复显示的源地址失效问题与本节内部列表生命周期问题分开记录；原生真机 UI、键盘和后台/音箱行为 Not run，无证据宣称进程闪退已解决。

## Not run 与边界

- iOS `xcodebuild`：Linux 无 Xcode；HarmonyOS HAP：本轮环境无 DevEco/Harmony 构建工具。已跑跨平台方法契约，不代表 Swift/ArkTS 编译通过。
- Android 原生 UI：首次启动曾因 `/dev/kvm` 权限失败，后续独立模拟器覆盖见上文。物理 Android 手机仍为 Not run；APK 编译通过不等于原生页面验收。
- 真实 Xiaomi 登录、硬件控制、DLNA 投放、AI 服务、外部搜索服务及实际发声/长期后台播放：没有可用账号、设备及对应服务；业务回归与夹具不能替代这些验收。
- 各轮远端 CI/发布状态以上文对应 SHA 为准；未在 Flutter 原生 WebView 真机上验证 HTML 回退，当前回退证据来自 Docker Chrome。
