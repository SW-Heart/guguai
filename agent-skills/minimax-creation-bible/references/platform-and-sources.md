# 平台能力与来源

## GuGu 当前接入快照

核对日期：2026-10-01。依据 `lib/video-capabilities.mjs` 的公开目录与 `providers/autodl.mjs` 的提交参数；运行时目录、配置和预检优先于本快照。

| 项目 | 当前 GuGu MiniMax H3 | 官方 H3 公开规格 |
| --- | --- | --- |
| 标识 | `minimax-h3-15s`，展示名 Minimax H3 | H3-Base-FL2VA / H3-Base-Ref2VA |
| 文生/参考 | 文本、图片/音频参考 | 文本、关键帧、全参考 |
| 时长 | 1～15 秒整数，默认 5 秒 | 4～15 秒 |
| 比例 | 16:9、9:16 | 包括 21:9、16:9、4:3、1:1、3:4、9:16 |
| 清晰度 | 768p、480p | 基础 768p；可经 H3-Regenerate-2K 再生成 2K |
| 图片/视频/音频上限 | 图片 9、视频 0、音频 3，总数 12 | Ref2VA 图片 9、视频 3、音频 3，总数 12 |
| 首尾帧 | 公开目录未开放 | FL2VA 变体支持；单图可用于首帧或尾帧 |

官方参考视频每段 2～15 秒、总时长最多 15 秒，参考音频同样每段 2～15 秒、总时长最多 15 秒。GuGu 当前仅开放图片和音频；实际文件验证另看当前工具结果，不能把官方数字当作 GuGu 已完成的文件校验。官方输出为 24 FPS、32 kHz 双声道；GuGu 的生成/后期输出是否保持该规格要检测实际文件。

源码仍有旧 `minimax-h3` 的 2K、首尾帧和视频参考 profile，但不在当前公开 modelCatalog 中。不能因为搜到旧 profile 就以该 ID 提交或承诺功能。

当前工作流将整条 `prompt` 原样传入，并以 `ref_image_0...`、`ref_audio_0...` 发送图片和音频。这些零起始 API 字段不证明官方一开始的 `<Picture 1>` / `<Audio 1>` 标签已经映射；项目现有试验脚本也不构成该方言验证。默认清晰自然语言描述各参考职责；用户明确要官方结构时可交付结构正文，同时说明入口条件。

官方上下文处理 H3-Context-IR 不在开源代码中，完整官方流程涉及托管处理与 2K 再生成；本技能是在创作层遵循其公开写作方法，不等同于部署或调用官方上下文处理系统。写 `2K`、编辑或续拍在正文里不会增加当前接口能力。

## GuGu 工具衔接

实际生成先 `models_list` / `models_describe` 读取当次模式、参数、参考上限与价格。素材引用使用工具返回的真实 ID，图片/音频逐类建立顺序；只提供文字文件不等于已上传参考。

`media_prepare` 验证具体输入与报价，按既有授权调用 `media_submit`，再使用当前环境的等待工具取得真实产物。描述能力之外的任务先给可执行替代，例如把原片剪辑与补拍交给已有视频制作工具，不伪装成 H3 原片编辑。

需要成片时按需读 `video-production` 的制作计划与剪辑交付，用当前真实提供的 `video_compose` / `video_edit` 等工具安排实际视频、音乐与文字。没有这些工具的环境交付提示词与制作方案，不编造执行结果。参考语法本身不提供浏览、代码执行、Hub 或新媒体接口权限。

## 官方来源与版本

上游： [MiniMax-AI/MiniMax-H3](https://github.com/MiniMax-AI/MiniMax-H3)。本次读取固定提交 `d21241f0a4b3acbb34c97dae47fa417b7065e438`，核对日期 2026-10-01。

- [官方提示词技能](https://github.com/MiniMax-AI/MiniMax-H3/blob/d21241f0a4b3acbb34c97dae47fa417b7065e438/skills/h3-prompt-writing/SKILL.md)：任务入口、英文结构与原文保留。
- [基础/关键帧指南](https://github.com/MiniMax-AI/MiniMax-H3/blob/d21241f0a4b3acbb34c97dae47fa417b7065e438/skills/h3-prompt-writing/references/base-en.txt)：三字段、帧对齐、运镜、对白与声场语法。
- [全参考指南](https://github.com/MiniMax-AI/MiniMax-H3/blob/d21241f0a4b3acbb34c97dae47fa417b7065e438/skills/h3-prompt-writing/references/ref-en.txt)：六字段、标签、保留关系、声音来源。
- [官方制作技能目录](https://github.com/MiniMax-AI/MiniMax-H3/tree/d21241f0a4b3acbb34c97dae47fa417b7065e438/skills)：`minimalist-product-ad-generator`、`brand-promo-video-generator`、`3d-animation-short-generator`、`music-video-subtitle-generator`、`papercraft-stop-motion-explainer`、`paper-collage-explainer-generator`、`handdrawn-live-video-generator`、`co-op-game-intro-generator`。本次阅读其中文 `SKILL.cn.md`，提取与当前任务相关的制作方法。
- [官方系统说明](https://github.com/MiniMax-AI/MiniMax-H3/blob/d21241f0a4b3acbb34c97dae47fa417b7065e438/README.md)：模块、输入输出规格和托管处理边界。

本技能独立编写中文说明和原创案例；保留协议字段、关系值和必要帧对齐句式，没有整份复制上游制作技能或其强制阶段确认规则。官方八种制作技能依赖 Hub 工具，不能直接视为 GuGu 可执行技能。

上游 README 指向 [MiniMax H3 Community License Agreement](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/LICENSE)，不能把该项目默认标成 MIT；需要分发上游原文、代码或模型时另核对应许可，本技能没有引入模型权重或上游运行代码。

## 更新与证据

更新指南时重新核对上游提交、两份语法资料和本项目公开目录；不要把上游功能自动升级为 GuGu 支持。模板与问题修订属于创作方法，尚未用真实 H3 生成验证。以后试镜记录具体线路、参数、素材与观察结果，仅保存能由结果支持的结论，不做无样本的质量排名。
