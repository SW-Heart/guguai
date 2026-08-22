# GuGu AI 创作工作台

GuGu AI 是一个单机运行的 AI 图片、视频与短剧创作工作台。它提供账号和积分体系、个人文件库、图片/视频生成，以及从剧本到完整成片的短剧工作流。

> 服务仅监听本机 `127.0.0.1`，生产环境必须使用单进程、持久化数据目录，并通过反向代理提供 HTTPS；完整步骤见“生产部署与域名”章节。

## 功能概览

- **个人创作空间**：账号注册/登录、邀请码注册、积分流水、用户数据隔离。
- **管理后台**：仅管理员可登录 `/guguadmin`，管理用户、模型、全局价格、邀请码、积分和运行日志。
- **文件库**：本地优先保存、搜索、筛选、预览、下载、重命名与删除图片、视频和音频素材；云端 OSS 只作为备份与跨设备同步来源。
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
| 常规视频 | `TTAPI_API_KEY`、`TTAPI_API_BASE`、`TTAPI_GROK_VIDEO_FAST_MODEL` | 使用 Grok Video 1.5 Fast 的 10、15、20、30 秒文本或参考图视频 |
| Omni Flash 视频 | `OAI_API_BASE`、`OAIAPI_GEMINI_KEY`、`OAI_OMNI_FAST_MODEL` | 使用 `omni-fast` 的 10 秒文本、参考图或首尾帧视频 |
| Grok Video 视频 | `OAI_API_BASE`、`OAIAPI_GROK_KEY`、`OAI_GROK_MODEL` | 使用 OAI 兼容接口的 Grok Video，支持 6/12 秒、480p/720p 和 7 种画幅；仅支持 1 张参考图，按 1 积分/秒计费 |
| Veo 3.1 视频 | `OAI_API_BASE`、`OAIAPI_VEO_KEY`、`OAI_VEO_31_MODEL` | 使用 oairegbox 的 `firefly-veo-3.1`，支持 4/6/8 秒文生视频和单图参考图视频 |
| MiniMax H3 视频 | `OAI_API_BASE`、`OAIAPI_MINIMAX_KEY`、`OAI_MINIMAX_H3_768_MODEL`、`OAI_MINIMAX_H3_2K_MODEL` | 平台统一展示为 MiniMax H3；选择 768p 路由到 768p 模型，选择 2K 路由到 2K 模型，支持 4–15 秒文本、参考图和首尾帧视频 |
| Seedance 2.0 / Seedance 2.0 Fast 视频 | `CNTCN_API_BASE`、`CNTCN_KEY`、`CNTCN_SD2_MODEL`、`CNTCN_SD2_FAST_MODEL` | 通过 CNTCN 异步接口使用两个模型；Seedance 2.0 固定 15 秒，Fast 支持 5–15 秒，均支持 720p、16:9/1:1/9:16 和参考素材，3 积分/秒 |
| GuGu 2.0 视频 | `AUTODL_API_BASE`、`AUTODL_COMFYUI_KEY`、`AUTODL_MINIMAX_H3_ID` | 通过 AutoDL ComfyUI 工作流使用；支持最多 9 张参考图片 + 3 段参考音频，1～15 秒，16:9/9:16 与 480p/768p 组合，1 积分/秒 |
| 智能导演 | `DIRECTOR_AGENT_BASE_URL`、`DIRECTOR_AGENT_API_KEY`、`DIRECTOR_AGENT_MODEL` | 使用智能导演、剧本分析或自动分镜 |
| LLM 计费 | `LLM_API_PROTOCOL`、`LLM_INPUT_PRICE_YUAN_PER_MILLION`、`LLM_OUTPUT_PRICE_YUAN_PER_MILLION`、`YUAN_PER_CREDIT` | 使用智能导演时建议确认 |
| 文件存储 | `ALIYUN_ACCESS_KEY_ID`、`ALIYUN_ACCESS_KEY_SECRET`、`ALIYUN_OSS_ENDPOINT`、`ALIYUN_OSS_BUCKET`、`ALIYUN_OSS_PREFIX` | 上传文件、使用参考图、保存生成结果或成片 |
| 桌面发布 | `DESKTOP_API_BASE`、`DESKTOP_UPDATE_OSS_PREFIX`、`DESKTOP_UPDATE_PUBLIC_URL` | 构建生产客户端并使用 `npm run desktop:release -- --publish` 发布桌面自动更新文件 |
| 浏览器直传 | `DIRECT_OSS_UPLOAD_ENABLED`、`ALIYUN_OSS_UPLOAD_EXPIRES_SECONDS`、`UPLOAD_INTENT_EXPIRES_SECONDS`、`UPLOAD_MAX_PENDING_PER_USER`、`UPLOAD_INIT_LIMIT_PER_MINUTE` | 开启浏览器直传杭州 OSS；默认关闭，需先完成 OSS CORS 验证 |

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

