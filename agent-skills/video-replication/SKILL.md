---
name: video-replication
description: 按 Hypit 原技能分析和复刻参考视频，保留叙事、表演、语义时间、素材依赖与画面系统的方法；通过 GuGu 工具完成原片阅读、改编、生成、剪辑和检查。
---

# 视频复刻 · Hypit 方法与 GuGu 工具

本技能直接使用 Hypit 固定版本的原文，核心方法不再由摘要代替。`references/hypit/` 内的 72 个文件从工作区源副本逐字节复制；来源、版本与许可证见 `SOURCE.md`。你仍是同一个 GuGu Agent，负责用户委托的视频。

## 优先一次生成，保持画面连续

制作时先用 `models_describe` 核对当前模型的单次时长、模式与参考素材能力。同一场景中没有大幅画面改变的连续动作、对白和人物互动，尽量在一次视频生成中完成；小幅推拉摇移、景别调整、表情变化、换人说话或叙事节拍变化，不作为分别生成的理由。把动作先后、人物关系、摄影机运动和需要保持的外观、道具、光线写进同一份完整描述，让模型完成连续表演。一条生成视频也可以包含模型支持的多个镜头；分析中的镜头数、参考图数、台词段落数不等于生成请求数。

场景切换或很大的画面改变才优先考虑拆分，但仍评估能否由模型在一次生成内完成。需要拆分时，说明具体的场景变化、画面差异或单次能力限制，保留连贯动作与完整对话，减少接缝。目标时长超过当前模型单次上限时，先核对已可用且符合用户选择的能力，再按必要的最少段数制作；不擅自换模型、增加费用或删减目标。用户明确指定分段或要求连续长镜头时，以其要求为准；拼接不能被宣称为连续长镜头。方案、拆分接点和检查方法见 [交付与变更](references/adaptation-delivery.md)。

## 当前阶段的交付

先确定本次是原片拆解、改编方案、画面描述、制作成片还是局部修改；从已有当前版本继续。开始改编或制作、接手已有结果时读 [交付与变更](references/adaptation-delivery.md)，将原片发现对应到目标作品，明确哪些已完成、缺什么以及保留哪些素材。用户只要拆解不进入生成；用户要成片则不能以拆解或提示词代替成片。

## 加载与执行规则

先读 [GuGu 工具适配](references/gugu-tools.md)，再按当前问题读取下面的原文资料；不为简单修改先加载整套上游说明。[Hypit 原技能](references/hypit/SKILL.md)用于需要整体导演方法时查阅。保留原技能的观看目标、表演、语义时间和可编辑作品原则，涉及操作时以本平台可执行工具为准。原文中的 Hypit CLI、Runtime、SVML/SVS/SVRun、Studio、Provider、账户安装和命令示例不是当前 GuGu 的可调用接口；按适配表调用真实工具，缺少等价能力时明确缺项。不得执行原文的安装、索取第三方密钥或把语法示例当成平台参数。

用 `skills_read`，`name: video-replication` 读取资料。长文返回 `nextOffset` 时，对同一 `resource` 继续传入该 `offset`，直到该页完整读完；不能只读第一页就视为已加载。原文链接相对于所在文件解析，原文 SKILL 中的 `references/...` 对应本技能的 `references/hypit/references/...`，不跳回工作区外目录。

## 把方法变成实际作品

先理解原片每个系统对观看体验的作用，再设计新版本中的对应关系。分别记录用户目标、原片事实、目标台词与创作决定，复用已成功的角色和场景素材。把原片“第几秒出现”转换为“目标中的哪个词或动作触发”，交付实际可播放文件后核对可观察结果。不要仅交一篇分析就声称完成复刻，也不要仅因生成请求成功就宣布效果合格。

需要叠加图文、补充视频、分屏或动画时，读取 [可执行的画面编排](references/video-editing.md)，用 `video_edit`、`video_edit_read` 和现有合成工具完成。工具选择由当前作品决定；文字分析和局部改稿不需要制作全片。

## 按原文进入当前问题

- 理解参考片：读 [原片阅读](references/hypit/references/creation/reference-video.md)；多人身份与本平台取帧限制补充见 [读取补充](references/reference-reading.md)。
- 定义新版本、保留和替换内容：读 [Brief 与 Treatment](references/hypit/references/creation/brief.md) 和 [改编](references/hypit/references/creation/transformations.md)。
- 改写对白、语言、节奏或按词触发事件：读 [剧本与语义时间](references/hypit/references/creation/script-and-time.md)。保留语义关系，以目标片实际表演重新定时，不照搬原片秒数。
- 写或修改图像描述：先读 [图像指导](references/hypit/references/playbooks/craft/image-direction.md)；角色、商品、场景多次复用时读 [素材依赖](references/hypit/references/playbooks/craft/generated-dependencies.md)。
- 写或修改视频描述、动作与表演：先读 [视频指导](references/hypit/references/playbooks/craft/video-direction.md)；声音身份与表演关系按原文继续读取。
- 字幕、补充画面、声音、动态图形，以及口播、访谈、排名、短剧等具体形态：从 [创作方法与类型索引](references/hypit/references/playbooks/index.md) 读取当前相关原文；制作能力看工具适配，不能把未支持效果悄悄省略。
- 检查或返工：读 [原版检查方法](references/hypit/references/production/review.md)，以实际可观察证据评价。只有抽帧和转录时不能声称已连续观看、听审。

用户只要求拆解时交付分析；明确要求制作时，在已有内容授权和平台费用确认范围内完成制作。字幕、独立配音、音乐、音效和动态图形按作品与用户选择安排，不强制添加，也不因某能力缺失而擅自改变用户目标。沿用已确认的选择，普通创作判断不反复询问。

用户补充的镜头原则用于细化摄影指导：需要设计或纠正运镜时，读取 `video-production` 的 `references/camera-and-blocking.md`。人物行动与摄影机运动分别写清，运动要有观看目的、起止构图和停止条件；这些补充不替代 Hypit 原文的表演与改编方法。
