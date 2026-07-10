import crypto from "node:crypto";
import fs from "node:fs";
import WebSocket from "ws";

/**
 * Edge-TTS：微软 Edge 浏览器"大声朗读"的在线语音合成接口，免费、无需 key。
 * 协议要点：
 *  - wss 连接需携带 TrustedClientToken + Sec-MS-GEC（按 5 分钟窗口对 token 做 SHA256 的防滥用签名）
 *  - 先发 speech.config（输出格式），再发 SSML，二进制帧里 Path:audio 的负载即 mp3 分片
 *  - 文本帧出现 Path:turn.end 表示本次合成结束
 * 接口属非公开协议，可能随 Edge 版本漂移——失败时引擎侧可切回 tts-mock 或换正式 API。
 */

const TRUSTED_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const WSS_URL = "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1";
// 服务端会拒绝过旧的版本串（2026-07 实测 130 被 403、143 通过）；漂移时改 env 即可
const CHROMIUM_VERSION = process.env.AMP_EDGE_TTS_VERSION?.trim() || "143.0.3650.75";
const OUTPUT_FORMAT = "audio-24khz-48kbitrate-mono-mp3";

export interface EdgeTtsOptions {
  text: string;
  /** 音色，如 zh-CN-XiaoxiaoNeural（晓晓·女）/ zh-CN-YunxiNeural（云希·男） */
  voice: string;
  /** 语速偏移，如 "+0%" / "+15%" / "-10%" */
  rate?: string;
  volume?: string;
  outFile: string;
  timeoutMs?: number;
}

export async function edgeSynthesize(opts: EdgeTtsOptions): Promise<void> {
  const { text, voice, outFile } = opts;
  const rate = opts.rate ?? "+0%";
  const volume = opts.volume ?? "+0%";
  const timeoutMs = opts.timeoutMs ?? 30_000;

  const url =
    `${WSS_URL}?TrustedClientToken=${TRUSTED_TOKEN}` +
    `&Sec-MS-GEC=${secMsGec()}&Sec-MS-GEC-Version=1-${CHROMIUM_VERSION}` +
    `&ConnectionId=${uuid()}`;

  const audio: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(url, {
      headers: {
        "User-Agent":
          `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ` +
          `Chrome/${CHROMIUM_VERSION.split(".")[0]}.0.0.0 Safari/537.36 Edg/${CHROMIUM_VERSION}`,
        Origin: "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
        Pragma: "no-cache",
        "Cache-Control": "no-cache",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      },
    });
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error(`Edge-TTS 合成超时（${Math.round(timeoutMs / 1000)}s）`));
    }, timeoutMs);
    const fail = (err: Error) => {
      clearTimeout(timer);
      ws.terminate();
      reject(err);
    };

    ws.on("open", () => {
      ws.send(
        `X-Timestamp:${new Date().toISOString()}\r\n` +
          `Content-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
          JSON.stringify({
            context: {
              synthesis: {
                audio: {
                  metadataoptions: { sentenceBoundaryEnabled: "false", wordBoundaryEnabled: "false" },
                  outputFormat: OUTPUT_FORMAT,
                },
              },
            },
          })
      );
      const ssml =
        `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='zh-CN'>` +
        `<voice name='${voice}'><prosody pitch='+0Hz' rate='${rate}' volume='${volume}'>` +
        `${escapeXml(text)}</prosody></voice></speak>`;
      ws.send(
        `X-RequestId:${uuid()}\r\nContent-Type:application/ssml+xml\r\n` +
          `X-Timestamp:${new Date().toISOString()}\r\nPath:ssml\r\n\r\n${ssml}`
      );
    });

    ws.on("message", (data: Buffer, isBinary: boolean) => {
      if (isBinary) {
        // 二进制帧：前 2 字节为头长度（大端），头内 Path:audio 的负载是 mp3 分片
        if (data.length < 2) return;
        const headerLen = data.readUInt16BE(0);
        const header = data.subarray(2, 2 + headerLen).toString("utf-8");
        if (header.includes("Path:audio")) audio.push(data.subarray(2 + headerLen));
        return;
      }
      const message = data.toString("utf-8");
      if (message.includes("Path:turn.end")) {
        clearTimeout(timer);
        ws.close();
        resolve();
      }
    });

    ws.on("error", (err) => fail(new Error(`Edge-TTS 连接失败：${err.message}`)));
    ws.on("close", (code) => {
      // 未收到 turn.end 就被关闭（403 = Sec-MS-GEC 校验失败或接口变更）
      clearTimeout(timer);
      if (audio.length === 0) fail(new Error(`Edge-TTS 连接被关闭（code=${code}），未返回音频`));
    });
  });

  const buffer = Buffer.concat(audio);
  if (buffer.length < 200) throw new Error("Edge-TTS 返回的音频为空");
  fs.writeFileSync(outFile, buffer);
}

/** Sec-MS-GEC：Windows 文件时间刻度按 5 分钟取整后拼 token 做 SHA256（Edge 客户端同款防滥用签名） */
function secMsGec(): string {
  let ticks = BigInt(Math.floor(Date.now() / 1000) + 11_644_473_600);
  ticks -= ticks % 300n;
  return crypto
    .createHash("sha256")
    .update(`${ticks * 10_000_000n}${TRUSTED_TOKEN}`, "ascii")
    .digest("hex")
    .toUpperCase();
}

function uuid(): string {
  return crypto.randomUUID().replaceAll("-", "");
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
