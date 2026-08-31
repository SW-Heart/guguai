# GuGu AI 创作工作台

GuGu AI 是一个单机运行的 AI 图片、视频与短剧创作工作台。它提供账号和积分体系、个人文件库、图片/视频生成，以及从剧本到完整成片的短剧工作流。

> 服务仅监听本机 `127.0.0.1`，生产环境必须使用单进程、持久化数据目录，并通过反向代理提供 HTTPS；完整步骤见“生产部署与域名”章节。

## 功能概览

- **个人创作空间**：手机号短信登录、密码登录、账号昵称与密码设置、积分流水、用户数据隔离。
- **管理后台**：仅管理员可登录 `/guguadmin`，管理用户、模型、全局价格、积分和运行日志。
- **文件库**：本地优先保存、搜索、筛选、预览、下载、重命名与删除图片、视频和音频素材；私有 R2 只作为备份与跨设备同步来源。
- **图片生成**：支持提示词、比例、质量和最多 7 张参考图；成品自动进入文件库。
- **视频生成**：支持文生视频、参考图视频、首尾帧视频；按时长和模式自动选择视频服务。
- **短剧创作**：提供「智能导演」和「专业编辑」两种工作模式，支持资源定稿、分镜、镜头视频、尾帧衔接与一键成片。

## 运行前准备

### 1. 安装依赖

需要以下软件：

- **Node.js 22.13.0 或更高版本**：项目使用无需实验开关的内置 `node:sqlite`。
- **ffmpeg**：用于提取镜头尾帧和合成最终 MP4。
- 可用的 Duomi、TTAPI、LLM、Cloudflare R2 与阿里云短信服务凭据，按实际启用的功能配置。

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
| 常规视频 | `TTAPI_API_KEY`、`TTAPI_API_BASE`、`TTAPI_GROK_VIDEO_FAST_MODEL` | 使用 Grok Video 1.5 Fast 的 10、15、20、30 秒文本或参考图视频 |
| Omni Flash 视频 | `OAI_API_BASE`、`OAIAPI_GEMINI_KEY`、`OAI_OMNI_FAST_MODEL` | 使用 `omni-fast` 的 10 秒文本、参考图或首尾帧视频 |
| Grok Video 视频 | `OAI_API_BASE`、`OAIAPI_GROK_KEY`、`OAI_GROK_MODEL` | 使用 OAI 兼容接口的 Grok Video，支持 6/12 秒、480p/720p 和 7 种画幅；仅支持 1 张参考图，按 1 积分/秒计费 |
| Veo 3.1 视频 | `OAI_API_BASE`、`OAIAPI_VEO_KEY`、`OAI_VEO_31_MODEL` | 使用 oairegbox 的 `firefly-veo-3.1`，支持 4/6/8 秒文生视频和单图参考图视频 |
| MiniMax H3 视频 | `OAI_API_BASE`、`OAIAPI_MINIMAX_KEY`、`OAI_MINIMAX_H3_768_MODEL`、`OAI_MINIMAX_H3_2K_MODEL` | 平台统一展示为 MiniMax H3；选择 768p 路由到 768p 模型，选择 2K 路由到 2K 模型，支持 4–15 秒文本、参考图和首尾帧视频 |
| Seedance 2.0 / 2.5 动态线路 | `DIW_API_BASE`、`DIW_KEY`、`WJ_API_BASE`、`WJ_TJWD_KEY`、`WJ_SD_PY_900_KEY`、`CNTCN_API_BASE`、`CNTCN_KEY` | 后台按模型与分辨率维护完整调用线路；每 10 分钟通过 `/v1/models` 自动停用或恢复缺失模型，支持手动指定优先线路 |
| Seedance 2.0 Fast 视频 | `DIW_API_BASE`、`DIW_KEY` | 使用 DIW 的 `ed-seedance 2.0 fast 720p`，固定 15 秒/720p，支持 9 图 + 3 视频 + 3 音频参考 |
| GuGu 2.0 视频 | `AUTODL_API_BASE`、`AUTODL_COMFYUI_KEY`、`AUTODL_MINIMAX_H3_15S_WORKFLOW_ID` | 内部模型 ID 为 `minimax-h3-15s`，通过 AutoDL ComfyUI 工作流使用；支持最多 9 张参考图片 + 3 段参考音频，1～15 秒，16:9/9:16 与 480p/768p 组合，1 积分/秒 |
| 智能导演 | `DIRECTOR_AGENT_BASE_URL`、`DIRECTOR_AGENT_API_KEY`、`DIRECTOR_AGENT_MODEL` | 使用智能导演、剧本分析或自动分镜 |
| LLM 计费 | `LLM_API_PROTOCOL`、`LLM_INPUT_PRICE_YUAN_PER_MILLION`、`LLM_OUTPUT_PRICE_YUAN_PER_MILLION`、`YUAN_PER_CREDIT` | 使用智能导演时建议确认 |
| 短信登录 | `SMS_ACCESS_KEY_ID`、`SMS_ACCESS_KEY_SECRET`、`SMS_SIGN_NAME`、`SMS_TEMPLATE_CODE`、`SMS_SCHEME_NAME` | 使用阿里云号码认证服务发送和核验短信验证码；短信凭据与媒体存储凭据相互隔离 |
| 文件存储 | `R2_*`、`R2_REFERENCE_*`、`MEDIA_OBJECT_PREFIX` | 用户素材、生成结果和成片固定使用私有 R2；模型参考图片使用独立临时 R2 Bucket |
| 桌面发布 | `DESKTOP_API_BASE`、`DESKTOP_UPDATE_OSS_PREFIX`、`DESKTOP_UPDATE_PUBLIC_URL` | 构建生产客户端并使用 `npm run desktop:release -- --publish` 发布桌面自动更新文件 |
| 浏览器直传 | `DIRECT_UPLOAD_ENABLED`、`R2_UPLOAD_EXPIRES_SECONDS`、`R2_ASSET_URL_EXPIRES_SECONDS`、`UPLOAD_INTENT_EXPIRES_SECONDS`、`UPLOAD_MAX_PENDING_PER_USER`、`UPLOAD_INIT_LIMIT_PER_MINUTE` | 使用 R2 预签名 PUT；上传完成后服务端执行对象大小、MIME 和文件头校验，默认开启 |

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
OAIAPI_MINIMAX_KEY=your_oai_minimax_key
OAI_MINIMAX_H3_768_MODEL=minimax-h3-768p
OAI_MINIMAX_H3_2K_MODEL=minimax-h3-2k
# OAI 兼容视频任务的最长轮询时长（默认 30 分钟；单次 HTTP 请求超时仍为 300 秒）
OAI_MAX_POLL_DURATION_MS=1800000

