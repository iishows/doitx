import type {
  TeamConfigBot,
  TeamConfigConnection,
  TeamConfigManifest,
  TeamConfigRoutine,
  TeamConfigSection,
  TeamConfigSkill,
} from "@rakazo/contracts";
import {
  TEAM_CONFIG_FORMAT,
  TEAM_CONFIG_MAX_BOTS,
  TEAM_CONFIG_MAX_SKILLS,
  TEAM_CONFIG_VERSION,
} from "@rakazo/contracts";

import type { PrismaClient } from "./client.js";
import { runAsSystem } from "./row-security.js";

/**
 * Builds a workspace team-config archive from a space's rows.
 *
 * Every mapper below is a **positive allow-list**: it names the columns allowed to travel and copies
 * nothing else. That is the whole security story — a new column added to `Bot`, `Connection` or
 * `McpServer` is absent from the archive until someone deliberately adds it here. Nothing in this
 * module imports the `Secret` model, so `Secret.ciphertext` is not reachable from the export path.
 *
 * The archive never carries runtime state: no messages, no memory documents, no uploaded files, no
 * run history. A skill travels as the Markdown its author wrote, which is configuration.
 */

/** A stable, readable key. Ids are regenerated on import, so they cannot be the handle. */
function botKey(name: string, id: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  // Fall back to the row id when a name has no Latin characters to slug (e.g. all CJK).
  return `bot:${slug || id}`;
}

/**
 * Keys name files inside the archive, so two rows that slug alike must not share one: a duplicate
 * path makes the whole zip unreadable on import. Names are unique per user, not per space, so two
 * users' skills in one space can collide here even though the database allows both.
 */
function uniqueKey(taken: Set<string>, base: string): string {
  let key = base;
  for (let n = 2; taken.has(key); n += 1) key = `${base}-${n}`;
  taken.add(key);
  return key;
}

function sectionKey(name: string, id: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `section:${slug || id}`;
}

/**
 * Reads every table the archive needs for one space. Reached from the download route, which has no
 * request-scoped session, so the read runs as the system against an explicit space id.
 */
export async function readTeamConfigSource(
  prisma: PrismaClient,
  spaceId: string,
  now = new Date(),
): Promise<TeamConfigExportSource> {
  return runAsSystem("read one Space's configuration for a team-config export", async () => {
    const [space, sections, bots, skills, connections, modelPreferences, approvalRules] =
      await Promise.all([
        prisma.space.findUniqueOrThrow({ where: { id: spaceId }, select: { name: true } }),
        prisma.botSection.findMany({
          where: { spaceId },
          orderBy: { position: "asc" },
          select: { id: true, name: true, position: true },
        }),
        prisma.bot.findMany({
          where: { spaceId },
          orderBy: { position: "asc" },
          select: {
            id: true,
            name: true,
            description: true,
            instructions: true,
            color: true,
            avatarSet: true,
            notifyOnFinish: true,
            pinned: true,
            position: true,
            memoryScope: true,
            modelProvider: true,
            modelId: true,
            thinkingLevel: true,
            modelMaxTokens: true,
            modelContextWindow: true,
            disabledBuiltinTools: true,
            teamChatAmbientEnabled: true,
            teamChatRules: true,
            crossSpaceCommunication: true,
            browserProxyEnabled: true,
            // Read only so the leak test can prove these never reach the archive.
            browserProxyUrl: true,
            browserProxyCiphertext: true,
            webhookSecretId: true,
            sectionId: true,
            routines: {
              orderBy: { createdAt: "asc" },
              select: {
                name: true,
                prompt: true,
                crons: true,
                timezone: true,
                active: true,
                notify: true,
                webhookEnabled: true,
                githubEnabled: true,
                modelProvider: true,
                modelId: true,
                thinkingLevel: true,
              },
            },
            mcpServers: {
              select: {
                // Only the address travels. `env` and `headers` routinely hold tokens, so they are
                // never selected; the importer asks the user to fill credentials in fresh.
                server: {
                  select: { name: true, command: true, endpoint: true, secretId: true },
                },
              },
            },
          },
        }),
        prisma.agentSkill.findMany({
          where: { spaceId },
          orderBy: { createdAt: "asc" },
          select: { name: true, description: true, content: true },
        }),
        prisma.connection.findMany({
          where: { spaceId },
          orderBy: { createdAt: "asc" },
          select: {
            provider: true,
            displayName: true,
            providerRef: true,
            secretId: true,
          },
        }),
        // `SpaceModelPreference` is per-credential and carries no provider; the space's visible model
        // choices live on `SpaceModelRoleChoice`, where `provider` is a column.
        prisma.spaceModelRoleChoice.findMany({
          where: { spaceId },
          orderBy: { position: "asc" },
          select: { provider: true, modelId: true, thinkingLevel: true },
        }),
        prisma.actionApprovalRule.findMany({
          where: { spaceId },
          select: { effect: true, matchKind: true, matchValue: true },
        }),
      ]);

    return {
      spaceName: space.name,
      exportedAt: now.toISOString(),
      sections,
      bots,
      skills,
      connections,
      modelPreferences,
      approvalRules,
    };
  });
}

