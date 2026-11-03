import type { Prisma, PrismaClient } from "./client.js";

/** The newest thing the user was shown for a run: a bot message or an artifact. */
export async function lastUserVisibleOutputAt(
  prisma: Pick<PrismaClient, "message" | "artifact">,
  runId: string,
): Promise<Date | null> {
  const [lastMessage, lastArtifact] = await Promise.all([
    prisma.message.findFirst({
      where: { runId, role: "bot" },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    }),
    prisma.artifact.findFirst({
      where: { runId },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    }),
  ]);
  const times = [lastMessage?.createdAt, lastArtifact?.createdAt].filter(
    (at): at is Date => at instanceof Date,
  );
  if (times.length === 0) return null;
  return new Date(Math.max(...times.map((at) => at.getTime())));
}

export type StalledRunningRun = {
  id: string;
  threadId: string;
  spaceId: string;
  botId: string;
  userId: string;
  taskId: string;
  /** The run's own start, used as the silence clock before any output lands. */
  startedAt: Date;
  /** When the user last saw output from this run. */
  lastOutputAt: Date;
  bot: { name: string; notifyOnFinish: boolean };
  thread: { groupId: string | null };
};

/**
 * Running runs that have shown the user nothing new for `silentMs`.
 *
 * Measured from output, not `updatedAt`: a running run's row is touched by its lease
 * heartbeat every minute, so `updatedAt` never looks old and a run spinning without
 * producing anything would go unnoticed. A run with no output yet falls back to its
 * start, so one that never gets going is caught too.
 */
export async function findStalledRunningRuns(
  prisma: Pick<PrismaClient, "run" | "message" | "artifact">,
  options: { silentMs: number; now: Date; batchSize: number },
): Promise<StalledRunningRun[]> {
  const cutoff = new Date(options.now.getTime() - options.silentMs);
  const candidates = await prisma.run.findMany({
    where: { status: "running", startedAt: { not: null, lte: cutoff } },
    orderBy: [{ startedAt: "asc" }, { id: "asc" }],
    take: options.batchSize,
    select: {
      id: true,
      threadId: true,
      spaceId: true,
      botId: true,
      userId: true,
      taskId: true,
      startedAt: true,
      bot: { select: { name: true, notifyOnFinish: true } },
      thread: { select: { groupId: true } },
    },
  });
  if (candidates.length === 0) return [];
  const ids = candidates.map((run) => run.id);
  const [messages, artifacts] = await Promise.all([
    prisma.message.groupBy({
      by: ["runId"],
      where: { runId: { in: ids }, role: "bot" },
      _max: { createdAt: true },
    }),
    prisma.artifact.groupBy({
      by: ["runId"],
      where: { runId: { in: ids } },
      _max: { createdAt: true },
    }),
  ]);
  const lastOutputByRun = new Map<string, Date>();
  for (const row of [...messages, ...artifacts]) {
    const at = row._max.createdAt;
    if (!row.runId || !(at instanceof Date)) continue;
    const known = lastOutputByRun.get(row.runId);
    if (!known || at > known) lastOutputByRun.set(row.runId, at);
  }
  return candidates.flatMap((run) => {
    const startedAt = run.startedAt;
    // The selection pinned startedAt, so this cannot be null here.
    if (!startedAt) return [];
    const lastOutputAt = lastOutputByRun.get(run.id) ?? startedAt;
    if (lastOutputAt > cutoff) return [];
    return [{ ...run, startedAt, lastOutputAt }];
  });
}

/** Re-derives the silence clock inside a caller's transaction, for a safe compare-and-set. */
export async function stalledRunEpisodeAt(
  tx: Pick<Prisma.TransactionClient, "message" | "artifact">,
  runId: string,
  fallback: Date,
): Promise<Date> {
  return (await lastUserVisibleOutputAt(tx, runId)) ?? fallback;
}
