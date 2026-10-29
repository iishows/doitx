import { afterEach, describe, expect, it, vi } from "vitest";
import { builtinAgentTools } from "./builtin-tools.js";
import {
  filterImageReturningComputerTools,
  IMAGE_RETURNING_COMPUTER_TOOLS,
  knownModelImageInput,
  modelAcceptsImageInput,
  modelIdSupportsImages,
  resolveModelRefForVisionCheck,
  updateModelImageCapabilities,
} from "./model-vision.js";
import { listAvailablePiCatalog } from "./pi-catalog-availability.js";
import type { CodexCatalogSpaceAuth } from "./pi-codex-catalog.js";
import { applyCodexLiveCatalog, parseCodexCatalog } from "./pi-codex-catalog.js";
import { liveCatalogEntry } from "./pi-live-catalog.js";
import { CHATGPT_OAUTH_PROVIDER } from "./pi-oauth.js";
import { resolveRuntimeModel } from "./pi-runtime-models.js";

const LOCAL_MODELS_ENV = "RAKAZO_LOCAL_MODELS";
const LOCAL_VISION_ENV = "RAKAZO_LOCAL_VISION_MODELS";

/**
 * The vision gate memoizes its catalog at module scope, so each case has to
 * start from a fresh module graph or it would read the previous case's env.
 * The deployment's models are declared through RAKAZO_LOCAL_MODELS now that no
 * vendor catalog ships with the app.
 */
async function withLocalModels<T>(
  models: string,
  visionModels: string,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = new Map(
    [LOCAL_MODELS_ENV, LOCAL_VISION_ENV].map((k) => [k, process.env[k]] as const),
  );
  process.env[LOCAL_MODELS_ENV] = models;
  process.env[LOCAL_VISION_ENV] = visionModels;
  vi.resetModules();
  try {
    return await fn();
  } finally {
    for (const [k, v] of previous) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    vi.resetModules();
  }
}

