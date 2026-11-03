import type { JobPublisher, NotificationMessage, NotificationProvider } from "@rakazo/adapter-kit";
import { runContinueJob } from "@rakazo/adapter-kit";
import type { StuckWorkStatus } from "@rakazo/core";
import {
  isStuckWorkStatus,
  STALLED_RUN_NOTIFY_AFTER_MS,
  stalledRunAction,
  stalledRunReminder,
  stalledRunStoppedNotification,
  STUCK_WORK_NOTICE,
  STUCK_WORK_STATUSES,
  stuckWorkAction,
  stuckWorkAgeMs,
  stuckWorkDueAfterMs,
  stuckWorkReminder,
  stuckWorkStoppedNotification,
} from "@rakazo/core";
import type { Prisma, PrismaClient, ThreadEvents } from "@rakazo/db";
import {
  appendEventInTransaction,
  expireStalledRun,
  expireStuckRun,
  findStalledRunningRuns,
  stalledRunEpisodeAt,
  withTransactionRetry,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { ExpoPushProvider } from "./expo-push.js";

type StuckCursor = { at: Date; id: string };

/**
 * Work that needs the user's attention because it is not moving.
 *
 * A wait's episode is its updatedAt, which a claim or answer changes. A running run's row is
 * touched by its own lease heartbeat every minute, so its episode is the last user-visible
 * output instead; that is also the clock its staleness is measured on.
 */
type StuckCandidate = {
  id: string;
  kind: "waiting" | "stalled";
  /** Only meaningful for a wait; a stalled run's status is always "running". */
  status: StuckWorkStatus | "running";
  episodeAt: Date;
  /** How long this has been stuck, from the same clock as the action threshold. */
  stuckForMs: number;
  spaceId: string;
  threadId: string;
  botId: string;
  userId: string;
  taskId: string;
  bot: { name: string; notifyOnFinish: boolean };
  thread: { groupId: string | null };
};

/**
 * How long a pending reminder claim counts as in flight. Longer than the Expo
 * push timeout so a live send is not treated as abandoned, and short enough
 * that a worker which stops before Expo accepts the push is retried.
 */
export const STUCK_NOTICE_CLAIM_TTL_MS = 2 * 60 * 1000;

/**
 * Remind, then cancel, work that has been sitting still: queued runs and human waits, and
 * running runs that have shown the user nothing for a long time. The notice stamp is keyed
 * to the episode, so the work moving on can remind again later. A pending claim becomes
 * delivered only after the push is accepted and is removed when the push fails, so a crash
 * or a dropped token can still remind.
 */
export async function reconcileStuckWork(deps: {
  prisma: PrismaClient;
  jobs: JobPublisher;
  events?: ThreadEvents;
  notifications?: NotificationProvider;
  now: Date;
  batchSize: number;
  cursor?: StuckCursor;
}): Promise<StuckCursor | undefined> {
  const cursorFilter = deps.cursor
    ? {
        OR: [
          { updatedAt: { gt: deps.cursor.at } },
          { updatedAt: deps.cursor.at, id: { gt: deps.cursor.id } },
        ],
      }
    : undefined;
  const runs = await deps.prisma.run.findMany({
    where: {
      AND: [
        {
          OR: STUCK_WORK_STATUSES.map((status) => ({
            status,
            updatedAt: { lte: new Date(deps.now.getTime() - stuckWorkDueAfterMs(status)) },
          })),
        },
        ...(cursorFilter ? [cursorFilter] : []),
      ],
    },
    orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
    take: deps.batchSize,
    select: {
      id: true,
      status: true,
      updatedAt: true,
      spaceId: true,
      threadId: true,
      botId: true,
      userId: true,
      taskId: true,
      bot: { select: { name: true, notifyOnFinish: true } },
      thread: { select: { groupId: true } },
    },
  });

  const due = runs.flatMap((run) => {
    const candidate = readyStuckRun(run, deps.now);
    return candidate ? [candidate] : [];
  });

  await applyStuckActions(deps, due);

  const last = runs.at(-1);
  if (runs.length < deps.batchSize || !last || !(last.updatedAt instanceof Date)) return undefined;
  return { at: last.updatedAt, id: last.id };
}

/**
 * Remind, then cancel, running runs that have shown the user nothing for a long time.
 *
 * Kept apart from the waiting sweep because it runs on a different clock: a running run's
 * row is touched by its lease heartbeat every minute, so staleness is measured from its
 * last user-visible output instead of updatedAt. Runs its own reconcile pass so a slow
 * output query never delays the queue and human-wait reminders.
 */
export async function reconcileStalledRuns(deps: {
  prisma: PrismaClient;
  jobs: JobPublisher;
  events?: ThreadEvents;
  notifications?: NotificationProvider;
  now: Date;
  batchSize: number;
}): Promise<void> {
  await applyStuckActions(deps, await readyStalledRuns(deps));
}

/** Runs whose last user-visible output is old; bounded like the waiting batch. */
async function readyStalledRuns(deps: {
  prisma: PrismaClient;
  now: Date;
  batchSize: number;
}): Promise<StuckCandidate[]> {
  const stalled = await findStalledRunningRuns(deps.prisma, {
    silentMs: STALLED_RUN_NOTIFY_AFTER_MS,
    now: deps.now,
    batchSize: deps.batchSize,
  });
  return stalled.map((run) => ({
    id: run.id,
    kind: "stalled",
    status: "running",
    episodeAt: run.lastOutputAt,
    stuckForMs: deps.now.getTime() - run.lastOutputAt.getTime(),
    spaceId: run.spaceId,
    threadId: run.threadId,
    botId: run.botId,
    userId: run.userId,
    taskId: run.taskId,
    bot: run.bot,
    thread: run.thread,
  }));
}

async function applyStuckActions(
  deps: {
    prisma: PrismaClient;
    jobs: JobPublisher;
    events?: ThreadEvents;
    notifications?: NotificationProvider;
    now: Date;
  },
  due: StuckCandidate[],
) {
  if (due.length === 0) return;
  const notices = await deps.prisma.event.findMany({
    where: {
      runId: { in: due.map((run) => run.id) },
      type: "thread.meta",
      payload: { path: ["notice"], equals: STUCK_WORK_NOTICE },
    },
    select: { runId: true, payload: true },
  });

  for (const run of due) {
    const alreadyNotified = notices.some(
      (notice) => notice.runId === run.id && noticeIsDelivered(notice.payload, run.episodeAt),
    );
    const action =
      run.kind === "stalled"
        ? stalledRunAction({ silentForMs: run.stuckForMs, alreadyNotified })
        : stuckWorkAction({
            status: run.status as StuckWorkStatus,
            ageMs: run.stuckForMs,
            alreadyNotified,
          });
    try {
      if (action === "notify") await remindStuckRun(deps, run);
      else if (action === "expire") await expireOne(deps, run);
    } catch (error) {
      getLogger().error("stuck work", error);
    }
  }
}

function readyStuckRun(
  run: {
    id: string;
    status?: string;
    updatedAt?: Date | null;
    spaceId?: string | null;
    threadId?: string | null;
    botId?: string | null;
    userId?: string | null;
    taskId?: string | null;
    bot?: { name: string; notifyOnFinish: boolean } | null;
    thread?: { groupId: string | null } | null;
  },
  now: Date,
): StuckCandidate | null {
  if (!run.status || !isStuckWorkStatus(run.status)) return null;
  if (!(run.updatedAt instanceof Date)) return null;
  const stuckForMs = stuckWorkAgeMs(run.updatedAt, now);
  if (stuckForMs < stuckWorkDueAfterMs(run.status)) return null;
  if (!run.spaceId || !run.threadId || !run.botId || !run.userId || !run.taskId) return null;
  if (!run.bot || !run.thread) return null;
  return {
    id: run.id,
    kind: "waiting",
    status: run.status,
    episodeAt: run.updatedAt,
    stuckForMs,
    spaceId: run.spaceId,
    threadId: run.threadId,
    botId: run.botId,
    userId: run.userId,
    taskId: run.taskId,
    bot: run.bot,
    thread: run.thread,
  };
}

function noticesEnabled(run: StuckCandidate): boolean {
  return Boolean(run.thread.groupId || run.bot.notifyOnFinish);
}

type StuckNoticePayload = {
  notice?: unknown;
  updatedAt?: unknown;
  state?: unknown;
  claimedAt?: unknown;
};

function stuckNoticePayload(payload: unknown): StuckNoticePayload | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as StuckNoticePayload;
  if (record.notice !== STUCK_WORK_NOTICE || typeof record.updatedAt !== "string") return null;
  return record;
}