export interface TeamConfigExportSource {
  spaceName: string;
  exportedAt: string;
  sections: Array<{ id: string; name: string; position: number }>;
  bots: Array<{
    id: string;
    name: string;
    description: string;
    instructions: string;
    color: string;
    avatarSet: string;
    notifyOnFinish: boolean;
    pinned: boolean;
    position: number;
    memoryScope: string | null;
    modelProvider: string | null;
    modelId: string | null;
    thinkingLevel: string | null;
    modelMaxTokens?: number | null;
    modelContextWindow?: number | null;
    disabledBuiltinTools: string[];
    teamChatAmbientEnabled: boolean;
    teamChatRules: string;
    crossSpaceCommunication: boolean;
    browserProxyEnabled: boolean;
    /**
     * Real columns on the row that must never be copied. They are on this interface so the leak test
     * can plant a credential-shaped value and assert it does not survive; the mappers never read them.
     */
    browserProxyUrl?: string | null;
    browserProxyCiphertext?: string | null;
    webhookSecretId?: string | null;
    sectionId: string | null;
    routines: Array<{
      name: string;
      prompt: string;
      crons: string[];
      timezone: string;
      active: boolean;
      notify: boolean;
      webhookEnabled: boolean;
      githubEnabled: boolean;
      modelProvider: string | null;
      modelId: string | null;
      thinkingLevel: string | null;
    }>;
    mcpServers: Array<{
      server: {
        name: string;
        command: string | null;
        endpoint: string | null;
        /** Read only to decide `requiresCredentials`; the id itself never travels. */
        secretId: string | null;
      };
    }>;
  }>;
  /** The space's skill library, read from `AgentSkill`. Space-scoped, so it sits at manifest level. */
  skills: Array<{ name: string; description: string; content: string }>;
  connections: Array<{
    provider: string;
    displayName: string;
    providerRef: string | null;
    /** Present only to prove the credential itself is not read; never copied. */
    secretId: string | null;
  }>;
  modelPreferences: Array<{
    provider: string;
    modelId: string | null;
    thinkingLevel: string | null;
  }>;
  approvalRules: Array<{ effect: string; matchKind: string; matchValue: string }>;
}

/**
 * Cap the archive at the schema's ceiling. A workspace with more bots than one archive may hold is
 * truncated and the caller is told, rather than silently producing an unimportable file.
 */
export interface TeamConfigExportResult {
  manifest: TeamConfigManifest;
  bots: TeamConfigBot[];
  /** Bodies written one file each, in the same order the manifest lists them. */
  skills: TeamConfigSkill[];
  truncated: boolean;
}

