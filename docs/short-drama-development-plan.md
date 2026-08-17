# AI 短剧工作台开发方案

版本：v1.0  
日期：2026-08-14  
适用项目：片场 · Model Studio

## 1. 结论

外部方案的产品方向总体合理，但不适合原样实施。

应保留的核心设计：

- 短剧采用项目制工作台，而不是单 Prompt 一键生成。
- 用结构化 `ShotSpec` 连接导演决策与不同媒体模型。
- 角色、场景、服装、道具采用可复用的资产实体和版本。
- 视频前先确认低成本关键帧。
- 每个镜头保留多个 Take，支持单镜头返修。
- 昂贵步骤前设置人工确认点。
- 记录模型、Skill、Prompt、参数和结果，形成可评测的数据闭环。

需要调整的部分：

- 不进行 Next.js + FastAPI + LangGraph + Celery 的一次性重写。
- MVP 不做 10 个 Skill、长篇小说 RAG、完整时间线、声音克隆、口型、多 Agent 和自动视频质检。
- MVP 不接入新的图片或视频模型，保持现有媒体模型不变。
- 连续性不能简单地把上一镜结尾无条件复制为下一镜开头，需要支持转场、时间跳跃和场景切换。
- 首版用显式状态机即可；LangGraph 只在工作流分支和恢复复杂到值得引入时再评估。

最终产品定位：

> 面向创作者的 AI 短剧制作工作台：AI 提供结构化导演建议，用户在关键节点确认，媒体模型负责执行，系统管理一致性、版本、成本与返修。

## 2. 当前基础与约束

当前系统已经具备：

- Node.js 20 原生 HTTP 服务和静态前端。
- 账号、Cookie 会话、邀请码、积分和退款流水。
- 用户级数据隔离。
- 阿里云 OSS 上传、签名 URL 和成品归档。
- 图片、视频任务创建、轮询、失败退款和结果入库。
- `gpt-image-2` 图片生成。
- `grok-video-1.5` 视频生成。

当前系统不具备：

- 通用 LLM 调用层和结构化输出校验。
- 短剧项目、集、场、镜头、资产和 Take 数据模型。
- 可恢复的持久任务队列；目前任务运行在单进程内存中。
- 模型能力注册表和供应商适配层。
- Skill 版本、Schema、Validator 和评测体系。
- 分镜工作台、确认节点、连续性状态和成片装配。

因此方案必须优先解决持久化和任务可靠性，不能直接在现有 `activeGenerations` 上堆长流程。

## 3. MVP 边界

### 3.1 MVP 要完成的闭环

```text
创建短剧项目
  → 粘贴或上传单集剧本
  → AI 解析场次并抽取资产
  → 用户确认资产
  → AI 生成分镜和 ShotSpec
  → 用户确认分镜
  → 批量生成关键帧
  → 用户选择关键帧
  → 按镜头生成视频 Take
  → 用户选择 Take、排序
  → 服务端拼接并导出 MP4
```

### 3.2 MVP 包含

- 单项目、多集的数据结构，但 UI 首先优化单集制作。
- 剧本输入、场次解析和基础剧本编辑。
- 角色、场景、服装、道具的抽取、编辑和参考图。
- 分镜卡片和 ShotSpec 编辑。
- 关键帧生成、选择和锁定。
- 图生视频、多个 Take、接受、废弃和重试。
- 场内连续性检查和人工修正。
- 镜头顺序、裁剪入出点、简单拼接和 MP4 导出。
- 项目级成本、任务状态和失败退款。

### 3.3 MVP 不包含

- 百万字小说自动改编。
- 从创意自动生成整季剧本。
- 多轨专业时间线和复杂转场。
- TTS、声音克隆、Lip Sync。
- AI 视频内容质检。
- 剪映工程导出。
- 多人实时协作。
- 多 Agent 自主运行。

这些能力不会被架构封死，但不进入首版验收范围。

## 4. 技术路线

