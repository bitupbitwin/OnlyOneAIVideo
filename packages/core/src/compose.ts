import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const requireCjs = createRequire(import.meta.url);

const FPS = 30;
const WIDTH = 1080;
const HEIGHT = 1920;
const SEGMENT_TIMEOUT_MS = 5 * 60 * 1000;
const FINAL_TIMEOUT_MS = 10 * 60 * 1000;
const STDERR_TAIL_BYTES = 8 * 1024;

export function ffmpegPath(): string {
  const env = process.env.FFMPEG_PATH?.trim();
  if (env) return env;
  try {
    const p = requireCjs("ffmpeg-static") as string | null;
    if (p && fs.existsSync(p)) return p;
  } catch {
    // 包不存在则回落 PATH
  }
  return "ffmpeg";
}

export function ffprobePath(): string {
  const env = process.env.FFPROBE_PATH?.trim();
  if (env) return env;
  try {
    const p = (requireCjs("ffprobe-static") as { path?: string })?.path;
    if (p && fs.existsSync(p)) return p;
  } catch {
    // 包不存在则回落 PATH
  }
  return "ffprobe";
}

/** ffprobe 实测媒体时长（秒）；探测失败返回 undefined */
export async function probeDurationSec(file: string): Promise<number | undefined> {
  return new Promise((resolve) => {
    const child = spawn(ffprobePath(), [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      file,
    ]);
    let out = "";
    child.stdout.on("data", (b: Buffer) => (out += b.toString("utf-8")));
    child.on("error", () => resolve(undefined));
    child.on("close", (code) => {
      const value = Number.parseFloat(out.trim());
      resolve(code === 0 && Number.isFinite(value) && value > 0 ? value : undefined);
    });
  });
}

export interface ComposeSceneInput {
  index: number;
  source: "generated" | "footage" | "video";
  /** generated：静帧图片 */
  framePath?: string;
  /** footage：素材视频 + 截取区间 */
  footagePath?: string;
  /** video：AI 生成的带声音短视频 */
  videoPath?: string;
  clipStart?: number;
  clipEnd?: number;
  audioPath?: string;
  subtitle: string;
  /** TTS 音频实测时长 */
  ttsDurSec: number;
  /** 分段总时长 = ttsDurSec + gap（主时钟） */
  durationSec: number;
}

export interface ComposeOptions {
  scenes: ComposeSceneInput[];
  /** compose/vN 输出目录 */
  outDir: string;
  bgmPath?: string;
  /** ASS 字幕字体名（Windows libass 走 DirectWrite 系统字体） */
  fontName?: string;
  onPhase?: (phase: string, pct: number, message?: string) => void;
}

export interface ComposeResultInfo {
  masterPath: string;
  segmentPaths: string[];
  assPath: string;
  totalDurSec: number;
}

/**
 * Hard-cut 合成（实现设计 §5.3 模型 A）：
 * 每镜分段渲染（时长 = TTS 实测 + gap）→ concat 硬切 → 烧录 ASS 字幕（累计时间码）→ 可选 BGM 混音。
 */
export async function composeMaster(opts: ComposeOptions): Promise<ComposeResultInfo> {
  const { scenes, outDir, onPhase } = opts;
  if (scenes.length === 0) throw new Error("没有可合成的镜头");
  const segmentsDir = path.join(outDir, "segments");
  fs.mkdirSync(segmentsDir, { recursive: true });

  const segmentPaths: string[] = [];
  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    const segPath = path.join(segmentsDir, `scene-${String(scene.index).padStart(2, "0")}.mp4`);
    onPhase?.("segment", (i / scenes.length) * 70, `渲染镜头 ${scene.index}/${scenes.length}`);
    await renderSegment(scene, segPath, outDir, (sec) => {
      const frac = Math.min(1, sec / Math.max(0.1, scene.durationSec));
      onPhase?.("segment", ((i + frac) / scenes.length) * 70, `渲染镜头 ${scene.index}/${scenes.length}`);
    });
    segmentPaths.push(segPath);
  }

  onPhase?.("concat", 72, "拼接分段");
  const concatPath = path.join(outDir, "concat.mp4");
  const listPath = path.join(outDir, "segments.txt");
  fs.writeFileSync(listPath, segmentPaths.map((p) => `file '${p.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`).join("\n"), "utf-8");
  await runFfmpeg(["-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", concatPath], {
    timeoutMs: SEGMENT_TIMEOUT_MS,
    logDir: outDir,
  });

  onPhase?.("subtitles", 76, "生成字幕");
  const assPath = path.join(outDir, "subtitles.ass");
  fs.writeFileSync(assPath, buildAss(scenes, opts.fontName ?? process.env.AMP_SUBTITLE_FONT ?? "Microsoft YaHei"), "utf-8");

  const totalDurSec = scenes.reduce((sum, s) => sum + s.durationSec, 0);
  const masterPath = path.join(outDir, "master.mp4");
  onPhase?.("finalize", 80, "烧录字幕与混音");
  await renderFinal(concatPath, assPath, masterPath, totalDurSec, opts, (sec) => {
    onPhase?.("finalize", 80 + Math.min(1, sec / Math.max(0.1, totalDurSec)) * 20, "烧录字幕与混音");
  });

  fs.rmSync(concatPath, { force: true });
  onPhase?.("done", 100, "母版合成完成");
  return { masterPath, segmentPaths, assPath, totalDurSec: Math.round(totalDurSec * 100) / 100 };
}

