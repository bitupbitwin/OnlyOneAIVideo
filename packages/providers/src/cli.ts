import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { GenerateRequest, GenerateResult, ProviderRow, ProviderStatus } from "@amp/shared";
import type { Provider } from "@amp/core";

/**
 * CLI 适配器：以子进程执行用户配置的命令模板。
 *
 * 支持占位符：
 *   {PROMPT}       提示词（shell 安全转义后内联）
 *   {PROMPT_FILE}  提示词写入临时文件后传路径（推荐，长提示词/避免转义问题）
 *   {OUTPUT_FILE}  期望 CLI 把结果写入该文件；存在时优先读取该文件而非 stdout
 *   {TMP_DIR}      本次调用的临时目录绝对路径（prompt.txt / image-N 所在；适合 agy --add-dir）
 */
export function createCliProvider(row: ProviderRow): Provider {
  const command: string = row.config.command;

  return {
    row,

    async generate(req: GenerateRequest, onChunk?: (chunk: string) => void): Promise<GenerateResult> {
      if (!command) throw new Error(`CLI 引擎 ${row.id} 未配置 command`);

      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "amp-cli-"));
      const promptFile = path.join(tmpDir, "prompt.txt");
      const outputFile = path.join(tmpDir, "output.txt");
      const imageRefs: string[] = [];
      const imageArgs: string[] = [];
      const stagedInputs = new Set<string>();
      const mediaRefs: string[] = [];
      if (row.config.mediaReferences) {
        for (let i = 0; i < (req.images?.length ?? 0); i++) {
          const source = req.images![i];
          const name = `input-image-${i + 1}${path.extname(source).toLowerCase() || ".jpg"}`;
          const target = path.join(tmpDir, name);
          fs.copyFileSync(source, target);
          stagedInputs.add(target);
          mediaRefs.push(`Input image ${i + 1}: ${name}`);
        }
        for (let i = 0; i < (req.videos?.length ?? 0); i++) {
          const source = req.videos![i];
          const name = `input-video-${i + 1}${path.extname(source).toLowerCase() || ".mp4"}`;
          const target = path.join(tmpDir, name);
          fs.copyFileSync(source, target);
          stagedInputs.add(target);
          mediaRefs.push(`Input video ${i + 1}: ${name}`);
        }
      } else if (row.config.imageReferences && req.images?.length) {
        for (let i = 0; i < req.images.length; i++) {
          const ext = path.extname(req.images[i]).toLowerCase() || ".jpg";
          const name = `image-${i + 1}${ext}`;
          const target = path.join(tmpDir, name);
          fs.copyFileSync(req.images[i], target);
          stagedInputs.add(target);
          imageRefs.push(`@${name}`);
          imageArgs.push(`-i ${quote(name)}`);
        }
      }
      if (row.config.imageArguments && req.images?.length && imageArgs.length === 0) {
        for (let i = 0; i < req.images.length; i++) {
          const ext = path.extname(req.images[i]).toLowerCase() || ".jpg";
          const name = `image-${i + 1}${ext}`;
          const target = path.join(tmpDir, name);
          fs.copyFileSync(req.images[i], target);
          stagedInputs.add(target);
          imageArgs.push(`-i ${quote(name)}`);
        }
      }

      const mediaTask = req.stepType === "cover" || req.stepType === "frames" || req.stepType === "video" || req.stepType === "image-to-video";
      const prompt = [
        req.prompt,
        ...mediaRefs,
        ...(row.config.collectMediaOutput && mediaTask
          ? ["Generate the requested media and save the final file or files directly in the current working directory. Do not only return links."]
          : []),
      ].join("\n\n");
      fs.writeFileSync(promptFile, prompt, "utf-8");

      const usesOutputFile = command.includes("{OUTPUT_FILE}");
      const cmd = command
        .replaceAll("{PROMPT_FILE}", quote(promptFile))
        .replaceAll("{OUTPUT_FILE}", quote(outputFile))
        .replaceAll("{TMP_DIR}", quote(tmpDir))
        .replaceAll("{IMAGE_REFS}", imageRefs.join(" "))
        .replaceAll("{IMAGE_ARGS}", imageArgs.join(" "))
        .replaceAll("{PROMPT}", quote(req.prompt));

      try {
        const { stdout } = await run(cmd, req.timeoutMs, row.config.useTempCwd ? tmpDir : row.config.cwd, onChunk);
        if (row.config.collectMediaOutput && mediaTask && req.outDir) {
          const isImageTask = req.stepType === "cover" || req.stepType === "frames";
          const files = collectMediaFiles(tmpDir, stagedInputs, isImageTask ? IMAGE_EXTENSIONS : VIDEO_EXTENSIONS);
          if (files.length > 0) {
            fs.mkdirSync(req.outDir, { recursive: true });
            const copied = files.map((file, index) => {
              const target = path.join(req.outDir!, `${safeName(req.taskId)}-${index + 1}${path.extname(file).toLowerCase()}`);
              fs.copyFileSync(file, target);
              return target;
            });
            if (isImageTask) return { kind: "images", files: copied };
            return { kind: "videos", files: copied };
          }
        }
        if (usesOutputFile && fs.existsSync(outputFile)) {
          return { kind: "text", text: fs.readFileSync(outputFile, "utf-8") };
        }
        return { kind: "text", text: stdout };
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    },

    async healthCheck(): Promise<ProviderStatus> {
      const healthCommand: string = row.config.healthCommand || `${(command || "").split(/\s+/)[0]} --version`;
      try {
        const { stdout } = await run(healthCommand, 15_000, row.config.cwd);
        const version = stdout.trim().split("\n")[0] || "可用";
        return { ok: true, detail: row.config.healthNote ? `${version} · ${row.config.healthNote}` : version };
      } catch (err: any) {
        return { ok: false, detail: err?.message ?? String(err) };
      }
    },
  };
}

function run(
  cmd: string,
  timeoutMs: number,
  cwd?: string,
  onChunk?: (chunk: string) => void
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, { shell: true, cwd });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`CLI 执行超时（${Math.round(timeoutMs / 1000)}s）`));
    }, timeoutMs);

    child.stdout.on("data", (buf: Buffer) => {
      const text = buf.toString("utf-8");
      stdout += text;
      onChunk?.(text);
    });
    child.stderr.on("data", (buf: Buffer) => {
      stderr += buf.toString("utf-8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`CLI 退出码 ${code}：${stderr.slice(-800) || stdout.slice(-800)}`));
    });
  });
}

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".webm", ".mkv"]);

function collectMediaFiles(root: string, excluded: Set<string>, extensions: Set<string>): string[] {
  const files: string[] = [];
  const visit = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (!excluded.has(file) && extensions.has(path.extname(file).toLowerCase())) {
        files.push(file);
      }
    }
  };
  visit(root);
  return files;
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-");
}

/** POSIX shell 单引号转义；Windows 下建议使用 {PROMPT_FILE} */
function quote(value: string): string {
  if (process.platform === "win32") return `"${value.replace(/"/g, '""')}"`;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
