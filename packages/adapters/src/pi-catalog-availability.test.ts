import { describe, expect, it } from "vitest";
import {
  catalogModelAvailableForAuth,
  listAvailablePiCatalog,
  modelCredentialAuthKindFromPlaintext,
  OPENAI_CODEX_CHATGPT_SUBSCRIPTION_EXCLUDED_MODEL_IDS,
} from "./pi-catalog-availability.js";
import { listPiCatalog } from "./pi-models.js";
import { CHATGPT_OAUTH_PROVIDER } from "./pi-oauth.js";

describe("catalog availability by sign-in kind", () => {
  const spark = "gpt-5.3-codex-spark";

  it("excludes the subscription-only Codex model from the exclusion list", () => {
    expect(OPENAI_CODEX_CHATGPT_SUBSCRIPTION_EXCLUDED_MODEL_IDS.has(spark)).toBe(true);
    expect(catalogModelAvailableForAuth(CHATGPT_OAUTH_PROVIDER, spark, "oauth", "oauth")).toBe(
      false,
    );
  });

  it("lets a model-specific auth kind override the provider kind", () => {
    // The same model is reachable once its own slot is an API key rather than the subscription.
    expect(catalogModelAvailableForAuth(CHATGPT_OAUTH_PROVIDER, spark, "api_key", "oauth")).toBe(
      true,
    );
    // "disconnected" inherits the provider's offered auth, so the subscription still excludes it.
    expect(
      catalogModelAvailableForAuth(CHATGPT_OAUTH_PROVIDER, spark, "disconnected", "oauth"),
    ).toBe(false);
    expect(
      catalogModelAvailableForAuth(CHATGPT_OAUTH_PROVIDER, spark, "disconnected", "api-key"),
    ).toBe(true);
  });

  it("leaves every other provider's models available", () => {
    for (const provider of ["local", "openai-compatible", "openai"]) {
      expect(catalogModelAvailableForAuth(provider, spark, "oauth", "oauth")).toBe(true);
      expect(catalogModelAvailableForAuth(provider, spark, "disconnected", "oauth")).toBe(true);
    }
  });

  it("offers the whole managed catalog now that no subscription provider is shipped", () => {
    const catalog = listPiCatalog();
    // Nothing is filtered: the exclusion rule only ever applied to openai-codex,
    // which the managed catalog no longer ships.
    expect(listAvailablePiCatalog()).toEqual(catalog);
    expect(
      listAvailablePiCatalog(
        { [CHATGPT_OAUTH_PROVIDER]: "oauth" },
        { [CHATGPT_OAUTH_PROVIDER]: { [spark]: "oauth" } },
      ),
    ).toEqual(catalog);
    for (const entry of catalog) {
      expect(entry.provider === "local" || entry.provider === "openai-compatible").toBe(true);
    }
  });

  it("detects oauth credentials from stored JSON", () => {
    const oauth = JSON.stringify({
      type: "oauth",
      access: "access-token",
      refresh: "refresh-token",
      expires: Date.now() + 60_000,
    });
    expect(modelCredentialAuthKindFromPlaintext(oauth)).toBe("oauth");
    expect(modelCredentialAuthKindFromPlaintext("sk-test-api-key-12345678")).toBe("api_key");
  });

  it("does not treat corrupt stored credential JSON as an API key", () => {
    const corrupt = JSON.stringify({ kind: "oauth", credential: { type: "oauth" } });
    expect(() => modelCredentialAuthKindFromPlaintext(corrupt)).toThrow(/corrupt/);
  });
});
