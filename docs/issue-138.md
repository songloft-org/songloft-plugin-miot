# 分组起播时差

关联 [songloft-org/songloft-plugin-miot#138](https://github.com/songloft-org/songloft-plugin-miot/issues/138)。[English](en/issue-138.md)。

## 调查与行为

报告描述 LX06 + OH2P 在空闲后起播错位。基线 `0cc6b92ea4804de0814850acda5d900def789f4e` 的 `MinaService.playURL()` 无条件等待 `pause → stop`，然后才查询型号、读取配置和选择接口。这里没有调用 `playerPauseVerified()`；Issue 提到的两次 700ms 核验属于显式暂停路径，不能直接当作当前预停的调用链。现有代码足以证明预停的两个云端往返会分别推迟各成员的播放请求，但未取得报告人的原始日志或设备，不能据此认定 Wi-Fi 休眠机制或实际发声时差。

采用方案 A：`player_play_music` 已携带 `play_behavior: REPLACE_ALL`，直接替换旧播放。`player_play_url` 保留清理旧媒体上下文的预停，包含用户禁用 Music API 的型号，以及歌词模式多次失败后的直链回退。显式暂停仍回读状态，必要时升级为 stop；显式停止和两轮回答中断保持原有行为。

分组进一步统一起播准备：

1. 并行取得各成员型号、配置，完成歌词匹配及直链所需预停。任何成员准备失败单独返回失败。
2. 全部准备结束后，在各设备原有 ubus 队列中占位，等待已在途请求完成。较快成员保持占位，防止后台状态查询先于新播放开始。
3. 各成员的首条播放指令全部入队后，在同一轮释放占位。使用 `finally` 释放；重复成员只准备、占位和下发一次，结果仍对应输入顺序。
4. 歌单、DLNA 组投放、临时 URL 接口和在线搜索的无歌单回退共用该入口。临时 URL 不再等待主设备回执后才开始播放其他成员。

歌单仍以至少一台成功作为整体成功判据；DLNA 仍要求全员成功并在部分失败时停止整组。准备期间的停止、切歌、外部接管及账号客户端更换通过原播放代次和客户端身份检查取消迟到下发。

这减少插件引入的起播差异，不是带统一设备时钟的定时播放协议。网络传输、云端重试、设备缓冲与歌词播放失败后的降级仍可能造成时差；没有承诺真机零回声或毫秒级声学同步。混合接口组会先共同等待直链预停，整体起播可能较慢。

## 验证

2026-11-12，Linux x86_64 / Node 22.17.1 / npm 10.9.2 / TypeScript 5.9.3；插件基线 `0cc6b92ea4804de0814850acda5d900def789f4e` 加未提交工作树，父仓库 `c3ae379944ff1fb8afad0b541c7fafca6efb2d56`。源码及测试清单 SHA-256：`aa44f6b94a604451af53be2fcc07070f2ed3db4ac8494bdb0340bcaea9eb9c8d`；逐文件摘要见 `/tmp/miot-138-source-manifest.json`，完整交付对象见 `/tmp/miot-138-verification.json`。

| 检查 | 结果 |
| --- | --- |
| `npx tsc --noEmit` | 通过 |
| `node --experimental-strip-types --test tests/*.test.mjs` | 1453 项通过，含 21 项新增分组专项 |
| 新专项在隔离基线下运行 | 4 项预期失败，覆盖三种 Music API 型号的无预停要求，以及 LX06 + OH2P 的实际播放管理器下发时序 |
| 隔离移除准备屏障 | 4 项预期失败，覆盖慢型号、歌词、直链预停和在途状态查询 |
| 隔离移除队列占位 | 1 项预期失败，覆盖准备期间才开始的后台慢查询 |
| 隔离移除直链预停 | 2 项预期失败，覆盖混合组和歌词降级 |
| 前端 `npm run typecheck` / `npm test` | 类型检查及 84 项测试通过，包含 slider/status 回归 |
| `npm run build` / `npm run validate` | 通过，含前端及 QuickJS 字节码构建 |
| 最终 `npm exec -- songloft-plugin build` / `npm run validate` | 通过；恢复预构建下载产生的无关 2027 节假日变动后重新打包 |
| TypeScript 格式化 / `git diff --check` | 通过 |

专项使用真实 `PlaylistManager → MinaService → MinaHTTPClient → ubus 队列`，仅在云端 HTTP、配置及部分准备输入处提供夹具。虚拟时钟模拟空闲二十分钟及 LX06 预停额外耗时 1800ms，修改后两成员的播放请求在同一虚拟时刻发出；慢准备、慢回执、已有慢查询及准备中新增查询分别验证。另覆盖取消、账号失效、单成员失败、重复成员、seek/倍速 URL、Music API 负载、直链降级和显式暂停核验。这里测量的是请求发送，不是云端回执间隔或实际发声。

日志：`/tmp/miot-138-{typecheck,tests-final,frontend-typecheck,frontend-tests,build,build-final,validate-final}.log`；反向验证见 `/tmp/miot-138-final-negative-j1ej5b2l/`。

Not run：LX06/OH2P 实际固件、空闲十至二十分钟后的真机起播/发声、旧歌曲尾音与语音打断后的设备表现、长期连续播放；当前没有设备。浏览器交互未运行，本次无界面改动。未修改宿主 API、Range、转码或 Go 实现，父仓库 Go 检查不适用。

以上为提交前验证记录：当时未提交、推送或正式发布，远端 CI 为 Not run，父仓库指针保持基线。提交、发布和同一 SHA 的 CI 结果在交付后补记。建议提交信息：`fix(player): 减少分组起播时差并跳过 Music API 预停 (#138)`。
