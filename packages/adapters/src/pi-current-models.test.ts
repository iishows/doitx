import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { listPiCatalog } from "./pi-models.js";
import { modelsForRequest } from "./pi-runtime.js";

/**
 * This file used to pin the vendor model data (Bedrock pricing, OpenCode
 * endpoints, Anthropic effort levels) that shipped with the upstream catalogue.
 * A deployment now runs on its own endpoint, so there is no vendor data to pin:
 * what matters is that none of it leaks back in and that the managed endpoint's
 * models resolve through the runtime.
 *
 * The catalog is memoized at module scope, so the env-declared cases below
 * re-import the modules after setting the environment.
 */
async function withLocalModels<T>(
  models: string,
  visionModels: string,
  fn: (mods: {
    catalog: () => ReturnType<typeof listPiCatalog>;
    resolve: typeof modelsForRequest;
  }) => T,
): Promise<T> {
  const previous = new Map(
    ["RAKAZO_LOCAL_MODELS", "RAKAZO_LOCAL_VISION_MODELS"].map(
      (key) => [key, process.env[key]] as const,
    ),
  );
  process.env.RAKAZO_LOCAL_MODELS = models;
  process.env.RAKAZO_LOCAL_VISION_MODELS = visionModels;
  vi.resetModules();
  try {
    const { listPiCatalog: catalog } = await import("./pi-models.js");
    const { modelsForRequest: resolve } = await import("./pi-runtime.js");
    return fn({ catalog, resolve });
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    vi.resetModules();
  }
}

describe("managed model compatibility", () => {
  const VENDOR_MODELS = [
    ["anthropic", "claude-sonnet-5-5"],
    ["opencode", "claude-haiku-5-5"],
    ["openai-codex", "gpt-6.1-sol"],
    ["amazon-bedrock", "in.anthropic.claude-haiku-4-5-20251001-v1:0"],
    ["amazon-bedrock", "us.openai.gpt-6.1-sol"],
  ] as const;

  it.each(VENDOR_MODELS)("no longer ships %s/%s", (provider, id) => {
    expect(listPiCatalog().some((entry) => entry.provider === provider && entry.id === id)).toBe(
      false,
    );
    expect(
      modelsForRequest(
        { model: { provider, id } } as Parameters<typeof modelsForRequest>[0],
        provider,
      ).getModel(provider, id),
    ).toBeUndefined();
  });

  it("resolves a configured local model with its declared efforts", async () => {
    await withLocalModels("fixture-vl-model", "fixture-vl-model", ({ catalog, resolve }) => {
      const model = resolve(
        { model: { provider: "local", id: "fixture-vl-model" } } as Parameters<typeof resolve>[0],
        "local",
      ).getModel("local", "fixture-vl-model");
      expect(model).toBeDefined();
      expect(getSupportedThinkingLevels(model!)).toEqual(["off"]);
      expect(model?.input).toContain("image");
      expect(
        catalog().find((entry) => entry.provider === "local" && entry.id === "fixture-vl-model")
          ?.thinkingLevels,
      ).toEqual(["off"]);
    });
  });

  it("keeps a local model text-only unless the operator declares vision", async () => {
    await withLocalModels("fixture-text-model", "", ({ resolve }) => {
      const model = resolve(
        { model: { provider: "local", id: "fixture-text-model" } } as Parameters<typeof resolve>[0],
        "local",
      ).getModel("local", "fixture-text-model");
      expect(model).toBeDefined();
      expect(model?.input).not.toContain("image");
    });
  });
});
