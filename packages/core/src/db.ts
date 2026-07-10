import { DatabaseSync } from "node:sqlite";
import type {
  Brief,
  MaterialRow,
  PipelineStatus,
  ProviderRow,
  StepDef,
  StepStatus,
} from "@amp/shared";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  brief_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE TABLE IF NOT EXISTS pipelines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  template_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  mode TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  auto INTEGER NOT NULL DEFAULT 0,
  options_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE TABLE IF NOT EXISTS materials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  kind TEXT NOT NULL,
  original_name TEXT,
  file_path TEXT,
  content TEXT,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE TABLE IF NOT EXISTS steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pipeline_id INTEGER NOT NULL REFERENCES pipelines(id),
  def_id TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  needs_json TEXT NOT NULL DEFAULT '[]',
  provider_id TEXT,
  prompt_template TEXT NOT NULL,
  human_gate INTEGER NOT NULL DEFAULT 0,
  cover_sizes_json TEXT,
  post TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  prompt_rendered TEXT,
  error TEXT,
  started_at TEXT,
  finished_at TEXT
);
CREATE TABLE IF NOT EXISTS artifacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  step_id INTEGER NOT NULL REFERENCES steps(id),
  version INTEGER NOT NULL DEFAULT 1,
  kind TEXT NOT NULL,
  content TEXT,
  file_path TEXT,
  label TEXT,
  selected INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  step_id INTEGER NOT NULL REFERENCES steps(id),
  artifact_id INTEGER,
  provider_id TEXT NOT NULL,
  target TEXT NOT NULL,
  scores_json TEXT NOT NULL,
  total REAL NOT NULL,
  verdict TEXT NOT NULL,
  issues_json TEXT NOT NULL,
  suggestions_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE TABLE IF NOT EXISTS providers (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  config_json TEXT NOT NULL DEFAULT '{}',
  max_concurrency INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS prompt_overrides (
  path TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
`;

export interface ProjectRow {
  id: number;
  title: string;
  brief: Brief;
  created_at: string;
}

export interface PipelineRow {
  id: number;
  project_id: number;
  template_id: string;
  platform: string;
  mode: string;
  name: string;
  status: PipelineStatus;
  /** 全自动模式：1=跳过人工卡点并启用评审自动重生成 */
  auto: number;
  /** 用户选择的运行选项（如 { visualMode, aspect }） */
  options: Record<string, string>;
  created_at: string;
}

export interface StepRow {
  id: number;
  pipeline_id: number;
  def_id: string;
  name: string;
  type: StepDef["type"];
  needs: string[];
  provider_id: string | null;
  prompt_template: string;
  human_gate: boolean;
  cover_sizes: StepDef["coverSizes"];
  post: string | null;
  status: StepStatus;
  prompt_rendered: string | null;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
}

export interface ArtifactRow {
  id: number;
  step_id: number;
  version: number;
  kind: "text" | "image" | "file";
  content: string | null;
  file_path: string | null;
  label: string | null;
  selected: boolean;
  created_at: string;
}

export class Repo {
  readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(SCHEMA);
    // 老库迁移：补充后加的列（已存在则忽略）
    for (const sql of [
      "ALTER TABLE pipelines ADD COLUMN auto INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE pipelines ADD COLUMN options_json TEXT NOT NULL DEFAULT '{}'",
    ]) {
      try {
        this.db.exec(sql);
      } catch {
        // 列已存在
      }
    }
  }

  // ---------- projects ----------
  createProject(title: string, brief: Brief): ProjectRow {
    const info = this.db
      .prepare("INSERT INTO projects (title, brief_json) VALUES (?, ?)")
      .run(title, JSON.stringify(brief));
    return this.getProject(Number(info.lastInsertRowid))!;
  }

  listProjects(): ProjectRow[] {
    return (this.db.prepare("SELECT * FROM projects ORDER BY id DESC").all() as any[]).map(mapProject);
  }

  getProject(id: number): ProjectRow | undefined {
    const row = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as any;
    return row ? mapProject(row) : undefined;
  }

  updateProjectBrief(id: number, brief: Brief) {
    this.db.prepare("UPDATE projects SET brief_json = ? WHERE id = ?").run(JSON.stringify(brief), id);
  }

  // ---------- materials（选题素材：粘贴文字/图片/视频/文件）----------
  createMaterial(m: {
    projectId: number;
    kind: MaterialRow["kind"];
    originalName?: string;
    filePath?: string;
    content?: string;
    note?: string;
  }): MaterialRow {
    const info = this.db
      .prepare(
        "INSERT INTO materials (project_id, kind, original_name, file_path, content, note) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run(m.projectId, m.kind, m.originalName ?? null, m.filePath ?? null, m.content ?? null, m.note ?? null);
    return this.getMaterial(Number(info.lastInsertRowid))!;
  }

  getMaterial(id: number): MaterialRow | undefined {
    return this.db.prepare("SELECT * FROM materials WHERE id = ?").get(id) as unknown as MaterialRow | undefined;
  }

  listMaterials(projectId: number): MaterialRow[] {
    return this.db
      .prepare("SELECT * FROM materials WHERE project_id = ? ORDER BY id")
      .all(projectId) as unknown as MaterialRow[];
  }

  deleteMaterial(id: number) {
    this.db.prepare("DELETE FROM materials WHERE id = ?").run(id);
  }

  // ---------- pipelines ----------
  createPipeline(
    projectId: number,
    templateId: string,
    platform: string,
    mode: string,
    name: string,
    options: Record<string, string> = {}
  ): PipelineRow {
    const info = this.db
      .prepare("INSERT INTO pipelines (project_id, template_id, platform, mode, name, options_json) VALUES (?, ?, ?, ?, ?, ?)")
      .run(projectId, templateId, platform, mode, name, JSON.stringify(options));
    return this.getPipeline(Number(info.lastInsertRowid))!;
  }

  getPipeline(id: number): PipelineRow | undefined {
    const row = this.db.prepare("SELECT * FROM pipelines WHERE id = ?").get(id) as any;
    return row ? mapPipeline(row) : undefined;
  }

  listPipelinesByProject(projectId: number): PipelineRow[] {
    return (this.db.prepare("SELECT * FROM pipelines WHERE project_id = ? ORDER BY id DESC").all(projectId) as any[]).map(
      mapPipeline
    );
  }

  setPipelineStatus(id: number, status: PipelineStatus) {
    this.db.prepare("UPDATE pipelines SET status = ? WHERE id = ?").run(status, id);
  }

  setPipelineAuto(id: number, auto: boolean) {
    this.db.prepare("UPDATE pipelines SET auto = ? WHERE id = ?").run(auto ? 1 : 0, id);
  }

  /** 服务启动时调用：上次进程退出时仍在运行的步骤已丢失，置为失败以便重跑 */
  recoverInterrupted() {
    this.db
      .prepare("UPDATE steps SET status = 'failed', error = '服务重启导致任务中断，请点击重跑' WHERE status = 'running'")
      .run();
    this.db.prepare("UPDATE pipelines SET status = 'failed' WHERE status = 'running'").run();
  }

  // ---------- steps ----------
  createStep(pipelineId: number, def: StepDef, providerId: string | null): StepRow {
    const info = this.db
      .prepare(
        `INSERT INTO steps (pipeline_id, def_id, name, type, needs_json, provider_id, prompt_template, human_gate, cover_sizes_json, post)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        pipelineId,
        def.id,
        def.name,
        def.type,
        JSON.stringify(def.needs ?? []),
        providerId ?? null,
        def.promptTemplate ?? "",
        def.humanGate ? 1 : 0,
        def.coverSizes ? JSON.stringify(def.coverSizes) : null,
        def.post ?? null
      );
    return this.getStep(Number(info.lastInsertRowid))!;
  }

  getStep(id: number): StepRow | undefined {
    const row = this.db.prepare("SELECT * FROM steps WHERE id = ?").get(id) as any;
    return row ? mapStep(row) : undefined;
  }

  listStepsByPipeline(pipelineId: number): StepRow[] {
    return (this.db.prepare("SELECT * FROM steps WHERE pipeline_id = ? ORDER BY id").all(pipelineId) as any[]).map(
      mapStep
    );
  }

  setStepStatus(id: number, status: StepStatus, patch: { error?: string | null; started?: boolean; finished?: boolean } = {}) {
    const sets = ["status = ?"];
    const args: any[] = [status];
    if (patch.error !== undefined) {
      sets.push("error = ?");
      args.push(patch.error);
    }
    if (patch.started) sets.push("started_at = datetime('now', 'localtime')");
    if (patch.finished) sets.push("finished_at = datetime('now', 'localtime')");
    args.push(id);
    this.db.prepare(`UPDATE steps SET ${sets.join(", ")} WHERE id = ?`).run(...args);
  }

  setStepPrompt(id: number, prompt: string) {
    this.db.prepare("UPDATE steps SET prompt_rendered = ? WHERE id = ?").run(prompt, id);
  }

  setStepProvider(id: number, providerId: string) {
    this.db.prepare("UPDATE steps SET provider_id = ? WHERE id = ?").run(providerId, id);
  }

  // ---------- artifacts ----------
  nextArtifactVersion(stepId: number): number {
    const row = this.db
      .prepare("SELECT COALESCE(MAX(version), 0) AS v FROM artifacts WHERE step_id = ?")
      .get(stepId) as any;
    return Number(row.v) + 1;
  }

  createArtifact(a: {
    stepId: number;
    version: number;
    kind: ArtifactRow["kind"];
    content?: string;
    filePath?: string;
    label?: string;
    selected?: boolean;
  }): ArtifactRow {
    const info = this.db
      .prepare(
        `INSERT INTO artifacts (step_id, version, kind, content, file_path, label, selected)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(a.stepId, a.version, a.kind, a.content ?? null, a.filePath ?? null, a.label ?? null, a.selected ? 1 : 0);
    return this.getArtifact(Number(info.lastInsertRowid))!;
  }

  getArtifact(id: number): ArtifactRow | undefined {
    const row = this.db.prepare("SELECT * FROM artifacts WHERE id = ?").get(id) as any;
    return row ? mapArtifact(row) : undefined;
  }

  listArtifactsByStep(stepId: number): ArtifactRow[] {
    return (this.db.prepare("SELECT * FROM artifacts WHERE step_id = ? ORDER BY id").all(stepId) as any[]).map(
      mapArtifact
    );
  }

  selectArtifact(artifactId: number) {
    const artifact = this.getArtifact(artifactId);
    if (!artifact) throw new Error(`artifact ${artifactId} 不存在`);
    this.db.prepare("UPDATE artifacts SET selected = 0 WHERE step_id = ?").run(artifact.step_id);
    this.db.prepare("UPDATE artifacts SET selected = 1 WHERE id = ?").run(artifactId);
    return this.getArtifact(artifactId)!;
  }

  /** 替换某个产物的文件（用于 MV 单张图片重抽/上传替换） */
  updateArtifactFile(id: number, filePath: string) {
    this.db.prepare("UPDATE artifacts SET file_path = ? WHERE id = ?").run(filePath, id);
    return this.getArtifact(id)!;
  }

  selectedArtifact(stepId: number): ArtifactRow | undefined {
    const row = this.db
      .prepare("SELECT * FROM artifacts WHERE step_id = ? AND selected = 1 ORDER BY id DESC LIMIT 1")
      .get(stepId) as any;
    return row ? mapArtifact(row) : undefined;
  }

  // ---------- reviews ----------
  createReview(r: {
    stepId: number;
    artifactId?: number;
    providerId: string;
    target: string;
    scores: Record<string, number>;
    total: number;
    verdict: string;
    issues: string[];
    suggestions: string[];
  }) {
    this.db
      .prepare(
        `INSERT INTO reviews (step_id, artifact_id, provider_id, target, scores_json, total, verdict, issues_json, suggestions_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        r.stepId,
        r.artifactId ?? null,
        r.providerId,
        r.target,
        JSON.stringify(r.scores),
        r.total,
        r.verdict,
        JSON.stringify(r.issues),
        JSON.stringify(r.suggestions)
      );
  }

  listReviewsByPipeline(pipelineId: number): any[] {
    return this.db
      .prepare(
        `SELECT r.* FROM reviews r JOIN steps s ON r.step_id = s.id WHERE s.pipeline_id = ? ORDER BY r.id`
      )
      .all(pipelineId)
      .map((row: any) => ({
        ...row,
        scores: JSON.parse(row.scores_json),
        issues: JSON.parse(row.issues_json),
        suggestions: JSON.parse(row.suggestions_json),
      }));
  }

  // ---------- providers ----------
  upsertProvider(p: ProviderRow) {
    this.db
      .prepare(
        `INSERT INTO providers (id, kind, name, config_json, max_concurrency, enabled)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, name=excluded.name,
           config_json=excluded.config_json, max_concurrency=excluded.max_concurrency, enabled=excluded.enabled`
      )
      .run(p.id, p.kind, p.name, JSON.stringify(p.config), p.maxConcurrency, p.enabled ? 1 : 0);
  }

  getProvider(id: string): ProviderRow | undefined {
    const row = this.db.prepare("SELECT * FROM providers WHERE id = ?").get(id) as any;
    return row ? mapProvider(row) : undefined;
  }

  listProviders(): ProviderRow[] {
    return (this.db.prepare("SELECT * FROM providers ORDER BY id").all() as any[]).map(mapProvider);
  }

  deleteProvider(id: string) {
    this.db.prepare("DELETE FROM providers WHERE id = ?").run(id);
  }

  // ---------- prompt overrides ----------
  getPromptOverride(path: string): string | undefined {
    const row = this.db.prepare("SELECT content FROM prompt_overrides WHERE path = ?").get(path) as any;
    return row?.content;
  }

  setPromptOverride(path: string, content: string) {
    this.db
      .prepare(
        `INSERT INTO prompt_overrides (path, content, updated_at) VALUES (?, ?, datetime('now', 'localtime'))
         ON CONFLICT(path) DO UPDATE SET content=excluded.content, updated_at=excluded.updated_at`
      )
      .run(path, content);
  }

  deletePromptOverride(path: string) {
    this.db.prepare("DELETE FROM prompt_overrides WHERE path = ?").run(path);
  }
}

