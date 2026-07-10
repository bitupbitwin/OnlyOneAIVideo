import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { extractJson } from "@amp/shared";

export interface StoryboardScene {
  shot: number;
  visual: string;
  line: string;
  subtitle?: string;
  durationSec: number;
}

export interface Storyboard {
  scenes: StoryboardScene[];
  bgmHint?: string;
}

export interface DraftResult {
  draftDir: string;
  csvPath: string;
}

/**
 * 把 LLM 输出的分镜表写成剪映草稿目录 + 分镜表 CSV（降级方案）。
 *
 * 注意：剪映草稿格式（draft_content.json）为非公开格式且随版本变动，
 * 这里按 9:16 竖版生成包含字幕轨（台词逐镜头）的最小草稿结构；
 * 若你的剪映版本无法识别，请使用 storyboard.csv 在剪映中手动建稿。
 */
export function writeJianyingDraft(
  storyboardText: string,
  outDir: string,
  meta: { name: string; sourceVideos?: string[] }
): DraftResult {
  const parsed = extractJson<Storyboard>(storyboardText);
  const scenes: StoryboardScene[] =
    parsed?.scenes?.map((s, i) => ({
      shot: s.shot ?? i + 1,
      visual: s.visual ?? "",
      line: s.line ?? "",
      subtitle: s.subtitle ?? s.line ?? "",
      durationSec: Number(s.durationSec) > 0 ? Number(s.durationSec) : 3,
    })) ?? [];

  const draftDir = path.join(outDir, `jianying-${sanitize(meta.name)}`);
  fs.mkdirSync(draftDir, { recursive: true });

  // ---- 降级方案：分镜表 CSV（任何剪映版本都可对照手动建稿）----
  const csvPath = path.join(draftDir, "storyboard.csv");
  const csvLines = ["镜头,画面描述,台词,字幕,时长(秒)"];
  for (const s of scenes) {
    csvLines.push([s.shot, s.visual, s.line, s.subtitle, s.durationSec].map(csvCell).join(","));
  }
  if (scenes.length === 0) csvLines.push(csvCell("(分镜 JSON 解析失败，原始输出见 raw_output.txt)"));
  fs.writeFileSync(csvPath, "﻿" + csvLines.join("\n"), "utf-8");
  fs.writeFileSync(path.join(draftDir, "raw_output.txt"), storyboardText, "utf-8");

  // ---- 剪映草稿（最小结构：画布 + 字幕轨）----
  const US = 1_000_000; // 剪映时间单位为微秒
  let cursor = 0;
  const texts: any[] = [];
  const segments: any[] = [];
  for (const s of scenes) {
    const id = randomUUID().toUpperCase();
    const duration = Math.round(s.durationSec * US);
    texts.push({
      id,
      type: "text",
      content: JSON.stringify({ text: s.subtitle, styles: [] }),
      alignment: 1,
      font_size: 15,
    });
    segments.push({
      id: randomUUID().toUpperCase(),
      material_id: id,
      target_timerange: { start: cursor, duration },
      source_timerange: { start: 0, duration },
      visible: true,
    });
    cursor += duration;
  }

  const draftContent = {
    canvas_config: { width: 1080, height: 1920, ratio: "9:16" },
    color_space: 0,
    duration: cursor,
    fps: 30.0,
    id: randomUUID().toUpperCase(),
    materials: { texts, videos: [], audios: [] },
    tracks: [{ id: randomUUID().toUpperCase(), type: "text", segments }],
    version: 360000,
  };
  fs.writeFileSync(path.join(draftDir, "draft_content.json"), JSON.stringify(draftContent, null, 2), "utf-8");
  fs.writeFileSync(
    path.join(draftDir, "draft_meta_info.json"),
    JSON.stringify({ draft_name: meta.name, draft_fold_path: draftDir, tm_duration: cursor }, null, 2),
    "utf-8"
  );

  // 用户上传的未剪辑原片：复制到草稿目录的 source/ 下，作为剪辑源素材
  const sourceVideos = meta.sourceVideos ?? [];
  const copiedSources: string[] = [];
  if (sourceVideos.length > 0) {
    const sourceDir = path.join(draftDir, "source");
    fs.mkdirSync(sourceDir, { recursive: true });
    for (const src of sourceVideos) {
      if (!fs.existsSync(src)) continue;
      const dest = path.join(sourceDir, path.basename(src));
      try {
        fs.copyFileSync(src, dest);
        copiedSources.push(path.basename(src));
      } catch {
        // 拷贝失败（如文件过大/占用）则跳过，不阻断草稿生成
      }
    }
  }

  fs.writeFileSync(
    path.join(draftDir, "README.txt"),
    [
      "【剪映草稿使用说明】",
      "1. 将本目录整体复制到剪映草稿目录后重启剪映：",
      "   Windows: %LOCALAPPDATA%\\JianyingPro\\User Data\\Projects\\com.lveditor.draft\\",
      "   macOS:   ~/Movies/JianyingPro/User Data/Projects/com.lveditor.draft/",
      "2. 若你的剪映版本无法识别该草稿，请打开 storyboard.csv，",
      "   按分镜表在剪映中手动建稿（或使用剪映「图文成片」粘贴台词）。",
      "3. 配音建议使用剪映内置「文本朗读」对字幕轨一键生成。",
      ...(copiedSources.length > 0
        ? [
            "",
            "【你的原始视频素材】已复制到本目录的 source/ 子文件夹：",
            ...copiedSources.map((n) => `   - source/${n}`),
            "在剪映中将这些素材拖入视频轨，对照 storyboard.csv 的分镜进行剪辑。",
          ]
        : []),
    ].join("\n"),
    "utf-8"
  );

  return { draftDir, csvPath };
}

function sanitize(name: string): string {
  return name.replace(/[\\/:*?"<>|\s]+/g, "-").slice(0, 60);
}

function csvCell(value: unknown): string {
  const s = String(value ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