/** A stamp counts as delivered once the push was accepted. Pending claims do not. */
function noticeIsDelivered(payload: unknown, episodeAt: Date): boolean {
  const record = stuckNoticePayload(payload);
  if (!record || record.updatedAt !== episodeAt.toISOString()) return false;
  return record.state !== "pending";
}

function pendingClaimFresh(payload: unknown, episodeAt: Date, now: Date): boolean {
  const record = stuckNoticePayload(payload);
  if (!record) return false;
  if (record.state !== "pending" || record.updatedAt !== episodeAt.toISOString()) return false;
  if (typeof record.claimedAt !== "string") return false;
  const claimedAt = Date.parse(record.claimedAt);
  if (!Number.isFinite(claimedAt)) return false;
  const age = now.getTime() - claimedAt;
  return age >= 0 && age < STUCK_NOTICE_CLAIM_TTL_MS;
}

function deliveredNotice(episodeAt: Date): Prisma.InputJsonValue {
  return {
    notice: STUCK_WORK_NOTICE,
    updatedAt: episodeAt.toISOString(),
    state: "delivered",
  };
}

async function remindStuckRun(
  deps: {
    prisma: PrismaClient;
    notifications?: NotificationProvider;
    now: Date;
  },
  run: StuckCandidate,
) {
  // A skipped push (notices off, no provider, or no push token yet) stays unmarked
  // so a later sweep can still remind during this same wait.
  if (!deps.notifications || !noticesEnabled(run)) return;
  if (!(await pushCanDeliver(deps.notifications, run.userId))) return;
  const claimId = await withTransactionRetry(() =>
    deps.prisma.$transaction((tx) => claimStuckReminder(tx, run, deps.now)),
  );
  if (!claimId) return;
  const reminder =
    run.kind === "stalled"
      ? stalledRunReminder(run.bot.name)
      : stuckWorkReminder(run.status as StuckWorkStatus, run.bot.name);
  const delivery = await sendStuckNotice(deps.notifications, run, {
    kind: reminder.kind,
    title: reminder.title,
    body: reminder.body,
    botId: run.botId,
    threadId: run.threadId,
  });
  if (delivery === "delivered") {
    await withTransactionRetry(() =>
      deps.prisma.$transaction((tx) => markStuckNoticeDelivered(tx, claimId, run)),
    );
    return;
  }
  await withTransactionRetry(() => deps.prisma.$transaction((tx) => clearStuckNotice(tx, claimId)));
}