CNTCN_API_BASE=https://api.ai.cntcn.com
CNTCN_KEY=your_cntcn_key
CNTCN_SD2_MODEL=933qudao-g
CNTCN_SD2_FAST_MODEL=933qudao-fast

AUTODL_API_BASE=https://autodl.art
AUTODL_MINIMAX_H3_ID=minimax_h3_image_audio_to_video_v2_15s
AUTODL_COMFYUI_KEY=your_autodl_comfyui_key

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
DIRECT_OSS_UPLOAD_ENABLED=false
ALIYUN_OSS_UPLOAD_EXPIRES_SECONDS=300
ALIYUN_OSS_ASSET_URL_EXPIRES_SECONDS=900
UPLOAD_INTENT_EXPIRES_SECONDS=600
UPLOAD_MAX_PENDING_PER_USER=3
UPLOAD_INIT_LIMIT_PER_MINUTE=10
MEDIA_TMP_DIR=/var/lib/gugu-ai/tmp
MEDIA_JOB_CONCURRENCY=2
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

# 下面三项仅用于桌面发布，本地 desktop:dev 不需要填写
DESKTOP_UPDATE_OSS_PREFIX=
DESKTOP_UPDATE_PUBLIC_URL=
DESKTOP_API_BASE=
```

运行 `npm run desktop:dev` 时，脚本会自动启动 `server.mjs`，并将桌面端连接到 `http://127.0.0.1:4317`。`DATA_DIR=./data` 表示数据库和本地运行数据放在项目根目录的 `data/` 下；如需隔离测试数据，可改成 `./data-desktop-dev`。本地没有 Nginx 反向代理时，`TRUST_PROXY` 保持为空。

生产安装包采用标准的“桌面客户端 + 线上 API 服务”架构：客户端只连接构建时写入的线上 API 地址，不内置或自动启动 Node 服务，也不会把项目 `.env`、模型密钥或 OSS 密钥打进安装包。若地址未配置或服务暂时不可达，客户端会打开服务连接页；填写 HTTPS API 地址并保存后即可重试。`npm run desktop:dev` 仅用于本地开发，会启动项目服务并把桌面端指向本机地址。

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
    ├── library-index.json   # 本地索引、SHA-256、云端关联 ID
    ├── transfers/           # 下载/上传临时文件
    ├── cache/
    └── logs/
```

### 本地优先与 OSS 备份

- 从客户端导入的图片、视频、音频会先复制到 `library/` 并计算 SHA-256；相同内容再次导入会直接复用本地文件。
- 导入完成后再向服务端发起 OSS 直传或兼容上传。服务端按同一账号的 SHA-256 做秒传复用，因此重复上传只提交元数据。
- AI 生成完成后，客户端通过服务端签名下载地址把成品自动落到本地 `library/`；文件库、任务卡片和预览优先使用本地 `gugu-media://` 地址，不再重复从网络加载。
- 客户端启动时先读取本地索引；网络不可用时仍可搜索、预览、重命名、删除和另存本地素材。联网后会在后台补齐尚未落地的历史云端素材。
- 云端 OSS 是临时备份/跨设备同步来源，不是客户端浏览的主存储。服务器不需要把大文件转存到应用服务器；生成接口仍需联网，未同步的本地素材不会被提交为生成参考图。

删除云端文件时，客户端会同时删除对应的本地副本；需要保留素材时请先在工作区或其他备份介质中复制一份。

### 自动更新

生产或内测分发时，为客户端提供一个静态 Generic Update Feed。当前仓库提供一键构建并发布到 OSS 的脚本：

```bash
# 第一次先预览：构建安装包，并列出将要上传的文件（不会上传）
DESKTOP_API_BASE=https://api.example.com \
  DESKTOP_UPDATE_PUBLIC_URL=https://download.example.com/gugu-ai \
  npm run desktop:release

# 配好线上 API、更新地址和 OSS 凭据后，构建并上传到 OSS
DESKTOP_API_BASE=https://api.example.com \
  DESKTOP_UPDATE_PUBLIC_URL=https://download.example.com/gugu-ai \
  npm run desktop:release -- --publish
```

