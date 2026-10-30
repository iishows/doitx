import { createHmac } from "node:crypto";
import type { SecretStore } from "@rakazo/adapter-kit";
import { botRunOutcomeText } from "./job-reconciler.js";
import { fetchSafeHttpRequest } from "./web-ssrf.js";

/**
 * One decrypted secret per bot, keyed by the secret id so a rotation
 * invalidates the cache without an extra lookup.
 */
type CallbackSecretCache = Map<string, { secretId: string; plaintext: string | null }>;
const secretCache: CallbackSecretCache = new Map();

export type WebhookReplyDeps = {
  prisma: {
    run: {
      findUnique: (args: {
        where: { id: string };
        select: {
          id: true;
          status: true;
          error: true;
          trigger: true;
          webhookReplyDeliveredAt: true;
          bot: {
            select: {
              id: true;
              spaceId: true;
              webhookCallbackUrl: true;
              webhookSecretId: true;
            };
          };
        };
      }) => Promise<{
        id: string;
        status: string;
        error: string | null;
        trigger: string;
        webhookReplyDeliveredAt: Date | null;
        bot: {
          id: string;
          spaceId: string;
          webhookCallbackUrl: string | null;
          webhookSecretId: string | null;
        };
      } | null>;
      updateMany: (args: {
        where: { id: string; webhookReplyDeliveredAt: null };
        data: { webhookReplyDeliveredAt: Date };
      }) => Promise<{ count: number }>;
    };
    secret: {
      findUnique: (args: {
        where: { id: string };
        select: { id: true; ciphertext: true };
      }) => Promise<{ id: string; ciphertext: string } | null>;
    };
    message: Parameters<typeof botRunOutcomeText>[0]["message"];
  };
  secrets: SecretStore;
  fetchImpl?: typeof globalThis.fetch;
  now?: () => Date;
  signal?: AbortSignal;
};

/** Bind the reply to its run, bot, and delivery time so a replayed body is not a new event. */
export function webhookReplySignature(
  secret: string,
  timestampSeconds: number,
  rawBody: string,
): string {
  return createHmac("sha256", secret).update(`${timestampSeconds}.${rawBody}`).digest("hex");
}

export function webhookReplyHeaders(
  secret: string,
  rawBody: string,
  now: Date,
): Record<string, string> {
  const timestampSeconds = Math.floor(now.getTime() / 1000);
  return {
    "content-type": "application/json",
    "x-rakazo-signature": `t=${timestampSeconds},v1=${webhookReplySignature(secret, timestampSeconds, rawBody)}`,
  };
}

async function loadCallbackSecret(
  deps: WebhookReplyDeps,
  botId: string,
  secretId: string,
): Promise<string | null> {
  const cached = secretCache.get(botId);
  if (cached && cached.secretId === secretId) return cached.plaintext;

  const row = await deps.prisma.secret.findUnique({
    where: { id: secretId },
    select: { id: true, ciphertext: true },
  });
  if (!row) {
    secretCache.set(botId, { secretId, plaintext: null });
    return null;
  }

  let plaintext: string | null = null;
  try {
    plaintext = await deps.secrets.load(row.ciphertext, row.id);
  } catch {
    plaintext = null;
  }
  secretCache.set(botId, { secretId, plaintext });
  return plaintext;
}

/**
 * POST a webhook-triggered run's reply to the bot's callback URL. Returns
 * without a network call when there is nothing to deliver, so the caller can
 * treat it as fire-and-forget. Throws when the receiver fails or rejects, so
 * the job executor applies its backoff.
 */
export async function deliverWebhookReply(
  deps: WebhookReplyDeps,
  runId: string,
): Promise<"delivered" | "skipped"> {
  const run = await deps.prisma.run.findUnique({
    where: { id: runId },
    select: {
      id: true,
      status: true,
      error: true,
      trigger: true,
      webhookReplyDeliveredAt: true,
      bot: {
        select: {
          id: true,
          spaceId: true,
          webhookCallbackUrl: true,
          webhookSecretId: true,
        },
      },
    },
  });

  // A run deleted mid-flight, or one already delivered, needs no work.
  if (!run || run.webhookReplyDeliveredAt) return "skipped";
  if (run.trigger !== "webhook") return "skipped";
  if (run.status !== "completed" && run.status !== "failed") return "skipped";

  const callbackUrl = run.bot.webhookCallbackUrl;
  if (!callbackUrl) return "skipped";

  const secret = run.bot.webhookSecretId
    ? await loadCallbackSecret(deps, run.bot.id, run.bot.webhookSecretId)
    : null;
  // Without a secret the receiver cannot authenticate us; delivering unsigned
  // would be worse than not delivering, so leave the run unmarked and surface it.
  if (!secret) throw new Error(`webhook reply for run ${runId} has no signing secret`);

  const outcome = await botRunOutcomeText(deps.prisma, runId);
  const now = deps.now?.() ?? new Date();
  const body = JSON.stringify({
    runId: run.id,
    botId: run.bot.id,
    status: run.status,
    reply: outcome.text,
    error: run.error ?? null,
  });

  const response = await fetchSafeHttpRequest(
    callbackUrl,
    {
      method: "POST",
      headers: webhookReplyHeaders(secret, body, now),
      body,
    },
    {
      timeoutMs: 15_000,
      ...(deps.fetchImpl ? { fetch: deps.fetchImpl } : {}),
      ...(deps.signal ? { signal: deps.signal } : {}),
    },
  );

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`webhook reply for run ${runId} got HTTP ${response.status}`);
  }

  // Only the first delivery may stamp the run; a concurrent duplicate then
  // becomes a no-op instead of a second POST.
  const stamped = await deps.prisma.run.updateMany({
    where: { id: runId, webhookReplyDeliveredAt: null },
    data: { webhookReplyDeliveredAt: now },
  });
  return stamped.count > 0 ? "delivered" : "skipped";
}
