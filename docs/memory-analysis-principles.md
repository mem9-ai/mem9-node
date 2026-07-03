# 记忆分析原则

## 第一轮：候选提取

- 第一轮只做高召回候选提取，不做最终总结。
- 目标是尽量不漏，不追求一次判断完全准确。
- 只基于输入原文，不脑补。
- 每个 candidate 必须绑定 `memoryId` 和 `evidenceQuote`。
- 不强制打 label，避免因为分类不匹配而丢信号。
- 当前维度：`long_term_goal`、`focus_area`、`emotion`、`preference_signal`、`growth_signal`。
- `preference_signal` 和 `growth_signal` 只是候选，不代表稳定偏好或最终成长结论。
- 无可处理内容时直接返回，不调用 LLM。

## 输入控制

- 原文是主输入，metadata 只保留明显有用字段。
- 预处理只能降噪，不能做语义裁决。
- 长内容用 head + tail，保留截断标记。
- 第一轮读取 memory 不能按维度重复扫描。

## 第二轮：本地变化检测

- 第二轮优先本地完成，不重新扫描原始 memory。
- 第二轮输入是第一轮 candidates，按 `dimension + topic` 聚合。
- 第二轮输出通用结构化分析结果，顶层按维度分组。
- 维度内按 topic 生成 topic changes，topic 内按时间顺序提供 timeline。
- timeline 每个点包含当前 state、相对上一点的 transition、evidence memory ids。
- 一个周期内可以有多个 topic、多个变化点。
- tags 在第二轮生成，只用于展示和筛选，不参与第一轮召回。
- 程度变化是通用变化形态；只有 `growth_signal` 才表示能力或认知成长。
- 小规模 candidates 直接全量进入第二轮。
- 大规模时做覆盖式采样，不能只按 confidence topN。

## 第三步：可选润色

- LLM 可作为第三步，只负责把本地变化结果润色成可读表达。
- 润色输入只包含本地 change events，不给原始 memory。
- LLM 不负责重新判断变化，也不引入新事实。

## 证据原则

- 所有结论必须可追溯到 evidence memory。
- 没有足够证据时保留为 candidate，不写成稳定结论。
- 情绪分析不做医疗诊断。
- 稳定偏好需要多条相近证据。
- 成长观察需要明确学习、改进、反思或能力增强证据。
