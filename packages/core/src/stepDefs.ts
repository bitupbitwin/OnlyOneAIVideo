import type { ProviderKind, SourceType, StepId, StepStatus } from "@amp/shared";

export interface StepDefMeta {
  id: StepId;
  name: string;
  prompt: string | null;
  humanGate: boolean;
  requiresProvider: boolean;
  providerKinds: ProviderKind[];
  defaultProviderId: string | null;
  requiredForTopicSuccess: boolean;
}

export const MAINLINE: StepId[] = [
  "analyze",
  "title",
  "script",
  "storyboard",
  "cover",
  "frames",
  "video",
  "tts",
  "compose",
  "review",
  "adapt",
];

export const MAINLINE_STEP_DEFS: Record<StepId, StepDefMeta> = {
  analyze: {
    id: "analyze",
    name: "素材理解",
    prompt: "analyze.md",
    humanGate: true,
    requiresProvider: true,
    providerKinds: ["api-text", "cli"],
    defaultProviderId: "cli-grok",
    requiredForTopicSuccess: true,
  },
  title: {
    id: "title",
    name: "标题",
    prompt: "title.md",
    humanGate: true,
    requiresProvider: true,
    providerKinds: ["cli", "api-text"],
    defaultProviderId: "cli-grok",
    requiredForTopicSuccess: true,
  },
  script: {
    id: "script",
    name: "口播稿",
    prompt: "script.md",
    humanGate: false,
    requiresProvider: true,
    providerKinds: ["cli", "api-text"],
    defaultProviderId: "cli-grok",
    requiredForTopicSuccess: true,
  },
  storyboard: {
    id: "storyboard",
    name: "分镜表",
    prompt: "storyboard.md",
    humanGate: false,
    requiresProvider: true,
    providerKinds: ["cli", "api-text"],
    defaultProviderId: "cli-grok",
    requiredForTopicSuccess: true,
  },
  cover: {
    id: "cover",
    name: "封面出图",
    // 提示词不走模板：分镜表 index0 生成初稿 copy 到 runtime.coverPrompt，用户可润色后出图
    prompt: null,
    humanGate: false,
    requiresProvider: true,
    providerKinds: ["cli", "api-image"],
    defaultProviderId: "cli-grok",
    requiredForTopicSuccess: true,
  },
  frames: {
    id: "frames",
    name: "逐镜画面",
    prompt: null,
    humanGate: false,
    requiresProvider: true,
    providerKinds: ["cli", "api-image"],
    defaultProviderId: "cli-grok",
    requiredForTopicSuccess: true,
  },
  video: {
    id: "video",
    name: "逐镜视频生成",
    prompt: null,
    humanGate: false,
    requiresProvider: true,
    providerKinds: ["cli", "api-video"],
    defaultProviderId: "cli-grok",
    requiredForTopicSuccess: true,
  },
  tts: {
    id: "tts",
    name: "逐镜配音",
    prompt: null,
    humanGate: false,
    requiresProvider: true,
    providerKinds: ["tts"],
    defaultProviderId: "tts-mock",
    requiredForTopicSuccess: true,
  },
  compose: {
    id: "compose",
    name: "合成母版",
    prompt: null,
    humanGate: false,
    requiresProvider: false,
    providerKinds: [],
    defaultProviderId: null,
    requiredForTopicSuccess: true,
  },
  review: {
    id: "review",
    name: "评审",
    prompt: "review.md",
    humanGate: false,
    requiresProvider: true,
    providerKinds: ["api-text", "cli"],
    defaultProviderId: "cli-grok",
    requiredForTopicSuccess: true,
  },
  adapt: {
    id: "adapt",
    name: "平台派生",
    prompt: "adapt-copy.md",
    humanGate: false,
    requiresProvider: true,
    providerKinds: ["api-text", "cli"],
    defaultProviderId: "cli-grok",
    requiredForTopicSuccess: false,
  },
};

export function initialStepStatus(
  stepId: StepId,
  sourceType: SourceType,
  mediaMode: "image-tts" | "image-video" | "text-video" = "image-tts"
): StepStatus {
  if (stepId === "analyze" && sourceType === "text") return "skipped";
  if (stepId === "frames" && mediaMode === "text-video") return "skipped";
  if (stepId === "video" && mediaMode === "image-tts") return "skipped";
  if (stepId === "tts" && mediaMode !== "image-tts") return "skipped";
  return "pending";
}
