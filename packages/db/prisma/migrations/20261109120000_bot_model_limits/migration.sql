-- Per-bot model limits. NULL inherits the connection's configured output limit
-- and context window, so the provider-level settings stay the default and a bot
-- can widen them for long-output work.
ALTER TABLE "bots" ADD COLUMN IF NOT EXISTS "modelMaxTokens" INTEGER;
ALTER TABLE "bots" ADD COLUMN IF NOT EXISTS "modelContextWindow" INTEGER;
