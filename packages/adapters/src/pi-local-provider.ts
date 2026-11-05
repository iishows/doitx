import type { Model, MutableModels, Provider } from "@earendil-works/pi-ai";
import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { LOCAL_PROVIDER_ID } from "@rakazo/contracts";
import { existsSync } from "node:fs";

import { declaredVisionModelIds, inputModalities } from "./model-modalities.js";

/** The deployment's centrally managed OpenAI-compatible endpoint. */
export { LOCAL_PROVIDER_ID };

/**
 * Stands in for the local endpoint's models until a probe lists them.
 *
 * An unconfigured local endpoint still needs a catalog entry: the entry is what
 * carries the "discover models" affordance, and what a discovered model is appended
 * after. Like the router's seed it is marked as a placeholder, so it is never run.
 */
export const LOCAL_SEED_MODEL_ID = "local-endpoint";

/** Model ids the local server serves, declared by the operator. */
export const LOCAL_MODELS_ENV = "RAKAZO_LOCAL_MODELS";

/** Model ids the local server serves with vision, declared by the operator. */
export const LOCAL_VISION_MODELS_ENV = "RAKAZO_LOCAL_VISION_MODELS";

/** Bearer token for endpoints that authenticate, such as a gateway in front. */
export const LOCAL_API_KEY_ENV = "RAKAZO_LOCAL_MODELS_API_KEY";

/**
 * The bearer sent to a local endpoint that names no key of its own.
 *
 * A keyless server ignores the header, so this keeps it working; the same value is
 * stored for a connection saved without a key, so a probe has something to send.
 */
export const LOCAL_PLACEHOLDER_API_KEY = "local";

export function localVisionModelIds(): ReadonlySet<string> {
  return declaredVisionModelIds(LOCAL_VISION_MODELS_ENV);
}

const DEFAULT_BASE_URL = "http://127.0.0.1:3456/v1";
const DEFAULT_CONTEXT_WINDOW = 32_768;
const DEFAULT_MAX_TOKENS = 4_096;

/**
 * Hostname used to reach the host machine from inside a container.
 *
 * Mapped to `host-gateway` via `extra_hosts` in the compose files. Inside a
 * container `127.0.0.1`/`localhost` is the container's own loopback, so a
 * model server bound on the host is only reachable through this name.
 */
const HOST_GATEWAY_HOSTNAME = "host.docker.internal";

/** True when running inside a Linux/Docker container (the app's api/worker). */
function isDocker(): boolean {
  return existsSync("/.dockerenv") || existsSync("/run/.containerenv");
}

/**
 * Rewrites a loopback base URL to the host-gateway hostname when running inside
 * a container, so the fetch reaches the host's model server instead of the
 * container's own loopback interface (which has nothing on that port).
 *
 * Only the configured value is rewritten: a URL that already points at the host
 * gateway or a LAN address is left untouched. When not in Docker the value is
 * returned unchanged, preserving normal desktop behavior.
 */
function resolveLocalBaseUrl(rawValue: string): string {
  if (!isDocker()) return rawValue;
  try {
    const url = new URL(rawValue);
    if (url.hostname === "127.0.0.1" || url.hostname === "localhost") {
      url.hostname = HOST_GATEWAY_HOSTNAME;
      return url.toString();
    }
    return rawValue;
  } catch {
    // Malformed values are validated by the caller; do not mask that error.
    return rawValue;
  }
}

export function localBaseUrl(): string {
  const rawValue = process.env.RAKAZO_LOCAL_MODELS_URL?.trim() || DEFAULT_BASE_URL;
  const value = resolveLocalBaseUrl(rawValue);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("RAKAZO_LOCAL_MODELS_URL must be an absolute HTTP(S) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("RAKAZO_LOCAL_MODELS_URL must be an absolute HTTP(S) URL");
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

/** Comma-separated model ids exactly as the local server names them. */
function localModelIds(): string[] {
  return (process.env[LOCAL_MODELS_ENV] ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}

/**
 * The bearer token for the local endpoint.
 *
 * Keyless servers ignore this header, so the placeholder keeps them working.
 * An endpoint that does check it gets the operator's real token instead.
 */
function localApiKey(): string {
  return process.env[LOCAL_API_KEY_ENV]?.trim() || LOCAL_PLACEHOLDER_API_KEY;
}

function localModel(id: string): Model<"openai-completions"> {
  return {
    id,
    name: id,
    api: "openai-completions",
    provider: LOCAL_PROVIDER_ID,
    baseUrl: localBaseUrl(),
    reasoning: false,
    compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
    input: inputModalities(localVisionModelIds().has(id)),
    // Runs on the operator's own hardware, so there is nothing to bill.
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: tokenLimit("RAKAZO_LOCAL_CONTEXT_WINDOW", DEFAULT_CONTEXT_WINDOW),
    maxTokens: tokenLimit("RAKAZO_LOCAL_MAX_TOKENS", DEFAULT_MAX_TOKENS),
  };
}

export function localProvider(): Provider | undefined {
  const ids = localModelIds();
  // An unconfigured endpoint is still offered: its seed keeps the provider visible so
  // a user can probe it, instead of the whole provider vanishing until ops sets models.
  return createProvider({
    id: LOCAL_PROVIDER_ID,
    name: "Local (self-hosted endpoint)",
    baseUrl: localBaseUrl(),
    auth: {
      apiKey: {
        name: "Local model server",
        resolve: async () => ({
          auth: { apiKey: localApiKey(), baseUrl: localBaseUrl() },
          source: "local model server",
        }),
      },
    },
    models: (ids.length ? ids : [LOCAL_SEED_MODEL_ID]).map(localModel),
    api: openAICompletionsApi(),
  });
}

export function registerLocalProvider(models: MutableModels): MutableModels {
  const provider = localProvider();
  if (provider) models.setProvider(provider);
  return models;
}