### 4.1 首版不重写现有产品

建议采用渐进式演进：

```text
现有商品图/商品视频
  └─ 保持现有页面和接口

新增短剧工作台
  ├─ React + Vite 独立 SPA，挂载在 /drama
  ├─ 继续使用 Node.js API
  ├─ PostgreSQL 保存短剧结构化数据
  ├─ Redis + BullMQ 执行持久媒体任务
  └─ 独立 worker 轮询模型和执行 FFmpeg
```

选择 React + Vite 而不是 Next.js，是因为短剧工作台是登录后的重交互应用，不需要 SEO 和服务端渲染。继续使用 Node.js 可以复用当前鉴权、积分、OSS 和媒体调用逻辑，避免同时维护 Python 与 Node 两套服务。

### 4.2 推荐组件

| 层 | MVP 选择 | 说明 |
|---|---|---|
| 工作台前端 | React + TypeScript + Vite | 仅新增短剧入口，现有页面不强制迁移 |
| API | 现有 Node.js 逐步模块化 | 暂不切 FastAPI |
| Schema 校验 | Zod + JSON Schema | ShotSpec、Skill 输入输出统一校验 |
| 数据库 | PostgreSQL | 项目、镜头、资产、版本、任务 |
| 队列 | Redis + BullMQ | 与 Node 技术栈一致，任务可重试、可恢复 |
| 对象存储 | 现有阿里云 OSS | 复用素材隔离和签名 URL |
| 媒体处理 | FFmpeg worker | 探测、转码、裁剪、拼接、导出 |
| 工作流 | 数据库显式状态机 | MVP 暂不引入 LangGraph |
| 可观测性 | 结构化日志 + job events | 记录 provider task、耗时、费用和错误 |

### 4.3 何时引入 LangGraph

只有同时出现以下需求时再引入 LangGraph JavaScript：

- 一个流程存在大量动态分支或循环返修。
- 需要从任意 AI 节点 checkpoint 恢复。
- 人工审批节点无法再被普通数据库状态机清晰表达。
- 团队已经有稳定的 Prompt/Schema 测试，能承担新的运行时复杂度。

即使引入 LangGraph，媒体生成仍由 BullMQ worker 执行。

## 5. 模型方案

### 5.1 MVP 模型组合

| 职责 | 模型 | 决策 |
|---|---|---|
| 导演 LLM | `deepseek-v4-flash` | 复用环境变量中的现有配置；负责剧本解析、资产抽取、场次导演和 ShotSpec |
| 图片 | `gpt-image-2` | 复用；负责角色定妆、场景概念图和分镜关键帧 |
| 视频 | `grok-video-1.5` | 复用；首版固定走关键帧图生视频，优先使用已实测稳定的 6 秒规格 |
| 成片处理 | FFmpeg | 拼接、统一编码、音频和分辨率 |

MVP 生产环境只启用 `deepseek-v4-flash`。业务代码不写死供应商域名或密钥，通过兼容层读取环境变量。每次 Skill 运行在服务端保存实际供应商、模型名和供应商返回的模型版本，但不向普通用户展示或提供模型切换入口。

建议的初期配置：

```dotenv
DIRECTOR_AGENT_BASE_URL=
DIRECTOR_AGENT_API_KEY=
DIRECTOR_AGENT_MODEL=deepseek-v4-flash
LLM_API_PROTOCOL=openai-compatible
LLM_INPUT_PRICE_YUAN_PER_MILLION=3
LLM_OUTPUT_PRICE_YUAN_PER_MILLION=6
YUAN_PER_CREDIT=0.1
```

`LLM_API_PROTOCOL` 支持 `anthropic` 或 `openai-compatible`，适配层将不同协议的 usage 字段统一为 `input_tokens` 和 `output_tokens`。密钥仅在服务端和 worker 中使用，不能通过 `/api/config` 或前端构建变量暴露。

### 5.2 视频模型策略

