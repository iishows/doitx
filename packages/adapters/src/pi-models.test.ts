import { MODEL_KEY_FORMAT_ERROR } from "@rakazo/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultCatalogModelId } from "./model-selection.js";
import { modelAcceptsImageInput } from "./model-vision.js";
import {
  catalogModelLabel,
  catalogModelServesAgents,
  catalogProviderProbeBaseUrl,
  hiddenCatalogModel,
  listPiCatalog,
  offeredCatalog,
  probeCatalogProviderModels,
  scriptedCatalogEntry,
  verifyCatalogProviderApiKey,
} from "./pi-models.js";
import { probeOpenAiCompatibleModels } from "./pi-openai-compatible-provider.js";
import { MODEL_CONNECT_TIMEOUT_MS } from "./pi-runtime-limits.js";

describe("catalog provider authentication", () => {
  it("refuses a key that cannot travel in a header without calling the provider", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(
      verifyCatalogProviderApiKey({ provider: "openrouter", apiKey: "sk-fixture-ключ" }, fetchImpl),
    ).rejects.toThrow(MODEL_KEY_FORMAT_ERROR);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("checks authentication before listing a public OpenRouter catalog", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json({ data: [{ id: "fixture-model" }] }),
    );
    await expect(
      probeCatalogProviderModels({ provider: "openrouter", apiKey: " fixture-key " }, fetchImpl),
    ).rejects.toThrow("This provider cannot be tested without saving.");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([401, 403])(
    "refuses rejected credentials (%i) without trusting the catalog",
    async (status) => {
      const fetchImpl = vi.fn<typeof fetch>(
        async () => new Response("private upstream details", { status }),
      );
      await expect(
        verifyCatalogProviderApiKey({ provider: "openrouter", apiKey: "fixture-key" }, fetchImpl),
      ).rejects.toThrow("API key was rejected by the provider.");
      expect(fetchImpl).toHaveBeenCalledOnce();
    },
  );

  it.each([302, 429, 503])(
    "keeps upstream failures (%i) distinct from invalid keys",
    async (status) => {
      await expect(
        verifyCatalogProviderApiKey(
          { provider: "openrouter", apiKey: "fixture-key" },
          async () => new Response("private upstream details", { status }),
        ),
      ).rejects.toThrow("Could not verify the API key. Try again.");
    },
  );

  it.each([
    ["deepseek", "https://api.deepseek.com/models", { Authorization: "Bearer fixture-key" }],
    [
      "google",
      "https://generativelanguage.googleapis.com/v1beta/models",
      { "x-goog-api-key": "fixture-key" },
    ],
  ])(
    "checks %s without calling a model or putting the key in the URL",
    async (provider, url, headers) => {
      const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({}));
      await verifyCatalogProviderApiKey({ provider, apiKey: " fixture-key " }, fetchImpl);
      expect(fetchImpl).toHaveBeenCalledWith(
        url,
        expect.objectContaining({ headers, redirect: "error" }),
      );
    },
  );

  it.each(["google", "deepseek"])("rejects unauthorized %s keys", async (provider) => {
    await expect(
      verifyCatalogProviderApiKey(
        { provider, apiKey: "fixture-key" },
        async () => new Response("private upstream details", { status: 401 }),
      ),
    ).rejects.toThrow("API key was rejected by the provider.");
  });

  it("recognizes Google's structured invalid-key response without exposing the body", async () => {
    await expect(
      verifyCatalogProviderApiKey({ provider: "google", apiKey: "fixture-key" }, async () =>
        Response.json(
          { error: { message: "private details", details: [{ reason: "API_KEY_INVALID" }] } },
          { status: 400 },
        ),
      ),
    ).rejects.toThrow("API key was rejected by the provider.");
  });

  it.each([
    "invalid JSON",
    JSON.stringify({ error: { details: [{ reason: "OTHER_REASON" }] } }),
    "x".repeat(4097),
  ])("does not label an unknown Google error as an invalid key", async (body) => {
    await expect(
      verifyCatalogProviderApiKey(
        { provider: "google", apiKey: "fixture-key" },
        async () => new Response(body, { status: 400 }),
      ),
    ).rejects.toThrow("Could not verify the API key. Try again.");
  });

  it("finishes a Google check safely when cancellation interrupts a partial error body", async () => {
    const controller = new AbortController();
    let waitingForBody: (() => void) | undefined;
    const bodyStarted = new Promise<void>((resolve) => {
      waitingForBody = resolve;
    });
    const result = verifyCatalogProviderApiKey(
      { provider: "google", apiKey: "fixture-key" },
      async (_url, init) =>
        new Response(
          new ReadableStream({
            start(body) {
              body.enqueue(new TextEncoder().encode('{"error":'));
              init?.signal?.addEventListener(
                "abort",
                () => body.error(new Error("private fixture-key details")),
                { once: true },
              );
              waitingForBody?.();
            },
          }),
          { status: 400 },
        ),
      controller.signal,
    );
    const assertion = expect(result).rejects.toThrow("Could not verify the API key. Try again.");
    await bodyStarted;
    controller.abort();
    await assertion;
  });

  it("cancels an oversized Google error without waiting for the stream to finish", async () => {
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream({
        start(body) {
          body.enqueue(new Uint8Array(4097));
        },
        cancel,
      }),
      { status: 400 },
    );
    await expect(
      verifyCatalogProviderApiKey(
        { provider: "google", apiKey: "fixture-key" },
        async () => response,
      ),
    ).rejects.toThrow("Could not verify the API key. Try again.");
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body?.locked).toBe(false);
  });

  it("bounds a stalled check and hides transport error details", async () => {
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    try {
      const result = verifyCatalogProviderApiKey(
        { provider: "openrouter", apiKey: "fixture-key" },
        async (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("fixture-key")));
          }),
      );
      const assertion = expect(result).rejects.toThrow("Could not verify the API key. Try again.");
      expect(timeout).toHaveBeenCalledWith(MODEL_CONNECT_TIMEOUT_MS);
      deadline.abort();
      await assertion;
    } finally {
      timeout.mockRestore();
    }
  });

  it("honors caller cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      verifyCatalogProviderApiKey(
        { provider: "openrouter", apiKey: "fixture-key" },
        async (_url, init) => {
          init?.signal?.throwIfAborted();
          throw new Error("must already be aborted");
        },
        controller.signal,
      ),
    ).rejects.toThrow("Could not verify the API key. Try again.");
  });

  it("adds no network requirement to other providers or local endpoints", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    for (const provider of ["openai-compatible", "local", "anthropic", "fixture-provider"]) {
      await verifyCatalogProviderApiKey({ provider, apiKey: "fixture-key" }, fetchImpl);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("Pi model catalog", () => {
  it("recommends no hosted provider now that only managed providers remain", () => {
    expect(listPiCatalog().filter((entry) => entry.recommended)).toEqual([]);
  });

  it("exposes only the managed local and OpenAI-compatible providers", () => {
    const catalog = listPiCatalog();
    const providers = new Set(catalog.map((entry) => entry.provider));
    expect(
      [...providers].every((provider) => provider === "local" || provider === "openai-compatible"),
    ).toBe(true);
    expect(providers.has("openai-compatible")).toBe(true);
    for (const removed of ["openrouter", "anthropic", "openai", "openai-codex", "azure"]) {
      expect(catalog.some((entry) => entry.provider === removed)).toBe(false);
    }
    expect(scriptedCatalogEntry.provider).toBe("scripted");
  });

  it("keeps the custom catalog independent of server model IDs", () => {
    const custom = listPiCatalog().filter((entry) => entry.provider === "openai-compatible");
    expect(custom).toHaveLength(1);
    expect(custom[0]).toMatchObject({ id: "custom", placeholder: true, reasoning: false });
  });

  it("leaves the custom connection's image support to its own setting", () => {
    const custom = listPiCatalog().find((entry) => entry.provider === "openai-compatible");
    expect(custom).toMatchObject({
      providerName: "OpenAI-compatible",
      auth: "api-key",
      authHint: "Custom server",
      subscription: false,
      billing: "Runs on a URL you control. Doitx does not pay for model usage.",
    });
    // The connection's own "Supports images" setting decides this one.
    expect(custom?.images).toBeUndefined();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("adds the local provider only once the operator configures models", async () => {
    expect(listPiCatalog().some((entry) => entry.provider === "local")).toBe(false);

    vi.stubEnv("RAKAZO_LOCAL_MODELS", "qwen3");
    vi.resetModules();
    const { listPiCatalog: listConfiguredCatalog } = await import("./pi-models.js");
    const local = listConfiguredCatalog().filter((entry) => entry.provider === "local");
    expect(local.map((entry) => entry.id)).toEqual(["qwen3"]);
    expect(local[0]).toMatchObject({
      providerName: "Local (Ollama / LM Studio)",
      auth: "api-key",
      subscription: false,
      billing:
        "Runs on infrastructure configured by the server operator. No model charges from Doitx.",
    });
  });

  it("lists local model ids exactly as the operator names them", async () => {
    vi.stubEnv("RAKAZO_LOCAL_MODELS", "deepseek-flash,DeepSeek-V4.1-Flash,Meta-Llama-3.3-70B");
    vi.resetModules();

    const { listPiCatalog: listConfiguredCatalog } = await import("./pi-models.js");
    const local = listConfiguredCatalog().filter((entry) => entry.provider === "local");
    const ids = local.map((entry) => entry.id);
    expect(ids).toContain("deepseek-flash");
    expect(ids).toContain("DeepSeek-V4.1-Flash");
    for (const entry of local) {
      expect(entry.id).toBe(entry.label);
      expect(entry.label.length).toBeGreaterThan(0);
    }
  });

  it("marks only the local models the operator declares as vision-capable", async () => {
    vi.stubEnv("RAKAZO_LOCAL_MODELS", "llava,qwen3");
    vi.stubEnv("RAKAZO_LOCAL_VISION_MODELS", "llava");
    vi.resetModules();

    const { listPiCatalog: listConfiguredCatalog } = await import("./pi-models.js");
    const local = listConfiguredCatalog().filter((entry) => entry.provider === "local");
    expect(local.find((entry) => entry.id === "llava")?.images).toBe(true);
    expect(local.find((entry) => entry.id === "qwen3")?.images).toBe(false);
  });

  it("leaves no managed provider with a pinned catalog probe", () => {
    for (const provider of ["local", "openai-compatible"]) {
      expect(catalogProviderProbeBaseUrl(provider)).toBeNull();
    }
    // Providers removed from the managed catalog are no longer probeable.
    for (const provider of ["openrouter", "openai", "groq", "anthropic"]) {
      expect(catalogProviderProbeBaseUrl(provider)).toBeNull();
      expect(listPiCatalog().some((entry) => entry.provider === provider)).toBe(false);
    }
    expect(listPiCatalog().some((entry) => entry.catalogProbe)).toBe(false);
  });

  it("keeps caller-supplied public endpoints gated", async () => {
    const previous = process.env.RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC;
    process.env.RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC = "0";
    try {
      await expect(
        probeOpenAiCompatibleModels(
          { baseUrl: "https://openrouter.ai/api/v1", apiKey: "sk-test-key" },
          async () => {
            throw new Error("user-supplied probe should be rejected before fetch");
          },
        ),
      ).rejects.toThrow(/Public model endpoints are disabled/);
    } finally {
      if (previous === undefined) delete process.env.RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC;
      else process.env.RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC = previous;
    }
  });

  it("rejects a custom-server model list over the probe cap", async () => {
    const ids = Array.from({ length: 5_000 }, (_, index) => {
      const suffix = String(index).padStart(4, "0");
      return `vendor/catalog-model-${suffix}-${"x".repeat(120)}`;
    });
    const payload = JSON.stringify({
      object: "list",
      data: ids.map((id) => ({ id, description: "x".repeat(512) })),
    });
    expect(Buffer.byteLength(payload)).toBeGreaterThan(2 * 1024 * 1024);
    expect(ids).toHaveLength(5_000);

    const fetchImpl = async () =>
      new Response(payload, {
        status: 200,
        headers: { "content-length": String(Buffer.byteLength(payload)) },
      });

    await expect(
      probeOpenAiCompatibleModels({ baseUrl: "http://127.0.0.1:8000/v1" }, fetchImpl, undefined, {
        allowPrivate: true,
      }),
    ).rejects.toThrow(/too large/i);
  });

  it("adds a configured OpenRouter model that is newer than the static catalog", async () => {
    vi.stubEnv("PI_DEFAULT_PROVIDER", " openrouter ");
    vi.stubEnv("PI_DEFAULT_MODEL", " rakazo-test/unknown-future-model ");
    vi.resetModules();

    const { listPiCatalog: listConfiguredCatalog } = await import("./pi-models.js");
    expect(listConfiguredCatalog()[0]).toMatchObject({
      provider: "openrouter",
      id: "rakazo-test/unknown-future-model",
      label: "rakazo-test/unknown-future-model",
    });
  });

  it("normalizes a PI_DEFAULT_MODEL id that ends in -latest", async () => {
    vi.stubEnv("PI_DEFAULT_PROVIDER", "openrouter");
    vi.stubEnv("PI_DEFAULT_MODEL", "foo-latest");
    vi.resetModules();

    const { listPiCatalog: listConfiguredCatalog } = await import("./pi-models.js");
    expect(listConfiguredCatalog()[0]).toMatchObject({
      provider: "openrouter",
      id: "foo-latest",
      label: "foo (auto-updates)",
    });
  });

  it("does not advertise a synthetic model for providers the runtime cannot synthesize", async () => {
    vi.stubEnv("PI_DEFAULT_PROVIDER", "anthropic");
    vi.stubEnv("PI_DEFAULT_MODEL", "future/unknown-model");
    vi.resetModules();

    const { listPiCatalog: listConfiguredCatalog } = await import("./pi-models.js");
    expect(
      listConfiguredCatalog().some(
        (entry) => entry.provider === "anthropic" && entry.id === "future/unknown-model",
      ),
    ).toBe(false);
  });

  it('never labels an older model "latest" and keeps aliases distinct from snapshots', () => {
    const providerModelIds = ["claude-opus-4-5", "claude-opus-4-5-20251101"];
    expect(catalogModelLabel("claude-opus-4-5", "Claude Opus 4.5 latest", providerModelIds)).toBe(
      "Claude Opus 4.5 (auto-updates)",
    );
    expect(
      catalogModelLabel("claude-opus-4-5-20251101", "Claude Opus 4.5 latest", providerModelIds),
    ).toBe("Claude Opus 4.5");
  });

});

describe("catalogModelLabel", () => {
  const providerModelIds = [
    "claude-opus-4-5",
    "claude-opus-4-5-20251101",
    "mistral-medium",
    "mistral-medium-2508",
    "mistral-small",
    "mistral-small-260401",
    "foo",
    "foo-preview",
  ];

  it.each([
    // Alias: the id ends in `latest`, or a dated sibling proves the undated id floats.
    ["claude-opus-4-5", "Claude Opus 4.5 (latest)", "Claude Opus 4.5 (auto-updates)"],
    ["mistral-medium", "Mistral Medium Latest", "Mistral Medium (auto-updates)"],
    ["mistral-small", "Mistral Small Latest", "Mistral Small (auto-updates)"],
    ["gemini-flash-latest", "Gemini Flash Latest", "Gemini Flash (auto-updates)"],
    ["foo-latest", "foo-latest", "foo (auto-updates)"],
    ["foo/latest", "foo/latest", "foo (auto-updates)"],
    ["qwen-max-latest", "Qwen Max Latest (Qwen3.8 Max)", "Qwen Max (auto-updates)"],
    // Pinned: `-preview` is its own model and a dated id is already a snapshot, so promise nothing.
    ["foo", "Foo Latest", "Foo"],
    ["claude-opus-4-5-20251101", "Claude Opus 4.5 (latest)", "Claude Opus 4.5"],
    // Untouched: no marker, no name, or nothing left once the marker goes.
    ["claude-opus-5", "Claude Opus 5", "Claude Opus 5"],
    ["some-model", undefined, "some-model"],
    ["latest", "latest", "latest"],
  ])("labels %s / %s as %s", (id, name, expected) => {
    expect(catalogModelLabel(id, name, providerModelIds)).toBe(expected);
  });
});

describe("models agents can run", () => {
  const free = { input: 0, output: 0 };
  const paid = { input: 1, output: 2 };

  it.each([
    // OpenRouter batch variants only exist on its batch endpoint.
    [{ provider: "openrouter", id: "fixture/model:batch", cost: paid }, false],
    [{ provider: "openrouter", id: "fixture/model", cost: paid }, true],
    // OpenRouter's own free models still answer API calls.
    [{ provider: "openrouter", id: "fixture/model:free", cost: free }, true],
    // OpenCode's free tier only answers inside the OpenCode app.
    [{ provider: "opencode", id: "fixture-free", cost: free }, false],
    [{ provider: "opencode", id: "fixture", cost: paid }, true],
    [{ provider: "opencode-go", id: "fixture-free", cost: free }, true],
    // Retired or integration-refused ids.
    [{ provider: "google", id: "gemini-2.5-flash", cost: paid }, false],
    [{ provider: "google", id: "gemini-3.8-flash", cost: paid }, true],
    [{ provider: "groq", id: "llama-3.1-8b-instant", cost: paid }, false],
    [{ provider: "github-copilot", id: "grok-4.5", cost: paid }, false],
  ])("judges %o as %s", (model, expected) => {
    expect(catalogModelServesAgents(model)).toBe(expected);
  });

  it("hides bundled models agents cannot run from the offered catalog", () => {
    const offered = offeredCatalog(listPiCatalog());
    const has = (provider: string, id: string) =>
      offered.some((entry) => entry.provider === provider && entry.id === id);
    expect(offered.some((entry) => entry.id.endsWith(":batch"))).toBe(false);
    expect(has("openrouter", "anthropic/claude-haiku-5.5")).toBe(true);
    expect(has("google", "gemini-2.5-flash")).toBe(false);
    expect(has("groq", "llama-3.1-8b-instant")).toBe(false);
    expect(has("opencode", "big-pickle")).toBe(false);
    expect(has("opencode", "claude-haiku-5-5")).toBe(true);
    // A hidden model stays a known catalog id, so saved choices keep running.
    expect(listPiCatalog().some((entry) => entry.id === "gemini-2.5-flash")).toBe(true);
  });

  it("keeps a hidden model the account already saved", () => {
    const entries = [
      { provider: "google", id: "gemini-2.5-flash" },
      { provider: "openrouter", id: "fixture/model:batch" },
    ];
    expect(offeredCatalog(entries, new Set(["google:gemini-2.5-flash"]))).toEqual([entries[0]]);
  });

  it("judges live ids the catalog does not bundle by their id", () => {
    expect(hiddenCatalogModel({ provider: "openrouter", id: "fixture/live:batch" })).toBe(true);
    expect(hiddenCatalogModel({ provider: "openrouter", id: "fixture/live" })).toBe(false);
  });

  it.each([
    ["google", "gemini-3.8-flash"],
    ["groq", "openai/gpt-oss-120b"],
    ["minimax", "MiniMax-M3"],
  ])("connects %s to %s when no model is chosen", (provider, model) => {
    expect(defaultCatalogModelId(provider, "fixture-api-key")).toBe(model);
    expect(
      listPiCatalog().find((entry) => entry.provider === provider && entry.id === model)
        ?.recommended,
    ).toBe(true);
  });
});
