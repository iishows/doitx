import { describe, expect, it } from "vitest";

import {
  ACCOUNT_EXPORT_TOKEN_MS,
  consumeAccountExportToken,
  consumeTeamConfigToken,
  issueAccountExportToken,
  issueTeamConfigToken,
} from "./account-export-token.js";

/**
 * A stand-in for the better-auth verification store: single-use, expiry-aware, keyed by identifier.
 * The real adapter hashes the identifier, which is orthogonal to what these tests check.
 */
function memoryAdapter() {
  const rows = new Map<string, { value: string; expiresAt: Date }>();
  return {
    async createVerificationValue(data: {
      identifier: string;
      value: string;
      expiresAt: Date;
    }): Promise<unknown> {
      rows.set(data.identifier, { value: data.value, expiresAt: data.expiresAt });
      return data;
    },
    async consumeVerificationValue(identifier: string) {
      const row = rows.get(identifier) ?? null;
      rows.delete(identifier);
      return row;
    },
    size: () => rows.size,
  };
}

describe("team-config token", () => {
  it("round-trips the user and space scope", async () => {
    const adapter = memoryAdapter();
    const token = await issueTeamConfigToken(adapter, { userId: "user-1", spaceId: "space-1" });

    expect(await consumeTeamConfigToken(adapter, token)).toEqual({
      userId: "user-1",
      spaceId: "space-1",
    });
  });

  it("is single use", async () => {
    const adapter = memoryAdapter();
    const token = await issueTeamConfigToken(adapter, { userId: "user-1", spaceId: "space-1" });

    expect(await consumeTeamConfigToken(adapter, token)).not.toBeNull();
    expect(await consumeTeamConfigToken(adapter, token)).toBeNull();
  });

  it("rejects an empty or unknown token", async () => {
    const adapter = memoryAdapter();
    expect(await consumeTeamConfigToken(adapter, "")).toBeNull();
    expect(await consumeTeamConfigToken(adapter, "not-a-real-token")).toBeNull();
  });

  it("rejects an expired token", async () => {
    const adapter = memoryAdapter();
    const token = await issueTeamConfigToken(adapter, { userId: "user-1", spaceId: "space-1" });

    // The token is good for 60s; read it back with the clock past that window.
    const realNow = Date.now;
    Date.now = () => realNow() + ACCOUNT_EXPORT_TOKEN_MS + 1_000;
    try {
      expect(await consumeTeamConfigToken(adapter, token)).toBeNull();
    } finally {
      Date.now = realNow;
    }
  });

  it("does not accept an account-export token", async () => {
    const adapter = memoryAdapter();
    const accountToken = await issueAccountExportToken(adapter, "user-1");

    expect(await consumeTeamConfigToken(adapter, accountToken)).toBeNull();
  });

  it("does not accept a team-config token as an account-export token", async () => {
    const adapter = memoryAdapter();
    const teamToken = await issueTeamConfigToken(adapter, { userId: "user-1", spaceId: "space-1" });

    expect(await consumeAccountExportToken(adapter, teamToken)).toBeNull();
  });

  it("rejects a stored value that is not a scope object", async () => {
    const adapter = memoryAdapter();
    // A collision in the namespace should not be read as a scope.
    await adapter.createVerificationValue({
      identifier: "team-config-bogus",
      value: JSON.stringify("just-a-string"),
      expiresAt: new Date(Date.now() + ACCOUNT_EXPORT_TOKEN_MS),
    });

    expect(await consumeTeamConfigToken(adapter, "bogus")).toBeNull();
  });
});
