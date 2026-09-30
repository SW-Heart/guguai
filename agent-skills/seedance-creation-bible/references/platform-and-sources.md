# GuGu 能力与文档来源

## 内容来源

本 skill 根据用户于2026-09-30在对话中提供的两份完整指南整理，保留版本差异、任务边界、素材建议与失败处理；去除网页展示标签和大段媒体示例，模板重新编写。未将这些资料描述为已实时核验的最新接口承诺。

- Seedance 2.0 系列提示词指南：原文给出的官方页面为 https://ark.volcengine.com/region:cn-beijing/docs/ark/seedance-2-0-prompt-guide 。
- Seedance 2.5 提示词指南：以本次用户粘贴文本为来源，未猜测其页面地址。原文引用的模板页为 https://bytedance.larkoffice.com/docx/OsiUdR1OxoDqvnxsK8LczYx7nPd ，本 skill 未读取该页，不将其内容当作已收录资料。
- 2.5 原文推荐 `sd25-pe`，并提供 `npx --yes skills@latest add "https://arkdocs.tos-cn-beijing.volces.com/skills/" --skill sd25-pe --yes`。这是原文的独立安装方式，本任务未安装或执行远端技能，不依赖它才能使用本 skill。GuGu 中选择本技能或直接指定Seedance版本即可。

文档中的人数、时长、格式和修补措施属于该来源快照。若用户要求最新规格，使用当前环境实际可用的官方文档工具核实；GuGu创作工具本身不默认提供网页浏览、NPX或命令执行能力。

## 当前平台调用边界

实际生成用 `models_list` 发现模型，`models_describe` 查看当前线路模式、时长、画幅、画质、参考类型与数量；随后 `media_prepare` 验证请求和报价。参考素材来自真实素材列表，`referenceAssetIds` 按所用模式的顺序传入；提示词中的图片N、视频N、音频N与实际输入匹配。不要重排素材却忘记更新正文编号。

供应商 `content.role`、`ratio`、`output_format` 与 GuGu 的 `generationType`、`aspectRatio` 不可直接互换。当前 `media_prepare` 提供TEXT/REFERENCE/FIRST&LAST、正数时长和有序参考素材ID，未直接提供供应商的 `duration=-1`、`output_format=mov` 或任意 `content.role` 字段。不要用额外字段绕过验证，也不要将普通图层剪辑 `video_edit` 当成Seedance原生视频编辑。

只有目录与工具明确支持并通过预检时，才能调用对应模式。提示词出现“严格编辑”“向后延长”不能单独证明线路提供了该能力。未开放时仍可交付该模型的提示词和需要的素材；实际制作可考虑已有素材剪辑、生成补充片段等当前可执行方案，并说明具体差异。

首尾帧模式只有实际接口提供、两份真实素材齐备时使用；普通参考图片上写“首帧”不代表完成严格绑定。独立音频绑定也需线路真实支持，不能只在正文中引用不存在的音频。

用户只要求提示词调优时不提交媒体任务。用户已要求实际生成时沿用既有费用确认/预算机制，报价后按会话授权提交并等待真实产物。排查不能演变为无限生成重试；必要后期处理使用可用工具与保留的原片，不假称完成了工具不支持的操作。
