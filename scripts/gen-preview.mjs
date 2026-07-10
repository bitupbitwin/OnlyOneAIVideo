// 用真实跑出的 CSDN 流水线数据，渲染一张还原「流程工作台」界面的预览图（SVG → PNG via sharp）
import fs from "node:fs";
import path from "node:path";
import sharp from "../node_modules/.pnpm/node_modules/sharp/lib/index.js";

const d = JSON.parse(fs.readFileSync("/tmp/preview-data.json", "utf-8"));
const C = {
  bg: "#11141a", panel: "#1a1f29", panel2: "#222837", border: "#2e3648",
  text: "#e6e9f0", muted: "#8b93a7", accent: "#4f8cff", green: "#3ecf8e",
  yellow: "#f5b73d", red: "#f06565",
};
const W = 1360;
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const clip = (s, n) => { s = String(s ?? "").replace(/\n/g, " "); return s.length > n ? s.slice(0, n - 1) + "…" : s; };

const step = (id) => d.steps.find((s) => s.def_id === id);
const titleStep = step("title");
const contentStep = step("content");
const coverStep = step("cover");
const titles = titleStep.artifacts.map((a) => ({ t: a.content, sel: !!a.selected }));
const content = (contentStep.artifacts.find((a) => a.selected)?.content || "").split("\n").filter((l) => l.trim());
const coverOriginals = coverStep.artifacts.filter((a) => a.label === "原图" || /竖|封面|2K|16:9|1:1|3:4/.test(a.label || ""));
const reviews = d.reviews || [];

// 封面缩略图：取派生尺寸里前 3 张，转 base64 内嵌
const coverThumbs = [];
for (const a of coverStep.artifacts.filter((a) => a.label === "原图").slice(0, 3)) {
  if (a.file_path && fs.existsSync(a.file_path)) {
    const buf = fs.readFileSync(a.file_path);
    coverThumbs.push("data:image/png;base64," + buf.toString("base64"));
  }
}

let y = 0;
const rows = [];
const push = (s) => rows.push(s);

// ===== 顶栏 =====
push(`<rect x="0" y="0" width="${W}" height="52" fill="${C.panel}"/>`);
push(`<line x1="0" y1="52" x2="${W}" y2="52" stroke="${C.border}"/>`);
push(`<text x="24" y="33" font-size="17" font-weight="700" fill="${C.text}">📦 自媒体内容工作台</text>`);
push(`<text x="280" y="33" font-size="14" fill="${C.muted}">项目</text>`);
push(`<text x="340" y="33" font-size="14" fill="${C.muted}">引擎管理</text>`);
push(`<text x="430" y="33" font-size="14" fill="${C.muted}">模板管理</text>`);
y = 52;

// ===== 标题栏 =====
y += 30;
push(`<text x="24" y="${y}" font-size="20" font-weight="700" fill="${C.text}">CSDN · 技术博客</text>`);
push(`<rect x="250" y="${y - 18}" width="68" height="24" rx="12" fill="rgba(62,207,142,.15)"/>`);
push(`<text x="284" y="${y - 1}" font-size="13" fill="${C.green}" text-anchor="middle">已完成</text>`);
// 按钮
const btn = (x, w, fill, stroke, tc, label) => {
  push(`<rect x="${x}" y="${y - 19}" width="${w}" height="28" rx="6" fill="${fill}" ${stroke ? `stroke="${stroke}"` : ""}/>`);
  push(`<text x="${x + w / 2}" y="${y}" font-size="13" fill="${tc}" text-anchor="middle">${label}</text>`);
};
btn(W - 360, 110, C.panel2, C.border, C.text, "📦 导出产物包");
btn(W - 240, 130, C.panel2, C.border, C.text, "▶ 运行（人工挑选）");
btn(W - 100, 76, C.accent, null, "#fff", "⚡ 全自动");
y += 22;

// ===== 卡片绘制工具 =====
const card = (h, accent) => {
  push(`<rect x="24" y="${y}" width="${W - 48}" height="${h}" rx="10" fill="${C.panel}" stroke="${accent || C.border}"/>`);
};
const stepHeader = (title, statusLabel, statusColor, statusBg, provider) => {
  push(`<text x="44" y="${y + 28}" font-size="15" font-weight="600" fill="${C.text}">${esc(title)}</text>`);
  const bw = 64;
  push(`<rect x="${44 + title.length * 15 + 16}" y="${y + 13}" width="${bw}" height="22" rx="11" fill="${statusBg}"/>`);
  push(`<text x="${44 + title.length * 15 + 16 + bw / 2}" y="${y + 28}" font-size="12" fill="${statusColor}" text-anchor="middle">${statusLabel}</text>`);
  // 引擎下拉（右侧）
  push(`<rect x="${W - 310}" y="${y + 12}" width="240" height="26" rx="6" fill="${C.panel2}" stroke="${C.border}"/>`);
  push(`<text x="${W - 298}" y="${y + 29}" font-size="12" fill="${C.muted}">${esc(provider)}</text>`);
  push(`<text x="${W - 86}" y="${y + 29}" font-size="11" fill="${C.muted}">▼</text>`);
};

// ----- 步骤1：标题生成 -----
const h1 = 56 + titles.length * 30 + 8;
card(h1, C.border);
stepHeader("标题生成", "已完成", C.green, "rgba(62,207,142,.15)", "演示文本引擎（Mock）");
push(`<text x="44" y="${y + 52}" font-size="12" fill="${C.muted}">产物（v1，点击可设为选中）— 共 ${titles.length} 个候选，按推荐度排序：</text>`);
let ty = y + 56;
titles.forEach((it) => {
  const sel = it.sel;
  push(`<rect x="44" y="${ty}" width="${W - 136}" height="26" rx="6" fill="${C.panel2}" stroke="${sel ? C.green : C.border}"/>`);
  push(`<text x="56" y="${ty + 18}" font-size="13" fill="${C.text}">${esc(clip(it.t, 60))}</text>`);
  if (sel) push(`<text x="${W - 110}" y="${ty + 18}" font-size="12" fill="${C.green}">✓ 已选</text>`);
  ty += 30;
});
y += h1 + 14;

