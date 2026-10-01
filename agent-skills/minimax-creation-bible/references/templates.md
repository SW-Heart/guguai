# 原创模板

以下为本项目原创示例，不是官方案例或已实测成片。例中台词、时长、人物与声音只服务示例，按用户要求修改。图片/声音内容是假定输入，实际使用前核对素材。官方结构只有在目标入口接收它时提交；其他入口使用自然语言。

## 当前 GuGu 线路：10 秒产品广告自然语言

输入：一张真实蓝色保温杯照片，只参考产品外形、颜色、杯盖与材质；不继承照片背景。参数：10 秒、16:9，清晰度选当前目录可用值。

```text
10 秒产品展示视频。参考图片中的蓝色保温杯，保留杯身轮廓、蓝色涂层、杯盖结构和表面材质。布景为浅灰石台，右后方窗光形成柔和边缘高光，不改变产品本体颜色。
开头以中近景展示杯子直立在石台上。镜头缓慢向前移动，杯子保持静止。第 3 秒切到杯口细节，一只手旋开杯盖，沿盖子真实结构完成动作；杯盖落在杯子右侧，杯身仍在原位。第 7 秒切回产品中近景，手退出画面，镜头停住，完整展示杯身和杯盖直至结尾。
声音只有杯盖旋开的摩擦声、轻放台面的碰触声与安静室内环境声。没有对白、旁白、背景音乐和画面文字。
```

这里只展示可由图中外观支持的开盖动作，不虚构温度测试或保温性能。动作设计不能替代产品功能证据。

## T2VA：8 秒人物对白，官方三字段

```text
integrated_multimodal_description: [Shot 1] Live-action. A medium shot frames a young courier in a green raincoat standing outside a wooden doorway, holding a dry cream envelope in her right hand. Soft afternoon light falls from the left. The camera holds still as she raises the envelope toward the unseen recipient. The courier, with a low, clear voice and measured delivery (S1), says: <d>[Chinese] 这封信，请你亲手打开。</d> She closes her lips and waits. [Shot 2] At 00:05.000, the camera cuts to a close-up of the envelope as a second hand enters from the doorway, takes it, and holds it still through the end of the eight-second video.

overall_soundscape: Quiet street ambience continues under a light breeze. The raincoat rustles as the courier raises her arm, followed by a soft paper sound during the handover.

non_diegetic_music: N/A
```

## I2VA：6 秒从真实首帧发展

假定首图确为绿雨衣快递员站在木门外、右手持信封的中景；接口已绑定该图为首帧。

```text
For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.

integrated_multimodal_description: [Shot 1] Live-action. Begin with the courier, doorway, envelope, framing, and afternoon lighting in <Picture 1>. Keep her face and green raincoat consistent. In a single continuous shot, she raises the envelope in her right hand toward the doorway. The camera pushes in slowly with small amplitude while another hand enters from inside and gently takes the envelope. The courier releases it, lowers her empty hand, and remains beside the door through the end of the six-second video. No speech or visible text.

overall_soundscape: A faint outdoor breeze continues throughout. Fabric rustles and the envelope makes a brief paper sound as it changes hands.

non_diegetic_music: N/A
```

普通图参考只能写“参考人物外貌与构图”，不能使用本例宣称已锁首帧。

## FL2VA：8 秒动作衔接

假定两帧人物、场景一致，首帧右手持信封，尾帧信封已在收件人手里，快递员右手放下；接口已绑定两图。

```text
How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; Picture 2 (from Shot 1) aligns with the 8.00-second mark of the target video.

integrated_multimodal_description: [Shot 1] Live-action, one continuous static medium shot. Start from the courier, wooden doorway, afternoon light, and hand positions in Picture 1. The courier extends the envelope with her right hand. The recipient's hand enters from the doorway and grips the opposite edge. The courier releases her fingers only after the recipient secures it, then lowers her empty right hand. Both hands slow to a stop, arriving at the positions, envelope ownership, and composition in Picture 2 at the eight-second endpoint. No speech or visible text.

overall_soundscape: A quiet breeze and distant street ambience persist. Raincoat fabric and envelope paper rustle briefly during the handover.

non_diegetic_music: N/A
```

## L2VA：6 秒收束到纸拼贴完成图

假定唯一图是薄荷绿纸底上完成组装的森林拼贴，接口绑定为尾帧。

```text
How the reference pictures align with the target video — <Picture 1> (from [Shot 1]) aligns with the 6.00-second mark of the target video.

integrated_multimodal_description: [Shot 1] Paper-collage stop-motion, a static overhead shot. Begin on the clean mint-green paper field matching <Picture 1>. Layered paper tree trunks slide into their final positions, followed by the separate leafy crowns. Each piece lands with a small tactile bounce and presses flat before the next group arrives. Preserve the paper fibers, cut edges, colors, and layered shadows from the image. All movement settles before the end, holding the completed forest composition in <Picture 1> at six seconds. No speech or visible text.

overall_soundscape: Soft paper friction follows each sliding piece, with a small tap as it lands. The final hold has quiet room ambience.

non_diegetic_music: N/A
```

## Ref2VA：10 秒人物与音色分工

假定 `<Picture 1>` 是绿雨衣快递员照片，`<Audio 1>` 是其目标音色参考；图片只提供人物，不绑定关键帧。下例压缩展示六段职责；复杂任务增加真实画面细节，不把长度当成执行条件。

```text
subject_definitions:
<Subject 1> is the courier in <Picture 1>, preserving her face, short dark hair, and green raincoat while replacing the original background with a wooden doorway.
<Audio 1> is the voice-timbre reference for <Subject 1> (S1); do not copy its words or waveform.

summary:
[reference generation + audio reference] <Subject 1> delivers an envelope at a wooden doorway in two shots, using the voice timbre of <Audio 1> for one new line of Chinese dialogue.

retention_analysis:
<Subject 1> (appears in [Shot 1], [Shot 2]): fully_preserved - her referenced face, short hair, and green raincoat remain consistent.
<Audio 1>: reference - use its vocal timbre and measured pace without copying the source signal or spoken content.

detailed_description:
The target video is live-action with soft afternoon window light and restrained colors.
[Shot 1] A medium shot frames <Subject 1>, the short-haired courier in the green raincoat from <Picture 1>, standing to the left of a wooden doorway. She holds a dry cream envelope in her right hand. The camera pushes in slowly with small amplitude as she raises the envelope toward the recipient inside the door. <Subject 1> (S1), using the low, clear timbre and measured pace referenced from <Audio 1>, says: <d>[Chinese] 这封信，请你亲手打开。</d> Her lips close after the final word. She keeps her gaze on the recipient and holds her hand steady.
[Shot 2] At 00:06.000, the camera cuts to a closer view of the handover, with the same green sleeve visible at the left edge. The recipient's hand grips the envelope from the opposite side before <Subject 1> releases it. The recipient draws it into the doorway while the courier lowers her empty hand. Both hands stop moving before the ten-second endpoint. There are no subtitles or other visible words.

overall_soundscape:
Low street ambience and a light breeze continue beneath the dialogue. The raincoat and paper rustle during the handover.

non_diegetic_music:
N/A
```

未验证标签映射的 GuGu 工作流改用用户语言说明“图片 1 只参考人物；音频 1 只参考音色，不复制台词”，并通过实际参考参数传入文件。不要把本例的英文标签直接当作当前适配器已认识的素材编号。
