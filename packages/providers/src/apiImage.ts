import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import type { GenerateRequest, GenerateResult, ProviderRow, ProviderStatus } from "@amp/shared";
import type { Provider } from "@amp/core";
import { fetchWithTimeout, headers, trimSlash } from "./apiText.js";

/**
 * 出图 API 适配器：OpenAI 兼容的 /images/generations 端点。
 * 覆盖 gpt-image-1、火山方舟（即梦/Seedream，OpenAI 兼容）、SD 兼容网关、xAI Grok 出图。
 * config.mock = true 时本地生成纯色占位图（无需密钥，便于演示与测试）。
 * config.overlayText = true 时启用「底图 + 程序叠字」：让模型只出无字底图，
 *   再用 sharp 把标题文字精确叠加到底图上（中文 100% 正确，适合 Grok 等中文渲染弱的模型）。
 */
export function createApiImageProvider(row: ProviderRow): Provider {
  const { baseUrl, apiKey, model, size = "1024x1024", mock, overlayText, aspectRatio, resolution } = row.config;
  const defaultN = row.config.n ?? 3;

  return {
    row,

    async generate(req: GenerateRequest): Promise<GenerateResult> {
      const outDir = req.outDir ?? process.cwd();
      fs.mkdirSync(outDir, { recursive: true });

      // 叠字模式：要求底图不要带任何文字，留出干净版面
      let prompt = req.prompt;
      if (overlayText) {
        prompt +=
          "\n\nIMPORTANT: Do NOT render any text, letters or words in the image. " +
          "Produce a clean background/illustration only, leaving a clear central area for a title to be added later.";
      }

      const n = req.imageCount ?? defaultN;
      const reqSize = req.imageSize || size; // 调用方指定则按该尺寸直接生成（不靠裁剪）
      let files: string[];
      if (mock) {
        files = await mockImages(outDir, Number(n) || 2, reqSize);
      } else if (row.config.apiStyle === "dashscope") {
        if (!baseUrl || !model || !apiKey) throw new Error(`引擎 ${row.id} 缺少 baseUrl/model/apiKey 配置`);
        const submit = await fetchWithTimeout(`${trimSlash(baseUrl)}/services/aigc/image-generation/generation`, req.timeoutMs, {
          method: "POST",
          headers: { ...headers(apiKey), "X-DashScope-Async": "enable" },
          body: JSON.stringify({
            model,
            input: { messages: [{ role: "user", content: [{ text: prompt }] }] },
            parameters: { n, size: reqSize.replace("x", "*"), prompt_extend: true },
          }),
        });
        const taskId = (await submit.json() as any)?.output?.task_id;
        if (!taskId) throw new Error("阿里云百炼出图任务未返回 task_id");
        const result = await pollDashScopeTask(baseUrl, apiKey, taskId, req.timeoutMs);
        const urls = (result?.output?.choices ?? []).flatMap((choice: any) => choice?.message?.content ?? []).map((item: any) => item?.image).filter(Boolean);
        files = await downloadImages(urls, outDir);
      } else {
        if (!baseUrl || !model) throw new Error(`引擎 ${row.id} 缺少 baseUrl/model 配置`);
        // xAI Grok 等不使用 OpenAI 的 size 字段，可通过各自字段请求原生比例。
        const body: Record<string, any> = { model, prompt, n, response_format: "b64_json" };
        if (!row.config.noSize) body.size = reqSize;
        if (req.aspectRatio || aspectRatio) body.aspect_ratio = req.aspectRatio || aspectRatio;
        if (req.resolution || resolution) body.resolution = req.resolution || resolution;
        const res = await fetchWithTimeout(`${trimSlash(baseUrl)}/images/generations`, req.timeoutMs, {
          method: "POST",
          headers: headers(apiKey),
          body: JSON.stringify(body),
        });
        const data: any = await res.json();
        const items: any[] = data?.data ?? [];
        if (items.length === 0) throw new Error(`出图 API 未返回图片: ${JSON.stringify(data).slice(0, 400)}`);

        files = [];
        for (let i = 0; i < items.length; i++) {
          const file = path.join(outDir, `cover_${Date.now()}_${i + 1}.png`);
          if (items[i].b64_json) {
            fs.writeFileSync(file, Buffer.from(items[i].b64_json, "base64"));
          } else if (items[i].url) {
            const imgRes = await fetch(items[i].url, { signal: AbortSignal.timeout(60_000) });
            fs.writeFileSync(file, Buffer.from(await imgRes.arrayBuffer()));
          } else {
            continue;
          }
          files.push(file);
        }
        if (files.length === 0) throw new Error("出图 API 返回数据中没有可用的图片内容");
      }

      // 叠字：把标题文字精确叠加到每张底图上
      if (overlayText && req.overlayText?.trim()) {
        for (const file of files) await overlayTitle(file, req.overlayText.trim());
      }
      return { kind: "images", files };
    },

    async healthCheck(): Promise<ProviderStatus> {
      if (mock) return { ok: true, detail: "演示模式（本地生成占位图）" };
      if (!baseUrl || !model) return { ok: false, detail: "缺少 baseUrl/model 配置" };
      if (!apiKey) return { ok: false, detail: "未配置 apiKey" };
      return { ok: true, detail: "配置完整（实际连通性以首次出图为准）" };
    },
  };
}

