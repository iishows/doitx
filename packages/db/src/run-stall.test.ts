import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { findStalledRunningRuns, lastUserVisibleOutputAt } from "./run-stall.js";

const at = (minutes: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + minutes * 60_000);
const now = at(24 * 60);

function fakePrisma(input: {
  runs: Array<{ id: string; startedAt: Date }>;
  botMessages?: Array<{ runId: string; createdAt: Date }>;
  artifacts?: Array<{ runId: string; createdAt: Date }>;
}) {
  const groupBy = (rows: Array<{ runId: string; createdAt: Date }>) =>
    vi.fn(async () => {
      const byRun = new Map<string, Date>();
      for (const row of rows) {
        const known = byRun.get(row.runId);
        if (!known || row.createdAt > known) byRun.set(row.runId, row.createdAt);
      }
      return [...byRun].map(([runId, createdAt]) => ({ runId, _max: { createdAt } }));
    });
  return {
    run: { findMany: vi.fn(async () => input.runs) },
    message: { groupBy: groupBy(input.botMessages ?? []) },
    artifact: { groupBy: groupBy(input.artifacts ?? []) },
  } as unknown as Pick<PrismaClient, "run" | "message" | "artifact">;
}

describe("findStalledRunningRuns", () => {
  it("reports a run whose last output is older than the silence window", async () => {
    const prisma = fakePrisma({
      runs: [{ id: "run-1", startedAt: at(0) }],
      botMessages: [{ runId: "run-1", createdAt: at(30) }],
    });
    const stalled = await findStalledRunningRuns(prisma, {
      silentMs: 60 * 60_000,
      now,
      batchSize: 10,
    });
    expect(stalled).toEqual([
      expect.objectContaining({ id: "run-1", lastOutputAt: at(30) }),
    ]);
  });

  it("leaves a run alone while its output is recent", async () => {
    const prisma = fakePrisma({
      runs: [{ id: "run-1", startedAt: at(0) }],
      botMessages: [{ runId: "run-1", createdAt: at(23 * 60 + 1) }],
    });
    await expect(
      findStalledRunningRuns(prisma, { silentMs: 60 * 60_000, now, batchSize: 10 }),
    ).resolves.toEqual([]);
  });

  it("treats an artifact as output too, and uses whichever is newest", async () => {
    const prisma = fakePrisma({
      runs: [{ id: "run-1", startedAt: at(0) }],
      botMessages: [{ runId: "run-1", createdAt: at(10) }],
      artifacts: [{ runId: "run-1", createdAt: at(23 * 60 + 30) }],
    });
    await expect(
      findStalledRunningRuns(prisma, { silentMs: 60 * 60_000, now, batchSize: 10 }),
    ).resolves.toEqual([]);
  });

  it("falls back to the run's start when it has produced nothing at all", async () => {
    const prisma = fakePrisma({ runs: [{ id: "run-1", startedAt: at(0) }] });
    const stalled = await findStalledRunningRuns(prisma, {
      silentMs: 60 * 60_000,
      now,
      batchSize: 10,
    });
    expect(stalled).toEqual([expect.objectContaining({ id: "run-1", lastOutputAt: at(0) })]);
  });

  it("only asks about running runs that started before the window", async () => {
    const prisma = fakePrisma({ runs: [] });
    await findStalledRunningRuns(prisma, { silentMs: 60 * 60_000, now, batchSize: 10 });
    const client = prisma as unknown as { run: { findMany: ReturnType<typeof vi.fn> } };
    expect(client.run.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: "running", startedAt: { not: null, lte: at(23 * 60) } },
      }),
    );
  });

  it("does not query output when no run is a candidate", async () => {
    const prisma = fakePrisma({ runs: [] });
    await findStalledRunningRuns(prisma, { silentMs: 60 * 60_000, now, batchSize: 10 });
    const client = prisma as unknown as { message: { groupBy: ReturnType<typeof vi.fn> } };
    expect(client.message.groupBy).not.toHaveBeenCalled();
  });
});

describe("lastUserVisibleOutputAt", () => {
  it("returns null when the run has shown nothing", async () => {
    const prisma = {
      message: { findFirst: vi.fn(async () => null) },
      artifact: { findFirst: vi.fn(async () => null) },
    } as unknown as Pick<PrismaClient, "message" | "artifact">;
    await expect(lastUserVisibleOutputAt(prisma, "run-1")).resolves.toBeNull();
  });

  it("returns the newer of the last bot message and the last artifact", async () => {
    const prisma = {
      message: { findFirst: vi.fn(async () => ({ createdAt: at(10) })) },
      artifact: { findFirst: vi.fn(async () => ({ createdAt: at(40) })) },
    } as unknown as Pick<PrismaClient, "message" | "artifact">;
    await expect(lastUserVisibleOutputAt(prisma, "run-1")).resolves.toEqual(at(40));
  });

  it("ignores a user message, which is not output the bot produced", async () => {
    const findFirst = vi.fn(async (args: { where: { role?: string } }) =>
      args.where.role === "bot" ? null : ({ createdAt: at(50) } as never),
    );
    const prisma = {
      message: { findFirst },
      artifact: { findFirst: vi.fn(async () => null) },
    } as unknown as Pick<PrismaClient, "message" | "artifact">;
    await expect(lastUserVisibleOutputAt(prisma, "run-1")).resolves.toBeNull();
  });
});
