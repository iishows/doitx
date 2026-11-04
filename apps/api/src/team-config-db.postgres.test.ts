import { randomUUID } from "node:crypto";
import type { Actor, TeamConfigFile } from "@rakazo/contracts";
import {
  TEAM_CONFIG_MANIFEST_PATH,
  teamConfigBotPath,
  teamConfigSkillPath,
} from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  asSystem,
  buildTeamConfig,
  createDb,
  createRepos,
  readTeamConfigSource,
  runAsTenant,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentImportServices } from "./agent-import.js";
import { createTeamConfig, previewTeamConfig } from "./team-config-apply.js";

/**
 * The stub suites prove the export and import halves agree on a shape; this one proves the shape
 * survives the database. Only a real Postgres run exercises the space-scoped reads, the createBot
 * transaction and the per-space name uniqueness that a stubbed prisma quietly skips.
 *
 * `createBot` and `findBot` are wired to the same repo the product uses; the model, MCP and routine
 * members are never reached because the fixture bot carries none of those.
 */

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

describePostgres("team-config export -> import against PostgreSQL", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const ownerUserId = `tc-owner-${suffix}`;
  const organizationId = `tc-org-${suffix}`;
  const sourceSpaceId = `tc-src-${suffix}`;
  const targetSpaceId = `tc-dst-${suffix}`;
  let prisma: PrismaClient;
  let close: () => Promise<void>;
  let sys: PrismaClient;

  const sourceActor: Actor = {
    userId: ownerUserId,
    spaceId: sourceSpaceId,
    email: `tc-${suffix}@example.test`,
    isDeploymentOwner: false,
  };
  const targetActor: Actor = {
    userId: ownerUserId,
    spaceId: targetSpaceId,
    email: `tc-${suffix}@example.test`,
    isDeploymentOwner: false,
  };

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    close = async () => {
      await db.prisma.$disconnect();
      await db.pool.end();
    };
    sys = asSystem(prisma);

    await sys.user.create({
      data: { id: ownerUserId, email: `tc-${suffix}@example.test`, name: "TC Owner" },
    });
    await sys.organization.create({
      data: {
        id: organizationId,
        name: `TC Org ${suffix}`,
        slug: organizationId,
        createdAt: new Date(),
      },
    });
    // Two spaces under one owner: the archive is read from the first and applied into the second.
    await sys.space.create({
      data: { id: sourceSpaceId, organizationId, name: "Source Team", isDefault: true },
    });
    await sys.space.create({
      data: { id: targetSpaceId, organizationId, name: "Target Team", isDefault: false },
    });
    // createBot serializes against the space claim, which resolves through the membership row.
    // Inserting the member row fires `member_default_space_membership`, which creates the
    // membership for the default source space itself; only the non-default target needs one here.
    await sys.member.create({
      data: {
        id: `tc-member-${suffix}`,
        organizationId,
        userId: ownerUserId,
        role: "owner",
        createdAt: new Date(),
      },
    });
    await sys.spaceMember.create({
      data: {
        id: `tc-sm-target-${suffix}`,
        spaceId: targetSpaceId,
        organizationId,
        userId: ownerUserId,
        role: "owner",
        createdAt: new Date(),
      },
    });
  });

  afterAll(async () => {
    if (!prisma) return;
    await sys.bot.deleteMany({ where: { spaceId: { in: [sourceSpaceId, targetSpaceId] } } });
    await sys.botSection.deleteMany({
      where: { spaceId: { in: [sourceSpaceId, targetSpaceId] } },
    });
    await sys.spaceMember.deleteMany({
      where: { spaceId: { in: [sourceSpaceId, targetSpaceId] } },
    });
    await sys.member.deleteMany({ where: { organizationId } });
    await sys.space.deleteMany({ where: { id: { in: [sourceSpaceId, targetSpaceId] } } });
    await sys.organization.deleteMany({ where: { id: organizationId } });
    await sys.user.delete({ where: { id: ownerUserId } });
    await close();
  });

  /** Serializes the archive exactly the way the download route does. */
  function archiveFiles(sourceSpace: string, now = new Date()): Promise<TeamConfigFile[]> {
    return readTeamConfigSource(prisma, sourceSpace, now).then((source) => {
      const archive = buildTeamConfig(source);
      return [
        {
          path: TEAM_CONFIG_MANIFEST_PATH,
          content: JSON.stringify(archive.manifest, null, 2),
        },
        ...archive.bots.map((bot, index) => ({
          path: teamConfigBotPath(archive.manifest.bots[index]!.key),
          content: JSON.stringify(bot, null, 2),
        })),
        ...archive.skills.map((skill) => ({
          path: teamConfigSkillPath(skill.key),
          content: skill.content,
        })),
      ];
    });
  }

  it("carries a bot and its fields from one space into another", async () => {
    const repos = createRepos(prisma);

    // Real rows through the same repo the product writes with, inside the tenant context the
    // RLS guard requires.
    const bot = await runAsTenant(sourceActor, () =>
      repos.createBot(sourceActor, {
        id: randomUUID(),
        name: "Release Captain",
        description: "Ships releases",
        instructions: "Always tag before deploying.",
        notifyOnFinish: true,
        color: "#123456",
        avatarSet: "rakazo",
      }),
    );
    expect(bot.name).toBe("Release Captain");

    const files = await archiveFiles(sourceSpaceId);

    // The export half: the row we wrote must appear in the archive with its content intact.
    const manifest = JSON.parse(files[0]!.content);
    const exportedBot = files
      .slice(1)
      .map((f) => JSON.parse(f.content))
      .find((b) => b.name === "Release Captain");
    expect(exportedBot).toBeDefined();
    expect(exportedBot.instructions).toBe("Always tag before deploying.");
    expect(manifest.bots.length).toBe(1);

    const key = manifest.bots[0]!.key;

    const services = {
      prisma,
      createBot: (actor: Actor, input: Parameters<AgentImportServices["createBot"]>[1]) =>
        repos.createBot(actor, input),
      findBot: async (actor: Actor, botId: string) => {
        const row = await prisma.bot.findFirst({
          where: { id: botId, spaceId: actor.spaceId, userId: actor.userId },
        });
        if (!row) throw new Error(`bot ${botId} not found`);
        return row;
      },
      hasModelConnection: async () => false,
      validateBotModel: async () => null,
      // Unreached: the fixture bot has no MCP servers, routines or model credentials.
      connectedProviders: async () => new Set<string>(),
      mcpCredentialValues: async () => null,
      stdioAllowed: () => true,
      prepareModelKey: async () => ({}),
      writeModelKey: async () => null,
      afterModelKey: () => undefined,
      prepareMcpServer: async () => null,
      insertMcpServer: async () => {
        throw new Error("no MCP server expected in this fixture");
      },
      assertRoutineSchedule: () => undefined,
      routineNextRunAt: () => new Date(),
      routineRowData: () => ({}),
      notifyThread: () => undefined,
    } as unknown as AgentImportServices;

    // Preview is the reviewable step; it must not write yet.
    const preview = await runAsTenant(targetActor, () =>
      previewTeamConfig(services, targetActor, { files }),
    );
    expect(preview.sourceWorkspace).toBe("Source Team");
    expect(preview.bots.length).toBe(1);
    expect(await sys.bot.count({ where: { spaceId: targetSpaceId } })).toBe(0);

    // Apply.
    const result = await runAsTenant(targetActor, () =>
      createTeamConfig(services, targetActor, {
        files,
        selection: { keys: [key] },
      }),
    );
    expect(result.created.map((c) => c.name)).toEqual(["Release Captain"]);

    // Read back the committed row, scoped to the target space.
    const imported = await sys.bot.findFirst({
      where: { spaceId: targetSpaceId, name: "Release Captain" },
    });
    expect(imported).not.toBeNull();
    expect(imported!.instructions).toBe("Always tag before deploying.");
    expect(imported!.description).toBe("Ships releases");
    expect(imported!.notifyOnFinish).toBe(true);
    expect(imported!.color).toBe("#123456");
    expect(imported!.avatarSet).toBe("rakazo");

    // The source space is untouched.
    expect(await sys.bot.count({ where: { spaceId: sourceSpaceId } })).toBe(1);
  });

  it("never serializes a credential-shaped key into the archive", async () => {
    const files = await archiveFiles(sourceSpaceId);
    const serialized = files.map((f) => f.content).join("\n");
    expect(serialized).not.toMatch(/"(apiKey|api_key|token|password|secret|credential)"\s*:/i);
  });
});
