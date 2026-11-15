# 语音点歌匹配阈值与验证

关联 [songloft-org/songloft#569](https://github.com/songloft-org/songloft/issues/569)。插件基线 `48413d6abc2a34e8094bca3ec2f80457365b5abd`；主仓库基线 `d5935c42d57dce17add89762e5a455a891d39bf0`。本次仅修改插件，尚未提交、推送、发布或安装到真实音箱；父仓库子模块显示 dirty，gitlink 未更新。

## 使用与行为

入口：设置 → 语音 → 搜索 → **歌曲匹配阈值（0–100）**，配置字段 `song_match_threshold`，默认 70。旧配置缺失字段、非数值或非有限值使用默认值；数值越界限制到 0–100。分数是字符串匹配强度，不是统计命中概率，越高越严格。

语音点歌统一处理简繁体、大小写、标点、单个中文数字与阿拉伯数字（如 `九/9`）；结合字面编辑距离与无声调拼音音节匹配，无需启用 AI 或填写模型 key。`cctv9记录` 可以命中 `CCTV九纪录`；只有短标题 `记录` 的候选覆盖不足，默认阈值下被拒绝。100 分要求归一化标题完全匹配；0 分仍不会接受完全无匹配的候选。

- 本地优先：先找达标本地候选，无候选才搜索外部。
- 外部优先：外部歌曲先校验匹配分，未达标或播放失败时回到本地。
- 并行搜索：同时搜索，等待两端结束，按匹配分降序尝试，同分优先本地。播放失败复用本轮剩余候选，不重复搜索或导入。等待较慢来源可能增加延迟，沿用现有索引等待与外部搜索超时。

外部歌曲在导入、追加歌单、播放前校验。歌单内、独立歌曲、缓存兜底、口令预览和失效歌单刷新后的重试使用相同阈值。普通索引搜索和歌手/歌单匹配继续使用现有规则；歌手/歌单外部兜底不按歌曲标题判定。外部搜索源仍遵循既有 topone 返回和源优先级，本次不扩展为外部多结果检索。

## 验证对象与结果

2026-11-15，Linux x86_64、Node 22.17.1，插件未提交工作树；差异标识与命令结果另存 `/tmp/miot-569/verification.json`。浏览器为 Docker `browserless/chrome:latest`，通过真实配置 handler、ConfigManager 和隔离磁盘存储，宿主桥接与音箱使用夹具。插件构建为 QuickJS 字节码。

| 检查 | 结果 / 证据 |
| --- | --- |
| `npx tsc --noEmit` | 通过，`/tmp/miot-569-typecheck.log` |
| `node --experimental-strip-types --test tests/*.test.mjs` | 通过，1492 项，`/tmp/miot-569-tests.log` |
| 前端 `npm run typecheck`、`npm test` | 通过，84 项；`/tmp/miot-569-frontend-{typecheck,tests}.log` |
| `npm run build --ignore-scripts` | 通过，包含 Vue 构建与 QuickJS 编译；`/tmp/miot-569-build.log` |
| `npm run validate` | 通过，`/tmp/miot-569-validate.log` |
| 隔离旧实现反向验证 | 保留新评分模块以避免缺依赖错误，将新增 14 项回归放入旧业务源码：13 项因目标行为失败、1 项评分模块检查通过；`/tmp/miot-569-before.log` |
| 三种优先级实际调用链 | 真实索引 + OnlineSearcher + HTTP 夹具，规则点歌命中电台 1933、调用歌单播放、停止一次，无错误外部导入或失败播报；归入全量测试 |
| 桌面/手机实际设置交互 | 1200px 保存 85、390px 保存 90，刷新界面后分别保持，磁盘存储与新 ConfigManager 读取一致；外部搜索关闭仍可调阈值，无页面脚本错误。`/tmp/miot-569/browser-result.json`、`ui-{1200,390}.png` |
| 格式与自审 | TypeScript Language Service 格式化本次改动，`git diff --check` 通过 |

全量 `npm run build` 的 prebuild 会联网更新次年节假日；本次已撤回该无关生成物，并用 `--ignore-scripts` 重新构建现有入库数据，未改变节假日安排。源码差异、包哈希与日志仅代表本地验证，不代表设备已升级。

Not run：真实音箱型号/固件、报告人曲库及在线搜索源验收、实际发声、长期运行、远端 CI。没有可用的报告人设备/账号；本次也没有提交或推送。主仓库 Go 回归不适用，本次未改变宿主接口或 Go 实现。
