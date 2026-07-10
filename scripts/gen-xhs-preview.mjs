// 小红书图文工作台预览（SVG→PNG via sharp）
// 展示：开放可调参数（字数/数量/比例/出图/图生视频）+ 多候选标题 + 封面×3 + 批量出图 + 图生视频
import fs from "node:fs";
import sharp from "../node_modules/.pnpm/node_modules/sharp/lib/index.js";

const d = JSON.parse(fs.readFileSync("/tmp/xhs-data.json", "utf-8"));
const C = { bg: "#11141a", panel: "#1a1f29", panel2: "#222837", border: "#2e3648", text: "#e6e9f0", muted: "#8b93a7", accent: "#4f8cff", green: "#3ecf8e", yellow: "#f5b73d", purple: "#a779ff", pink: "#ff2442" };
const W = 1380;
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const clip = (s, n) => { s = String(s ?? "").replace(/\n/g, " "); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
const step = (id) => d.steps.find((s) => s.def_id === id);
const opts = d.options || {};

const rows = [];
const push = (s) => rows.push(s);
let y = 0;

// 顶栏
push(`<rect x="0" y="0" width="${W}" height="52" fill="${C.panel}"/><line x1="0" y1="52" x2="${W}" y2="52" stroke="${C.border}"/>`);
push(`<text x="24" y="33" font-size="17" font-weight="700" fill="${C.text}">📦 自媒体内容工作台</text>`);
["项目", "引擎管理", "模板管理"].forEach((t, i) => push(`<text x="${280 + i * 78}" y="33" font-size="14" fill="${C.muted}">${t}</text>`));
y = 52;

// 标题栏
y += 30;
push(`<rect x="24" y="${y - 19}" width="6" height="22" rx="3" fill="${C.pink}"/>`);
push(`<text x="40" y="${y}" font-size="20" font-weight="700" fill="${C.text}">小红书 · 图文笔记</text>`);
push(`<rect x="280" y="${y - 18}" width="60" height="24" rx="12" fill="rgba(62,207,142,.15)"/><text x="310" y="${y - 1}" font-size="13" fill="${C.green}" text-anchor="middle">已完成</text>`);
push(`<rect x="${W - 360}" y="${y - 19}" width="110" height="28" rx="6" fill="${C.panel2}" stroke="${C.border}"/><text x="${W - 305}" y="${y}" font-size="13" fill="${C.text}" text-anchor="middle">📦 导出产物包</text>`);
push(`<rect x="${W - 100}" y="${y - 19}" width="76" height="28" rx="6" fill="${C.accent}"/><text x="${W - 62}" y="${y}" font-size="13" fill="#fff" text-anchor="middle">⚡ 全自动</text>`);
y += 16;

// ===== 参数面板 =====
const params = [
  { k: "标题字数上限", v: opts.titleMaxLen || "20", t: "number" },
  { k: "正文字数", v: opts.contentLen || "800", t: "number" },
  { k: "图片数量", v: opts.imageCount || "6", t: "number" },
  { k: "画面比例", v: opts.aspect || "3:4", t: "choices" },
  { k: "图片出图", v: "真实出图", t: "choices" },
  { k: "图生视频", v: "转动态片段", t: "choices" },
];
const ph = 60;
push(`<rect x="24" y="${y}" width="${W - 48}" height="${ph}" rx="10" fill="${C.panel}" stroke="${C.purple}" stroke-opacity="0.5"/>`);
push(`<text x="44" y="${y + 24}" font-size="13" font-weight="600" fill="${C.purple}">⚙ 可调参数（字数 / 数量为数字输入框，比例 / 模式为下拉，创建流程时设置）</text>`);
let px = 44;
params.forEach((p) => {
  const isNum = p.t === "number";
  const label = `${p.k}: ${p.v}`;
  const w = label.length * 12.5 + 30 + (isNum ? 0 : 14);
  push(`<rect x="${px}" y="${y + 32}" width="${w}" height="22" rx="6" fill="${C.panel2}" stroke="${isNum ? C.yellow : C.border}"/>`);
  push(`<text x="${px + 12}" y="${y + 47}" font-size="12" fill="${C.text}">${esc(p.k)}: <tspan fill="${isNum ? C.yellow : C.accent}" font-weight="600">${esc(p.v)}</tspan></text>`);
  push(`<text x="${px + w - 16}" y="${y + 47}" font-size="10" fill="${C.muted}">${isNum ? "⇕" : "▾"}</text>`);
  px += w + 10;
});
y += ph + 14;

const card = (h) => push(`<rect x="24" y="${y}" width="${W - 48}" height="${h}" rx="10" fill="${C.panel}" stroke="${C.border}"/>`);
const header = (title, provider) => {
  push(`<text x="44" y="${y + 27}" font-size="15" font-weight="600" fill="${C.text}">${esc(title)}</text>`);
  push(`<rect x="${44 + title.length * 15 + 14}" y="${y + 12}" width="60" height="22" rx="11" fill="rgba(62,207,142,.15)"/><text x="${44 + title.length * 15 + 44}" y="${y + 27}" font-size="12" fill="${C.green}" text-anchor="middle">已完成</text>`);
  push(`<rect x="${W - 300}" y="${y + 11}" width="230" height="26" rx="6" fill="${C.panel2}" stroke="${C.border}"/><text x="${W - 288}" y="${y + 28}" font-size="12" fill="${C.muted}">${esc(provider)}</text><text x="${W - 86}" y="${y + 28}" font-size="11" fill="${C.muted}">▼</text>`);
};

// 步骤1：标题 ×5（人工卡点）
const titles = step("title").artifacts.map((a) => ({ t: a.content, sel: !!a.selected }));
const h1 = 56 + titles.length * 28 + 6;
card(h1); header("标题生成（×5 候选 · 人工卡点）", "演示文本引擎（Mock）");
push(`<text x="44" y="${y + 50}" font-size="12" fill="${C.muted}">产物（点击设为选中）— 标题严格 ≤ ${opts.titleMaxLen || 20} 字：</text>`);
let ty = y + 56;
titles.forEach((it) => {
  push(`<rect x="44" y="${ty}" width="${W - 136}" height="24" rx="6" fill="${C.panel2}" stroke="${it.sel ? C.green : C.border}"/>`);
  push(`<text x="56" y="${ty + 16}" font-size="12.5" fill="${C.text}">${esc(clip(it.t, 56))}</text>`);
  if (it.sel) push(`<text x="${W - 116}" y="${ty + 16}" font-size="12" fill="${C.green}">✓ 已选</text>`);
  ty += 28;
});
y += h1 + 12;

// 步骤2：正文（约 800 字）
const content = (step("content").artifacts.find((a) => a.selected)?.content || "").split("\n").filter((l) => l.trim()).slice(0, 5);
const h2 = 60 + content.length * 18 + 8;
card(h2); header(`笔记正文生成（约 ${opts.contentLen || 800} 字 · 干货优先）`, "演示文本引擎（Mock）");
push(`<rect x="44" y="${y + 44}" width="${W - 92}" height="${h2 - 54}" rx="8" fill="#0d1016"/>`);
let cy = y + 62;
content.forEach((l) => { push(`<text x="56" y="${cy}" font-size="12" fill="#c8cedb">${esc(clip(l, 110))}</text>`); cy += 18; });
y += h2 + 12;

// 步骤3：封面 ×3（原生 3:4）
const covers = step("cover").artifacts.filter((a) => a.label === "原图").slice(0, 3);
const ctw = 150, cth = 200;
const h3 = 70 + cth + 16;
card(h3); header("封面生成（×3 候选 · 原生 3:4 不裁剪）", "演示出图引擎（即梦）");
push(`<text x="44" y="${y + 52}" font-size="12" fill="${C.muted}">3 个候选版本（点选切换）｜ 比例 ${opts.aspect || "3:4"} → 派生 1080×1440：</text>`);
covers.forEach((a, i) => {
  const x = 44 + i * (ctw + 16);
  const src = "data:image/png;base64," + fs.readFileSync(a.file_path).toString("base64");
  push(`<clipPath id="cc${i}"><rect x="${x}" y="${y + 62}" width="${ctw}" height="${cth}" rx="8"/></clipPath>`);
  push(`<image x="${x}" y="${y + 62}" width="${ctw}" height="${cth}" href="${src}" preserveAspectRatio="xMidYMid slice" clip-path="url(#cc${i})"/>`);
  push(`<rect x="${x}" y="${y + 62}" width="${ctw}" height="${cth}" rx="8" fill="none" stroke="${a.selected ? C.green : C.border}"/>`);
  if (a.selected) push(`<text x="${x + 8}" y="${y + 80}" font-size="11" fill="${C.green}" style="paint-order:stroke;stroke:#000;stroke-width:2px">✓ 已选</text>`);
});
y += h3 + 12;

// 步骤4：批量出图（6 张）
const imgs = step("batch-images").artifacts.filter((a) => a.kind === "image");
const cols = 6, gap = 12, padX = 44;
const tw = Math.floor((W - 48 - 40 - (cols - 1) * gap) / cols), th = Math.round(tw * 4 / 3);
const h4 = 70 + th + 16;
card(h4); header(`批量出图（按内容逐张 · ${imgs.length} 张）`, "演示出图引擎（即梦 / Seedream）");
push(`<text x="44" y="${y + 52}" font-size="12" fill="${C.muted}">产物（共 ${imgs.length} 张 · 由「图片数量」参数控制 · 可对单张 🎲重抽 / ⬆替换）：</text>`);
for (let i = 0; i < Math.min(imgs.length, cols); i++) {
  const x = padX + i * (tw + gap);
  const src = "data:image/png;base64," + fs.readFileSync(imgs[i].file_path).toString("base64");
  push(`<clipPath id="ic${i}"><rect x="${x}" y="${y + 62}" width="${tw}" height="${th}" rx="6"/></clipPath>`);
  push(`<image x="${x}" y="${y + 62}" width="${tw}" height="${th}" href="${src}" preserveAspectRatio="xMidYMid slice" clip-path="url(#ic${i})"/>`);
  push(`<rect x="${x}" y="${y + 62}" width="${tw}" height="${th}" rx="6" fill="none" stroke="${C.border}"/>`);
  push(`<text x="${x + 4}" y="${y + 76}" font-size="10" fill="#fff" style="paint-order:stroke;stroke:#000;stroke-width:2px">画面 ${i + 1}</text>`);
}
y += h4 + 12;

// 步骤5：图生视频（6 段）
const clips = step("image-to-video").artifacts;
const h5 = 70 + th + 16;
card(h5); header(`图生视频（每张图 → 动态片段 · ${clips.length} 段）`, "图生视频（即梦 Seedance i2v）");
push(`<text x="44" y="${y + 52}" font-size="12" fill="${C.muted}">产物（共 ${clips.length} 段 .mp4 · 由上方每张图驱动生成 · 让静态图集变可滑动短视频）：</text>`);
for (let i = 0; i < Math.min(clips.length, cols); i++) {
  const x = padX + i * (tw + gap);
  const src = "data:image/png;base64," + fs.readFileSync(imgs[i].file_path).toString("base64");
  push(`<clipPath id="vc${i}"><rect x="${x}" y="${y + 62}" width="${tw}" height="${th}" rx="6"/></clipPath>`);
  push(`<image x="${x}" y="${y + 62}" width="${tw}" height="${th}" href="${src}" preserveAspectRatio="xMidYMid slice" clip-path="url(#vc${i})" opacity="0.85"/>`);
  push(`<rect x="${x}" y="${y + 62}" width="${tw}" height="${th}" rx="6" fill="none" stroke="${C.purple}" stroke-opacity="0.6"/>`);
  const cxp = x + tw / 2, cyp = y + 62 + th / 2;
  push(`<circle cx="${cxp}" cy="${cyp}" r="16" fill="rgba(0,0,0,0.55)"/><path d="M ${cxp - 5} ${cyp - 8} L ${cxp + 9} ${cyp} L ${cxp - 5} ${cyp + 8} Z" fill="#fff"/>`);
  push(`<rect x="${x}" y="${y + 62 + th - 18}" width="${tw}" height="18" fill="rgba(0,0,0,0.5)"/><text x="${x + tw / 2}" y="${y + 62 + th - 5}" font-size="10" fill="#fff" text-anchor="middle">视频片段 ${i + 1}</text>`);
}
y += h5 + 12;

// 步骤6：评审 + 注意事项
const h6 = 64;
card(h6); header("评审评分 + 合规预检", "演示文本引擎（Mock）");
push(`<text x="44" y="${y + 52}" font-size="12" fill="${C.muted}">✓ 标题/正文多维评分　|　✓ 极限词预检（严禁站外引流：微信号/二维码）　|　产物包导出后手动发布</text>`);
y += h6 + 16;

const H = y;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family="WenQuanYi Zen Hei, sans-serif"><rect width="${W}" height="${H}" fill="${C.bg}"/>${rows.join("\n")}</svg>`;
await sharp(Buffer.from(svg)).png().toFile("/home/user/Auto-media-product/xhs-preview.png");
console.log("生成完成:", H, "px");
