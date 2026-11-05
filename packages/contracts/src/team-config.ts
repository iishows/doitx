import * as z from "zod";
import { AgentImportWarningSchema } from "./agent-import.js";
import { BotAvatarSetSchema } from "./bot-avatar.js";
import { BOT_DESCRIPTION_MAX_LENGTH, BOT_NAME_MAX_LENGTH } from "./domain.js";

/**
 * The version of the workspace team-config archive. Bumped when the on-disk shape changes in a way
 * an older importer cannot read. The importer refuses anything newer than the version it knows and
 * migrates anything older.
 */
export const TEAM_CONFIG_VERSION = 4;

/** Identifies the archive as ours, so an unrelated zip is rejected before anything is read. */
export const TEAM_CONFIG_FORMAT = "rakazo-team-config";

/** The manifest always sits at the archive root. */
export const TEAM_CONFIG_MANIFEST_PATH = "manifest.json";

/** Per-bot configuration files live under this directory, one `<key>.json` each. */
export const TEAM_CONFIG_BOTS_DIR = "bots";

/** Maps a bot key to its file inside the archive. Keys are slugs, so they are path-safe already. */
export function teamConfigBotPath(key: string): string {
  return `${TEAM_CONFIG_BOTS_DIR}/${encodeURIComponent(key)}.json`;
}

/** Per-skill bodies live here, one `<key>.md` each. A skill's content is Markdown, so no JSON wrapper. */
export const TEAM_CONFIG_SKILLS_DIR = "skills";

export function teamConfigSkillPath(key: string): string {
  return `${TEAM_CONFIG_SKILLS_DIR}/${encodeURIComponent(key)}.md`;
}

/** How many bots one archive may carry. Mirrors the per-agent file ceiling the importer already applies. */
export const TEAM_CONFIG_MAX_BOTS = 200;

/** Matches the bot ceiling, so the file count stays inside `TEAM_CONFIG_MAX_FILES`. */
export const TEAM_CONFIG_MAX_SKILLS = 200;

/**
 * A key that is stable inside one archive only. Slugs are minted on export and are what the import
 * preview lists and the user ticks, so they must survive a round trip unchanged.
 */
export const TeamConfigKeySchema = z.string().min(1).max(120);

/** A bot group. Bots reference these by key rather than by id, which is regenerated on import. */
export const TeamConfigSectionSchema = z.object({
  key: TeamConfigKeySchema,
  name: z.string().min(1).max(BOT_NAME_MAX_LENGTH),
  position: z.number().int(),
});
export type TeamConfigSection = z.infer<typeof TeamConfigSectionSchema>;

/**
 * A routine definition, minus the bot it belongs to and every runtime field. The schedule, prompt
 * and delivery switches are the whole definition; run history and `nextRunAt` are not configuration
 * and are recomputed on import.
 */
export const TeamConfigRoutineSchema = z.strictObject({
  key: TeamConfigKeySchema,
  name: z.string().min(1),
  prompt: z.string(),
  crons: z.array(z.string()),
  timezone: z.string(),
  active: z.boolean(),
  notify: z.boolean(),
  webhookEnabled: z.boolean(),
  githubEnabled: z.boolean(),
  modelProvider: z.string().nullable(),
  modelId: z.string().nullable(),
  thinkingLevel: z.string().nullable(),
});
export type TeamConfigRoutine = z.infer<typeof TeamConfigRoutineSchema>;

/**
 * A skill in the space's library. Skills are space-scoped rather than per-bot, so the manifest lists
 * them; the recording a taught skill produces is runtime state and is not exported.
 *
 * The body is the author's Markdown and lives in its own file (`teamConfigSkillPath`). It used to be
 * inlined here, which made the manifest itself unbounded: one legal 100 000-character skill pushed
 * the manifest past the per-file limit and the archive could be exported but never imported.
 */
export const TeamConfigSkillSchema = z.strictObject({
  key: TeamConfigKeySchema,
  name: z.string().min(1),
  description: z.string(),
  content: z.string(),
});
export type TeamConfigSkill = z.infer<typeof TeamConfigSkillSchema>;