export function buildTeamConfig(source: TeamConfigExportSource): TeamConfigExportResult {
  const sections: TeamConfigSection[] = source.sections.map((section) => ({
    key: sectionKey(section.name, section.id),
    name: section.name,
    position: section.position,
  }));
  const sectionKeyById = new Map<string, string>();
  for (const [index, section] of source.sections.entries()) {
    sectionKeyById.set(section.id, sections[index]!.key);
  }

  const truncatedBots = source.bots.length > TEAM_CONFIG_MAX_BOTS;
  const kept = source.bots.slice(0, TEAM_CONFIG_MAX_BOTS);
  const truncatedSkills = source.skills.length > TEAM_CONFIG_MAX_SKILLS;
  const keptSkills = source.skills.slice(0, TEAM_CONFIG_MAX_SKILLS);

  const botKeys = new Set<string>();
  const bots: TeamConfigBot[] = kept.map((bot) => {
    const key = uniqueKey(botKeys, botKey(bot.name, bot.id));
    const routines: TeamConfigRoutine[] = bot.routines.map((routine, index) => ({
      key: `routine:${key}:${routine.name.toLowerCase() || index}`,
      name: routine.name,
      prompt: routine.prompt,
      crons: routine.crons,
      timezone: routine.timezone,
      active: routine.active,
      notify: routine.notify,
      webhookEnabled: routine.webhookEnabled,
      githubEnabled: routine.githubEnabled,
      modelProvider: routine.modelProvider,
      modelId: routine.modelId,
      thinkingLevel: routine.thinkingLevel,
    }));

    return {
      key,
      name: bot.name,
      description: bot.description,
      instructions: bot.instructions,
      color: bot.color,
      avatarSet: bot.avatarSet as TeamConfigBot["avatarSet"],
      notifyOnFinish: bot.notifyOnFinish,
      pinned: bot.pinned,
      position: bot.position,
      memoryScope: bot.memoryScope,
      modelProvider: bot.modelProvider,
      modelId: bot.modelId,
      thinkingLevel: bot.thinkingLevel,
      // Limits describe a named model; without one the runtime never applies them.
      ...(bot.modelProvider && bot.modelId
        ? {
            modelMaxTokens: bot.modelMaxTokens,
            modelContextWindow: bot.modelContextWindow,
          }
        : {}),
      disabledBuiltinTools: bot.disabledBuiltinTools,
      teamChatAmbientEnabled: bot.teamChatAmbientEnabled,
      teamChatRules: bot.teamChatRules,
      crossSpaceCommunication: bot.crossSpaceCommunication,
      browserProxyEnabled: bot.browserProxyEnabled,
      sectionKey: bot.sectionId ? (sectionKeyById.get(bot.sectionId) ?? null) : null,
      routines,
      // The server row carries env and headers; only the declared endpoint is copied, and the
      // importer is told the user must supply credentials before it can run.
      mcpServers: bot.mcpServers.map((assignment, index) => ({
        key: `mcp:${key}:${assignment.server.name.toLowerCase() || index}`,
        name: assignment.server.name,
        ...(assignment.server.command ? { command: assignment.server.command } : {}),
        ...(assignment.server.endpoint ? { endpoint: assignment.server.endpoint } : {}),
        // A server with a stored secret will not run without one on the destination either.
        requiresCredentials: assignment.server.secretId !== null,
      })),
    };
  });

  const connections: TeamConfigConnection[] = source.connections.map((connection, index) => ({
    key: `connection:${connection.provider.toLowerCase() || index}`,
    provider: connection.provider,
    displayName: connection.displayName,
    ...(connection.providerRef ? { providerRef: connection.providerRef } : {}),
  }));

  // The body is written to its own file; the manifest only points at it, so a long skill can no
  // longer push the manifest past the per-file limit an import enforces.
  const skillKeys = new Set<string>();
  const skills: TeamConfigSkill[] = keptSkills.map((skill, index) => ({
    key: uniqueKey(skillKeys, `skill:${skill.name.toLowerCase() || index}`),
    name: skill.name,
    description: skill.description,
    content: skill.content,
  }));

  const manifest: TeamConfigManifest = {
    format: TEAM_CONFIG_FORMAT,
    version: TEAM_CONFIG_VERSION,
    exportedAt: source.exportedAt,
    sourceWorkspace: source.spaceName,
    bots: bots.map((bot) => ({ key: bot.key, name: bot.name, warnings: [] })),
    sections,
    connections,
    skills: skills.map(({ key, name, description }) => ({ key, name, description })),
    modelPreferences: source.modelPreferences.map((preference) => ({
      provider: preference.provider,
      ...(preference.modelId ? { modelId: preference.modelId } : {}),
      ...(preference.thinkingLevel ? { thinkingLevel: preference.thinkingLevel } : {}),
    })),
    approvalRules: source.approvalRules.map((rule) => ({
      effect: rule.effect,
      matchKind: rule.matchKind,
      matchValue: rule.matchValue,
    })),
  };

  return { manifest, bots, skills, truncated: truncatedBots || truncatedSkills };
}
