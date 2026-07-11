import type { ProviderFactory } from "@amp/core";
import type { ProviderKind } from "@amp/shared";
import { createCliProvider } from "./cli.js";
import { createApiTextProvider } from "./apiText.js";
import { createApiImageProvider } from "./apiImage.js";
import { createApiVideoProvider } from "./apiVideo.js";
import { createTtsProvider } from "./tts.js";
export { ensureAnalysisImage, ensureImageThumbnail } from "./thumbnail.js";

export const providerFactories: Record<ProviderKind, ProviderFactory> = {
  cli: createCliProvider,
  "api-text": createApiTextProvider,
  "api-image": createApiImageProvider,
  "api-video": createApiVideoProvider,
  tts: createTtsProvider,
};

export { createCliProvider, createApiTextProvider, createApiImageProvider, createApiVideoProvider, createTtsProvider };