/** What the manifest carries for a skill: everything but the body, which sits in its own file. */
export const TeamConfigSkillSummarySchema = z.strictObject({
  key: TeamConfigKeySchema,
  name: z.string().min(1),
  description: z.string(),
});
export type TeamConfigSkillSummary = z.infer<typeof TeamConfigSkillSummarySchema>;

/**
 * An MCP server declaration. The command and endpoint describe what to run or connect to; **the
 * environment, headers and any key are deliberately absent** and must be supplied by the user
 * after import. Strict, so an exporter that leaks one is rejected rather than silently trimmed.
 */
export const TeamConfigMcpServerSchema = z.strictObject({
  key: TeamConfigKeySchema,
  name: z.string().min(1),
  command: z.string().optional(),
  /** The declared address only. `env` and `headers` can hold tokens and never travel. */
  endpoint: z.string().optional(),
  /** True when the server needs the user to enter credentials before it can run. */
  requiresCredentials: z.boolean().default(false),
});
export type TeamConfigMcpServer = z.infer<typeof TeamConfigMcpServerSchema>;

/**
 * An integration connection, **metadata only**. `secretId` and every credential column are absent
 * by construction, so this can never carry a token. After import the bot is marked as needing the
 * user to re-authorize the connection.
 */
export const TeamConfigConnectionSchema = z.strictObject({
  key: TeamConfigKeySchema,
  provider: z.string().min(1),
  displayName: z.string().min(1),
  /** The provider-side subject or account ref, when it is not itself a credential. */
  providerRef: z.string().optional(),
});
export type TeamConfigConnection = z.infer<typeof TeamConfigConnectionSchema>;

/**
 * One bot's configuration. Every field here is an explicit allow-list entry picked off the `Bot`
 * row: adding a column to the schema never adds it to the archive. Secret-bearing columns on `Bot`
 * (`webhookSecretId`, `browserProxyCiphertext`) and every per-bot credential are excluded on
 * purpose, and the object is strict so one that slips through fails loudly instead of being kept.
 *
 * `browserProxyUrl` is excluded alongside the ciphertext: a proxy URL may embed `user:pass@`, so it
 * is treated as a credential. Only the on/off intent travels.
 */
export const TeamConfigBotSchema = z.strictObject({
  key: TeamConfigKeySchema,
  name: z.string().min(1).max(BOT_NAME_MAX_LENGTH),
  description: z.string().max(BOT_DESCRIPTION_MAX_LENGTH),
  instructions: z.string(),
  color: z.string(),
  avatarSet: BotAvatarSetSchema,
  notifyOnFinish: z.boolean(),
  pinned: z.boolean(),
  position: z.number().int(),
  memoryScope: z.string().nullable(),
  modelProvider: z.string().nullable(),
  modelId: z.string().nullable(),
  thinkingLevel: z.string().nullable(),
  /** Absent in archives written before per-bot model limits existed. */
  modelMaxTokens: z.number().int().min(1).nullable().optional(),
  modelContextWindow: z.number().int().min(1).nullable().optional(),
  disabledBuiltinTools: z.array(z.string()),
  teamChatAmbientEnabled: z.boolean(),
  teamChatRules: z.string(),
  crossSpaceCommunication: z.boolean(),
  /** Only whether the bot proxies its browser; the URL and its ciphertext stay behind. */
  browserProxyEnabled: z.boolean(),
  /** The group this bot sits in, by section key. Resolved to a real section on import. */
  sectionKey: TeamConfigKeySchema.nullable(),
  routines: z.array(TeamConfigRoutineSchema),
  mcpServers: z.array(TeamConfigMcpServerSchema),
});
export type TeamConfigBot = z.infer<typeof TeamConfigBotSchema>;

/**
 * A space-wide model preference. The `credentialId` that backs it is deliberately absent: it names a
 * user's own credential, which does not exist in the importing account. Only the intent — which
 * provider and model this space prefers — travels, and the importer drops the entry with a warning
 * when the user has no credential for that provider.
 */
