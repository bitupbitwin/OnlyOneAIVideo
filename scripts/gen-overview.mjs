// 渲染「全局产品总览」信息图（SVG→PNG via sharp）
import sharp from "../node_modules/.pnpm/node_modules/sharp/lib/index.js";

const C = { bg: "#0e1117", panel: "#1a1f29", panel2: "#222837", border: "#2e3648", text: "#e6e9f0", muted: "#8b93a7", accent: "#4f8cff", green: "#3ecf8e", yellow: "#f5b73d", pink: "#f06565", purple: "#a779ff", cyan: "#39d3ff" };
const W = 1500;
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const r = [];
const P = (s) => r.push(s);

const platforms = [
  { name: "抖音", color: "#161823c0", accent: "#fe2c55", modes: ["视频", "长文", "图集"] },
  { name: "小红书", color: "#2a1418", accent: "#ff2442", modes: ["图文笔记", "视频笔记"] },
  { name: "哔哩哔哩", color: "#14222a", accent: "#00aeec", modes: ["短视频", "长视频", "图文"] },
  { name: "微信公众号", color: "#13231a", accent: "#07c160", modes: ["文章"] },
  { name: "微信视频号", color: "#13231a", accent: "#fa9d3b", modes: ["视频"] },
  { name: "CSDN", color: "#1a1d2a", accent: "#fc5531", modes: ["技术博客"] },
  { name: "MV 歌词可视化", color: "#1d1626", accent: "#a779ff", modes: ["纯图片/纯视频 · 9:16/16:9"] },
];

let y = 0;
// 标题
P(`<rect width="${W}" height="78" fill="${C.panel}"/>`);
P(`<text x="40" y="38" font-size="26" font-weight="800" fill="${C.text}">📦 自媒体内容工作台 · 全局总览</text>`);
P(`<text x="40" y="62" font-size="14" fill="${C.muted}">7 大平台 · 12 条制作流程 · 全自动生产 + 人工接管 · 标题/内容/封面/视频/字幕一站式产出</text>`);
y = 78;

// 区块1：平台与流程
y += 34;
P(`<text x="40" y="${y}" font-size="17" font-weight="700" fill="${C.accent}">① 覆盖平台与流程（12 条）</text>`);
y += 16;
const cols = 4, cw = (W - 80 - (cols - 1) * 16) / cols;
let cx = 40, cy = y, rowH = 0;
platforms.forEach((p, i) => {
  const col = i % cols;
  if (col === 0 && i > 0) { cy += rowH + 16; rowH = 0; }
  cx = 40 + col * (cw + 16);
  const h = 92;
  rowH = Math.max(rowH, h);
  P(`<rect x="${cx}" y="${cy}" width="${cw}" height="${h}" rx="10" fill="${C.panel}" stroke="${C.border}"/>`);
  P(`<rect x="${cx}" y="${cy}" width="5" height="${h}" rx="2" fill="${p.accent}"/>`);
  P(`<text x="${cx + 18}" y="${cy + 28}" font-size="16" font-weight="700" fill="${C.text}">${esc(p.name)}</text>`);
  p.modes.forEach((m, j) => {
    const chy = cy + 44 + Math.floor(j / 2) * 24;
    const chx = cx + 18 + (j % 2) * ((cw - 36) / 2);
    P(`<rect x="${chx}" y="${chy}" width="${Math.min(esc(m).length * 13 + 16, (cw - 40) / 2 + 30)}" height="20" rx="10" fill="${C.panel2}"/>`);
    P(`<text x="${chx + 10}" y="${chy + 14}" font-size="11.5" fill="${C.muted}">${esc(m)}</text>`);
  });
});
y = cy + rowH + 26;