async function renderSegment(
  scene: ComposeSceneInput,
  segPath: string,
  logDir: string,
  onTime: (sec: number) => void
) {
  const dur = scene.durationSec;
  const durArg = dur.toFixed(3);
  const audioChain = `[1:a]aresample=44100,apad=whole_dur=${durArg}[a]`;

  let args: string[];
  if (scene.source === "video") {
    if (!scene.videoPath) throw new Error(`镜头 ${scene.index} 缺少生成视频文件`);
    const filter =
      `[0:v]fps=${FPS},scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase,` +
      `crop=${WIDTH}:${HEIGHT},format=yuv420p[v]`;
    args = [
      "-i", scene.videoPath,
      "-filter_complex", filter,
      "-map", "[v]", "-map", "0:a?",
    ];
  } else if (scene.source === "footage") {
    if (!scene.footagePath) throw new Error(`镜头 ${scene.index} 缺少实拍素材路径`);
    const clipStart = Math.max(0, scene.clipStart ?? 0);
    const clipEnd = scene.clipEnd && scene.clipEnd > clipStart ? scene.clipEnd : clipStart + dur;
    const avail = clipEnd - clipStart;
    // 素材不够长：最多慢放到 0.9×，仍不足冻结尾帧补齐（实现设计 §5.4）
    const slow = avail < dur ? Math.max(0.9, avail / dur) : 1;
    const setpts = slow < 1 ? `setpts=PTS/${slow.toFixed(4)},` : "";
    const filter =
      `[0:v]${setpts}fps=${FPS},split[b0][f0];` +
      `[b0]scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase,crop=${WIDTH}:${HEIGHT},boxblur=20:2[bg];` +
      `[f0]scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=decrease[fg];` +
      `[bg][fg]overlay=(W-w)/2:(H-h)/2,tpad=stop_mode=clone:stop_duration=${durArg},format=yuv420p[v];` +
      // M3：实拍镜头静音原声，只保留旁白（duck/keep 模式在 M4 与 B 模式一起做）
      audioChain;
    args = [
      "-ss", clipStart.toFixed(3), "-t", Math.max(avail, 0.2).toFixed(3), "-i", scene.footagePath,
      "-i", scene.audioPath!,
      "-filter_complex", filter,
      "-map", "[v]", "-map", "[a]",
    ];
  } else {
    if (!scene.framePath) throw new Error(`镜头 ${scene.index} 缺少画面文件`);
    const frames = Math.max(1, Math.round(dur * FPS));
    // 2× 预放大再 zoompan，消除缓推抖动（Ken Burns 1.0→1.08）
    const filter =
      `[0:v]scale=${WIDTH * 2}:${HEIGHT * 2}:force_original_aspect_ratio=increase,crop=${WIDTH * 2}:${HEIGHT * 2},` +
      `zoompan=z='1+0.08*on/${frames}':x='(iw-iw/zoom)/2':y='(ih-ih/zoom)/2':d=${frames}:s=${WIDTH}x${HEIGHT}:fps=${FPS},` +
      `format=yuv420p[v];` +
      audioChain;
    args = [
      "-i", scene.framePath,
      "-i", scene.audioPath!,
      "-filter_complex", filter,
      "-map", "[v]", "-map", "[a]",
    ];
  }

  args.push(
    "-t", durArg,
    "-r", String(FPS),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "192k", "-ar", "44100", "-ac", "2",
    "-movflags", "+faststart",
    segPath
  );
  await runFfmpeg(args, { timeoutMs: SEGMENT_TIMEOUT_MS, logDir, onTime });
}

