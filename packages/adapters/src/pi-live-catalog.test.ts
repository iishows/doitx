import { afterEach, describe, expect, it, vi } from "vitest";
import { DOITX_PROVIDER_ID } from "./pi-doitx-provider.js";
import {
  applyProviderLiveCatalog,
  liveCatalogEntry,
  ProviderCatalogCache,
  providerLiveCatalogsForSpace,
  trustedProviderModels,
} from "./pi-live-catalog.js";
import { LOCAL_PROVIDER_ID, LOCAL_SEED_MODEL_ID } from "./pi-local-provider.js";
import { listPiCatalog } from "./pi-models.js";
import { OPENAI_COMPATIBLE_PROVIDER_ID } from "./pi-openai-compatible-provider.js";

/** A provider no longer shipped in the catalog: it has no probe and no bundled models. */
const provider = "openai";
const base = listPiCatalog();
const credential = {
  provider,
  secretId: "secret-test",
  version: "version-1",
  apiKey: async () => "fake-key-never-in-cache-key",
};
const auth = {
  byProvider: { openai: "api_key" as const },
  byModel: {},
  secretIdByProvider: { openai: credential.secretId },
};
const ids = ["gpt-6-luna", "gpt-6-sol"];
const merge = (live: string[], selected = new Set<string>()) =>
  applyProviderLiveCatalog(base, auth, new Map([[credential.secretId, live]]), selected);

/** The two managed providers, and a credential per provider for the merge below. */
const liveAuth = {
  byProvider: { [DOITX_PROVIDER_ID]: "api_key" as const, [LOCAL_PROVIDER_ID]: "api_key" as const },
  byModel: {},
  secretIdByProvider: {
    [DOITX_PROVIDER_ID]: "router-secret",
    [LOCAL_PROVIDER_ID]: "local-secret",
  },
};
const mergeProvider = (target: string, secretId: string, live: string[]) =>
  applyProviderLiveCatalog(base, liveAuth, new Map([[secretId, live]]))
    .filter((entry) => entry.provider === target)
    .map((entry) => entry.id);
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

/**
 * The router and the local endpoint both list their models at run time, so both carry
 * a pinned probe URL and merge whatever that probe returns. A provider the catalog no
 * longer ships has none of that: nothing probes, merges, or invents models for it.
 */
