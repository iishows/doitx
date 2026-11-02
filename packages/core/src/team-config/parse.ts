import {
  TEAM_CONFIG_BOTS_DIR,
  TEAM_CONFIG_FORMAT,
  TEAM_CONFIG_MANIFEST_PATH,
  TEAM_CONFIG_VERSION,
  type TeamConfigBot,
  TeamConfigBotSchema,
  type TeamConfigFile,
  type TeamConfigManifest,
  TeamConfigManifestSchema,
} from "@rakazo/contracts";

/**
 * What a team-config archive failed to load. `version` is a *newer* archive than this build knows;
 * `format` is a zip that is not one of ours at all. They are separate so the UI can say which.
 */
export type TeamConfigParseErrorReason =
  | "not_an_archive"
  | "format"
  | "version"
  | "malformed"
  | "missing_bot";

export class TeamConfigParseError extends Error {
  readonly reason: TeamConfigParseErrorReason;

  constructor(reason: TeamConfigParseErrorReason, message: string) {
    super(message);
    this.name = "TeamConfigParseError";
    this.reason = reason;
  }
}

export interface ParsedTeamConfig {
  manifest: TeamConfigManifest;
  /** Keyed by the manifest's bot key, so a bot body without a manifest entry is unreachable. */
  bots: Map<string, TeamConfigBot>;
}

function textOf(files: TeamConfigFile[], path: string): string | null {
  return files.find((file) => file.path === path)?.content ?? null;
}

/**
 * Reads the manifest and every bot body out of an already-opened archive.
 *
 * The manifest is authoritative: a bot file is only read when the manifest lists its key, so an
 * archive cannot smuggle in a bot the user never saw in the preview. Nothing here trusts the file
 * contents — each body is validated against the same strict schema the exporter writes.
 */
export function parseTeamConfig(files: TeamConfigFile[]): ParsedTeamConfig {
  const manifestText = textOf(files, TEAM_CONFIG_MANIFEST_PATH);
  if (manifestText === null) {
    throw new TeamConfigParseError("not_an_archive", "This file has no manifest.");
  }

  let raw: unknown;
  try {
    raw = JSON.parse(manifestText);
  } catch {
    throw new TeamConfigParseError("malformed", "The manifest is not valid JSON.");
  }

  // Check the tag before the full parse so a foreign zip is named honestly rather than "malformed".
  if (
    typeof raw !== "object" ||
    raw === null ||
    (raw as { format?: unknown }).format !== TEAM_CONFIG_FORMAT
  ) {
    throw new TeamConfigParseError("format", "This is not a workspace export.");
  }
  const version = (raw as { version?: unknown }).version;
  if (typeof version === "number" && version > TEAM_CONFIG_VERSION) {
    throw new TeamConfigParseError(
      "version",
      "This export was made by a newer version of the app.",
    );
  }

  const parsed = TeamConfigManifestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new TeamConfigParseError("malformed", "The manifest is incomplete.");
  }
  const manifest = parsed.data;

  const bots = new Map<string, TeamConfigBot>();
  for (const entry of manifest.bots) {
    const bodyText = textOf(files, `${TEAM_CONFIG_BOTS_DIR}/${encodeURIComponent(entry.key)}.json`);
    if (bodyText === null) {
      throw new TeamConfigParseError("missing_bot", `The file for "${entry.name}" is missing.`);
    }
    let bodyRaw: unknown;
    try {
      bodyRaw = JSON.parse(bodyText);
    } catch {
      throw new TeamConfigParseError(
        "malformed",
        `The file for "${entry.name}" is not valid JSON.`,
      );
    }
    const body = TeamConfigBotSchema.safeParse(bodyRaw);
    if (!body.success) {
      throw new TeamConfigParseError("malformed", `The settings for "${entry.name}" are invalid.`);
    }
    // The manifest key wins, so a body cannot claim to be a different bot than the preview showed.
    bots.set(entry.key, { ...body.data, key: entry.key });
  }

  return { manifest, bots };
}