async function renderFinal(
  concatPath: string,
  assPath: string,
  masterPath: string,
  totalDurSec: number,
  opts: ComposeOptions,
  onTime: (sec: number) => void
) {
  const subFilter = `subtitles=filename='${escapeFilterPath(assPath)}'`;
  const bgm = opts.bgmPath && fs.existsSync(opts.bgmPath) ? opts.bgmPath : undefined;

  let args: string[];
  if (bgm) {
    const fadeOutStart = Math.max(0, totalDurSec - 1.5);
    const filter =
      `[0:v]${subFilter}[v];` +
      `[1:a]atrim=0:${totalDurSec.toFixed(3)},volume=0.12,afade=t=in:st=0:d=1,afade=t=out:st=${fadeOutStart.toFixed(3)}:d=1.5[b];` +
      `[0:a][b]amix=inputs=2:duration=first:dropout_transition=0[a]`;
    args = [
      "-i", concatPath,
      "-stream_loop", "-1", "-i", bgm,
      "-filter_complex", filter,
      "-map", "[v]", "-map", "[a]",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "192k",
      "-movflags", "+faststart",
      masterPath,
    ];
  } else {
    args = [
      "-i", concatPath,
      "-vf", subFilter,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
      "-c:a", "copy",
      "-movflags", "+faststart",
      masterPath,
    ];
  }
  await runFfmpeg(args, { timeoutMs: FINAL_TIMEOUT_MS, logDir: path.dirname(masterPath), onTime });
}

/** ASS 字幕：与分段同一套累计时间码（§5.3），字幕只覆盖 ttsDur 段，不含 gap */
function buildAss(scenes: ComposeSceneInput[], fontName: string): string {
  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${WIDTH}`,
    `PlayResY: ${HEIGHT}`,
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Sub,${fontName},64,&H00FFFFFF,&H00FFFFFF,&H00141414,&H7F000000,1,0,0,0,100,100,0,0,1,3,1,2,60,60,300,1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
  const lines: string[] = [];
  let start = 0;
  for (const scene of scenes) {
    const text = scene.subtitle.replace(/[{}]/g, "").replace(/\r?\n/g, "\\N").trim();
    if (text) {
      lines.push(`Dialogue: 0,${assTime(start)},${assTime(start + scene.ttsDurSec)},Sub,,0,0,0,,${text}`);
    }
    start += scene.durationSec;
  }
  return header.concat(lines).join("\n") + "\n";
}

function assTime(sec: number): string {
  const totalCs = Math.max(0, Math.round(sec * 100));
  const cs = totalCs % 100;
  const s = Math.floor(totalCs / 100) % 60;
  const m = Math.floor(totalCs / 6000) % 60;
  const h = Math.floor(totalCs / 360000);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

/** Windows 路径进 filter 参数：反斜杠转正斜杠、盘符冒号转义 */
function escapeFilterPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

interface RunOptions {
  timeoutMs: number;
  /** 失败时写 ffmpeg-error.log 的目录 */
  logDir: string;
  onTime?: (sec: number) => void;
}

function runFfmpeg(args: string[], opts: RunOptions): Promise<void> {
  const fullArgs = ["-hide_banner", "-y", "-nostats", "-progress", "pipe:1", ...args];
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath(), fullArgs, { windowsHide: true });
    let stderrTail = "";
    let stdoutBuf = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`ffmpeg 执行超时（${Math.round(opts.timeoutMs / 1000)}s）`));
    }, opts.timeoutMs);

    child.stdout.on("data", (b: Buffer) => {
      stdoutBuf += b.toString("utf-8");
      let idx: number;
      while ((idx = stdoutBuf.indexOf("\n")) >= 0) {
        const line = stdoutBuf.slice(0, idx).trim();
        stdoutBuf = stdoutBuf.slice(idx + 1);
        const m = line.match(/^out_time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
        if (m) opts.onTime?.(Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]));
      }
    });
    child.stderr.on("data", (b: Buffer) => {
      stderrTail = (stderrTail + b.toString("utf-8")).slice(-STDERR_TAIL_BYTES);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`无法启动 ffmpeg（${ffmpegPath()}）：${err.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve();
      try {
        fs.appendFileSync(
          path.join(opts.logDir, "ffmpeg-error.log"),
          `\n===== ${new Date().toISOString()} exit=${code} =====\nffmpeg ${fullArgs.join(" ")}\n${stderrTail}\n`,
          "utf-8"
        );
      } catch {
        // 日志写失败不影响错误上抛
      }
      const brief = stderrTail.trim().split("\n").slice(-4).join("\n");
      reject(new Error(`ffmpeg 退出码 ${code}（详见 ffmpeg-error.log）：${brief}`));
    });
  });
}
