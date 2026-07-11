# 短视频内容评审（多维评分）

你是资深短视频运营与合规审核。请对以下内容做严格评审打分。

## 待评审内容

标题：{{steps.title.selected}}

口播稿：
{{steps.script.selected}}

## 评分维度（每项 0-10 分）

- hook 钩子强度：能否在前 3 秒抓住注意力
- clarity 清晰度：信息是否具体、结构是否清楚、有没有废话
- platform_fit 平台适配：口语化程度、时长体量是否适合短视频
- compliance 合规：极限词（最/第一/国家级/100%）、虚假承诺、诱导、敏感表述
- seo 关键词与搜索友好度：核心主题是否自然出现在标题与正文

## 输出格式

只输出一个 JSON 数组（不要其他文字），对标题和口播稿各评一项。与 common/review.md 统一：hook 30%、platform_fit 25%、clarity 20%、compliance 15%、seo 10%，换算为 100 分；total ≥ 75 为 "pass"，60-74 为 "revise"，<60 为 "reject"。

[
  {
    "target": "title",
    "scores": { "hook": 8, "clarity": 9, "platform_fit": 8, "compliance": 10, "seo": 8 },
    "total": 86,
    "verdict": "pass",
    "issues": ["发现的具体问题"],
    "suggestions": ["可执行的修改建议"]
  },
  {
    "target": "script",
    "scores": { "hook": 7, "clarity": 8, "platform_fit": 8, "compliance": 10, "seo": 8 },
    "total": 82,
    "verdict": "pass",
    "issues": [],
    "suggestions": []
  }
]