CNTCN_API_BASE=https://api.ai.kbai.cc
CNTCN_KEY=your_cntcn_key
CNTCN_SD2_MODEL=933qudao-g
DIW_API_BASE=https://mjnewapi.diwdiw.cn
DIW_KEY=your_diw_key
WJ_API_BASE=https://www.weijinapi.top
WJ_TJWD_KEY=your_wj_tjwd_key
WJ_SD_PY_900_KEY=your_wj_seedance_900_key
MODEL_ROUTE_CHECK_INTERVAL_MS=600000
# 动态视频线路创建任务的提交请求超时时间（默认 180 秒）
VIDEO_ROUTE_SUBMIT_TIMEOUT_MS=180000
# 异步视频提交后，超过此时间仍未取得上游 taskId 则失败并退款（默认 5 分钟）
VIDEO_PROVIDER_TASK_ID_TIMEOUT_MS=300000

AUTODL_API_BASE=https://autodl.art
AUTODL_MINIMAX_H3_15S_WORKFLOW_ID=minimax_h3_image_audio_to_video_v2_15s
AUTODL_COMFYUI_KEY=your_autodl_comfyui_key

DIRECTOR_AGENT_BASE_URL=https://your-llm-endpoint
DIRECTOR_AGENT_API_KEY=your_llm_key
DIRECTOR_AGENT_MODEL=deepseek-v4-flash
LLM_API_PROTOCOL=openai-compatible
LLM_INPUT_PRICE_YUAN_PER_MILLION=3
LLM_OUTPUT_PRICE_YUAN_PER_MILLION=6
YUAN_PER_CREDIT=0.1

