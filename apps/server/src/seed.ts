import path from "node:path";
import type { Repo } from "@amp/core";
import type { ProviderRow } from "@amp/shared";

export function seedProviders(repo: Repo, rootDir: string) {
  const env = process.env;
  const winPipe = process.platform === "win32" ? "type {PROMPT_FILE} |" : "cat {PROMPT_FILE} |";

  const ensure = (id: string, build: (enabled: boolean) => ProviderRow, trigger?: string) => {
    const has = !!trigger?.trim();
    if (has) repo.upsertProvider(build(true));
    else if (!repo.getProvider(id)) repo.upsertProvider(build(false));
  };

  if (!repo.getProvider("cli-mock")) {
    repo.upsertProvider({
      id: "cli-mock",
      kind: "cli",
      name: "演示文本引擎（本地 Mock，无需配置）",
      config: { command: `node "${path.join(rootDir, "scripts", "mock-llm.mjs")}" {PROMPT_FILE}`, healthCommand: "node --version" },
      maxConcurrency: 4,
      enabled: true,
    });
  }
  if (!repo.getProvider("img-mock")) {
    repo.upsertProvider({
      id: "img-mock",
      kind: "api-image",
      name: "演示出图引擎（本地占位图，无需配置）",
      config: { mock: true, n: 1 },
      maxConcurrency: 2,
      enabled: true,
    });
  }
  if (!repo.getProvider("video-mock")) {
    repo.upsertProvider({
      id: "video-mock",
      kind: "api-video",
      name: "演示图生视频引擎（本地占位，无需配置）",
      config: { mock: true },
      maxConcurrency: 1,
      enabled: true,
    });
  }
  if (!repo.getProvider("tts-mock")) {
    repo.upsertProvider({
      id: "tts-mock",
      kind: "tts",
      name: "演示 TTS（静音 wav，无需配置）",
      config: { mock: true, voice: "zh-CN-XiaoxiaoNeural" },
      maxConcurrency: 4,
      enabled: true,
    });
  }
  // Edge-TTS：微软免费在线配音，无需 key（需联网；音色/语速可在引擎管理里改 config）
  if (!repo.getProvider("tts-edge")) {
    repo.upsertProvider({
      id: "tts-edge",
      kind: "tts",
      name: "Edge-TTS 免费配音（晓晓·在线，无需key）",
      config: {
        voice: env.AMP_TTS_VOICE || "zh-CN-XiaoxiaoNeural",
        rate: env.AMP_TTS_RATE || "+0%",
        volume: "+0%",
      },
      maxConcurrency: 2,
      enabled: true,
    });
  }

  const cli = (id: string, name: string, bin: string, sub: string) =>
    ensure(
      id,
      (enabled) => ({
        id,
        kind: "cli",
        name: `${name}（${sub}）`,
        config: { command: `${winPipe} ${bin} -p`, healthCommand: `${bin} --version` },
        maxConcurrency: 2,
        enabled,
      }),
      env[`AMP_CLI_${id.replace("cli-", "").toUpperCase()}`]
    );
  cli("cli-claude", "Claude Code CLI", env.AMP_CLI_CLAUDE || "claude", "Claude 订阅");
  cli("cli-gemini", "Gemini CLI", env.AMP_CLI_GEMINI || "gemini", "Gemini 订阅");
  cli("cli-codex", "Codex CLI", env.AMP_CLI_CODEX || "codex", "ChatGPT 订阅");

  ensure(
    "api-deepseek",
    (enabled) => ({
      id: "api-deepseek",
      kind: "api-text",
      name: "DeepSeek API（评审/改写）",
      config: { baseUrl: "https://api.deepseek.com", model: "deepseek-chat", apiKey: env.DEEPSEEK_API_KEY || "" },
      maxConcurrency: 4,
      enabled,
    }),
    env.DEEPSEEK_API_KEY
  );
  ensure(
    "api-grok-vision",
    (enabled) => ({
      id: "api-grok-vision",
      kind: "api-text",
      name: "Grok API · 视觉（素材理解）",
      config: { baseUrl: "https://api.x.ai/v1", model: "grok-2-vision-1212", apiKey: env.GROK_API_KEY || "", vision: true },
      maxConcurrency: 2,
      enabled,
    }),
    env.GROK_API_KEY
  );
  ensure(
    "api-jimeng",
    (enabled) => ({
      id: "api-jimeng",
      kind: "api-image",
      name: "即梦/Seedream（火山方舟）· 出图",
      config: { baseUrl: "https://ark.cn-beijing.volces.com/api/v3", model: "doubao-seedream-4-0-250828", apiKey: env.ARK_API_KEY || "", size: "1080x1920", n: 1 },
      maxConcurrency: 2,
      enabled,
    }),
    env.ARK_API_KEY
  );
}
