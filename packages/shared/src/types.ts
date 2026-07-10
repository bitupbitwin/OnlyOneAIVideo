export type Platform = "douyin" | "xiaohongshu" | "wechat-mp" | "wechat-channels" | "bilibili" | "csdn" | "mv";

export type StepType =
  | "title"
  | "content"
  | "cover"
  | "video"
  | "review"
  | "lyrics"
  | "image-prompts"
  | "video-prompts"
  | "subtitle"
  | "docx"
  | "batch-images"
  | "image-to-video";

export type ProviderKind = "cli" | "api-text" | "api-image" | "api-video" | "web";

export type StepStatus =
  | "pending"
  | "running"
  | "waiting_human"
  | "succeeded"
  | "failed"
  | "cancelled";

export type PipelineStatus = "pending" | "running" | "waiting_human" | "succeeded" | "failed";

export interface Brief {
  topic: string;
  audience?: string;
  sellingPoints?: string;
  references?: string;
  /** 我的具体要求：希望生成成什么样、风格、必须包含/避免的内容等 */
  requirements?: string;
  extra?: string;
}

export type MaterialKind = "text" | "image" | "video" | "file";

export interface MaterialRow {
  id: number;
  project_id: number;
  kind: MaterialKind;
  original_name: string | null;
  file_path: string | null;
  /** 文本素材（粘贴/抽取）的内容 */
  content: string | null;
  /** 用户对该素材的说明 */
  note: string | null;
  created_at: string;
}

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
  /** 不同画面比例下的封面尺寸（按 options.aspect 选取，覆盖 coverSizes） */
  coverSizesByAspect?: Record<string, CoverSize[]>;
  post?: "jianying-draft";
  /** 条件步骤：仅当所有指定的运行选项都匹配时才创建该步骤（如 { visualMode: "images" }） */
  when?: Record<string, string>;
}

export interface PipelineOptionChoice {
  value: string;
  label: string;
}

/** 流程的可选参数（创建流程时由用户在界面上调节） */
export interface PipelineOption {
  id: string;
  label: string;
  /** 控件类型：choices=按钮单选（默认）；number=数字输入；select=下拉 */
  type?: "choices" | "number" | "select";
  /** choices / select 的候选项 */
  choices?: PipelineOptionChoice[];
  /** number 类型的范围与步进 */
  min?: number;
  max?: number;
  step?: number;
  /** 默认值（数字也用字符串存，渲染时转换） */
  default: string;
  /** 简短说明 */
  hint?: string;
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

export interface ProviderRow {
  id: string;
  kind: ProviderKind;
  name: string;
  config: Record<string, any>;
  maxConcurrency: number;
  enabled: boolean;
}

export interface GenerateRequest {
  taskId: string;
  stepType: StepType;
  prompt: string;
  timeoutMs: number;
  /** 图片类产物输出目录 */
  outDir?: string;
  /** 多模态输入图片（本地文件路径），用于封面评审等场景 */
  images?: string[];
  /** 封面叠字模式：要叠加到底图上的标题文字（出图引擎 config.overlayText=true 时生效） */
  overlayText?: string;
  /** 覆盖出图引擎本次返回的图片数量（批量出图时按提示词逐条调用，每条只出 1 张） */
  imageCount?: number;
  /** 覆盖出图尺寸（"宽x高"，如 "1080x1920"），让模型直接按该比例生成而非事后裁剪 */
  imageSize?: string;
  /** 图生视频：单条片段时长（秒） */
  durationSec?: number;
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

export type GenerateResult = TextResult | ImageResult | VideoResult;

export interface ProviderStatus {
  ok: boolean;
  detail: string;
}

export interface EngineEvent {
  type: "pipeline-status" | "step-status" | "step-stream" | "artifact" | "review";
  pipelineId: number;
  stepId?: number;
  data: any;
}

export interface ReviewScore {
  target: "title" | "content" | "cover";
  scores: Record<string, number>;
  total: number;
  verdict: "pass" | "revise" | "reject";
  issues: string[];
  suggestions: string[];
}
