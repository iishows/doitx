import { runContinueJob } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import type { ExecutorDeps } from "./executor-deps.js";
import { startNextWaitingRun, startNextWaitingRunForComputer } from "./run-lifecycle.js";

function deps(next: { id: string } | null) {
  const findFirst = vi.fn(async () => next);
  const enqueue = vi.fn(async () => undefined);
  return {
    deps: { prisma: { run: { findFirst } }, jobs: { enqueue } } as unknown as ExecutorDeps,
    findFirst,
    enqueue,
  };
}

describe("starting the next run waiting for a bot's computer", () => {
  it("starts the oldest other due run of the bot, leaving failure backoff alone", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-28T12:00:00Z") });
    try {
      const f = deps({ id: "waiting" });
      await startNextWaitingRun(f.deps, "bot", "finished");
      expect(f.findFirst).toHaveBeenCalledWith({
        where: {
          botId: "bot",
          status: "queued",
          id: { not: "finished" },
          OR: [{ wakeAt: null }, { wakeAt: { lte: new Date("2026-10-28T12:00:00Z") } }],
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { id: true },
      });
      expect(f.enqueue).toHaveBeenCalledExactlyOnceWith(runContinueJob("waiting"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("does nothing when no run is waiting", async () => {
    const f = deps(null);
    await startNextWaitingRun(f.deps, "bot", "finished");
    expect(f.enqueue).not.toHaveBeenCalled();
  });
});

describe("starting the next run waiting for a shared computer", () => {
  it("picks the oldest due run on the computer regardless of which bot owns it", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-28T12:00:00Z") });
    try {
      const f = deps({ id: "waiting" });
      await startNextWaitingRunForComputer(f.deps, "computer-1", "finished");
      expect(f.findFirst).toHaveBeenCalledWith({
        where: {
          status: "queued",
          id: { not: "finished" },
          bot: { computerId: "computer-1" },
          OR: [{ wakeAt: null }, { wakeAt: { lte: new Date("2026-10-28T12:00:00Z") } }],
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { id: true },
      });
      expect(f.enqueue).toHaveBeenCalledExactlyOnceWith(runContinueJob("waiting"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("does nothing when no run on the computer is waiting", async () => {
    const f = deps(null);
    await startNextWaitingRunForComputer(f.deps, "computer-1", "finished");
    expect(f.enqueue).not.toHaveBeenCalled();
  });
});
