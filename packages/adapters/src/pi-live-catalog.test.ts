import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyProviderLiveCatalog,
  liveCatalogEntry,
  ProviderCatalogCache,
  providerLiveCatalogsForSpace,
  trustedProviderModels,
} from "./pi-live-catalog.js";
import { listPiCatalog } from "./pi-models.js";
import { OPENAI_COMPATIBLE_PROVIDER_ID } from "./pi-openai-compatible-provider.js";

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
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

/**
 * The live catalog only ever applied to a provider with a pinned registry probe
 * URL. Those came from the vendor catalogue the app no longer ships, so the
 * managed providers (local, openai-compatible) deliberately have none: their
 * endpoint is the operator's or the user's own. What is left to pin is that the
 * seam is closed — nothing probes, merges or invents models for them.
 */
describe("live catalog is closed for the managed providers", () => {
  it("ships no provider with a pinned registry probe", () => {
    for (const entry of base) {
      expect(entry.catalogProbe).toBeUndefined();
    }
  });

  it("merges nothing into a managed provider", () => {
    expect(merge(ids)).toEqual(base);
    expect(merge(ids, new Set([`${provider}:${ids[0]}`]))).toEqual(base);
  });

  it("adds no live-only model a sibling could imply", () => {
    const withUnknown = merge([...ids, "gpt-future-chat"]);
    expect(withUnknown.some((entry) => entry.id === "gpt-future-chat")).toBe(false);
    expect(merge(["gpt-future-chat"])).toEqual(base);
  });

  it("treats a non-empty live listing as trusted when no models are bundled", () => {
    // Trust asks for a quarter of the bundled ids to match. A provider with no
    // bundled models has a threshold of zero, so any non-empty listing passes —
    // harmless here, because the probe gate above is what keeps the seam closed.
    expect(trustedProviderModels(provider, ids)).toBe(true);
    expect(trustedProviderModels(provider, [])).toBe(false);
    expect(trustedProviderModels(OPENAI_COMPATIBLE_PROVIDER_ID, [])).toBe(false);
  });

  it("resolves no live-only entry for a managed provider", () => {
    expect(liveCatalogEntry(provider, "gpt-future-chat")).toBeUndefined();
    expect(liveCatalogEntry("local", "some-unlisted-model")).toBeUndefined();
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
  // The cache itself still works; it is simply never reached for a managed
  // provider because none has a pinned probe URL.
  it("returns undefined for a provider without a pinned probe", async () => {
    const probe = vi.fn(async () => ids);
    const cache = new ProviderCatalogCache({ enabled: true, probe });
    expect(await cache.read(credential)).toBeUndefined();
    expect(await cache.read({ ...credential, provider: "local" })).toBeUndefined();
    expect(
      await cache.read({ ...credential, provider: OPENAI_COMPATIBLE_PROVIDER_ID }),
    ).toBeUndefined();
    expect(probe).not.toHaveBeenCalled();
  });

  it("is inert while the catalog switch is off", async () => {
    vi.stubEnv("RAKAZO_LIVE_MODEL_CATALOG", "off");
    const probe = vi.fn(async () => ids);
    const cache = new ProviderCatalogCache({ probe });
    expect(await cache.read(credential)).toBeUndefined();
    expect(probe).not.toHaveBeenCalled();
  });
});
