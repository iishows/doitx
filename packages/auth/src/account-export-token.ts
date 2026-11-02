import { randomBytes } from "node:crypto";

/** Long enough for the browser to start the download it was issued for. */
export const ACCOUNT_EXPORT_TOKEN_MS = 60_000;

/** Stored hashed (see `verification.storeIdentifier`), so the table never holds a usable token. */
export const ACCOUNT_EXPORT_TOKEN_PREFIX = "account-export-";

/**
 * A separate namespace for the team-config archive. The prefix is what keeps the two flows from
 * accepting each other's tokens, so it must differ from the account prefix.
 */
export const TEAM_CONFIG_TOKEN_PREFIX = "team-config-";

type Verification = { value: string; expiresAt: Date };

async function issueExportToken(
  adapter: {
    createVerificationValue(data: Verification & { identifier: string }): Promise<unknown>;
  },
  prefix: string,
  value: string,
): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await adapter.createVerificationValue({
    identifier: `${prefix}${token}`,
    value,
    expiresAt: new Date(Date.now() + ACCOUNT_EXPORT_TOKEN_MS),
  });
  return token;
}

/** The stored value, or null. Consuming is atomic, so a token works once. */
async function consumeExportToken(
  adapter: { consumeVerificationValue(identifier: string): Promise<Verification | null> },
  prefix: string,
  token: string,
): Promise<string | null> {
  if (!token) return null;
  const stored = await adapter.consumeVerificationValue(`${prefix}${token}`);
  return stored && stored.expiresAt.getTime() > Date.now() ? stored.value : null;
}

/** The user the token was issued to. */
export function issueAccountExportToken(
  adapter: {
    createVerificationValue(data: Verification & { identifier: string }): Promise<unknown>;
  },
  userId: string,
): Promise<string> {
  return issueExportToken(adapter, ACCOUNT_EXPORT_TOKEN_PREFIX, userId);
}

export async function consumeAccountExportToken(
  adapter: { consumeVerificationValue(identifier: string): Promise<Verification | null> },
  token: string,
): Promise<string | null> {
  return consumeExportToken(adapter, ACCOUNT_EXPORT_TOKEN_PREFIX, token);
}

/**
 * The workspace a team-config download belongs to. It carries both ids because the download route
 * is reached with the token alone, so the token is the only thing that can say which space to read.
 */
export interface TeamConfigTokenScope {
  userId: string;
  spaceId: string;
}

export function issueTeamConfigToken(
  adapter: {
    createVerificationValue(data: Verification & { identifier: string }): Promise<unknown>;
  },
  scope: TeamConfigTokenScope,
): Promise<string> {
  return issueExportToken(adapter, TEAM_CONFIG_TOKEN_PREFIX, JSON.stringify(scope));
}

/** The scope the token was issued for, or null when it is expired, reused or malformed. */
export async function consumeTeamConfigToken(
  adapter: { consumeVerificationValue(identifier: string): Promise<Verification | null> },
  token: string,
): Promise<TeamConfigTokenScope | null> {
  const value = await consumeExportToken(adapter, TEAM_CONFIG_TOKEN_PREFIX, token);
  if (!value) return null;
  try {
    const scope: unknown = JSON.parse(value);
    if (
      typeof scope === "object" &&
      scope !== null &&
      typeof (scope as TeamConfigTokenScope).userId === "string" &&
      typeof (scope as TeamConfigTokenScope).spaceId === "string"
    ) {
      return scope as TeamConfigTokenScope;
    }
  } catch {
    // A malformed value is treated as no token rather than a crash.
  }
  return null;
}
