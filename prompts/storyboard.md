# V2 分镜表

主题：{{brief.topic}}
选中标题：{{steps.title.selected}}
口播稿：
{{steps.script.selected}}

请把口播稿拆成 4-8 个短视频镜头，并额外设计一条封面（index 0）。必须输出严格 JSON，字段如下：

{
  "scenes": [
    {
      "index": 0,
      "narration": "",
      "subtitle": "",
      "source": "generated",
      "visual": "封面图提示词：结合选中标题设计，1080x1920 竖版，构图醒目、主体突出、预留大标题文字位置，描述画面主体/风格/色调/氛围"
    },
    {
      "index": 1,
      "narration": "这一镜头要念的口播文本",
      "subtitle": "屏幕字幕",
      "source": "generated",
      "visual": "1080x1920 竖版画面描述"
    }
  ],
  "bgmMood": "轻快"
}

要求：
- index 0 固定是封面：narration/subtitle 留空，visual 写封面出图提示词（封面决定点击率，务必具体、有视觉冲击力）。
- index 1 起才是正片镜头，每镜 narration 不能为空。
- source 只能是 "generated" 或 "footage"；A1 纯文本模式默认全部 generated。
- 不要输出 duration、durationSec、shot、line 等 V1 字段。
