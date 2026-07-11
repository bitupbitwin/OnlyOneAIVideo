import fs from "node:fs";
import path from "node:path";
import type { GenerateRequest, GenerateResult, ProviderRow, ProviderStatus } from "@amp/shared";
import type { Provider } from "@amp/core";
import { fetchWithTimeout, headers, trimSlash } from "./apiText.js";

/**
 * 图生视频适配器（异步：提交任务 → 轮询取结果 → 下载）。
 * 默认按火山方舟（即梦视频/Seedance）风格的异步 API 实现，路径/字段可在 config 中校准，
 * 以适配可灵 / Runway 等其它视频生成服务。config.mock=true 时本地写占位文件用于演示。
 *
 * 请求：req.images[0] 为输入图片，req.prompt 为运动/镜头描述，req.imageSize 决定比例。
 */
export function createApiVideoProvider(row: ProviderRow): Provider {
  const c = row.config;
  const submitPath: string = c.submitPath || "/contents/generations/tasks";
  const statusPath: string = c.statusPath || "/contents/generations/tasks/{id}";
  const pollInterval = Number(c.pollIntervalMs) || 6000;
  const pollTimeout = Number(c.pollTimeoutMs) || 5 * 60 * 1000;

  return {
    row,

    async generate(req: GenerateRequest, onChunk?: (s: string) => void): Promise<GenerateResult> {
      const outDir = req.outDir ?? process.cwd();
      fs.mkdirSync(outDir, { recursive: true });

      if (c.mock) {
        const file = path.join(outDir, `clip_${Date.now()}.mp4`);
        fs.writeFileSync(file, "MOCK-VIDEO-PLACEHOLDER（演示占位：配置 api-video 引擎并填 key 后产出真实视频）");
        return { kind: "videos", files: [file] };
      }
      if (!c.baseUrl || !c.model) throw new Error(`引擎 ${row.id} 缺少 baseUrl/model 配置`);
      const inputImage = req.images?.[0];
      const inputVideo = req.videos?.[0];
      if (!inputImage && !inputVideo && !c.allowTextToVideo) throw new Error("该视频引擎需要输入图片或视频");

      if (c.apiStyle === "xai") {
        const body: any = {
          model: c.model,
          prompt: req.prompt,
          duration: req.durationSec ?? c.duration ?? 5,
          aspect_ratio: req.aspectRatio ?? c.aspectRatio ?? req.imageSize ?? "9:16",
          resolution: req.resolution ?? c.resolution ?? "480p",
        };
        if (inputImage) body.image = { url: toDataUrl(inputImage) };
        onChunk?.("[Grok 视频] 提交生成任务…\n");
        const submitted = await fetchWithTimeout(`${trimSlash(c.baseUrl)}/videos/generations`, 60_000, {
          method: "POST",
          headers: headers(c.apiKey),
          body: JSON.stringify(body),
        });
        const requestId = (await submitted.json() as any)?.request_id;
        if (!requestId) throw new Error("Grok 视频提交未返回 request_id");
        const deadline = Date.now() + pollTimeout;
        let videoUrl = "";
        while (Date.now() < deadline) {
          await sleep(pollInterval);
          const response = await fetchWithTimeout(`${trimSlash(c.baseUrl)}/videos/${requestId}`, 60_000, {
            headers: headers(c.apiKey),
          });
          const state: any = await response.json();
          onChunk?.(`[Grok 视频] 状态：${state.status}\n`);
          if (state.status === "done") { videoUrl = state?.video?.url ?? ""; break; }
          if (state.status === "failed" || state.status === "expired") throw new Error(`Grok 视频生成${state.status}`);
        }
        if (!videoUrl) throw new Error("Grok 视频生成超时或未返回地址");
        const file = path.join(outDir, `clip_${Date.now()}.mp4`);
        const downloaded = await fetch(videoUrl, { signal: AbortSignal.timeout(180_000) });
        if (!downloaded.ok) throw new Error(`视频下载失败：HTTP ${downloaded.status}`);
        fs.writeFileSync(file, Buffer.from(await downloaded.arrayBuffer()));
        return { kind: "videos", files: [file] };
      }

      if (c.apiStyle === "dashscope") {
        const selectedModel = inputImage ? (c.imageModel || c.model) : (c.textModel || c.model);
        const input: any = { prompt: req.prompt };
        if (inputImage) input.img_url = toDataUrl(inputImage);
        const body = {
          model: selectedModel,
          input,
          parameters: {
            size: videoPixelSize(req.aspectRatio || req.imageSize || "9:16", req.resolution || "720p").replace("x", "*"),
            duration: req.durationSec ?? 5,
            prompt_extend: true,
          },
        };
        onChunk?.("[Wan 视频] 提交生成任务…\n");
        const submitted = await fetchWithTimeout(`${trimSlash(c.baseUrl)}/services/aigc/video-generation/video-synthesis`, 60_000, {
          method: "POST",
          headers: { ...headers(c.apiKey), "X-DashScope-Async": "enable" },
          body: JSON.stringify(body),
        });
        const taskId = (await submitted.json() as any)?.output?.task_id;
        if (!taskId) throw new Error("Wan 视频任务未返回 task_id");
        const deadline = Date.now() + pollTimeout;
        while (Date.now() < deadline) {
          await sleep(pollInterval);
          const response = await fetchWithTimeout(`${trimSlash(c.baseUrl)}/tasks/${taskId}`, 60_000, { headers: headers(c.apiKey) });
          const state: any = await response.json();
          const status = state?.output?.task_status;
          onChunk?.(`[Wan 视频] 状态：${status}\n`);
          if (status === "SUCCEEDED") {
            const url = state?.output?.video_url;
            if (!url) throw new Error("Wan 视频任务成功但未返回 video_url");
            const file = path.join(outDir, `clip_${Date.now()}.mp4`);
            const downloaded = await fetch(url, { signal: AbortSignal.timeout(180_000) });
            if (!downloaded.ok) throw new Error(`视频下载失败：HTTP ${downloaded.status}`);
            fs.writeFileSync(file, Buffer.from(await downloaded.arrayBuffer()));
            return { kind: "videos", files: [file] };
          }
          if (status === "FAILED" || status === "CANCELED" || status === "UNKNOWN") throw new Error(`Wan 视频生成失败：${state?.message ?? status}`);
        }
        throw new Error("Wan 视频生成超时");
      }

      if (c.apiStyle === "minimax") {
        const body: any = {
          model: c.model,
          prompt: req.prompt,
          duration: req.durationSec ?? 10,
          resolution: String(req.resolution ?? "1080p").toUpperCase(),
        };
        if (inputImage) body.first_frame_image = toDataUrl(inputImage);
        const submitted = await fetchWithTimeout(`${trimSlash(c.baseUrl)}/video_generation`, 60_000, {
          method: "POST", headers: headers(c.apiKey), body: JSON.stringify(body),
        });
        const taskId = (await submitted.json() as any)?.task_id;
        if (!taskId) throw new Error("MiniMax 视频任务未返回 task_id");
        const deadline = Date.now() + pollTimeout;
        while (Date.now() < deadline) {
          await sleep(pollInterval);
          const response = await fetchWithTimeout(`${trimSlash(c.baseUrl)}/query/video_generation?task_id=${encodeURIComponent(taskId)}`, 60_000, { headers: headers(c.apiKey) });
          const state: any = await response.json();
          onChunk?.(`[MiniMax 视频] 状态：${state?.status}\n`);
          if (state?.status === "Success") {
            const fileId = state?.file_id;
            const fileResponse = await fetchWithTimeout(`${trimSlash(c.baseUrl)}/files/retrieve?file_id=${encodeURIComponent(fileId)}`, 60_000, { headers: headers(c.apiKey) });
            const fileData: any = await fileResponse.json();
            return { kind: "videos", files: [await downloadVideo(fileData?.file?.download_url, outDir)] };
          }
          if (state?.status === "Fail") throw new Error(`MiniMax 视频生成失败：${state?.base_resp?.status_msg ?? "未知错误"}`);
        }
        throw new Error("MiniMax 视频生成超时");
      }

      if (c.apiStyle === "vidu") {
        const endpoint = inputImage ? "/img2video" : "/text2video";
        const body: any = {
          model: c.model,
          prompt: req.prompt,
          duration: req.durationSec ?? 5,
          resolution: String(req.resolution ?? "720p").toLowerCase(),
          aspect_ratio: req.aspectRatio ?? "9:16",
          movement_amplitude: "auto",
          audio: true,
        };
        if (inputImage) body.images = [toDataUrl(inputImage)];
        const viduHeaders = { "Content-Type": "application/json", Authorization: `Token ${c.apiKey}` };
        const submitted = await fetchWithTimeout(`${trimSlash(c.baseUrl)}${endpoint}`, 60_000, {
          method: "POST", headers: viduHeaders, body: JSON.stringify(body),
        });
        const taskId = (await submitted.json() as any)?.task_id;
        if (!taskId) throw new Error("Vidu 视频任务未返回 task_id");
        const deadline = Date.now() + pollTimeout;
        while (Date.now() < deadline) {
          await sleep(pollInterval);
          const response = await fetchWithTimeout(`${trimSlash(c.baseUrl)}/tasks/${taskId}/creations`, 60_000, { headers: viduHeaders });
          const state: any = await response.json();
          onChunk?.(`[Vidu 视频] 状态：${state?.state}\n`);
          if (state?.state === "success") return { kind: "videos", files: [await downloadVideo(state?.creations?.[0]?.url, outDir)] };
          if (state?.state === "failed") throw new Error(`Vidu 视频生成失败：${state?.err_code ?? "未知错误"}`);
        }
        throw new Error("Vidu 视频生成超时");
      }

      // 1) 提交任务
      const content: any[] = [{ type: "text", text: req.prompt }];
      if (inputImage) {
        content.push({ type: "image_url", image_url: { url: toDataUrl(inputImage) }, role: c.imageRole || "first_frame" });
      }
      if (inputVideo) {
        content.push({ type: "video_url", video_url: { url: toDataUrl(inputVideo) }, role: c.videoRole || "reference_video" });
      }
      const body: any = { model: c.model, content };
      if (req.aspectRatio || req.imageSize) body.ratio = req.aspectRatio || req.imageSize;
      if (req.resolution) body.resolution = req.resolution;
      if (req.durationSec) body.duration = req.durationSec;
      if (typeof c.generateAudio === "boolean") body.generate_audio = c.generateAudio;
      onChunk?.("[图生视频] 提交任务…\n");
      const subRes = await fetchWithTimeout(`${trimSlash(c.baseUrl)}${submitPath}`, 60_000, {
        method: "POST",
        headers: headers(c.apiKey),
        body: JSON.stringify(body),
      });
      const subData: any = await subRes.json();
      const taskId = subData?.id ?? subData?.task_id ?? subData?.data?.id;
      if (!taskId) throw new Error(`提交未返回任务 id：${JSON.stringify(subData).slice(0, 300)}`);

      // 2) 轮询
      const deadline = Date.now() + pollTimeout;
      let videoUrl = "";
      while (Date.now() < deadline) {
        await sleep(pollInterval);
        const stRes = await fetchWithTimeout(
          `${trimSlash(c.baseUrl)}${statusPath.replace("{id}", taskId)}`,
          60_000,
          { headers: headers(c.apiKey) }
        );
        const st: any = await stRes.json();
        const status = st?.status ?? st?.data?.status;
        onChunk?.(`[图生视频] 状态：${status}\n`);
        if (status === "succeeded" || status === "success" || status === "done") {
          videoUrl = st?.content?.video_url ?? st?.data?.content?.video_url ?? st?.data?.video_url ?? st?.video?.url ?? st?.video_url ?? "";
          break;
        }
        if (status === "failed" || status === "error") {
          throw new Error(`视频生成失败：${JSON.stringify(st).slice(0, 300)}`);
        }
      }
      if (!videoUrl) throw new Error("视频生成超时或未返回视频地址");

      // 3) 下载
      const file = path.join(outDir, `clip_${Date.now()}.mp4`);
      const vr = await fetch(videoUrl, { signal: AbortSignal.timeout(120_000) });
      if (!vr.ok) throw new Error(`视频下载失败：HTTP ${vr.status}`);
      fs.writeFileSync(file, Buffer.from(await vr.arrayBuffer()));
      return { kind: "videos", files: [file] };
    },

    async healthCheck(): Promise<ProviderStatus> {
      if (c.mock) return { ok: true, detail: "演示模式（本地写占位视频文件）" };
      if (!c.baseUrl || !c.model) return { ok: false, detail: "缺少 baseUrl/model 配置" };
      if (!c.apiKey) return { ok: false, detail: "未配置 apiKey" };
      return { ok: true, detail: "配置完整（实际连通性以首次生成为准）" };
    },
  };
}

