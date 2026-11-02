import type {
  TeamConfigBot,
  TeamConfigConnection,
  TeamConfigManifest,
  TeamConfigRoutine,
  TeamConfigSection,
} from "@rakazo/contracts";
import { TEAM_CONFIG_FORMAT, TEAM_CONFIG_MAX_BOTS, TEAM_CONFIG_VERSION } from "@rakazo/contracts";

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
 * The archive never carries content: no messages, no memory documents, no files, no run history.
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

  const truncated = source.bots.length > TEAM_CONFIG_MAX_BOTS;
  const kept = source.bots.slice(0, TEAM_CONFIG_MAX_BOTS);

  const bots: TeamConfigBot[] = kept.map((bot) => {
    const routines: TeamConfigRoutine[] = bot.routines.map((routine, index) => ({
      key: `routine:${botKey(bot.name, bot.id)}:${routine.name.toLowerCase() || index}`,
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
      key: botKey(bot.name, bot.id),
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
        key: `mcp:${botKey(bot.name, bot.id)}:${assignment.server.name.toLowerCase() || index}`,
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

  const manifest: TeamConfigManifest = {
    format: TEAM_CONFIG_FORMAT,
    version: TEAM_CONFIG_VERSION,
    exportedAt: source.exportedAt,
    sourceWorkspace: source.spaceName,
    bots: bots.map((bot) => ({ key: bot.key, name: bot.name, warnings: [] })),
    sections,
    connections,
    skills: source.skills.map((skill, index) => ({
      key: `skill:${skill.name.toLowerCase() || index}`,
      name: skill.name,
      description: skill.description,
      content: skill.content,
    })),
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

  return { manifest, bots, truncated };
}
