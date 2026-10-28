import { createModels, type CreateModelsOptions, type MutableModels } from "@earendil-works/pi-ai";
import { LOCAL_PROVIDER_ID, OPENAI_COMPATIBLE_PROVIDER_ID } from "@rakazo/contracts";
import { registerLocalProvider } from "./pi-local-provider.js";
import { applyPiModelCompatibility } from "./pi-model-compat.js";
import { registerOpenAiCompatibleCatalog } from "./pi-openai-compatible-provider.js";

/** The only providers a Rakazo deployment exposes. */
export const MANAGED_PROVIDER_IDS: ReadonlySet<string> = new Set([
  LOCAL_PROVIDER_ID,
  OPENAI_COMPATIBLE_PROVIDER_ID,
]);

/**
 * The one place that decides which providers a Rakazo deployment offers.
 *
 * `@earendil-works/pi-ai/providers/all`'s `builtinModels()` registers every
 * provider in the upstream catalog (OpenRouter, Anthropic, OpenAI, Google,
 * Groq, Bedrock, Copilot, ...). Rakazo deployments run on a centrally managed
 * endpoint or a user-controlled OpenAI-compatible URL instead, so the upstream
 * catalog is deliberately left empty here and only two providers are added:
 *
 * - `local` — the deployment-configured OpenAI-compatible endpoint
 * - `openai-compatible` — user-supplied OpenAI-compatible connections
 *
 * Starting from `createModels()` rather than `builtinModels()` is what keeps
 * the removed providers from reappearing through any call path.
 */
export function createManagedModels(options?: CreateModelsOptions): MutableModels {
  return registerOpenAiCompatibleCatalog(
    registerLocalProvider(applyPiModelCompatibility(createModels(options))),
  );
}