SMS_ACCESS_KEY_ID=your_sms_access_key_id
SMS_ACCESS_KEY_SECRET=your_sms_access_key_secret
SMS_ENDPOINT=dypnsapi.aliyuncs.com
SMS_SIGN_NAME=速通互联验证码
SMS_TEMPLATE_CODE=100001
SMS_SCHEME_NAME=AIGC
SMS_VALID_TIME_SECONDS=300
SMS_INTERVAL_SECONDS=60
SMS_CODE_LENGTH=6
R2_ACCESS_KEY_ID=your_r2_access_key_id
R2_SECRET_ACCESS_KEY=your_r2_secret_access_key
R2_ENDPOINT=https://your-account-id.r2.cloudflarestorage.com
R2_BUCKET=your_private_media_bucket
R2_REGION=auto
MEDIA_OBJECT_PREFIX=model-studio
# 模型参考图专用公共 R2 Bucket；凭据留空时复用上面的 R2_*，但 Bucket 必须单独填写
R2_REFERENCE_ACCESS_KEY_ID=
R2_REFERENCE_SECRET_ACCESS_KEY=
R2_REFERENCE_ENDPOINT=
R2_REFERENCE_BUCKET=your_public_reference_bucket
R2_REFERENCE_REGION=auto
R2_REFERENCE_PUBLIC_BASE_URL=https://r2-ref.example.com
R2_REFERENCE_IMAGE_PREFIX=model-studio/temporary/reference-images
R2_REFERENCE_IMAGE_TTL_MINUTES=60
# 请在 R2 为上述前缀配置生命周期过期规则；应用不会周期性扫描整个 Bucket
DIRECT_UPLOAD_ENABLED=true
R2_UPLOAD_EXPIRES_SECONDS=300
R2_ASSET_URL_EXPIRES_SECONDS=900
# 视频/音频异步模型稍后拉取输入，签名地址默认保留 2 小时
R2_MODEL_INPUT_URL_EXPIRES_SECONDS=7200
UPLOAD_INTENT_EXPIRES_SECONDS=600
UPLOAD_MAX_PENDING_PER_USER=3
UPLOAD_INIT_LIMIT_PER_MINUTE=10
UPLOAD_VERIFY_STALE_MINUTES=10
UPLOAD_SWEEP_INTERVAL_MINUTES=10
MEDIA_TMP_DIR=/var/lib/gugu-ai/tmp
```

说明：

- 业务媒体固定使用私有 R2，需要完整配置 `R2_ACCESS_KEY_ID`、`R2_SECRET_ACCESS_KEY`、`R2_ENDPOINT`、`R2_BUCKET`；服务端不再读取业务 OSS 配置。
- 新版本使用全新的 SQLite 基线，正式部署从空 `DATA_DIR` 开始，不迁移旧用户、旧任务或旧业务素材。已有旧数据库会被拒绝启动。
- `R2_REFERENCE_BUCKET` 是模型参考图专用 Bucket，必须和 `R2_BUCKET` 分开；参考图凭据和连接参数可留空以复用主 R2 配置。
- `R2_REFERENCE_PUBLIC_BASE_URL` 必须指向绑定到 `R2_REFERENCE_BUCKET` 的公共自定义域名，不能填 R2 S3 API Endpoint，也不能填 Bucket 名称；所有视频模型带参考图片时都必须配置，保证供应商拿到统一的无签名 R2 URL。
- 图生图和图生视频不会把私有主桶地址直接提交给模型。服务端会先把参考图片复制到 `R2_REFERENCE_BUCKET` 的 `R2_REFERENCE_IMAGE_PREFIX` 临时目录，使用公共地址或短期签名地址提交，默认 60 分钟后自动删除；因此带参考图片的生成需要配置参考图专用 R2。
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

首次使用前先执行 `npm run create-admin` 创建管理员。新用户默认使用手机号短信登录，发送验证码前必须完成图形人机验证，首次验证手机号时会自动创建账号；登录后可在“账号设置”中设置昵称和密码，之后可用昵称/账号与密码登录。历史用户仍可继续使用原账号密码登录。密码长度为 8–128 位；邀请码不再参与注册，旧邀请码数据仅保留用于历史数据兼容。

## 桌面客户端（内测）

桌面客户端适合素材量较大、需要快速查阅本地成品的场景。内测阶段暂不做 macOS Developer ID 签名和公证，macOS 首次打开可能需要在系统安全设置中允许应用。

### 启动与打包

```bash
# 启动本地服务并打开 Electron 客户端（仅开发调试）
npm run desktop:dev

# 指定已运行的服务地址（不会重复启动服务）
npm run desktop:dev -- --api-base=http://127.0.0.1:4317