describe("model vision gating for computer tools", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("treats declared text-only models as unable to see", async () => {
    await withLocalModels("some-text-model,some-vl-model", "some-vl-model", async () => {
      const { modelAcceptsImageInput: accepts } = await import("./model-vision.js");
      expect(accepts("local", "some-text-model")).toBe(false);
    });
  });

  it("treats declared vision models as able to see", async () => {
    await withLocalModels("some-text-model,some-vl-model", "some-vl-model", async () => {
      const { modelAcceptsImageInput: accepts } = await import("./model-vision.js");
      expect(accepts("local", "some-vl-model")).toBe(true);
    });
  });

  it("sees models the runtime adds to the deployment catalog", async () => {
    await withLocalModels("runtime-vl-model", "runtime-vl-model", async () => {
      const { modelAcceptsImageInput: accepts } = await import("./model-vision.js");
      const { resolveRuntimeModel: resolve } = await import("./pi-runtime-models.js");
      expect(resolve({ provider: "local", id: "runtime-vl-model" }).model?.input).toContain(
        "image",
      );
      expect(accepts("local", "runtime-vl-model")).toBe(true);
    });
  });

  it.each([
    ["local", "declared-vl-model", "declared-vl-model", true],
    ["local", "undeclared-vl-model", "declared-vl-model", false],
  ])(
    "agrees with listing and execution for %s/%s",
    (provider, id, declaredVision, images) => {
      return withLocalModels(`${id},${declaredVision}`, declaredVision, async () => {
        const { resolveRuntimeModel: resolve } = await import("./pi-runtime-models.js");
        const { modelAcceptsImageInput: accepts } = await import("./model-vision.js");
        const { filterImageReturningComputerTools: filterImageTools } = await import(
          "./model-vision.js"
        );
        expect(resolve({ provider, id }).model?.input.includes("image")).toBe(images);
        expect(accepts(provider, id)).toBe(images);
        const tools = filterImageTools(builtinAgentTools, accepts(provider, id));
        expect(tools.some((tool) => tool.name === "computer_observe")).toBe(images);
      });
    },
  );

  it("resolves the scripted placeholder like Pi before checking vision", () => {
    vi.stubEnv("PI_DEFAULT_MODEL", "");
    expect(resolveModelRefForVisionCheck("scripted", "scripted")).toEqual({
      provider: "local",
      id: "openai/gpt-6-luna",
    });

    vi.stubEnv("PI_DEFAULT_MODEL", "some-vl-model");
    expect(resolveModelRefForVisionCheck("scripted", "scripted")).toEqual({
      provider: "local",
      id: "some-vl-model",
    });
  });

  it("follows the account catalog for a live Codex slug outside its sibling family", () => {
    const id = "gpt-6.1-terra";
    const provider = CHATGPT_OAUTH_PROVIDER;
    const auth: CodexCatalogSpaceAuth = {
      byProvider: { [provider]: "oauth" },
      byModel: {},
      secretIdByProvider: { [provider]: "secret-a" },
      secretIdByModel: {},
    };
    const base = listAvailablePiCatalog(auth.byProvider, auth.byModel);
    expect(liveCatalogEntry(provider, id)?.images).toBe(false);
    expect(modelAcceptsImageInput(provider, id)).toBe(false);
    expect(resolveRuntimeModel({ provider, id }).model?.input).toEqual(["text"]);

    for (const supportsImages of [true, false]) {
      const inputModalities = supportsImages ? ["text", "image"] : ["text"];
      const parsed = parseCodexCatalog({
        models: [
          {
            slug: "gpt-6.1-sol",
            visibility: "list",
            supported_in_api: true,
            input_modalities: ["text", "image"],
          },
          {
            slug: id,
            visibility: "list",
            supported_in_api: true,
            input_modalities: inputModalities,
          },
        ],
      });
      const entry = applyCodexLiveCatalog(base, auth, new Map([["secret-a", parsed ?? []]])).find(
        (item) => item.provider === provider && item.id === id,
      );
      expect(entry?.images).toBe(supportsImages);
      expect(modelAcceptsImageInput(provider, id, entry?.images)).toBe(supportsImages);
      expect(
        resolveRuntimeModel({ provider, id, acceptsImages: entry?.images }).model?.input.includes(
          "image",
        ),
      ).toBe(supportsImages);
      const names = filterImageReturningComputerTools(
        builtinAgentTools,
        modelAcceptsImageInput(provider, id, entry?.images),
      ).map((tool) => tool.name);
      for (const name of IMAGE_RETURNING_COMPUTER_TOOLS) {
        expect(names.includes(name)).toBe(supportsImages);
      }
    }
  });

  it("strips screenshot tools when a bundled Codex model is text-only in the account list", () => {
    const provider = CHATGPT_OAUTH_PROVIDER;
    const id = "gpt-6.1-sol";
    expect(modelAcceptsImageInput(provider, id)).toBe(true);
    expect(modelAcceptsImageInput(provider, id, false)).toBe(false);
    expect(resolveRuntimeModel({ provider, id, acceptsImages: false }).model?.input).toEqual([
      "text",
    ]);
    const names = filterImageReturningComputerTools(
      builtinAgentTools,
      modelAcceptsImageInput(provider, id, false),
    ).map((tool) => tool.name);
    for (const name of IMAGE_RETURNING_COMPUTER_TOOLS) {
      expect(names).not.toContain(name);
    }
    expect(names).toContain("shell");
  });

  it("treats unknown models as text-only", () => {
    expect(modelAcceptsImageInput("local", "rakazo-test/unknown-future-model")).toBe(false);
  });

  it("keeps explicit image capability scoped to the selected model", () => {
    const enabled = updateModelImageCapabilities(
      [" vision-model ", "text-model"],
      "text-model",
      false,
    );
    expect(enabled).toEqual(["vision-model"]);
    expect(modelIdSupportsImages(enabled, "vision-model")).toBe(true);
    expect(modelIdSupportsImages(enabled, "text-model")).toBe(false);
  });

  it("omits image-returning computer tools for text-only models", () => {
    const names = filterImageReturningComputerTools(builtinAgentTools, false).map(
      (tool) => tool.name,
    );
    for (const name of IMAGE_RETURNING_COMPUTER_TOOLS) {
      expect(names).not.toContain(name);
    }
    expect(names).toContain("shell");
    expect(names).toContain("list_files");
  });

  it("keeps image-returning computer tools for vision models", () => {
    const names = filterImageReturningComputerTools(builtinAgentTools, true).map(
      (tool) => tool.name,
    );
    expect(names).toEqual(builtinAgentTools.map((tool) => tool.name));
    expect(names).toContain("computer_observe");
    expect(names).toContain("computer_act");
  });
});

describe("known attachment input capability", () => {
  it("keeps catalogue misses distinct from known text-only and image models", () => {
    expect(knownModelImageInput("openrouter", "fixture/future-model")).toBeUndefined();
    expect(knownModelImageInput("openrouter", "deepseek/deepseek-v4-pro")).toBe(false);
    expect(knownModelImageInput("openrouter", "openai/gpt-4o")).toBe(true);
    expect(knownModelImageInput("openai-compatible", "openai/gpt-4o")).toBeUndefined();
  });
});