视频模型保持现有 `grok-video-1.5`，不在本次短剧功能中增加或切换供应商。首版统一走关键帧图生视频，并优先使用已经完成实测的 6 秒规格。

### 5.3 Capability Registry

模型能力不能只存布尔值，还需要约束和版本：

```json
{
  "model_id": "grok-video-1.5",
  "provider": "duomi",
  "version": "2026-08-tested",
  "modes": ["image_to_video"],
  "durations": [6],
  "aspect_ratios": ["9:16", "16:9"],
  "max_reference_images": 7,
  "native_audio": true,
  "first_frame": true,
  "last_frame": false,
  "cancel": false,
  "tested_at": "2026-08-12",
  "enabled": true
}
```

产品路由只使用 `enabled=true` 且满足镜头约束的模型。

## 6. 核心领域模型

建议的主要表：

```text
drama_projects
episodes
scenes
shots
shot_spec_revisions

asset_entities
asset_versions
asset_bindings

continuity_states
continuity_transitions

takes
timeline_items
exports

jobs
llm_usage_records
billing_holds
workflow_approvals
skill_versions
model_capabilities
eval_runs
```

关键关系：

```text
Project
  └─ Episode
      └─ Scene
          └─ Shot
              ├─ ShotSpecRevision
              ├─ ContinuityState(start/end)
              └─ Take(0..n)

Project
  └─ AssetEntity(character/location/prop/costume)
      └─ AssetVersion(0..n)
```

所有用户可编辑对象需要：

- `owner_id`：继续保持用户隔离。
- `version`：支持乐观锁，避免旧页面覆盖新修改。
- `created_at`、`updated_at`。
- `created_by`：user、skill 或 system。
- 软删除或归档状态。

## 7. ShotSpec v1

ShotSpec 是制作计划，不保存供应商最终 Prompt。建议首版结构：

```json
{
  "schema_version": "1.0",
  "shot_id": "uuid",
  "narrative": {
    "function": "建立女主主动离开的决心",
    "information_gain": "辞职信首次出现",
    "dramatic_beat": "权力关系开始反转"
  },
  "timing": {
    "target_duration_sec": 6,
    "pace": "restrained"
  },
  "scene_id": "uuid",
  "character_bindings": [
    { "entity_id": "uuid", "costume_version_id": "uuid" }
  ],
  "prop_bindings": ["uuid"],
  "action_beats": [
    { "at_sec": 0.0, "action": "女主右手压住辞职信" },
    { "at_sec": 2.0, "action": "女主松手" },
    { "at_sec": 3.5, "action": "男主抬眼" }
  ],
  "dialogue": [
    { "speaker_id": "uuid", "text": "顾总，这是我的辞职信。" }
  ],
  "performance": {
    "emotion_start": "克制",
    "emotion_end": "坚定"
  },
  "camera": {
    "shot_size": "medium_close_up",
    "angle": "eye_level",
    "movement": "slow_push_in",
    "axis_rule": "preserve"
  },
  "continuity": {
    "start_state_id": "uuid",
    "expected_end_state": {}
  },
  "negative_constraints": [
    "不新增人物",
    "辞职信不能消失"
  ]
}
```

视频适配器根据 ShotSpec、资产引用和模型能力编译出：

- `compiled_prompt`。
- 模型参数。
- 引用图片列表及其角色。
- 无法满足的能力警告。
- 编译器版本。

已提交的 Take 必须保存完整编译快照，避免 Skill 升级后无法复现。

## 8. 连续性设计

连续性是场景内的结构化状态，不是长文本记忆。

首版跟踪：

- 人物：站位、朝向、姿势、情绪、服装、手持物。
- 道具：所有者、位置、状态。
- 场景：时段、光线、天气、关键布局。
- 镜头：轴线、视线方向、开始和结束状态。

`Shot N.end` 只在以下条件成立时建议合并到 `Shot N+1.start`：

- 同一场次或显式连续转场。
- 没有时间跳跃。
- 没有位置重置指令。