# 构建当前平台的安装包，构建时写入线上 API，产物写入 release/
DESKTOP_API_BASE=https://api.example.com npm run desktop:dist
```

本地开发的 `.env` 可以这样配置：

```dotenv
NODE_ENV=development
PORT=4317
DATA_DIR=./data
TRUST_PROXY=
DESKTOP_APP_ONLY=true
# 官网下载按钮（留空时使用 GuGu AI 桌面安装包稳定别名，也可按部署需要覆盖）
PUBLIC_MAC_DOWNLOAD_URL=
PUBLIC_WINDOWS_DOWNLOAD_URL=

# 下面三项仅用于桌面客户端构建/发布；本地 desktop:dev 不需要填写。
# OSS 发布凭据请放在独立的 .env.desktop-release 文件，不要放入服务端 .env。
DESKTOP_UPDATE_OSS_PREFIX=
DESKTOP_UPDATE_PUBLIC_URL=
DESKTOP_API_BASE=
```

运行 `npm run desktop:dev` 时，脚本会自动启动 `server.mjs`，并将桌面端连接到 `http://127.0.0.1:4317`。`DATA_DIR=./data` 表示数据库和本地运行数据放在项目根目录的 `data/` 下；如需隔离测试数据，可改成 `./data-desktop-dev`。本地没有 Nginx 反向代理时，`TRUST_PROXY` 保持为空。

生产安装包采用标准的“桌面客户端 + 线上 API 服务”架构：客户端只连接构建时写入的线上 API 地址，不内置或自动启动 Node 服务，也不会把项目 `.env`、模型密钥或 OSS 密钥打进安装包。若地址未配置或服务暂时不可达，客户端会打开服务连接页；填写 HTTPS API 地址并保存后即可重试。`npm run desktop:dev` 仅用于本地开发，会启动项目服务并把桌面端指向本机地址。

网页入口默认是 GuGu AI 官网，创作工作台只对桌面客户端开放；`/guguadmin` 和 `/api/admin/*` 仍供管理后台使用。客户端通过受控请求标识访问工作台，普通浏览器访问 `/image`、`/video`、`/drama`、`/files` 会回到官网。需要临时启用网页工作台时，可在服务环境设置 `DESKTOP_APP_ONLY=false`，不建议在生产环境长期使用。

发布生产/内测包时必须设置 `DESKTOP_API_BASE`，例如：

```bash
DESKTOP_API_BASE=https://api.example.com \
  DESKTOP_UPDATE_PUBLIC_URL=https://download.example.com/gugu-ai \
  npm run desktop:release
```

三个桌面发布变量的对应关系如下：

| 变量 | 配置位置 | 示例 | 作用 |
| --- | --- | --- | --- |
| `DESKTOP_API_BASE` | 构建客户端时的环境变量 | `https://ai.example.com` | 桌面客户端连接的线上服务根地址；不是 `/api` 子路径，也不要带尾部 `/` |
| `DESKTOP_UPDATE_OSS_PREFIX` | 发布脚本环境变量 | `model-studio/desktop-updates` | 安装包、feed、blockmap 在 OSS 中的对象前缀 |
| `DESKTOP_UPDATE_PUBLIC_URL` | 发布脚本环境变量 | `https://download.example.com/gugu-ai` | 用户设备可以直接下载更新文件的 HTTPS 根地址，必须和 OSS/CDN 的对象前缀对应 |

官网首次下载链接使用同一目录下的稳定别名，不要写死版本号，也不要使用 GitHub Artifact 地址。发布脚本每次上传新版本时会在版本文件和 feed 完成后同步覆盖这两个别名，因此服务器环境通常只需配置一次：

```dotenv
PUBLIC_MAC_DOWNLOAD_URL=https://download.example.com/gugu-ai/latest-mac.dmg
PUBLIC_WINDOWS_DOWNLOAD_URL=https://download.example.com/gugu-ai/latest-windows.exe
```

其中 `latest-mac.dmg` 和 `latest-windows.exe` 只服务官网首次下载；Electron 自动更新仍使用同一目录下的 `latest-mac.yml` 和 `latest.yml`，不应把 `.yml` 地址填进官网安装包下载按钮。

`DESKTOP_API_BASE` 不需要写进服务器 `.env`。服务器只需要正常运行 `server.mjs`，并通过域名和 HTTPS 反向代理暴露出来。例如服务器 `.env` 使用：

```dotenv
NODE_ENV=production
PORT=4317
DATA_DIR=/var/lib/gugu-ai
TRUST_PROXY=loopback
```

Nginx 将 `https://ai.example.com` 转发到本机 `127.0.0.1:4317` 后，检查：

