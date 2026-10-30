-- Reply callback for webhook-triggered runs: the bot stores an optional URL and
-- the run records when the reply was delivered, so the reconciler can page
-- pending deliveries without rescanning completed work.
ALTER TABLE "bots" ADD COLUMN IF NOT EXISTS "webhookCallbackUrl" TEXT;
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "webhookReplyDeliveredAt" TIMESTAMP(3);