系统生成 continuity diff，用户或连贯性 Skill 确认后落库。不能无条件覆盖下一镜已经编辑过的开始状态。

## 9. Skill 设计

MVP 只做 5 个 Skill：

1. `script-structure`：剧本转集、场、戏剧节拍。
2. `asset-extraction`：抽取角色、场景、服装、道具并去重。
3. `shot-director`：场次和节拍转 ShotSpec。
4. `continuity-check`：检查相邻镜头的结构化状态冲突。
5. `video-prompt-compiler`：ShotSpec 转具体模型请求。

每个 Skill 包含：

```text
skills/<name>/
  skill.yaml
  system.md
  input.schema.json
  output.schema.json
  examples/
  fixtures/
```

Validator 优先使用 TypeScript + Zod/JSON Schema，不在 MVP 为每个 Skill 单独引入 Python。Skill 运行记录必须保存：

- Skill 名称和版本。
- 模型及模型快照。
- 输入对象版本。
- 原始输出、校验错误和修复次数。
- Token、时延和估算成本。
- 用户接受、编辑或拒绝结果。

AI 对已确认内容的修改必须先生成结构化 diff，用户确认后应用。

## 10. 工作流与状态机

项目级状态：

```text
draft
  → assets_review
  → storyboard_review
  → keyframes_review
  → production
  → assembly
  → exported
```

状态只表示推荐的主流程，不阻止用户回到旧阶段编辑。旧阶段修改后，系统标记下游对象为 `stale`，由用户选择保留或重新生成。

镜头级状态：

```text
draft
  → spec_approved
  → keyframe_generating
  → keyframe_approved
  → video_generating
  → take_approved
```

每个阶段都允许 `failed`、`cancelled` 和 `needs_revision`。

四个确认点：

- 资产确认。
- 分镜确认。
- 关键帧确认。
- Take 确认。

剧本解析属于低成本步骤，可自动执行；图片和视频不得跨过确认点自动扣费批量生成。

## 11. 任务与计费

媒体任务迁移到 BullMQ worker 后需要满足：

- API 创建 job 后立即返回，不在 Web 进程轮询。
- job 使用幂等键，重复提交不会重复扣费。
- 保存 `provider_task_id`，进程重启后继续轮询。
- 对创建失败、供应商失败、归档失败分别处理。
- 图片和视频必须先完成扣费，worker 才能调用供应商。
- 只有未交付结果的媒体任务才退款；归档失败优先恢复下载。
- 支持有限次数指数退避，不对安全拒绝自动重试。
- 项目、镜头、Take、模型和积分流水可互相追踪。

### 11.1 统一最小计费单位

现有整数积分无法精确表达单 Token 价格。数据库统一改用整数 `credit_micro`：

```text
1 积分 = ¥0.1
1 积分 = 1,000,000 credit_micro
1 元 = 10,000,000 credit_micro
```

旧用户迁移时：

```text
new_balance_micro = old_integer_credits × 1,000,000
```

所有计算和账本只使用整数，禁止使用浮点数处理余额。前端展示时再除以 `1,000,000`，最多显示 4 位小数。

### 11.2 LLM 动态计费

给定价格：

```text
输入：¥3 / 1,000,000 Token = 30 积分 / 1,000,000 Token
输出：¥6 / 1,000,000 Token = 60 积分 / 1,000,000 Token
```

换算成最小单位后可精确整数计算：

```text
input_cost_micro  = input_tokens  × 30
output_cost_micro = output_tokens × 60
actual_cost_micro = input_cost_micro + output_cost_micro
```

例如输入 10,000 Token、输出 3,000 Token：

```text
输入成本：0.30 积分
输出成本：0.18 积分
合计：0.48 积分 = ¥0.048
```

LLM 调用采用“调用前预授权、完成后按实际 Token 结算”：