```bash
curl --fail https://ai.example.com/healthz
# {"status":"ok"}
```

此时构建桌面客户端时使用 `DESKTOP_API_BASE=https://ai.example.com` 即可。完整的 systemd、Nginx 和 HTTPS 配置见下方「生产部署与域名」。

客户端默认工作区为系统 Documents 下的 `GuGu AI Projects`，也可以在右上角「本地工作区」切换。每个工作区包含以下目录：

```text
GuGu AI Projects/
├── library/                 # 素材和生成成品的本地主副本
├── projects/                # 短剧项目文件
├── exports/                 # 导出成片
└── .gugu/
    ├── library.db           # 本地 SQLite 索引、SHA-256、云端关联 ID
    ├── library-index.json   # 旧版本索引，仅首次启动时迁移
    ├── transfers/           # 下载/上传临时文件
    ├── cache/
    └── logs/
```

### 本地优先与 R2 备份

- 从客户端导入的图片、视频、音频会先复制到 `library/` 并计算 SHA-256；相同内容再次导入会直接复用本地文件。
- 导入完成后再向服务端发起 R2 预签名 PUT 直传。服务端按同一账号的 SHA-256 做秒传复用，因此重复上传只提交元数据。
- AI 生成完成后，客户端优先通过受保护的交付地址直接从上游结果链接把成品落到本地 `library/`；上游需要鉴权时由服务端代为转发，避免把密钥交给客户端。文件库、任务卡片和预览优先使用本地 `gugu-media://` 地址，不再重复从网络加载。
- 生成结果会给客户端一个短暂的本地接收窗口（默认 120 秒）。客户端完成 SHA-256 校验并回执后，服务端不再把该成品上传 R2；只有客户端未接收、下载失败或客户端离线时，服务端才将结果归档到 R2，作为临时兜底和跨设备来源。
- 客户端启动时先读取本地 SQLite 索引；首次成功联网只接收有限的待交付成品，之后通过服务端签名游标按增量同步变更，并以每台设备的 `deviceId` 记录本地回执。文件库使用 keyset 分页，任务卡片按 `assetId` 精确补取，不会为了打开页面扫描全部素材。网络不可用时仍可搜索、预览、重命名、删除和另存本地素材。
- R2 是临时备份/跨设备同步来源，不是客户端浏览的主存储。服务器不需要把大文件转存到应用服务器；生成接口仍需联网，未同步的本地素材不会被提交为生成参考图。
- 临时参考图在请求完成后按对象键精确清理；为覆盖服务重启场景，必须在 `R2_REFERENCE_IMAGE_PREFIX` 对应前缀配置 R2 生命周期过期规则。应用不会按周期 `ListObjects` 扫描整个参考图 Bucket。

删除云端文件时，客户端会同时删除对应的本地副本；需要保留素材时请先在工作区或其他备份介质中复制一份。

### 自动更新与标准 CI

生产或内测分发时，为客户端提供一个静态 Generic Update Feed。仓库的 GitHub Actions 负责质量检查和构建安装包，但不会上传桌面发布 OSS：

- Pull Request 和 `main` 分支提交：运行语法检查和全部测试。
- `v*` tag 或手动触发：在 Linux 通过质量检查后，并行构建 Windows x64 与 macOS arm64，分别上传到 GitHub Actions Artifact。
- Artifact 只保留安装包、feed 和 blockmap 等最终发布文件，不包含 `win-unpacked`、`mac-arm64` 等 electron-builder 中间目录。
- Artifact 下载后先安装、启动、登录并验证正式包；确认无误后，再使用 `$gugu-desktop-oss-publish` Skill 人工上传 OSS。

GitHub 仓库需要先配置两个 Repository variables（不是 Secrets）：

| 变量 | 示例 | 用途 |
| --- | --- | --- |
| `DESKTOP_API_BASE` | `https://ai.example.com` | 安装包连接的线上 API 根地址 |
| `DESKTOP_UPDATE_PUBLIC_URL` | `https://download.example.com/gugu-ai` | 用户设备可访问的 Generic Update Feed 根地址 |

两个地址必须是 HTTPS，且 `DESKTOP_UPDATE_PUBLIC_URL` 必须对应 OSS/CDN 的公开目录。OSS AccessKey 不要配置到 GitHub Actions，也不要提交到仓库。

默认使用 GitHub Actions 同时构建两个平台。本地脚本只用于 macOS 安装包验收或 CI 诊断：

