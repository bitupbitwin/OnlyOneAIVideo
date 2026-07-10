import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 向上查找 pnpm-workspace.yaml 定位仓库根目录 */
export function findRepoRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error("未找到仓库根目录（pnpm-workspace.yaml）");
}
