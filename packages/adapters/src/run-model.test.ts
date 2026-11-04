import { SecretStoreUnavailableError } from "@rakazo/adapter-kit";
import { MISSING_MODEL_RUN_ERROR } from "@rakazo/core";
import { describe, expect, it, vi } from "vitest";
import { loadModelCredential } from "./run-model.js";

const secret = { id: "secret-1", ciphertext: "v2:ciphertext" };

describe("loadModelCredential", () => {
  it("reads the ciphertext with its row id, which the AAD covers", async () => {
    const load = vi.fn(async () => "api-key");

    await expect(loadModelCredential({ load }, secret)).resolves.toBe("api-key");
    expect(load).toHaveBeenCalledWith(secret.ciphertext, secret.id);
  });

  it("keeps a store outage retryable", async () => {
    const load = vi.fn(async () => {
      throw new SecretStoreUnavailableError();
    });

    await expect(loadModelCredential({ load }, secret)).rejects.toBeInstanceOf(
      SecretStoreUnavailableError,
    );
  });

  it("turns a cipher failure into the connect-a-model error instead of repeating it", async () => {
    const load = vi.fn(async () => {
      throw new Error("Unsupported state or unable to authenticate data");
    });

    await expect(loadModelCredential({ load }, secret)).rejects.toMatchObject({
      name: "UnavailableModelForAuthError",
      message: MISSING_MODEL_RUN_ERROR,
    });
  });
});
