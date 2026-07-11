import fs from "node:fs";
import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import { pipeline as streamPipeline } from "node:stream/promises";
import type { FastifyInstance } from "fastify";
import { MAINLINE_STEP_DEFS, providerSupportsStep, type PipelineEngine, type ProviderRegistry, type Repo, type TemplateStore } from "@amp/core";
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

  app.post<{ Body: { title: string; sourceType?: SourceType; brief?: Brief; auto?: boolean; material?: { content: string; note?: string } } }>(
    "/api/topics",
    { bodyLimit: 2 * 1024 * 1024 },
    async (req, reply) => {
      const title = req.body?.title?.trim();
      if (!title) return reply.code(400).send({ error: "title 必填" });
      const sourceType = req.body.sourceType ?? "text";
      if (!["text", "image", "footage"].includes(sourceType)) return reply.code(400).send({ error: "sourceType 不合法" });
      const brief = { topic: title, ...(req.body.brief ?? {}) };
      const materialContent = req.body.material?.content?.trim() ?? "";
      if (materialContent.length > 300_000) return reply.code(413).send({ error: "文字素材最多 30 万字，请拆分或精简后再导入" });
      const topic = repo.createTopic({ title, sourceType, brief, auto: !!req.body.auto });
      try {
        if (materialContent) {
          repo.createMaterial({ topicId: topic.id, kind: "text", content: materialContent, note: req.body.material?.note });
        }
        engine.bootstrapSteps(topic.id);
        return getTopicDetail(repo, topic.id);
      } catch (error) {
        repo.deleteTopic(topic.id);
        throw error;
      }
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

  app.post<{ Body: { url: string } }>("/api/materials/fetch-url", async (req, reply) => {
    try {
      return await fetchWebMaterial(req.body?.url);
    } catch (error: any) {
      return reply.code(400).send({ error: error?.message ?? String(error) });
    }
  });

  app.post<{ Params: { id: string }; Body: { content: string; note?: string } }>(
    "/api/topics/:id/materials/text",
    { bodyLimit: 2 * 1024 * 1024 },
    async (req, reply) => {
      const topic = repo.getTopic(Number(req.params.id));
      if (!topic) return reply.code(404).send({ error: "选题不存在" });
      if (!req.body?.content?.trim()) return reply.code(400).send({ error: "文字内容不能为空" });
      if (req.body.content.trim().length > 300_000) return reply.code(413).send({ error: "文字素材最多 30 万字" });
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
    if (!provider.enabled) return reply.code(400).send({ error: `引擎“${provider.name}”当前未启用` });
    const allowedKinds = MAINLINE_STEP_DEFS[step.step_id].providerKinds;
    if (!allowedKinds.includes(provider.kind)) {
      return reply.code(400).send({ error: `该模块不支持“${provider.name}”；请选择 ${allowedKinds.join(" / ")} 类型引擎` });
    }
    if (!providerSupportsStep(provider, step.step_id)) {
      return reply.code(400).send({ error: `引擎“${provider.name}”缺少该模块所需的能力标签或真实文件输出能力` });
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

async function fetchWebMaterial(input: string | undefined) {
  if (!input?.trim()) throw new Error("网页地址不能为空");
  const normalized = /^[a-z][a-z\d+.-]*:\/\//i.test(input.trim()) ? input.trim() : `https://${input.trim()}`;
  let current = new URL(normalized);
  for (let redirectCount = 0; redirectCount <= 5; redirectCount++) {
    const response = await fetchPublicPage(current);
    if (response.status >= 300 && response.status < 400) {
      const location = response.location;
      if (!location) throw new Error(`网页重定向缺少地址（HTTP ${response.status}）`);
      current = new URL(location, current);
      continue;
    }
    if (response.status < 200 || response.status >= 300) throw new Error(`网页返回 HTTP ${response.status}`);
    const contentType = response.contentType;
    if (!/text\/html|application\/xhtml\+xml|text\/plain/i.test(contentType)) {
      throw new Error("该地址不是可读取的网页正文");
    }
    const html = decodeWebBody(response.body, contentType);
    const article = extractWebArticle(html);
    if (!article.content) throw new Error("未从网页中提取到正文");
    return { ...article, url: current.toString() };
  }
  throw new Error("网页重定向次数过多");
}

async function resolvePublicAddress(url: URL): Promise<{ address: string; family: 4 | 6 }> {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("只支持 HTTP 或 HTTPS 网页地址");
  if (url.username || url.password) throw new Error("网页地址不能包含账号或密码");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    throw new Error("禁止访问本机或内网地址");
  }
  const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  // 混合解析结果也拒绝，防止域名在公网和内网地址之间切换。
  if (addresses.length === 0 || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error("禁止访问本机或内网地址");
  }
  const selected = addresses[0];
  return { address: selected.address, family: selected.family as 4 | 6 };
}

/** 使用已经校验的 IP 发起请求，避免校验后由底层再次 DNS 解析造成重绑定。 */
async function fetchPublicPage(url: URL): Promise<{ status: number; location: string; contentType: string; body: Uint8Array }> {
  const pinned = await resolvePublicAddress(url);
  const transport = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const request = transport.request(url, {
      method: "GET",
      headers: {
        Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1",
        "User-Agent": "Mozilla/5.0 OnlyOneAIVideo/1.0",
      },
      // Node ≥20 默认开启 autoSelectFamily，连接走 lookupAndConnectMultiple，
      // 会以 { all: true } 调用自定义 lookup 并期望返回地址数组；此时必须回调数组，
      // 否则底层拿到 undefined 地址报 ERR_INVALID_IP_ADDRESS。两种调用形态都要兼容。
      lookup: ((_hostname: string, options: any, callback: (error: Error | null, address: any, family?: number) => void) => {
        if (options && options.all) {
          callback(null, [{ address: pinned.address, family: pinned.family }]);
        } else {
          callback(null, pinned.address, pinned.family);
        }
      }) as any,
      ...(url.protocol === "https:" ? { servername: url.hostname } : {}),
    }, (response) => {
      const chunks: Buffer[] = [];
      let total = 0;
      response.on("data", (chunk: Buffer) => {
        total += chunk.length;
        if (total > 5 * 1024 * 1024) {
          request.destroy(new Error("网页正文超过 5 MB，无法导入"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        location: String(response.headers.location ?? ""),
        contentType: String(response.headers["content-type"] ?? ""),
        body: new Uint8Array(Buffer.concat(chunks)),
      }));
    });
    request.setTimeout(20_000, () => request.destroy(new Error("网页抓取超时（20秒）")));
    request.on("error", reject);
    request.end();
  });
}

export function isPrivateAddress(address: string): boolean {
  if (net.isIPv4(address)) {
    const [a, b] = address.split(".").map(Number);
    return a === 0
      || a === 10
      || a === 127
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || a >= 224;
  }
  if (net.isIPv6(address)) {
    const normalized = address.toLowerCase();
    const mapped = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
    return normalized === "::"
      || normalized === "::1"
      || normalized.startsWith("fc")
      || normalized.startsWith("fd")
      || normalized.startsWith("fe8")
      || normalized.startsWith("fe9")
      || normalized.startsWith("fea")
      || normalized.startsWith("feb")
      || !!(mapped && isPrivateAddress(mapped));
  }
  return true;
}

function decodeWebBody(bytes: Uint8Array, contentType: string): string {
  const initial = new TextDecoder("utf-8").decode(bytes.slice(0, 4096));
  const charset = contentType.match(/charset\s*=\s*["']?([^;"'\s]+)/i)?.[1]
    ?? initial.match(/<meta[^>]+charset\s*=\s*["']?([^"'\s/>]+)/i)?.[1]
    ?? initial.match(/<meta[^>]+content=["'][^"']*charset=([^"'\s;]+)/i)?.[1]
    ?? "utf-8";
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

export function extractWebArticle(html: string): { title: string; content: string } {
  const title = decodeHtml(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "")
    .replace(/\s+/g, " ")
    .trim();
  const cleaned = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|svg|canvas|iframe|nav|footer|header|aside)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
  const articleCandidates = Array.from(cleaned.matchAll(/<article\b[^>]*>([\s\S]*?)<\/article>/gi), (match) => htmlFragmentToText(match[1]))
    .filter((candidate) => candidate.length >= 200);
  const mainCandidates = Array.from(cleaned.matchAll(/<main\b[^>]*>([\s\S]*?)<\/main>/gi), (match) => htmlFragmentToText(match[1]))
    .filter((candidate) => candidate.length >= 200);
  const body = htmlFragmentToText(cleaned.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? cleaned);
  // 语义容器优先；同级多个候选时再选择内容最完整的一个。
  const candidates = articleCandidates.length > 0 ? articleCandidates : mainCandidates.length > 0 ? mainCandidates : [body];
  const content = candidates.sort((left, right) => right.length - left.length)[0] ?? "";
  return { title, content: content.slice(0, 500_000) };
}

function htmlFragmentToText(html: string): string {
  return decodeHtml(
    html
      .replace(/<(br|hr)\b[^>]*\/?>/gi, "\n")
      .replace(/<\/(p|div|section|article|main|h[1-6]|li|blockquote|pre|tr)>/gi, "\n")
      .replace(/<li\b[^>]*>/gi, "• ")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeHtml(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: "\"",
    apos: "'",
    nbsp: " ",
  };
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (entity, code: string) => {
    if (code[0] !== "#") return named[code.toLowerCase()] ?? entity;
    const value = code[1].toLowerCase() === "x" ? Number.parseInt(code.slice(2), 16) : Number.parseInt(code.slice(1), 10);
    return Number.isFinite(value) ? String.fromCodePoint(value) : entity;
  });
}
