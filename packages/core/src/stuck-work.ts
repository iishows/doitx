import { displayName } from "./display-name.js";
/** Remind once a queued run or a human wait has been sitting this long.
 *  Long enough that a short queue or stepping away stays quiet; short enough
 *  that forgotten work is not silent until the next day. */
export const STUCK_WORK_NOTIFY_AFTER_MS = 4 * 60 * 60 * 1000;

/** Cancel once that same work has been sitting this long.
 *  Leaves the hours after the reminder for someone to answer before the thread is freed. */
export const STUCK_WORK_EXPIRE_AFTER_MS = 24 * 60 * 60 * 1000;

/** A takeover request nobody acted on is cancelled much sooner: it holds the bot's computer,
 *  so later work for that bot waits behind it. Expires before the reminder would fire. */
export const TAKEOVER_WAIT_EXPIRE_AFTER_MS = 30 * 60 * 1000;

/** Marker on a thread.meta event so a reminder is sent once per waiting episode. */
export const STUCK_WORK_NOTICE = "stuck";

/** A running run that has shown the user nothing new for this long gets a reminder.
 *  The user is watching a spinner, so silence is worse here than in a queue. */
export const STALLED_RUN_NOTIFY_AFTER_MS = 30 * 60 * 1000;

/** Cancel a running run that stays silent this long. A slow task can legitimately think for
 *  a while, so this only fires well past the reminder, when nothing has landed at all. */
export const STALLED_RUN_EXPIRE_AFTER_MS = 2 * 60 * 60 * 1000;

export const STUCK_WORK_STATUSES = ["queued", "waiting_input", "waiting_takeover"] as const;
export type StuckWorkStatus = (typeof STUCK_WORK_STATUSES)[number];

export type StuckWorkAction = "notify" | "expire" | "none";

export function isStuckWorkStatus(status: string): status is StuckWorkStatus {
  return (STUCK_WORK_STATUSES as readonly string[]).includes(status);
}

export function stuckWorkAgeMs(updatedAt: Date | string, now: Date): number {
  const at = updatedAt instanceof Date ? updatedAt.getTime() : Date.parse(updatedAt);
  if (!Number.isFinite(at)) return 0;
  return now.getTime() - at;
}

/** How long a run in this status may sit before the first reminder or cancellation. */
export function stuckWorkDueAfterMs(status: StuckWorkStatus): number {
  return Math.min(STUCK_WORK_NOTIFY_AFTER_MS, stuckWorkExpireAfterMs(status));
}

/** `alreadyNotified` is for this episode (the run's current updatedAt), not an older one. */
export function stuckWorkAction(input: {
  status: StuckWorkStatus;
  ageMs: number;
  alreadyNotified: boolean;
}): StuckWorkAction {
  if (input.ageMs >= stuckWorkExpireAfterMs(input.status)) return "expire";
  if (input.ageMs >= STUCK_WORK_NOTIFY_AFTER_MS && !input.alreadyNotified) return "notify";
  return "none";
}

/** True once a queued or human-waiting run is old enough to call out in the activity list. */
export function isAgedStuckWork(
  status: string,
  updatedAt: Date | string,
  now = Date.now(),
): boolean {
  if (!isStuckWorkStatus(status)) return false;
  return stuckWorkAgeMs(updatedAt, new Date(now)) >= STUCK_WORK_NOTIFY_AFTER_MS;
}

/**
 * What to do about a working run that has shown the user nothing for a while.
 *
 * Age is measured from the last user-visible output, not the run's updatedAt: a running
 * run's row is touched by its own lease heartbeat every minute, so updatedAt says nothing
 * about progress and would never look old. `silentForMs` is now minus the newest bot
 * message or artifact for the run.
 */
export function stalledRunAction(input: {
  silentForMs: number;
  alreadyNotified: boolean;
}): StuckWorkAction {
  if (input.silentForMs >= STALLED_RUN_EXPIRE_AFTER_MS) return "expire";
  if (input.silentForMs >= STALLED_RUN_NOTIFY_AFTER_MS && !input.alreadyNotified) return "notify";
  return "none";
}

export function stuckWorkExpiredNonce(runId: string): string {
  return `stuck-expired:${runId}`;
}

/** Status line left in the thread when the wait is cancelled. */
export function stuckWorkStatusMessage(status: StuckWorkStatus): string {
  switch (status) {
    case "queued":
      return "Stopped. This stayed queued without starting.";
    case "waiting_input":
      return "Stopped. This was still waiting for an answer.";
    case "waiting_takeover":
      return "Stopped. This was still waiting for you on the screen.";
  }
}

export function stuckWorkStatusMessages(): readonly string[] {
  return STUCK_WORK_STATUSES.map((status) => stuckWorkStatusMessage(status));
}

/** Status line left in the thread when a run is cancelled for going quiet. */
export const STALLED_RUN_MESSAGE = "Stopped. This ran for a long time without showing anything.";

export type StuckAttentionKind = "help" | "takeover" | "failure";

export function stuckWorkReminder(
  status: StuckWorkStatus,
  botName: string,
): { kind: StuckAttentionKind; title: string; body: string } {
  const name = botLabel(botName);
  switch (status) {
    case "queued":
      return {
        kind: "help",
        title: `${name} is still queued`,
        body: "It has been waiting to start.",
      };
    case "waiting_input":
      return {
        kind: "help",
        title: `${name} still needs an answer`,
        body: "This has been waiting on you.",
      };
    case "waiting_takeover":
      return {
        kind: "takeover",
        title: `${name} still needs you`,
        body: "The screen has been waiting.",
      };
  }
}

export function stuckWorkStoppedNotification(
  status: StuckWorkStatus,
  botName: string,
): { kind: "failure"; title: string; body: string } {
  return {
    kind: "failure",
    title: `${botLabel(botName)} stopped`,
    body: stuckWorkStatusMessage(status),
  };
}

/** Reminder for a running run that has gone quiet while the user watches a spinner. */
export function stalledRunReminder(botName: string): {
  kind: "help";
  title: string;
  body: string;
} {
  const name = botLabel(botName);
  return {
    kind: "help",
    title: `${name} has gone quiet`,
    body: "It is still running but has not shown anything new for a while.",
  };
}

export function stalledRunStoppedNotification(botName: string): {
  kind: "failure";
  title: string;
  body: string;
} {
  return {
    kind: "failure",
    title: `${botLabel(botName)} stopped`,
    body: STALLED_RUN_MESSAGE,
  };
}

function botLabel(name: string): string {
  return displayName(name, "Bot");
}

function stuckWorkExpireAfterMs(status: StuckWorkStatus): number {
  return status === "waiting_takeover" ? TAKEOVER_WAIT_EXPIRE_AFTER_MS : STUCK_WORK_EXPIRE_AFTER_MS;
}