```bash
# 本地 macOS 预览：构建安装包，并列出发布清单（不会上传）
DESKTOP_API_BASE=https://api.example.com \
  DESKTOP_UPDATE_PUBLIC_URL=https://download.example.com/gugu-ai \
  npm run desktop:release -- --mac --arm64
```

CI 构建使用 `macos-14` Apple Silicon runner 生成 macOS arm64 包，使用 Windows runner 生成 Windows x64 包。macOS 当前默认关闭签名发现，因此没有 Apple Developer ID 证书时会生成未签名包；用于公开分发前应补充签名和公证配置。

当 `DESKTOP_API_BASE` 或 `DESKTOP_UPDATE_PUBLIC_URL` 已配置时，脚本会在构建过程中把线上 API 地址和更新地址临时写入安装包元数据，构建结束后恢复源码。因此用户从 Finder 双击安装包即可连接线上服务并自动检查更新，不需要在用户电脑上设置环境变量。

CI 与本地诊断命令：

```bash
# 默认流程：版本提交推送后，手动触发 CI，同时构建 Windows x64 和 macOS arm64
gh workflow run ci.yml --ref main

# 仅在本地验包或诊断时构建 macOS Apple Silicon
DESKTOP_API_BASE=https://guguai.xyz \
  DESKTOP_UPDATE_PUBLIC_URL=https://你的更新公开地址 \
  npm run desktop:release -- --mac --arm64
```

Windows 包固定由 `.github/workflows/ci.yml` 的 `windows-latest` job 构建，不在 macOS 本地配置 Wine 或执行 `--win`。CI 同时使用 `macos-14` 生成 macOS arm64 包。

使用 GitHub Actions 发布构建包只需要：

1. 修改 `package.json` 的 `version`，例如从 `0.1.0` 改为 `0.1.1`。
2. 运行 `npm run check` 和 `npm test`，只提交并推送本次版本相关改动。
3. 执行 `gh workflow run ci.yml --ref main`。推送 `main` 本身只运行质量检查，不会自动启动桌面打包 job；只有明确需要 tag 发布时，才创建与 `package.json.version` 匹配的 `v*` tag。
4. 在 Actions 中等待 `quality`、Windows x64 和 macOS arm64 三个 job 成功。
5. 下载两个 Artifact，分别测试 Windows 安装包和 macOS arm64 DMG/ZIP。
6. 测试正式包确认无误后，调用 `$gugu-desktop-oss-publish` Skill；Skill 会再次核对版本、feed、blockmap、官网稳定别名和目标目录，并在上传前要求明确确认。
7. 已安装客户端会自动检查更新；也可以点击页面左侧导航底部的「更新」。发现新版本后会弹出版本提示并默认开始下载，下载完成后再次提示“重启更新”；确认后客户端会关闭并打开对应安装包，用户按系统提示重新安装覆盖。

也可以在客户端离线连接页填写「自动更新地址」并重启客户端，用于覆盖安装包内置地址。`DESKTOP_UPDATE_PUBLIC_URL` 必须与用户端的 `GUGU_UPDATE_URL` 相同；OSS endpoint 本身不一定是可公开访问的下载地址，通常应使用 OSS 公网域名或 CDN 自定义域名。

更新采用 electron-updater 的 Generic feed。electron-builder 会为 zip/安装包生成 `.blockmap`；客户端有旧版本缓存时会通过 HTTP Range 请求只下载差异块，差分失败才回退为完整包。首次安装、跨架构或缓存不可用时仍需要完整下载。OSS/CDN 必须支持 HTTPS、Range 和正确的 `Content-Length`，并且不能长期缓存 `latest*.yml` 或官网稳定下载别名。

OSS 上传仍然是人工步骤，不属于 GitHub Actions。`$gugu-desktop-oss-publish` Skill 会读取本地 `.env.desktop-release` 或当前 shell 中的 OSS 配置，执行 `npm run desktop:release -- --publish --skip-build`。它会先上传当前版本的安装包、feed 和 blockmap，最后同步 `latest-mac.dmg`、`latest-windows.exe` 两个官网稳定别名；不会构建新包、不会删除旧版本，且不会把 OSS 密钥写入仓库或 CI。当前 Codex 环境同时提供 `gugu-desktop-release` skill；下次说明“更新版本”即可按本项目流程完成版本修改、校验、远端写入确认、CI 构建和 Artifact 验收。

