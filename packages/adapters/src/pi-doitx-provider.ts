import type { Model, MutableModels, Provider } from "@earendil-works/pi-ai";
import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { DOITX_PROVIDER_ID } from "@rakazo/contracts";

import { declaredVisionModelIds, inputModalities } from "./model-modalities.js";

/** The Doitx router: the deployment's centrally managed remote endpoint. */
export { DOITX_PROVIDER_ID };

/** Model ids the router serves, declared by the operator. */
export const DOITX_MODELS_ENV = "RAKAZO_DOITX_MODELS";

/** Model ids the router serves with vision, declared by the operator. */
export const DOITX_VISION_MODELS_ENV = "RAKAZO_DOITX_VISION_MODELS";

/** Bearer token used when a user has not supplied their own key. */
export const DOITX_API_KEY_ENV = "RAKAZO_DOITX_API_KEY";

export function doitxVisionModelIds(): ReadonlySet<string> {
  return declaredVisionModelIds(DOITX_VISION_MODELS_ENV);
}

/**
 * The router lives on the public internet, so its address is a product decision
 * rather than a user choice — a deployment can still point at a mirror.
 */
const DEFAULT_BASE_URL = "https://router.doitx.ai/v1";
const DEFAULT_CONTEXT_WINDOW = 32_768;
const DEFAULT_MAX_TOKENS = 4_096;

/**
 * The provider is registered even with no configured ids, so the router stays
 * reachable: `catalogProbe` lists its real models at run time, and this seed
 * keeps the provider and its base URL present for the live entries to hang off.
 * It is marked as a placeholder, so it is never chosen as a model to run.
 */
export const DOITX_SEED_MODEL_ID = "doitx-router";

export function doitxBaseUrl(): string {
  const value = process.env.RAKAZO_DOITX_MODELS_URL?.trim() || DEFAULT_BASE_URL;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("RAKAZO_DOITX_MODELS_URL must be an absolute HTTP(S) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("RAKAZO_DOITX_MODELS_URL must be an absolute HTTP(S) URL");
  }
  return value;
}

/** Throws instead of `Number(x) || default`, which would swallow a typo or accept a negative window. */
function tokenLimit(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, received "${raw}"`);
  }
  return value;
}

/** Comma-separated model ids exactly as the router names them. */
function doitxModelIds(): string[] {
  return (process.env[DOITX_MODELS_ENV] ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}

/**
 * The bearer token for the router.
 *
 * Each user supplies their own key through the normal connection form; this is
 * only the deployment-wide fallback for installs that share one credential.
 */
function doitxApiKey(): string {
  return process.env[DOITX_API_KEY_ENV]?.trim() || "doitx";
}

function doitxModel(id: string): Model<"openai-completions"> {
  return {
    id,
    name: id,
    api: "openai-completions",
    provider: DOITX_PROVIDER_ID,
    baseUrl: doitxBaseUrl(),
    reasoning: false,
    compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
    input: inputModalities(doitxVisionModelIds().has(id)),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: tokenLimit("RAKAZO_DOITX_CONTEXT_WINDOW", DEFAULT_CONTEXT_WINDOW),
    maxTokens: tokenLimit("RAKAZO_DOITX_MAX_TOKENS", DEFAULT_MAX_TOKENS),
  };
}

export function doitxProvider(): Provider {
  const ids = doitxModelIds();
  return createProvider({
    id: DOITX_PROVIDER_ID,
    name: "Doitx Router",
    baseUrl: doitxBaseUrl(),
    auth: {
      apiKey: {
        name: "Doitx router",
        resolve: async () => ({
          auth: { apiKey: doitxApiKey(), baseUrl: doitxBaseUrl() },
          source: "doitx router",
        }),
      },
    },
    models: (ids.length ? ids : [DOITX_SEED_MODEL_ID]).map(doitxModel),
    api: openAICompletionsApi(),
  });
}

export function registerDoitxProvider(models: MutableModels): MutableModels {
  models.setProvider(doitxProvider());
  return models;
}
