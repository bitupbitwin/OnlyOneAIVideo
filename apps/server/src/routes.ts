import fs from "node:fs";
import path from "node:path";
import { pipeline as streamPipeline } from "node:stream/promises";
import type { FastifyInstance } from "fastify";
import { MAINLINE_STEP_DEFS, type PipelineEngine, type ProviderRegistry, type Repo, type TemplateStore } from "@amp/core";
import type { Brief, EngineEvent, ProviderRow, SourceType } from "@amp/shared";
import { ensureAnalysisImage, ensureImageThumbnail } from "@amp/providers";

interface Ctx {
  repo: Repo;
  engine: PipelineEngine;
  registry: ProviderRegistry;
  templates: TemplateStore;
  workspaceDir: string;
}

export async function registerRoutes(app: FastifyInstance, ctx: Ctx) {
  const { repo, engine, registry, templates } = ctx;

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

  app.get("/api/health", async () => ({
    ok: true,
    schemaVersion: 2,
    ffmpegPath: null,
    ffprobePath: null,
    ffmpegOk: false,
    uptimeSec: Math.round(process.uptime()),
  }));

  app.get("/api/topics", async () => repo.listTopics());

  app.post<{ Body: { title: string; sourceType?: SourceType; brief?: Brief; auto?: boolean } }>(
    "/api/topics",
    async (req, reply) => {
      const title = req.body?.title?.trim();
      if (!title) return reply.code(400).send({ error: "title 必填" });
      const sourceType = req.body.sourceType ?? "text";
      if (!["text", "image", "footage"].includes(sourceType)) return reply.code(400).send({ error: "sourceType 不合法" });
      const brief = { topic: title, ...(req.body.brief ?? {}) };
      const topic = repo.createTopic({ title, sourceType, brief, auto: !!req.body.auto });
      engine.bootstrapSteps(topic.id);
      return getTopicDetail(repo, topic.id);
    }
  );

  app.get<{ Params: { id: string } }>("/api/topics/:id", async (req, reply) => {
    const detail = getTopicDetail(repo, Number(req.params.id));
    if (!detail) return reply.code(404).send({ error: "选题不存在" });
    return detail;
  });

  app.delete<{ Params: { id: string } }>("/api/topics/:id", async (req, reply) => {
    const topicId = Number(req.params.id);
    const topic = repo.getTopic(topicId);
    if (!topic) return reply.code(404).send({ error: "选题不存在" });
    if (repo.listStepsByTopic(topicId).some((step) => step.status === "running")) {
      return reply.code(409).send({ error: "选题正在运行，完成后才能删除" });
    }
    repo.deleteTopic(topicId);
    const workspaceRoot = path.resolve(ctx.workspaceDir);
    const topicDir = path.resolve(workspaceRoot, `topic-${topicId}`);
    if (topicDir.startsWith(`${workspaceRoot}${path.sep}`) && fs.existsSync(topicDir)) {
      fs.rmSync(topicDir, { recursive: true, force: true });
    }
    return { ok: true };
  });

  app.post<{ Body: { ids: number[] } }>("/api/topics/bulk-delete", async (req, reply) => {
    const ids = [...new Set((req.body?.ids ?? []).map(Number).filter((id) => Number.isInteger(id) && id > 0))];
    if (ids.length === 0) return reply.code(400).send({ error: "请至少选择一个选题" });
    const topics = ids.map((id) => repo.getTopic(id));
    if (topics.some((topic) => !topic)) return reply.code(404).send({ error: "部分选题不存在，请刷新后重试" });
    const running = ids.filter((id) => repo.listStepsByTopic(id).some((step) => step.status === "running"));
    if (running.length > 0) return reply.code(409).send({ error: "所选项目中有正在运行的选题，请完成后再删除" });

    const workspaceRoot = path.resolve(ctx.workspaceDir);
    for (const id of ids) {
      repo.deleteTopic(id);
      const topicDir = path.resolve(workspaceRoot, `topic-${id}`);
      if (topicDir.startsWith(`${workspaceRoot}${path.sep}`) && fs.existsSync(topicDir)) {
        fs.rmSync(topicDir, { recursive: true, force: true });
      }
    }
    return { ok: true, deleted: ids.length };
  });

  app.put<{ Params: { id: string }; Body: { brief: Brief } }>("/api/topics/:id/brief", async (req, reply) => {
    const topic = repo.getTopic(Number(req.params.id));
    if (!topic) return reply.code(404).send({ error: "选题不存在" });
    if (!req.body?.brief?.topic?.trim()) return reply.code(400).send({ error: "brief.topic 必填" });
    repo.updateTopicBrief(topic.id, req.body.brief);
    return getTopicDetail(repo, topic.id);
  });

  app.post<{ Params: { id: string }; Body: { auto?: boolean } }>("/api/topics/:id/run", async (req, reply) => {
    const topic = repo.getTopic(Number(req.params.id));
    if (!topic) return reply.code(404).send({ error: "选题不存在" });
    const materials = repo.listMaterials(topic.id);
    if (topic.source_type === "image" && !materials.some((material) => material.kind === "image")) {
      return reply.code(400).send({ error: "请先上传至少一张参考图，再运行素材理解" });
    }
    if (topic.source_type === "footage" && !materials.some((material) => material.kind === "video")) {
      return reply.code(400).send({ error: "请先上传实拍视频，再运行素材理解" });
    }
    if (req.body?.auto != null) repo.setTopicAuto(topic.id, !!req.body.auto);
    engine.kick(topic.id, true);
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>("/api/topics/:id/materials", async (req) => repo.listMaterials(Number(req.params.id)));

  app.post<{ Params: { id: string }; Body: { content: string; note?: string } }>(
    "/api/topics/:id/materials/text",
    async (req, reply) => {
      const topic = repo.getTopic(Number(req.params.id));
      if (!topic) return reply.code(404).send({ error: "选题不存在" });
      if (!req.body?.content?.trim()) return reply.code(400).send({ error: "文字内容不能为空" });
      return repo.createMaterial({ topicId: topic.id, kind: "text", content: req.body.content, note: req.body.note });
    }
  );

  app.post<{ Params: { id: string } }>("/api/topics/:id/materials/upload", async (req, reply) => {
    const topic = repo.getTopic(Number(req.params.id));
    if (!topic) return reply.code(404).send({ error: "选题不存在" });
    const dir = path.join(ctx.workspaceDir, `topic-${topic.id}`, "materials");
    fs.mkdirSync(dir, { recursive: true });

    const created: any[] = [];
    let note: string | undefined;
    for await (const part of (req as any).parts()) {
      if (part.type === "field" && part.fieldname === "note") {
        note = String(part.value);
        continue;
      }
      if (part.type !== "file") continue;
      const safeName = String(part.filename || "file").replace(/[\\/]/g, "_");
      const dest = path.join(dir, `${Date.now()}_${safeName}`);
      await streamPipeline((part as any).file, fs.createWriteStream(dest));
      const mime: string = part.mimetype || "";
      const kind = mime.startsWith("image/") ? "image" : mime.startsWith("video/") ? "video" : "file";
      if (kind === "image") {
        try {
          await ensureAnalysisImage(dest, `${dest}.analysis.jpg`);
        } catch (error: any) {
          fs.rmSync(dest, { force: true });
          return reply.code(422).send({ error: `图片无法处理，请换用 JPG/PNG/WebP：${error?.message ?? String(error)}` });
        }
      }
      created.push(repo.createMaterial({ topicId: topic.id, kind, originalName: safeName, filePath: dest, note }));
    }
    if (created.length === 0) return reply.code(400).send({ error: "未收到文件" });
    return created;
  });

  app.delete<{ Params: { id: string } }>("/api/materials/:id", async (req) => {
    const m = repo.getMaterial(Number(req.params.id));
    if (m?.file_path && fs.existsSync(m.file_path)) fs.rmSync(m.file_path, { force: true });
    if (m?.file_path && fs.existsSync(`${m.file_path}.thumb.jpg`)) fs.rmSync(`${m.file_path}.thumb.jpg`, { force: true });
    if (m?.file_path && fs.existsSync(`${m.file_path}.analysis.jpg`)) fs.rmSync(`${m.file_path}.analysis.jpg`, { force: true });
    repo.deleteMaterial(Number(req.params.id));
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>("/api/materials/:id/file", async (req, reply) => {
    const material = repo.getMaterial(Number(req.params.id));
    if (!material?.file_path || !fs.existsSync(material.file_path)) return reply.code(404).send({ error: "素材文件不存在" });
    const resolved = path.resolve(material.file_path);
    const root = path.resolve(ctx.workspaceDir);
    const rel = path.relative(root, resolved);
    if (rel.startsWith("..") || path.isAbsolute(rel)) return reply.code(403).send({ error: "禁止访问工作目录之外的文件" });
    const ext = path.extname(resolved).toLowerCase();
    const mime =
      ext === ".png" ? "image/png"
      : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg"
      : ext === ".webp" ? "image/webp"
      : ext === ".mp4" ? "video/mp4"
      : "application/octet-stream";
    reply.header("Content-Type", mime);
    return reply.send(fs.createReadStream(resolved));
  });

  app.get<{ Params: { id: string } }>("/api/materials/:id/thumbnail", async (req, reply) => {
    const material = repo.getMaterial(Number(req.params.id));
    if (!material?.file_path || material.kind !== "image" || !fs.existsSync(material.file_path)) {
      return reply.code(404).send({ error: "图片素材不存在" });
    }
    const resolved = path.resolve(material.file_path);
    const root = path.resolve(ctx.workspaceDir);
    const rel = path.relative(root, resolved);
    if (rel.startsWith("..") || path.isAbsolute(rel)) return reply.code(403).send({ error: "禁止访问工作目录之外的文件" });
    const thumbnail = `${resolved}.thumb.jpg`;
    try {
      await ensureImageThumbnail(resolved, thumbnail);
    } catch (error: any) {
      return reply.code(422).send({ error: `无法生成图片缩略图：${error?.message ?? String(error)}` });
    }
    reply.header("Content-Type", "image/jpeg");
    reply.header("Cache-Control", "private, max-age=3600");
    return reply.send(fs.createReadStream(thumbnail));
  });

  app.post<{ Params: { id: string }; Body: { feedback?: string } }>("/api/steps/:id/rerun", async (req, reply) => {
    try {
      engine.rerunStep(Number(req.params.id), req.body?.feedback);
      return { ok: true };
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }
  });

  app.post<{ Params: { id: string } }>("/api/steps/:id/run", async (req, reply) => {
    try {
      engine.runPendingStep(Number(req.params.id));
      return { ok: true };
    } catch (err: any) {
      return reply.code(400).send({ error: err?.message ?? String(err) });
    }
  });

  app.post<{ Params: { id: string }; Body: { providerId: string } }>("/api/steps/:id/provider", async (req, reply) => {
    const step = repo.getStep(Number(req.params.id));
    if (!step) return reply.code(404).send({ error: "步骤不存在" });
    const provider = repo.getProvider(req.body.providerId);
    if (!provider) return reply.code(400).send({ error: "引擎不存在" });
    const allowedKinds = MAINLINE_STEP_DEFS[step.step_id].providerKinds;
    if (!allowedKinds.includes(provider.kind)) {
      return reply.code(400).send({ error: `该模块不支持“${provider.name}”；请选择 ${allowedKinds.join(" / ")} 类型引擎` });
    }
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

  app.post<{ Params: { id: string } }>("/api/artifacts/:id/select", async (req, reply) => {
    try {
      return engine.selectArtifact(Number(req.params.id));
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }
  });

  app.get<{ Params: { id: string } }>("/api/artifacts/:id/file", async (req, reply) => {
    const artifact = repo.getArtifact(Number(req.params.id));
    if (!artifact?.file_path || !fs.existsSync(artifact.file_path)) return reply.code(404).send({ error: "文件不存在" });
    const resolved = path.resolve(artifact.file_path);
    const root = path.resolve(ctx.workspaceDir);
    const rel = path.relative(root, resolved);
    if (rel.startsWith("..") || path.isAbsolute(rel)) return reply.code(403).send({ error: "禁止访问工作目录之外的文件" });
    const ext = path.extname(resolved).toLowerCase();
    const mime =
      ext === ".png" ? "image/png"
      : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg"
      : ext === ".wav" ? "audio/wav"
      : ext === ".mp3" ? "audio/mpeg"
      : ext === ".mp4" ? "video/mp4"
      : ext === ".ass" || ext === ".srt" || ext === ".json" || ext === ".txt" ? "text/plain; charset=utf-8"
      : "application/octet-stream";
    reply.header("Content-Type", mime);
    reply.header("Accept-Ranges", "bytes");

    // Range 支持：浏览器 <video> 拖动进度条需要 206 分段响应
    const size = fs.statSync(resolved).size;
    const range = req.headers.range;
    const match = typeof range === "string" ? range.match(/^bytes=(\d*)-(\d*)$/) : null;
    if (match && (match[1] || match[2])) {
      const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
      const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
      if (start >= size || start > end) {
        return reply.code(416).header("Content-Range", `bytes */${size}`).send();
      }
      reply.code(206);
      reply.header("Content-Range", `bytes ${start}-${end}/${size}`);
      reply.header("Content-Length", end - start + 1);
      return reply.send(fs.createReadStream(resolved, { start, end }));
    }
    reply.header("Content-Length", size);
    return reply.send(fs.createReadStream(resolved));
  });

  app.get("/api/platforms", async () => templates.listPlatforms());

  app.post<{ Params: { id: string }; Body: { platforms: string[] } }>("/api/topics/:id/adapt", async (req, reply) => {
    const topic = repo.getTopic(Number(req.params.id));
    if (!topic) return reply.code(404).send({ error: "选题不存在" });
    try {
      engine.requestAdapt(topic.id, req.body?.platforms ?? []);
      return { ok: true };
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }
  });

  app.get<{ Params: { id: string } }>("/api/topics/:id/export", async (req, reply) => {
    const topic = repo.getTopic(Number(req.params.id));
    if (!topic) return reply.code(404).send({ error: "选题不存在" });
    const pkgRoot = path.join(ctx.workspaceDir, `topic-${topic.id}`, "packages");
    if (!fs.existsSync(pkgRoot) || fs.readdirSync(pkgRoot).length === 0) {
      return reply.code(400).send({ error: "还没有发布包，请先在「平台派生」勾选平台生成" });
    }
    const { default: archiver } = await import("archiver");
    reply.header("Content-Type", "application/zip");
    reply.header("Content-Disposition", `attachment; filename="topic-${topic.id}-packages.zip"`);
    const archive = archiver("zip", { zlib: { level: 6 } });
    archive.directory(pkgRoot, false);
    void archive.finalize();
    return reply.send(archive as any);
  });

  app.get<{ Params: { id: string } }>("/api/topics/:id/cover-prompt", async (req, reply) => {
    const topic = repo.getTopic(Number(req.params.id));
    if (!topic) return reply.code(404).send({ error: "选题不存在" });
    return { prompt: engine.getCoverPrompt(topic.id) };
  });

  app.put<{ Params: { id: string }; Body: { prompt: string } }>("/api/topics/:id/cover-prompt", async (req, reply) => {
    const topic = repo.getTopic(Number(req.params.id));
    if (!topic) return reply.code(404).send({ error: "选题不存在" });
    try {
      engine.setCoverPrompt(topic.id, req.body?.prompt ?? "");
      return { ok: true, prompt: engine.getCoverPrompt(topic.id) };
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }
  });

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
    try {
      return await registry.get(row.id).healthCheck();
    } catch (err: any) {
      return { ok: false, detail: err.message };
    }
  });

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

function getTopicDetail(repo: Repo, id: number) {
  const topic = repo.getTopic(id);
  if (!topic) return undefined;
  const steps = repo.listStepsByTopic(id).map((s) => ({ ...s, artifacts: repo.listArtifactsByStep(s.id) }));
  return { ...topic, steps, materials: repo.listMaterials(id), packages: repo.listPackages(id) };
}
