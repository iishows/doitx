import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { WebhookReplyDeps } from "./webhook-reply.js";
import { deliverWebhookReply, webhookReplyHeaders } from "./webhook-reply.js";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]),
}));

const CALLBACK = "https://receiver.example.test/hooks/run";
const SECRET = "callback-secret-value";

type RunRow = {
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
};

function runRow(overrides: Partial<RunRow> = {}, bot: Partial<RunRow["bot"]> = {}): RunRow {
  return {
    id: "run-1",
    status: "completed",
    error: null,
    trigger: "webhook",
    webhookReplyDeliveredAt: null,
    bot: {
      id: "bot-1",
      spaceId: "space-1",
      webhookCallbackUrl: CALLBACK,
      webhookSecretId: "secret-1",
      ...bot,
    },
    ...overrides,
  };
}

function deps(
  options: {
    run?: RunRow | null;
    secretCiphertext?: string | null;
    plaintext?: string | null;
    messages?: Array<{ blocks: unknown; clientNonce: string | null }>;
    stampCount?: number;
    now?: Date;
  } = {},
) {
  const findUnique = vi.fn(async () => options.run ?? null);
  const updateMany = vi.fn(async () => ({ count: options.stampCount ?? 1 }));
  const secretFindUnique = vi.fn(async () =>
    options.secretCiphertext === null ? null : { id: "secret-1", ciphertext: "sealed-ref" },
  );
  const messageFindMany = vi.fn(async () => options.messages ?? []);
  const load = vi.fn(async () => options.plaintext ?? SECRET);
  const fetchImpl = vi.fn(async () => new Response("ok", { status: 200 }));
  const now = options.now ?? new Date("2026-03-01T12:00:00.000Z");

  const prisma = {
    run: { findUnique, updateMany },
    secret: { findUnique: secretFindUnique },
    message: { findMany: messageFindMany },
  };
  const secrets = { load };

  return {
    deps: {
      prisma,
      secrets,
      fetchImpl,
      now: () => now,
    } as unknown as WebhookReplyDeps,
    findUnique,
    updateMany,
    messageFindMany,
    load,
    fetchImpl,
    now,
  };
}

function textBlocks(...texts: string[]) {
  return texts.map((text) => ({ kind: "text", text }));
}

