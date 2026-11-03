import { type CreateModelsOptions, createModels, type MutableModels } from "@earendil-works/pi-ai";
import { MANAGED_MODEL_PROVIDER_IDS } from "@rakazo/contracts";
import { registerDoitxProvider } from "./pi-doitx-provider.js";
import { registerLocalProvider } from "./pi-local-provider.js";
import { applyPiModelCompatibility } from "./pi-model-compat.js";

/**
 * The only providers a Doitx deployment exposes — the same set the connect schema
 * enforces, so the two cannot drift apart.
 */
export const MANAGED_PROVIDER_IDS: ReadonlySet<string> = MANAGED_MODEL_PROVIDER_IDS;

/**
 * The one place that decides which providers a Doitx deployment offers.
 *
 * `@earendil-works/pi-ai/providers/all`'s `builtinModels()` registers every
 * provider in the upstream catalog (OpenRouter, Anthropic, OpenAI, Google,
 * Groq, Bedrock, Copilot, ...). Doitx deployments talk to exactly two
 * OpenAI-compatible endpoints instead, so the upstream catalog is deliberately
 * left empty here and only two providers are added:
 *
 * - `local` — the deployment-configured endpoint (default 127.0.0.1:3456)
 * - `doitx` — the centrally managed Doitx router (default router.doitx.ai)
 *
 * Starting from `createModels()` rather than `builtinModels()` is what keeps
 * the removed providers from reappearing through any call path.
 */
export function createManagedModels(options?: CreateModelsOptions): MutableModels {
  return registerDoitxProvider(
    registerLocalProvider(applyPiModelCompatibility(createModels(options))),
  );
}
