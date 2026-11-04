import { ORPCError } from "@orpc/server";
import type {
  Actor,
  AgentImportPlan,
  AgentImportSelection,
  TeamConfigCreateInput,
  TeamConfigCreateResult,
  TeamConfigManifest,
  TeamConfigPreview,
  TeamConfigPreviewInput,
  TeamConfigSkill,
} from "@rakazo/contracts";
import { parseTeamConfig, TeamConfigParseError } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import type { AgentImportServices } from "./agent-import.js";
import { materializeImportedBot } from "./agent-import.js";
import { buildTeamConfigBot } from "./team-config-import.js";

/**
 * Preview and apply for a team-config archive.
 *
 * Both read the archive again rather than staging anything, so a preview the user ticked against
 * cannot go stale into a different create. Nothing is trusted from the file beyond its shape: the
 * parser validates every body against the same strict schemas the exporter writes.
 */

/**
 * Reads the archive. A foreign or damaged zip is the user's problem, not a server fault, so the
 * parser's reason is passed on as a coded 400 the UI can turn into its own sentence.
 */
function read(input: TeamConfigPreviewInput | TeamConfigCreateInput) {
  try {
    return parseTeamConfig(input.files);
  } catch (error) {
    if (error instanceof TeamConfigParseError) {
      throw new ORPCError("BAD_REQUEST", {
        message: error.message,
        data: { reason: error.reason },
      });
    }
    throw error;
  }
}

export async function previewTeamConfig<PreparedKey>(
  services: AgentImportServices<PreparedKey>,
  actor: Actor,
  input: TeamConfigPreviewInput,
): Promise<TeamConfigPreview> {
  const { manifest, bots } = read(input);

  const taken = await takenBotNames(services.prisma, actor);
  const plans: TeamConfigPreview["bots"] = [];

  for (const entry of manifest.bots) {
    const bot = bots.get(entry.key);
    if (!bot) continue;
    const built = await buildTeamConfigBot(services, actor, bot);
    // A name taken here, or claimed by an earlier bot in this same archive, is created renamed.
    const nameTaken = taken.has(bot.name.toLowerCase());
    taken.add(bot.name.toLowerCase());
    plans.push({
      key: entry.key,
      name: bot.name,
      warnings: [
        ...new Set([
          ...entry.warnings,
          ...built.plan.mcpServers.flatMap((server) => server.warnings),
        ]),
      ],
      routines: built.plan.routines.length,
      mcpServers: built.plan.mcpServers.length,
      needsCredentials: bot.mcpServers.some((server) => server.requiresCredentials),
      nameTaken,
    });
  }

  const droppedPreferences = await droppedModelPreferences(
    services,
    actor,
    manifest.modelPreferences,
  );

  return {
    sourceWorkspace: manifest.sourceWorkspace,
    exportedAt: manifest.exportedAt,
    bots: plans,
    counts: {
      sections: manifest.sections.length,
      connections: manifest.connections.length,
      skills: manifest.skills.length,
    },
    droppedPreferences,
  };
}

export async function createTeamConfig<PreparedKey>(
  services: AgentImportServices<PreparedKey>,
  actor: Actor,
  input: TeamConfigCreateInput,
): Promise<TeamConfigCreateResult> {
  const { manifest, bots, skills } = read(input);
  const wanted = new Set(input.selection.keys);

  // Space-scoped items first, so a bot that references a section can find it.
  await writeSpaceLevelItems(services.prisma, actor, manifest, skills);

  // Names are claimed as they are handed out, so two bots called the same in one archive do not
  // both get the same free name.
  const taken = await takenBotNames(services.prisma, actor);
  const created: TeamConfigCreateResult["created"] = [];
  for (const entry of manifest.bots) {
    if (!wanted.has(entry.key)) continue;
    const bot = bots.get(entry.key);
    if (!bot) continue;
    const built = await buildTeamConfigBot(services, actor, bot);
    // Scoped to this archive: the same archive applied twice is a no-op, but a bot key that
    // happens to repeat in a different archive is a different bot.
    const importKey = `team-config:${manifest.exportedAt}:${entry.key}`;
    const digest = `${manifest.exportedAt}:${entry.key}`;
    const already = async () => {
      const found = await services.prisma.agentImport.findFirst({
        where: { spaceId: actor.spaceId, userId: actor.userId, importKey },
        select: { botId: true, requestDigest: true },
      });
      if (!found) return null;
      if (found.requestDigest !== digest) {
        throw new ORPCError("PRECONDITION_FAILED", {
          message: "This archive was already imported with different contents.",
        });
      }
      return services.findBot(actor, found.botId);
    };
    // A second apply of the same archive returns the bots it already made.
    const existing = await already();
    if (existing) {
      created.push({ key: entry.key, name: existing.name });
      continue;
    }
    const name = freeBotName(taken, bot.name);
    const row = await materializeImportedBot(
      services,
      actor,
      {
        name,
        description: bot.description,
        computerMode: "team",
        color: bot.color,
        avatarSet: bot.avatarSet,
        selection: fullSelection(built.plan),
        importKey,
        source: "team-config",
        digest,
        already,
      },
      built,
    );
    created.push({ key: entry.key, name: row.name });
  }

  return { created };
}

/**
 * The items that belong to the space rather than to one bot: sections, skills, connection
 * declarations, model preferences and approval rules. Each is created only when it is not already
 * here, so applying the same archive twice does not duplicate them.
 *
 * A connection is written with no credential: the archive never carries one, and the provider must
 * be re-authorised here before it works. That is a `pending` row the user finishes in connections.
 */