function mapPipeline(row: any): PipelineRow {
  let options: Record<string, string> = {};
  try {
    options = row.options_json ? JSON.parse(row.options_json) : {};
  } catch {
    options = {};
  }
  return { ...row, options };
}

function mapProject(row: any): ProjectRow {
  return { id: row.id, title: row.title, brief: JSON.parse(row.brief_json), created_at: row.created_at };
}

function mapStep(row: any): StepRow {
  return {
    id: row.id,
    pipeline_id: row.pipeline_id,
    def_id: row.def_id,
    name: row.name,
    type: row.type,
    needs: JSON.parse(row.needs_json),
    provider_id: row.provider_id,
    prompt_template: row.prompt_template,
    human_gate: !!row.human_gate,
    cover_sizes: row.cover_sizes_json ? JSON.parse(row.cover_sizes_json) : undefined,
    post: row.post,
    status: row.status,
    prompt_rendered: row.prompt_rendered,
    error: row.error,
    started_at: row.started_at,
    finished_at: row.finished_at,
  };
}

function mapArtifact(row: any): ArtifactRow {
  return { ...row, selected: !!row.selected };
}

function mapProvider(row: any): ProviderRow {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    config: JSON.parse(row.config_json),
    maxConcurrency: row.max_concurrency,
    enabled: !!row.enabled,
  };
}
