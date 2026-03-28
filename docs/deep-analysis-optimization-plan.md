# Deep Analysis 质量优化、重复清理导出与本地免限流方案

## Summary

- 开工前先把本计划落库到 `docs/deep-analysis-optimization-plan.md`，作为本次实现的规格说明。
- 这次优化同时解决四件事：
  - persona 洞察不够深
  - `themeLandscape` / `entities` 被 stopwords 和泛化词污染
  - duplicated 增加“只导出可删除 duplicate”的下载能力
  - 本地开发完全取消 deep analysis 的业务限制；只有生产环境才启用“每天一次”等限制
- 默认规则：
  - `NODE_ENV !== "production"` 时，deep analysis 不做每日次数、运行中冲突、1000-20000 条 memory 数量限制
  - `NODE_ENV === "production"` 时，保留现有限制，并支持按 fingerprint 白名单临时绕过“每天一次”
  - duplicated 下载格式使用 `CSV`
  - persona 结构扩充，不只优化文案

## Implementation Changes

### 1. 文档先行

- 在 `mem9-node` 的 `docs/` 下新增计划文档，内容即本规格，文件名固定为 `deep-analysis-optimization-plan.md`
- 实现阶段以该文档为准，若设计有变更，先更新文档再改代码

### 2. Deep analysis 生成质量优化

- 在 `apps/worker/src/deep-analysis-report-processor.service.ts` 重构 deep analysis 流程，保持四阶段：
  - `Preprocess`
  - `Chunk Analysis`
  - `Global Synthesis`
  - `Validate`
- `Preprocess` 增加两层过滤：
  - 通用 stopwords 过滤，中英文各一套
  - 泛化业务词/角色词过滤，至少覆盖：`the`, `and`, `for`, `user`, `agent`, `assistant`, `self`, `team`, `project`, `task`, `system`, `memory`, `workflow`
- `themeLandscape` 改成“短语优先、单词兜底”：
  - 优先输出 2-4 token 的高信息量短语
  - 单词主题必须通过 stopword/general-term 过滤和最小信息量阈值
  - 禁止纯代词、冠词、角色词进入最终 highlights
- `entities` 改成“候选抽取 + 规则清洗 + LLM 复核”：
  - 删除 `The`, `User`, `Self`, `Assistant`, `team` 这类伪实体
  - People / Teams / Projects / Tools / Places 只保留有明确证据的项
  - 泛化标签不进最终实体列表
- chunk prompt 和 final prompt 统一改成强约束 JSON：
  - 明确禁止输出 stopwords、代词、泛化角色名
  - persona 必须做跨 chunk 的稳定模式归纳
  - themes / entities / relationships / persona evidence 都必须带 `memoryIds`
- `Validate` 增加：
  - theme/entity 黑名单校验
  - persona 字段最小密度校验
  - evidence memory IDs 存在性校验
  - synthesis 失败时先重试一次，再回退 heuristic report

### 3. Persona 结构扩充

- 报告中的 persona 固定扩展为：
  - `summary`
  - `workingStyle`
  - `goals`
  - `preferences`
  - `constraints`
  - `decisionSignals`
  - `notableRoutines`
  - `contradictionsOrTensions`
  - `evidenceHighlights`
- persona 生成要求固定为：
  - 每个字段必须来自多条 memory 或多 chunk 汇总，不允许只复述单条内容
  - `summary` 至少覆盖长期关注点、工作方式、行为倾向三部分
  - `contradictionsOrTensions` 用来展示“效率 vs 细节”这类张力，没有则返回空数组
  - `evidenceHighlights` 每项带 `memoryIds` 和短摘录

### 4. Duplicated 导出与清理清单

- 保留现有 duplicate cluster 结构：`canonicalMemoryId + duplicateMemoryIds[]`
- 新增专用导出接口：
  - `GET /v1/deep-analysis/reports/:id/duplicates.csv`
- 导出规则固定为：
  - CSV 只包含 `duplicateMemoryIds`
  - `canonicalMemoryId` 绝不作为待删除项导出
  - 可附带 canonical 的短摘录预览，但不导出 canonical ID
- CSV 字段固定为：
  - `duplicateMemoryId`
  - `clusterIndex`
  - `canonicalPreview`
  - `duplicatePreview`
  - `reason`
