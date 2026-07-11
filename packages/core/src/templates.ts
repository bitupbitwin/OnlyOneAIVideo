import fs from "node:fs";
import path from "node:path";
import type { PipelineTemplate, PlatformSpec } from "@amp/shared";
import type { Repo } from "./db.js";

export class TemplateStore {
  constructor(
    private rootDir: string,
    private repo: Repo
  ) {}

  get promptsDir() {
    return path.join(this.rootDir, "prompts");
  }

  /** 平台参数表：platforms/platforms.json，每个平台一段，改参数不改代码 */
  listPlatforms(): PlatformSpec[] {
    const file = path.join(this.rootDir, "platforms", "platforms.json");
    if (!fs.existsSync(file)) return [];
    const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, Omit<PlatformSpec, "id">>;
    return Object.entries(raw).map(([id, spec]) => ({ id, ...spec }));
  }

  listPipelineTemplates(): PipelineTemplate[] {
    return [];
  }

  getPipelineTemplate(_id: string): PipelineTemplate | undefined {
    return undefined;
  }

  readPrompt(relPath: string): string {
    const safe = relPath.replace(/\\/g, "/");
    if (safe.includes("..") || path.isAbsolute(safe)) throw new Error("非法模板路径");
    const override = this.repo.getPromptOverride(safe);
    if (override != null) return override;
    const full = path.join(this.promptsDir, safe);
    if (!fs.existsSync(full)) throw new Error(`Prompt 模板不存在: ${safe}`);
    return fs.readFileSync(full, "utf-8");
  }

  listPromptPaths(): string[] {
    const result: string[] = [];
    const walk = (dir: string, prefix: string) => {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) walk(path.join(dir, entry.name), `${prefix}${entry.name}/`);
        else if (entry.name.endsWith(".md")) result.push(`${prefix}${entry.name}`);
      }
    };
    walk(this.promptsDir, "");
    return result.sort();
  }
}