function toDataUrl(file: string): string {
  const ext = path.extname(file).toLowerCase();
  const mime = ext === ".jpg" || ext === ".jpeg"
    ? "image/jpeg"
    : ext === ".webp"
      ? "image/webp"
      : ext === ".mp4"
        ? "video/mp4"
        : ext === ".mov"
          ? "video/quicktime"
          : "image/png";
  return `data:${mime};base64,${fs.readFileSync(file).toString("base64")}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function videoPixelSize(aspectRatio: string, resolution: string): string {
  const short = resolution === "540p" ? 480 : resolution === "720p" ? 720 : 1080;
  const [w, h] = aspectRatio.split(":").map(Number);
  if (!w || !h || w === h) return `${short}x${short}`;
  return w > h ? `${Math.round(short * w / h)}x${short}` : `${short}x${Math.round(short * h / w)}`;
}

async function downloadVideo(url: string | undefined, outDir: string): Promise<string> {
  if (!url) throw new Error("视频任务成功但没有返回下载地址");
  const response = await fetch(url, { signal: AbortSignal.timeout(180_000) });
  if (!response.ok) throw new Error(`视频下载失败：HTTP ${response.status}`);
  const file = path.join(outDir, `clip_${Date.now()}.mp4`);
  fs.writeFileSync(file, Buffer.from(await response.arrayBuffer()));
  return file;
}
