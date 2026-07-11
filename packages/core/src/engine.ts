import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { extractJson, renderTemplate } from "@amp/shared";
import type { EngineEvent, GenerateResult, PlatformSpec, RuntimeSceneGraph, StepId, TopicStatus } from "@amp/shared";
import { ruleCheck } from "@amp/review";
import type { Repo, StepRow } from "./db.js";
import type { ProviderRegistry } from "./registry.js";
import type { TemplateStore } from "./templates.js";
import { initialStepStatus, MAINLINE, MAINLINE_STEP_DEFS, type StepDefMeta } from "./stepDefs.js";
import { composeMaster, deriveAspectVideo, probeDurationSec, type ComposeSceneInput } from "./compose.js";

const STEP_TIMEOUT_MS = 10 * 60 * 1000;
/** 镜头间呼吸间隔（实现设计 §5.3 Hard-cut 模型） */
const GAP_SEC = 0.3;

const CONTENT_RULES = [
  "只给真材实料：具体例子、步骤、数据、原理或亲身经验至少要出现一种。",
  "拒绝正确的废话、空洞口号、营销话术和堆砌形容词。",
  "基于用户提供的主题/素材展开，不编造与素材冲突的事实。",
].join("\n");

export class PipelineEngine extends EventEmitter {
  private inflight = new Set<number>();
  private topicInflight = new Set<number>();
  private feedback = new Map<number, string>();
  private adaptRequested = new Set<number>();
  private adaptPlatforms = new Map<number, string[]>();

  constructor(
    private repo: Repo,
    private registry: ProviderRegistry,
    private templates: TemplateStore,
    private workspaceDir: string
  ) {
    super();
  }

  bootstrapSteps(topicId: number) {
    const topic = this.repo.getTopic(topicId);
    if (!topic) throw new Error(`选题 ${topicId} 不存在`);
    const existing = this.repo.listStepsByTopic(topicId);
    const existingIds = new Set(existing.map((step) => step.step_id));

    for (const stepId of MAINLINE) {
      if (existingIds.has(stepId)) continue;
      const def = MAINLINE_STEP_DEFS[stepId];
      const status = initialStepStatus(stepId, topic.source_type, topic.brief.mediaMode);
      const humanGate = topic.auto ? false : def.humanGate;
      const provider = def.requiresProvider ? this.resolveProvider(def)?.id ?? def.defaultProviderId : null;
      this.repo.createStep({
        topicId,
        stepId,
        name: def.name,
        status,
        providerId: provider,
        promptPath: def.prompt,
        humanGate,
      });
    }
    this.refreshTopicStatus(topicId);
  }

  kick(topicId: number, forceOneStep = false) {
    if (this.topicInflight.has(topicId)) return;
    this.bootstrapSteps(topicId);
    this.refreshTopicStatus(topicId);

    const topic = this.repo.getTopic(topicId);
    if (!topic) return;
    if (!topic.auto && !forceOneStep) return;
    const steps = this.repo.listStepsByTopic(topicId);
    const byStepId = new Map(steps.map((s) => [s.step_id, s]));

    for (const stepId of MAINLINE) {
      const step = byStepId.get(stepId);
      if (!step) continue;
      if (step.status === "succeeded" || step.status === "skipped") continue;
      if (step.status === "failed" || step.status === "cancelled" || step.status === "waiting_human") return;
      if (step.status === "running" || this.inflight.has(step.id)) return;
      if (step.status !== "pending") continue;
      if (stepId === "adapt" && !this.adaptRequested.has(topicId)) return;

      this.inflight.add(step.id);
      this.topicInflight.add(topicId);
      void this.runStep(step.id).finally(() => {
        this.inflight.delete(step.id);
        this.topicInflight.delete(topicId);
        this.refreshTopicStatus(topicId);
        const latest = this.repo.getStep(step.id);
        if (latest?.status === "succeeded" || latest?.status === "skipped") this.kick(topicId);
      });
      return;
    }
  }

  rerunStep(stepId: number, feedback?: string) {
    const step = this.repo.getStep(stepId);
    if (!step) throw new Error(`步骤 ${stepId} 不存在`);
    if (this.inflight.has(stepId)) throw new Error("该步骤正在运行中");
    this.repo.setTopicAuto(step.topic_id, false);
    if (feedback?.trim()) this.feedback.set(stepId, feedback.trim());
    this.repo.resetStepsFrom(step.topic_id, step.step_id, MAINLINE);
    this.emitEvent({ type: "step-status", topicId: step.topic_id, stepId: step.id, data: { status: "pending" } });
    this.refreshTopicStatus(step.topic_id);
    this.kick(step.topic_id, true);
  }

  runPendingStep(stepId: number) {
    const step = this.repo.getStep(stepId);
    if (!step) throw new Error(`步骤 ${stepId} 不存在`);
    if (step.status !== "pending") throw new Error("只有待执行模块可以运行");
    const steps = this.repo.listStepsByTopic(step.topic_id);
    const index = MAINLINE.indexOf(step.step_id);
    const blocked = steps.some((candidate) => {
      const candidateIndex = MAINLINE.indexOf(candidate.step_id);
      return candidateIndex < index && candidate.status !== "succeeded" && candidate.status !== "skipped";
    });
    if (blocked) throw new Error("请先完成上一个模块");
    this.repo.setTopicAuto(step.topic_id, false);
    this.kick(step.topic_id, true);
  }

