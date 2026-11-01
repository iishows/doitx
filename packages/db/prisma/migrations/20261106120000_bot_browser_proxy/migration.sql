-- Per-bot upstream proxy for the bot's browser. The URL keeps scheme/host/port
-- only; the user:password blob is sealed in browserProxyCiphertext so the
-- plaintext credential is never persisted.
ALTER TABLE "bots" ADD COLUMN IF NOT EXISTS "browserProxyEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "bots" ADD COLUMN IF NOT EXISTS "browserProxyUrl" TEXT;
ALTER TABLE "bots" ADD COLUMN IF NOT EXISTS "browserProxyCiphertext" TEXT;
