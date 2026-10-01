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

运行时默认只把每项 Skill 的名称和简介放入模型上下文。模型判断确有帮助时调用 `skills_read` 读取正文，再按需要读参考文件；界面选择的 Skill 也是提示，不会强制装载其内容。无关的新一轮请求不会继续携带上一轮读取的 Skill 正文。外部技能目录由部署方管理；同名 Skill 以先配置的目录为准，内置目录优先。

## Hypit 复刻方法

`video-replication` 直接读取 `references/hypit/` 中的 Hypit 原技能与全部参考资料；正文逐字节保留，执行接口由 `references/gugu-tools.md` 统一替换为 GuGu 工具。不引入 Hypit Runtime 或 Studio；GuGu 的 `video_edit` / `video_edit_read` 提供声明式图层、移动缩放和目标台词定位，支持常见图文、画中画、分屏和排名卡片。

源副本位于 `vendor-hypit-skill/`。更新副本时先确认版本与许可证，再执行 `node scripts/agent/sync-hypit-skill.mjs`，同步更新版本记录；`--check` 校验活跃副本和清单。长技能资料由 `skills_read` 返回 `nextOffset`，模型需对同一资源继续传入 `offset` 读完；无需把大段原文塞入默认上下文。

## 基础设计能力

系统指令包含面向视觉任务的简短设计准则：从用途与内容建立方向，把抽象审美要求转成可执行决定，保留品牌与用户约束，并按实际作品修订。非视觉任务和简单局部修改不强制走设计流程。

`image-design` 覆盖品牌、海报、包装、产品图、角色场景、信息图和界面视觉；详细方法放在 `references/visual-foundations.md`、`references/deliverable-playbook.md` 和 `references/critique-and-refinement.md`，按问题读取。视频美术和作品检查可复用这些资料。此增强不新增网页浏览、代码执行、矢量导出或印前制作能力，也不改变费用确认。调研来源、取舍与真实模型评估题见 [设计能力调研](../docs/agent-design-capability.md)。

## 内置技能的交付方法

当前展示十个创作入口，顺序为：提示词优化、图像创作、视频创作、短剧创作、剧本创作、视频复刻、作品检查、Seedance 创作圣经、MiniMax 创作圣经、角色设计。现有 `image-design`、`video-production` 等 ID 保持，已选技能的会话可继续使用。技能名与简介用于按需发现，用户选择某技能不强制改变当前请求范围。

新增 `prompt-optimization` 负责保留意图的描述优化与合规澄清，`script-writing` 负责通用剧本、场景和对白，`character-design` 负责人物设定、外貌与多视图。短剧仍处理分集、改编与观看节奏；图像创作负责画面与出图。导演、运镜、表演、光线、美术、声音和连续制作技巧统一由 `video-production` 提供，Seedance 专题只保留版本适配、素材绑定与模式排查。

新技能各有本地 1536×864 JPEG 封面和 640×360 缩略图。内置图片工具的封面描述、风格参考与输出路径记录在 [封面记录](cover-prompts-v1.json)。上游方法的固定版本与 MIT 许可记录在 [制作方法来源](video-production/references/seedance-source.md)。技能资料热读取；技能入口和封面展示的前端缓存链路为 `app.js?v=471`、`workspace.js?v=82`、`skill-gallery.js?v=6`。

2026-09-28 补充了各阶段的交付要求、实例、失败归因与完成条件。正文负责入口判断，专题按任务读取，不通过增加默认上下文来加载全部资料。

| 技能 | 本次新增的按需资料 |
| --- | --- |
| 图像设计 | [方案到画面](image-design/references/design-to-prompt.md)：参考职责、可复制描述、保留产品的局部改图 |
| 短剧创作 | [故事开发](short-drama/references/story-development.md)、[场景与对白](short-drama/references/scene-writing.md)、[分镜交接](short-drama/references/storyboard-handoff.md) |
| 视频制作 | [制作计划](video-production/references/production-planning.md)、[剪辑与交付](video-production/references/editing-delivery.md)：素材依赖、真实入出点和成片时间 |
| 视频复刻 | [交付与变更](video-replication/references/adaptation-delivery.md)：原片证据到目标作品的对应；保留已有 Hypit 原文 |
| 作品检查 | [证据与结论](creative-review/references/evidence-and-verdict.md)、[局部修订](creative-review/references/repair-playbook.md) |
| Seedance 2.0/2.5 创作圣经 | [技能入口](seedance-creation-bible/SKILL.md)：版本差异、素材绑定、分镜与时间轴、参考/编辑/延长模板、声画问题排查 |
| MiniMax H3 创作圣经 | [技能入口](minimax-creation-bible/SKILL.md)：五种模式、三/六字段声画语法、素材职责、原创模板、八类视频制作与问题排查；[固定上游版本与当前线路](minimax-creation-bible/references/platform-and-sources.md) |

2026-10-01 新增 MiniMax 创作圣经，接入中文目录和 H3/海螺视频搜索；补齐列表简介、详情、使用示例与图片工具生成的封面、缩略图，生成描述记录在封面记录中。官方 Hub 制作技能的方法独立改写，执行沿用 GuGu 现有工具；模板尚未用真实 H3 生成验证。

来源复核与后续行为评估题见 [创作技能调研](creative-agent-assessment.md#2026-09-28-五个技能的深化)。本次只改技能与维护文档，技能仍热读取；无需修改前端缓存键或重新打桌面安装包。方法与例子不是新工具能力，实际制作仍取决于会话提供的工具、当前模型与授权。

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
