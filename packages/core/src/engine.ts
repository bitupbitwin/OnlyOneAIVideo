import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { extractJson, renderTemplate } from "@amp/shared";
import type { EngineEvent, GenerateResult, RuntimeSceneGraph, StepId, TopicStatus } from "@amp/shared";
import { ruleCheck } from "@amp/review";
import type { Repo, StepRow } from "./db.js";
import type { ProviderRegistry } from "./registry.js";
import type { TemplateStore } from "./templates.js";
import { initialStepStatus, MAINLINE, MAINLINE_STEP_DEFS, type StepDefMeta } from "./stepDefs.js";
import { composeMaster, probeDurationSec, type ComposeSceneInput } from "./compose.js";

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

      if (step.step_id === "frames") {
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
        throw new Error("M5 平台派生尚未实现");
      } else {
        await this.runProviderTextStep(step);
      }

      const latest = this.repo.getStep(step.id)!;
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
      const normalized: RuntimeSceneGraph = {
        bgmMood: parsed.bgmMood,
        scenes: parsed.scenes.map((scene, idx) => ({
          index: Number(scene.index ?? idx + 1),
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
    const firstFrame = graph.scenes.find((scene) => scene.framePath)?.framePath;
    if (firstFrame) {
      const cover = this.repo.createArtifact({
        stepId: step.id,
        version,
        kind: "image",
        role: "cover",
        filePath: firstFrame,
        label: "封面（复用首镜，不额外消耗出图额度）",
        meta: { source: "first-frame" },
      });
      this.emitEvent({ type: "artifact", topicId: step.topic_id, stepId: step.id, data: cover });
    }
    this.writeRuntime(step.topic_id, graph);
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

  private async runReview(step: StepRow) {
    const title = this.repo.selectedArtifact(this.repo.getStepByTopicAndStep(step.topic_id, "title")!.id)?.content ?? "";
    const script = this.repo.selectedArtifact(this.repo.getStepByTopicAndStep(step.topic_id, "script")!.id)?.content ?? "";
    const issues = [...ruleCheck(title), ...ruleCheck(script)];
    const text = JSON.stringify(
      [
        {
          target: "title",
          scores: { compliance: issues.length ? 6 : 9 },
          total: issues.length ? 70 : 86,
          verdict: issues.length ? "revise" : "pass",
          issues,
          suggestions: issues.length ? ["请替换命中的极限词或敏感词"] : [],
        },
      ],
      null,
      2
    );
    const version = this.repo.nextArtifactVersion(step.id);
    this.repo.createArtifact({ stepId: step.id, version, kind: "text", role: "review", content: text, selected: true });
  }
}
