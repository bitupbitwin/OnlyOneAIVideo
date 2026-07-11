import path from "node:path";
import type { Repo } from "@amp/core";
import type { ProviderCapability, ProviderRow } from "@amp/shared";

export function seedProviders(repo: Repo, rootDir: string) {
  const env = process.env;
  const winPipe = process.platform === "win32" ? "type {PROMPT_FILE} |" : "cat {PROMPT_FILE} |";

  const ensure = (id: string, build: (enabled: boolean) => ProviderRow, trigger?: string) => {
    const has = !!trigger?.trim();
    if (has) repo.upsertProvider(build(true));
    else if (!repo.getProvider(id)) repo.upsertProvider(build(false));
  };
  const scaffold = (provider: ProviderRow) => {
    if (!repo.getProvider(provider.id)) repo.upsertProvider({ ...provider, enabled: false });
  };
  const base = (capabilities: ProviderCapability[], realFileOutput = false) => ({ capabilities, realFileOutput });

  if (!repo.getProvider("cli-mock")) {
    repo.upsertProvider({
      id: "cli-mock",
      kind: "cli",
      name: "演示文本引擎（本地 Mock，无需配置）",
      config: { command: `node "${path.join(rootDir, "scripts", "mock-llm.mjs")}" {PROMPT_FILE}`, healthCommand: "node --version" },
      maxConcurrency: 4,
      enabled: true,
      ...base(["text-generation"]),
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
      ...base(["image-generation"]),
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
      ...base(["image-to-video"]),
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
      ...base(["tts"]),
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
      ...base(["tts"], true),
    });
  }

  const cli = (id: string, name: string, bin: string, sub: string) =>
    ensure(
      id,
      (enabled) => ({
        id,
        kind: "cli",
        name: `${name}（${sub}）`,
        config:
          id === "cli-gemini"
            ? {
                // Antigravity CLI（agy v1.1.x）：无 run 子命令，-p 必须带参数；
                // 用 --add-dir 挂载临时目录（绝对路径），@prompt.txt/@image-N 相对该目录解析
                command: `"${bin}" --add-dir {TMP_DIR} -p "@prompt.txt {IMAGE_REFS}"`,
                healthCommand: `"${bin}" --version`,
                healthNote: "仅验证已安装，首次调用前需在终端运行 agy 完成 Google 登录",
                useTempCwd: true,
                imageReferences: true,
              }
            : id === "cli-codex"
              ? {
                  command: `${winPipe} ${bin} exec --ephemeral --skip-git-repo-check {IMAGE_ARGS} -o {OUTPUT_FILE} -`,
                  healthCommand: `${bin} --version`,
                  useTempCwd: true,
                  imageArguments: true,
                }
            : { command: `${winPipe} ${bin} -p`, healthCommand: `${bin} --version` },
        maxConcurrency: 2,
        enabled,
        ...base(
          id === "cli-gemini"
            ? ["text-generation", "image-understanding", "image-generation"]
            : id === "cli-grok"
              ? [
                  "text-generation",
                  "image-understanding",
                  "video-understanding",
                  "image-generation",
                  "image-editing",
                  "text-to-video",
                  "image-to-video",
                  "video-editing",
                ]
            : id === "cli-codex"
              ? ["text-generation", "image-understanding"]
              : ["text-generation"]
          , id === "cli-grok"
        ),
      }),
      env[`AMP_CLI_${id.replace("cli-", "").toUpperCase()}`]
    );
  cli("cli-claude", "Claude Code CLI", env.AMP_CLI_CLAUDE || "claude", "Claude 订阅");
  cli("cli-gemini", "Antigravity CLI", env.AMP_CLI_GEMINI || "agy", "Google·agy");
  cli("cli-codex", "Codex CLI", env.AMP_CLI_CODEX || "codex", "ChatGPT 订阅");
  ensure(
    "cli-grok",
    (enabled) => ({
      id: "cli-grok",
      kind: "cli",
      name: "Grok CLI（SuperGrok 订阅 · 全模态优先）",
      config: {
        command: `${winPipe} ${env.AMP_CLI_GROK || "grok"} -p`,
        healthCommand: `${env.AMP_CLI_GROK || "grok"} --version`,
        useTempCwd: true,
        mediaReferences: true,
        collectMediaOutput: true,
      },
      maxConcurrency: 2,
      enabled,
      ...base([
        "text-generation",
        "image-understanding",
        "video-understanding",
        "image-generation",
        "image-editing",
        "text-to-video",
        "image-to-video",
        "video-editing",
      ], true),
    }),
    env.AMP_CLI_GROK
  );

  ensure(
    "api-deepseek",
    (enabled) => ({
      id: "api-deepseek",
      kind: "api-text",
      name: "DeepSeek API（评审/改写）",
      config: { baseUrl: "https://api.deepseek.com", model: "deepseek-chat", apiKey: env.DEEPSEEK_API_KEY || "" },
      maxConcurrency: 4,
      enabled,
      ...base(["text-generation"]),
    }),
    env.DEEPSEEK_API_KEY
  );
  for (const item of [
    { id: "api-kimi-text", name: "Kimi API · 文本整合与表达", key: env.KIMI_API_KEY, baseUrl: "https://api.moonshot.cn/v1", model: "kimi-k2.5" },
    { id: "api-qwen-text", name: "Qwen API · 文本整合与表达", key: env.DASHSCOPE_API_KEY, baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus" },
    { id: "api-minimax-text", name: "MiniMax API · 文本整合与表达", key: env.MINIMAX_API_KEY, baseUrl: "https://api.minimaxi.com/v1", model: "MiniMax-M2.7" },
    { id: "api-doubao-text", name: "豆包 API · 文本整合与表达", key: env.ARK_API_KEY, baseUrl: "https://ark.cn-beijing.volces.com/api/v3", model: "doubao-seed-2-0-lite-260215" },
    { id: "api-glm-text", name: "GLM API · 文本整合与表达", key: env.ZHIPU_API_KEY, baseUrl: "https://open.bigmodel.cn/api/paas/v4", model: "glm-5" },
  ]) {
    ensure(item.id, (enabled) => ({
      id: item.id, kind: "api-text", name: item.name,
      config: { baseUrl: item.baseUrl, model: item.model, apiKey: item.key || "" },
      maxConcurrency: 2, enabled, ...base(["text-generation"]),
    }), item.key);
  }
  ensure(
    "api-grok-vision",
    (enabled) => ({
      id: "api-grok-vision",
      kind: "api-text",
      name: "Grok API · 视觉（素材理解）",
      config: { baseUrl: "https://api.x.ai/v1", model: "grok-4.3", apiKey: env.GROK_API_KEY || "", vision: true, videoVision: true },
      maxConcurrency: 2,
      enabled,
      ...base(["text-generation", "image-understanding", "video-understanding"]),
    }),
    env.GROK_API_KEY
  );
  ensure(
    "api-grok-text",
    (enabled) => ({
      id: "api-grok-text",
      kind: "api-text",
      name: "Grok API · 文本创作",
      config: { baseUrl: "https://api.x.ai/v1", model: "grok-4.3", apiKey: env.GROK_API_KEY || "" },
      maxConcurrency: 2,
      enabled,
      ...base(["text-generation"]),
    }),
    env.GROK_API_KEY
  );
  ensure(
    "api-grok-image",
    (enabled) => ({
      id: "api-grok-image",
      kind: "api-image",
      name: "Grok Imagine · 分镜出图",
      config: {
        baseUrl: "https://api.x.ai/v1",
        model: "grok-imagine-image",
        apiKey: env.GROK_API_KEY || "",
        noSize: true,
        aspectRatio: "9:16",
        resolution: "1k",
        n: 1,
      },
      maxConcurrency: 2,
      enabled,
      ...base(["image-generation", "image-editing"], true),
    }),
    env.GROK_API_KEY
  );
  ensure(
    "api-grok-overlay",
    (enabled) => ({
      id: "api-grok-overlay",
      kind: "api-image",
      name: "Grok Imagine · 底图 + 程序叠字",
      config: {
        baseUrl: "https://api.x.ai/v1",
        model: "grok-imagine-image",
        apiKey: env.GROK_API_KEY || "",
        noSize: true,
        aspectRatio: "9:16",
        resolution: "1k",
        overlayText: true,
        n: 1,
      },
      maxConcurrency: 2,
      enabled,
      ...base(["image-generation", "image-editing"], true),
    }),
    env.GROK_API_KEY
  );
  ensure(
    "api-grok-video",
    (enabled) => ({
      id: "api-grok-video",
      kind: "api-video",
      name: "Grok Imagine · 文生/图生视频",
      config: {
        baseUrl: "https://api.x.ai/v1",
        model: "grok-imagine-video",
        apiKey: env.GROK_API_KEY || "",
        apiStyle: "xai",
        allowTextToVideo: true,
        aspectRatio: "9:16",
        resolution: "480p",
        duration: 5,
        pollIntervalMs: 5000,
        pollTimeoutMs: 10 * 60 * 1000,
      },
      maxConcurrency: 1,
      enabled,
      ...base(["text-to-video", "image-to-video", "video-editing"], true),
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
      ...base(["image-generation", "image-editing"], true),
    }),
    env.ARK_API_KEY
  );
  for (const item of [
    { id: "api-qwen-image", name: "Qwen-Image 2.0 · 图片生成", model: "qwen-image-2.0-pro" },
    { id: "api-wan-image", name: "Wan 2.7 Image · 图片生成/编辑", model: "wan2.7-image-pro" },
  ]) {
    ensure(item.id, (enabled) => ({
      id: item.id, kind: "api-image", name: item.name,
      config: { baseUrl: "https://dashscope.aliyuncs.com/api/v1", apiStyle: "dashscope", model: item.model, apiKey: env.DASHSCOPE_API_KEY || "", n: 1 },
      maxConcurrency: 1, enabled, ...base(["image-generation", "image-editing"], true),
    }), env.DASHSCOPE_API_KEY);
  }

  // 下列厂商使用 AK/SK 或厂商专用签名协议；先提供准确配置入口，不伪装为已可运行的通用 Bearer API。
  scaffold({
    id: "api-hunyuan-image", kind: "api-image", name: "混元 Image · 图片生成/编辑（待填腾讯云 AK/SK）",
    config: { vendor: "tencent-hunyuan", endpoint: "hunyuan.tencentcloudapi.com", action: "TextToImageLite", secretId: "", secretKey: "", integrationReady: false },
    maxConcurrency: 1, enabled: false, ...base(["image-generation", "image-editing"]),
  });
  scaffold({
    id: "api-kling-image", kind: "api-image", name: "可灵 Image · 图片生成/编辑（待填 Access/Secret Key）",
    config: { vendor: "kling", baseUrl: "https://api.klingai.com", accessKey: "", secretKey: "", model: "kling-v3", integrationReady: false },
    maxConcurrency: 1, enabled: false, ...base(["image-generation", "image-editing"]),
  });
  const arkVideoKey = env.MV_VIDEO_API_KEY || env.ARK_API_KEY;
  ensure(
    "api-seedance-video",
    (enabled) => ({
      id: "api-seedance-video",
      kind: "api-video",
      name: "Seedance 2.0 · 文生/图生视频",
      config: {
        baseUrl: env.MV_VIDEO_BASE_URL || "https://ark.cn-beijing.volces.com/api/v3",
        model: env.MV_VIDEO_MODEL || "doubao-seedance-2-0-260128",
        apiKey: arkVideoKey || "",
        submitPath: "/contents/generations/tasks",
        statusPath: "/contents/generations/tasks/{id}",
        allowTextToVideo: true,
        imageRole: "first_frame",
        videoRole: "reference_video",
        generateAudio: true,
        pollIntervalMs: 8000,
        pollTimeoutMs: 15 * 60 * 1000,
      },
      maxConcurrency: 1,
      enabled,
      ...base(["image-understanding", "video-understanding", "text-to-video", "image-to-video", "video-editing"], true),
    }),
    arkVideoKey
  );
  ensure("api-wan-video", (enabled) => ({
    id: "api-wan-video", kind: "api-video", name: "Wan 2.6 · 文生/图生视频",
    config: {
      baseUrl: "https://dashscope.aliyuncs.com/api/v1", apiStyle: "dashscope", apiKey: env.DASHSCOPE_API_KEY || "",
      textModel: "wan2.6-t2v", imageModel: "wan2.6-i2v", model: "wan2.6-t2v", allowTextToVideo: true,
      pollIntervalMs: 8000, pollTimeoutMs: 10 * 60 * 1000,
    },
    maxConcurrency: 1, enabled, ...base(["text-to-video", "image-to-video"], true),
  }), env.DASHSCOPE_API_KEY);
  ensure("api-hailuo-video", (enabled) => ({
    id: "api-hailuo-video", kind: "api-video", name: "海螺/MiniMax · 文生/图生视频",
    config: { baseUrl: "https://api.minimaxi.com/v1", apiStyle: "minimax", model: "MiniMax-Hailuo-2.3", apiKey: env.MINIMAX_API_KEY || "", allowTextToVideo: true, pollIntervalMs: 10000, pollTimeoutMs: 10 * 60 * 1000 },
    maxConcurrency: 1, enabled, ...base(["text-to-video", "image-to-video"], true),
  }), env.MINIMAX_API_KEY);
  ensure("api-vidu-video", (enabled) => ({
    id: "api-vidu-video", kind: "api-video", name: "Vidu Q3 · 文生/图生视频",
    config: { baseUrl: "https://api.vidu.com/ent/v2", apiStyle: "vidu", model: "viduq3-pro", apiKey: env.VIDU_API_KEY || "", allowTextToVideo: true, pollIntervalMs: 8000, pollTimeoutMs: 10 * 60 * 1000 },
    maxConcurrency: 1, enabled, ...base(["text-to-video", "image-to-video"], true),
  }), env.VIDU_API_KEY);
  scaffold({
    id: "api-kling-video", kind: "api-video", name: "可灵 Video · 文生/图生视频（待填 Access/Secret Key）",
    config: { vendor: "kling", baseUrl: "https://api-singapore.klingai.com", model: "kling-v3", accessKey: "", secretKey: "", integrationReady: false },
    maxConcurrency: 1, enabled: false, ...base(["text-to-video", "image-to-video"]),
  });

  // 旧数据库中的内置引擎也同步补齐能力标签；不改变用户编辑过的名称、配置和启用状态。
  const annotations: Record<string, { capabilities: ProviderCapability[]; realFileOutput: boolean }> = {
    "cli-mock": base(["text-generation"]),
    "img-mock": base(["image-generation"]),
    "video-mock": base(["image-to-video"]),
    "tts-mock": base(["tts"]),
    "tts-edge": base(["tts"], true),
    "cli-claude": base(["text-generation"]),
    // AGY 已确认具备生图能力，但当前通用 CLI 适配器只接收文本输出，尚不能把图片文件登记进流水线。
    "cli-gemini": base(["text-generation", "image-understanding", "image-generation"]),
    "cli-codex": base(["text-generation", "image-understanding"]),
    "cli-grok": base([
      "text-generation",
      "image-understanding",
      "video-understanding",
      "image-generation",
      "image-editing",
      "text-to-video",
      "image-to-video",
      "video-editing",
    ], true),
    "api-deepseek": base(["text-generation"]),
    "api-grok-vision": base(["text-generation", "image-understanding", "video-understanding"]),
    "api-grok-text": base(["text-generation"]),
    "api-grok-image": base(["image-generation", "image-editing"], true),
    "api-grok-overlay": base(["image-generation", "image-editing"], true),
    "api-grok-video": base(["text-to-video", "image-to-video", "video-editing"], true),
    "api-jimeng": base(["image-generation", "image-editing"], true),
    "api-seedance-video": base(["image-understanding", "video-understanding", "text-to-video", "image-to-video", "video-editing"], true),
    "api-kimi-text": base(["text-generation"]),
    "api-qwen-text": base(["text-generation"]),
    "api-minimax-text": base(["text-generation"]),
    "api-doubao-text": base(["text-generation"]),
    "api-glm-text": base(["text-generation"]),
    "api-qwen-image": base(["image-generation", "image-editing"], true),
    "api-wan-image": base(["image-generation", "image-editing"], true),
    "api-wan-video": base(["text-to-video", "image-to-video"], true),
    "api-hailuo-video": base(["text-to-video", "image-to-video"], true),
    "api-vidu-video": base(["text-to-video", "image-to-video"], true),
  };
  for (const [id, annotation] of Object.entries(annotations)) {
    const provider = repo.getProvider(id);
    if (provider) repo.upsertProvider({
      ...provider,
      ...(id === "api-grok-video" ? { name: "Grok Imagine · 文生/图生视频" } : {}),
      ...(id === "cli-grok"
        ? {
            name: "Grok CLI（SuperGrok 订阅 · 全模态优先）",
            config: {
              ...provider.config,
              useTempCwd: true,
              mediaReferences: true,
              collectMediaOutput: true,
            },
          }
        : {}),
      ...annotation,
    });
  }
}
