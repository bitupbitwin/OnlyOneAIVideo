import type { GenerateRequest, GenerateResult, ProviderRow, ProviderStatus } from "@amp/shared";
import type { Provider } from "@amp/core";
import { hasLoginProfile, launchContext, resolveWebConfig } from "./webSession.js";

/**
 * Web 网页端适配器（M4）：Playwright persistent context 驱动 ChatGPT 等网页端。
 *
 * - 登录态保存在本地 profile 目录（引擎管理页「打开登录窗口」首次登录）
 * - 全程有头模式 + 人类化输入间隔，遇到验证码时用户可直接在弹出的窗口中处理
 * - 选择器以配置描述（config.selectors），站点改版后可热更，无需改代码
 * - 同一站点建议并发 = 1（避免触发风控），由引擎注册表的信号量控制
 */
export function createWebProvider(row: ProviderRow): Provider {
  return {
    row,

    async generate(req: GenerateRequest, onChunk?: (chunk: string) => void): Promise<GenerateResult> {
      const config = resolveWebConfig(row);
      const context = await launchContext(config);
      try {
        const page = context.pages()[0] ?? (await context.newPage());
        onChunk?.(`[网页端] 打开 ${config.url} …\n`);
        await page.goto(config.url, { waitUntil: "domcontentloaded" });

        const input = page.locator(config.selectors.input).first();
        try {
          await input.waitFor({ state: "visible", timeout: config.readyTimeoutMs });
        } catch {
          throw new Error(
            `未找到输入框（${config.selectors.input}）。可能原因：未登录（请先在引擎管理页打开登录窗口完成登录）、` +
              `站点出现验证码、或页面改版导致选择器失效（可在引擎配置 selectors 中更新）`
          );
        }

        // 人类化输入：聚焦后整段插入（insertText 走输入事件，兼容 contenteditable）
        await input.click();
        await page.waitForTimeout(300 + Math.random() * 500);
        await page.keyboard.insertText(req.prompt);
        await page.waitForTimeout(300 + Math.random() * 400);

        const send = page.locator(config.selectors.send).first();
        if (await send.isVisible().catch(() => false)) {
          await send.click();
        } else {
          await page.keyboard.press("Enter");
        }
        onChunk?.("[网页端] 已发送，等待回复生成…\n");

        // 等待完成：busy 标志出现（容忍未捕获到）后消失，再等最后一条回复文本稳定
        const busy = page.locator(config.selectors.busy).first();
        await busy.waitFor({ state: "visible", timeout: 15_000 }).catch(() => undefined);
        await busy.waitFor({ state: "hidden", timeout: req.timeoutMs }).catch(() => undefined);

        const reply = page.locator(config.selectors.assistantMessage).last();
        let text = "";
        let stableCount = 0;
        const deadline = Date.now() + req.timeoutMs;
        while (Date.now() < deadline && stableCount < 2) {
          await page.waitForTimeout(1500);
          const current = (await reply.innerText().catch(() => "")).trim();
          if (current && current === text) stableCount += 1;
          else stableCount = 0;
          text = current;
        }
        if (!text) {
          throw new Error(
            `未能提取到回复内容（${config.selectors.assistantMessage}）。若页面上已有回复，` +
              `说明站点改版导致选择器失效，请更新引擎配置中的 selectors`
          );
        }
        onChunk?.(`[网页端] 已提取回复（${text.length} 字）\n`);
        return { kind: "text", text };
      } finally {
        await context.close().catch(() => undefined);
      }
    },

    async healthCheck(): Promise<ProviderStatus> {
      try {
        const { existsSync } = await import("node:fs");
        const execPath = (await import("playwright")).chromium.executablePath();
        if (!execPath || !existsSync(execPath)) {
          return { ok: false, detail: "Chromium 未安装，请运行: npx playwright install chromium" };
        }
      } catch {
        return { ok: false, detail: "Playwright 未安装（npx playwright install chromium）" };
      }
      if (!hasLoginProfile(row)) {
        return { ok: false, detail: "未检测到登录态，请点击「打开登录窗口」完成登录" };
      }
      return { ok: true, detail: "已有本地登录态（实际有效性以调用为准）" };
    },
  };
}
