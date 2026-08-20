# GuGu AI 创作工作台

GuGu AI 是一个单机运行的 AI 图片、视频与短剧创作工作台。它提供账号和积分体系、个人文件库、图片/视频生成，以及从剧本到完整成片的短剧工作流。

> 服务仅监听本机 `127.0.0.1`，生产环境必须使用单进程、持久化数据目录，并通过反向代理提供 HTTPS；完整步骤见“生产部署与域名”章节。

## 功能概览

- **个人创作空间**：账号注册/登录、邀请码注册、积分流水、用户数据隔离。
- **管理后台**：仅管理员可登录 `/guguadmin`，管理用户、模型、全局价格、邀请码、积分和运行日志。
- **文件库**：上传、搜索、筛选、预览、下载、重命名与删除图片、视频素材。
- **图片生成**：支持提示词、比例、质量和最多 7 张参考图；成品自动进入文件库。
- **视频生成**：支持文生视频、参考图视频、首尾帧视频；按时长和模式自动选择视频服务。
- **短剧创作**：提供「智能导演」和「专业编辑」两种工作模式，支持资源定稿、分镜、镜头视频、尾帧衔接与一键成片。

## 运行前准备

### 1. 安装依赖

需要以下软件：

- **Node.js 22.5.0 或更高版本**：项目使用内置 `node:sqlite`。
- **ffmpeg**：用于提取镜头尾帧和合成最终 MP4。
- 可用的 Duomi、TTAPI、LLM 与阿里云 OSS 服务凭据，按实际启用的功能配置。

确认工具可用：

```bash
node --version
ffmpeg -version
```

安装项目依赖：

```bash
# 开发环境
npm install

# 生产环境使用锁文件进行可重复安装
npm ci --omit=dev
```

### 2. 创建环境变量文件

复制模板并编辑根目录的 `.env`：

```bash
cp .env.example .env
```

`.env` 中的密钥不要提交到 Git。各项配置说明如下。

| 分类 | 配置项 | 何时需要 |
| --- | --- | --- |
| 服务 | `PORT` | 可选，默认 `4317` |
| 运行模式 | `NODE_ENV` | 生产环境必须设为 `production`，用于启用 Secure Cookie |
| 数据目录 | `DATA_DIR` | 生产环境必须指向项目目录外的持久化绝对路径 |
| 可信代理 | `TRUST_PROXY` | 本机 Nginx 反代时设为 `loopback`；直连服务时不要设置 |
| 图片与 8 秒视频 | `DUOMI_API_KEY`、`DUOMI_API_BASE`、`DUOMI_VEO_MODEL` | 使用图片生成，或使用 8 秒文本/参考图/首尾帧视频 |
| 常规视频 | `TTAPI_API_KEY`、`TTAPI_API_BASE`、`TTAPI_GROK_VIDEO_FAST_MODEL` | 使用 Grok Video 1.5 Fast 的 20、30 秒文本或参考图视频 |
| Omni Flash 视频 | `OAI_API_BASE`、`OAIAPI_GEMINI_KEY`、`OAI_OMNI_FAST_MODEL` | 使用 `omni-fast` 的 10 秒文本、参考图或首尾帧视频 |
| Grok Video 视频 | `OAI_API_BASE`、`OAIAPI_GROK_KEY`、`OAI_GROK_MODEL` | 使用 OAI 兼容接口的 Grok Video，支持 6/12 秒、480p/720p 和 7 种画幅；仅支持 1 张参考图，按 1 积分/秒计费 |
| Veo 3.1 视频 | `OAI_API_BASE`、`OAIAPI_VEO_KEY`、`OAI_VEO_31_MODEL` | 使用 oairegbox 的 `firefly-veo-3.1`，支持 4/6/8 秒文生视频和单图参考图视频 |
| 智能导演 | `DIRECTOR_AGENT_BASE_URL`、`DIRECTOR_AGENT_API_KEY`、`DIRECTOR_AGENT_MODEL` | 使用智能导演、剧本分析或自动分镜 |
| LLM 计费 | `LLM_API_PROTOCOL`、`LLM_INPUT_PRICE_YUAN_PER_MILLION`、`LLM_OUTPUT_PRICE_YUAN_PER_MILLION`、`YUAN_PER_CREDIT` | 使用智能导演时建议确认 |
| 文件存储 | `ALIYUN_ACCESS_KEY_ID`、`ALIYUN_ACCESS_KEY_SECRET`、`ALIYUN_OSS_ENDPOINT`、`ALIYUN_OSS_BUCKET`、`ALIYUN_OSS_PREFIX` | 上传文件、使用参考图、保存生成结果或成片 |

