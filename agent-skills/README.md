# GuGu 通用创作 Agent

## 接入语言模型

服务端环境变量（密钥不下发客户端）：

```dotenv
AGENT_API_BASE=https://your-gateway.example/v1
AGENT_API_KEY=your-server-key
AGENT_MODEL=your-default-model
AGENT_MODELS=your-default-model,another-model
AGENT_MAX_OUTPUT_TOKENS=6000
AGENT_CONTEXT_BYTES=120000
```

所有语言请求统一 POST `/v1/chat/completions`。支持 SSE 和返回 JSON 的兼容站点；工具使用 `tools` / `tool_calls` / `tool` 消息。站点必须返回有效 `usage.prompt_tokens` 和 `usage.completion_tokens`，流式请求发送 `stream_options.include_usage=true`。缺失用量或连接中断进入待核账，不会自动重试扣费请求。图片理解需要选用支持 `image_url` 输入的模型。没有工具调用能力的模型只能用于普通对话。

未配置 `AGENT_MODELS` 时尝试从同站点 `/v1/models` 获取目录，失败保留默认模型。显式模型列表适用于站点没有模型目录的情况。环境变量为空时兼容已有 `DIRECTOR_AGENT_BASE_URL` / `DIRECTOR_AGENT_API_KEY` / `DIRECTOR_AGENT_MODEL`，再回退到 `LLM_API_BASE` / `LLM_API_KEY` / `LLM_MODEL`。修改环境后重启服务。

用户可以在画布对话顶部切换模型。切换对下一次语言请求生效；进行中的请求继续使用发起时的模型。语言计费复用当前平台统一 LLM 费率，并非自动同步网关每个模型的价格。

## Skill 扩展

在本目录新增文件夹，例如 `product-copy/SKILL.md`：

```markdown
---
name: product-copy
description: 用户要求撰写产品介绍、推广文案时使用。
---
先理解产品、受众和用户指定的语气。读取已有作品，保留事实。
需要保存时使用 documents_write。只有用户要求配图时才准备媒体生成。
```

也可用 `AGENT_SKILLS_DIRS` 指定外部目录，使用系统路径分隔符（Linux/macOS 为冒号，Windows 为分号）。每个目录包含多个 Skill 子目录。支持按需读取 `references/`、`assets/` 中的文本参考文件，禁止越界路径和符号链接逃逸。Skill 热读取，无需修改运行循环。Skill 是专业方法，不是必须完成的工作流，也不提供脚本执行权限。

## 工具与运行机制

- 语言模型循环根据用户消息自主决定回答、读取 Skill 或调用工具。
- 模型目录从现有平台配置生成，`models_list` 发现图像/视频模型，`models_describe` 获取具体参数；生成统一复用现有生成服务的验证、价格、扣费、任务队列和素材归档。
- 支持素材检索和图片理解、版本化创作文档、带修订冲突检查的剧本/角色/镜头编辑、生成报价和提交、等待异步任务。
- 默认逐次确认媒体费用；用户可开启自动生成并设置会话累计预算。确认绑定具体调用，用户改变要求会使尚未提交的确认失效。已提交媒体任务不会被聊天停止按钮撤销。
- SQLite 保存会话、消息收件箱、工具调用、生成请求及执行租约。服务内调度器在页面关闭后继续工作，重启后恢复等待任务；上游是否收费不明确的语言请求暂停核账。
- 会话按用户、设备、工作区和画布隔离。服务端保存完整工具历史，客户端只展示可见对话、作品、进度与费用确认。
- 当前调度器运行在应用服务进程中；未包含独立 Worker 部署、任意代码执行、网页浏览或 MCP 服务管理。

## 验证

`npm run check`：语法检查。

`npm test`：完整逻辑、HTTP 回归测试。测试需要本地回环端口权限。

`node --test test/agent.test.mjs test/midjourney-grid.test.mjs`：网关协议、工具循环、持久化隔离、重复请求、人工确认、异常核账、Skill 路径隔离、媒体预览和预算限制。

上述测试使用模拟网关，不代表已用真实站点密钥验证所有模型。真实接入还需对实际站点验证工具调用、流式用量和视觉模型支持。

## 画布生成反馈

媒体预检成功后即建立占位画框，等待确认、排队、生成、下载、失败和完成均沿用同一画布节点。活跃会话每 500ms 获取一次快照，空闲时每 1200ms 获取一次；这是短轮询，不是推送事件流。比例先使用请求参数，媒体加载后用真实像素尺寸校正。

每批最多四列，新增批次排在已有内容下方；生成节点的位置保存进项目，后续状态变化不重新排版。用户移动过的节点保持原位。语言模型收到多个独立生成要求时先提交各任务，再统一等待；真实并发数仍受平台现有任务队列限制。

桌面端完成任务后复用本地媒体投递与恢复链路，画框在文件可用前显示保存状态，完成后从 `gugu-media://` 本地地址读取图片或视频。项目结构和对话仍保存在服务端；此实现没有把整个画布项目改为离线文件格式。
