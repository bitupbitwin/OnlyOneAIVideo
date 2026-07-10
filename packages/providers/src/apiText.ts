import fs from "node:fs";
import path from "node:path";
import type { GenerateRequest, GenerateResult, ProviderRow, ProviderStatus } from "@amp/shared";
import type { Provider } from "@amp/core";

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

      // 多模态：附带图片时按 OpenAI vision 消息格式发送（需模型支持，config.vision = true）
      let userContent: any = req.prompt;
      if (req.images?.length) {
        userContent = [
          { type: "text", text: req.prompt },
          ...req.images.map((file) => ({
            type: "image_url",
            image_url: { url: toDataUrl(file) },
          })),
        ];
      }
      messages.push({ role: "user", content: userContent });

      const res = await fetchWithTimeout(`${trimSlash(baseUrl)}/chat/completions`, req.timeoutMs, {
        method: "POST",
        headers: headers(apiKey),
        body: JSON.stringify({ model, messages }),
      });
      const data: any = await res.json();
      const text = data?.choices?.[0]?.message?.content;
      if (typeof text !== "string") throw new Error(`API 返回异常: ${JSON.stringify(data).slice(0, 400)}`);
      return { kind: "text", text };
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