最小示例（请替换为真实值）：

```dotenv
PORT=4317

DUOMI_API_KEY=your_duomi_key
DUOMI_API_BASE=https://duomiapi.com
DUOMI_VEO_MODEL=veo-fast

TTAPI_API_KEY=your_ttapi_key
TTAPI_API_BASE=https://api.ttapi.io
TTAPI_GROK_VIDEO_FAST_MODEL=grok-imagine-video-1.5-fast

OAI_API_BASE=https://newapi.oairegbox.cc/v1
OAIAPI_GEMINI_KEY=your_oai_gemini_key
OAI_OMNI_FAST_MODEL=omni-fast
OAIAPI_GROK_KEY=your_oai_grok_key
OAI_GROK_MODEL=grok-imagine-video
OAIAPI_VEO_KEY=your_oai_veo_key
OAI_VEO_31_MODEL=firefly-veo-3.1

DIRECTOR_AGENT_BASE_URL=https://your-llm-endpoint
DIRECTOR_AGENT_API_KEY=your_llm_key
DIRECTOR_AGENT_MODEL=deepseek-v4-flash
LLM_API_PROTOCOL=openai-compatible
LLM_INPUT_PRICE_YUAN_PER_MILLION=3
LLM_OUTPUT_PRICE_YUAN_PER_MILLION=6
YUAN_PER_CREDIT=0.1

ALIYUN_ACCESS_KEY_ID=your_access_key_id
ALIYUN_ACCESS_KEY_SECRET=your_access_key_secret
ALIYUN_OSS_ENDPOINT=your_oss_endpoint
ALIYUN_OSS_BUCKET=your_bucket
ALIYUN_OSS_PREFIX=model-studio
```

说明：

- OSS 的前四项必须同时配置；否则无法上传素材，也无法归档模型生成结果。
- 智能导演需要完整的 `DIRECTOR_AGENT_*` 三项。项目也兼容旧命名 `LLM_API_BASE`、`LLM_API_KEY`、`LLM_MODEL`。
- `LLM_API_PROTOCOL` 可设为 `openai-compatible`（默认）或 `anthropic`。
- 开发环境不设置 `DATA_DIR` 时默认使用项目下的 `data/`；生产环境应显式设置项目目录外的持久化绝对路径。
- `TRUST_PROXY=loopback` 只信任来自本机反向代理的 `X-Real-IP`，不要在 Node 端口直接暴露公网时启用。

### 3. 启动服务

```bash
npm start
```

浏览器访问：

```text
http://127.0.0.1:4317
```

首次使用前先执行 `npm run create-admin` 创建管理员，再从 `/guguadmin` 创建随机邀请码。系统不会内置或自动生成公开邀请码。普通账号要求 3–24 位小写字母、数字或下划线，密码为 8–128 位；注册赠送积分由邀请码配置决定。

## 生产部署与域名

推荐使用独立子域名（例如 `ai.example.com`）部署在站点根路径。前端和 API 使用 `/api/...`、`/app.js` 等根路径，不支持直接挂载到 `/gugu/` 之类的子目录。

### 1. DNS 与服务器目录

在域名服务商添加指向服务器公网 IPv4 的 A 记录；只有服务器已经配置 IPv6 时才添加 AAAA 记录。准备专用运行用户和目录：

```bash
sudo useradd --system --home /opt/gugu-ai --shell /usr/sbin/nologin gugu
sudo mkdir -p /opt/gugu-ai /var/lib/gugu-ai
sudo chown -R gugu:gugu /opt/gugu-ai /var/lib/gugu-ai
```

将代码发布到 `/opt/gugu-ai`，然后执行：

```bash
cd /opt/gugu-ai
npm ci --omit=dev
cp .env.production.example .env
chmod 600 .env
```

生产 `.env` 至少确认：

```dotenv
NODE_ENV=production
PORT=4317
DATA_DIR=/var/lib/gugu-ai
TRUST_PROXY=loopback
```

密钥必须使用生产凭据。Node 端口只监听 `127.0.0.1`，防火墙不要向公网开放 `4317`。

如果目标目录已有旧数据库，先停止旧服务并执行备份，再首次启动新代码：

```bash
sudo systemctl stop gugu-ai 2>/dev/null || true
npm run db:backup
```

数据库 schema 需要升级时，`openDatabase` 会在任何迁移写入前额外生成并校验 `studio.db.pre-schema-<旧版本>-to-<新版本>-<时间>` 快照。代码回滚到旧 schema 时必须同时恢复这份升级前快照，不能让旧代码直接打开升级后的数据库。

