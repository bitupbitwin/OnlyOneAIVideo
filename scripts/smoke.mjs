#!/usr/bin/env node
/**
 * 端到端冒烟测试：用内置 Mock 引擎完整跑一条「抖音·视频」流程。
 * 前置：服务已在 127.0.0.1:8787 启动。
 * 验证点：标题候选生成→人工卡点→选标题→内容/封面并行→封面多尺寸→剪映草稿→评审入库。
 */
const BASE = "http://127.0.0.1:8787";

const api = async (method, url, body) => {
  const res = await fetch(BASE + url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status}: ${JSON.stringify(data)}`);
  return data;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (cond, msg) => {
  if (!cond) throw new Error(`断言失败: ${msg}`);
  console.log(`  ✓ ${msg}`);
};

const waitFor = async (pipelineId, predicate, label, timeoutMs = 60_000) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const detail = await api("GET", `/api/pipelines/${pipelineId}`);
    if (predicate(detail)) return detail;
    await sleep(500);
  }
  throw new Error(`等待超时: ${label}`);
};

console.log("1. 创建项目");
const project = await api("POST", "/api/projects", {
  title: "冒烟测试项目",
  brief: { topic: "新手如何30天养成跑步习惯", audience: "久坐上班族", sellingPoints: "零基础、低门槛" },
});

console.log("2. 创建抖音·视频流程");
const pipeline = await api("POST", `/api/projects/${project.id}/pipelines`, { templateId: "douyin-video" });
let detail = await api("GET", `/api/pipelines/${pipeline.id}`);
assert(detail.steps.length === 5, "流程包含 5 个步骤");
assert(detail.steps.every((s) => s.provider_id), "每个步骤都分配了默认引擎");

console.log("3. 运行流程，等待标题人工卡点");
await api("POST", `/api/pipelines/${pipeline.id}/run`);
detail = await waitFor(pipeline.id, (d) => d.steps.find((s) => s.def_id === "title").status === "waiting_human", "标题等待人工");
const titleStep = detail.steps.find((s) => s.def_id === "title");
assert(titleStep.artifacts.length >= 5, `生成了 ${titleStep.artifacts.length} 个候选标题`);
assert(detail.status === "waiting_human", "流水线状态为等待人工");

console.log("4. 选定第 2 个标题并确认，等待后续步骤并行完成");
await api("POST", `/api/artifacts/${titleStep.artifacts[1].id}/select`);
await api("POST", `/api/steps/${titleStep.id}/confirm`);
detail = await waitFor(pipeline.id, (d) => d.status === "succeeded" || d.status === "failed", "流水线终态", 120_000);
for (const s of detail.steps) {
  assert(s.status === "succeeded", `步骤「${s.name}」完成（实际: ${s.status}${s.error ? " / " + s.error : ""}）`);
}

const cover = detail.steps.find((s) => s.def_id === "cover");
assert(cover.artifacts.some((a) => a.label?.includes("1080x1920")), "封面派生了 1080x1920 尺寸");
assert(cover.artifacts.some((a) => a.selected), "封面自动选中了一张");

const content = detail.steps.find((s) => s.def_id === "content");
assert(content.artifacts.some((a) => a.selected && a.content?.includes(titleStep.artifacts[1].content.slice(0, 5)) || a.selected), "内容已生成并选中");

const video = detail.steps.find((s) => s.def_id === "video");
assert(video.artifacts.some((a) => a.label === "剪映草稿目录"), "生成了剪映草稿目录");
assert(video.artifacts.some((a) => a.label?.includes("CSV")), "生成了分镜表 CSV 降级方案");

assert(detail.reviews.length >= 2, `评审入库 ${detail.reviews.length} 条（标题+内容）`);
assert(detail.notes.length > 0, "注意事项清单非空");

const fs = await import("node:fs");
const draftDir = video.artifacts.find((a) => a.label === "剪映草稿目录").file_path;
assert(fs.existsSync(`${draftDir}/draft_content.json`), "剪映 draft_content.json 已写盘");
assert(fs.existsSync(`${draftDir}/storyboard.csv`), "storyboard.csv 已写盘");

console.log("5. 按评审建议重生成内容");
const oldContentArtifacts = content.artifacts.length;
await api("POST", `/api/steps/${content.id}/rerun`, { feedback: "问题：开头铺垫太长\n建议：第一句直接给结论" });
detail = await waitFor(
  pipeline.id,
  (d) => d.steps.find((s) => s.def_id === "content").status === "succeeded" &&
         d.steps.find((s) => s.def_id === "content").artifacts.length > oldContentArtifacts,
  "内容重生成完成"
);
const content2 = detail.steps.find((s) => s.def_id === "content");
assert(content2.prompt_rendered.includes("评审修改意见"), "重生成提示词包含评审修改意见");
assert(content2.artifacts.filter((a) => a.selected).length === 1, "重生成后只有一个选中产物");

console.log("6. 导出产物包");
const exportRes = await fetch(`${BASE}/api/pipelines/${pipeline.id}/export`);
assert(exportRes.status === 200, "导出接口返回 200");
assert((exportRes.headers.get("content-type") || "").includes("zip"), "导出类型为 zip");
const zipBuf = await exportRes.arrayBuffer();
assert(zipBuf.byteLength > 5000, `导出包大小 ${(zipBuf.byteLength / 1024).toFixed(1)}KB > 5KB`);

console.log("7. Prompt 模板覆盖");
await api("PUT", "/api/prompts/content", { path: "common/review.md", content: "OVERRIDE-TEST {{platform}}" });
let prompts = await api("GET", "/api/prompts");
assert(prompts.find((p) => p.path === "common/review.md").overridden, "模板标记为已覆盖");
const got = await api("GET", "/api/prompts/content?path=common/review.md");
assert(got.content.startsWith("OVERRIDE-TEST"), "读取到覆盖内容");
await fetch(`${BASE}/api/prompts/content?path=common/review.md`, { method: "DELETE" });
prompts = await api("GET", "/api/prompts");
assert(!prompts.find((p) => p.path === "common/review.md").overridden, "恢复默认成功");

console.log("8. 全自动模式（免人工卡点 + 评审不过自动重生成一轮）");
const reviewTpl = await api("GET", "/api/prompts/content?path=common/review.md");
await api("PUT", "/api/prompts/content", { path: "common/review.md", content: reviewTpl.content + "\nFORCE_REVISE" });
const autoPl = await api("POST", `/api/projects/${project.id}/pipelines`, { templateId: "xhs-note" });
await api("POST", `/api/pipelines/${autoPl.id}/run`, { auto: true });
let autoDetail = await waitFor(
  autoPl.id,
  (d) => d.status === "succeeded" || d.status === "failed",
  "全自动流水线终态",
  180_000
);
assert(autoDetail.status === "succeeded", "全自动流水线无人工干预跑完");
const autoTitle = autoDetail.steps.find((s) => s.def_id === "title");
assert(autoTitle.artifacts.some((a) => a.selected), "标题自动选定（推荐度第一）");
const autoContent = autoDetail.steps.find((s) => s.def_id === "content");
const contentVersions = new Set(autoContent.artifacts.map((a) => a.version)).size;
assert(contentVersions >= 2, `评审不过触发了自动重生成（内容 ${contentVersions} 个版本）`);
assert(autoContent.prompt_rendered.includes("评审修改意见"), "重生成提示词带入了评审意见");
assert(autoDetail.reviews.filter((r) => r.target === "content").length >= 2, "复评完成（评审记录 ≥ 2 轮）");
const autoCover = autoDetail.steps.find((s) => s.def_id === "cover");
const coverOriginals = autoCover.artifacts.filter((a) => a.label === "原图").length;
assert(coverOriginals >= 3, `封面产出 ${coverOriginals} 个候选版本`);
await fetch(`${BASE}/api/prompts/content?path=common/review.md`, { method: "DELETE" });

console.log("\n✅ 冒烟测试全部通过");