async function pollDashScopeTask(baseUrl: string, apiKey: string, taskId: string, timeoutMs: number): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const response = await fetchWithTimeout(`${trimSlash(baseUrl)}/tasks/${taskId}`, 30_000, { headers: headers(apiKey) });
    const data: any = await response.json();
    const status = data?.output?.task_status;
    if (status === "SUCCEEDED") return data;
    if (status === "FAILED" || status === "CANCELED" || status === "UNKNOWN") throw new Error(`阿里云百炼出图失败：${data?.message ?? status}`);
  }
  throw new Error("阿里云百炼出图超时");
}

async function downloadImages(urls: string[], outDir: string): Promise<string[]> {
  const files: string[] = [];
  for (let index = 0; index < urls.length; index++) {
    const response = await fetch(urls[index], { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`图片下载失败：HTTP ${response.status}`);
    const file = path.join(outDir, `image_${Date.now()}_${index + 1}.png`);
    fs.writeFileSync(file, Buffer.from(await response.arrayBuffer()));
    files.push(file);
  }
  if (!files.length) throw new Error("阿里云百炼任务成功但没有返回图片地址");
  return files;
}

/**
 * 把标题文字叠加到底图中央：半透明深色衬底 + 大号加粗白字 + 描边，保证手机小屏可读。
 * 文字居中放置，便于后续裁切成各平台比例时主体不被切掉。直接覆盖写回原文件。
 */
async function overlayTitle(file: string, title: string): Promise<void> {
  const meta = await sharp(file).metadata();
  const W = meta.width ?? 1024;
  const H = meta.height ?? 1024;

  // 按字符数折行（中文按宽度估算，每行约 9 个全角字）
  const perLine = Math.max(6, Math.round(W / 115));
  const lines: string[] = [];
  let rest = title.replace(/\s+/g, " ").trim();
  while (rest.length > 0 && lines.length < 3) {
    lines.push(rest.slice(0, perLine));
    rest = rest.slice(perLine);
  }
  if (rest.length > 0) lines[2] = lines[2].slice(0, perLine - 1) + "…";

  const fontSize = Math.round(W * 0.092);
  const lineH = Math.round(fontSize * 1.28);
  const blockH = lines.length * lineH;
  const top = Math.round(H / 2 - blockH / 2);
  const panelPad = Math.round(fontSize * 0.6);

  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const texts = lines
    .map((ln, i) => {
      const y = top + i * lineH + fontSize;
      return `<text x="${W / 2}" y="${y}" font-size="${fontSize}" font-weight="bold" fill="#ffffff" text-anchor="middle" style="paint-order:stroke;stroke:#000000;stroke-width:${Math.round(fontSize * 0.07)}px">${esc(ln)}</text>`;
    })
    .join("\n");

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family="WenQuanYi Zen Hei, Noto Sans CJK SC, Microsoft YaHei, sans-serif">
    <rect x="0" y="${top - panelPad}" width="${W}" height="${blockH + panelPad * 2}" fill="#000000" opacity="0.32"/>
    ${texts}
  </svg>`;

  const composed = await sharp(file).composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).png().toBuffer();
  fs.writeFileSync(file, composed);
}

async function mockImages(outDir: string, count: number, size = "1024x1024"): Promise<string[]> {
  const [w, h] = size.split("x").map((s) => parseInt(s, 10) || 1024);
  const files: string[] = [];
  for (let i = 0; i < count; i++) {
    const hue = Math.floor(Math.random() * 360);
    const file = path.join(outDir, `mock_cover_${Date.now()}_${i + 1}.png`);
    const [r, g, b] = hslToRgb(hue, 0.55, 0.6);
    await sharp({ create: { width: w, height: h, channels: 3, background: { r, g, b } } })
      .png()
      .toFile(file);
    files.push(file);
  }
  return files;
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] =
    h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}
