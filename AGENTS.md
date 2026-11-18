# AGENTS.md

本文件是 `songloft-org/songloft-plugin-miot` 的开发入口，记录智能音箱插件的实现约定、设备兼容与历史回归经验。英文版见 [AGENTS.en.md](AGENTS.en.md)。

## 仓库边界与入口

- 本仓库是独立 Git 仓库，在父仓库工作区位于 `plugins/src/songloft-plugin-miot/`；提交到本仓库的 `main`。
- 插件业务与排障经验维护在本文件；公共宿主、Go 后端和跨仓库通用约定见 [父仓库 AGENTS.md](https://github.com/songloft-org/songloft/blob/main/AGENTS.md)。
- `src/player/manager.ts` 管理播放状态、自动切歌与分组目标；`src/handlers/playlist.ts` 融合 HTTP/WS 状态；`src/playback/voice_resume.ts` 负责语音打断后的恢复；`src/mina/client.ts` 管理设备云端请求、共享采样与退避。
- `frontend/` 为 ReactLynx + TypeScript 界面；`plugin.json` 定义插件清单，最终产物为 `dist/miot.jsplugin.zip`，包含 QuickJS 字节码。工具链 2.22.0 起自动生成带 bundle 内容版本的 `static/index.html`，`static/` 中的 icon 与 Material Icons 许可证副本为入库静态文件。
- 本文件与 `AGENTS.en.md` 内容、结构同步。提交使用 Conventional Commits，描述尽量用中文，不添加 `Co-Authored-By`。
- 提交信息引用本仓库 Issue 可以写 `#124`；引用父仓库 Issue 必须写完整路径，例如 `songloft-org/songloft#495`。子仓库先提交，父仓库再同步子模块指针；服务端和插件分别升级。

## AI 开发、Issue 排查与复盘

- 执行方式见 [AI 开发流程](docs/ai-development.md)，经验见 [LESSONS.md](LESSONS.md)。调查、实现、验证、自审连续执行，不逐阶段确认；关键缺失信息、产品决定或扩大范围才询问。提交、推送、发布和 Issue 写操作分别按明确授权，已有授权不重复询问。
- 关联 Issue 的修复推送后，主动展示回复草稿、完整目标 Issue 和待确认的评论动作；已有适用评论授权则直接回复。CI/发布结果变化时更新草稿，不等用户追问；细则见本地流程的「关联 Issue 回复」。
- 任务前读适用经验，结束记录有证据的新教训并同步英文。三个不同日期的独立事件提出升级，同一事故重复复盘不递增；已有设备回归铁律立即执行。
- 未解决 Issue 排查包含父仓库和所有递归子模块，去重、完整分页，核对正文、全部评论、最新代码及修复/复发证据；报告完整引用和缺口，不把 open 当未修复结论。插件修复、父指针、发布和设备已安装版本分别判断。
- 验证绑定插件与后端仓库 SHA、设备/固件、音频来源、命令和实际结果，相关未跑项写 `Not run`。代码变更重跑受影响项；云端回执、UI 外推或模拟测试不冒充设备采样/实际发声，真实音箱与长期运行未验须明确写出。

## 验证命令

自动发布与每日版本序号见 [自动发布](docs/releases.md)：每个 main 非文档业务提交单独出包，版本为北京时间 `YYYY.M.D.N`，正常换日从 `.0` 开始；纯 Markdown / `docs/` 提交不发包、不占序号，版本提交不递归触发。更改发布脚本时运行 `node --test tests/release_pipeline.test.mjs`，核对文档跳过、失败续跑与 tag/源码对应关系。

在本仓库执行：

```bash
npx tsc --noEmit
node --experimental-strip-types --test tests/*.test.mjs
npm run build
npm run validate
```

Node 22 的类型擦除参数用于直接导入 TS 的测试。构建会先生成词典/节假日数据，再构建前端、打包并编译 QuickJS 字节码；`static/index.html`、`dist/` 为忽略的构建产物，`static/` 中其余文件入库。前端变更另在 `frontend/` 执行 `npm run typecheck && npm run build && npm test`。涉及宿主播放接口、Range 或定时器时，在父仓库执行相应 Go 回归测试和 `make check`。

## 公共宿主 API 使用经验

- 宿主 `internal/jsplugin/assets/common.js` 末尾公开对象决定 `window.SongloftPlugin` 实际可用的成员；使用 `@songloft/client-sdk` 的 `SongloftPluginGlobal`，不要手写宿主 API 类型。
- `invokeHost` 一度只存在于 `window.__SongloftInternal`（标注"插件请勿依赖"）而公开对象里没有，miot 却在自己的 `frontend/env.d.ts` 里手写了 `invokeHost?` 声明，于是 `window.SongloftPlugin?.invokeHost?.(...)` 通过 TS 编译、运行时被可选调用**静默吞掉**，收藏同步整个功能一个字节都没发出去（songloft-org/songloft-plugin-miot#86 第二次复发的根因）。
- 收藏同步通过公开 `invokeHost('favorite', 'refresh', {songId, isFavorited})` 调用宿主；原生 WebView 与 Web/iframe 的传输差异交给 SDK/宿主处理。

## 服务端播放接口的插件侧约定

- 音量均衡：设置页 `volume_normalize` → `URLBuilder.buildSongURL` 追加 `normalize=1&format=mp3`；预热下一首必须携带相同转码参数。
- 不入库直链遇到音箱不支持的 webm/opus 等格式，使用父仓库 `/api/v1/proxy/transcode` 转码代理（`songloft-org/songloft#394`）；token 放在首个查询参数，避免设备固件错误处理 `&`。
- 推 URL 后立即开始倒计时，会把冷启动下载/转码时间算成已听内容。插件 #61 曾出现 `dur_ms=22392/24348/22381` 的首字节等待：前 20 多秒空白，尾部也提前切掉。服务端使用实时流和预热，插件仍必须按真实设备进度校准，不能把缓存完成当成播放完成。
- 部分设备忽略暂停，需要升级为 stop；媒体上下文丢失后，通过带 `seek` 的新 URL 恢复位置（插件 #60）。`playCurrent` 的 seek 必须遵守服务端距结尾 3 秒的边界。
- 随机预热：随机模式下 `PlaylistManager.reserveNextIndex()` 把「预热的那首」和「真会播的那首」
  锁到同一首。`getNextIndex()` 每次调用都重新摇骰子，预热与切歌各调一次就必然热错人（实测 492/500 不一致）
- 流内位置：`PlaylistManager.streamSeekOffsetSec` 记住当前流的起点。带 seek 的流对设备是
  「从 0 开始的新流」，它上报的 `play_song_detail.position` 只是流内偏移，**消费点必须补上偏移**
  （`handlers/playlist.ts` 的 `resolvePlayerStatus`、`playback/voice_resume.ts` 的恢复判断），
  否则续播后网页进度条会掉回 0、自动切歌被推迟一整个 seek 时长

## 续播与重播的历史回归约束（songloft-org/songloft#516）

- **相同现象不等于相同根因**：排查先检索父仓库和插件仓库的全部 Issue，再对相关正文、评论、
  修复提交与现有测试交叉核对。至少覆盖父仓库（`songloft-org/songloft`）的 #171/#404/#408/#437/#449/#466/#481/#488/#490/#494/#495/#500/#503/#514/#516，
  以及本仓库 #54/#60/#61/#63/#87/#88/#95/#96/#98/#103/#114/#124/#129。
  不因旧 Issue 已关闭就认为没有回归，也不要把未发布、未更新插件或旧 ffmpeg 镜像当成代码修复无效。
- **不能仅凭本地计时超前就重推**：缓冲会让音箱位置落后；状态 0/2 也可能误报（songloft-org/songloft#449）。
  自动恢复检测重播需同曲身份、连续新采样推进，以及至少一份采样落在流开头三秒且明显落后保存位置。
  判断前把流内秒换为 `position * speed + seekOffset`。身份未知、重复缓存或交互前采样不能证明重播。
- **保存位置不被暂停后的归零覆盖**：语音任务保存打断锚点，暂停/停止读回值不能把它回拨到 0。
  `resetAutoNextTimer` 是 HTTP/WS 状态融合与智能续播共用入口，必须挡住挂起期间的回零校准；
  只修 `VoiceResumeCoordinator` 会被状态轮询抢先改写位置、递增版本并取消任务（songloft-org/songloft#171）。
- **新操作优先，切歌规则不漂移**：每次 await 后核对任务身份和播放版本；暂停、停止、下一首、
  新对话及 DLNA 接管后，迟到结果不得恢复旧歌曲（songloft-org/songloft#408/songloft-org/songloft#494）。正常续播必须重建剩余时间定时器，
  保留 `transitionOffset` / speed（songloft-org/songloft#404、插件 #87/#88）；重播检测不能替代尾部结束校验（songloft-org/songloft#481/songloft-org/songloft#495）。
  自动恢复临近结尾时使用保护区前的安全整数秒，不能让 seek 守卫退化为整首重播。
- **取证与验证**：访问日志比较请求 `range`、响应 `content_range/content_length` 与实际 `bytes`；
  206 或重复 GET 本身不能证明全量重拉，下载字节也不是已听进度。ffmpeg 失败看完整 `error/output`；
  应用内升级不更新镜像里的 ffmpeg（songloft-org/songloft#403）。回归必须运行插件 `player_failures`、`player_status`、
  `player_transition`、`mina_status`、前端 slider/status 测试，及后端播放/Range/定时器测试。
  Node 22 用 `node --experimental-strip-types --test tests/*.test.mjs`，不能漏掉直接导入 TS 的测试。
  自动化通过只证明覆盖的场景；真实音箱、问题音频与长期运行验收须单独记录，不能宣称已完成。

## 切歌修复的证据与回归矩阵（songloft-org/songloft-plugin-miot#124）

- **无进度与查询失败分开处理**：成功返回明确状态、当前流从未上报有效进度且没有外来媒体证据的设备，
  到元数据截止时间按原时长切歌；`status=-1`、请求超时、进度冻结、流长不匹配继续有界重试。
  不能为修复 #124 删除 songloft-org/songloft#495 的 5 秒查询等待和 30 秒确认宽限期。`hasPosition=false` 的兜底 0
  不是真实回零，`hasPosition=true` 的有效 0 也不能被当作“设备不支持进度”。时长未知时不能凭空注册结束计时器。
- **持续推进不是结束证据（父 #495 再次复发）**：2026-10-12 日志中，`seek=112` 的 631 秒歌曲
  在流内位置 525.009 秒切歌（曲内 637.009 秒）；后续 `seek=0` 的几集同样误切，不能仅归因于 seek。
  流长不匹配时，尾部附近连续新采样、稳定流长和合理进度增量只允许延后检查，不能再用较短的元数据判结束。
  确认后的连续进度可越过元数据尾部 15 秒窗口并刷新 30 秒宽限；证据中断后才按最后有效进度的宽限兜底。
  回零或连续停止单独确认，playing 下的冻结可能是缓冲，不能按元数据尾部的 6 秒停滞规则硬切。
  流长暂时缺失时，尾部探测也不能绕过这份保护；短暂查询失败恢复后须重新建立连续采样。
  恢复的第一份采样暂时静止时保留已确认的流，只重建基线，等下一份推进后再刷新宽限；不能丢掉证据后按旧截止时间误切。
  暂停、语音挂起、重推、新歌及定时器重排清空尾部连续性，区别于保留的“曾收到有效进度”标记。
  原音频真实时长与设备流长差异仍须实机核实，不能直接把设备上报的 3090 秒当作实际播放时长。
- **恢复任务拥有挂起期间的控制权（父 #481）**：HTTP/WS 状态融合在语音挂起、整点恢复等待期间
  只更新音量等展示信息，进度保留保存锚点，不按缓存外推，不调用 `resetAutoNextTimer`。即使单次采样带真实位置，
  也不能证明已续播；重排会递增版本，
  取消仍在等待的恢复任务，形成“进度走、无声音、等下一首才恢复”。由恢复协调器连续确认进度后重建定时器。
  L15A 直链播放被打断后的 `status=3` 不能当作正在播放，也不能与查询失败的 `-1` 混同；
  语音、整点探测、恢复等待和恢复指令校验都须识别该状态，统一使用 `src/playback/device_state.ts` 的状态判据，
  避免只在其中一条链路补状态值。云端恢复指令成功仍须回读；连续 idle 无进度时
  带打断位置重推同一首，保留 seek/倍速/切歌偏移。成功查询却始终无进度的设备，等配置的播报窗口后实际重推；
  查询失败或只有旧采样时保留保守兜底，不能声称已恢复发声。真实进度仍不能被保存锚点或 UI 外推冒充。
  重复缓存不能沿用先前的“无进度成功响应”标记触发超时重推，必须重新收到本轮的新状态证据。
  验收必须同时覆盖有/无状态页面、Music API/直链、语音/整点、seek/倍速、恢复后下一次自然切歌，
  在自然结束前一毫秒断言仍是同一首，结束后断言实际下一首 URL、无失败标记及无打断下一首的 TTS。
- **进度来源必须贯穿调用链**：`resetAutoNextTimer(position, deviceReportsProgress)` 的第二个参数
  区分真实上报与保存锚点/墙钟外推；智能续播超时、挂起时 HTTP/WS 状态融合、插件重载、报时取消及仅流长探测
  都要核对来源。只改 `PlaylistManager` 不够，必须检查 `handlers/playlist.ts` 和 `playback/voice_resume.ts`。
  智能续播曾收到真实进度、随后查询失败时，仍须保留这份证据，不能因最后一份采样缺失而走无进度兜底。
- **证据按当前流保存**：软暂停、语音挂起、续播及计时器重排保留“曾收到有效进度”；新歌、同曲重推 URL、
  新歌单和销毁清空。迟到查询须在播放身份/版本检查之后才记录，不能污染替换流并给它额外加 30 秒等待。
- **状态采样不是换流证据（#124 复发，MIOT-013）**：设备自然播完时会在尾部先报一次 `status=0/2/3`，
  下一份 playing 采样才是重拉后的流。尾部回拨基线 `tailLoopSample` 只能由明确的暂停、停止、重推、
  seek、换歌、外部接管、查询失败等生命周期事件清空；被动 idle 采样必须保留基线，同一流尾部可只推进
  采样时刻，避免 idle 等待被算成长间隔。截止校验与尾部探测两个入口都要按「尾部 playing → idle →
  5 秒后 playing 回零」回归；只测相邻两份 playing 会再次漏掉这条路径。
- **状态不可信设备不等于播放失败（插件 #129）**：OH2 等 Music API/代理播放在正常出声时也会持续上报
  `status=0/position=0/duration=0`。只有本进程下发过、且当前流从未出现正位置或正流长的全零 idle 才进入盲区：
  起播确认先对相对流 URL 做 HEAD 探测，明确 404/410/5xx 才跳歌；流可拉取或探测无结论（超时/外链）
  最多观察两轮后接受播放，由元数据定时器兜底。外停探测忽略这类采样；整点续播窗口内除外，
  继续交给智能续播链。尾部到点若整条流从未上报正位置、已下发超过六十秒且媒体详情仍全零，
  直接按元数据时长切歌，不再附加三十秒宽限。任一采样出现正位置或正流长立即退出盲区，恢复 #124/#495 的严格判定；
  重载接管（`streamStartedAtMs=0`）的流不进入盲区，保持原 idle 判定。真实 404/410/5xx 仍按起播失败跳歌。
- **先复现交叉场景，再修复**：新增测试应在修复前失败、修复后通过；同时断言下一首 URL 是否实际下发、
  队列索引/状态、失败标记、TTS 及剩余定时器。纯 `onSongFinished` 计数或 UI 截图不能证明整个队列能继续。
  全量筛查两仓库的 Issue 和评论后，对相关修复提交、最新复发日志逐项核对；未证实根因的旧报告保留为未知，
  不因标题相似就归并、不因已关闭就跳过。

| 历史问题 | 必须保留的行为 | 回归入口 |
|---|---|---|
| 父 #495 ↔ 插件 #124 | 无进度设备按时切歌；流长失准时持续推进超过元数据和 30 秒仍不误切，证据中断后保留有界确认 | `player_transition`、`player_failures` |
| 父 #481/#171 | 状态轮询不取消语音恢复；直链 status=3 打断后实际续播/重推，整点与语音恢复后下一次自然切歌仍准确 | `player_failures`、`player_status` |
| 父 #404、插件 #60/#87/#88/#95 | 长暂停后按剩余时间续播，seek/倍速/切歌偏移不丢失，真实归零不覆盖打断锚点 | `player_failures`、`player_status` |
| 父 #264/#437 | 时长未知不放弃队列探测，也不凭空设置结束上限；读到设备流长后接回正常计时器 | `player_transition`、后端 seek 测试 |
| 插件 #98 | 云端回执超时不等于设备未起播，保留假失败核验、退避重试与外部恢复兜底 | `player_failures`、`mina_status` |
| 父 #466/#494、插件 #114 | 失败标记有 TTL；全部候选失败仍有重试；自然结束不误标、不发打断下一首的单首 TTS | `player_failures`、前端失败标记测试 |
| 父 #408/#449、插件 #103 | 外部停止与状态误报按进度证据区分；新操作/DLNA 接管后旧任务不得推歌 | `player_failures`、`player_status` |
| 父 #500/#503/#514 | 同设备共享查询、失败退避、控制优先；过期句柄和迟到结果不清理新定时器 | `mina_status`、`player_transition`、宿主 timer 测试 |
| 插件 #124 复发 / MIOT-013 | 尾部 idle 不丢回拨基线；`status=2` 后 5 秒的流内回零仍立即切歌，不落入 30 秒宽限 | `player_transition` |
| 插件 #129 | 全零 idle 不误判起播失败/外部停止；真实 404/410/5xx 仍跳歌；出现正位置或流长后恢复严格判定；整点报时仍可续播 | `player_failures`、`player_transition` |

矩阵修改须与英文版同步。列出的测试文件使用 `tests/<name>.test.mjs`；父仓库与插件独立升级，验收要记录两者版本和实际包含的提交。

## Lynx 前端约定

原生 JSX 位于 `frontend/src/App.tsx` 与 `views/`；`page-state.tsx` 将可观察业务动作绑定到 React 生命周期。复用 `ui/native.tsx`，业务代码不调用浏览器全局对象。输入草稿不得把后台迟到渲染写回正在编辑的原生文本框。Socket 归属、认证、外链与返回交给宿主。前端须跑类型检查、测试、双产物构建及[验证记录](docs/lynx-migration.md)中的 Docker 浏览器矩阵/交互/播放器脚本。
