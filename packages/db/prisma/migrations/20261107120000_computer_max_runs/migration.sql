-- Per-computer concurrency ceiling for executing runs. Null inherits the instance
-- default (RAKAZO_MAX_RUNS_PER_COMPUTER, else 1), so a shared team computer is not
-- oversubscribed by several bots running at once.
ALTER TABLE "computers" ADD COLUMN IF NOT EXISTS "maxRunsPerComputer" INTEGER;
