import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { GenerateRequest, GenerateResult, ProviderRow, ProviderStatus } from "@amp/shared";
import { ffmpegPath, type Provider } from "@amp/core";

/**
 * 文本 API 适配器：OpenAI 兼容的 /chat/completions 端点
 * （OpenAI / Anthropic 兼容网关 / 火山方舟 / Ollama 等均可）。
 */
export function createApiTextProvider(row: ProviderRow): Provider {
  const { baseUrl, apiKey, model, systemPrompt } = row.config;

  return {
    row,

    async generate(req: GenerateRequest): Promise<GenerateResult> {
      if (!baseUrl || !model) throw new Error(`引擎 ${row.id} 缺少 baseUrl/model 配置`);
      const messages: any[] = [];
      if (systemPrompt) messages.push({ role: "system", content: systemPrompt });

      // 视频理解使用本地 ffmpeg 均匀抽帧，再按兼容性最好的 image_url 视觉消息发送。
      // 这样不依赖各厂商尚未统一的 video_url 消息格式，也不会触发视频生成计费。
      const frameDir = req.videos?.length && row.config.videoVision
        ? fs.mkdtempSync(path.join(os.tmpdir(), "amp-video-vision-"))
        : undefined;
      const videoFrames: string[] = [];
      if (frameDir) {
        for (let index = 0; index < req.videos!.length; index++) {
          videoFrames.push(...await extractVideoFrames(req.videos![index], frameDir, index));
        }
      }

      // 多模态：附带图片时按 OpenAI vision 消息格式发送（需模型支持）。
      let userContent: any = req.prompt;
      const visualFiles = [...(req.images ?? []), ...videoFrames];
      if (visualFiles.length) {
        userContent = [
          { type: "text", text: videoFrames.length ? `${req.prompt}\n\n以下图片按时间顺序来自上传视频的抽帧，请结合前后帧理解动作、场景变化和视频内容。` : req.prompt },
          ...visualFiles.map((file) => ({
            type: "image_url",
            image_url: { url: toDataUrl(file) },
          })),
        ];
      }
      messages.push({ role: "user", content: userContent });

      try {
        const res = await fetchWithTimeout(`${trimSlash(baseUrl)}/chat/completions`, req.timeoutMs, {
          method: "POST",
          headers: headers(apiKey),
          body: JSON.stringify({ model, messages }),
        });
        const data: any = await res.json();
        const text = data?.choices?.[0]?.message?.content;
        if (typeof text !== "string") throw new Error(`API 返回异常: ${JSON.stringify(data).slice(0, 400)}`);
        return { kind: "text", text };
      } finally {
        if (frameDir) fs.rmSync(frameDir, { recursive: true, force: true });
      }
    },

    async healthCheck(): Promise<ProviderStatus> {
      if (!baseUrl || !model) return { ok: false, detail: "缺少 baseUrl/model 配置" };
      if (!apiKey) return { ok: false, detail: "未配置 apiKey" };
      try {
        const res = await fetchWithTimeout(`${trimSlash(baseUrl)}/chat/completions`, 30_000, {
          method: "POST",
          headers: headers(apiKey),
          body: JSON.stringify({ model, messages: [{ role: "user", content: "ping" }], max_tokens: 4 }),
        });
        return { ok: true, detail: `连通正常（HTTP ${res.status}）` };
      } catch (err: any) {
        return { ok: false, detail: err?.message ?? String(err) };
      }
    },
  };
}

function extractVideoFrames(video: string, outDir: string, videoIndex: number): Promise<string[]> {
  const pattern = path.join(outDir, `video-${videoIndex + 1}-%02d.jpg`);
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath(), [
      "-hide_banner", "-loglevel", "error", "-y", "-i", video,
      "-vf", "fps=1/4,scale='min(1280,iw)':-2", "-frames:v", "8", pattern,
    ], { windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`视频抽帧失败：${stderr.slice(-500)}`));
      const prefix = `video-${videoIndex + 1}-`;
      resolve(fs.readdirSync(outDir).filter((name) => name.startsWith(prefix)).sort().map((name) => path.join(outDir, name)));
    });
  });
}

function toDataUrl(file: string): string {
  const ext = path.extname(file).toLowerCase();
  const mime = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".webp" ? "image/webp" : "image/png";
  return `data:${mime};base64,${fs.readFileSync(file).toString("base64")}`;
}

export function headers(apiKey?: string): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) h["Authorization"] = `Bearer ${apiKey}`;
  return h;
}

export function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

export async function fetchWithTimeout(url: string, timeoutMs: number, init: RequestInit): Promise<Response> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${url}: ${body.slice(0, 400)}`);
  }
  return res;
}