  confirmHumanGate(stepId: number) {
    const step = this.repo.getStep(stepId);
    if (!step) throw new Error(`步骤 ${stepId} 不存在`);
    if (step.status !== "waiting_human") throw new Error("该步骤不在等待人工确认状态");
    if (!this.repo.selectedArtifact(step.id)) throw new Error("请先选定一个产物");
    this.repo.setStepStatus(stepId, "succeeded", { finished: true, error: null });
    this.emitEvent({ type: "step-status", topicId: step.topic_id, stepId, data: { status: "succeeded" } });
    this.kick(step.topic_id);
  }

  selectArtifact(artifactId: number) {
    const artifact = this.repo.selectArtifact(artifactId);
    const step = this.repo.getStep(artifact.step_id);
    if (!step) return artifact;
    if (step.status === "waiting_human") {
      this.repo.setStepStatus(step.id, "succeeded", { finished: true, error: null });
      this.emitEvent({ type: "step-status", topicId: step.topic_id, stepId: step.id, data: { status: "succeeded" } });
    }
    const next = step.step_id === "title" ? "script" : step.step_id === "script" ? "storyboard" : null;
    if (next) this.repo.resetStepsFrom(step.topic_id, next, MAINLINE);
    this.kick(step.topic_id);
    return artifact;
  }

  renderPrompt(stepId: number): string {
    const step = this.repo.getStep(stepId);
    if (!step) throw new Error(`步骤 ${stepId} 不存在`);
    const prompt = this.composePrompt(step, this.feedback.get(stepId));
    this.repo.setStepPrompt(step.id, prompt);
    return prompt;
  }

  async submitManualText(stepId: number, text: string) {
    const step = this.repo.getStep(stepId);
    if (!step) throw new Error(`步骤 ${stepId} 不存在`);
    if (!text?.trim()) throw new Error("回填内容不能为空");
    const version = this.repo.nextArtifactVersion(stepId);
    const outDir = this.stepDir(step, version);
    await this.saveTextResult(step, version, outDir, text.trim());
    this.repo.setStepStatus(step.id, "succeeded", { finished: true, error: null });
    this.kick(step.topic_id);
  }

  private emitEvent(event: EngineEvent) {
    this.emit("event", event);
  }

  private resolveProvider(def: StepDefMeta) {
    const enabled = this.repo.listProviders().filter((p) => p.enabled && def.providerKinds.includes(p.kind));
    return enabled.find((p) => !p.id.includes("mock")) ?? enabled[0] ?? null;
  }

  private refreshTopicStatus(topicId: number) {
    const steps = this.repo.listStepsByTopic(topicId);
    const required = steps.filter((s) => MAINLINE_STEP_DEFS[s.step_id].requiredForTopicSuccess);
    const done = (s: StepRow) => s.status === "succeeded" || s.status === "skipped";
    let status: TopicStatus;
    if (required.some((s) => s.status === "running" || this.inflight.has(s.id))) status = "running";
    else if (required.some((s) => s.status === "waiting_human")) status = "waiting_human";
    else if (required.some((s) => s.status === "failed")) status = "failed";
    else if (required.length > 0 && required.every(done)) status = "succeeded";
    else status = "pending";

    const topic = this.repo.getTopic(topicId);
    if (topic && topic.status !== status) {
      this.repo.setTopicStatus(topicId, status);
      this.emitEvent({ type: "topic-status", topicId, data: { status } });
    }
  }

  private buildVars(step: StepRow) {
    const topic = this.repo.getTopic(step.topic_id)!;
    const steps: Record<string, any> = {};
    for (const s of this.repo.listStepsByTopic(step.topic_id)) {
      const selected = this.repo.selectedArtifact(s.id);
      steps[s.step_id] = {
        selected: selected?.content ?? "",
        selectedPath: selected?.file_path ?? "",
      };
    }
    const materials = this.repo
      .listMaterials(topic.id)
      .map((m) => {
        if (m.kind === "text") return `【文字素材】${m.note ? `（${m.note}）` : ""}\n${m.content ?? ""}`;
        return `【${m.kind}素材】${m.original_name ?? ""}${m.note ? ` - ${m.note}` : ""}`;
      })
      .join("\n\n");
    return {
      topic,
      brief: { ...topic.brief, materials },
      steps,
      sourceType: topic.source_type,
      contentRules: CONTENT_RULES,
    };
  }

  private composePrompt(step: StepRow, feedback?: string): string {
    if (!step.prompt_path) return "";
    let prompt = renderTemplate(this.templates.readPrompt(step.prompt_path), this.buildVars(step));
    const req = this.repo.getTopic(step.topic_id)?.brief.requirements?.trim();
    if (req) prompt += `\n\n## 我的具体要求\n${req}`;
    if (step.step_id === "title" || step.step_id === "script" || step.step_id === "storyboard") {
      prompt += `\n\n## 创作铁律\n${CONTENT_RULES}`;
    }
    if (feedback) prompt += `\n\n## 修改意见\n${feedback}`;
    return prompt;
  }