1. Skill 为每次调用设置明确的 `max_output_tokens`。
2. 优先使用供应商 tokenizer 计算输入 Token 上限；没有 tokenizer 时使用 UTF-8 字节数作为保守上限。
3. 原子冻结：`input_token_upper_bound × 30 + max_output_tokens × 60` 个 `credit_micro`。
4. 可用余额不足时不调用 LLM，直接返回余额不足。
5. 成功响应后读取供应商 `usage.input_tokens` 和 `usage.output_tokens`。
6. 按实际 Token 原子结算，并立即释放多余冻结额度。
7. Skill 输出若因平台错误或 Schema 校验最终失败，则释放冻结额度，不向用户收费；平台记录上游实际消耗用于成本分析。
8. 用户在请求已发出后取消时，如果供应商返回实际 usage，则按实际 usage 结算。

若成功响应没有 usage：

- 不允许把该结果标记为正常结算完成。
- 保持冻结并将记录置为 `billing_reconcile_required`。
- 后台查询供应商记录或由管理员核对后结算。
- 禁止静默按 0 Token 放行，避免形成免费调用漏洞。

每次调用保存不可变的 `llm_usage_record`：

```json
{
  "request_id": "uuid",
  "user_id": "uuid",
  "project_id": "uuid",
  "skill_name": "shot-director",
  "skill_version": "1.0.0",
  "provider": "env-configured",
  "model": "deepseek-v4-flash",
  "input_tokens": 10000,
  "output_tokens": 3000,
  "input_rate_yuan_per_million": 3,
  "output_rate_yuan_per_million": 6,
  "charged_micro": 480000,
  "status": "settled"
}
```

价格必须快照到 usage 记录中；后续调整环境变量价格不能改变历史账单。

### 11.3 图片和视频预扣费

- 图片按次定价，提交任务前全额扣除。
- 视频沿用现有定价规则，提交任务前按选择的时长全额扣除。
- 批量生成时先展示总预计积分，用户确认后对整批任务原子预扣；扣费失败时不创建任何供应商任务。
- worker 只消费 `credit_status=charged` 的任务。
- 供应商创建失败、生成失败或最终未交付成品时原路全额退款。
- 相同幂等键不能重复扣费、重复退款或重复创建供应商任务。
- 归档失败但供应商已经生成成功时不立即退款，优先恢复下载和 OSS 归档。

### 11.4 账本要求

- `charge`、`hold`、`capture`、`release`、`refund` 都必须产生独立账本事件。
- 余额、冻结额和可用余额在同一数据库事务中更新。
- 每个事件带唯一幂等键并引用用户、项目、Skill 或媒体 job。
- API 返回余额时同时返回 `balance`、`held` 和 `available`。
- 用户账单展示 LLM 输入/输出 Token、费率、积分和人民币金额。
- 管理端统计供应商实际成本、用户扣费、失败平台成本和毛利。

## 12. 前端信息架构

左侧新增一级入口“短剧”，进入项目列表，不复用商品视频单页生成器。

项目内导航：

```text
概览
剧本
资产
分镜
镜头
成片
```

核心分镜页面：

- 左侧：场次和筛选。
- 中间：分镜卡片列表，展示关键帧、对白、时长和状态。
- 右侧：ShotSpec 属性、连续性警告和 AI 导演建议。
- 底部：首版只做镜头顺序条，不做专业多轨编辑器。

每条 AI 建议展示变更前后和影响范围；涉及已生成媒体时提示下游对象可能过期。

## 13. 分阶段交付

以下为开发工作量估算，不是固定自然周承诺。假设 2 名前端、2 名后端/AI、1 名产品设计兼职并行；单人开发约为团队周期的 2–2.5 倍。

### 阶段 0：技术底座，2 周

- PostgreSQL 迁移框架和用户关联。
- 整数微积分账本、旧余额迁移、冻结与实际结算。
- Redis + BullMQ worker。
- 将现有媒体生成改为可恢复 job。
- 模型能力注册表和 provider adapter 接口。
- FFmpeg 环境和媒体探测。