### 2. systemd 单进程运行

仓库提供 `deploy/gugu-ai.service.example`。确认服务器的 Node 路径（`command -v node`）与模板中的 `/usr/bin/node` 一致，然后安装：

```bash
sudo cp deploy/gugu-ai.service.example /etc/systemd/system/gugu-ai.service
sudo systemctl daemon-reload
sudo systemctl enable --now gugu-ai
sudo systemctl status gugu-ai
curl --fail http://127.0.0.1:4317/readyz
```

当前架构只允许一个服务进程访问同一个 `DATA_DIR`，不要启用 PM2 cluster、systemd 多实例或多副本负载均衡。

### 3. Nginx、HTTPS 与域名

先将下面只监听 80 的临时站点保存为 `/etc/nginx/conf.d/gugu-ai.conf`（替换示例域名），完成域名验证后再申请证书：

```nginx
server {
    listen 80;
    server_name ai.example.com;
    location / {
        proxy_pass http://127.0.0.1:4317;
        proxy_set_header Host $host;
    }
}
```

```bash
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d ai.example.com
```

证书签发后，复制仓库的完整模板并替换其中所有 `YOUR_DOMAIN`：

```bash
sudo cp deploy/nginx.conf.example /etc/nginx/conf.d/gugu-ai.conf
sudo nginx -t
sudo systemctl reload nginx
sudo certbot renew --dry-run
```

完整模板已经包含：

- HTTP 到 HTTPS 跳转、HSTS 和基础安全响应头。
- 30 MB 请求上限，覆盖 8 MB 图片和 25 MB 视频上传。
- 1800 秒上游超时，覆盖智能导演、尾帧和成片合成。
- 原始 `Host` 与真实客户端 IP 传递。
- 普通登录和管理员登录的 Nginx IP 限流，超限统一返回 HTTP 429。
- `/healthz` 存活检查和 `/readyz` SQLite 就绪检查。

只保留一个正式域名；其他域名应 301 跳转到正式 HTTPS 域名，避免 Cookie 和登录状态分散。

### 4. 上线检查

```bash
npm run check
npm test
npm run db:check
curl --fail https://ai.example.com/healthz
curl --fail https://ai.example.com/readyz
curl -I http://ai.example.com/
```

然后手工验证普通登录、管理员登录、Secure Cookie、接近上限的图片/视频上传、一次真实生成、尾帧提取和成片合成。真实模型调用会产生费用，不包含在自动测试内。

## 管理后台（`/guguadmin`）

管理后台集成在当前服务中，不是独立站点。用户端导航不会显示后台入口；知道地址也不能绕过管理员鉴权，后台数据和操作 API 只接受拥有 `admin` 角色且状态为 `active` 的管理员会话。

### 创建管理员

首次部署或初始化数据库后，使用环境变量执行管理员创建：

```bash
ADMIN_USERNAME=admin ADMIN_PASSWORD='请替换为强密码' npm run create-admin
```

如果要将已有普通用户提升为管理员，必须明确设置 `ADMIN_PROMOTE_EXISTING=1`：

```bash
ADMIN_USERNAME=已有用户名 \
ADMIN_PASSWORD='该用户当前密码' \
ADMIN_PROMOTE_EXISTING=1 \
npm run create-admin
```

不要把真实密码写入 README、`.env.example` 或提交到 Git。生产环境建议通过部署平台的密钥变量注入 `ADMIN_PASSWORD`，并使用 HTTPS。

### 登录和功能

启动服务后访问：

```text
http://127.0.0.1:4317/guguadmin
```

后台 V1 提供：

- 数据总览、用户列表和用户详情；支持禁用/启用用户、撤销会话和管理员备注。
- 用户积分增加/减少；调账使用 micro 整数账本、原因、备注和幂等键，并写入审计日志。
- 模型用户端展示/隐藏、启用/停用和排序控制；停用模型会同时受到服务端生成接口限制。
- 全局图片价格（积分/次）和视频价格（积分/秒）；价格按版本保存，生成任务保留价格快照。
- 邀请码创建、启停、最大使用次数、有效期、注册送积分和使用记录。
- 生成、积分、LLM、审计和系统日志；支持按用户、模型和时间范围筛选。
- 冻结积分异常的人工对账查询。

后台写操作使用独立管理员会话、同源校验和 CSRF Token。不要共享普通用户会话 Cookie，也不要将后台地址当作唯一安全措施。