脚本会读取现有的 `ALIYUN_ACCESS_KEY_ID`、`ALIYUN_ACCESS_KEY_SECRET`、`ALIYUN_OSS_ENDPOINT`、`ALIYUN_OSS_BUCKET`，默认上传到 `${ALIYUN_OSS_PREFIX}/desktop-updates/`。如需指定目录，可设置 `DESKTOP_UPDATE_OSS_PREFIX`。它会自动上传安装包、zip、`latest-*.yml` 和 blockmap 文件，并对 `latest-*.yml` 使用不缓存策略。

当 `DESKTOP_API_BASE` 或 `DESKTOP_UPDATE_PUBLIC_URL` 已配置时，脚本会在构建过程中把线上 API 地址和更新地址临时写入安装包元数据，构建结束后恢复源码。因此用户从 Finder 双击安装包即可连接线上服务并自动检查更新，不需要在用户电脑上设置环境变量。

按平台分别构建：

```bash
# macOS：在 macOS 上执行，生成 DMG、ZIP 和对应 blockmap/feed
DESKTOP_API_BASE=https://guguai.xyz \
  DESKTOP_UPDATE_PUBLIC_URL=https://你的更新公开地址 \
  npm run desktop:release -- --mac

# Windows：建议在 Windows 构建机上执行，生成 NSIS 安装包
# PowerShell
$env:DESKTOP_API_BASE = "https://guguai.xyz"
$env:DESKTOP_UPDATE_PUBLIC_URL = "https://你的更新公开地址"
npm run desktop:release -- --win
```

当前 macOS 主机未安装 Wine，不能直接在这台 Mac 上可靠生成 Windows NSIS 安装包；Windows 包请在 Windows 构建机或 CI 上执行。`--mac`、`--win`、`--linux` 参数会传递给 electron-builder，也可以使用 `--x64` 或 `--arm64` 指定架构。

每次发布只需要：

1. 修改 `package.json` 的 `version`，例如从 `0.1.0` 改为 `0.1.1`。
2. 确认 `DESKTOP_API_BASE` 是线上 API 的 HTTPS 地址，`DESKTOP_UPDATE_PUBLIC_URL` 是浏览器可访问的更新 feed 地址；并准备 OSS 四项凭据。
3. 执行带两个地址的 `npm run desktop:release` 检查文件清单。
4. 执行 `DESKTOP_API_BASE=https://api.example.com DESKTOP_UPDATE_PUBLIC_URL=https://download.example.com/gugu-ai npm run desktop:release -- --publish`。
5. 已安装客户端会自动检查更新；也可以点击页面左侧导航底部的「更新」。发现新版本后会自动下载，下载完成后按钮变为「重启更新」。

也可以在客户端离线连接页填写「自动更新地址」并重启客户端，用于覆盖安装包内置地址。`DESKTOP_UPDATE_PUBLIC_URL` 必须与用户端的 `GUGU_UPDATE_URL` 相同；OSS endpoint 本身不一定是可公开访问的下载地址，通常应使用 OSS 公网域名或 CDN 自定义域名。

更新采用 electron-updater 的 Generic feed。electron-builder 会为 zip/安装包生成 `.blockmap`；客户端有旧版本缓存时会通过 HTTP Range 请求只下载差异块，差分失败才回退为完整包。首次安装、跨架构或缓存不可用时仍需要完整下载。OSS/CDN 必须支持 HTTPS、Range 和正确的 `Content-Length`，并且不能长期缓存 `latest-*.yml`。

目前这是本机一键发布流程，还没有绑定 GitHub Actions 等 CI。后续如果确定代码托管平台，可以再把同一条命令接到打 tag 自动构建发布。当前 Codex 环境已提供 `gugu-desktop-release` skill；下次直接说明“更新版本”即可按本项目流程递增版本、校验并生成发布清单，只有明确要求上传时才执行 OSS 发布。

