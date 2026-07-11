import fs from "node:fs";
import path from "node:path";
import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import { PipelineEngine, ProviderRegistry, Repo, TemplateStore } from "@amp/core";
import { ensureAnalysisImage, providerFactories } from "@amp/providers";
import { findRepoRoot } from "./root.js";
import { seedProviders } from "./seed.js";
import { registerRoutes } from "./routes.js";

export interface ServerOptions {
  /** 资源根目录（prompts/pipelines/scripts/apps/web/dist 所在），默认环境变量 AMP_ROOT 或仓库根 */
  rootDir?: string;
  /** 数据目录（SQLite），默认 AMP_DATA_DIR 或 root/data */
  dataDir?: string;
  /** 产物目录，默认 AMP_WORKSPACE_DIR 或 root/workspace */
  workspaceDir?: string;
  /** 监听端口，0 表示随机可用端口；默认 PORT 或 8787 */
  port?: number;
}

export async function startServer(opts: ServerOptions = {}) {
  const root = opts.rootDir ?? process.env.AMP_ROOT ?? findRepoRoot();
  // 加载项目根目录的 .env（填 API key / CLI 命令），Node 20.12+ 内置，无需依赖
  const envFile = path.join(root, ".env");
  if (fs.existsSync(envFile) && typeof (process as any).loadEnvFile === "function") {
    try {
      (process as any).loadEnvFile(envFile);
    } catch {
      // .env 格式问题不阻断启动
    }
  }
  const dataDir = opts.dataDir ?? process.env.AMP_DATA_DIR ?? path.join(root, "data");
  const workspaceDir = opts.workspaceDir ?? process.env.AMP_WORKSPACE_DIR ?? path.join(root, "workspace");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });

  const repo = new Repo(path.join(dataDir, "amp.db"));
  repo.recoverInterrupted();
  seedProviders(repo, root);

  const templates = new TemplateStore(root, repo);
  const registry = new ProviderRegistry(repo, providerFactories);
  const engine = new PipelineEngine(repo, registry, templates, workspaceDir);
  // 为升级前创建的选题补齐新加入的主线模块（例如逐镜视频生成）。
  for (const topic of repo.listTopics()) {
    engine.bootstrapSteps(topic.id);
    for (const material of repo.listMaterials(topic.id)) {
      if (material.kind === "image" && material.file_path && fs.existsSync(material.file_path)) {
        await ensureAnalysisImage(material.file_path, `${material.file_path}.analysis.jpg`).catch(() => undefined);
      }
    }
  }

  const app = Fastify({ logger: { level: "info" } });
  await app.register(cors, { origin: true });
  await app.register(websocket);
  // 素材上传：单文件最大 2GB（容纳未剪辑视频原片）
  await app.register(multipart, { limits: { fileSize: 2 * 1024 * 1024 * 1024 } });

  const webDist = path.join(root, "apps", "web", "dist");
  if (fs.existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist });
  }

  await registerRoutes(app, { repo, engine, registry, templates, workspaceDir });

  const port = opts.port ?? Number(process.env.PORT || 8787);
  await app.listen({ port, host: "127.0.0.1" });
  const actualPort = (app.server.address() as any)?.port ?? port;
  console.log(`\n  自媒体内容工作台已启动: http://127.0.0.1:${actualPort}\n`);
  return { app, port: actualPort as number };
}
