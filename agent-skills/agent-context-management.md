# Agent 长对话上下文管理

## 选择依据

OpenAI 的 [Compaction 文档](https://developers.openai.com/api/docs/guides/compaction)采用“保留近期对话、用压缩结果承接较早状态”的方式；Claude 的[阈值压缩](https://platform.claude.com/docs/en/build-with-claude/compaction-threshold)也在接近窗口时以摘要替换旧内容。Claude Code 还提供[`/compact` 手动触发](https://code.claude.com/docs/zh-CN/commands)。两家的服务端压缩格式分别依赖 Responses API 和 Claude Messages API，不能直接放进当前 OpenAI 兼容的 Chat Completions 消息数组。因此本项目采用应用层摘要，沿用现有网关和计费机制。

DeepSeek 官方[模型列表接口](https://api-docs.deepseek.com/api/list-models/)可以返回 `context_window`，它表示输入与输出合计的窗口。项目对默认 DeepSeek 模型设置 384000 Token 的保守使用上限；这是一项产品配置，不是对模型厂商标称最大窗口的断言。其他模型需在 `AGENT_MODEL_CONTEXT_WINDOWS` 中登记，或由网关 `/v1/models` 返回窗口数据。缺少窗口数据时拒绝发送请求。

## 运行方式

1. 会话完整消息继续保存在数据库中；摘要只影响发给模型的视图。摘要记录其覆盖的消息位置，恢复运行后不会重复压缩相同片段。
2. 发送前估算系统指令、工作区索引、摘要、对话、工具定义及图片的输入量，并预留输出与安全余量。估算用 UTF-8 字节数保守计算文本，用固定额度估算图片；这仍是预检而非供应商精确 Token 计数。
3. 接近预算的 75% 时，用当前模型分批总结较早且已结束的轮次。摘要保留目标、约束、决定、结果、来源和待办；最近两轮原样保留。摘要调用按普通模型请求计费并持久化结果。
4. 过大的工具结果在模型视图中只保留预览和调用标识；Agent 可用 `tool_result_read` 按偏移读取完整结果。原始结果仍保存在会话记录中。
5. 如果最新请求本身超出窗口，或摘要输入无法放入窗口，请求在发送前停止并提示用户分段提供内容，不静默丢失原始信息。

## 配置

`AGENT_MODEL_CONTEXT_WINDOWS=other-model:131072,another-model:200000`。显式配置与网关元数据同时存在时采用较小值。`AGENT_MAX_OUTPUT_TOKENS` 是单次回复预留量，默认 6000。
