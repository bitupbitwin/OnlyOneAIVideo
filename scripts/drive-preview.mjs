// 跑两条流水线（小红书图文 + MV），把 detail 数据 dump 到 /tmp，供渲染脚本使用
const BASE = "http://127.0.0.1:8787";
import fs from "node:fs";
const api = async (m, u, b) => {
  const res = await fetch(BASE + u, { method: m, headers: { "Content-Type": "application/json" }, body: m === "GET" ? undefined : JSON.stringify(b ?? {}) });
  const d = await res.json();
  if (!res.ok) throw new Error(`${m} ${u} -> ${res.status}: ${JSON.stringify(d)}`);
  return d;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (id, pred, label, t = 120000) => {
  const s = Date.now();
  while (Date.now() - s < t) { const d = await api("GET", `/api/pipelines/${id}`); if (pred(d)) return d; await sleep(500); }
  throw new Error("超时: " + label);
};

const project = await api("POST", "/api/projects", {
  title: "预览演示", brief: { topic: "通勤路上用碎片时间学英语的5个方法", audience: "上班族", sellingPoints: "零成本、可坚持、亲测有效" },
});

// ---- 1. 小红书图文：真实出图 + 图生视频 ----
console.log("跑 小红书图文（真实出图+图生视频）...");
const xhs = await api("POST", `/api/projects/${project.id}/pipelines`, {
  templateId: "xhs-note",
  options: { aspect: "3:4", titleMaxLen: "20", contentLen: "800", imageCount: "6", imageGen: "real", videoGen: "real" },
});
await api("POST", `/api/pipelines/${xhs.id}/run`, { auto: true });
let xhsD = await waitFor(xhs.id, (d) => d.status === "succeeded" || d.status === "failed", "xhs 终态", 180000);
console.log("  xhs 状态:", xhsD.status);
fs.writeFileSync("/tmp/xhs-data.json", JSON.stringify(xhsD));

// ---- 2. MV：纯图片 + 真实出图 + 图生视频，画面数量 10 ----
console.log("跑 MV（画面数量10 + 真实出图 + 图生视频）...");
const mv = await api("POST", `/api/projects/${project.id}/pipelines`, {
  templateId: "mv-song",
  options: { visualMode: "images", aspect: "9:16", imageCount: "10", imageGen: "real", videoGen: "real" },
});
await api("POST", `/api/pipelines/${mv.id}/run`, { auto: true });
let mvD = await waitFor(mv.id, (d) => d.status === "succeeded" || d.status === "failed", "mv 终态", 180000);
console.log("  mv 状态:", mvD.status);
fs.writeFileSync("/tmp/mv-data.json", JSON.stringify(mvD));

// 摘要
const sum = (d) => d.steps.map((s) => `${s.name}: ${s.status} (${s.artifacts.length}产物)`).join("\n  ");
console.log("\n=== 小红书 ===\n  " + sum(xhsD));
console.log("\n=== MV ===\n  " + sum(mvD));