// 区块2：标准生产流水线
y += 16;
P(`<text x="40" y="${y}" font-size="17" font-weight="700" fill="${C.green}">② 标准生产流水线（DAG 自动并行）</text>`);
y += 22;
const flow = [
  { t: "选题录入", s: "主题/要求/素材(文字·图·视频)", c: C.muted },
  { t: "标题 ×5", s: "候选择优·人工卡点", c: C.accent },
  { t: "内容", s: "正文/口播/歌词/博文", c: C.accent },
  { t: "封面 ×3", s: "出图API·原生比例", c: C.yellow },
  { t: "视频/图", s: "剪映草稿·批量出图", c: C.yellow },
  { t: "评审打分", s: "多维+极限词预检", c: C.purple },
  { t: "导出 ZIP", s: "→ 手动发布", c: C.green },
];
const fw = (W - 80 - (flow.length - 1) * 38) / flow.length;
flow.forEach((f, i) => {
  const x = 40 + i * (fw + 38);
  P(`<rect x="${x}" y="${y}" width="${fw}" height="68" rx="10" fill="${C.panel}" stroke="${f.c}" stroke-opacity="0.5"/>`);
  P(`<text x="${x + fw / 2}" y="${y + 28}" font-size="14.5" font-weight="700" fill="${f.c}" text-anchor="middle">${esc(f.t)}</text>`);
  P(`<text x="${x + fw / 2}" y="${y + 50}" font-size="10.5" fill="${C.muted}" text-anchor="middle">${esc(f.s)}</text>`);
  if (i < flow.length - 1) P(`<text x="${x + fw + 11}" y="${y + 40}" font-size="20" fill="${C.border}">→</text>`);
});
y += 68 + 14;
P(`<text x="40" y="${y}" font-size="12" fill="${C.muted}">✍️ 任意步骤可「人工接管」：导出提示词→外部模型生成→粘贴/上传回填　·　⚡ 全自动模式：免卡点+评审不过自动重生成</text>`);
y += 24;

// 区块3：引擎适配层
y += 18;
P(`<text x="40" y="${y}" font-size="17" font-weight="700" fill="${C.cyan}">③ 引擎适配层（每步独立选择·自由混搭·并行）</text>`);
y += 20;
const engines = [
  { t: "CLI 引擎", s: "Claude/Gemini/Codex/Grok/Kimi", d: "走订阅·包月", c: C.accent },
  { t: "文本 API", s: "DeepSeek/Grok/Kimi", d: "评审·看图(视觉)", c: C.purple },
  { t: "出图 API", s: "即梦/Seedream·Grok叠字", d: "封面·MV批量图", c: C.yellow },
  { t: "网页端", s: "ChatGPT/Claude/Kimi/豆包", d: "Playwright登录态", c: C.green },
];
const ew = (W - 80 - 3 * 16) / 4;
engines.forEach((e, i) => {
  const x = 40 + i * (ew + 16);
  P(`<rect x="${x}" y="${y}" width="${ew}" height="74" rx="10" fill="${C.panel}" stroke="${C.border}"/>`);
  P(`<text x="${x + 16}" y="${y + 26}" font-size="15" font-weight="700" fill="${e.c}">${esc(e.t)}</text>`);
  P(`<text x="${x + 16}" y="${y + 47}" font-size="11.5" fill="${C.text}">${esc(e.s)}</text>`);
  P(`<text x="${x + 16}" y="${y + 64}" font-size="11" fill="${C.muted}">${esc(e.d)}</text>`);
});
y += 74 + 22;

// 区块4：核心能力
P(`<text x="40" y="${y}" font-size="17" font-weight="700" fill="${C.pink}">④ 核心能力</text>`);
y += 18;
const caps = ["全自动生产", "多版本择优", "人工接管回填", "素材上传(文字/图/视频)", "封面原生比例出图", "MV批量出图+单张重抽", "评审打分+合规预检", "剪映草稿+SRT字幕", "docx文档导出", ".env一键配引擎", "本地运行·数据不出本机", "Electron桌面壳"];
let kx = 40, ky = y + 4;
caps.forEach((c) => {
  const w = esc(c).length * 13 + 28;
  if (kx + w > W - 40) { kx = 40; ky += 34; }
  P(`<rect x="${kx}" y="${ky}" width="${w}" height="26" rx="13" fill="${C.panel2}" stroke="${C.border}"/>`);
  P(`<text x="${kx + 14}" y="${ky + 17}" font-size="12.5" fill="${C.text}">✓ ${esc(c)}</text>`);
  kx += w + 10;
});
y = ky + 26 + 24;

const H = y;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family="WenQuanYi Zen Hei, sans-serif"><rect width="${W}" height="${H}" fill="${C.bg}"/>${r.join("\n")}</svg>`;
await sharp(Buffer.from(svg)).png().toFile("/home/user/Auto-media-product/overview.png");
console.log("生成完成:", W, "x", H);
