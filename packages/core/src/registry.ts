import type { GenerateRequest, GenerateResult, ProviderKind, ProviderRow, ProviderStatus } from "@amp/shared";
import type { Repo } from "./db.js";
import { Semaphore } from "./semaphore.js";

export interface Provider {
  row: ProviderRow;
  generate(req: GenerateRequest, onChunk?: (chunk: string) => void): Promise<GenerateResult>;
  healthCheck(): Promise<ProviderStatus>;
}

export type ProviderFactory = (row: ProviderRow) => Provider;

export class ProviderRegistry {
  private semaphores = new Map<string, Semaphore>();

  constructor(
    private repo: Repo,
    private factories: Partial<Record<ProviderKind, ProviderFactory>>
  ) {}

  get(id: string): Provider {
    const row = this.repo.getProvider(id);
    if (!row) throw new Error(`引擎 ${id} 不存在，请先在「引擎管理」中配置`);
    if (!row.enabled) throw new Error(`引擎 ${row.name}（${id}）已停用`);
    const factory = this.factories[row.kind];
    if (!factory) throw new Error(`不支持的引擎类型: ${row.kind}`);
    return factory(row);
  }

  semaphore(row: ProviderRow): Semaphore {
    let sem = this.semaphores.get(row.id);
    if (!sem) {
      sem = new Semaphore(Math.max(1, row.maxConcurrency));
      this.semaphores.set(row.id, sem);
    } else {
      sem.setLimit(Math.max(1, row.maxConcurrency));
    }
    return sem;
  }
}