## 日常使用步骤

### 1. 上传与管理素材

1. 登录后进入「文件库」。
2. 上传 PNG、JPEG、WebP、MP4、WebM 或 MOV 文件。
3. 图片最大 8 MB，视频最大 25 MB。
4. 在文件库中搜索、筛选、预览、下载或重命名素材；图片可作为图片生成和视频生成的参考图。

### 2. 生成图片或普通视频

**图片生成**

1. 进入「图像生成」。
2. 输入提示词，选择画面比例和质量；如需保持主体或风格，可选择最多 7 张参考图。
3. 提交后等待任务完成，结果会自动保存到文件库。

**视频生成**

1. 进入「视频生成」。
2. 输入提示词，选择画幅、时长和生成模式。
3. 参考图必须来自当前账号的文件库，且为不超过 8 MB 的图片。
4. 等待完成后，在任务列表或文件库预览、下载成品。

图片和视频价格由管理员后台配置，初始值为图片 1 积分/次、视频 1 积分/秒；任务提交前会按当前价格扣除积分，模型未成功产出时，系统会尝试自动退款。

## 短剧创作流程

进入「短剧创作」后，创建项目并选择一种模式。

### 模式 A：智能导演

适合从一句话创意或已有剧本快速得到可制作的方案。

1. 创建「智能导演」项目。
2. 输入一句话创意或完整剧本，设置分镜数量、总时长、单镜时长和画幅。
3. 点击「生成完整导演方案」。系统会生成或整理剧本、场次、节拍、视觉资源和连续分镜，并进行质量校验。
4. 审阅并编辑故事梗概、剧本、场次、资源和分镜，然后确认进入资源步骤。
5. 为角色、场景、物品生成候选图，并为每项资源选择一个定稿版本。
6. 审查分镜的剧本节拍、起止状态、镜头运动、资源引用和连续性；完成后进入视频生成。
7. 为每个分镜选择视频模式并提交生成，选定最终视频版本。
8. 所有镜头完成后，一键合成完整成片并下载。

> 智能导演依赖 LLM 配置，会按实际 Token 用量结算积分；系统会在调用前冻结上限积分，并在完成后按实际用量结算。

### 模式 B：专业编辑

适合完全手动控制每个镜头。

1. 创建「专业编辑」项目。
2. 填写剧本正文，创建场次和节拍；每行一个节拍，`角色名：台词` 会识别为对白。
3. 进入编辑工作台，逐一新建分镜，填写分镜名称、脚本内容、画幅与时长。
4. 为镜头选择生成模式：
   - **文生视频**：仅用分镜文字生成。
   - **参考图**：添加角色、场景等图片，最多 7 张，可拖动调整顺序。
   - **首尾帧**：设置首帧，尾帧可选；适合控制动作衔接。
5. 提交镜头视频，生成完成后选择要用于成片的版本。
6. 可从已选视频提取尾帧，并将其用作下一镜的首帧。
7. 至少完成 2 个镜头，且每镜都选定一个完成版本后，点击「一键拼接」生成完整成片。

### 视频模式与限制

| 模式 | 图片要求 | 时长 | 画幅 | 清晰度 |
| --- | --- | --- | --- | --- |
| 文生视频 | 不可带参考图 | Grok Video：6、12 秒；Grok Video 1.5 Fast：10、20、30 秒；Veo：8 秒；Omni Flash：10 秒；Veo 3.1：8 秒 | 依模型能力 | 依模型能力 |
| 参考图视频 | 1 张图片（Grok Video；Veo 3.1：1 张） | Grok Video：6、12 秒；Grok Video 1.5 Fast：10、20、30 秒；Veo：8 秒；Omni Flash：10 秒；Veo 3.1：8 秒 | 依模型能力 | 依模型能力 |
| 首尾帧视频 | 1–2 张图片 | Veo：固定 8 秒；Omni Flash：10 秒 | 16:9、9:16 | 依模型能力 |

路由规则：Grok Video 的 6、12 秒文本/参考图视频使用 OAI 兼容接口 `POST /v1/videos` 提交任务和 `GET /v1/videos/{task_id}` 轮询；请求使用 `seconds`、`aspect_ratio`、`resolution`，单张首帧使用 `image`，最多 1 张参考图，不支持多图和 1080p。Grok Video 按 1 积分/秒计费。Grok Video 1.5 Fast 的 10、20、30 秒文本/参考图视频使用 TTAPI；Veo 的 8 秒文本/参考图及首尾帧视频使用 Duomi；Omni Flash 使用 OAI 渠道的同一组异步接口；Veo 3.1 使用 oairegbox 的同一组异步接口。OAI 任务默认每 4 秒轮询，单次请求超时 300 秒。

