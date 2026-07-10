import fs from "node:fs";
import path from "node:path";
import type { GenerateRequest, GenerateResult, ProviderRow, ProviderStatus } from "@amp/shared";
import type { Provider } from "@amp/core";

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
      const files: string[] = [];
      const durationsSec: number[] = [];
      for (let i = 0; i < parts.length; i++) {
        const duration = estimateDuration(parts[i]);
        const file = path.join(outDir, `scene-${String(i + 1).padStart(2, "0")}.wav`);
        fs.writeFileSync(file, makeSilentWav(duration));
        files.push(file);
        durationsSec.push(duration);
      }
      return { kind: "audio", files, durationsSec };
    },
    async healthCheck(): Promise<ProviderStatus> {
      return { ok: true, detail: row.config.mock ? "演示 TTS：生成静音 wav" : "TTS provider stub 可用" };
    },
  };
}

function estimateDuration(text: string): number {
  const cjk = (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
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
