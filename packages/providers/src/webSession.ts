import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProviderRow } from "@amp/shared";

export interface WebSiteConfig {
  url: string;
  profileDir: string;
  selectors: {
    /** 输入框（contenteditable 或 textarea） */
    input: string;
    /** 发送按钮 */
    send: string;
    /** 助手回复消息块 */
    assistantMessage: string;
    /** 生成中标志（如"停止生成"按钮），消失即视为回复完成 */
    busy: string;
  };
  /** 页面就绪/登录检测超时（毫秒） */
  readyTimeoutMs: number;
}

/** ChatGPT 网页版默认选择器；站点改版后可在引擎配置 JSON 的 selectors 中覆盖 */
const DEFAULT_SELECTORS: WebSiteConfig["selectors"] = {
  input: "#prompt-textarea",
  send: '[data-testid="send-button"]',
  assistantMessage: '[data-message-author-role="assistant"]',
  busy: '[data-testid="stop-button"]',
};

export function resolveWebConfig(row: ProviderRow): WebSiteConfig {
  return {
    url: row.config.url ?? "https://chatgpt.com",
    profileDir: row.config.profileDir ?? path.join(os.homedir(), ".amp", "browser-profiles", row.id),
    selectors: { ...DEFAULT_SELECTORS, ...(row.config.selectors ?? {}) },
    readyTimeoutMs: Number(row.config.readyTimeoutMs) || 30_000,
  };
}

export async function loadChromium() {
  try {
    const { chromium } = await import("playwright");
    return chromium;
  } catch {
    throw new Error(
      "Playwright 未就绪。请在项目根目录运行: pnpm install 后执行 npx playwright install chromium"
    );
  }
}

/** 全程有头模式：网页端站点对无头浏览器风控严格，且登录/验证码需要人工介入 */
export async function launchContext(config: WebSiteConfig) {
  const chromium = await loadChromium();
  fs.mkdirSync(config.profileDir, { recursive: true });
  try {
    return await chromium.launchPersistentContext(config.profileDir, {
      headless: false,
      viewport: null,
      args: ["--disable-blink-features=AutomationControlled"],
    });
  } catch (err: any) {
    const message: string = err?.message ?? String(err);
    if (message.includes("Executable doesn't exist")) {
      throw new Error("未安装 Chromium 浏览器。请运行: npx playwright install chromium");
    }
    throw err;
  }
}

/**
 * 打开登录窗口：弹出真实浏览器让用户手动登录，登录态保存在本地 profile 目录。
 * 用户登录完成后关闭浏览器窗口即可（或调用返回的 close）。
 */
export async function openLoginWindow(row: ProviderRow): Promise<{ close: () => Promise<void> }> {
  const config = resolveWebConfig(row);
  const context = await launchContext(config);
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(config.url, { waitUntil: "domcontentloaded" }).catch(() => undefined);
  let closed = false;
  context.on("close", () => {
    closed = true;
  });
  return {
    close: async () => {
      if (!closed) await context.close().catch(() => undefined);
    },
  };
}

export function hasLoginProfile(row: ProviderRow): boolean {
  const config = resolveWebConfig(row);
  return fs.existsSync(config.profileDir) && fs.readdirSync(config.profileDir).length > 0;
}
