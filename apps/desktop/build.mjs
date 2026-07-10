/**
 * 用 esbuild 把本地服务（含全部 workspace 包）打成单文件 CJS bundle，
 * 供 Electron 主进程直接 require（进程内启动，无需 tsx/Node 环境）。
 * 第三方依赖保持 external，由本包 dependencies 提供。
 */
import { build } from "esbuild";

await build({
  entryPoints: ["../server/src/server.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  outfile: "dist/server.bundle.cjs",
  external: ["fastify", "@fastify/*", "archiver", "sharp", "playwright"],
  logLevel: "info",
});
