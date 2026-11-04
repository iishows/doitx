import { afterEach, describe, expect, it, vi } from "vitest";
import { createManagedModels } from "./pi-managed-models.js";
import { liveModelSibling } from "./pi-live-model.js";

/** A managed models collection with the local endpoint pointed at `url`. */
function managedAt(url: string) {
  vi.stubEnv("RAKAZO_LOCAL_MODELS", "qwen3");
  vi.stubEnv("RAKAZO_LOCAL_MODELS_URL", url);
  return createManagedModels();
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("liveModelSibling endpoint schemes", () => {
  it("resolves a sibling on the pinned local endpoint over plain http", () => {
    // The deployment reaches its own local server over loopback http, so a discovered
    // local model has to materialize from its sibling the same way an https one does.
    const models = managedAt("http://127.0.0.1:3456/v1");
    expect(liveModelSibling(models, "local", "llama-4")?.id).toBe("llama-4");
    // The desktop app's API runs in a container, where Docker names this host.
    const containerized = managedAt("http://host.docker.internal:3456/v1");
    expect(liveModelSibling(containerized, "local", "llama-4")?.id).toBe("llama-4");
  });

  it("resolves a sibling on the router's https endpoint", () => {
    const models = createManagedModels();
    expect(liveModelSibling(models, "doitx", "gpt-5.2")?.id).toBe("gpt-5.2");
  });

  it("refuses a cleartext endpoint that is not the pinned origin", () => {
    // A different port or a LAN address is a different server, so its models are not
    // inferred from a sibling the way the pinned local endpoint's are.
    expect(liveModelSibling(managedAt("http://127.0.0.1:11434/v1"), "local", "llama-4")).toBeUndefined();
    expect(liveModelSibling(managedAt("http://192.168.1.5:3456/v1"), "local", "llama-4")).toBeUndefined();
  });

  it("refuses an id that is not a chat model", () => {
    const models = managedAt("http://127.0.0.1:3456/v1");
    expect(liveModelSibling(models, "local", "text-embedding-3-small")).toBeUndefined();
  });

  it("resolves on exactly the endpoints the probe can reach", () => {
    // The two checks have to move together: whichever endpoint the probe reaches is
    // the one a discovered model can be materialized for.
    const pinned = managedAt("http://127.0.0.1:3456/v1");
    expect(liveModelSibling(pinned, "local", "llama-4")).toBeDefined();
    const moved = managedAt("http://127.0.0.1:9999/v1");
    expect(liveModelSibling(moved, "local", "llama-4")).toBeUndefined();
  });
});