- 前端在 `Memory Analysis` 的 quality 区块新增下载按钮：
  - 文案固定说明“只包含建议删除的 duplicate memories，不包含 canonical memory”
  - duplicate 数量为 0 时不显示按钮

### 5. 本地开发免限流与生产白名单

- 在 `apps/api/src/deep-analysis.service.ts` 增加环境感知规则：
  - `NODE_ENV !== "production"`：完全关闭 deep analysis 的业务限制
  - `NODE_ENV === "production"`：启用每日次数、运行中冲突、1000-20000 数量门槛
- 本地开发关闭的限制固定包括：
  - 同日只能运行一次
  - 已有运行中报告时禁止再次创建
  - `<1000` 和 `>20000` memory 数量门槛
- 生产环境新增 fingerprint 白名单：
  - 配置项：`DEEP_ANALYSIS_DAILY_LIMIT_BYPASS_FINGERPRINTS`
  - 值为逗号分隔的 fingerprint hex 列表
- 生产白名单规则固定为：
  - 命中白名单时，只绕过“同日只能一次”
  - 不绕过“已有运行中报告”限制
  - 不绕过 memory 数量门槛
- 为了不暴露原始 key：
  - 白名单只保存 `apiKeyFingerprint`
  - 不把原始 API key 写进代码、配置文件或数据库
- 增加一个本地运维辅助命令或脚本：
  - 输入原始 `x-mem9-api-key`
  - 结合当前 `APP_PEPPER` 计算 fingerprint hex
  - 只在本地终端使用，不写文件
- 测试时的临时解除方式固定为：
  - 本地开发：直接运行非 production 环境，无任何业务限制
  - 生产临时测试：把 fingerprint 加入 `DEEP_ANALYSIS_DAILY_LIMIT_BYPASS_FINGERPRINTS`，测试结束后移除并重启 API service

### 6. 前端展示调整

- `dashboard/app/src/components/space/deep-analysis-tab.tsx` 跟随新报告结构渲染 persona 扩展字段
- `themeLandscape` 和 `entities` 只展示过滤后的高质量结果
- `quality` 区块展示：
  - duplicate ratio
  - duplicate memory count
  - duplicate cleanup CSV 下载按钮
- 历史报告兼容策略：
  - 老报告缺少新 persona 字段时前端按空值渲染
  - 不要求历史报告回填迁移

## Public Interfaces / Types

- `packages/contracts/src/analysis.ts` 扩展：
  - `DeepAnalysisPersona` 新增 `workingStyle`, `goals`, `constraints`, `decisionSignals`, `notableRoutines`, `contradictionsOrTensions`, `evidenceHighlights`
  - `DeepAnalysisQuality` 新增 `duplicateMemoryCount`
  - 新增 `DeepAnalysisDuplicateExportRow`
- `mem9-node` API 新增：
  - `GET /v1/deep-analysis/reports/:id/duplicates.csv`
- 配置新增：
  - `DEEP_ANALYSIS_DAILY_LIMIT_BYPASS_FINGERPRINTS`

## Test Plan

- `mem9-node`：
  - stopwords/general-term 过滤后，`themeLandscape` 不出现 `the/for/user/agent/team`
  - `entities` 不接受 `The/User/Self/Assistant/team` 这类脏实体
  - persona 在 1000+ memory 场景下输出扩展字段且 evidence IDs 合法
  - duplicate export 只导出 duplicate IDs，不导出 canonical ID
  - `NODE_ENV !== "production"` 时，同日多次运行、小样本、超大样本都不会被业务限制拦截
  - `NODE_ENV === "production"` 时，非白名单仍受每日限制；白名单只绕过每日限制，不绕过运行中冲突和数量门槛
- `mem9` 前端：
  - persona 新字段渲染正常
  - duplicate 下载按钮仅在有 duplicate 时显示
  - 点击下载命中 CSV 接口
  - 过滤后 theme/entity 不显示 stopwords/general terms
- 回归：
  - 历史报告详情仍可正常显示
  - 旧的 daily limit 提示在生产环境保持不变
  - 本地开发环境点击 `Deep Analysis` 可以连续执行多次

## Assumptions

- 本次只优化 `Memory Analysis` 报告质量和 duplicate 导出，不把结果回写到 `Memory Insight` 图谱
- 本地开发免限流用于测试便利，不通过前端开关暴露
- 生产白名单仅用于运维/测试，不入库
- 历史报告不做数据迁移，前端按向后兼容方式渲染
