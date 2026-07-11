export type StepId =
  | "analyze"
  | "title"
  | "script"
  | "storyboard"
  | "cover"
  | "frames"
  | "video"
  | "tts"
  | "compose"
  | "review"
  | "adapt";

export type SourceType = "text" | "image" | "footage";
export type SceneSource = "generated" | "footage";
export type ProviderKind = "cli" | "api-text" | "api-image" | "api-video" | "tts";
export type ProviderCapability =
  | "text-generation"
  | "image-understanding"
  | "video-understanding"
  | "image-generation"
  | "image-editing"
  | "text-to-video"
  | "image-to-video"
  | "video-editing"
  | "tts";

export type StepStatus =
  | "pending"
  | "running"
  | "waiting_human"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "skipped";

export type TopicStatus = "pending" | "running" | "waiting_human" | "succeeded" | "failed";

export interface Brief {
  topic: string;
  audience?: string;
  sellingPoints?: string;
  references?: string;
  requirements?: string;
  extra?: string;
  mediaMode?: "image-tts" | "image-video" | "text-video";
  aspectRatio?: "16:9" | "9:16" | "1:1" | "3:4" | "4:3";
  resolution?: "540p" | "720p" | "1080p" | "1K" | "2K" | "4K";
  videoDurationSec?: 5 | 10 | 15;
}

export type MaterialKind = "text" | "image" | "video" | "file";

export interface MaterialRow {
  id: number;
  topic_id: number;
  kind: MaterialKind;
  original_name: string | null;
  file_path: string | null;
  content: string | null;
  note: string | null;
  created_at: string;
}

export interface ProviderRow {
  id: string;
  kind: ProviderKind;
  name: string;
  config: Record<string, any>;
  maxConcurrency: number;
  enabled: boolean;
  capabilities: ProviderCapability[];
  /** 是否能向流水线返回可继续使用的真实文件，而非仅文字说明或 Mock 占位文件。 */
  realFileOutput: boolean;
}

export type StepType = StepId | "content" | "cover" | "video" | "image-prompts" | "image-to-video";

export interface GenerateRequest {
  taskId: string;
  stepType: StepType;
  prompt: string;
  timeoutMs: number;
  outDir?: string;
  images?: string[];
  videos?: string[];
  overlayText?: string;
  imageCount?: number;
  imageSize?: string;
  aspectRatio?: string;
  resolution?: string;
  durationSec?: number;
  voice?: string;
  speed?: number;
}

export interface TextResult {
  kind: "text";
  text: string;
}

export interface ImageResult {
  kind: "images";
  files: string[];
}

export interface VideoResult {
  kind: "videos";
  files: string[];
}

export interface AudioResult {
  kind: "audio";
  files: string[];
  durationsSec: number[];
}

export type GenerateResult = TextResult | ImageResult | VideoResult | AudioResult;

export interface ProviderStatus {
  ok: boolean;
  detail: string;
}

export interface EngineEvent {
  type: "topic-status" | "step-status" | "step-stream" | "artifact" | "review" | "compose-progress" | "package";
  topicId: number;
  stepId?: number;
  data: any;
}

export interface RuntimeScene {
  index: number;
  narration: string;
  subtitle: string;
  source: SceneSource;
  visual?: string;
  clip?: { start: number; end: number };
  framePath?: string;
  videoPath?: string;
  audioPath?: string;
  /** TTS 音频实测时长（compose 前 ffprobe 回填） */
  ttsDurSec?: number;
  /** 分段总时长 = ttsDurSec + gap，母版时间轴主时钟 */
  durationSec?: number;
  segmentPath?: string;
}

export interface RuntimeSceneGraph {
  scenes: RuntimeScene[];
  bgmMood?: string;
  /** 封面出图提示词：分镜表 index0 生成初稿 copy 到此，用户可在封面模块手动润色后再出图 */
  coverPrompt?: string;
}

export interface PlatformSpec {
  id: string;
  name: string;
  /** 目标视频比例，如 "9:16" / "3:4" / "16:9" / "1:1" */
  aspect: string;
  /** 封面尺寸 "宽x高" */
  coverSize: string;
  titleMaxLen: number;
  tagCount: [number, number];
  voice: string;
  checklist: string[];
}

export interface ReviewScore {
  target: "title" | "script" | "cover";
  scores: Record<string, number>;
  total: number;
  verdict: "pass" | "revise" | "reject";
  issues: string[];
  suggestions: string[];
}

// Legacy shape retained only so older helper modules still typecheck during the V2 cutover.
export type Platform = "douyin" | "xiaohongshu" | "wechat-mp" | "wechat-channels" | "bilibili" | "csdn" | "mv";
export type PipelineStatus = TopicStatus;
export interface CoverSize {
  w: number;
  h: number;
  label: string;
}
export interface StepDef {
  id: string;
  name: string;
  type: StepType;
  needs: string[];
  promptTemplate: string;
  humanGate?: boolean;
  defaultProvider?: string;
  coverSizes?: CoverSize[];
}
export interface PipelineOptionChoice {
  value: string;
  label: string;
}
export interface PipelineOption {
  id: string;
  label: string;
  default: string;
  type?: "choices" | "number" | "select";
  choices?: PipelineOptionChoice[];
}
export interface PipelineTemplate {
  id: string;
  platform: Platform;
  mode: string;
  name: string;
  steps: StepDef[];
  notes: string[];
  options?: PipelineOption[];
}