// ----- 步骤2：博文生成 -----
const contentPreview = content.slice(0, 12);
const h2 = 64 + contentPreview.length * 19 + 8;
card(h2, C.border);
stepHeader("博文生成（Markdown+摘要+标签）", "已完成", C.green, "rgba(62,207,142,.15)", "演示文本引擎（Mock）");
push(`<rect x="44" y="${y + 48}" width="${W - 92}" height="${h2 - 60}" rx="8" fill="#0d1016"/>`);
let cy = y + 66;
contentPreview.forEach((line) => {
  const isH = /^#/.test(line);
  const isCode = /^```|^echo|^graph|^#\s|^A\[|git /.test(line);
  const col = isH ? C.accent : /原创不易|关注我|评论区/.test(line) ? C.yellow : /【摘要】|【标签】/.test(line) ? C.green : "#c8cedb";
  push(`<text x="56" y="${cy}" font-size="12.5" font-family="monospace" fill="${col}">${esc(clip(line, 95))}</text>`);
  cy += 19;
});
y += h2 + 14;

// ----- 步骤3：封面生成 -----
const h3 = 150;
card(h3, C.border);
stepHeader("封面生成", "已完成", C.green, "rgba(62,207,142,.15)", "演示出图引擎（3候选）");
push(`<text x="44" y="${y + 52}" font-size="12" fill="${C.muted}">3 个候选版本（点选切换）｜ 自动派生：CSDN 封面 16:9 · 2K 高清 2048×1152</text>`);
const tw = 170, th = 72;
coverThumbs.forEach((src, i) => {
  const x = 44 + i * (tw + 16);
  push(`<clipPath id="cc${i}"><rect x="${x}" y="${y + 62}" width="${tw}" height="${th}" rx="8"/></clipPath>`);
  push(`<image x="${x}" y="${y + 62}" width="${tw}" height="${th}" href="${src}" preserveAspectRatio="xMidYMid slice" clip-path="url(#cc${i})"/>`);
  push(`<rect x="${x}" y="${y + 62}" width="${tw}" height="${th}" rx="8" fill="none" stroke="${i === 0 ? C.green : C.border}"/>`);
  // 标题文字叠加示意
  push(`<text x="${x + tw / 2}" y="${y + 104}" font-size="13" font-weight="700" fill="#fff" text-anchor="middle" style="paint-order:stroke;stroke:#000;stroke-width:3px">${esc(clip(titles.find(t=>t.sel)?.t, 10))}</text>`);
  if (i === 0) push(`<text x="${x + 8}" y="${y + 78}" font-size="11" fill="${C.green}">✓ 已选</text>`);
});
y += h3 + 14;

// ----- 步骤4：评审评分 -----
const h4 = 60 + reviews.length * 46;
card(h4, C.border);
stepHeader("评审评分", "已完成", C.green, "rgba(62,207,142,.15)", "演示文本引擎（Mock）");
let ry = y + 50;
reviews.slice(0, 3).forEach((r) => {
  const pass = r.verdict === "pass";
  push(`<text x="44" y="${ry + 14}" font-size="13" font-weight="600" fill="${C.text}">${r.target === "title" ? "标题" : r.target === "content" ? "内容" : r.target}评审</text>`);
  push(`<rect x="120" y="${ry}" width="86" height="20" rx="10" fill="${pass ? "rgba(62,207,142,.15)" : "rgba(240,101,101,.15)"}"/>`);
  push(`<text x="163" y="${ry + 14}" font-size="11" fill="${pass ? C.green : C.red}" text-anchor="middle">${r.verdict} ${r.total || ""}分</text>`);
  let sx = 230;
  Object.entries(r.scores || {}).forEach(([k, v]) => {
    push(`<rect x="${sx}" y="${ry}" width="92" height="20" rx="5" fill="${C.panel2}"/>`);
    push(`<text x="${sx + 8}" y="${ry + 14}" font-size="11" fill="${C.muted}">${k}: ${v}</text>`);
    sx += 100;
  });
  ry += 46;
});
y += h4 + 14;

// ----- 注意事项 -----
const notes = (d.notes || []).slice(0, 4);
const h5 = 50 + notes.length * 24;
card(h5, C.border);
push(`<text x="44" y="${y + 28}" font-size="15" font-weight="600" fill="${C.text}">📋 发布注意事项（手动发布前逐条核对）</text>`);
let ny = y + 50;
notes.forEach((n) => {
  push(`<rect x="44" y="${ny - 11}" width="14" height="14" rx="3" fill="${C.panel2}" stroke="${C.border}"/>`);
  push(`<text x="66" y="${ny}" font-size="12.5" fill="${C.muted}">${esc(clip(n, 92))}</text>`);
  ny += 24;
});
y += h5 + 24;

const H = y;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="WenQuanYi Zen Hei, sans-serif">
<rect width="${W}" height="${H}" fill="${C.bg}"/>
${rows.join("\n")}
</svg>`;

fs.writeFileSync("/tmp/preview.svg", svg);
await sharp(Buffer.from(svg)).png().toFile("/home/user/Auto-media-product/docs/preview-csdn.png");
console.log("生成完成:", H, "px 高");
