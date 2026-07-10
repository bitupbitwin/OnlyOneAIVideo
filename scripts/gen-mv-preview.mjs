// 用真实 MV 数据渲染「流程工作台」预览图（SVG→PNG via sharp）
// 展示：可调参数（画面数量10 等）+ 批量出图 + 图生视频片段
import fs from "node:fs";
import sharp from "../node_modules/.pnpm/node_modules/sharp/lib/index.js";

const d = JSON.parse(fs.readFileSync("/tmp/mv-data.json", "utf-8"));
const C = { bg: "#11141a", panel: "#1a1f29", panel2: "#222837", border: "#2e3648", text: "#e6e9f0", muted: "#8b93a7", accent: "#4f8cff", green: "#3ecf8e", yellow: "#f5b73d", purple: "#a779ff" };
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
push(`<text x="24" y="${y}" font-size="20" font-weight="700" fill="${C.text}">MV · 歌词可视化</text>`);
push(`<rect x="240" y="${y - 18}" width="60" height="24" rx="12" fill="rgba(62,207,142,.15)"/><text x="270" y="${y - 1}" font-size="13" fill="${C.green}" text-anchor="middle">已完成</text>`);
push(`<rect x="${W - 360}" y="${y - 19}" width="110" height="28" rx="6" fill="${C.panel2}" stroke="${C.border}"/><text x="${W - 305}" y="${y}" font-size="13" fill="${C.text}" text-anchor="middle">📦 导出产物包</text>`);
push(`<rect x="${W - 100}" y="${y - 19}" width="76" height="28" rx="6" fill="${C.accent}"/><text x="${W - 62}" y="${y}" font-size="13" fill="#fff" text-anchor="middle">⚡ 全自动</text>`);
y += 16;

// ===== 参数面板（创建时可调，界面开放） =====
const params = [
  { k: "生成形式", v: "纯图片", t: "choices" },
  { k: "画面比例", v: opts.aspect || "9:16", t: "choices" },
  { k: "画面数量", v: opts.imageCount || "10", t: "number" },
  { k: "图片出图", v: "真实出图", t: "choices" },
  { k: "图生视频", v: "转动态片段", t: "choices" },
];
const ph = 60;
push(`<rect x="24" y="${y}" width="${W - 48}" height="${ph}" rx="10" fill="${C.panel}" stroke="${C.purple}" stroke-opacity="0.5"/>`);
push(`<text x="44" y="${y + 24}" font-size="13" font-weight="600" fill="${C.purple}">⚙ 可调参数（创建流程时在界面选择/输入）</text>`);
let px = 44;
params.forEach((p) => {
  const isNum = p.t === "number";
  const label = `${p.k}: ${p.v}`;
  const w = label.length * 12.5 + 30 + (isNum ? 0 : 14);
  push(`<rect x="${px}" y="${y + 32}" width="${w}" height="22" rx="6" fill="${C.panel2}" stroke="${isNum ? C.yellow : C.border}"/>`);
  push(`<text x="${px + 12}" y="${y + 47}" font-size="12" fill="${C.text}">${esc(p.k)}: <tspan fill="${isNum ? C.yellow : C.accent}" font-weight="600">${esc(p.v)}</tspan></text>`);
  if (!isNum) push(`<text x="${px + w - 16}" y="${y + 47}" font-size="10" fill="${C.muted}">▾</text>`);
  px += w + 10;
});
y += ph + 14;

const card = (h) => push(`<rect x="24" y="${y}" width="${W - 48}" height="${h}" rx="10" fill="${C.panel}" stroke="${C.border}"/>`);
const header = (title, provider, statusColor = C.green, statusLabel = "已完成") => {
  push(`<text x="44" y="${y + 27}" font-size="15" font-weight="600" fill="${C.text}">${esc(title)}</text>`);
  push(`<rect x="${44 + title.length * 15 + 14}" y="${y + 12}" width="60" height="22" rx="11" fill="rgba(62,207,142,.15)"/><text x="${44 + title.length * 15 + 44}" y="${y + 27}" font-size="12" fill="${statusColor}" text-anchor="middle">${statusLabel}</text>`);
  push(`<rect x="${W - 300}" y="${y + 11}" width="230" height="26" rx="6" fill="${C.panel2}" stroke="${C.border}"/><text x="${W - 288}" y="${y + 28}" font-size="12" fill="${C.muted}">${esc(provider)}</text><text x="${W - 86}" y="${y + 28}" font-size="11" fill="${C.muted}">▼</text>`);
};

// 步骤1：歌词（紧凑）
const lyr = (step("lyrics").artifacts.find((a) => a.selected)?.content || "").split("\n").filter(Boolean).slice(0, 5);
const h1 = 48 + lyr.length * 18 + 6;
card(h1); header("歌词与歌名生成", "Claude Code CLI");
let ly = y + 50;
lyr.forEach((l) => { const isT = /标题《/.test(l); const isTag = /^【/.test(l); push(`<text x="44" y="${ly}" font-size="${isT ? 14 : 12.5}" font-weight="${isT ? "700" : "400"}" fill="${isT ? C.accent : isTag ? C.yellow : "#c8cedb"}">${esc(clip(l, 80))}</text>`); ly += 18; });
y += h1 + 12;

