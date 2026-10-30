# 校园版模型调用诊断

2026-10-30 增加可观测字段。保留现有模型、思考强度、并发方式、超时及兼容重试行为；未实施此前撤回的 B 预览、统一生成时限或取消空正文重试方案。

同日根据诊断结果，将文献综述 A 的输出上限由 6000 提高到 16000，将 C 仲裁上限由 8500 提高到 16000；B 保持 6000，普通双模型共识合并保持 2200。上限由 `backend/synthesize.js` 设置，思考强度不变。DeepSeek 的输出额度包含思考与正文，提高上限用于减少额度耗尽导致的空正文或截断，不保证缩短耗时。

校园版 A 于 16:47:49、C 于 16:58:40（北京时间）重启生效。A 调整后的一个请求以 `stop` 一次完成，输出 9591 token，其中思考 7436 token；该请求中尚未调整的 C 以 `length` 截断，促成后续 C 上限调整。C 调整后的完整性仍需用后续真实请求验证。两次上限修改均通过本地和服务器各 24 项相关测试及服务健康检查。

## 查看日志

```bash
sudo journalctl -u ailunwen-school-api.service --since '30 minutes ago' --no-pager -o cat | grep -E '\[llm-diagnostic\]|\[perf-stage\]|\[perf-summary\]'
```

按 `requestId` 对齐搜索，按 `callId` 对齐一次逻辑模型调用，再按 `attempt` 区分内部 HTTP 请求。`mode` 为 `stream`、`stream_without_options` 或 `non_stream`。文献 A、B、C 仲裁均关联搜索性能记录。

`start` 记录调用起点；`headers` 记录响应头到达；`first_reasoning`、`first_content` 记录首次观察到相应内容；`retry` 记录回退原因；`end` 记录此次请求完整数据。同一请求的结束信息也写入 `llm.attempt.A/B/C` 性能阶段。

主要字段：`headersMs`、`firstChunkMs`、`firstReasoningMs`、`firstContentMs`、`bodyCompleteMs`、`durationMs`、`maxChunkGapMs`、`inputTokens`、`outputTokens`、`reasoningTokens`、`finishReason`、`httpStatus`、`responseModel`、`contentChars`、`reasoningChars`、`errorCategory`、`abortKind`。

非流式响应只能在读完整个响应体后统计内容，`timingMode=body_end_only` 下的 `firstContentMs` 不是上游首 token 时间。没有返回 token 统计时字段缺省，不能当作零。`headersMs` 包括网络和上游等待，单靠它不能区分两者。

## 归因方法

- `finishReason=length`、`contentChars=0`、`reasoningTokens` 接近输出预算：支持思考耗尽输出预算的判断。
- 同一 `callId` 有多个 `attempt`，前一次结束后紧接 `retry`：逐次相加判断内部回退是否放大耗时。
- 响应头很早到达，思考持续很久后才出现正文：等待集中在响应生成阶段。
- `abortKind=timeout` 与 `abortKind=caller` 分别代表该次客户端计时器和调用方取消，不混同为上游错误。
- 现有代码可能将只有思考内容的非流式结果标记为成功；诊断用 `outcome=reasoning_only` 与 `contentChars=0` 显示此情况，不改变现有返回语义。

日志仅记录计数、时间、模型标识和受限状态；不记录密钥、完整输入、正文或思考内容。`inputFingerprint` 使用进程内随机盐，只用于同一进程中的输入相等比较，重启后不可直接比较。

上线前本地 224 项、服务器隔离目录 213 项测试通过。上线后的合成短文本验证中 A 单次调用约 2.18 秒，B 约 1.17 秒，均正常结束。该样本不代表真实文献综述耗时，也不能反推之前 115 秒请求的原因。
