# Memory Analysis 深度报告方案

## Summary
- 在 `mem9` 的 `Memory Insight` 右侧新增第三个 Tab，名称定为 `Memory Analysis`；现有右侧同名侧栏重命名为 `Analysis Summary`，保留其当前自动分析/聚合职责。
- 新 Tab 是一套**显式触发、历史可追溯**的 LLM 深度分析报告能力；V1 只做报告展示和结构化 JSON 持久化，不回写 `mem9` 主记忆图或现有关系洞察。
- 深度分析由 `mem9-node` 发起并在后端执行，但数据来源改为 **mem9-node 服务端主动分页拉取 mem9 `/memories`**；原始 `x-mem9-api-key` 只在本次请求内存中短暂使用，不入库、不进日志。
- 分析范围固定为**全量 active 非 session memories**，不受当前页面 time range 影响；触发前先检查：**同一用户自然日仅一次**、`memoryCount >= 1000 && <= 20000`，否则返回明确错误码给前端。

## Implementation Changes
- `mem9` 前端：
  - 在 [memory-overview-tabs.tsx](/Users/bosn/git/mem9/dashboard/app/src/components/space/memory-overview-tabs.tsx) 增加第三个 tab 值 `analysis`，内容为新的“报告列表 + 报告详情”容器。
  - 右侧现有 [analysis-panel.tsx](/Users/bosn/git/mem9/dashboard/app/src/components/space/analysis-panel.tsx) 改文案为 `Analysis Summary`，不承载深度报告历史。
  - 新 Tab 首屏行为：无历史时显示空态和唯一主 CTA `深度分析`；有历史时列表按时间倒序，默认展开最新一份；若最新报告仍在运行，则默认展开并轮询状态。
  - 点击 `深度分析` 后调用新接口；若返回 `DAILY_LIMIT`、`TOO_FEW_MEMORIES`、`TOO_MANY_MEMORIES`、`ALREADY_RUNNING`，前端直接展示服务端错误文案并聚焦已有当日报告。
- `mem9-node` API：
  - 新增报告域，而不是复用现有 `analysis-jobs` 浏览器上传模型。
  - 新接口：
    - `POST /v1/deep-analysis/reports`，body: `{ lang: string, timezone: string }`
    - `GET /v1/deep-analysis/reports?limit&offset`
    - `GET /v1/deep-analysis/reports/:id`
  - `POST` 流程固定为：校验同日限制 -> 调 mem9 `/memories?limit=1` 取 `total` -> 校验 1000/20000 阈值 -> 服务端分页拉全量 memories -> 写临时 S3 快照 -> 创建 report 记录 -> 投递 LLM 队列 -> 返回 `202`。
  - 将 request context 扩展为“指纹 + 原始 key 的仅内存态访问”，并确保审计/日志仍只记录指纹和脱敏头。
- `mem9-node` 持久化与队列：
  - 新增 `DeepAnalysisReport` 表，至少包含：`id`、`apiKeyFingerprint`、`requestDayKey`、`status`、`stage`、`progressPercent`、`lang`、`timezone`、`memoryCount`、`requestedAt`、`startedAt`、`completedAt`、`errorCode`、`errorMessage`、`previewJson`、`reportObjectKey`、`sourceSnapshotObjectKey`。
  - 对 `(apiKeyFingerprint, requestDayKey)` 建唯一约束，`requestDayKey` 采用 `YYYY-MM-DD@IANA_TIMEZONE`，由前端传入的 `timezone` 计算；缺失时回退 `UTC`。
  - 原始 memory 快照只放临时 S3；最终完整报告 JSON 放持久 S3；MySQL 只存列表预览字段和对象 key。
  - 复用现有 `analysis-llm` 队列，消息改成判别联合类型，新增 `deep_report` message；worker 增加一个深度报告处理器。

