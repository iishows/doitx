-- Sole statement so CREATE INDEX CONCURRENTLY runs outside an implicit
-- transaction. The job reconciler pages webhook-triggered runs whose reply has
-- not been delivered yet in updatedAt order; only those few runs belong in the
-- index. Runs without a callback URL on their bot never match and stay out.
CREATE INDEX CONCURRENTLY "runs_webhook_reply_pending_idx"
ON "runs" ("updatedAt", "id")
WHERE "trigger" = 'webhook' AND "webhookReplyDeliveredAt" IS NULL;
