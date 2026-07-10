import fs from "node:fs";
import path from "node:path";
import type { GenerateRequest, GenerateResult, ProviderRow, ProviderStatus } from "@amp/shared";
import type { Provider } from "@amp/core";
import { edgeSynthesize } from "./edgeTts.js";

/**
 * TTS 适配器：req.prompt 以 "\n---\n" 分隔逐镜旁白，逐段合成音频。
 * - config.mock=true：本地静音 wav（零配置演示）
 * - 否则：Edge-TTS 免费在线合成 mp3（config.voice / rate / volume）
 * 返回的 durationsSec 仅供展示参考；成片主时钟以 compose 阶段 ffprobe 实测为准。
 */
export function createTtsProvider(row: ProviderRow): Provider {
  return {
    row,
    async generate(req: GenerateRequest): Promise<GenerateResult> {
      const outDir = req.outDir ?? process.cwd();
      fs.mkdirSync(outDir, { recursive: true });
      const parts = req.prompt
        .split(/\n---\n/g)
        .map((s) => s.trim())
        .filter(Boolean);
      if (parts.length === 0) throw new Error("没有可合成的旁白文本");

      const files: string[] = [];
      const durationsSec: number[] = [];

      if (row.config.mock) {
        for (let i = 0; i < parts.length; i++) {
          const duration = estimateDuration(parts[i]);
          const file = path.join(outDir, `scene-${String(i + 1).padStart(2, "0")}.wav`);
          fs.writeFileSync(file, makeSilentWav(duration));
          files.push(file);
          durationsSec.push(duration);
        }
        return { kind: "audio", files, durationsSec };
      }

      const voice: string = req.voice || row.config.voice || "zh-CN-XiaoxiaoNeural";
      const rate: string = row.config.rate || "+0%";
      const volume: string = row.config.volume || "+0%";
      for (let i = 0; i < parts.length; i++) {
        const file = path.join(outDir, `scene-${String(i + 1).padStart(2, "0")}.mp3`);
        await withRetry(2, () =>
          edgeSynthesize({ text: parts[i], voice, rate, volume, outFile: file, timeoutMs: Math.min(req.timeoutMs, 60_000) })
        );
        files.push(file);
        durationsSec.push(estimateDuration(parts[i]));
      }
      return { kind: "audio", files, durationsSec };
    },

    async healthCheck(): Promise<ProviderStatus> {
      if (row.config.mock) return { ok: true, detail: "演示 TTS：生成静音 wav" };
      const tmp = path.join(fs.mkdtempSync(path.join(process.env.TEMP || "/tmp", "amp-tts-")), "ping.mp3");
      try {
        await edgeSynthesize({ text: "连接测试", voice: row.config.voice || "zh-CN-XiaoxiaoNeural", outFile: tmp, timeoutMs: 15_000 });
        const size = fs.statSync(tmp).size;
        return { ok: true, detail: `Edge-TTS 可用（测试音频 ${Math.round(size / 1024)}KB）` };
      } catch (err: any) {
        return { ok: false, detail: err?.message ?? String(err) };
      } finally {
        fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
      }
    },
  };
}

async function withRetry<T>(attempts: number, fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 800));
    }
  }
  throw lastErr;
}

function estimateDuration(text: string): number {
  const cjk = (text.match(/[一-鿿]/g) ?? []).length;
  const words = text.split(/\s+/).filter(Boolean).length;
  const seconds = Math.max(1.2, cjk / 4.2 + words / 2.6 + 0.3);
  return Math.round(seconds * 10) / 10;
}

function makeSilentWav(durationSec: number): Buffer {
  const sampleRate = 16_000;
  const channels = 1;
  const bitsPerSample = 16;
  const dataSize = Math.max(1, Math.floor(durationSec * sampleRate)) * channels * (bitsPerSample / 8);
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * (bitsPerSample / 8), 28);
  buffer.writeUInt16LE(channels * (bitsPerSample / 8), 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}