async function writeSpaceLevelItems(
  db: PrismaClient,
  actor: Actor,
  manifest: TeamConfigManifest,
  skills: Map<string, TeamConfigSkill>,
): Promise<void> {
  const owner = { spaceId: actor.spaceId, userId: actor.userId };

  const sectionNames = new Set(
    (await db.botSection.findMany({ where: owner, select: { name: true } })).map((row) =>
      row.name.toLowerCase(),
    ),
  );
  const sectionPosition =
    (await db.botSection.aggregate({ where: owner, _max: { position: true } }))._max.position ?? -1;
  const newSections = manifest.sections.filter((section) => {
    if (sectionNames.has(section.name.toLowerCase())) return false;
    sectionNames.add(section.name.toLowerCase());
    return true;
  });
  if (newSections.length) {
    await db.botSection.createMany({
      data: newSections.map((section, index) => ({
        ...owner,
        name: section.name,
        position: sectionPosition + 1 + index,
      })),
    });
  }

  const skillNames = new Set(
    (await db.agentSkill.findMany({ where: owner, select: { name: true } })).map((row) =>
      row.name.toLowerCase(),
    ),
  );
  // Bodies come from their own files, so the manifest's summaries alone cannot create anything.
  const newSkills = [...skills.values()].filter((skill) => {
    if (skillNames.has(skill.name.toLowerCase())) return false;
    skillNames.add(skill.name.toLowerCase());
    return true;
  });
  for (const skill of newSkills) {
    await db.agentSkill.create({
      data: {
        ...owner,
        name: skill.name,
        description: skill.description,
        content: skill.content,
        source: "user",
      },
    });
  }

  const connectionKeys = new Set(
    (
      await db.connection.findMany({
        where: owner,
        select: { provider: true, displayName: true },
      })
    ).map((row) => `${row.provider}\u0000${row.displayName.toLowerCase()}`),
  );
  for (const connection of manifest.connections) {
    const key = `${connection.provider}\u0000${connection.displayName.toLowerCase()}`;
    if (connectionKeys.has(key)) continue;
    connectionKeys.add(key);
    await db.connection.create({
      data: {
        ...owner,
        provider: connection.provider,
        displayName: connection.displayName,
        providerRef: connection.providerRef ?? null,
        // No credential travels, so this only becomes usable once the user authorises it here.
        status: "pending",
      },
    });
  }

  for (const preference of manifest.modelPreferences) {
    const credential = await db.userModelCredential.findFirst({
      where: { userId: actor.userId, provider: preference.provider },
      select: { id: true },
    });
    if (!credential) continue;
    await db.spaceModelPreference.upsert({
      where: {
        spaceId_userId_credentialId: {
          spaceId: actor.spaceId,
          userId: actor.userId,
          credentialId: credential.id,
        },
      },
      create: {
        ...owner,
        credentialId: credential.id,
        modelId: preference.modelId ?? null,
        thinkingLevel: preference.thinkingLevel ?? null,
      },
      update: {
        modelId: preference.modelId ?? null,
        thinkingLevel: preference.thinkingLevel ?? null,
      },
    });
  }

  if (manifest.approvalRules.length) {
    await db.actionApprovalRule.createMany({
      data: manifest.approvalRules.map((rule) => ({
        spaceId: actor.spaceId,
        createdByUserId: actor.userId,
        effect: rule.effect,
        matchKind: rule.matchKind,
        matchValue: rule.matchValue,
      })),
      skipDuplicates: true,
    });
  }
}

/** Everything the archive carried is pre-selected: the user ticked the bots they wanted. */
function fullSelection(plan: AgentImportPlan): AgentImportSelection {
  return {
    instructions: plan.instructions.map((item) => item.id),
    memory: plan.memory.map((item) => ({ id: item.id, destination: "bot" as const })),
    skills: plan.skills.map((item) => item.id),
    model: plan.model !== null,
    mcpServers: plan.mcpServers.map((item) => item.id),
    routines: plan.routines.map((item) => item.id),
    apiKeys: [],
  };
}

async function takenBotNames(db: PrismaClient, actor: Actor): Promise<Set<string>> {
  const rows = await db.bot.findMany({
    where: { spaceId: actor.spaceId, userId: actor.userId, archivedAt: null },
    select: { name: true },
  });
  return new Set(rows.map((row) => row.name.toLowerCase()));
}

/** A free name, claiming it so the next bot of the same name gets a different one. */
function freeBotName(taken: Set<string>, name: string): string {
  let candidate = name;
  for (let n = 2; taken.has(candidate.toLowerCase()); n += 1) {
    candidate = `${name}-${n}`;
  }
  taken.add(candidate.toLowerCase());
  return candidate;
}

/**
 * Model preferences naming a provider this user has no credential for. Only the intent travels, so
 * the entry is dropped with a note rather than silently doing nothing.
 */
async function droppedModelPreferences<PreparedKey>(
  services: AgentImportServices<PreparedKey>,
  actor: Actor,
  preferences: { provider: string }[],
): Promise<TeamConfigPreview["droppedPreferences"]> {
  const dropped: TeamConfigPreview["droppedPreferences"] = [];
  for (const preference of preferences) {
    if (!(await services.hasModelConnection(actor, preference.provider))) {
      dropped.push({ provider: preference.provider });
    }
  }
  return dropped;
}
