# 全参考与素材职责

仅在目标接口明确支持 H3 Ref2VA 结构及对应输入映射时使用。六段依次为：

```text
subject_definitions:
...

summary:
...

retention_analysis:
...

detailed_description:
...

overall_soundscape:
...

non_diegetic_music:
...
```

共同的镜头、对白与声音语法见 [基础模式与声画语法](base-and-audio.md)。这里不使用 `integrated_multimodal_description`。

## 素材文件与参考内容分开编号

`<Picture N>`、`<Video N>`、`<Audio N>` 分别按各类实际输入建立对应；`<Subject N>` 是从素材中提取的参考内容，不是文件序号。一个文件可提供人物和场景两个 Subject，多份素材也可共同定义一个人物。保持同一编号在六段中含义不变。

| 标签 | 何时单独定义 |
| --- | --- |
| `<Subject N>` | 要跟踪的人物、物品、场景、服装、动作或风格等内容 |
| `<Picture N>` | 图片作为首帧、尾帧、关键帧、构图或分镜规划锚点 |
| `<Video N>` | 原片编辑/续拍来源，或整片运镜、剪辑、节奏参考 |
| `<Audio N>` | 原音复制，或音色、节拍、音乐与声音内容参考 |

只用于外貌的图片在 Subject 定义中引用即可，不重复建一个无实际独立作用的 Picture 条目。单独 Video 标签不替代视频里的人物 Subject。

```text
<Subject 1> is the courier in <Picture 1>; preserve her short hair and green raincoat, but use the target doorway instead of the photograph's background.
<Audio 1> is the voice-timbre reference for <Subject 1> (S1), without reusing its spoken words or signal.
```

说话人 ID 与 Subject 序号不必相同，按目标发声顺序赋值；Audio 定义绑定发声人物时复用其 ID，不重新分配。Video 与 Audio 各自计数，数字相同不说明两者同源。视频自带音轨只有真正启用作声音输入时才建立 Audio 条目；必要时明说它与哪段 Video 同源，不能假设适配器自动拆音轨。

## 任务摘要

`summary` 为一小段英文，以方括号任务类型起头，必要时用 ` + ` 组合，类型不重复。只用已建立的标签。

| 类型 | 真实关系 |
| --- | --- |
| `keyframe completion` | 图片是目标片的具体帧锚点 |
| `reference generation` | 借用外貌、环境、动作、风格或节奏 |
| `video editing` | 直接修改原视频 |
| `video continuation` | 从原视频继续或延展 |
| `audio reuse` | 直接复用原声音信号 |
| `audio reference` | 参考音色、节奏或内容，重新生成声音 |

编辑摘要在类型之后以 `The target video is an edited version of <Video 1>.` 开始。原片运镜参考不自动变成编辑；编辑图像、两帧间生成也不属于视频编辑。

## 保留关系

`retention_analysis` 对每项需要独立追踪的参考标签写一行：使用位置、固定关系值、具体保留/修改内容。人物新增动作或换到目标场景不一定损失保真，判断范围取决于该 Subject 定义承担的职责。

| 视觉值 | 含义 |
| --- | --- |
| `fully_preserved` | 定义的参考职责全部保留 |
| `partially_preserved` | 定义中的部分特征改变 |
| `attribute_transfer` | 特征转移到不同可识别主体 |
| `weak_reference` | 只保留宽泛相似性 |

| 音频值 | 含义 |
| --- | --- |
| `fully_copy` | 源音频完整充当目标片的完整最终音轨 |
| `partially_copy` | 只拷贝片段/声层，或复制后增加、删除、替换声音 |
| `reference` | 只参考音色、节奏、内容、纹理，未复制信号 |
| `weak_reference` | 只借用宽泛类别或氛围 |

源音乐下增加对白时不能宣称最终音轨 `fully_copy`。`retention_analysis` 不写说话人 `(Sx)`。

## 正文中让参考实际生效

`detailed_description` 在 `[Shot 1]` 之前用一两句英文建立风格，之后依序写画面、动作、摄影机、光线、空间、声音和变化。第一次出现 Subject 时说明其可见特征、位置与动作；引用 Audio 的镜头或阶段说明复制还是参考，不能只在定义表里提到。

真实说话人物写 `<Subject 2> (S1)`；原配乐内歌词只是动作触发点时引用 `<Audio N>`，不虚构一个发声人物。仅参考音色时使用新台词；复用或明确重唱源歌词时保留可听清的原词，听不清用 `[unclear]`。官方全参考指南允许整理源转录的装饰标点；用户指定逐字原稿时按原稿保留，不擅自改词。

总体声场与配乐分别说明所用 Audio 的对应声层，不重复完整对白。结构中的“复制”是任务目标；若要逐样本保留原音乐或严格节拍，优先保留原音轨并在具备能力的后期工具中对齐，生成结果仍需实际核对。
