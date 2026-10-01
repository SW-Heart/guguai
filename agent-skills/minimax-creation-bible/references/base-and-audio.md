# 基础模式与声画语法

用于已确认接收官方 H3 结构的 T2VA / I2VA / FL2VA / L2VA。普通工作流可复用声画设计，但不默认支持下列特殊标签。

## 三字段顺序

```text
integrated_multimodal_description: [Shot 1] ...

overall_soundscape: ...

non_diegetic_music: ...
```

主字段承担画面、动作、切镜、发声人物、对白和与画面同步的声音。第一镜先说明风格与起始构图；参考帧任务依据实际图片建立身份、服装、道具、光线和空间锚点，不能凭空描述图片内容。

关键帧对齐指令位于三个字段之前，并空一行。以下为官方规定的协议句式；提交时将 `N` 替换为真实末镜编号，`S.SS` 替换为目标时长，不能留下占位符。

I2VA：

```text
For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.
```

FL2VA：

```text
How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; Picture 2 (from Shot N) aligns with the S.SS-second mark of the target video.
```

L2VA：

```text
How the reference pictures align with the target video — <Picture 1> (from [Shot N]) aligns with the S.SS-second mark of the target video.
```

T2VA 无对齐行。FL2VA 写起点、可见中间变化、终点，不只是重复两张静态图；L2VA 的终点属于末镜，不一定是第一镜。

## 摄影机和切镜

运镜嵌入当前镜头的自然英文句子，说明运动类型，幅度与速度只在有意义时补充。`Push In / Pull Out` 移动摄影机，`Zoom In / Zoom Out` 改焦距；`Pan` 转向，`Truck` 横移；`Tilt` 俯仰，`Pedestal` 升降。跟拍说明跟谁、相对距离和停点；环绕说明中心、方向与揭示内容。不要混用互相矛盾的路线。

```text
[Shot 1] A medium shot frames the courier beside the door. The camera holds a static shot as she raises the parcel.
[Shot 2] At 00:04.000, the camera cuts to her hands placing the parcel on the bench.
```

新增切镜应带来新信息；仅需要靠近人物时可用缓慢推进。切点在实际总时长内，拍摄动作与人物动作分别写。

## 说话人与对白

发声来源按目标片首次实际发声顺序赋 `(S1)`、`(S2)`，跨镜保持，不随画面出场顺序或参考文件顺序重新编号。不发声的人物没有说话人 ID；齐声可用 `(S1,S2)`。首次发声明确音色、语速与必要口音，情绪、动作和身份写在 `<d>` 外。

```text
The courier, speaking at a measured pace in a low, clear voice (S1), says: <d>[Chinese] 这封信，请你亲手打开。</d>
```

`<d>` 内只有语言标签和实际说出的内容。基础模式保留用户台词的字词与标点，不翻译、不摘要。画外旁白用 `says in an off-screen voiceover`；如果画面上有与旁白对应的人物，紧接对白说明其嘴唇闭合，避免无意口型。

同一句话跨切点时在切点两侧用 `<scenetrans>`，并说明声音跨镜连续，不能整句在两个镜头重播。片尾确实需要截断语音时才使用 `<cutoff>`；需要完整台词的任务应先调整时长或镜头负载，不以截断解决。

## 三类声音分工

| 内容 | 放置位置 |
| --- | --- |
| 对白、唱词、画内收音机/乐器、动作时刻的声音 | 主描述的发生镜头 |
| 环境、脚步、碰撞、衣料、呼吸等整体声场 | `overall_soundscape`，通常一段 1～4 句 |
| 仅观众听到的配乐 | `non_diegetic_music`，通常 1～3 句 |

配乐写乐器、速度、节奏和强弱变化，不只写“感人”。没有配乐时音乐字段用 `N/A`；只有用户要求全片彻底静音时声场字段才用 `N/A`。“无背景音乐”仍可有对白、风声与动作声。声音摘要不重复整段台词和歌词。

画面中的招牌、文字、字幕用英文双引号圈定实际字样，如 `The label reads "晚安".`，保留原文。场景字与字幕分开指定，不因出现对白而自动加字幕。
