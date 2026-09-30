# Hypit 复刻能力的模型与服务评估

核对版本：Hypit `78d7436071bace1ee2bc9bf662d0b89cc3d84e2f`，2026-09-24。这里记录的是该仓库实际声明的能力，不代表 GuGu 已接入，也不把 Hypit 的某个 Provider 当成必须采用的第三方服务。

| 需求 | Hypit 当前实现或模型 | GuGu 接入判断 |
| --- | --- | --- |
| 视频结构、动作、字幕和图像理解 | Hypit 的 `media probe/frames/tiles/boundaries/cut` 与 FFmpeg 提供时间化视觉证据；语义解释由使用 Skill 的多模态 Agent 完成，没有固定的视频理解模型 ID。 | GuGu 对话模型将支持图像输入。后续如接入可同时读取视频画面与音轨的模型，先形成全片概览，再用定点画面、物理切镜与准确台词核对；直接读视频的模型与图像模型看到的帧密度不能混为一谈。 |
| 单张图片理解 | 同一多模态 Agent 看图片，没有独立的“Hypit 图片理解模型”。OpenCV 包负责特定图像处理，不替代语义理解。 | 复用视觉对话模型；对于密集小字、商品包装和局部动作，评估分辨率、裁切复看与 OCR 准确率。 |
| 图像、视频生成（与“理解”分开） | HypiHub 映射列出视频 `seedance-2`、`seedance-2-fast`、`seedance-2-mini`、`seedance-2.5`、`pixverse/v6`、`pixverse/c1`、`minimax-h3`、`grok-imagine-video`、`grok-imagine-video-1.5-preview`，以及图像 `gpt-image-2`、`nano-banana-2`、`nano-banana-pro`、`seedream-5-lite`。这些模型负责生成，不负责看懂原片。 | 继续复用 GuGu 现有图像/视频路由，只按复刻质量、参考一致性、时长和费用评估是否补充。 |
| 语音识别和逐词时间 | 本地 `WhisperX 3.8.6`：faster-whisper ASR，默认 `small/cpu/int8`；`large-v3` 是质量优先示例。中文、英文各需对应的 WhisperX 对齐资源。HypiHub 默认远程路由 `victor-upmeet/whisperx`。 | 第一版已选 Deepgram Nova-3 预录音频接口：平台服务端把原片音轨规范为 16 kHz 单声道 MP3，保存逐词起止、置信度、说话人和字幕建议；不要求用户配置第三方账号。 |
| 声音设计、配音 | HypiHub 映射：`mimo-v2.5-tts-voicedesign`、`mimo-v2.5-tts-voiceclone`；`fishaudio/voice-design-1`、`fishaudio/voice-clone`；`eleven_ttv_v3` 用于 ElevenLabs Voice Design 候选，并非这个映射中的独立长篇配音操作。 | 先选“声音设计 + 目标台词配音”闭环，核验中文/英文、参考声音限制、返回格式、长句分段、时长与真实价格。声音设计结果是可复用音频素材。 |
| 音乐生成与音效生成 | 该快照有 Audio Track、Sound 和具体的混音方法，但没有固定的音乐或音效生成 Model/Provider 映射，也不附带曲库。可使用原视频声轨、已提供音频、视频模型生成的声音或其他来源。 | 不是复刻底座的必选模型。只有目标视频确实需要独立可控的 BGM/音效且现有素材或视频原声不合适时再选型。 |
| 原视频音轨提取 | `media:ExtractAudio` 由 FFmpeg 实现，输出规范化 WAV；不调用模型。 | GuGu 已先接入原片混合音轨提取，输出可播放的 M4A 文件库素材；后续 ASR Worker 可另做 16 kHz WAV 投影。 |
| 人声与背景音乐分离 | 该快照未发现内置声源分离模型；音轨提取只得到原有混音。 | 可选。只有确需保留原片伴奏并替换其中人声时，再评估声源分离模型/服务，记录漏音、伪影与成本。 |
| 裁切、拼接、混音和成片编码 | Hypit 媒体管线和 Audio Track 由 FFmpeg/渲染组件执行，属于确定性处理。 | 平台媒体 Worker 实现，不需要选生成模型；需可编辑多轨 Composition 和真实成片检查。 |