## LLM Framework
- 采用固定四阶段，避免把 1k-20k 条 memory 一次塞进模型：
  - `Stage 1: Preprocess`：规范化、去重统计、语言/时间跨度统计、基础质量指标、chunk 规划。
  - `Stage 2: Chunk Analysis`：按 token/条数切块调用 `QWEN_MODEL` 指定的模型，每块输出严格 JSON。
  - `Stage 3: Global Synthesis`：聚合 chunk JSON，再调用一次 `QWEN_MODEL` 指定的模型生成最终报告 JSON。
  - `Stage 4: Validate`：校验 schema、evidence memory IDs、计数一致性，失败重试一次，仍失败则报告失败。
- Chunk 和 Final 都必须走**结构化 JSON schema**，不依赖自由文本；每条洞察都要求 `evidenceMemoryIds`，可附最多 2 条短摘录，禁止保存整份原始 memory 正文到最终报告。
- V1 报告 JSON 固定包含这些 section：
  - `overview`: memory 数量、时间跨度、语言、去重后数量、生成时间
  - `persona`: 用户画像、偏好、习惯、目标、约束
  - `themeLandscape`: 高频主题/项目/生活面向
  - `entities`: 人、团队、项目、工具、地点等候选实体
  - `relationships`: `source / relation / target / confidence / evidenceMemoryIds`
  - `quality`: 重复内容、低质量内容、噪音模式、覆盖缺口
  - `recommendations`: 记忆优化建议和后续产品利用建议
  - `productSignals`: 可供未来增强 `Memory Insight` 的候选 nodes/edges/search seeds
- 模型完全通过环境变量注入；新增环境变量至少包括 `MEM9_SOURCE_API_BASE_URL`、`QWEN_API_KEY`、`QWEN_MODEL`、`MEM9_SOURCE_PAGE_SIZE=200`。

## Public Interfaces / Types
- `mem9` 新增前端类型：
  - `DeepAnalysisReportListItem`
  - `DeepAnalysisReportDetail`
  - `CreateDeepAnalysisReportResponse`
- `mem9-node` 新增错误码：
  - `DEEP_ANALYSIS_DAILY_LIMIT`
  - `DEEP_ANALYSIS_ALREADY_RUNNING`
  - `DEEP_ANALYSIS_TOO_FEW_MEMORIES`
  - `DEEP_ANALYSIS_TOO_MANY_MEMORIES`
  - `DEEP_ANALYSIS_SOURCE_FETCH_FAILED`
  - `DEEP_ANALYSIS_REPORT_INVALID`
- 报告状态固定为：`QUEUED | PREPARING | ANALYZING | SYNTHESIZING | COMPLETED | FAILED`；前端只按这组状态渲染，不复用现有 `analysis-jobs` 的 batch 状态枚举。

## Test Plan
- `mem9-node`：
  - API 单测/集成测覆盖：同日唯一约束、1000/20000 阈值、已有运行中报告返回、source fetch 分页、原始 key 不进入审计记录。
  - Worker 测试覆盖：chunk 规划、LLM 输出 schema 校验、evidence ID 校验、阶段推进、失败重试、最终报告写入 S3。
  - 仓储测试覆盖：`requestDayKey` 唯一约束、历史列表倒序、详情读取。
- `mem9`：
  - Tab 切换测试：新增 `Memory Analysis` tab、旧侧栏重命名。
  - 空态测试：首次无报告时只显示 CTA。
  - 历史测试：最新自动展开、旧报告折叠、运行中报告轮询刷新。
  - 错误测试：每日限制、内存数过少/过多、已有运行中报告的提示和跳转行为。

## Assumptions
- V1 深度分析固定分析全量 active 非 session memories，不跟随页面 time range。
- V1 保留所有历史报告；数据库仅存预览和索引，完整报告正文放 S3。
- V1 不把报告结果写回 `mem9` 主 memories、taxonomy 或关系图，只在报告 JSON 中输出可复用结构化信号。
- 现有自动分类分析继续存在并作为 `Analysis Summary`；新 Tab 只承载“手动触发的深度报告”。