验收：服务重启后生成任务可继续；重复请求不重复扣费；现有商品图/视频回归测试通过。

### 阶段 1：项目、剧本和资产，2 周

- 短剧项目、集、场数据模型与 API。
- React 工作台壳和项目导航。
- 复用环境变量中的 `deepseek-v4-flash`，记录 usage 并动态结算。
- 剧本输入、`script-structure`、`asset-extraction`。
- 资产编辑、去重、参考图绑定和确认。

验收：一份单集剧本可稳定生成可编辑场次和资产，Schema 校验通过率达到 95% 以上。

### 阶段 2：分镜与连续性，2–3 周

- ShotSpec v1、版本和 diff。
- `shot-director` 和 `continuity-check`。
- 分镜卡片、批量编辑和人工确认。
- 下游 stale 标记。

验收：20–40 镜头的单集可以完成分镜确认；相邻镜头的服装、道具和站位冲突能够被结构化定位。

### 阶段 3：关键帧、视频 Take 和导出，3 周

- `gpt-image-2` 关键帧生成和锁定。
- `video-prompt-compiler`。
- `grok-video-1.5` 图生视频 Take。
- 批量任务、进度、重试、接受和废弃。
- 顺序条、裁剪入出点和 FFmpeg MP4 导出。

验收：可从一集剧本完成不少于 10 个镜头的端到端生成并导出；任一失败镜头可以独立重做，不影响已接受 Take。

### 阶段 4：小范围内测与加固，2 周

- 5–10 个真实项目内测。
- Skill fixtures 和回归评测。
- 供应商错误归类、成本看板和性能优化。
- 优化现有图片、视频模型的提示词编译和任务成功率。

团队版 MVP 合计约 11–12 周。

## 14. 核心验收指标

产品指标：

- 端到端完成率：创建项目到导出成片。
- 首个可接受镜头所需时间。
- 每个已接受镜头的平均生成次数和积分成本。
- 关键帧确认后的视频首轮接受率。
- 用户对 AI 分镜的直接接受、编辑和拒绝比例。

质量指标：

- ShotSpec Schema 首次通过率。
- 资产重复实体率。
- 连续性冲突召回率和误报率。
- 人物身份、服装和关键道具的人工一致性评分。
- 模型任务成功率、P50/P95 时延和安全拒绝率。

工程指标：

- worker 重启恢复率。
- 重复扣费事件数必须为 0。
- 结果完成但归档失败的自动恢复率。
- 导出成功率。
- 所有 Take 的模型、Prompt、参数和引用可追溯率必须为 100%。

## 15. P1/P2 路线

P1：

- 基础 TTS、字幕、BGM 和音量标准化。
- 视频多模态质检与返修建议。
- 首尾帧和更强参考一致性。
- 剪映草稿实验导出。

P2：

- 长篇小说索引与分集改编。
- 多人协作和审批权限。
- 声音克隆授权流程、Lip Sync。
- 更完整的多轨时间线。
- 在复杂度确有收益时引入 LangGraph。

## 16. 立即执行顺序

1. 固化 ShotSpec v1 和五个 Skill 的输入输出 Schema。
2. 用现有《风暴之门》链路制作一套 10 镜头黄金样本和验收标注。
3. 将现有媒体任务从进程内 Map 迁移到 BullMQ。
4. 新增 PostgreSQL 领域表和 owner 隔离测试。
5. 使用环境变量中的 `deepseek-v4-flash`，完成 Token usage、预授权、动态结算和离线 Skill 评测。
6. 开发 React 项目壳、资产页和分镜页。
7. 接通关键帧、Take 与 MP4 导出闭环。

首个里程碑不是“支持所有短剧能力”，而是：

> 同一用户可以把一份单集剧本稳定制作成 10 个可独立返修的镜头，并导出一条可播放 MP4；全过程可恢复、可追溯、不重复扣费。