## 常用命令

```bash
# 启动服务
npm start

# 检查服务端和前端脚本语法
npm run check

# 运行全部测试
npm test

# 运行管理后台核心和 HTTP 测试
npm run test:admin

# 校验 SQLite 完整性、外键、积分余额与冻结记录
npm run db:check

# 创建 SQLite 热备份，并只保留最近 7 份
npm run db:backup
```

## 数据迁移、备份与恢复

### 从旧 JSON 数据迁移

如果 `data/users.json` 中仍有旧数据，且数据库没有迁移完成标记，服务会拒绝启动，避免误用空数据库。请按顺序执行：

```bash
# 只生成迁移报告，不写入数据库
npm run migrate -- --dry-run

# 确认无误后，在单个事务内执行迁移
npm run migrate

# 可选：迁移后逐字段校验 JSON 与 SQLite
npm run migrate -- --verify
```

迁移不会删除旧 JSON 文件或本地媒体文件。每次迁移会生成报告，并在已有数据库时先创建数据库备份。

`npm run create-admin` 用于当前 SQLite 数据库中的管理员初始化或管理员提升，不会创建普通用户。执行前请确认 `.env` 中的 `DATA_DIR` 指向目标数据库；初始化后可访问 `/guguadmin` 验证登录。旧 JSON 数据迁移仍应先执行 `npm run migrate -- --dry-run`，确认报告无误后再执行 `npm run migrate`。

### 备份与恢复

元数据保存在 `${DATA_DIR:-data}/studio.db`，数据库使用 WAL 模式；媒体文件会归档到 OSS，本地副本作为 ffmpeg 工作缓存，缺失时会按需从 OSS 回源。SQLite 热备份不包含 OSS 对象，生产环境还必须为 OSS 配置版本控制、生命周期保护或独立备份策略。

备份请使用：

```bash
npm run db:backup
```

不要只复制 `studio.db`，因为最近提交的数据可能仍在 `studio.db-wal` 中。

恢复步骤：

1. 停止服务。
2. 将 `studio.db.bak-<时间戳>` 重命名为 `studio.db`。
3. 删除同目录的 `studio.db-wal` 和 `studio.db-shm`。
4. 重新启动服务，并执行 `npm run db:check`。

## 常见问题

### 上传或生成结果归档失败

检查 OSS 的 `ALIYUN_ACCESS_KEY_ID`、`ALIYUN_ACCESS_KEY_SECRET`、`ALIYUN_OSS_ENDPOINT`、`ALIYUN_OSS_BUCKET` 是否完整配置，且 Bucket、Endpoint 与访问权限匹配。

### 智能导演不可用

确认 `DIRECTOR_AGENT_BASE_URL`、`DIRECTOR_AGENT_API_KEY`、`DIRECTOR_AGENT_MODEL` 均已设置，并确认 `LLM_API_PROTOCOL` 与目标服务兼容。

### 视频生成提示服务未配置

根据所选模型与时长检查对应服务：Duomi 提供旧版 8 秒 Veo 及首尾帧；Veo 3.1 使用 `OAIAPI_VEO_KEY`，支持 4/6/8 秒；Omni Flash 和 Grok Video 1.5 使用各自的 OAI 配置；Grok Video 1.5 Fast 使用 TTAPI。

### 提取尾帧或合成成片失败

确认 `ffmpeg` 已安装并已加入 `PATH`，再重试操作。

### 无法合成专业编辑项目

专业编辑项目至少需要 2 个分镜；每个分镜必须选择一个状态为「已完成」的视频版本。

### 生产环境 Cookie 无法保持登录

使用 HTTPS，并将 `NODE_ENV=production` 加入 `.env`。此时会话 Cookie 会自动启用 `Secure` 属性。

## 数据与安全边界

- 服务使用 SQLite 保存用户、项目、任务、文件元数据、会话和积分流水；账号、任务、素材和项目均按用户隔离。
- 上传素材、生成结果、尾帧和成片会归档到 OSS，服务本地保留缓存。
- 密码使用带随机盐的 `scrypt` 哈希保存；会话 Cookie 为 `HttpOnly`、`SameSite=Lax`。
- 写操作会校验同源请求；登录失败过多会被临时限流。
- 当前设计适合单机单进程运行。不要让多个服务进程同时使用同一个 SQLite 数据目录。