describe("live catalog serves the managed providers", () => {
  it("pins a registry probe on the router and the local endpoint", () => {
    for (const entry of base) {
      const managed = entry.provider === DOITX_PROVIDER_ID || entry.provider === LOCAL_PROVIDER_ID;
      if (managed) expect(entry.catalogProbe).toBe(true);
      else expect(entry.catalogProbe).toBeUndefined();
    }
  });

  it("merges nothing into a provider that has no pinned probe", () => {
    expect(merge(ids)).toEqual(base);
    expect(merge(ids, new Set([`${provider}:${ids[0]}`]))).toEqual(base);
  });

  it("adds no live-only model a sibling could imply", () => {
    const withUnknown = merge([...ids, "gpt-future-chat"]);
    expect(withUnknown.some((entry) => entry.id === "gpt-future-chat")).toBe(false);
    expect(merge(["gpt-future-chat"])).toEqual(base);
  });

  it("treats a non-empty live listing as trusted when no models are bundled", () => {
    // Trust asks for a quarter of the bundled ids to match. A provider whose only
    // bundled entry is a placeholder has a threshold of zero, so any non-empty
    // listing passes — the placeholder is a stand-in, not a model to match against.
    expect(trustedProviderModels(provider, ids)).toBe(true);
    expect(trustedProviderModels(provider, [])).toBe(false);
    expect(trustedProviderModels(OPENAI_COMPATIBLE_PROVIDER_ID, [])).toBe(false);
    expect(trustedProviderModels(DOITX_PROVIDER_ID, ["gpt-5.2"])).toBe(true);
    expect(trustedProviderModels(LOCAL_PROVIDER_ID, ["qwen3"])).toBe(true);
  });

  it("resolves no live-only entry for a provider without a pinned probe", () => {
    expect(liveCatalogEntry(provider, "gpt-future-chat")).toBeUndefined();
  });

  it("merges the router's live models and drops its placeholder seed", () => {
    expect(mergeProvider(DOITX_PROVIDER_ID, "router-secret", ["gpt-5.2", "claude-opus-5"])).toEqual(
      ["claude-opus-5", "gpt-5.2"],
    );
  });

  it("merges the local endpoint's live models over plain http", () => {
    expect(mergeProvider(LOCAL_PROVIDER_ID, "local-secret", ["qwen3", "llama-4"])).toEqual([
      "llama-4",
      "qwen3",
    ]);
  });

  it("keeps the placeholder seed while a provider is unprobed", () => {
    expect(mergeProvider(DOITX_PROVIDER_ID, "router-secret", [])).toEqual(["doitx-router"]);
    expect(mergeProvider(LOCAL_PROVIDER_ID, "local-secret", [])).toEqual([LOCAL_SEED_MODEL_ID]);
  });

  it("lists the local endpoint's models from a connection saved without a key", async () => {
    const seen: Array<{ provider: string; apiKey: string }> = [];
    const cache = new ProviderCatalogCache({
      enabled: true,
      probe: async (input) => {
        seen.push(input);
        return ["qwen3", "llama-4"];
      },
    });
    const catalogs = await providerLiveCatalogsForSpace(
      {
        secret: {
          findMany: async () => [{ id: "local-secret", ciphertext: "stored-ciphertext" }],
        },
      } as never,
      { load: async () => JSON.stringify({ kind: "api_key", key: "local" }) },
      { userId: "u", spaceId: "w" },
      liveAuth,
      cache,
    );
    // A keyless connect stores the endpoint's placeholder token, so the probe still sends
    // a bearer and the listing is what the catalog then offers.
    expect(seen).toEqual([{ provider: LOCAL_PROVIDER_ID, apiKey: "local" }]);
    expect(
      applyProviderLiveCatalog(base, liveAuth, catalogs)
        .filter((e) => e.provider === LOCAL_PROVIDER_ID)
        .map((e) => e.id),
    ).toEqual(["llama-4", "qwen3"]);
  });

  it("consults no credential when collecting per-space live catalogs", async () => {
    const cache = new ProviderCatalogCache({ enabled: true });
    const load = vi.fn(async () => "secret");
    const catalogs = await providerLiveCatalogsForSpace(
      { userModelCredential: { findMany: vi.fn(async () => []) } } as never,
      { load },
      { userId: "u", spaceId: "w" },
      auth,
      cache,
    );
    expect(catalogs.size).toBe(0);
    expect(load).not.toHaveBeenCalled();
  });
});

describe("ProviderCatalogCache", () => {
  it("returns undefined for a provider without a pinned probe", async () => {
    const probe = vi.fn(async () => ids);
    const cache = new ProviderCatalogCache({ enabled: true, probe });
    expect(await cache.read(credential)).toBeUndefined();
    expect(
      await cache.read({ ...credential, provider: OPENAI_COMPATIBLE_PROVIDER_ID }),
    ).toBeUndefined();
    expect(probe).not.toHaveBeenCalled();
  });

  it("probes a managed provider that has a pinned probe", async () => {
    const seen: string[] = [];
    const probe = vi.fn(async (input: { provider: string }) => {
      seen.push(input.provider);
      return ids;
    });
    const cache = new ProviderCatalogCache({ enabled: true, probe });
    expect(await cache.read({ ...credential, provider: LOCAL_PROVIDER_ID })).toEqual(ids);
    expect(seen).toEqual([LOCAL_PROVIDER_ID]);
  });

  it("is inert while the catalog switch is off", async () => {
    vi.stubEnv("RAKAZO_LIVE_MODEL_CATALOG", "off");
    const probe = vi.fn(async () => ids);
    const cache = new ProviderCatalogCache({ probe });
    expect(await cache.read(credential)).toBeUndefined();
    expect(probe).not.toHaveBeenCalled();
  });
});
