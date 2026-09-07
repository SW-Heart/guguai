# GuGu AI 项目约定

## UI 与图标约定

- 更新、重启等系统操作优先使用成熟图标库的语义图标；当前按 Lucide 的 `Download`、`RefreshCw`、`CircleAlert`、`X` 线性图标规范实现，避免继续绘制不稳定的自定义图形。
- 液态玻璃组件沿用主体的浅色玻璃材质、靛蓝品牌色、半透明边框与模糊阴影；状态文字必须完整可见，不能依靠裁切传达进度。
- 更新与重启弹窗采用“居中图标 + 短文案 + 明确主次按钮”；普通说明文字不使用链接色、悬浮态或可点击暗示，所有操作都必须落在实体按钮上。
- 产品更新类弹窗的身份图标复用 GuGu AI 的 `brand-gem` 产品 Logo；重复的模块标签和进度辅助文字不展示，进度以视觉进度条和状态按钮表达。

## 桌面客户端发版记忆

- 用户提到“更新客户端版本”“发新版”“客户端更新”或在版本更新后说“开始构建”时，自动使用 `gugu-desktop-release` 技能，不要重新摸索平台构建方式。
- 本项目把 `v0.31` 这类紧凑写法解释为合法 SemVer `0.3.1`，即最后一位是 patch；不要误写为 `0.31.0`。已是三段式的版本号按原值使用。
- 默认由 GitHub Actions 同时构建 Windows x64 和 macOS arm64。Windows 禁止在本地交叉构建；除非用户明确要求本地验包或诊断 CI，否则也不要重复进行本地 macOS 打包。
- CI 只能构建远端已有的代码。版本改动必须先提交并推送，再执行 `gh workflow run ci.yml --ref main`；推送 `main` 本身只运行质量检查，不会自动启动桌面打包 job。
- 如果当前请求没有明确授权提交和推送，只在远端写入前集中确认一次提交、推送和 CI 触发；确认后连续完成 CI 监控和 Artifact 验收，不要逐步反复询问。不要夹带无关改动、强推、擅自创建 tag 或上传 OSS。
- 不要仅凭 `gh auth status` 的警告宣布阻塞；先尝试实际需要的 `git push` 或 `gh workflow run`，只有目标命令真实失败后才报告凭据问题。
- CI 成功后必须核验 Windows Artifact 包含 EXE、EXE blockmap 和 `latest.yml`，macOS Artifact 包含 DMG、ZIP、各自 blockmap 和 `latest-mac.yml`。OSS 上传与稳定下载别名更新属于独立发布阶段，必须得到用户明确授权。
- 本地 `release/` 保留旧版本是增量更新所需行为。检查本地预览时必须核对 feed 内的版本号；macOS 构建后残留的旧 `latest.yml` 不能被当作当前 Windows feed。