export const TeamConfigModelPreferenceSchema = z.strictObject({
  provider: z.string().min(1),
  modelId: z.string().optional(),
  thinkingLevel: z.string().optional(),
});
export type TeamConfigModelPreference = z.infer<typeof TeamConfigModelPreferenceSchema>;

/**
 * An action-approval rule, as the pattern its author wrote. Nothing here is a credential: the rule
 * says which action to match and whether to allow it.
 */
export const TeamConfigApprovalRuleSchema = z.strictObject({
  effect: z.string().min(1),
  matchKind: z.string().min(1),
  matchValue: z.string(),
});
export type TeamConfigApprovalRule = z.infer<typeof TeamConfigApprovalRuleSchema>;

/**
 * Everything the manifest carries except its version and skills, which are what differ between
 * archive versions. Sharing them keeps the two schemas from drifting.
 */
const manifestBase = {
  format: z.literal(TEAM_CONFIG_FORMAT),
  exportedAt: z.string(),
  sourceWorkspace: z.string(),
  bots: z
    .array(
      z.object({
        key: TeamConfigKeySchema,
        name: z.string().min(1).max(BOT_NAME_MAX_LENGTH),
        warnings: z.array(AgentImportWarningSchema).default([]),
      }),
    )
    .max(TEAM_CONFIG_MAX_BOTS),
  sections: z.array(TeamConfigSectionSchema),
  connections: z.array(TeamConfigConnectionSchema),
  modelPreferences: z.array(TeamConfigModelPreferenceSchema).default([]),
  approvalRules: z.array(TeamConfigApprovalRuleSchema).default([]),
};

/**
 * The archive's root manifest. It doubles as the import preview: `bots` carries the list the user
 * ticks and any per-bot warning the exporter already knows about. Each skill's body is a file.
 */
export const TeamConfigManifestSchema = z.object({
  ...manifestBase,
  version: z.literal(TEAM_CONFIG_VERSION),
  skills: z.array(TeamConfigSkillSummarySchema).max(TEAM_CONFIG_MAX_SKILLS).default([]),
});
export type TeamConfigManifest = z.infer<typeof TeamConfigManifestSchema>;

/**
 * The version 2 manifest, kept only so archives exported before skills were split out can still be
 * imported. Skills were inlined then, so this schema needs no skill files. Do not extend it.
 */
export const TeamConfigManifestV2Schema = z.object({
  ...manifestBase,
  version: z.literal(2),
  skills: z.array(TeamConfigSkillSchema).default([]),
});
export type TeamConfigManifestV2 = z.infer<typeof TeamConfigManifestV2Schema>;

/**
 * The version 3 manifest. Its shape matches the current one; only the bot files differ, gaining
 * optional per-bot model limits in version 4. Kept so archives exported before that still import.
 */
export const TeamConfigManifestV3Schema = z.object({
  ...manifestBase,
  version: z.literal(3),
  skills: z.array(TeamConfigSkillSummarySchema).max(TEAM_CONFIG_MAX_SKILLS).default([]),
});
export type TeamConfigManifestV3 = z.infer<typeof TeamConfigManifestV3Schema>;

/**
 * Which bots the user ticked in the preview, by archive key. The importer only ever writes the keys
 * it is given, so an unticked bot is never created.
 */
export const TeamConfigSelectionSchema = z.object({
  keys: z.array(TeamConfigKeySchema).max(TEAM_CONFIG_MAX_BOTS),
});
export type TeamConfigSelection = z.infer<typeof TeamConfigSelectionSchema>;

/* ----------------------------------------------------------------------------------------- *
 * Import transport, preview and apply
 * ----------------------------------------------------------------------------------------- */

/** One manifest, one file per bot and one per skill, plus slack for the manifest and future entries. */
export const TEAM_CONFIG_MAX_FILES = TEAM_CONFIG_MAX_BOTS + TEAM_CONFIG_MAX_SKILLS + 16;
export const TEAM_CONFIG_MAX_FILE_LENGTH = 100_000;
export const TEAM_CONFIG_MAX_TOTAL_LENGTH = 4_000_000;
export const TEAM_CONFIG_MAX_PATH_LENGTH = 300;

