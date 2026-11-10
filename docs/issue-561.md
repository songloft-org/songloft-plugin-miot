# 全部歌曲虚拟歌单

关联 [songloft-org/songloft#561](https://github.com/songloft-org/songloft/issues/561#issuecomment-6758336062)。[English](en/issue-561.md)。

## 行为

- 播放歌单选择器首项为「全部歌曲」，展示当前曲库中的本地和网络歌曲，排除 `type=radio` 的电台，包括非直播电台。无需创建实体歌单或复制成员。
- 每次加载按 ID 升序、每页 1000 条读取，直到原始分页不足一页；不受语音索引 `max_song_index` 的数量上限影响。整页都是电台时仍继续下一页。
- 支持网页选曲、随机播放、切歌、上次进度及插件重载恢复。重载时按已保存歌曲 ID 定位，曲库增删导致下标变化时仍优先恢复同一首。
- 定时任务可按虚拟歌单 ID 选择，语音歌单查询可用名称「全部歌曲」；起始歌曲查询使用同一份过滤与排序。
- 虚拟入口为只读：列表隐藏删除操作，全屏播放器禁用删除，后端拒绝成员删除；外部搜索的追加目标只列出可写的实体歌单。管理歌曲请使用主程序曲库。

固定身份为插件内部保留的 `Number.MAX_SAFE_INTEGER`，区别于设备临时队列的负数 ID。虚拟 ID 不传入宿主实体歌单读写接口。曲库更新后，重新加载或重新开始该歌单时读取最新成员；正在播放的队列保持本次加载的快照。

## 验证

2026-11-11，Linux amd64 / Node 22.17.1；插件基线 `1379528daab3841e7e3ca0edb05d14046ff14a17` 加未提交工作树，父仓库 `cda7928858f2e99045f7b76f8f3ba691e10b48da`。源码与测试文件的内容清单摘要为 `e83a3084657895f140f1d0d259d557939ff86d768f612637eb888116edf8609b`，本地插件包 SHA-256 为 `cccc151f7f8f3851d1562909dea5c861708b3bb275905449d42d94e435d4f186`。逐文件摘要、环境和验证对象见 `/tmp/miot-561-verification.json`。

| 检查 | 结果 |
| --- | --- |
| `npx tsc --noEmit` | 通过 |
| `node --experimental-strip-types --test tests/*.test.mjs` | 1432 项通过，含 9 项新增虚拟歌单回归 |
| 隔离基线运行新增专项 | 7 项按预期失败；验证旧实现缺少入口、播放、恢复及只读保护 |
| 隔离副本移除电台过滤 | 6 项失败，确认回归能捕获电台进入计数和队列 |
| `npm run build` / `npm run validate` | 通过，含前端构建及 QuickJS 字节码编译 |
| 最终 `npm --ignore-scripts run build` / `npm run validate` | 通过；保持已入库词典和节假日数据，不引入预构建下载的无关更新 |
| 前端 `npm run typecheck` / `npm test` | 类型检查及 84 项测试通过 |
| Docker Chrome 121，1200×850 / 390×844 | 两首歌曲可见、电台不可见；实际点击选曲、上一首、随机模式、下一首后回读真实播放管理器和 URL；列表无删除入口，全屏删除按钮禁用，页面异常为零 |
| `git diff --check` | 通过 |

浏览器使用构建后的真实前端、歌单 handler 与播放管理器，曲库桥接、账号、音箱控制为测试夹具。断言不只依赖截图；`/tmp/miot-561-browser-report.json` 记录实际歌曲 ID、模式、持久化状态和下发 URL，截图为 `/tmp/miot-561-{desktop,mobile}.png`。日志为 `/tmp/miot-561-{tests,before,mutation,frontend-tests,typecheck,frontend-typecheck,build-final,validate}.log`。

Not run：真实音箱/固件、实际发声、长期连续播放、远端 CI 与正式发布。未修改宿主接口或 Go 代码，父仓库 Go 检查不适用。本次未提交、推送或发布，父仓库子模块指针未更新。