未签名 macOS 客户端不使用 ShipIt 替换应用。客户端仅借助 Generic feed 检查版本，并从同源 HTTPS 地址下载 DMG；下载完成后会按 `latest-mac.yml` 中的文件大小和 SHA-512 校验安装包。用户确认“退出并安装”后，会启动独立安装引导进程，GuGu AI 完全退出后才挂载并打开 DMG，避免 Finder 因旧版本仍在运行而无法覆盖。随后用户在 Finder 中将新版本拖入「应用程序」并选择覆盖即可。

取得 `Developer ID Application` 证书后，可再切回签名应用的原生自动替换流程并配置 Apple 公证。证书应通过钥匙串或 `CSC_LINK`、`CSC_KEY_PASSWORD` 注入，不要提交到仓库。

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
- 30 MB 请求上限，覆盖 20 MB 图片和 25 MB 视频上传。
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
- 历史邀请码数据保留查询能力，但不再参与普通用户注册。
- 生成、积分、LLM、审计和系统日志；支持按用户、模型和时间范围筛选。
- 冻结积分异常的人工对账查询。

后台写操作使用独立管理员会话、同源校验和 CSRF Token。不要共享普通用户会话 Cookie，也不要将后台地址当作唯一安全措施。

## 日常使用步骤

### 1. 上传与管理素材

1. 登录后进入「文件库」。
2. 上传 PNG、JPEG、WebP、MP4、WebM、MOV、MP3、WAV 或 FLAC 文件。
3. 图片最大 20 MB，视频最大 25 MB。
4. 在文件库中搜索、筛选、预览、下载或重命名素材；图片可作为图片生成和视频生成的参考图。

### 2. 生成图片或普通视频

**图片生成**

1. 进入「图像生成」。
2. 输入提示词，选择画面比例和质量；如需保持主体或风格，可选择最多 7 张参考图。
3. 提交后等待任务完成，结果会自动保存到文件库。

**视频生成**

1. 进入「视频生成」。
2. 输入提示词，选择模型、画幅、时长和清晰度。
3. 参考素材使用统一入口；系统会按当前模型只允许上传支持的图片、视频或音频，并显示各类型数量上限。素材必须来自当前账号的文件库，图片不超过 20 MB，视频或音频不超过 25 MB。
4. 等待完成后，在任务列表或文件库预览、下载成品。

图片和普通视频价格由管理员后台配置。Seedance 2.0/2.5 根据当前实际选中的线路成本动态定价：成本上浮 20%，按 1 积分 = ¥0.1 换算；任务提交时固化价格快照，价格或线路变化时会要求用户确认最新价格。

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
| 文生视频 | 不可带参考素材 | Grok Video：6、12 秒；Grok Video 1.5 Fast：10、15、20、30 秒；Veo：8 秒；Omni Flash：10 秒；Veo 3.1：8 秒；MiniMax H3：4–15 秒；Seedance 2.0：15 秒；Seedance 2.5：30 秒 | 依模型能力 | MiniMax H3：768p / 2K；Seedance 2.0/2.5：480p / 720p |
| 参考素材视频 | 1 张图片（Grok Video；Veo 3.1：1 张）；MiniMax H3：图片 5 / 视频 3 / 音频 3，合计 15；Seedance 2.0/Fast：图片 9 / 视频 3 / 音频 3；Seedance 2.5：图片 30 / 视频 10 / 音频 10 | Seedance 2.0/Fast：15 秒；Seedance 2.5：30 秒；其他依模型能力 | Seedance：16:9 / 9:16 / 1:1 | 依模型能力 |
| GuGu 2.0 参考素材视频 | 图片最多 9 张、音频最多 3 段，合计最多 12 个；不支持参考视频 | 1–15 秒 | 16:9 / 9:16 | 480p / 768p |
| 首尾帧视频 | 1–2 张图片 | Veo：固定 8 秒；Omni Flash：10 秒；MiniMax H3：4–15 秒 | 依模型能力 | 依模型能力 |

Seedance 2.0/2.5/Fast 使用 DIW、WJ、CNTCN 的动态完整调用线路。服务每 10 分钟按“渠道地址 + API Key”请求 `/v1/models`：目录缺失会自动停用，重新出现会自动恢复。后台可修改线路启停、优先级和成本，也可指定一条手动优先线路；指定线路不可用时仍按其余优先级降级。WJ 按 `seconds` 提交，DIW 按 `duration` 提交，CNTCN 使用 `reference_image_urls` 等参考字段；任务 ID、线路快照和价格快照都会持久化，重启后只轮询原线路，不会重复提交。

