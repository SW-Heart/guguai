# GuGu AI

完整的图片与视频生成平台，包含账号体系、用户数据隔离、生成任务和个人文件库。

## 功能

- 账号密码注册和登录；注册必须使用后端预置的一次性邀请码。
- HttpOnly Cookie 会话与登录尝试限流。
- 图片生成和视频生成。
- 项目制短剧工作台：剧本设计、资源生成、分镜设计、视频生成四步生产线。
- 智能导演可从一句话或已有剧本一次生成可编辑剧本、角色/场景/物品定义与分镜；专业编辑支持完全手动创作。
- 资源采用视觉圣经与版本生命周期：角色身份/外观/服装/标准视图、场景空间锚点、物品材质状态均可编辑和升版。
- 分镜采用叙事任务、镜头执行、连续性锁定三段式制作单，上游资源变更会把相关镜头标记为待复核。
- 视频支持文本生成、首尾帧和参考元素三种策略；分镜视频可提取尾帧并自动设为下一镜首帧，所有镜头确认后可一键拼接成片。
- 平台积分：1 积分等于 ¥0.1；图片每次 1 积分，视频每秒 1 积分；新注册用户赠送 50 积分。
- 服务端原子扣费、余额校验和失败任务自动退款，并保存积分流水。
- 从个人文件库选择参考图片。
- 上传、搜索、筛选、预览、下载、重命名和删除文件。
- 生成结果自动下载到个人文件库。
- 上传素材和生成结果归档到阿里云 OSS；模型参考图使用短期签名 URL。
- 不同账号的任务和文件在服务端隔离。

商品图与商品视频入口不会改写用户提示词；短剧工作台会根据剧本生成结构化分析和制作提示词。

## 配置

Node.js 22.5 或更高版本（元数据存储使用内置 `node:sqlite`）：

```dotenv
DUOMI_API_KEY=
DUOMI_API_BASE=https://duomiapi.com
DUOMI_VEO_MODEL=veo-fast
TTAPI_API_KEY=
TTAPI_API_BASE=https://api.ttapi.io
TTAPI_GROK_VIDEO_MODEL=grok-imagine-video
TTAPI_GROK_VIDEO_FAST_MODEL=grok-imagine-video-1.5-fast
PORT=4317
DIRECTOR_AGENT_BASE_URL=
DIRECTOR_AGENT_API_KEY=
DIRECTOR_AGENT_MODEL=deepseek-v4-flash
LLM_API_PROTOCOL=openai-compatible
LLM_INPUT_PRICE_YUAN_PER_MILLION=3
LLM_OUTPUT_PRICE_YUAN_PER_MILLION=6
YUAN_PER_CREDIT=0.1
ALIYUN_ACCESS_KEY_ID=
ALIYUN_ACCESS_KEY_SECRET=
ALIYUN_OSS_ENDPOINT=
ALIYUN_OSS_BUCKET=
ALIYUN_OSS_PREFIX=model-studio
```

系统优先读取现有 `DIRECTOR_AGENT_*` 配置，同时兼容 `LLM_API_BASE / LLM_API_KEY / LLM_MODEL`。`LLM_API_PROTOCOL` 支持 `anthropic` 和 `openai-compatible`，默认使用 OpenAI-compatible。LLM 调用前冻结最大可能积分，成功后根据供应商返回的输入/输出 Token 实际结算；图片和视频仍在提交任务前全额扣费。模型名称只保存在服务端账单和审计记录中，不向普通用户展示。

视频由服务端按参数自动路由：4、6、10、15 秒的文本/参考图请求使用 TTAPI `grok-imagine-video`；20、30 秒使用 TTAPI `grok-imagine-video-1.5-fast`；8 秒文本/参考图和 8 秒首尾帧请求使用 Duomi `veo-fast`。标准视频支持 `4 / 6 / 10 / 15 / 20 / 30` 秒、`2:3 / 3:2 / 1:1 / 9:16 / 16:9` 画幅和 720p；最多 7 张参考图，但 `grok-imagine-video` 的 15 秒参考图请求仅允许 1 张，多张参考图最长 10 秒。首尾帧支持 1～2 张图、`9:16 / 16:9` 与 `720p / 1080p / 4k`。

TTAPI 视频任务在提交后使用 `jobId` 轮询 `/grok/fetch`；Duomi Veo 任务继续使用 Duomi 的视频任务接口。两类任务都会保存供应商、模型和任务 ID；对应供应商未配置或任务失败时，原任务按既有规则退款，不跨模型切换。

启动：

```bash
npm start
```

检查与测试：

```bash
npm run check
npm test
```

创建管理员（默认初始 10,000 测试积分，账号不会覆盖）：

```bash
ADMIN_USERNAME=admin ADMIN_PASSWORD='使用安全密码' npm run create-admin
```

## 数据库与运维

元数据保存在 SQLite（`data/studio.db`，WAL 模式），素材二进制归档到阿里云 OSS 并在本地保留缓存。

从旧版 JSON 文件存储升级时，先迁移再启动：

```bash
npm run migrate -- --dry-run   # 只出报告，不写库
npm run migrate                # 单事务导入，失败整体回滚
npm run migrate -- --verify    # 导入后逐字段比对库与 JSON
```

迁移不会修改或删除任何 `data/*.json` 与本地媒体文件，回退时原样可用。若检测到 `data/users.json` 里有用户但数据库缺少迁移完成标记，服务会拒绝启动，避免对着空库提供服务。

```bash
npm run db:check    # 余额与流水对账、冻结额度对账、外键与完整性检查
npm run db:backup   # VACUUM INTO 热备份，服务运行时可执行，保留最近 7 份
```

备份必须用 `npm run db:backup`。WAL 模式下最新已提交的数据可能仍在 `studio.db-wal` 里，直接拷贝 `studio.db` 会丢数据。

从备份恢复：停止服务，把 `studio.db.bak-<时间戳>` 重命名为 `studio.db`，删除同目录的 `studio.db-wal` 与 `studio.db-shm`。

## 数据和安全

- 积分余额与流水在同一个数据库事务内写入，`余额 == SUM(流水)` 与 `冻结 == SUM(held 冻结记录)` 两个不变式由 `npm run db:check` 核验。
- 记账幂等键落在 `credit_entries(user_id, idempotency_key)` 唯一约束上，重放不会重复扣费或重复退款。
- 写操作按用户加锁，不同账号互不阻塞。
- 短剧项目分镜仅能绑定当前用户自己的生成任务；所有记录查询都以 `user_id` 为必备条件，越权访问与记录不存在返回同样的 404。
- 邀请码核销与账号创建在同一事务内完成，并发使用同一邀请码只有一个请求成功。
- 密码使用带随机盐的 `scrypt` 哈希保存，不保存明文密码。
- 会话令牌通过 HttpOnly、SameSite=Lax Cookie 传递，服务端只保存令牌哈希。
- 文件上传上限为 25 MB，只接受配置的图片和视频 MIME 类型。
- 生产环境设置 `NODE_ENV=production` 后，会话 Cookie 会启用 `Secure`。
- 过期会话在启动时清理一次，之后每 6 小时清理一次。
- 当前实现适合单机单进程部署。列表接口支持 `limit`（1–200，默认 100）与 `cursor` 分页，分页信息通过 `X-Total-Count` 与 `X-Next-Cursor` 响应头返回，响应体形状保持不变。
