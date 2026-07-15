# Voice Memory V3 设计与实现

## 定位

Voice Memory V3 在 V1 精确口令和 V2 实体解析之上增加可视化管理，不替代实时 resolver。固定控制命令仍然绝对优先，语音顺序保持为：固定控制命令、V1 exact、V2 entity、歌曲/歌单规则、AI fallback。

V3 只管理单曲记忆，不接管歌单匹配，不修改 AI API、提示词或账号认证。

## 数据兼容

- 继续使用 `memory:v1:records` 和 snapshot version `1`。
- 旧 `MemoryRecord` 字段不变；V3 字段全部可选。
- `manualAlias` 和 `aliasSource` 标识手动用户说法。
- `memoryHitCount`、`savedAiCalls` 和 `lastHitReason` 保存轻量累计统计。
- 缺少新字段的 V1/V2 记录可以直接加载；展示统计时使用已有 `hitCount` 做保守近似。
- 缺少 `canonicalKey` 的旧记录由 V2 索引在内存中聚合，后续正常命中或写入时懒迁移。

## 实体聚合与别名

管理 API 按现有 `MemoryEntityIndex` 的 canonical entity 聚合记录。同一歌曲的多个 query 只展示为一个实体，原始 query 在实体详情中按需展开。

缺少歌曲元数据、无法进入实体索引的旧记录不会被修改或强制生成 canonicalKey。它们继续支持 V1 exact，并在独立、默认折叠的“未归类记忆”区域中展示和删除，不会混入正常歌曲实体列表。统计中的用户说法数量仍包含这些记录。

手动别名作为普通 `MemoryRecord` 写入原快照，因此 V1 exact 可以直接命中，同时删除、清空、数量淘汰和索引重建继续复用既有机制。别名要求 2 到 30 个字符，拒绝空值、重复值、宽泛词和固定控制词。

## 统计写入

首次学习新口令和 V2 新实体说法仍走现有串行写队列。已迁移的 V1 exact 命中只在内存中累计，并在 5 秒后合并写入一次完整快照。统计写入失败会保留待写增量，不影响播放。

`savedAiCalls` 表示本地 V1/V2 成功命中次数，是节省 AI 调用的轻量近似值。系统不保存完整命中历史。

## 歧义记录

V2 resolver 已明确返回 `ambiguous` 时，VoiceEngine 异步记录 query、原因、候选摘要、出现次数和最后时间，然后继续原规则及 AI fallback。

歧义数据使用独立的 `memory:v3:ambiguous` storage key，最多保留最近 20 条并防抖保存。读取或写入失败不会改变语音处理结果，也不会覆盖 `memory:v1:records`。

## 管理 API

- `GET /memory/stats`：统计摘要。
- `GET /memory/entities`：聚合实体和用户说法。
- `POST /memory/aliases`：添加手动别名，body 为 `canonicalKey`、`alias`。
- `DELETE /memory/aliases`：删除单条用户说法，query 为 `canonicalKey`、`recordId`。
- `DELETE /memory/entity`：删除整组歌曲记忆，query 为 `canonicalKey`。
- `GET /memory/ambiguous`：最近歧义记录。

原有 `GET /memory`、`DELETE /memory`、`DELETE /memory/all` 和 `/memory/self-test` 保留。

## 设置页

语音记忆仍位于 PR #47 的 `data-category="voice"` 卡片内。管理区默认折叠，仅加载统计摘要；展开后才加载实体和歧义。每个歌曲实体的用户说法再次独立折叠。实体列表桌面端最大高度 480px，移动端最大高度 50vh。

Voice Memory 开关不依赖 AI 开关。AI 关闭后，已有记忆仍可命中；复杂新口令的首次学习能力会受限。

## 资源限制与已知限制

- 默认 100 条，允许 10 到 500 条。
- 不新增依赖、数据库、模型、向量索引或外部服务。
- UI 聚合只在管理请求时计算，不进入语音热路径。
- 歧义候选最多保存 5 个摘要，歧义记录最多 20 条。
- 插件在防抖窗口内被强制终止时，最近几秒的统计增量可能丢失，但记忆与播放不受影响。
- 旧记录缺少歌曲元数据时仍只支持 V1 exact，无法进入实体聚合视图。
