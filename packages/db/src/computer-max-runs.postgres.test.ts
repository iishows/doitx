import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import {
  getMaxRunsPerComputer,
  resolveMaxRunsPerComputer,
  setMaxRunsPerComputer,
} from "./computers.js";
import { asSystem } from "./row-security.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

describePostgres("per-computer run ceiling (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  let prisma: PrismaClient;
  let close: () => Promise<void>;
  let computerId: string;
  let organizationId: string;
  let spaceId: string;
  let userId: string;

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    close = async () => {
      await prisma.$disconnect();
      await db.pool.end();
    };
    const system = asSystem(prisma);
    userId = `max-runs-user-${suffix}`;
    organizationId = `max-runs-org-${suffix}`;
    spaceId = `max-runs-space-${suffix}`;
    await system.user.create({
      data: { id: userId, email: `${userId}@example.test`, name: "Max Runs" },
    });
    await system.organization.create({
      data: { id: organizationId, name: "Max runs", slug: organizationId, createdAt: new Date() },
    });
    await system.space.create({
      data: { id: spaceId, organizationId, name: "Max runs", isDefault: true },
    });
    const computer = await system.computer.create({
      data: {
        spaceId,
        userId,
        scope: "team",
        scopeKey: `team:${spaceId}:${userId}`,
        homeKey: `team-max-runs-${suffix}`,
        kind: "docker",
      },
      select: { id: true },
    });
    computerId = computer.id;
  });

  afterAll(async () => {
    // The computer cascades from its space, which cascades from its organization.
    await asSystem(prisma).organization.deleteMany({ where: { id: organizationId } });
    await asSystem(prisma).user.deleteMany({ where: { id: userId } });
    await close();
  });

  it("stores the migration's column with a real null default", async () => {
    const row = await asSystem(prisma).computer.findUniqueOrThrow({
      where: { id: computerId },
      select: { maxRunsPerComputer: true },
    });
    expect(row.maxRunsPerComputer).toBeNull();
  });

  it("round-trips an override and reports the effective value", async () => {
    await expect(setMaxRunsPerComputer(asSystem(prisma), computerId, 3)).resolves.toBe(3);
    await expect(getMaxRunsPerComputer(asSystem(prisma), computerId)).resolves.toBe(3);

    const stored = await asSystem(prisma).computer.findUniqueOrThrow({
      where: { id: computerId },
      select: { maxRunsPerComputer: true },
    });
    expect(stored.maxRunsPerComputer).toBe(3);
  });

  it("clears the override back to the instance default", async () => {
    await expect(setMaxRunsPerComputer(asSystem(prisma), computerId, null)).resolves.toBe(
      resolveMaxRunsPerComputer(null),
    );
    const stored = await asSystem(prisma).computer.findUniqueOrThrow({
      where: { id: computerId },
      select: { maxRunsPerComputer: true },
    });
    expect(stored.maxRunsPerComputer).toBeNull();
  });
});
