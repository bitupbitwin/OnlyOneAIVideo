import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  Brief,
  MaterialRow,
  ProviderRow,
  SourceType,
  StepId,
  StepStatus,
  TopicStatus,
} from "@amp/shared";

const SCHEMA_VERSION = 2;

const SCHEMA = `
PRAGMA user_version = ${SCHEMA_VERSION};
CREATE TABLE IF NOT EXISTS topics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  source_type TEXT NOT NULL DEFAULT 'text',
  brief_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  auto INTEGER NOT NULL DEFAULT 0,
  queue_order INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE TABLE IF NOT EXISTS materials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic_id INTEGER NOT NULL REFERENCES topics(id),
  kind TEXT NOT NULL,
  original_name TEXT,
  file_path TEXT,
  content TEXT,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE TABLE IF NOT EXISTS steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic_id INTEGER NOT NULL REFERENCES topics(id),
  step_id TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  provider_id TEXT,
  prompt_path TEXT,
  prompt_rendered TEXT,
  human_gate INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  started_at TEXT,
  finished_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_steps_topic_step ON steps(topic_id, step_id);
CREATE TABLE IF NOT EXISTS artifacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  step_id INTEGER NOT NULL REFERENCES steps(id),
  version INTEGER NOT NULL DEFAULT 1,
  kind TEXT NOT NULL,
  role TEXT,
  content TEXT,
  file_path TEXT,
  label TEXT,
  selected INTEGER NOT NULL DEFAULT 0,
  meta_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE TABLE IF NOT EXISTS packages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic_id INTEGER NOT NULL REFERENCES topics(id),
  platform TEXT NOT NULL,
  video_path TEXT,
  title TEXT,
  caption TEXT,
  cover_paths_json TEXT NOT NULL DEFAULT '[]',
  checklist_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'draft',
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
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

export interface TopicRow {
  id: number;
  title: string;
  source_type: SourceType;
  brief: Brief;
  status: TopicStatus;
  auto: number;
  queue_order: number | null;
  created_at: string;
}

export interface StepRow {
  id: number;
  topic_id: number;
  step_id: StepId;
  name: string;
  status: StepStatus;
  provider_id: string | null;
  prompt_path: string | null;
  prompt_rendered: string | null;
  human_gate: boolean;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
}

export interface ArtifactRow {
  id: number;
  step_id: number;
  version: number;
  kind: "text" | "image" | "audio" | "video" | "file";
  role: string | null;
  content: string | null;
  file_path: string | null;
  label: string | null;
  selected: boolean;
  meta: Record<string, any>;
  created_at: string;
}

export interface PackageRow {
  id: number;
  topic_id: number;
  platform: string;
  video_path: string | null;
  title: string | null;
  caption: string | null;
  cover_paths: string[];
  checklist: string[];
  status: "draft" | "exported" | "published";
  created_at: string;
  updated_at: string;
}

export class Repo {
  db: DatabaseSync;

  constructor(private dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.ensureV2Schema();
  }

  private ensureV2Schema() {
    const version = Number((this.db.prepare("PRAGMA user_version").get() as any)?.user_version ?? 0);
    const hasTopics = tableExists(this.db, "topics");
    const legacyShape =
      tableExists(this.db, "projects") ||
      tableExists(this.db, "pipelines") ||
      (tableExists(this.db, "materials") && !columnExists(this.db, "materials", "topic_id")) ||
      (tableExists(this.db, "steps") && !columnExists(this.db, "steps", "topic_id"));
    if (legacyShape || (hasTopics && !columnExists(this.db, "topics", "source_type")) || version < SCHEMA_VERSION) {
      this.recreateDatabase(version);
      return;
    }
    if (!hasTopics) this.db.exec(SCHEMA);
    this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
  }

  private recreateDatabase(version: number) {
    this.db.close();
    if (fs.existsSync(this.dbPath)) {
      const backup = `${this.dbPath}.v${version}.bak-${Date.now()}`;
      fs.copyFileSync(this.dbPath, backup);
      fs.rmSync(this.dbPath, { force: true });
    }
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(SCHEMA);
  }

  createTopic(input: { title: string; sourceType: SourceType; brief: Brief; auto?: boolean }): TopicRow {
    const info = this.db
      .prepare("INSERT INTO topics (title, source_type, brief_json, auto) VALUES (?, ?, ?, ?)")
      .run(input.title, input.sourceType, JSON.stringify(input.brief), input.auto ? 1 : 0);
    return this.getTopic(Number(info.lastInsertRowid))!;
  }

  listTopics(): TopicRow[] {
    return (this.db.prepare("SELECT * FROM topics ORDER BY id DESC").all() as any[]).map(mapTopic);
  }

  getTopic(id: number): TopicRow | undefined {
    const row = this.db.prepare("SELECT * FROM topics WHERE id = ?").get(id) as any;
    return row ? mapTopic(row) : undefined;
  }

  updateTopicBrief(id: number, brief: Brief) {
    this.db.prepare("UPDATE topics SET brief_json = ? WHERE id = ?").run(JSON.stringify(brief), id);
  }

  setTopicStatus(id: number, status: TopicStatus) {
    this.db.prepare("UPDATE topics SET status = ? WHERE id = ?").run(status, id);
  }

  setTopicAuto(id: number, auto: boolean) {
    this.db.prepare("UPDATE topics SET auto = ? WHERE id = ?").run(auto ? 1 : 0, id);
  }

  deleteTopic(id: number) {
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM artifacts WHERE step_id IN (SELECT id FROM steps WHERE topic_id = ?)").run(id);
      this.db.prepare("DELETE FROM steps WHERE topic_id = ?").run(id);
      this.db.prepare("DELETE FROM materials WHERE topic_id = ?").run(id);
      this.db.prepare("DELETE FROM packages WHERE topic_id = ?").run(id);
      this.db.prepare("DELETE FROM topics WHERE id = ?").run(id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  recoverInterrupted() {
    this.db
      .prepare("UPDATE steps SET status = 'failed', error = '服务重启导致任务中断，请点击重跑' WHERE status = 'running'")
      .run();
    this.db.prepare("UPDATE topics SET status = 'failed' WHERE status = 'running'").run();
  }

  createMaterial(m: {
    topicId: number;
    kind: MaterialRow["kind"];
    originalName?: string;
    filePath?: string;
    content?: string;
    note?: string;
  }): MaterialRow {
    const info = this.db
      .prepare(
        "INSERT INTO materials (topic_id, kind, original_name, file_path, content, note) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run(m.topicId, m.kind, m.originalName ?? null, m.filePath ?? null, m.content ?? null, m.note ?? null);
    return this.getMaterial(Number(info.lastInsertRowid))!;
  }

  getMaterial(id: number): MaterialRow | undefined {
    return this.db.prepare("SELECT * FROM materials WHERE id = ?").get(id) as unknown as MaterialRow | undefined;
  }

  listMaterials(topicId: number): MaterialRow[] {
    return this.db.prepare("SELECT * FROM materials WHERE topic_id = ? ORDER BY id").all(topicId) as unknown as MaterialRow[];
  }

  deleteMaterial(id: number) {
    this.db.prepare("DELETE FROM materials WHERE id = ?").run(id);
  }

  createStep(input: {
    topicId: number;
    stepId: StepId;
    name: string;
    status: StepStatus;
    providerId: string | null;
    promptPath: string | null;
    humanGate: boolean;
  }): StepRow {
    const info = this.db
      .prepare(
        `INSERT INTO steps (topic_id, step_id, name, status, provider_id, prompt_path, human_gate)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.topicId,
        input.stepId,
        input.name,
        input.status,
        input.providerId,
        input.promptPath,
        input.humanGate ? 1 : 0
      );
    return this.getStep(Number(info.lastInsertRowid))!;
  }

  getStep(id: number): StepRow | undefined {
    const row = this.db.prepare("SELECT * FROM steps WHERE id = ?").get(id) as any;
    return row ? mapStep(row) : undefined;
  }

  getStepByTopicAndStep(topicId: number, stepId: StepId): StepRow | undefined {
    const row = this.db.prepare("SELECT * FROM steps WHERE topic_id = ? AND step_id = ?").get(topicId, stepId) as any;
    return row ? mapStep(row) : undefined;
  }

  listStepsByTopic(topicId: number): StepRow[] {
    return (this.db.prepare(`SELECT * FROM steps WHERE topic_id = ? ORDER BY CASE step_id
      WHEN 'analyze' THEN 1 WHEN 'title' THEN 2 WHEN 'script' THEN 3 WHEN 'storyboard' THEN 4
      WHEN 'frames' THEN 5 WHEN 'video' THEN 6 WHEN 'tts' THEN 7 WHEN 'compose' THEN 8
      WHEN 'review' THEN 9 WHEN 'adapt' THEN 10 ELSE 99 END`).all(topicId) as any[]).map(mapStep);
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

  setStepProvider(id: number, providerId: string | null) {
    this.db.prepare("UPDATE steps SET provider_id = ? WHERE id = ?").run(providerId, id);
  }

  resetStepsFrom(topicId: number, fromStepId: StepId, stepsInOrder: StepId[]) {
    const start = stepsInOrder.indexOf(fromStepId);
    if (start < 0) return;
    const dirty = stepsInOrder.slice(start);
    const placeholders = dirty.map(() => "?").join(",");
    this.db
      .prepare(
        `UPDATE steps
         SET status = 'pending', error = NULL, started_at = NULL, finished_at = NULL
         WHERE topic_id = ? AND step_id IN (${placeholders}) AND status != 'skipped'`
      )
      .run(topicId, ...dirty);
  }

  nextArtifactVersion(stepId: number): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM artifacts WHERE step_id = ?").get(stepId) as any;
    return Number(row.v) + 1;
  }

  createArtifact(a: {
    stepId: number;
    version: number;
    kind: ArtifactRow["kind"];
    role?: string | null;
    content?: string | null;
    filePath?: string | null;
    label?: string | null;
    selected?: boolean;
    meta?: Record<string, any>;
  }): ArtifactRow {
    const info = this.db
      .prepare(
        `INSERT INTO artifacts (step_id, version, kind, role, content, file_path, label, selected, meta_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        a.stepId,
        a.version,
        a.kind,
        a.role ?? null,
        a.content ?? null,
        a.filePath ?? null,
        a.label ?? null,
        a.selected ? 1 : 0,
        JSON.stringify(a.meta ?? {})
      );
    return this.getArtifact(Number(info.lastInsertRowid))!;
  }

  getArtifact(id: number): ArtifactRow | undefined {
    const row = this.db.prepare("SELECT * FROM artifacts WHERE id = ?").get(id) as any;
    return row ? mapArtifact(row) : undefined;
  }

  listArtifactsByStep(stepId: number): ArtifactRow[] {
    return (this.db.prepare("SELECT * FROM artifacts WHERE step_id = ? ORDER BY id").all(stepId) as any[]).map(mapArtifact);
  }

  selectArtifact(artifactId: number) {
    const artifact = this.getArtifact(artifactId);
    if (!artifact) throw new Error(`artifact ${artifactId} 不存在`);
    this.db.prepare("UPDATE artifacts SET selected = 0 WHERE step_id = ?").run(artifact.step_id);
    this.db.prepare("UPDATE artifacts SET selected = 1 WHERE id = ?").run(artifactId);
    return this.getArtifact(artifactId)!;
  }

  selectedArtifact(stepId: number): ArtifactRow | undefined {
    const row = this.db
      .prepare("SELECT * FROM artifacts WHERE step_id = ? AND selected = 1 ORDER BY id DESC LIMIT 1")
      .get(stepId) as any;
    return row ? mapArtifact(row) : undefined;
  }

  listPackages(topicId: number): PackageRow[] {
    return (this.db.prepare("SELECT * FROM packages WHERE topic_id = ? ORDER BY platform").all(topicId) as any[]).map(mapPackage);
  }

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

function tableExists(db: DatabaseSync, name: string): boolean {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(name) as any;
  return !!row;
}

function columnExists(db: DatabaseSync, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as any[]).some((row) => row.name === column);
}

function safeJson<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function mapTopic(row: any): TopicRow {
  return {
    id: row.id,
    title: row.title,
    source_type: row.source_type,
    brief: safeJson<Brief>(row.brief_json, { topic: row.title }),
    status: row.status,
    auto: row.auto,
    queue_order: row.queue_order ?? null,
    created_at: row.created_at,
  };
}

function mapStep(row: any): StepRow {
  return {
    id: row.id,
    topic_id: row.topic_id,
    step_id: row.step_id,
    name: row.name,
    status: row.status,
    provider_id: row.provider_id,
    prompt_path: row.prompt_path,
    prompt_rendered: row.prompt_rendered,
    human_gate: !!row.human_gate,
    error: row.error,
    started_at: row.started_at,
    finished_at: row.finished_at,
  };
}

function mapArtifact(row: any): ArtifactRow {
  return {
    id: row.id,
    step_id: row.step_id,
    version: row.version,
    kind: row.kind,
    role: row.role,
    content: row.content,
    file_path: row.file_path,
    label: row.label,
    selected: !!row.selected,
    meta: safeJson<Record<string, any>>(row.meta_json, {}),
    created_at: row.created_at,
  };
}

function mapPackage(row: any): PackageRow {
  return {
    id: row.id,
    topic_id: row.topic_id,
    platform: row.platform,
    video_path: row.video_path,
    title: row.title,
    caption: row.caption,
    cover_paths: safeJson<string[]>(row.cover_paths_json, []),
    checklist: safeJson<string[]>(row.checklist_json, []),
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function mapProvider(row: any): ProviderRow {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    config: safeJson<Record<string, any>>(row.config_json, {}),
    maxConcurrency: row.max_concurrency,
    enabled: !!row.enabled,
  };
}