/** The archive read in the browser and sent up as text, one entry per file. */
export const TeamConfigFileSchema = z.strictObject({
  path: z.string().min(1).max(TEAM_CONFIG_MAX_PATH_LENGTH),
  content: z.string().max(TEAM_CONFIG_MAX_FILE_LENGTH),
});
export type TeamConfigFile = z.infer<typeof TeamConfigFileSchema>;

export const TeamConfigFilesSchema = z
  .array(TeamConfigFileSchema)
  .min(1)
  .max(TEAM_CONFIG_MAX_FILES)
  .superRefine((files, ctx) => {
    const total = files.reduce((sum, file) => sum + file.content.length, 0);
    if (total > TEAM_CONFIG_MAX_TOTAL_LENGTH) {
      ctx.addIssue({ code: "custom", message: "The archive is too large to import." });
    }
    if (new Set(files.map((file) => file.path)).size !== files.length) {
      ctx.addIssue({ code: "custom", message: "Each file can be sent once." });
    }
  });

/** What one bot in the archive will become, as shown in the preview before anything is written. */
export const TeamConfigBotPlanSchema = z.object({
  key: TeamConfigKeySchema,
  name: z.string(),
  /** Reuses the agent-import vocabulary so the checklist reads the same as a single-agent import. */
  warnings: z.array(AgentImportWarningSchema).default([]),
  routines: z.number().int().nonnegative(),
  mcpServers: z.number().int().nonnegative(),
  /**
   * True when at least one MCP server in the archive carried a secret, so this bot cannot fully run
   * until the user supplies credentials.
   */
  needsCredentials: z.boolean().default(false),
  /**
   * Connectors that are imported but whose address this deployment cannot use. They need a new
   * address before they work; the archive still carries their definition.
   */
  endpointProblems: z.array(z.string()).default([]),
  /** A bot whose name is already taken here; it is created under a free name instead. */
  nameTaken: z.boolean().default(false),
});
export type TeamConfigBotPlan = z.infer<typeof TeamConfigBotPlanSchema>;

/**
 * A model preference from the archive that names a provider the importing user has no credential
 * for, so it is dropped. Only the provider travels — there is nothing here that could leak a key.
 */
export const TeamConfigDroppedPreferenceSchema = z.object({ provider: z.string() });
export type TeamConfigDroppedPreference = z.infer<typeof TeamConfigDroppedPreferenceSchema>;

export const TeamConfigPreviewSchema = z.object({
  sourceWorkspace: z.string(),
  exportedAt: z.string(),
  bots: z.array(TeamConfigBotPlanSchema),
  counts: z.object({
    sections: z.number().int().nonnegative(),
    connections: z.number().int().nonnegative(),
    skills: z.number().int().nonnegative(),
  }),
  droppedPreferences: z.array(TeamConfigDroppedPreferenceSchema).default([]),
});
export type TeamConfigPreview = z.infer<typeof TeamConfigPreviewSchema>;

/** Preview re-reads the files rather than staging anything, so the two calls take the same input. */
export const TeamConfigPreviewInput = z.strictObject({ files: TeamConfigFilesSchema });
export type TeamConfigPreviewInput = z.infer<typeof TeamConfigPreviewInput>;

export const TeamConfigCreateInput = z.strictObject({
  files: TeamConfigFilesSchema,
  selection: TeamConfigSelectionSchema,
});
export type TeamConfigCreateInput = z.infer<typeof TeamConfigCreateInput>;

/** What an apply actually wrote, so the UI can report it rather than guessing from the selection. */
export const TeamConfigCreateResultSchema = z.object({
  created: z.array(z.object({ key: TeamConfigKeySchema, name: z.string() })),
});
export type TeamConfigCreateResult = z.infer<typeof TeamConfigCreateResultSchema>;