// 步骤2：图片提示词（含数量约束提示）
const ipText = (step("image-prompts").artifacts.find((a) => a.selected)?.content || "").split("\n").filter(Boolean).slice(0, 3);
const h2 = 46 + ipText.length * 17 + 10;
card(h2); header("图片提示词（全曲分段 · 正好 10 段）", "Claude Code CLI");
push(`<rect x="44" y="${y + 40}" width="${W - 92}" height="${h2 - 50}" rx="8" fill="#0d1016"/>`);
let iy = y + 58;
ipText.forEach((l) => { const isH = /^【画面/.test(l); push(`<text x="56" y="${iy}" font-size="11.5" font-family="monospace" fill="${isH ? C.yellow : "#9fe8c1"}">${esc(clip(l, 120))}</text>`); iy += 17; });
y += h2 + 12;

// 步骤3：批量出图（10 张缩略图）
const imgs = step("batch-images").artifacts.filter((a) => a.kind === "image");
const cols = 10, gap = 10, padX = 44;
const tw = Math.floor((W - 48 - 40 - (cols - 1) * gap) / cols), th = Math.round(tw * 16 / 9);
const h3 = 70 + th + 24;
card(h3); header(`批量出图（按提示词逐张 · ${imgs.length} 张）`, "MV 批量出图（即梦 / Seedream）");
push(`<text x="44" y="${y + 52}" font-size="12" fill="${C.muted}">产物（共 ${imgs.length} 张 · 原生 1080×1920 不裁剪 · 可对单张 🎲重抽 / ⬆替换）：</text>`);
for (let i = 0; i < Math.min(imgs.length, cols); i++) {
  const x = padX + i * (tw + gap);
  const src = "data:image/png;base64," + fs.readFileSync(imgs[i].file_path).toString("base64");
  push(`<clipPath id="ic${i}"><rect x="${x}" y="${y + 62}" width="${tw}" height="${th}" rx="6"/></clipPath>`);
  push(`<image x="${x}" y="${y + 62}" width="${tw}" height="${th}" href="${src}" preserveAspectRatio="xMidYMid slice" clip-path="url(#ic${i})"/>`);
  push(`<rect x="${x}" y="${y + 62}" width="${tw}" height="${th}" rx="6" fill="none" stroke="${C.border}"/>`);
  push(`<text x="${x + 4}" y="${y + 76}" font-size="10" fill="#fff" style="paint-order:stroke;stroke:#000;stroke-width:2px">${i + 1}</text>`);
}
y += h3 + 12;

// 步骤4：图生视频（10 个片段，复用上游图作帧 + ▶ 角标）
const clips = step("image-to-video").artifacts;
const h4 = 70 + th + 24;
card(h4); header(`图生视频（每张图 → 动态片段 · ${clips.length} 段）`, "图生视频（即梦 Seedance i2v）");
push(`<text x="44" y="${y + 52}" font-size="12" fill="${C.muted}">产物（共 ${clips.length} 段 .mp4 · 由上方每张图驱动 · 导入剪映拼接成完整 MV）：</text>`);
for (let i = 0; i < Math.min(clips.length, cols); i++) {
  const x = padX + i * (tw + gap);
  const src = "data:image/png;base64," + fs.readFileSync(imgs[i].file_path).toString("base64");
  push(`<clipPath id="vc${i}"><rect x="${x}" y="${y + 62}" width="${tw}" height="${th}" rx="6"/></clipPath>`);
  push(`<image x="${x}" y="${y + 62}" width="${tw}" height="${th}" href="${src}" preserveAspectRatio="xMidYMid slice" clip-path="url(#vc${i})" opacity="0.85"/>`);
  push(`<rect x="${x}" y="${y + 62}" width="${tw}" height="${th}" rx="6" fill="none" stroke="${C.purple}" stroke-opacity="0.6"/>`);
  // 播放角标
  const cxp = x + tw / 2, cyp = y + 62 + th / 2;
  push(`<circle cx="${cxp}" cy="${cyp}" r="13" fill="rgba(0,0,0,0.55)"/><path d="M ${cxp - 4} ${cyp - 6} L ${cxp + 7} ${cyp} L ${cxp - 4} ${cyp + 6} Z" fill="#fff"/>`);
  push(`<rect x="${x}" y="${y + 62 + th - 16}" width="${tw}" height="16" fill="rgba(0,0,0,0.5)"/><text x="${x + tw / 2}" y="${y + 62 + th - 4}" font-size="9" fill="#fff" text-anchor="middle">片段${i + 1}</text>`);
}
y += h4 + 12;

// 步骤5：字幕 + 封面 + docx
const h5 = 92;
card(h5); header("SRT 字幕 + 封面图 + 文档打包", "Claude / 即梦");
push(`<text x="44" y="${y + 52}" font-size="12" fill="${C.muted}">📄 字幕.srt 已生成　|　🖼 封面 9:16 已生成　|　📦 提示词文档.docx 已打包　|　产物包内含全部图/片段/字幕/封面</text>`);
const cov = step("cover").artifacts.find((a) => a.label === "原图");
if (cov) { const csrc = "data:image/png;base64," + fs.readFileSync(cov.file_path).toString("base64"); push(`<clipPath id="cov"><rect x="${W - 120}" y="${y + 12}" width="40" height="68" rx="4"/></clipPath><image x="${W - 120}" y="${y + 12}" width="40" height="68" href="${csrc}" preserveAspectRatio="xMidYMid slice" clip-path="url(#cov)"/>`); }
y += h5 + 16;

const H = y;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family="WenQuanYi Zen Hei, sans-serif"><rect width="${W}" height="${H}" fill="${C.bg}"/>${rows.join("\n")}</svg>`;
await sharp(Buffer.from(svg)).png().toFile("/home/user/Auto-media-product/mv-preview.png");
console.log("生成完成:", H, "px");