async function pushCanDeliver(
  notifications: NotificationProvider,
  userId: string,
): Promise<boolean> {
  if (!(notifications instanceof ExpoPushProvider)) return true;
  return notifications.hasPushRecipient(userId);
}

/** Re-reads the episode under the thread lock so a run that moved on is not reminded. */
async function currentEpisodeAt(
  tx: Prisma.TransactionClient,
  run: StuckCandidate,
): Promise<Date | null> {
  const current = await tx.run.findUnique({
    where: { id: run.id },
    select: { status: true, updatedAt: true, startedAt: true },
  });
  if (!current || current.status !== run.status) return null;
  if (run.kind === "stalled") {
    // Output, not updatedAt: the lease heartbeat rewrites updatedAt every minute.
    return stalledRunEpisodeAt(tx, run.id, current.startedAt ?? run.episodeAt);
  }
  return current.updatedAt;
}

async function claimStuckReminder(
  tx: Prisma.TransactionClient,
  run: StuckCandidate,
  now: Date,
): Promise<string | null> {
  await tx.$queryRaw`SELECT id FROM threads WHERE id = ${run.threadId} FOR UPDATE`;
  const episodeAt = await currentEpisodeAt(tx, run);
  if (!episodeAt || episodeAt.getTime() !== run.episodeAt.getTime()) return null;
  const existing = await tx.event.findMany({
    where: {
      runId: run.id,
      type: "thread.meta",
      payload: { path: ["notice"], equals: STUCK_WORK_NOTICE },
    },
    select: { payload: true },
  });
  if (existing.some((notice) => noticeIsDelivered(notice.payload, episodeAt))) return null;
  if (existing.some((notice) => pendingClaimFresh(notice.payload, episodeAt, now))) {
    return null;
  }
  await tx.event.deleteMany({
    where: {
      runId: run.id,
      type: "thread.meta",
      AND: [
        { payload: { path: ["notice"], equals: STUCK_WORK_NOTICE } },
        { payload: { path: ["updatedAt"], equals: episodeAt.toISOString() } },
        { payload: { path: ["state"], equals: "pending" } },
      ],
    },
  });
  const claimed = await appendEventInTransaction(tx, {
    spaceId: run.spaceId,
    threadId: run.threadId,
    botId: run.botId,
    type: "thread.meta",
    runId: run.id,
    payload: {
      notice: STUCK_WORK_NOTICE,
      updatedAt: episodeAt.toISOString(),
      state: "pending",
      claimedAt: now.toISOString(),
    },
  });
  return claimed.id;
}

