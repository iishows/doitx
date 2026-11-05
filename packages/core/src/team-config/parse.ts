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
  TeamConfigManifestV2Schema,
  TeamConfigManifestV3Schema,
  type TeamConfigSkill,
  teamConfigSkillPath,
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
  | "missing_bot"
  | "missing_skill";

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
  /** Keyed the same way; the body is read from its own file (or inlined, for a version 2 archive). */
  skills: Map<string, TeamConfigSkill>;
}

function textOf(files: TeamConfigFile[], path: string): string | null {
  return files.find((file) => file.path === path)?.content ?? null;
}

/**
 * Reads the manifest, every bot body and every skill body out of an already-opened archive.
 *
 * The manifest is authoritative: a body file is only read when the manifest lists its key, so an
 * archive cannot smuggle in a bot or skill the user never saw in the preview. Nothing here trusts
 * the file contents — each bot body is validated against the same strict schema the exporter writes.
 *
 * Version 2 inlined skill bodies in the manifest. Those archives are still importable: the manifest
 * is read with its own schema and normalized to the current shape, so the rest of the import path
 * only ever sees one manifest type.
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

  const skills = new Map<string, TeamConfigSkill>();
  let manifest: TeamConfigManifest;

  if (version === 2) {
    const parsed = TeamConfigManifestV2Schema.safeParse(raw);
    if (!parsed.success) {
      throw new TeamConfigParseError("malformed", "The manifest is incomplete.");
    }
    for (const skill of parsed.data.skills) skills.set(skill.key, skill);
    manifest = {
      ...parsed.data,
      version: TEAM_CONFIG_VERSION,
      skills: parsed.data.skills.map(({ key, name, description }) => ({
        key,
        name,
        description,
      })),
    };
  } else if (version === 3) {
    const parsed = TeamConfigManifestV3Schema.safeParse(raw);
    if (!parsed.success) {
      throw new TeamConfigParseError("malformed", "The manifest is incomplete.");
    }
    // Only the bot files changed since version 3; the manifest shape is the current one.
    manifest = { ...parsed.data, version: TEAM_CONFIG_VERSION };
  } else {
    const parsed = TeamConfigManifestSchema.safeParse(raw);
    if (!parsed.success) {
      throw new TeamConfigParseError("malformed", "The manifest is incomplete.");
    }
    manifest = parsed.data;
  }

  // Version 2 inlined skill bodies; later versions keep each body in its own file.
  if (version !== 2) {
    for (const entry of manifest.skills) {
      const content = textOf(files, teamConfigSkillPath(entry.key));
      if (content === null) {
        throw new TeamConfigParseError("missing_skill", `The file for "${entry.name}" is missing.`);
      }
      skills.set(entry.key, { ...entry, content });
    }
  }

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

  return { manifest, bots, skills };
}
