import { SecretStoreUnavailableError } from "@rakazo/adapter-kit";
import { botRunOutcomeText } from "@rakazo/adapters";
import { hasValidBearerToken } from "@rakazo/core";
import type { Hono } from "hono";
import { mountGithubWebhookRoute } from "./github-webhook.js";
import { readBoundedBody } from "./http-body.js";
import type { WebhookDeps, WebhookSecretCache } from "./webhook-inbound.js";
import {
  deliverWebhookEvent,
  formatWebhookPrompt,
  loadWebhookTarget,
  parseWebhookPayload,
  WEBHOOK_MAX_BODY_BYTES,
} from "./webhook-inbound.js";

export {
  formatGithubEventPrompt,
  githubEventName,
  githubWebhookPath,
  hasValidGithubSignature,
} from "./github-webhook.js";
export {
  formatUntrustedDeliveryPayload,
  formatWebhookPrompt,
  WEBHOOK_MAX_BODY_BYTES,
  WEBHOOK_SECRET_KIND,
  type WebhookDeps,
  type WebhookEvents,
  type WebhookTarget,
} from "./webhook-inbound.js";

export function webhookPath(botId: string): string {
  return `/api/v1/bots/${botId}/webhook`;
}

export function webhookReplyPath(botId: string, runId: string): string {
  return `/api/v1/bots/${botId}/webhook/replies/${runId}`;
}

export function mountWebhookHttpRoutes(app: Hono, deps: WebhookDeps) {
  const secretCache: WebhookSecretCache = new Map();

  app.post("/api/v1/bots/:botId/webhook", async (c) => {
    const unauthorized = () => c.json({ error: "Unauthorized" }, 401);

    // Reject oversized bodies before target lookup so size limits do not reveal active bots.
    const raw = await readBoundedBody(c.req.raw, WEBHOOK_MAX_BODY_BYTES);
    if (raw === null) {
      return c.json({ error: "Payload too large" }, 413);
    }

    let target: Awaited<ReturnType<typeof loadWebhookTarget>>;
    try {
      target = await loadWebhookTarget(deps, secretCache, c.req.param("botId"));
    } catch (error) {
      if (error instanceof SecretStoreUnavailableError) {
        return c.json({ error: "Service unavailable" }, 503);
      }
      throw error;
    }

    // Same 401 for missing bot, missing secret, and bad bearer so bot ids are not enumerable.
    if (!target || !hasValidBearerToken(c.req.header("authorization"), target.expected)) {
      return unauthorized();
    }

    const payload = parseWebhookPayload(raw, c.req.header("content-type"));
    const eventPrompt = formatWebhookPrompt(payload);

    const webhookRoutines = await deps.prisma.routine.findMany({
      where: {
        botId: target.bot.id,
        spaceId: target.bot.spaceId,
        active: true,
        webhookEnabled: true,
      },
      select: {
        id: true,
        name: true,
        prompt: true,
        modelProvider: true,
        modelId: true,
        thinkingLevel: true,
      },
      orderBy: { updatedAt: "desc" },
      take: 5,
    });

    const idempotencyKey =
      c.req.header("idempotency-key")?.trim() ||
      c.req.header("x-idempotency-key")?.trim() ||
      (typeof payload.id === "string" ? payload.id.trim() : "") ||
      (typeof payload.event_id === "string" ? payload.event_id.trim() : "") ||
      undefined;

    return c.json(
      await deliverWebhookEvent(deps, target, {
        prompt: eventPrompt,
        routines: webhookRoutines,
        source: "webhook",
        idempotencyKey,
      }),
    );
  });

  mountGithubWebhookRoute(app, deps, secretCache);

  app.get("/api/v1/bots/:botId/webhook/replies/:runId", async (c) => {
    // Missing bot, missing secret, and bad bearer share one 401 so bot ids stay unenumerable.
    const notFound = () => c.json({ error: "Not found" }, 404);

    let target: Awaited<ReturnType<typeof loadWebhookTarget>>;
    try {
      target = await loadWebhookTarget(deps, secretCache, c.req.param("botId"));
    } catch (error) {
      if (error instanceof SecretStoreUnavailableError) {
        return c.json({ error: "Service unavailable" }, 503);
      }
      throw error;
    }

    if (!target || !hasValidBearerToken(c.req.header("authorization"), target.expected)) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const run = await deps.prisma.run.findUnique({
      where: { id: c.req.param("runId") },
      select: { id: true, botId: true, spaceId: true, status: true, error: true, trigger: true },
    });

    // A run is only readable through the bot that owns it, and only if it came
    // from this webhook — otherwise a holder of one bot's secret could read
    // another bot's run by guessing an id. Mismatches are indistinguishable
    // from a missing run.
    if (!run || run.botId !== target.bot.id || run.spaceId !== target.bot.spaceId) {
      return notFound();
    }
    if (run.trigger !== "webhook") return notFound();

    const terminal = run.status === "completed" || run.status === "failed";
    const outcome = terminal ? await botRunOutcomeText(deps.prisma, run.id) : null;

    return c.json({
      runId: run.id,
      status: run.status,
      reply: outcome?.text ?? null,
      error: run.error ?? null,
    });
  });
}
