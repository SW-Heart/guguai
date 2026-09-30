# Hypit 来源与适配边界

- 上游仓库：https://github.com/hypit-ai/hypit.git
- 源副本记录的固定提交：`78d7436071bace1ee2bc9bf662d0b89cc3d84e2f`
- 原目录：`skills/hypit/`
- 工作区原始副本：`vendor-hypit-skill/`
- 原副本引入日期：2026-09-23；本次完整接入日期：2026-09-28。
- 活跃原文：`references/hypit/`，包含原 SKILL 与 references 的全部 72 个文件，逐字节复制；未将旧副本升级为上游 main。源副本另有 `agents/openai.yaml` 展示元数据，因此源副本共 73 个文件；该元数据不参与 GuGu 的技能加载。
- 核对清单：`references/hypit/manifest.json`，逐文件记录路径、字节数与 SHA-256。
- 校验：`node scripts/agent/sync-hypit-skill.mjs --check`；重新复制：去掉 `--check`。更新上游快照时须同时更新脚本的固定提交与本记录。

## 哪些保留，哪些替换

原文的导演责任、全片/局部阅读、改编、Script 与语义时间、角色表演、图像/视频指导、参考依赖、字幕、B-roll、声音、动态图形、各种视频形态与验收方法全部保留。原文示例、链接与措辞未改写；没有用摘要代替正文。

活跃 `SKILL.md` 是 GuGu 加载入口，先读 `references/gugu-tools.md` 和原版入口，再按当前创作问题读取原版专题。`references/video-editing.md` 说明本平台可执行的图层和语义时间接口。工具替换通过单独适配规则执行：平台工具定义决定调用名称和参数，原文 CLI/Runtime/SVML 示例不在 GuGu 执行。`references/reference-reading.md` 仅保留本平台多人身份与取帧补充；用户提供的摄影知识通过 video-production 参考单独读取。2026-09-28 新增的 `references/adaptation-delivery.md` 是 GuGu 原创交付与局部变更指导，不属于上游逐字副本，不修改 manifest 或 Hypit 原文。

Hypit 的环境安装、包语法、组件渲染和 Studio 文件也保留，方便追溯，默认不执行其操作。没有等价工具的能力明确列入适配缺项：直接复制 Skill 不代表接入 Hypit Runtime 或完整复刻其渲染系统。

## 许可证

上游使用带额外条件的 Apache 2.0 修改版，并非无附加条件的 Apache-2.0。完整声明保存在 `LICENSE.hypit.txt`；来源为固定提交的 https://github.com/hypit-ai/hypit/blob/78d7436071bace1ee2bc9bf662d0b89cc3d84e2f/LICENSE 。

该声明对多租户托管服务和商业分发要求 Hypit.AI 的书面授权；本记录不表示 GuGu 已取得授权。面向第三方工作区的生产发布或商业分发前应确认适用许可。原文、来源与权利声明保留；此适配不改变其权利归属。