## 已落地的模型无关能力

- Agent 的 `video_probe`、`video_frames`、`video_boundaries` 可逐段阅读原片画面；帧进入当前多模态对话调用，尚需验证所选 GuGu 模型确实支持 `image_url`。
- `audio_extract` 将视频原有混合音轨提取为文件库音频，画布显示播放器；它不做人声/音乐分离。`audio_transcribe` 使用 Deepgram Nova-3 识别原片或生成视频中的台词，`source_transcript_read` 按原片时间读取词级结果。Agent 项目内的对话共享转录；画布可查看台词时间线、播放同步字幕及下载 SRT。
- `source_observation_read/write` 保存原片事实、时间点、依据与修订版本；新增画面依据必须引用实际读取过的帧，台词依据必须引用已转录词句。`video_audio_check` 只检查音轨、音量和静音，不判断声音内容。`video_compose` 可合成视频并混合最多 8 条已有独立音轨，设置成片起点、裁剪、音量和淡入淡出；视频原声可逐段调节或静音。对混音成片完整转录后，`video_caption_burn` 可把普通或逐词卡点字幕烧录进新的 MP4。混合原声声源分离、自动听懂音乐音效和人工听审记录仍需后续能力。
- 上述 FFmpeg 操作运行在 GuGu 服务端，用户无需安装本地命令行工具。

## 接入前需要确定的最小选择

1. **直接读视频模型（可选接入）**：若要以全片视频和音轨联合理解作为第一遍分析，指定平台视频理解路由，明确视频时长、采样密度、音轨读取与时间码能力；与现有按时间取帧的 LLM 分析在快切、包装小字、中文字幕和前后动作连续性上对照。
2. **ASR + 对齐**：已接 Deepgram Nova-3；用中文、英文、专名、混合语言和背景音乐下的人声做实际素材评估，并核对词级时间是否足以支撑字幕卡点。若中文混说效果不足，再考虑其他识别模型或平台托管对齐 Worker。
3. **配音**：先验证现有视频模型的原生口播和参考音色。若需独立旁白或补录，首选评估 MiMo Voice Clone；若还需从文字创建新音色，再加 MiMo Voice Design。两者组成同一家模型的完整闭环，无须同时接入 Fish/ElevenLabs。
4. **音乐/音效和声源分离**：默认不接独立模型。只有实际项目需要替换或单独控制这些声部时，再确定服务。

## 源码依据

- [HypiHub 模型映射](https://github.com/hypit-ai/hypit/blob/78d7436071bace1ee2bc9bf662d0b89cc3d84e2f/packages/provider-hypihub/src/mapping.ts)：语音模型 ID 与服务字段。
- [HypiHub Provider](https://github.com/hypit-ai/hypit/blob/78d7436071bace1ee2bc9bf662d0b89cc3d84e2f/packages/provider-hypihub/src/provider.ts)：托管 WhisperX 默认模型与路由。
- [本地 WhisperX 说明](https://github.com/hypit-ai/hypit/blob/78d7436071bace1ee2bc9bf662d0b89cc3d84e2f/packages/provider-whisperx-local/README.md)、[Worker 说明](https://github.com/hypit-ai/hypit/blob/78d7436071bace1ee2bc9bf662d0b89cc3d84e2f/services/whisperx/README.md)：本地 ASR/对齐模型与运行参数。
- [媒体任务定义](https://github.com/hypit-ai/hypit/blob/78d7436071bace1ee2bc9bf662d0b89cc3d84e2f/packages/media-pipeline/src/manifest.ts)、[媒体执行器](https://github.com/hypit-ai/hypit/blob/78d7436071bace1ee2bc9bf662d0b89cc3d84e2f/packages/media-execution/src/execute.ts)：音轨提取与媒体处理。
- [原片分析方法](https://github.com/hypit-ai/hypit/blob/78d7436071bace1ee2bc9bf662d0b89cc3d84e2f/skills/hypit/references/creation/reference-video.md)：全片与局部视觉阅读方法。