其他路由保持原有适配：Grok Video 1.5 Fast 使用 TTAPI；Veo 使用 Duomi；Omni Flash、Veo 3.1 和 MiniMax H3 使用 OAI；GuGu 2.0 使用 AutoDL ComfyUI 工作流。OAI 任务最长等待 30 分钟，可用 `OAI_MAX_POLL_DURATION_MS` 调整。

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

# 启动桌面客户端（内测）
npm run desktop:dev

# 构建桌面安装包
npm run desktop:dist

# 构建并预览桌面发布文件；追加 -- --publish 才会上传桌面安装包 OSS
npm run desktop:release
```

## 全新数据库、备份与恢复

### 全新数据库基线

本版本从全新的 SQLite 基线启动，不支持旧 SQLite schema、旧 JSON 数据或旧业务素材迁移。检测到旧数据库时服务会拒绝启动，避免把旧数据误当作新数据使用。

正式切换前请停止服务，使用旧版本工具或原始 SQLite 只读方式备份旧 `DATA_DIR`，再将旧目录改名为带时间戳的 quarantine 目录。不要直接覆盖或删除旧目录。随后创建权限为 `0700` 的新空目录，设置新的 `DATA_DIR`，启动服务并创建首个管理员：

```bash
install -d -m 700 /var/lib/gugu-ai-new
DATA_DIR=/var/lib/gugu-ai-new npm run create-admin
```

`npm run create-admin` 只用于新 SQLite 数据库中的管理员初始化或管理员提升，不会导入旧账号。新库启动后应执行 `npm run db:check`，并确认 `users`、`assets`、`generations` 和 `upload_intents` 均从零开始。

### 备份与恢复

元数据保存在 `${DATA_DIR:-data}/studio.db`，数据库使用 WAL 模式；浏览器直传和未被桌面客户端接收的生成结果会归档到私有 R2，生成结果归档使用任务临时目录中转。SQLite 热备份不包含 R2 对象，生产环境还必须为 R2 配置生命周期、版本控制或独立备份策略。

桌面客户端的媒体主副本位于用户选择的本地工作区，服务端数据库只保存素材元数据和云端对象关联。桌面工作区需要纳入用户电脑的备份策略；`.gugu/library.db`、`.gugu/library-index.json`（旧版本迁移源）与 `library/` 必须一起备份，不能只备份索引文件。

备份请使用：

```bash
npm run db:backup
```

不要只复制 `studio.db`，因为最近提交的数据可能仍在 `studio.db-wal` 中。若需要清理旧本地媒体，必须先确认对应 R2 对象的大小和校验信息，再使用 `npm run media:audit -- --delete` 分批执行；本版本不会自动清理旧数据目录。

恢复步骤：

1. 停止服务。
2. 将 `studio.db.bak-<时间戳>` 重命名为 `studio.db`。
3. 删除同目录的 `studio.db-wal` 和 `studio.db-shm`。
4. 重新启动服务，并执行 `npm run db:check`。

## 常见问题

### 上传或生成结果归档失败

检查 `R2_ACCESS_KEY_ID`、`R2_SECRET_ACCESS_KEY`、`R2_ENDPOINT`、`R2_BUCKET`，同时确认 Bucket、Endpoint 与访问权限匹配；浏览器直传还需要在 R2 Bucket 配置生产 Web Origin、`PUT`、`Content-Type` 和 `ETag` CORS 权限。

### Seedance 2.0 参考图返回 403

所有视频模型带参考图片时都需要配置 `R2_REFERENCE_PUBLIC_BASE_URL`，使供应商的 `HEAD` 可用性预检和后续 `GET` 下载都能成功。图生图在未配置公共域名时仍可使用短期签名 URL；视频参考图不再允许走签名 URL，避免不同供应商的兼容性差异。

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
- 上传素材、生成结果、尾帧和成片固定归档到私有 R2，服务本地保留缓存；桌面安装包、更新清单和 blockmap 仍单独发布到 OSS。
- 密码使用带随机盐的 `scrypt` 哈希保存；会话 Cookie 为 `HttpOnly`、`SameSite=Lax`。
- 写操作会校验同源请求；登录失败过多会被临时限流。
- 当前设计适合单机单进程运行。不要让多个服务进程同时使用同一个 SQLite 数据目录。
