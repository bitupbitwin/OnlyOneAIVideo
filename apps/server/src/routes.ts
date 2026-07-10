import fs from "node:fs";
import path from "node:path";
import { pipeline as streamPipeline } from "node:stream/promises";
import type { FastifyInstance } from "fastify";
import type { PipelineEngine, ProviderRegistry, Repo, TemplateStore } from "@amp/core";
import type { Brief, EngineEvent, ProviderRow } from "@amp/shared";

const pipelineAsync = streamPipeline;

interface Ctx {
  repo: Repo;
  engine: PipelineEngine;
  registry: ProviderRegistry;
  templates: TemplateStore;
  workspaceDir: string;
}

export async function registerRoutes(app: FastifyInstance, ctx: Ctx) {
  const { repo, engine, registry, templates } = ctx;

  // ---------- WebSocket：引擎事件实时推送 ----------
  const sockets = new Set<any>();
  engine.on("event", (event: EngineEvent) => {
    const payload = JSON.stringify(event);
    for (const socket of sockets) {
      try {
        socket.send(payload);
      } catch {
        sockets.delete(socket);
      }
    }
  });
  app.get("/api/ws", { websocket: true }, (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  // ---------- 流程模板 ----------
  app.get("/api/templates", async () => templates.listPipelineTemplates());

  // ---------- 项目 ----------
  app.get("/api/projects", async () => repo.listProjects());

  app.post<{ Body: { title: string; brief: Brief } }>("/api/projects", async (req, reply) => {
    const { title, brief } = req.body;
    if (!title?.trim() || !brief?.topic?.trim()) {
      return reply.code(400).send({ error: "title 与 brief.topic 必填" });
    }
    return repo.createProject(title.trim(), brief);
  });

  app.get<{ Params: { id: string } }>("/api/projects/:id", async (req, reply) => {
    const project = repo.getProject(Number(req.params.id));
    if (!project) return reply.code(404).send({ error: "项目不存在" });
    return {
      ...project,
      pipelines: repo.listPipelinesByProject(project.id),
      materials: repo.listMaterials(project.id),
    };
  });

  app.put<{ Params: { id: string }; Body: { brief: Brief } }>("/api/projects/:id/brief", async (req, reply) => {
    const project = repo.getProject(Number(req.params.id));
    if (!project) return reply.code(404).send({ error: "项目不存在" });
    if (!req.body?.brief?.topic?.trim()) return reply.code(400).send({ error: "brief.topic 必填" });
    repo.updateProjectBrief(project.id, req.body.brief);
    return repo.getProject(project.id);
  });

  // ---------- 选题素材：粘贴文字 / 上传图片、视频、文件 ----------
  app.get<{ Params: { id: string } }>("/api/projects/:id/materials", async (req) =>
    repo.listMaterials(Number(req.params.id))
  );

  app.post<{ Params: { id: string }; Body: { content: string; note?: string } }>(
    "/api/projects/:id/materials/text",
    async (req, reply) => {
      const project = repo.getProject(Number(req.params.id));
      if (!project) return reply.code(404).send({ error: "项目不存在" });
      if (!req.body?.content?.trim()) return reply.code(400).send({ error: "文字内容不能为空" });
      return repo.createMaterial({
        projectId: project.id,
        kind: "text",
        content: req.body.content,
        note: req.body.note,
      });
    }
  );

  app.post<{ Params: { id: string } }>("/api/projects/:id/materials/upload", async (req, reply) => {
    const project = repo.getProject(Number(req.params.id));
    if (!project) return reply.code(404).send({ error: "项目不存在" });

    const dir = path.join(ctx.workspaceDir, `project-${project.id}`, "materials");
    fs.mkdirSync(dir, { recursive: true });

    const created: any[] = [];
    let note: string | undefined;
    const parts = (req as any).parts();
    for await (const part of parts) {
      if (part.type === "field" && part.fieldname === "note") {
        note = String(part.value);
        continue;
      }
      if (part.type !== "file") continue;
      const safeName = String(part.filename || "file").replace(/[\\/]/g, "_");
      const dest = path.join(dir, `${Date.now()}_${safeName}`);
      await pipelineAsync((part as any).file, fs.createWriteStream(dest));
      const mime: string = part.mimetype || "";
      const kind = mime.startsWith("image/") ? "image" : mime.startsWith("video/") ? "video" : "file";
      created.push(repo.createMaterial({ projectId: project.id, kind, originalName: safeName, filePath: dest, note }));
    }
    if (created.length === 0) return reply.code(400).send({ error: "未收到文件" });
    return created;
  });

  app.get<{ Params: { id: string } }>("/api/materials/:id/file", async (req, reply) => {
    const m = repo.getMaterial(Number(req.params.id));
    if (!m?.file_path || !fs.existsSync(m.file_path)) return reply.code(404).send({ error: "文件不存在" });
    const resolved = path.resolve(m.file_path);
    if (!resolved.startsWith(path.resolve(ctx.workspaceDir))) return reply.code(403).send({ error: "禁止访问" });
    return reply.send(fs.createReadStream(resolved));
  });

  app.delete<{ Params: { id: string } }>("/api/materials/:id", async (req) => {
    const m = repo.getMaterial(Number(req.params.id));
    if (m?.file_path && fs.existsSync(m.file_path)) fs.rmSync(m.file_path, { force: true });
    repo.deleteMaterial(Number(req.params.id));
    return { ok: true };
  });

  // ---------- 流水线 ----------
  app.post<{
    Params: { id: string };
    Body: { templateId: string; providerOverrides?: Record<string, string>; options?: Record<string, string> };
  }>("/api/projects/:id/pipelines", async (req, reply) => {
    const project = repo.getProject(Number(req.params.id));
    if (!project) return reply.code(404).send({ error: "项目不存在" });
    const template = templates.getPipelineTemplate(req.body.templateId);
    if (!template) return reply.code(400).send({ error: `流程模板 ${req.body.templateId} 不存在` });

    // 合并用户选择的运行选项与模板默认值
    const options: Record<string, string> = {};
    for (const opt of template.options ?? []) options[opt.id] = opt.default;
    for (const [k, v] of Object.entries(req.body.options ?? {})) if (v != null) options[k] = String(v);

    const pipeline = repo.createPipeline(project.id, template.id, template.platform, template.mode, template.name, options);
    const providers = repo.listProviders().filter((p) => p.enabled);

    // 条件步骤：when 不匹配则跳过；据此确定实际创建的步骤集合
    const activeDefs = template.steps.filter(
      (def) => !def.when || Object.entries(def.when).every(([k, v]) => options[k] === v)
    );
    const activeIds = new Set(activeDefs.map((d) => d.id));

    for (const def of activeDefs) {
      const override = req.body.providerOverrides?.[def.id];
      const providerId =
        override ??
        (def.defaultProvider && repo.getProvider(def.defaultProvider)?.enabled ? def.defaultProvider : undefined) ??
        pickProvider(def.type, providers);
      // 依赖过滤为实际存在的步骤；封面尺寸按画面比例选取
      const effectiveDef = {
        ...def,
        needs: def.needs.filter((n) => activeIds.has(n)),
        coverSizes: def.coverSizesByAspect?.[options.aspect] ?? def.coverSizes,
      };
      repo.createStep(pipeline.id, effectiveDef, providerId ?? null);
    }
    return repo.getPipeline(pipeline.id);
  });

  app.get<{ Params: { id: string } }>("/api/pipelines/:id", async (req, reply) => {
    const pipeline = repo.getPipeline(Number(req.params.id));
    if (!pipeline) return reply.code(404).send({ error: "流水线不存在" });
    const template = templates.getPipelineTemplate(pipeline.template_id);
    const steps = repo.listStepsByPipeline(pipeline.id).map((s) => ({
      ...s,
      artifacts: repo.listArtifactsByStep(s.id),
    }));
    return { ...pipeline, steps, reviews: repo.listReviewsByPipeline(pipeline.id), notes: template?.notes ?? [] };
  });

  app.post<{ Params: { id: string }; Body: { auto?: boolean } }>("/api/pipelines/:id/run", async (req, reply) => {
    const pipeline = repo.getPipeline(Number(req.params.id));
    if (!pipeline) return reply.code(404).send({ error: "流水线不存在" });
    if (req.body?.auto != null) repo.setPipelineAuto(pipeline.id, !!req.body.auto);
    engine.kick(pipeline.id);
    return { ok: true };
  });

  // ---------- 步骤 ----------
  app.post<{ Params: { id: string }; Body: { feedback?: string } }>("/api/steps/:id/rerun", async (req, reply) => {
    try {
      engine.rerunStep(Number(req.params.id), req.body?.feedback);
      return { ok: true };
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }
  });

  app.post<{ Params: { id: string }; Body: { providerId: string } }>("/api/steps/:id/provider", async (req, reply) => {
    const step = repo.getStep(Number(req.params.id));
    if (!step) return reply.code(404).send({ error: "步骤不存在" });
    if (!repo.getProvider(req.body.providerId)) return reply.code(400).send({ error: "引擎不存在" });
    repo.setStepProvider(step.id, req.body.providerId);
    return repo.getStep(step.id);
  });

  app.post<{ Params: { id: string } }>("/api/steps/:id/confirm", async (req, reply) => {
    try {
      engine.confirmHumanGate(Number(req.params.id));
      return { ok: true };
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }
  });

  // ---------- 人工接管：拿提示词去外部模型手动生成，再回填工作区 ----------
  app.post<{ Params: { id: string } }>("/api/steps/:id/render-prompt", async (req, reply) => {
    try {
      return { prompt: engine.renderPrompt(Number(req.params.id)) };
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }
  });

  app.post<{ Params: { id: string }; Body: { content: string } }>("/api/steps/:id/manual-text", async (req, reply) => {
    try {
      await engine.submitManualText(Number(req.params.id), req.body?.content ?? "");
      return { ok: true };
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }
  });

  app.post<{ Params: { id: string } }>("/api/steps/:id/manual-image", async (req, reply) => {
    const step = repo.getStep(Number(req.params.id));
    if (!step) return reply.code(404).send({ error: "步骤不存在" });
    const dir = path.join(ctx.workspaceDir, `manual-uploads`, `step-${step.id}-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    const saved: string[] = [];
    for await (const part of (req as any).parts()) {
      if (part.type !== "file") continue;
      const safeName = String(part.filename || "cover.png").replace(/[\\/]/g, "_");
      const dest = path.join(dir, safeName);
      await pipelineAsync((part as any).file, fs.createWriteStream(dest));
      saved.push(dest);
    }
    try {
      await engine.submitManualImages(step.id, saved);
      return { ok: true };
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }
  });

  // ---------- 产物 ----------
  app.post<{ Params: { id: string } }>("/api/artifacts/:id/select", async (req, reply) => {
    try {
      return repo.selectArtifact(Number(req.params.id));
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }
  });

  // 单张图片重抽（MV 批量图片）
  app.post<{ Params: { id: string } }>("/api/artifacts/:id/reroll", async (req, reply) => {
    try {
      return await engine.rerollBatchImage(Number(req.params.id));
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }
  });

  // 单张图片上传替换
  app.post<{ Params: { id: string } }>("/api/artifacts/:id/replace", async (req, reply) => {
    const art = repo.getArtifact(Number(req.params.id));
    if (!art) return reply.code(404).send({ error: "产物不存在" });
    const dir = path.join(ctx.workspaceDir, "manual-uploads", `artifact-${art.id}-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    let saved: string | undefined;
    for await (const part of (req as any).parts()) {
      if (part.type !== "file") continue;
      const dest = path.join(dir, String(part.filename || "image.png").replace(/[\\/]/g, "_"));
      await pipelineAsync((part as any).file, fs.createWriteStream(dest));
      saved = dest;
      break;
    }
    if (!saved) return reply.code(400).send({ error: "未收到图片" });
    if (art.file_path && fs.existsSync(art.file_path)) fs.rmSync(art.file_path, { force: true });
    return repo.updateArtifactFile(art.id, saved);
  });

  app.get<{ Params: { id: string } }>("/api/artifacts/:id/file", async (req, reply) => {
    const artifact = repo.getArtifact(Number(req.params.id));
    if (!artifact?.file_path || !fs.existsSync(artifact.file_path)) {
      return reply.code(404).send({ error: "文件不存在" });
    }
    const resolved = path.resolve(artifact.file_path);
    if (!resolved.startsWith(path.resolve(ctx.workspaceDir))) {
      return reply.code(403).send({ error: "禁止访问工作目录之外的文件" });
    }
    const ext = path.extname(resolved).toLowerCase();
    const mime =
      ext === ".png" ? "image/png" : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : "application/octet-stream";
    reply.header("Content-Type", mime);
    return reply.send(fs.createReadStream(resolved));
  });

  // ---------- 导出打包 ----------
  app.get<{ Params: { id: string } }>("/api/pipelines/:id/export", async (req, reply) => {
    const pipeline = repo.getPipeline(Number(req.params.id));
    if (!pipeline) return reply.code(404).send({ error: "流水线不存在" });
    const template = templates.getPipelineTemplate(pipeline.template_id);
    const steps = repo.listStepsByPipeline(pipeline.id);
    const reviews = repo.listReviewsByPipeline(pipeline.id);

    const archiver = (await import("archiver")).default;
    const archive = archiver("zip", { zlib: { level: 6 } });
    const filename = `${pipeline.name.replace(/[\\/:*?"<>|\s]+/g, "-")}-p${pipeline.id}.zip`;
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
    });
    archive.pipe(reply.raw);
    archive.on("error", () => reply.raw.end());

    for (const step of steps) {
      const artifacts = repo.listArtifactsByStep(step.id);
      if (artifacts.length === 0) continue;
      const latest = Math.max(...artifacts.map((a) => a.version));
      const current = artifacts.filter((a) => a.version === latest);
      const selected = current.find((a) => a.selected) ?? artifacts.find((a) => a.selected);

      if (step.type === "title") {
        const lines = [`【已选标题】\n${selected?.content ?? "(未选定)"}`, "", "【全部候选】"];
        for (const a of current) lines.push(`- ${a.content}${a.selected ? "  ←已选" : ""}`);
        archive.append(lines.join("\n"), { name: "01-标题.txt" });
      } else if (step.type === "content") {
        if (selected?.content) archive.append(selected.content, { name: "02-内容.md" });
      } else if (step.type === "cover") {
        for (const a of current) {
          if (!a.file_path || !fs.existsSync(a.file_path)) continue;
          const label = (a.label ?? "cover").replace(/[\\/:*?"<>|\s]+/g, "_");
          archive.file(a.file_path, { name: `03-封面/${label}_${a.id}${path.extname(a.file_path)}` });
        }
      } else if (step.type === "video") {
        const draft = current.find((a) => a.label === "剪映草稿目录");
        if (draft?.file_path && fs.existsSync(draft.file_path)) {
          archive.directory(draft.file_path, "04-剪映草稿");
        }
        const script = current.find((a) => a.kind === "text" && a.selected);
        if (script?.content) archive.append(script.content, { name: "04-分镜脚本.md" });
      } else if (step.type === "lyrics") {
        if (selected?.content) archive.append(selected.content, { name: "01-歌词.txt" });
      } else if (step.type === "image-prompts") {
        if (selected?.content) archive.append(selected.content, { name: "02-图片提示词.txt" });
      } else if (step.type === "video-prompts") {
        if (selected?.content) archive.append(selected.content, { name: "03-视频提示词.txt" });
      } else if (step.type === "subtitle") {
        const srt = current.find((a) => a.kind === "file" && a.file_path && fs.existsSync(a.file_path));
        if (srt?.file_path) archive.file(srt.file_path, { name: "字幕.srt" });
        else if (selected?.content) archive.append(selected.content, { name: "字幕.srt" });
      } else if (step.type === "docx") {
        const doc = current.find((a) => a.kind === "file" && a.file_path && fs.existsSync(a.file_path));
        if (doc?.file_path) archive.file(doc.file_path, { name: `提示词文档${path.extname(doc.file_path)}` });
      } else if (step.type === "batch-images") {
        for (const a of current) {
          if (a.kind !== "image" || !a.file_path || !fs.existsSync(a.file_path)) continue;
          const label = (a.label ?? "image").replace(/[\\/:*?"<>|\s]+/g, "_");
          archive.file(a.file_path, { name: `图片/${label}${path.extname(a.file_path)}` });
        }
      } else if (step.type === "image-to-video") {
        for (const a of current) {
          if (a.kind !== "file" || !a.file_path || !fs.existsSync(a.file_path)) continue;
          const label = (a.label ?? "clip").replace(/[\\/:*?"<>|\s]+/g, "_");
          archive.file(a.file_path, { name: `视频片段/${label}${path.extname(a.file_path)}` });
        }
      }
    }

    if (reviews.length > 0) {
      const lines = ["# 评审报告", ""];
      for (const r of reviews) {
        lines.push(`## ${r.target}（${r.provider_id}）`);
        lines.push(`- 结论：${r.verdict}${r.total ? `，总分 ${r.total}` : ""}`);
        const scores = Object.entries(r.scores as Record<string, number>);
        if (scores.length > 0) lines.push(`- 各维度：${scores.map(([k, v]) => `${k}=${v}`).join("，")}`);
        for (const issue of r.issues) lines.push(`- ⚠ ${issue}`);
        for (const s of r.suggestions) lines.push(`- 💡 ${s}`);
        lines.push("");
      }
      archive.append(lines.join("\n"), { name: "05-评审报告.md" });
    }

    const notes = template?.notes ?? [];
    if (notes.length > 0) {
      archive.append(
        ["# 发布注意事项（发布前逐条核对）", "", ...notes.map((n) => `- [ ] ${n}`)].join("\n"),
        { name: "06-发布注意事项.md" }
      );
    }
    await archive.finalize();
    return reply;
  });

  // ---------- 网页端登录管理 ----------
  const webLogins = new Map<string, { close: () => Promise<void> }>();

  app.post<{ Params: { id: string } }>("/api/providers/:id/web-login", async (req, reply) => {
    const row = repo.getProvider(req.params.id);
    if (!row) return reply.code(404).send({ error: "引擎不存在" });
    if (row.kind !== "web") return reply.code(400).send({ error: "仅网页端引擎支持登录窗口" });
    try {
      await webLogins.get(row.id)?.close();
      const { openLoginWindow } = await import("@amp/providers");
      const session = await openLoginWindow(row);
      webLogins.set(row.id, session);
      return { ok: true, detail: "已弹出浏览器窗口，请完成登录；登录后可直接关闭窗口" };
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }
  });

  app.post<{ Params: { id: string } }>("/api/providers/:id/web-login/close", async (req) => {
    await webLogins.get(req.params.id)?.close();
    webLogins.delete(req.params.id);
    return { ok: true };
  });

  // ---------- 引擎管理 ----------
  app.get("/api/providers", async () => repo.listProviders());

  app.put<{ Params: { id: string }; Body: ProviderRow }>("/api/providers/:id", async (req, reply) => {
    const body = req.body;
    if (!body.kind || !body.name) return reply.code(400).send({ error: "kind/name 必填" });
    repo.upsertProvider({ ...body, id: req.params.id });
    return repo.getProvider(req.params.id);
  });

  app.delete<{ Params: { id: string } }>("/api/providers/:id", async (req) => {
    repo.deleteProvider(req.params.id);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/providers/:id/health", async (req, reply) => {
    const row = repo.getProvider(req.params.id);
    if (!row) return reply.code(404).send({ error: "引擎不存在" });
    const factory = (await import("@amp/providers")).providerFactories[row.kind];
    if (!factory) return { ok: false, detail: `不支持的类型 ${row.kind}` };
    try {
      return await factory(row).healthCheck();
    } catch (err: any) {
      return { ok: false, detail: err.message };
    }
  });

  // ---------- Prompt 模板 ----------
  app.get("/api/prompts", async () => {
    return templates.listPromptPaths().map((p) => ({ path: p, overridden: repo.getPromptOverride(p) != null }));
  });

  app.get<{ Querystring: { path: string } }>("/api/prompts/content", async (req, reply) => {
    try {
      return { path: req.query.path, content: templates.readPrompt(req.query.path) };
    } catch (err: any) {
      return reply.code(404).send({ error: err.message });
    }
  });

  app.put<{ Body: { path: string; content: string } }>("/api/prompts/content", async (req) => {
    repo.setPromptOverride(req.body.path, req.body.content);
    return { ok: true };
  });

  app.delete<{ Querystring: { path: string } }>("/api/prompts/content", async (req) => {
    repo.deletePromptOverride(req.query.path);
    return { ok: true };
  });
}

/** 按步骤类型挑选默认引擎：封面→出图类，其余→文本类（cli 优先） */
function pickProvider(stepType: string, enabled: ProviderRow[]): string | undefined {
  if (stepType === "image-to-video") return enabled.find((p) => p.kind === "api-video")?.id;
  if (stepType === "cover" || stepType === "batch-images") return enabled.find((p) => p.kind === "api-image")?.id;
  const text = enabled.filter((p) => p.kind === "cli" || p.kind === "api-text");
  return (text.find((p) => p.kind === "cli") ?? text[0])?.id;
}
