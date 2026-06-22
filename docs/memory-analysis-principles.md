# 记忆分析原则

## P0: 必须先定

- 只基于输入，不脑补
- 证据绑定
- 一次扫描，多维过滤
- candidates 必须可追溯到 memoryId
- 固定 schema + enum
- 允许 neutral / uncertain

## P1: 影响准确性

- 原文是主输入
- 先产出 multi-dimensional candidates
- 再基于 candidates 做趋势分析
- 避免按维度重复扫描原始 memory
- 预处理只降噪，不裁决
- 不改写、不摘要、不语义过滤
- 允许混合情绪
- 禁止医疗诊断

## P2: 输入输出控制

- 先判断是否值得处理
- 保留关键字段
- metadata allowlist
- 长内容 head + tail
- 显式标记截断
- dimension enum
- confidence clamp
- sentiment score clamp
- evidence 来自真实 memory

## 当前接口范围

- 同步轻量分析
- 默认前 10 条 active memories
- 非 deep analysis report job

## 后续 Review

- batch-level summary
- dominant emotion
- average sentiment
- high-intensity count
- risk signals
- evidence memory IDs