内测包未签名/未公证，自动更新机制已经接入，但 macOS 可能因系统安全策略限制未签名应用的自动替换；内测阶段可在更新失败时重新打开最新安装包覆盖安装。正式对外发布前仍应补充代码签名、公证和 HTTPS 更新源。

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
2. 上传 PNG、JPEG、WebP、MP4、WebM、MOV、MP3、WAV 或 FLAC 文件。
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
| 文生视频 | 不可带参考图 | Grok Video：6、12 秒；Grok Video 1.5 Fast：10、15、20、30 秒；Veo：8 秒；Omni Flash：10 秒；Veo 3.1：8 秒；MiniMax H3：4–15 秒；Seedance 2.0：15 秒 | 依模型能力 | MiniMax H3：768p / 2K；Seedance 2.0：720p |
| 参考素材视频 | 1 张图片（Grok Video；Veo 3.1：1 张）；MiniMax H3：图片 5 / 视频 3 / 音频 3，合计 15；Seedance 2.0：图片 9 / 视频 3 / 音频 3，合计 15；Seedance 2.0 Fast：图片 9 / 视频 3 / 音频 3，合计 12 | Grok Video：6、12 秒；Grok Video 1.5 Fast：10、15、20、30 秒；Veo：8 秒；Omni Flash：10 秒；Veo 3.1：8 秒；MiniMax H3：4–15 秒；Seedance 2.0：15 秒；Seedance 2.0 Fast：5–15 秒 | 依模型能力 | 依模型能力 |
| GuGu 2.0 参考素材视频 | 图片最多 9 张、音频最多 3 段，合计最多 12 个；不支持参考视频 | 1–15 秒 | 16:9 / 9:16 | 480p / 768p |
| 首尾帧视频 | 1–2 张图片 | Veo：固定 8 秒；Omni Flash：10 秒；MiniMax H3：4–15 秒 | 依模型能力 | 依模型能力 |

路由规则：Grok Video 的 6、12 秒文本/参考图视频使用 OAI 兼容接口 `POST /v1/videos` 提交任务和 `GET /v1/videos/{task_id}` 轮询；请求使用 `seconds`、`aspect_ratio`、`resolution`，单张首帧使用 `image`，最多 1 张参考图，不支持多图和 1080p。Grok Video 按 1 积分/秒计费。Grok Video 1.5 Fast 的 10、15、20、30 秒文本/参考图视频使用 TTAPI；Veo 的 8 秒文本/参考图及首尾帧视频使用 Duomi；Omni Flash、Veo 3.1 和 MiniMax H3 使用 OAI 渠道的同一组异步接口。Seedance 2.0 和 Seedance 2.0 Fast 使用 CNTCN 的同一组 `POST /v1/videos` 与 `GET /v1/videos/{task_id}` 异步接口，提示词中的 `@图片1`、`@视频1`、`@音频1` 分别按数组顺序映射到 `reference_image_urls`、`reference_videos`、`reference_audios`；标准版固定 15 秒，Fast 支持 5–15 秒，均支持 720p、16:9/1:1/9:16，按 3 积分/秒计费。CNTCN 的 `queued/running/succeeded/failed/expired` 状态会持久化到任务恢复链路，成功后归档原始下载地址。GuGu 2.0 通过 AutoDL ComfyUI 工作流提交到 `/api/v1/comfyui/comfyui_workflow/{workflow_id}`，使用 `duration`、`resolution`、`ref_image_0..8` 和 `ref_audio_0..2` 字段；分辨率由平台的画幅与清晰度组合映射为 `480p竖`、`768p竖`、`480p横` 或 `768p横`，任务通过 `/result/{task_id}` 轮询并支持服务重启恢复。MiniMax H3 支持参考图片、视频和音频，使用 `ratio`、`referenceImages`、`referenceVideos`、`referenceAudios`、`first_image`、`last_image`；768p 按 2 积分/秒计费，2K 按 3 积分/秒计费。OAI 任务默认每 4 秒轮询，单次请求超时 300 秒。

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

# 构建并预览桌面发布文件；追加 -- --publish 才会上传 OSS
npm run desktop:release
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

元数据保存在 `${DATA_DIR:-data}/studio.db`，数据库使用 WAL 模式；浏览器直传和生成结果归档后，媒体主副本保存在 OSS，生成结果使用任务临时目录中转；历史媒体仍可能存在用户 files 目录，可先用 `npm run media:audit` dry-run 审计，确认 OSS 对象后再使用 `-- --delete` 分批清理。SQLite 热备份不包含 OSS 对象，生产环境还必须为 OSS 配置版本控制、生命周期保护或独立备份策略。

桌面客户端的媒体主副本位于用户选择的本地工作区，服务端数据库只保存素材元数据和 OSS 关联。桌面工作区需要纳入用户电脑的备份策略；`.gugu/library-index.json` 与 `library/` 必须一起备份，不能只备份索引文件。

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

### Seedance 2.0 参考图返回 403

当前 OSS Bucket 使用公共读。CNTCN 参考素材必须提交不带签名 query 的公开对象 URL，使渠道的 `HEAD` 可用性预检和后续 `GET` 下载都能成功。不要为 CNTCN 使用按 GET 方法签发的 OSS 临时 URL；该 URL 在渠道发起 HEAD 请求时会因签名方法不匹配返回 403。

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
