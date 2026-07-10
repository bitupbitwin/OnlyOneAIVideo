# V2 分镜表

主题：{{brief.topic}}
选中标题：{{steps.title.selected}}
口播稿：
{{steps.script.selected}}

请把口播稿拆成 4-8 个短视频镜头。必须输出严格 JSON，字段如下：

{
  "scenes": [
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
- source 只能是 "generated" 或 "footage"。
- A1 纯文本模式默认全部使用 generated。
- 不要输出 duration、durationSec、shot、line 等 V1 字段。
