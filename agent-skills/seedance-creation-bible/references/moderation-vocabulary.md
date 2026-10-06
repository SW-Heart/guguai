# Seedance 2.0 / 2.5 审核词句排查

核对日期：2026-10-06。用于 GuGu 的提示词优化和自动优化。必须读取同目录 [具体中文与英文候选词表](moderation-cues.json)。候选词集中保存在 JSON，不另维护重复列表。

## 证据与版本

未在本次查阅的官方资料中找到逐词、完整且保证触发的 Seedance 2.0 或 2.5 禁词表。不能把 Google 的审核类别或支持码当成 Seedance 规则。

词表整合下列五个 GitHub 来源，核对于上述日期。完整地址、版本范围和证据等级保存在 JSON 的 `sources`，每组通过 `sourceIds` 追溯。源作者的实测声明仅记为作者报告，未独立复现；2.0 即梦记录不能视为 2.5 API 或 GuGu 渠道的实测结论。因此两版均可读取来辅助排查，2.5 的适用性标为未验证。

| 来源 | 纳入内容 | 证据限制 |
| --- | --- | --- |
| [Emily2040](https://github.com/Emily2040/seedance-2.0/blob/main/data/moderation-cues.json) | 武器、伤害、犯罪、机构文书、未成年人、烟酒、恐怖与符号的中英文候选词 | [作者记录](https://github.com/Emily2040/seedance-2.0/blob/main/references/moderation-prescreen.md)只有两份示例被拒，未逐词验证 |
| [MapleShaw](https://github.com/MapleShaw/seedance2.0-prompt-skill/blob/main/references/image-to-prompt.md) | 品牌、作品、导演、音乐、场所、服务角色、室内氛围和地域相关候选词 | case-12/13/17 的特定情境报告及经验扩展；爵士等普通词不能推广为独立必拦项 |
| [ningning-happy](https://github.com/ningning-happy/seedance2.0-prompt-skill/blob/master/SKILL.md) | 引擎、制作商标、版权和敏感类别 | 没有逐词审核结果；同一文件既禁引擎词又在模板推荐使用，故降为弱证据。其指向的独立中文词库文件本次未取到，不声称导入该文件 |
| [kuronzzhan-droid](https://github.com/kuronzzhan-droid/seedance-pov-series-skill/blob/main/references/seedance-constraints.md) | 洗浴、未着装、身体接触的场景检查 | 个人总结，没有可复现词级结论；不采用反复提交二分法或遮挡式规避建议 |
| [liangdabiao](https://github.com/liangdabiao/Seedance2-Storyboard-Generator/blob/main/README.md) | 江湖人士等武侠称谓的可能项 | 作者只称可能失败，没有逐词结果 |

这里只整合本次实际查到并读取的相关内容，不声称覆盖整个 GitHub。通用政治/色情大词库不自动套用到 Seedance；重复来源、Fork 及重复词不增加证据强度。以后纳入新来源时补充 `sources` 和候选组，不改成无来源的巨大拼接词表。

表中包含刀、血、绑架等候选项，也保留离婚、律师、合同、制服等容易被忽略的短剧词句。后者的证据较弱，不允许默认删掉。来源的“命中即阻止交付”“三个中风险等于高风险”未作为 GuGu 的判断规则采用，也不采用将人物改为成年人、将武器藏到画外、删除音乐或品牌等未经授权的内容替换。

## 官方信息优先

- [Seedance 2.0 官方指南](https://docs.volcengine.com/docs/ark/seedance-2-0-prompt-guide?lang=zh&redirect=1)指出人物形象漂移可能撞脸明星并被审核拦截。它也提供 Logo 参考示例，不能将“商标/logo”一律视为禁词。
- [Seedance 2.5 官方指南](https://docs.volcengine.com/docs/ark/seedance-2-5-prompt-guide?lang=zh)提供角色、Logo 与素材指代写法。普通角色称谓、参考标签不是可任意删除的审核词。
- [官方肖像素材说明](https://docs.volcengine.com/docs/ark/seedance-portrait-asset-guide?lang=zh)对两版的真人参考素材提供受支持的处理途径。此类输入限制不是写一句“已授权”就能解决；不自动改变参考人物。
- [火山方舟错误码](https://docs.volcengine.com/docs/82379/1299023)区分输入文字、输入素材、生成结果与版权问题。优先按实际返回类别处理；通用提示“请修改提示词后重试”不能证明具体词被拒。

## 每轮实际使用

1. 阅读词表和原描述。自动优化收到的 `candidateCueMatches` 带有词、原文位置、上下文和类别；这些只是定位线索。普通 agent 使用 `skills_read` 读 JSON 后自行检查原文。
2. 对每个命中结合前后句、否定词、引用、人物年龄、动作对象和镜头判断。单字容易误匹配：刀工不一定涉及攻击，血橙不涉及血腥，鬼斧神工不涉及恐怖。学生、医院、合同、商标的正常描述保留。没有命中也不能断定安全。
3. 只对允许内容中确有歧义的词句进行等价澄清。例如已有颜色含义的“血红色灯光”可以明确为“深红色灯光”；明确的受伤流血不能换成红色颜料。不是批量同义替换。
4. 台词、引号内逐字文字、素材标签与已确认事实保持。无法保留原意、错误只指向素材/参数、或没有可靠改动时返回空 replacements；需要改剧情的方案留给用户选择。
5. 第二次必须在再次生成后出现匹配报错才启动。结合第一轮的命中、替换和新反馈检查，不能反复换词试探、谐音、拆字或换语言掩盖同一内容。两次后停止自动优化。

## 效果结论

源码与逻辑测试可以证明词表被完整加载、命中位置正确、两轮都传给优化模型；不能证明生成平台接受改稿。只有对应模型、渠道和原稿/改稿的实际返回能支持通过率结论，不把本地扫描通过写成审核通过。

## 词表来源许可

JSON 中中文候选项与部分英文项改编自上述 MIT 项目；GuGu 增加上下文边界，不采用其规避式替代建议。保留原许可：

```text
MIT License

Copyright (c) 2026 Iamemily2050 (@iamemily2050)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
