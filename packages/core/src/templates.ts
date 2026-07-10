import fs from "node:fs";
import path from "node:path";
import type { CoverSize, PipelineOption, PipelineTemplate, StepDef } from "@amp/shared";
import type { Repo } from "./db.js";

interface NodeLib {
  sizes: Record<string, CoverSize[]>;
  optionPresets: Record<string, PipelineOption>;
  nodes: Record<string, StepDef>;
}

export class TemplateStore {
  constructor(
    private rootDir: string,
    private repo: Repo
  ) {}

  get pipelinesDir() {
    return path.join(this.rootDir, "pipelines");
  }

  get nodesDir() {
    return path.join(this.rootDir, "nodes");
  }

  get promptsDir() {
    return path.join(this.rootDir, "prompts");
  }

  /** 加载共享节点库（节点定义 / 尺寸预设 / 选项预设） */
  private loadNodeLib(): NodeLib {
    const dir = this.nodesDir;
    const read = (f: string): any => JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8"));
    const lib: NodeLib = { sizes: {}, optionPresets: {}, nodes: {} };
    if (!fs.existsSync(dir)) return lib;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      if (f === "sizes.json") lib.sizes = read(f);
      else if (f === "options.json") lib.optionPresets = read(f);
      else {
        const n = read(f) as StepDef;
        lib.nodes[n.id ?? f.replace(/\.json$/, "")] = n;
      }
    }
    return lib;
  }

  /**
   * 解析流程模板：把步骤/选项里的「节点引用」与「比例简写」展开为完整定义。
   * - 步骤可写成 "review"（字符串引用）、{ "use": "cover", ...覆盖 }、或完整内联对象。
   * - 步骤含 aspects:[...] 时，按 sizes 预设展开为 coverSizesByAspect（并设默认 coverSizes）。
   * - 选项含 aspects:[...] 时展开为封面比例选项；写成 "imageGen" 字符串时取选项预设。
   * 展开后形状与旧的完全内联写法一致，下游无感知。
   */
  private resolveTemplate(raw: any): PipelineTemplate {
    const { sizes, optionPresets, nodes } = this.loadNodeLib();

    const expandAspects = (step: any): StepDef => {
      if (Array.isArray(step.aspects)) {
        const map: Record<string, CoverSize[]> = {};
        for (const a of step.aspects) if (sizes[a]) map[a] = sizes[a];
        step.coverSizesByAspect = map;
        step.coverSizes = sizes[step.aspects[0]] ?? step.coverSizes;
        delete step.aspects;
      }
      return step as StepDef;
    };

    const steps: StepDef[] = (raw.steps ?? []).map((s: any) => {
      if (typeof s === "string") return expandAspects({ ...(nodes[s] ?? { id: s }) });
      if (s.use) {
        const { use, ...override } = s;
        return expandAspects({ ...(nodes[use] ?? {}), ...override });
      }
      return expandAspects({ ...s });
    });

    const options: PipelineOption[] = (raw.options ?? [])
      .map((o: any): PipelineOption | undefined => {
        if (typeof o === "string") return optionPresets[o];
        if (Array.isArray(o.aspects)) {
          return {
            id: o.id ?? "aspect",
            label: o.label ?? "封面比例",
            default: o.default ?? o.aspects[0],
            choices: o.aspects.map((a: string) => ({ value: a, label: sizes[a]?.[0]?.label ?? a })),
          };
        }
        if (o.use) {
          const { use, ...override } = o;
          return { ...(optionPresets[use] ?? {}), ...override } as PipelineOption;
        }
        return o as PipelineOption;
      })
      .filter((o: PipelineOption | undefined): o is PipelineOption => !!o);

    return { ...raw, steps, options };
  }

  listPipelineTemplates(): PipelineTemplate[] {
    if (!fs.existsSync(this.pipelinesDir)) return [];
    return fs
      .readdirSync(this.pipelinesDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => this.resolveTemplate(JSON.parse(fs.readFileSync(path.join(this.pipelinesDir, f), "utf-8"))))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  getPipelineTemplate(id: string): PipelineTemplate | undefined {
    return this.listPipelineTemplates().find((t) => t.id === id);
  }

  /** 读取 Prompt 模板：用户覆盖优先，其次内置文件 */
  readPrompt(relPath: string): string {
    const safe = relPath.replace(/\\/g, "/");
    if (safe.includes("..")) throw new Error("非法模板路径");
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
