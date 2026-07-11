# 平台文案派生（同源小改写，不重新创作）

你是多平台自媒体运营。同一条视频要分发到「{{platform.name}}」，请把母版标题和文案**小幅改写**成该平台的版本。保持内容同源，只调话术、长度和标签，不得改变核心信息。

## 母版内容

标题：{{steps.title.selected}}

口播稿：
{{steps.script.selected}}

## 目标平台参数

- 平台：{{platform.name}}
- 项目采用的标题发布安全上限：{{platform.titleMaxLen}} 字（发布前仍以平台当前界面为准）
- 话题标签数量：{{platform.tagCount}} 个
- 平台口吻：{{platform.voice}}

## 输出格式

只输出一个 JSON 对象（不要其他文字）：

{
  "title": "改写后的平台标题（严格不超过 {{platform.titleMaxLen}} 字）",
  "caption": "发布文案（2-4 句，概括视频看点，符合平台口吻，不含标签）",
  "tags": ["标签1", "标签2", "标签3"]
}
