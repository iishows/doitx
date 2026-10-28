import type { Actor } from "@rakazo/contracts";
import { MODEL_KEY_REJECTED_ERROR, OPENAI_COMPATIBLE_PROVIDER_ID } from "@rakazo/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  firstModelConnectAnalytics,
  modelConnectErrorKind,
  modelConnectProperties,
} from "./model-connect-analytics.js";
import type { RouterDeps } from "./router.js";

const modelSetup = vi.hoisted(() => vi.fn());
vi.mock("./routes/shared.js", () => ({ modelSetup }));

const actor = { userId: "user-1", spaceId: "space-1" } as Actor;

describe("model connect analytics", () => {
  // The managed endpoint's models are declared through env, and only catalog
  // providers are reported, so declare one before the module reads the catalog.
  vi.stubEnv("RAKAZO_LOCAL_MODELS", "fixture-model");
  beforeEach(() => modelSetup.mockReset());

  it("sends catalog provider ids and never a compatible endpoint or unknown provider", () => {
    expect(modelConnectProperties("local", "api_key")).toEqual({
      method: "api_key",
      provider: "local",
    });
    expect(modelConnectProperties(OPENAI_COMPATIBLE_PROVIDER_ID, "api_key")).toEqual({
      method: "compatible",
    });
    expect(modelConnectProperties("https://private.example.test", "api_key")).toEqual({
      method: "api_key",
    });
    expect(modelConnectProperties(undefined, "oauth")).toEqual({ method: "oauth" });
  });

  it("reduces failures to a coarse kind", () => {
    expect(modelConnectErrorKind(new Error(MODEL_KEY_REJECTED_ERROR))).toBe("auth");
    expect(modelConnectErrorKind(new Error('429: {"error":{"message":"rate limit"}}'))).toBe(
      "rate",
    );
    expect(modelConnectErrorKind(new Error("Could not verify the API key. Try again."))).toBe(
      "other",
    );
    expect(modelConnectErrorKind("not an error")).toBe("other");
  });

  it("records only while the user has no usable model", async () => {
    const capture = vi.fn();
    const deps = { analytics: { capture, flush: async () => undefined } } as unknown as RouterDeps;

    modelSetup.mockResolvedValueOnce({ needsModel: false });
    (await firstModelConnectAnalytics(deps, actor, "api_key"))("local", {
      name: "model_connected",
    });
    expect(capture).not.toHaveBeenCalled();

    modelSetup.mockRejectedValueOnce(new Error("db unavailable"));
    (await firstModelConnectAnalytics(deps, actor, "api_key"))("local", {
      name: "model_connected",
    });
    expect(capture).not.toHaveBeenCalled();

    modelSetup.mockResolvedValueOnce({ needsModel: true });
    const record = await firstModelConnectAnalytics(deps, actor, "api_key");
    record("local", { name: "model_connect_started" });
    record("local", {
      name: "model_connect_failed",
      error: new Error(`${MODEL_KEY_REJECTED_ERROR} sk-private`),
    });
    expect(capture.mock.calls).toEqual([
      ["user-1", { name: "model_connect_started", method: "api_key", provider: "local" }],
      [
        "user-1",
        { name: "model_connect_failed", method: "api_key", provider: "local", errorKind: "other" },
      ],
    ]);
    expect(JSON.stringify(capture.mock.calls)).not.toContain("sk-private");
  });
});