async function markStuckNoticeDelivered(
  tx: Prisma.TransactionClient,
  eventId: string,
  run: StuckCandidate,
) {
  await tx.$queryRaw`SELECT id FROM threads WHERE id = ${run.threadId} FOR UPDATE`;
  await tx.event.update({
    where: { id: eventId },
    data: { payload: deliveredNotice(run.episodeAt) },
  });
}

async function clearStuckNotice(tx: Prisma.TransactionClient, eventId: string) {
  await tx.event.deleteMany({ where: { id: eventId } });
}

async function expireOne(
  deps: {
    prisma: PrismaClient;
    jobs: JobPublisher;
    events?: ThreadEvents;
    notifications?: NotificationProvider;
    now: Date;
  },
  run: StuckCandidate,
) {
  const expired = await withTransactionRetry(() =>
    deps.prisma.$transaction((tx) =>
      run.kind === "stalled"
        ? expireStalledRun(tx, {
            runId: run.id,
            threadId: run.threadId,
            startedAt: run.episodeAt,
            lastOutputAt: run.episodeAt,
            now: deps.now,
          })
        : expireStuckRun(tx, {
            runId: run.id,
            threadId: run.threadId,
            status: run.status as StuckWorkStatus,
            updatedAt: run.episodeAt,
            now: deps.now,
          }),
    ),
  );
  if (!expired) return;
  await deps.events?.notify(run.threadId, expired.seq).catch((error) => {
    getLogger().error("stuck work realtime notification", error);
  });
  if (expired.continuationRunId) {
    await deps.jobs.enqueue(runContinueJob(expired.continuationRunId)).catch((error) => {
      getLogger().error("stuck work continuation", error);
    });
  }
  if (!deps.notifications || !noticesEnabled(run)) return;
  const stopped =
    run.kind === "stalled"
      ? stalledRunStoppedNotification(run.bot.name)
      : stuckWorkStoppedNotification(run.status as StuckWorkStatus, run.bot.name);
  await sendStuckNotice(deps.notifications, run, {
    kind: stopped.kind,
    title: stopped.title,
    body: stopped.body,
    botId: run.botId,
    threadId: run.threadId,
  });
}

type StuckNoticeDelivery = "delivered" | "undeliverable" | "failed";

async function sendStuckNotice(
  notifications: NotificationProvider,
  run: StuckCandidate,
  message: NotificationMessage,
): Promise<StuckNoticeDelivery> {
  const context = {
    operationId: "notify",
    traceId: run.botId,
    spaceId: run.spaceId,
    userId: run.userId,
    botId: run.botId,
    signal: new AbortController().signal,
  };
  const notice = run.thread.groupId ? { ...message, groupId: run.thread.groupId } : message;
  try {
    if (notifications instanceof ExpoPushProvider) {
      return await notifications.deliver(notice, context);
    }
    await notifications.send(notice, context);
    return "delivered";
  } catch (error) {
    getLogger().error("stuck work notification", error);
    return "failed";
  }
}