describe("deliverWebhookReply", () => {
  it("posts the run outcome to the callback URL and stamps the run", async () => {
    // Unique bot id: the module caches decrypted secrets per bot.
    const harness = deps({
      run: runRow({ id: "run-deliver" }, { id: "bot-deliver" }),
      messages: [{ blocks: textBlocks("deploy finished"), clientNonce: null }],
    });

    await expect(deliverWebhookReply(harness.deps, "run-deliver")).resolves.toBe("delivered");

    expect(harness.fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = harness.fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(CALLBACK);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      runId: "run-deliver",
      botId: "bot-deliver",
      status: "completed",
      reply: "deploy finished",
      error: null,
    });
    expect(harness.updateMany).toHaveBeenCalledWith({
      where: { id: "run-deliver", webhookReplyDeliveredAt: null },
      data: { webhookReplyDeliveredAt: harness.now },
    });
    expect(harness.load).toHaveBeenCalledWith("sealed-ref", "secret-1");
  });

  it("signs the body so the receiver can verify it", async () => {
    const harness = deps({ run: runRow({ id: "run-sign" }, { id: "bot-sign" }) });

    await deliverWebhookReply(harness.deps, "run-sign");

    const [, init] = harness.fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    const body = String(init.body);
    const timestamp = Math.floor(harness.now.getTime() / 1000);
    const expected = createHmac("sha256", SECRET).update(`${timestamp}.${body}`).digest("hex");

    expect(headers["content-type"]).toBe("application/json");
    expect(headers["x-rakazo-signature"]).toBe(`t=${timestamp},v1=${expected}`);
    expect(webhookReplyHeaders(SECRET, body, harness.now)["x-rakazo-signature"]).toBe(
      headers["x-rakazo-signature"],
    );
  });

  it("sends the failure reason for a failed run", async () => {
    const harness = deps({
      run: runRow(
        { id: "run-failed", status: "failed", error: "sandbox crashed" },
        { id: "bot-failed" },
      ),
    });

    await deliverWebhookReply(harness.deps, "run-failed");

    const [, init] = harness.fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({
      status: "failed",
      error: "sandbox crashed",
      reply: "",
    });
  });

  it("prefers the latest final reply over earlier narration", async () => {
    const harness = deps({
      run: runRow({ id: "run-progress" }, { id: "bot-progress" }),
      messages: [
        { blocks: textBlocks("looking at it"), clientNonce: null },
        { blocks: textBlocks("step one"), clientNonce: "user-progress:1" },
        { blocks: textBlocks("all green"), clientNonce: null },
      ],
    });

    await deliverWebhookReply(harness.deps, "run-progress");

    const [, init] = harness.fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body)).reply).toBe("all green");
  });

  it("does nothing when the run was already delivered", async () => {
    const harness = deps({
      run: runRow({ id: "run-done", webhookReplyDeliveredAt: new Date() }, { id: "bot-done" }),
    });

    await expect(deliverWebhookReply(harness.deps, "run-done")).resolves.toBe("skipped");
    expect(harness.fetchImpl).not.toHaveBeenCalled();
    expect(harness.updateMany).not.toHaveBeenCalled();
  });

  it("does nothing for a run that was not triggered by a webhook", async () => {
    const harness = deps({
      run: runRow({ id: "run-chat", trigger: "chat" }, { id: "bot-chat" }),
    });

    await expect(deliverWebhookReply(harness.deps, "run-chat")).resolves.toBe("skipped");
    expect(harness.fetchImpl).not.toHaveBeenCalled();
  });

  it("does nothing while the run is still in flight", async () => {
    const harness = deps({
      run: runRow({ id: "run-live", status: "running" }, { id: "bot-live" }),
    });

    await expect(deliverWebhookReply(harness.deps, "run-live")).resolves.toBe("skipped");
    expect(harness.fetchImpl).not.toHaveBeenCalled();
  });

  it("does nothing when the bot has no callback URL", async () => {
    const harness = deps({
      run: runRow({ id: "run-no-url" }, { id: "bot-no-url", webhookCallbackUrl: null }),
    });

    await expect(deliverWebhookReply(harness.deps, "run-no-url")).resolves.toBe("skipped");
    expect(harness.fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses to deliver unsigned when the signing secret cannot be loaded", async () => {
    const harness = deps({
      run: runRow({ id: "run-nosecret" }, { id: "bot-nosecret", webhookSecretId: null }),
    });

    await expect(deliverWebhookReply(harness.deps, "run-nosecret")).rejects.toThrow(
      "webhook reply for run run-nosecret has no signing secret",
    );
    expect(harness.fetchImpl).not.toHaveBeenCalled();
    expect(harness.updateMany).not.toHaveBeenCalled();
  });

  it("throws and leaves the run unstamped when the receiver rejects", async () => {
    const harness = deps({ run: runRow({ id: "run-500" }, { id: "bot-500" }) });
    harness.fetchImpl.mockResolvedValueOnce(new Response("nope", { status: 500 }));

    await expect(deliverWebhookReply(harness.deps, "run-500")).rejects.toThrow(
      "webhook reply for run run-500 got HTTP 500",
    );
    expect(harness.updateMany).not.toHaveBeenCalled();
  });

  it("does not fire twice when a concurrent delivery already stamped the run", async () => {
    const harness = deps({
      run: runRow({ id: "run-race" }, { id: "bot-race" }),
      stampCount: 0,
    });

    await expect(deliverWebhookReply(harness.deps, "run-race")).resolves.toBe("skipped");
  });
});
