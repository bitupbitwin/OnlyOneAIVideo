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
  "frames",
  "tts",
  "compose",
  "review",
  "adapt",
];

export const MAINLINE_STEP_DEFS: Record<StepId, StepDefMeta> = {
  analyze: {
    id: "analyze",
    name: "素材理解",
    prompt: null,
    humanGate: true,
    requiresProvider: true,
    providerKinds: ["api-text"],
    defaultProviderId: "api-grok-vision",
    requiredForTopicSuccess: true,
  },
  title: {
    id: "title",
    name: "标题",
    prompt: "title.md",
    humanGate: true,
    requiresProvider: true,
    providerKinds: ["cli", "api-text"],
    defaultProviderId: "cli-mock",
    requiredForTopicSuccess: true,
  },
  script: {
    id: "script",
    name: "口播稿",
    prompt: "script.md",
    humanGate: false,
    requiresProvider: true,
    providerKinds: ["cli", "api-text"],
    defaultProviderId: "cli-mock",
    requiredForTopicSuccess: true,
  },
  storyboard: {
    id: "storyboard",
    name: "分镜表",
    prompt: "storyboard.md",
    humanGate: false,
    requiresProvider: true,
    providerKinds: ["cli", "api-text"],
    defaultProviderId: "cli-mock",
    requiredForTopicSuccess: true,
  },
  frames: {
    id: "frames",
    name: "逐镜画面+封面",
    prompt: "cover.md",
    humanGate: false,
    requiresProvider: true,
    providerKinds: ["api-image"],
    defaultProviderId: "img-mock",
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
    defaultProviderId: "cli-mock",
    requiredForTopicSuccess: true,
  },
  adapt: {
    id: "adapt",
    name: "平台派生",
    prompt: "adapt-copy.md",
    humanGate: false,
    requiresProvider: true,
    providerKinds: ["api-text", "cli"],
    defaultProviderId: "cli-mock",
    requiredForTopicSuccess: false,
  },
};

export function initialStepStatus(stepId: StepId, sourceType: SourceType): StepStatus {
  return stepId === "analyze" && sourceType === "text" ? "skipped" : "pending";
}
