import path from "node:path";
import type { Repo } from "@amp/core";
import type { ProviderRow } from "@amp/shared";

/**
 * 写入/更新默认引擎预设。幂等：按 provider id 增量处理，不会清掉你已填的配置。
 *
 * key / CLI 命令从环境变量读取（项目根目录的 .env 文件，见 .env.example）：
 *  - 环境变量存在 → 覆盖写入对应预设并启用（改 .env 重启即生效）
 *  - 环境变量缺失 → 仅在该预设不存在时创建一个「停用」占位（也可之后在「引擎管理」页手动填）
 */
export function seedProviders(repo: Repo, rootDir: string) {
  const env = process.env;
  const winPipe = process.platform === "win32" ? "type {PROMPT_FILE} |" : "cat {PROMPT_FILE} |";

  /** 有 env 触发值就覆盖+启用；否则不存在才建停用占位，存在则保持现状（不覆盖你的手填） */
  const ensure = (id: string, build: (enabled: boolean) => ProviderRow, trigger?: string) => {
    const has = !!trigger?.trim();
    if (has) {
      repo.upsertProvider(build(true));
    } else if (!repo.getProvider(id)) {
      repo.upsertProvider(build(false));
    }
  };

  const profile = (id: string) => path.join(rootDir, "data", "browser-profiles", id);

  // ============ 演示引擎（始终存在，零配置跑通 demo）============
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
      config: { mock: true, n: 3 },
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

  // ============ CLI（走订阅，包月不额外计费；填 .env 的 AMP_CLI_* = 命令名即启用）============
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
  cli("cli-claude", "Claude Code CLI", env.AMP_CLI_CLAUDE || "claude", "Claude 订阅 · 中文/技术首选");
  cli("cli-gemini", "Gemini CLI", env.AMP_CLI_GEMINI || "gemini", "Gemini 订阅");
  cli("cli-codex", "Codex CLI", env.AMP_CLI_CODEX || "codex", "ChatGPT 订阅");
  cli("cli-grok", "Grok CLI", env.AMP_CLI_GROK || "grok", "Grok 订阅");
  cli("cli-kimi", "Kimi CLI", env.AMP_CLI_KIMI || "kimi", "Kimi 订阅");

  // ============ 文本 API（按量计费；填对应 *_API_KEY 即启用）============
  ensure(
    "api-deepseek",
    (enabled) => ({
      id: "api-deepseek",
      kind: "api-text",
      name: "DeepSeek API（推荐用于评审打分）",
      config: { baseUrl: "https://api.deepseek.com", model: "deepseek-chat", apiKey: env.DEEPSEEK_API_KEY || "" },
      maxConcurrency: 4,
      enabled,
    }),
    env.DEEPSEEK_API_KEY
  );
  ensure(
    "api-grok",
    (enabled) => ({
      id: "api-grok",
      kind: "api-text",
      name: "Grok API · 文本（xAI）",
      config: { baseUrl: "https://api.x.ai/v1", model: "grok-4", apiKey: env.GROK_API_KEY || "" },
      maxConcurrency: 3,
      enabled,
    }),
    env.GROK_API_KEY
  );
  ensure(
    "api-kimi",
    (enabled) => ({
      id: "api-kimi",
      kind: "api-text",
      name: "Kimi/Moonshot API · 文本",
      config: { baseUrl: "https://api.moonshot.cn/v1", model: "moonshot-v1-32k", apiKey: env.KIMI_API_KEY || "" },
      maxConcurrency: 3,
      enabled,
    }),
    env.KIMI_API_KEY
  );

  // ============ 视觉 API（看图：封面多模态评审 / 图片素材理解；config.vision=true）============
  ensure(
    "api-grok-vision",
    (enabled) => ({
      id: "api-grok-vision",
      kind: "api-text",
      name: "Grok API · 视觉（看图，推荐绑定封面评审）",
      config: { baseUrl: "https://api.x.ai/v1", model: "grok-2-vision-1212", apiKey: env.GROK_API_KEY || "", vision: true },
      maxConcurrency: 2,
      enabled,
    }),
    env.GROK_API_KEY
  );
  ensure(
    "api-kimi-vision",
    (enabled) => ({
      id: "api-kimi-vision",
      kind: "api-text",
      name: "Kimi/Moonshot API · 视觉（看图）",
      config: { baseUrl: "https://api.moonshot.cn/v1", model: "moonshot-v1-32k-vision-preview", apiKey: env.KIMI_API_KEY || "", vision: true },
      maxConcurrency: 2,
      enabled: false,
    }),
    undefined // 默认不自动启用，避免和 grok-vision 重复；需要时手动启用
  );

  // ============ 出图 API（封面）============
  // 即梦/Seedream（火山方舟）：中文渲染最好，推荐主力（充值用 ARK_API_KEY）
  ensure(
    "api-jimeng",
    (enabled) => ({
      id: "api-jimeng",
      kind: "api-image",
      name: "即梦/Seedream（火山方舟）· 封面主力·中文最佳",
      config: { baseUrl: "https://ark.cn-beijing.volces.com/api/v3", model: "doubao-seedream-4-0-250828", apiKey: env.ARK_API_KEY || "", size: "1024x1024", n: 3 },
      maxConcurrency: 2,
      enabled,
    }),
    env.ARK_API_KEY
  );
  // Grok 出图（原生）：用 GROK_API_KEY
  ensure(
    "api-grok-image",
    (enabled) => ({
      id: "api-grok-image",
      kind: "api-image",
      name: "Grok 出图（xAI 原生，中文可能弱）",
      config: { baseUrl: "https://api.x.ai/v1", model: "grok-2-image-1212", apiKey: env.GROK_API_KEY || "", n: 2 },
      maxConcurrency: 2,
      enabled: false,
    }),
    undefined
  );
  // Grok 底图 + 程序叠字：零成本中文100%正确的封面方案（用 GROK_API_KEY）
  ensure(
    "api-grok-overlay",
    (enabled) => ({
      id: "api-grok-overlay",
      kind: "api-image",
      name: "Grok底图+程序叠字 · 封面（中文100%正确）",
      config: { baseUrl: "https://api.x.ai/v1", model: "grok-2-image-1212", apiKey: env.GROK_API_KEY || "", n: 2, overlayText: true },
      maxConcurrency: 2,
      enabled: !!env.GROK_API_KEY,
    }),
    env.GROK_API_KEY
  );
  // MV 批量出图专用引擎（按图片提示词逐张生成）：可单独填 key/模型；留空则用 ARK_API_KEY 走即梦
  ensure(
    "api-mv-images",
    (enabled) => ({
      id: "api-mv-images",
      kind: "api-image",
      name: "MV 批量出图（即梦/Seedream，可单独配置）",
      config: {
        baseUrl: env.MV_IMAGE_BASE_URL || "https://ark.cn-beijing.volces.com/api/v3",
        model: env.MV_IMAGE_MODEL || "doubao-seedream-4-0-250828",
        apiKey: env.MV_IMAGE_API_KEY || env.ARK_API_KEY || "",
        size: "1024x1024",
        n: 1,
      },
      maxConcurrency: 2,
      enabled,
    }),
    env.MV_IMAGE_API_KEY || env.ARK_API_KEY
  );

  // 图生视频（即梦视频/Seedance · 火山方舟，异步生成）：填 MV_VIDEO_API_KEY 即启用
  ensure(
    "api-video-jimeng",
    (enabled) => ({
      id: "api-video-jimeng",
      kind: "api-video",
      name: "即梦视频/Seedance 图生视频（火山方舟，可校准）",
      config: {
        baseUrl: env.MV_VIDEO_BASE_URL || "https://ark.cn-beijing.volces.com/api/v3",
        model: env.MV_VIDEO_MODEL || "doubao-seedance-1-0-lite-i2v-250428",
        apiKey: env.MV_VIDEO_API_KEY || "",
        submitPath: "/contents/generations/tasks",
        statusPath: "/contents/generations/tasks/{id}",
        pollIntervalMs: 6000,
        pollTimeoutMs: 300000,
      },
      maxConcurrency: 1,
      enabled,
    }),
    env.MV_VIDEO_API_KEY
  );

  // OpenAI gpt-image-1（如果以后能充值）
  ensure(
    "api-gpt-image",
    (enabled) => ({
      id: "api-gpt-image",
      kind: "api-image",
      name: "OpenAI gpt-image-1（如可充值）",
      config: { baseUrl: "https://api.openai.com/v1", model: "gpt-image-1", apiKey: env.OPENAI_API_KEY || "", size: "1024x1024", n: 3 },
      maxConcurrency: 2,
      enabled,
    }),
    env.OPENAI_API_KEY
  );

  // ============ 网页端（Playwright 驱动订阅网页，登录一次长期复用）============
  const web = (id: string, name: string, url: string, selectors?: any) => {
    if (repo.getProvider(id)) return;
    repo.upsertProvider({ id, kind: "web", name, config: { url, profileDir: profile(id), ...(selectors ? { selectors } : {}) }, maxConcurrency: 1, enabled: false });
  };
  web("web-chatgpt", "ChatGPT 网页端（需 Playwright 登录）", "https://chatgpt.com");
  web("web-claude", "Claude 网页端（选择器或需校准）", "https://claude.ai/new", {
    input: 'div[contenteditable="true"]',
    send: 'button[aria-label="Send message"]',
    assistantMessage: "div.font-claude-message",
    busy: 'button[aria-label="Stop response"]',
  });
  web("web-gemini", "Gemini 网页端（选择器或需校准）", "https://gemini.google.com/app", {
    input: 'div[contenteditable="true"], rich-textarea',
    send: 'button[aria-label*="Send"], button[aria-label*="发送"]',
    assistantMessage: "message-content, .model-response-text",
    busy: 'button[aria-label*="Stop"], .stop-icon',
  });
  web("web-kimi", "Kimi 网页端（选择器或需校准）", "https://www.kimi.com", {
    input: 'div[contenteditable="true"]',
    send: 'button[type="submit"]',
    assistantMessage: 'div[data-role="assistant"], .chat-content-item-assistant',
    busy: ".stop-button, button[aria-label*='停止']",
  });
}