  private stepDir(step: StepRow, version: number) {
    const dir = path.join(this.workspaceDir, `topic-${step.topic_id}`, step.step_id, `v${version}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  private runtimeDir(topicId: number) {
    const dir = path.join(this.workspaceDir, `topic-${topicId}`, "runtime");
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  private runtimePath(topicId: number) {
    return path.join(this.runtimeDir(topicId), "scenes.json");
  }

  private readRuntime(topicId: number): RuntimeSceneGraph {
    const file = this.runtimePath(topicId);
    if (!fs.existsSync(file)) return { scenes: [] };
    return JSON.parse(fs.readFileSync(file, "utf-8")) as RuntimeSceneGraph;
  }

  private writeRuntime(topicId: number, graph: RuntimeSceneGraph) {
    fs.writeFileSync(this.runtimePath(topicId), JSON.stringify(graph, null, 2), "utf-8");
  }

  private async runStep(stepId: number) {
    const step = this.repo.getStep(stepId)!;
    try {
      this.repo.setStepStatus(step.id, "running", { started: true, error: null });
      this.emitEvent({ type: "step-status", topicId: step.topic_id, stepId: step.id, data: { status: "running" } });

      if (step.step_id === "cover") {
        await this.runCover(step);
      } else if (step.step_id === "frames") {
        await this.runFrames(step);
      } else if (step.step_id === "video") {
        await this.runVideo(step);
      } else if (step.step_id === "tts") {
        await this.runTts(step);
      } else if (step.step_id === "compose") {
        await this.runCompose(step);
      } else if (step.step_id === "review") {
        await this.runReview(step);
      } else if (step.step_id === "adapt") {
        await this.runAdapt(step);
      } else {
        await this.runProviderTextStep(step);
      }

      const latest = this.repo.getStep(step.id)!;
      // 重跑覆盖：本次成功后清掉旧版本产物（封面例外——候选永久保留供对比）
      if (step.step_id !== "cover" && (latest.status === "running" || latest.status === "waiting_human")) {
        this.repo.purgeOldArtifactVersions(step.id);
      }
      if (latest.status === "running") {
        this.repo.setStepStatus(step.id, "succeeded", { finished: true, error: null });
        this.emitEvent({ type: "step-status", topicId: step.topic_id, stepId: step.id, data: { status: "succeeded" } });
      }
    } catch (err: any) {
      const message = err?.message ?? String(err);
      this.repo.setStepStatus(step.id, "failed", { error: message, finished: true });
      this.emitEvent({ type: "step-status", topicId: step.topic_id, stepId: step.id, data: { status: "failed", error: message } });
    }
  }

  private async runProviderTextStep(step: StepRow) {
    if (!step.provider_id) throw new Error("该步骤未绑定引擎");
    const provider = this.registry.get(step.provider_id);
    const feedback = this.feedback.get(step.id);
    if (feedback) this.feedback.delete(step.id);
    const prompt = this.composePrompt(step, feedback);
    this.repo.setStepPrompt(step.id, prompt);

    const version = this.repo.nextArtifactVersion(step.id);
    const outDir = this.stepDir(step, version);
    const release = await this.registry.semaphore(provider.row).acquire();
    let result: GenerateResult;
    try {
      result = await provider.generate(
        {
          taskId: String(step.id),
          stepType: step.step_id,
          prompt,
          timeoutMs: STEP_TIMEOUT_MS,
          outDir,
          images:
            step.step_id === "analyze"
              ? this.repo
                  .listMaterials(step.topic_id)
                  .filter((material) => material.kind === "image" && material.file_path)
                  .map((material) => {
                    const analysisCopy = `${material.file_path}.analysis.jpg`;
                    return fs.existsSync(analysisCopy) ? analysisCopy : material.file_path!;
                  })
              : undefined,
        },
        (chunk) => this.emitEvent({ type: "step-stream", topicId: step.topic_id, stepId: step.id, data: { chunk } })
      );
    } finally {
      release();
    }
    if (result.kind !== "text") throw new Error(`${step.name} 期望文本输出`);
    await this.saveTextResult(step, version, outDir, result.text);
  }

  private async saveTextResult(step: StepRow, version: number, outDir: string, text: string) {
    if (step.step_id === "title") {
      const parsed = extractJson<string[]>(text);
      const titles = (Array.isArray(parsed) ? parsed : text.split("\n"))
        .map((x) => String(x).replace(/^\s*[\d.、\-*]+\s*/, "").trim())
        .filter(Boolean)
        .slice(0, 3);
      if (titles.length === 0) throw new Error("未解析到标题候选");
      const created = titles.map((title) =>
        this.repo.createArtifact({ stepId: step.id, version, kind: "text", role: "title", content: title, label: "标题候选" })
      );
      for (const artifact of created) this.emitEvent({ type: "artifact", topicId: step.topic_id, stepId: step.id, data: artifact });
      const topic = this.repo.getTopic(step.topic_id)!;
      if (step.human_gate && !topic.auto) {
        this.repo.setStepStatus(step.id, "waiting_human");
        this.emitEvent({ type: "step-status", topicId: step.topic_id, stepId: step.id, data: { status: "waiting_human" } });
      } else {
        this.repo.selectArtifact(created[0].id);
      }
      return;
    }

    const artifact = this.repo.createArtifact({
      stepId: step.id,
      version,
      kind: "text",
      role: step.step_id,
      content: text.trim(),
      selected: true,
    });
    this.emitEvent({ type: "artifact", topicId: step.topic_id, stepId: step.id, data: artifact });

    if (step.step_id === "storyboard") {
      const parsed = extractJson<RuntimeSceneGraph>(text);
      if (!parsed?.scenes?.length) throw new Error("分镜表输出无法解析为 V2 JSON：需要 scenes 数组");
      // index 0 = 封面提示词条目（只有 visual），copy 到 coverPrompt 供封面模块润色后出图；
      // 重跑分镜表会刷新这份 copy（分镜变了封面初稿也应更新）
      const coverEntry = parsed.scenes.find(
        (scene) => Number(scene.index ?? -1) === 0 || (!String(scene.narration ?? "").trim() && scene.visual)
      );
      const sceneEntries = parsed.scenes.filter((scene) => scene !== coverEntry);
      if (sceneEntries.length === 0) throw new Error("分镜表中没有镜头条目（index 1 起）");
      const title = this.repo.selectedArtifact(this.repo.getStepByTopicAndStep(step.topic_id, "title")!.id)?.content ?? "";
      const normalized: RuntimeSceneGraph = {
        bgmMood: parsed.bgmMood,
        coverPrompt: coverEntry?.visual
          ? String(coverEntry.visual).trim()
          : `短视频封面，1080x1920 竖版，主题「${title}」。${sceneEntries[0]?.visual ?? ""} 构图醒目、主体居中、预留标题文字位置。`,
        scenes: sceneEntries.map((scene, idx) => ({
          index: idx + 1,
          narration: String(scene.narration ?? "").trim(),
          subtitle: String(scene.subtitle ?? scene.narration ?? "").trim(),
          source: scene.source === "footage" ? "footage" : "generated",
          visual: scene.visual ? String(scene.visual) : undefined,
          clip: scene.clip,
        })),
      };
      if (normalized.scenes.some((scene) => !scene.narration)) throw new Error("分镜表中存在空 narration");
      this.writeRuntime(step.topic_id, normalized);
      this.repo.createArtifact({
        stepId: step.id,
        version,
        kind: "file",
        role: "runtime",
        filePath: this.runtimePath(step.topic_id),
        label: "runtime/scenes.json",
      });
    }
  }

  private async runFrames(step: StepRow) {
    const graph = this.readRuntime(step.topic_id);
    if (graph.scenes.length === 0) throw new Error("缺少 runtime/scenes.json，请先生成分镜表");
    if (!step.provider_id) throw new Error("frames 步骤未绑定出图引擎");
    const provider = this.registry.get(step.provider_id);
    const version = this.repo.nextArtifactVersion(step.id);
    const outDir = this.stepDir(step, version);
    for (const scene of graph.scenes) {
      if (scene.source === "footage") continue;
      const release = await this.registry.semaphore(provider.row).acquire();
      try {
        const result = await provider.generate({
          taskId: `${step.id}-${scene.index}`,
          stepType: "frames",
          prompt: scene.visual || scene.narration,
          timeoutMs: STEP_TIMEOUT_MS,
          outDir,
          imageCount: 1,
          imageSize: "1080x1920",
        });
        if (result.kind !== "images" || !result.files[0]) throw new Error(`镜头 ${scene.index} 未生成图片`);
        scene.framePath = result.files[0];
        const artifact = this.repo.createArtifact({
          stepId: step.id,
          version,
          kind: "image",
          role: "frame",
          filePath: result.files[0],
          label: `镜头 ${scene.index}`,
          meta: { sceneIndex: scene.index },
          selected: scene.index === 1,
        });
        this.emitEvent({ type: "artifact", topicId: step.topic_id, stepId: step.id, data: artifact });
      } finally {
        release();
      }
    }
    this.writeRuntime(step.topic_id, graph);
  }

  /** 封面出图：提示词来自 runtime.coverPrompt（分镜表 index0 的 copy，允许用户润色后再跑）。
   *  候选不做重跑覆盖——历史封面永久保留，便于对比挑选。 */
  private async runCover(step: StepRow) {
    const graph = this.readRuntime(step.topic_id);
    const prompt = graph.coverPrompt?.trim();
    if (!prompt) throw new Error("缺少封面提示词：请先生成分镜表，或在封面模块手动填写提示词后再运行");
    if (!step.provider_id) throw new Error("cover 步骤未绑定出图引擎");
    const provider = this.registry.get(step.provider_id);
    const version = this.repo.nextArtifactVersion(step.id);
    const outDir = this.stepDir(step, version);
    const title = this.repo.selectedArtifact(this.repo.getStepByTopicAndStep(step.topic_id, "title")!.id)?.content ?? "";
    this.repo.setStepPrompt(step.id, prompt);

    const release = await this.registry.semaphore(provider.row).acquire();
    try {
      const result = await provider.generate({
        taskId: String(step.id),
        stepType: "cover",
        prompt,
        timeoutMs: STEP_TIMEOUT_MS,
        outDir,
        imageCount: 3,
        imageSize: "1080x1920",
        overlayText: title, // 叠字类引擎（Grok底图+程序叠字）会把标题精确压到底图上；其他引擎忽略
      });
      if (result.kind !== "images" || result.files.length === 0) throw new Error("封面引擎未返回图片");
      const hadSelected = !!this.repo.selectedArtifact(step.id);
      result.files.forEach((file, i) => {
        const artifact = this.repo.createArtifact({
          stepId: step.id,
          version,
          kind: "image",
          role: "cover",
          filePath: file,
          label: `封面候选 v${version}-${i + 1}`,
          selected: !hadSelected && i === 0,
        });
        this.emitEvent({ type: "artifact", topicId: step.topic_id, stepId: step.id, data: artifact });
      });
    } finally {
      release();
    }
  }

  getCoverPrompt(topicId: number): string {
    return this.readRuntime(topicId).coverPrompt ?? "";
  }

  setCoverPrompt(topicId: number, prompt: string) {
    if (!prompt?.trim()) throw new Error("封面提示词不能为空");
    const graph = this.readRuntime(topicId);
    graph.coverPrompt = prompt.trim();
    this.writeRuntime(topicId, graph);
  }

  private async runTts(step: StepRow) {
    const graph = this.readRuntime(step.topic_id);
    if (graph.scenes.length === 0) throw new Error("缺少 runtime/scenes.json，请先生成分镜表");
    if (!step.provider_id) throw new Error("tts 步骤未绑定 TTS 引擎");
    const provider = this.registry.get(step.provider_id);
    const version = this.repo.nextArtifactVersion(step.id);
    const outDir = this.stepDir(step, version);
    const release = await this.registry.semaphore(provider.row).acquire();
    try {
      const result = await provider.generate({
        taskId: String(step.id),
        stepType: "tts",
        prompt: graph.scenes.map((s) => s.narration).join("\n---\n"),
        timeoutMs: STEP_TIMEOUT_MS,
        outDir,
      });
      if (result.kind !== "audio") throw new Error("TTS 引擎未返回音频");
      graph.scenes.forEach((scene, idx) => {
        scene.audioPath = result.files[idx];
        scene.durationSec = result.durationsSec[idx];
        const artifact = this.repo.createArtifact({
          stepId: step.id,
          version,
          kind: "audio",
          role: "narration",
          filePath: result.files[idx],
          label: `配音 ${scene.index}`,
          meta: { sceneIndex: scene.index, durationSec: scene.durationSec },
        });
        this.emitEvent({ type: "artifact", topicId: step.topic_id, stepId: step.id, data: artifact });
      });
    } finally {
      release();
    }
    this.writeRuntime(step.topic_id, graph);
  }

  private async runVideo(step: StepRow) {
    const graph = this.readRuntime(step.topic_id);
    if (graph.scenes.length === 0) throw new Error("缺少 runtime/scenes.json，请先生成分镜表");
    if (!step.provider_id) throw new Error("video 步骤未绑定视频生成引擎");
    const topic = this.repo.getTopic(step.topic_id)!;
    const mode = topic.brief.mediaMode ?? "image-tts";
    const provider = this.registry.get(step.provider_id);
    const version = this.repo.nextArtifactVersion(step.id);
    const outDir = this.stepDir(step, version);

    for (const scene of graph.scenes) {
      const inputImage = mode === "image-video" ? scene.framePath : undefined;
      if (mode === "image-video" && (!inputImage || !fs.existsSync(inputImage))) {
        throw new Error(`镜头 ${scene.index} 缺少基底图片，请先运行「逐镜画面+封面」`);
      }
      const prompt = [
        scene.visual || scene.narration,
        `Narration/dialogue to include naturally in the generated clip: ${scene.narration}`,
        "Vertical short-video shot, coherent motion, preserve character identity and appearance.",
      ].join("\n");
      const release = await this.registry.semaphore(provider.row).acquire();
      try {
        const result = await provider.generate({
          taskId: `${step.id}-${scene.index}`,
          stepType: "video",
          prompt,
          timeoutMs: STEP_TIMEOUT_MS,
          outDir,
          images: inputImage ? [inputImage] : undefined,
          imageSize: "9:16",
          durationSec: 5,
        });
        if (result.kind !== "videos" || !result.files[0]) throw new Error(`镜头 ${scene.index} 未生成视频`);
        scene.videoPath = result.files[0];
        const artifact = this.repo.createArtifact({
          stepId: step.id,
          version,
          kind: "video",
          role: "generated-clip",
          filePath: result.files[0],
          label: `视频镜头 ${scene.index}`,
          meta: { sceneIndex: scene.index, mode },
        });
        this.emitEvent({ type: "artifact", topicId: step.topic_id, stepId: step.id, data: artifact });
      } finally {
        release();
      }
    }
    this.writeRuntime(step.topic_id, graph);
  }

  private async runCompose(step: StepRow) {
    const graph = this.readRuntime(step.topic_id);
    if (graph.scenes.length === 0) throw new Error("缺少 runtime/scenes.json，请先生成分镜表");
    const version = this.repo.nextArtifactVersion(step.id);
    const outDir = this.stepDir(step, version);

    // 实拍镜头的素材源：选题的第一个视频素材
    const footage = this.repo.listMaterials(step.topic_id).find((m) => m.kind === "video")?.file_path ?? undefined;

    const mediaMode = this.repo.getTopic(step.topic_id)?.brief.mediaMode ?? "image-tts";
    // 主时钟：普通路径取 TTS 时长；视频路径取生成视频的实测时长。
    const inputs: ComposeSceneInput[] = [];
    for (const scene of graph.scenes) {
      if (mediaMode !== "image-tts") {
        if (!scene.videoPath || !fs.existsSync(scene.videoPath)) {
          throw new Error(`镜头 ${scene.index} 缺少生成视频，请先运行「逐镜视频生成」`);
        }
        const videoDur = await probeDurationSec(scene.videoPath);
        if (!videoDur) throw new Error(`镜头 ${scene.index} 视频时长无法探测`);
        scene.durationSec = Math.round(videoDur * 100) / 100;
        inputs.push({
          index: scene.index,
          source: "video",
          videoPath: scene.videoPath,
          subtitle: scene.subtitle || scene.narration,
          ttsDurSec: scene.durationSec,
          durationSec: scene.durationSec,
        });
        continue;
      }
      if (!scene.audioPath || !fs.existsSync(scene.audioPath)) {
        throw new Error(`镜头 ${scene.index} 缺少配音文件，请先运行「逐镜配音」`);
      }
      const ttsDur = (await probeDurationSec(scene.audioPath)) ?? scene.durationSec;
      if (!ttsDur || ttsDur <= 0) throw new Error(`镜头 ${scene.index} 配音时长无法探测`);
      scene.ttsDurSec = Math.round(ttsDur * 100) / 100;
      scene.durationSec = Math.round((ttsDur + GAP_SEC) * 100) / 100;

      if (scene.source === "footage") {
        if (!footage || !fs.existsSync(footage)) {
          throw new Error(`镜头 ${scene.index} 为实拍镜头，但选题没有可用的视频素材`);
        }
        inputs.push({
          index: scene.index,
          source: "footage",
          footagePath: footage,
          clipStart: scene.clip?.start,
          clipEnd: scene.clip?.end,
          audioPath: scene.audioPath,
          subtitle: scene.subtitle || scene.narration,
          ttsDurSec: scene.ttsDurSec,
          durationSec: scene.durationSec,
        });
      } else {
        if (!scene.framePath || !fs.existsSync(scene.framePath)) {
          throw new Error(`镜头 ${scene.index} 缺少画面文件，请先运行「逐镜画面」`);
        }
        inputs.push({
          index: scene.index,
          source: "generated",
          framePath: scene.framePath,
          audioPath: scene.audioPath,
          subtitle: scene.subtitle || scene.narration,
          ttsDurSec: scene.ttsDurSec,
          durationSec: scene.durationSec,
        });
      }
    }

    const bgmEnv = process.env.AMP_BGM_PATH?.trim();
    const result = await composeMaster({
      scenes: inputs,
      outDir,
      bgmPath: bgmEnv && fs.existsSync(bgmEnv) ? bgmEnv : undefined,
      onPhase: (phase, pct, message) =>
        this.emitEvent({
          type: "compose-progress",
          topicId: step.topic_id,
          stepId: step.id,
          data: { phase, pct: Math.round(pct), message },
        }),
    });

    result.segmentPaths.forEach((segPath, i) => {
      graph.scenes[i].segmentPath = segPath;
      const artifact = this.repo.createArtifact({
        stepId: step.id,
        version,
        kind: "video",
        role: "segment",
        filePath: segPath,
        label: `分段 ${graph.scenes[i].index}`,
        meta: { sceneIndex: graph.scenes[i].index, durationSec: graph.scenes[i].durationSec },
      });
      this.emitEvent({ type: "artifact", topicId: step.topic_id, stepId: step.id, data: artifact });
    });
    this.repo.createArtifact({
      stepId: step.id,
      version,
      kind: "file",
      role: "subtitles",
      filePath: result.assPath,
      label: "字幕 subtitles.ass",
    });
    const master = this.repo.createArtifact({
      stepId: step.id,
      version,
      kind: "video",
      role: "master",
      filePath: result.masterPath,
      label: `母版成片 master.mp4（${result.totalDurSec}s）`,
      meta: { durationSec: result.totalDurSec },
      selected: true,
    });
    this.emitEvent({ type: "artifact", topicId: step.topic_id, stepId: step.id, data: master });
    this.writeRuntime(step.topic_id, graph);
  }

  /**
   * 评审 = 本地规则预检（极限词/敏感词）+ LLM 多维打分。
   * 只报告不重跑：verdict 不合格时也把结果展示给用户，由用户决定是否点「按建议重跑」。
   */
  private async runReview(step: StepRow) {
    const title = this.repo.selectedArtifact(this.repo.getStepByTopicAndStep(step.topic_id, "title")!.id)?.content ?? "";
    const script = this.repo.selectedArtifact(this.repo.getStepByTopicAndStep(step.topic_id, "script")!.id)?.content ?? "";
    const ruleIssues = [
      ...ruleCheck(title).map((issue) => `标题：${issue}`),
      ...ruleCheck(script).map((issue) => `口播稿：${issue}`),
    ];

    let items: any[] = [];
    let note: string | undefined;
    if (!step.provider_id) {
      note = "评审未绑定引擎，仅执行本地规则预检";
    } else {
      try {
        const provider = this.registry.get(step.provider_id);
        const prompt = this.composePrompt(step);
        this.repo.setStepPrompt(step.id, prompt);
        const release = await this.registry.semaphore(provider.row).acquire();
        let result: GenerateResult;
        try {
          result = await provider.generate(
            { taskId: String(step.id), stepType: "review", prompt, timeoutMs: STEP_TIMEOUT_MS },
            (chunk) => this.emitEvent({ type: "step-stream", topicId: step.topic_id, stepId: step.id, data: { chunk } })
          );
        } finally {
          release();
        }
        if (result.kind !== "text") throw new Error("评审引擎未返回文本");
        const parsed = extractJson<any[]>(result.text);
        if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("评审输出无法解析为 JSON 数组");
        items = parsed.map((item) => ({
          target: item.target === "script" ? "script" : "title",
          scores: item.scores ?? {},
          total: Number(item.total ?? 0),
          verdict: item.verdict === "pass" ? "pass" : item.verdict === "reject" ? "reject" : "revise",
          issues: Array.isArray(item.issues) ? item.issues.map(String) : [],
          suggestions: Array.isArray(item.suggestions) ? item.suggestions.map(String) : [],
        }));
      } catch (err: any) {
        note = `LLM 评审失败（${err?.message ?? String(err)}），以下仅为本地规则预检结果`;
      }
    }

    const report = { mode: "report-only", items, ruleIssues, note };
    const version = this.repo.nextArtifactVersion(step.id);
    const artifact = this.repo.createArtifact({
      stepId: step.id,
      version,
      kind: "text",
      role: "review",
      content: JSON.stringify(report, null, 2),
      selected: true,
    });
    this.emitEvent({ type: "artifact", topicId: step.topic_id, stepId: step.id, data: artifact });
    this.emitEvent({ type: "review", topicId: step.topic_id, stepId: step.id, data: report });
  }

  /** 平台派生入口：校验母版存在后直接执行 adapt 步骤（不经主线推进，避免被前置步骤拦住） */
  requestAdapt(topicId: number, platforms: string[]) {
    const specs = this.templates.listPlatforms();
    if (specs.length === 0) throw new Error("缺少 platforms/platforms.json 平台参数表");
    if (!platforms?.length) throw new Error("请至少选择一个平台");
    const unknown = platforms.filter((p) => !specs.some((spec) => spec.id === p));
    if (unknown.length) throw new Error(`未知平台: ${unknown.join(", ")}`);
    if (!this.findMasterPath(topicId)) throw new Error("请先完成「合成母版」，再生成发布包");
    const adaptStep = this.repo.getStepByTopicAndStep(topicId, "adapt");
    if (!adaptStep) throw new Error("adapt 步骤不存在");
    if (this.inflight.has(adaptStep.id)) throw new Error("发布包正在生成中，请稍候");

    this.adaptPlatforms.set(topicId, platforms);
    this.repo.setStepStatus(adaptStep.id, "running", { started: true, error: null });
    this.emitEvent({ type: "step-status", topicId, stepId: adaptStep.id, data: { status: "running" } });
    this.inflight.add(adaptStep.id);
    void this.runStep(adaptStep.id).finally(() => {
      this.inflight.delete(adaptStep.id);
      this.refreshTopicStatus(topicId);
    });
  }

  private findMasterPath(topicId: number): string | undefined {
    const composeStep = this.repo.getStepByTopicAndStep(topicId, "compose");
    if (!composeStep) return undefined;
    const masters = this.repo.listArtifactsByStep(composeStep.id).filter((a) => a.role === "master" && a.file_path);
    const master = masters.find((a) => a.selected) ?? masters.at(-1);
    return master?.file_path && fs.existsSync(master.file_path) ? master.file_path : undefined;
  }

  private async runAdapt(step: StepRow) {
    const topicId = step.topic_id;
    const specs = this.templates.listPlatforms();
    const chosen = this.adaptPlatforms.get(topicId) ?? specs.map((spec) => spec.id);
    const selectedSpecs = specs.filter((spec) => chosen.includes(spec.id));
    if (selectedSpecs.length === 0) throw new Error("没有可用平台（检查 platforms/platforms.json）");

    const masterPath = this.findMasterPath(topicId);
    if (!masterPath) throw new Error("缺少母版成片，请先完成「合成母版」");
    const coverStep = this.repo.getStepByTopicAndStep(topicId, "cover");
    const coverArtifacts = coverStep ? this.repo.listArtifactsByStep(coverStep.id).filter((a) => a.role === "cover") : [];
    const coverArtifact = coverArtifacts.find((a) => a.selected) ?? coverArtifacts.at(-1);
    const coverSrc =
      coverArtifact?.file_path && fs.existsSync(coverArtifact.file_path) ? coverArtifact.file_path : undefined;
    const title = this.repo.selectedArtifact(this.repo.getStepByTopicAndStep(topicId, "title")!.id)?.content ?? "";
    const script = this.repo.selectedArtifact(this.repo.getStepByTopicAndStep(topicId, "script")!.id)?.content ?? "";
    const version = this.repo.nextArtifactVersion(step.id);

    for (const spec of selectedSpecs) {
      this.emitEvent({
        type: "step-stream",
        topicId,
        stepId: step.id,
        data: { chunk: `【${spec.name}】发布包生成中...\n` },
      });
      const pkgDir = path.join(this.workspaceDir, `topic-${topicId}`, "packages", spec.id);
      fs.mkdirSync(pkgDir, { recursive: true });

      // 1) 视频转比例：与母版同比例直接复用，否则裁切/模糊 pad
      const videoOut = path.join(pkgDir, "video.mp4");
      if (spec.aspect === "9:16") fs.copyFileSync(masterPath, videoOut);
      else await deriveAspectVideo(masterPath, videoOut, spec.aspect);

      // 2) 封面按平台尺寸派生
      let coverOut: string | undefined;
      if (coverSrc) {
        coverOut = path.join(pkgDir, "cover.jpg");
        const [cw, ch] = spec.coverSize.split("x").map((n) => parseInt(n, 10));
        await sharp(coverSrc).resize(cw || 1080, ch || 1920, { fit: "cover" }).jpeg({ quality: 92 }).toFile(coverOut);
      }

      // 3) 标题/文案按平台参数小改写（同源改写，不重新创作）
      let copyData: { title?: string; caption?: string; tags?: string[] } = {};
      if (step.provider_id) {
        try {
          const provider = this.registry.get(step.provider_id);
          const prompt = renderTemplate(this.templates.readPrompt("adapt-copy.md"), {
            ...this.buildVars(step),
            platform: spec,
          });
          const release = await this.registry.semaphore(provider.row).acquire();
          let result: GenerateResult;
          try {
            result = await provider.generate({
              taskId: `${step.id}-${spec.id}`,
              stepType: "adapt",
              prompt,
              timeoutMs: STEP_TIMEOUT_MS,
            });
          } finally {
            release();
          }
          if (result.kind === "text") copyData = extractJson<typeof copyData>(result.text) ?? {};
        } catch {
          // 改写失败回落母版标题/口播稿，不阻断发布包
        }
      }
      const pTitle = String(copyData.title || title).slice(0, spec.titleMaxLen);
      const tags = (copyData.tags ?? []).slice(0, spec.tagCount?.[1] ?? 5).map((t) => `#${String(t).replace(/^#/, "")}`);
      const caption = [String(copyData.caption || script.slice(0, 120)), tags.join(" ")].filter(Boolean).join("\n\n");
      fs.writeFileSync(path.join(pkgDir, "title.txt"), pTitle, "utf-8");
      fs.writeFileSync(path.join(pkgDir, "caption.txt"), caption, "utf-8");
      fs.writeFileSync(
        path.join(pkgDir, "checklist.md"),
        `# ${spec.name} 发布注意事项\n\n${spec.checklist.map((c) => `- [ ] ${c}`).join("\n")}\n`,
        "utf-8"
      );

      const pkg = this.repo.upsertPackage({
        topicId,
        platform: spec.id,
        videoPath: videoOut,
        title: pTitle,
        caption,
        coverPaths: coverOut ? [coverOut] : [],
        checklist: spec.checklist,
      });
      this.emitEvent({ type: "package", topicId, data: pkg });

      for (const artifact of [
        this.repo.createArtifact({
          stepId: step.id,
          version,
          kind: "video" as const,
          role: "package-video",
          filePath: videoOut,
          label: `【${spec.name}】成片 ${spec.aspect}`,
          meta: { platform: spec.id },
        }),
        coverOut
          ? this.repo.createArtifact({
              stepId: step.id,
              version,
              kind: "image" as const,
              role: "package-cover",
              filePath: coverOut,
              label: `【${spec.name}】封面 ${spec.coverSize}`,
              meta: { platform: spec.id },
            })
          : null,
        this.repo.createArtifact({
          stepId: step.id,
          version,
          kind: "text" as const,
          role: "package-copy",
          content: `【标题】${pTitle}\n\n【发布文案】\n${caption}\n\n【注意事项】\n${spec.checklist.map((c) => `- ${c}`).join("\n")}`,
          label: `【${spec.name}】发布文案`,
          meta: { platform: spec.id },
        }),
      ]) {
        if (artifact) this.emitEvent({ type: "artifact", topicId, stepId: step.id, data: artifact });
      }
    }
    this.adaptPlatforms.delete(topicId);
    this.adaptRequested.delete(topicId);
  }
}
