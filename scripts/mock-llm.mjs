#!/usr/bin/env node
/**
 * 演示用本地 Mock LLM：读取提示词文件，根据提示词中的输出要求返回固定格式的演示内容。
 * 用途：让用户在未配置任何真实 CLI / API 引擎时也能完整跑通流程。
 * 用法：node mock-llm.mjs <prompt_file>
 */
import fs from "node:fs";

const promptFile = process.argv[2];
const prompt = promptFile ? fs.readFileSync(promptFile, "utf-8") : "";

const topicMatch = prompt.match(/主题[^:：\n]*[:：]\s*(.+)/);
const topic = (topicMatch?.[1] ?? "今日选题").trim().slice(0, 30);

if (prompt.includes("JSON 数组") && prompt.includes("候选标题")) {
  console.log(
    JSON.stringify(
      [
        `${topic}，看完这篇就够了`,
        `普通人也能上手的${topic}指南`,
        `我试了 30 天${topic}，结果出乎意料`,
        `关于${topic}，90%的人都做错了这一步`,
        `${topic}避坑清单，建议收藏`,
      ],
      null,
      2
    )
  );
} else if (prompt.includes("评分") && prompt.includes("verdict")) {
  // 含 FORCE_REVISE 标记时输出不通过结论（用于测试全自动评审重生成闭环）
  const forceRevise = prompt.includes("FORCE_REVISE");
  console.log(
    JSON.stringify(
      [
        {
          target: "title",
          scores: { hook: forceRevise ? 5 : 8, platform_fit: 8, clarity: 9, compliance: 10, seo: 7 },
          total: forceRevise ? 68 : 84,
          verdict: forceRevise ? "revise" : "pass",
          issues: forceRevise ? ["标题钩子不够强"] : [],
          suggestions: ["可在标题中加入更具体的数字增强可信度"],
        },
        {
          target: "script",
          scores: { hook: forceRevise ? 5 : 7, platform_fit: 8, clarity: 8, compliance: 10, seo: 7 },
          total: forceRevise ? 66 : 80,
          verdict: forceRevise ? "revise" : "pass",
          issues: ["开头铺垫略长，建议压缩到 1 句话内"],
          suggestions: ["第一段直接给结论，再展开细节"],
        },
      ],
      null,
      2
    )
  );
} else if (prompt.includes("平台文案派生") || (prompt.includes("titleMaxLen") && prompt.includes("平台"))) {
  console.log(
    JSON.stringify(
      {
        title: `${topic}三步搞定`.slice(0, 20),
        caption: `一条视频讲清楚${topic}的核心方法，照着做就能出第一条成片。`,
        tags: [topic.slice(0, 8), "干货分享", "教程"],
      },
      null,
      2
    )
  );
} else if (prompt.includes("V2 分镜表") || prompt.includes("分镜表")) {
  console.log(
    JSON.stringify(
      {
        scenes: [
          {
            index: 0,
            narration: "",
            subtitle: "",
            source: "generated",
            visual: `短视频封面：主题「${topic}」，1080x1920 竖版，主体居中构图醒目，高对比配色，预留大标题文字位置，现代扁平风`
          },
          {
            index: 1,
            narration: `你还在为${topic}发愁吗？`,
            subtitle: `你还在为${topic}发愁吗？`,
            source: "generated",
            visual: "1080x1920 竖版，近景特写，主角面向镜头，背景简洁，有短视频开场冲击力"
          },
          {
            index: 2,
            narration: "今天用 3 步讲清楚核心方法。",
            subtitle: "3 步讲清楚",
            source: "generated",
            visual: "1080x1920 竖版，手机屏幕与要点卡片组合，信息清楚，现代内容创作工作台氛围"
          },
          {
            index: 3,
            narration: "第一步，找准切入点；第二步，搭好结构；第三步，持续迭代。",
            subtitle: "找切入点 / 搭结构 / 持续迭代",
            source: "generated",
            visual: "1080x1920 竖版，三张要点字卡依次排列，留白充足，视觉层次清晰"
          },
          {
            index: 4,
            narration: "把这三步跑顺，你就能稳定做出第一条可发布的视频。",
            subtitle: "稳定做出第一条视频",
            source: "generated",
            visual: "1080x1920 竖版，完成的视频预览在手机中播放，旁边是勾选完成的流程清单"
          },
        ],
        bgmMood: "轻快节奏，副歌不抢人声",
      },
      null,
      2
    )
  );
} else if (prompt.includes("SRT 字幕")) {
  console.log(
    [
      "1",
      "00:00:00,000 --> 00:00:04,000",
      `${topic}（演示字幕第一句）`,
      "",
      "2",
      "00:00:04,300 --> 00:00:08,300",
      "演示字幕第二句",
      "",
      "3",
      "00:00:08,600 --> 00:00:12,600",
      "演示字幕第三句",
    ].join("\n")
  );
} else if (prompt.includes("分镜拆解") || prompt.includes("AI 视频生成")) {
  const horiz = prompt.includes("[HORIZONTAL 16:9]");
  const tag = horiz ? "[HORIZONTAL 16:9]" : "[VERTICAL 9:16]";
  const suf = horiz ? "Landscape orientation, horizontal composition, 16:9 format." : "Portrait orientation, vertical composition, 9:16 format.";
  console.log(
    [
      "【镜头 1】对应歌词：「风又吹过老屋的屋檐」",
      `${tag} Slow dolly-in toward a Chinese child standing by an old red-brick wall, wind moving the leaves, warm summer afternoon light, nostalgic tones, cinematic, ultra high definition. ${suf}`,
      "",
      "【镜头 2】对应歌词：「夕阳落在红砖上面」",
      `${tag} Crane-up over a red-brick wall as long shadows stretch at golden hour, dust drifting in warm light, emotional, film grain, ultra high definition. ${suf}`,
      "",
      "【镜头 3】对应歌词：「当夜色落满空院子」",
      `${tag} Handheld push through a quiet empty Chinese courtyard at night toward a single warm window, deep blue tones, lonely mood, cinematic, ultra high definition. ${suf}`,
    ].join("\n")
  );
} else if (prompt.includes("画面化拆解") || prompt.includes("不限制图片数量") || prompt.includes("信息图")) {
  const horiz = prompt.includes("[HORIZONTAL 16:9]");
  const tag = horiz ? "[HORIZONTAL 16:9]" : "[VERTICAL 9:16]";
  const suf = horiz ? "Landscape orientation, horizontal composition, 16:9 format." : "Portrait orientation, vertical composition, 9:16 format.";
  const cnt = Math.max(1, parseInt((prompt.match(/生成\s*(\d+)\s*张/) || [])[1] || "3", 10));
  const lines = [];
  for (let i = 1; i <= cnt; i++) {
    lines.push(`【画面 ${i}】要点：「演示要点 ${i}」`);
    lines.push(`${tag} Clean infographic poster about ${topic}, point ${i}, large bold Chinese headline area, modern flat design, consistent color scheme, ultra high definition, masterpiece. ${suf}`);
    lines.push("");
  }
  console.log(lines.join("\n").trim());
} else if (prompt.includes("作词") || prompt.includes("创作一首完整的中文歌曲")) {
  console.log(
    [
      `标题《${topic}》`,
      "",
      "【Verse 1】",
      "风又吹过老屋的屋檐",
      "光阴在砖墙上慢慢转圈",
      "",
      "【Chorus】",
      "不是谁把时针挂起",
      "是岁月在替我们记忆",
      "",
      "【Final Chorus】",
      "当风再次吹过老屋",
      "我知道它还在那里",
    ].join("\n")
  );
} else if (prompt.includes("@[TOC]") || prompt.includes("CSDN")) {
  console.log(
    [
      `@[TOC](${topic} 实战详解)`,
      "",
      `# ${topic} 实战详解`,
      "",
      `工作中遇到「${topic}」相关问题，记不住、搞不清？本文带你从原理到实战一次讲透。`,
      "",
      "## 一、核心概念",
      "",
      `先理解「${topic}」要解决的问题：它的本质是在保证正确性的前提下提升效率。`,
      "",
      "## 二、快速上手",
      "",
      "```bash",
      "# 演示命令（注释用中文，便于理解）",
      "echo '第一步：初始化环境'",
      "echo '第二步：执行核心逻辑'",
      "```",
      "",
      "## 三、流程图解",
      "",
      "```mermaid",
      "graph LR",
      "A[输入] --> B[处理] --> C[输出]",
      "```",
      "",
      "## 四、关键公式",
      "",
      "当数据规模为 $n$ 时，时间复杂度约为 $O(n \\log n)$。",
      "",
      "## 总结",
      "",
      "本文梳理了核心概念、上手步骤与注意事项，建议收藏备用。",
      "",
      "> **🔥 原创不易，如有收获请点个赞！**",
      ">",
      "> **👨‍💻 关注我，带你深入浅出学技术！**",
      ">",
      "> **💬 遇到问题？欢迎在评论区留言交流！**",
      "",
      "【摘要】",
      `本文围绕「${topic}」展开，从核心概念、快速上手、流程图解到关键公式逐层讲解，配有示例代码与实战建议，适合有一定基础的开发者收藏查阅。`,
      "",
      "【标签】",
      `${topic}, 实战教程, 后端开发`,
    ].join("\n")
  );
} else {
  console.log(
    [
      `（演示内容）关于「${topic}」：`,
      "",
      "开头钩子：用一个反常识结论抓住注意力。",
      "",
      "主体部分分三段展开：第一段给出背景与痛点，让读者产生共鸣；",
      "第二段给出可落地的方法与步骤，每一步配一个具体例子；",
      "第三段总结要点，并给出下一步行动建议。",
      "",
      "结尾引导互动：你在这件事上踩过什么坑？评论区聊聊。",
    ].join("\n")
  );
}
