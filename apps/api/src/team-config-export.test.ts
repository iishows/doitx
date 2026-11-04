import { parseTeamConfig } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { unzipSync } from "fflate";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

import { mountTeamConfigExportRoute } from "./team-config-export.js";

// A stand-in for the space read, so the route can be exercised without a database. The real reader
// is covered by the db package's own tests.
const fakeSource = vi.hoisted(() => ({
  spaceName: "My Workspace",
  exportedAt: "2026-11-06T00:00:00.000Z",
  sections: [{ id: "sec-1", name: "Content", position: 0 }],
  bots: [
    {
      id: "bot-1",
      name: "Writer",
      description: "",
      instructions: "Be concise.",
      color: "#123456",
      avatarSet: "organic",
      notifyOnFinish: true,
      pinned: false,
      position: 0,
      memoryScope: null,
      modelProvider: null,
      modelId: null,
      thinkingLevel: null,
      disabledBuiltinTools: [],
      teamChatAmbientEnabled: false,
      teamChatRules: "",
      crossSpaceCommunication: false,
      browserProxyEnabled: true,
      // Credential-shaped columns: these must never reach the archive.
      browserProxyUrl: "http://user:hunter2@proxy.internal:8080",
      browserProxyCiphertext: "SENTINEL-CIPHERTEXT",
      webhookSecretId: "SENTINEL-SECRET-ID",
      sectionId: "sec-1",
      routines: [],
      mcpServers: [
        {
          server: {
            name: "linear",
            command: null,
            endpoint: "https://mcp.linear.app",
            secretId: "SENTINEL-MCP-SECRET",
          },
        },
      ],
    },
  ],
  skills: [{ name: "House style", description: "Our tone", content: "# House style\n\nBe terse." }],
  connections: [
    {
      provider: "github",
      displayName: "GitHub",
      providerRef: null,
      secretId: "SENTINEL-CONNECTION-SECRET",
    },
  ],
  modelPreferences: [],
  approvalRules: [],
}));

vi.mock("@rakazo/db", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  readTeamConfigSource: async () => fakeSource,
}));

const SCOPE = { userId: "user-1", spaceId: "space-1" };

function buildApp(options: { scope?: typeof SCOPE | null } = {}) {
  const consumeTeamConfigToken = vi.fn(async () => options.scope ?? null);
  const app = new Hono();
  mountTeamConfigExportRoute(app, {
    prisma: {} as PrismaClient,
    auth: { consumeTeamConfigToken } as never,
  });
  return { app, consumeTeamConfigToken };
}

describe("team-config export route", () => {
  it("streams a zip with the manifest, one file per bot and one per skill", async () => {
    const { app, consumeTeamConfigToken } = buildApp({ scope: SCOPE });

    const response = await app.request("/api/team-config/export?token=good");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/zip");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-disposition")).toContain(
      `attachment; filename="doitx-team-config-`,
    );
    expect(consumeTeamConfigToken).toHaveBeenCalledWith("good");

    const files = unzipSync(new Uint8Array(await response.arrayBuffer()));
    const names = Object.keys(files).sort();
    expect(names).toEqual([
      "bots/bot%3Awriter.json",
      "manifest.json",
      "skills/skill%3Ahouse%20style.md",
    ]);

    const manifest = JSON.parse(new TextDecoder().decode(files["manifest.json"]!));
    expect(manifest.format).toBe("rakazo-team-config");
    expect(manifest.version).toBe(3);
    expect(manifest.sourceWorkspace).toBe("My Workspace");
    expect(manifest.bots[0]?.key).toBe("bot:writer");
    // The manifest points at the skill but does not carry its body.
    expect(manifest.skills).toEqual([
      { key: "skill:house style", name: "House style", description: "Our tone" },
    ]);
    expect(new TextDecoder().decode(files["skills/skill%3Ahouse%20style.md"]!)).toBe(
      "# House style\n\nBe terse.",
    );

    const bot = JSON.parse(new TextDecoder().decode(files["bots/bot%3Awriter.json"]!));
    expect(bot.key).toBe("bot:writer");
    expect(bot.mcpServers[0]?.endpoint).toBe("https://mcp.linear.app");
    // The server carries a secret, so the importer must ask for one.
    expect(bot.mcpServers[0]?.requiresCredentials).toBe(true);

    // The names the zip wrote are the names the importer looks for, skill path included.
    const parsed = parseTeamConfig(
      Object.entries(files).map(([path, bytes]) => ({
        path,
        content: new TextDecoder().decode(bytes),
      })),
    );
    expect(parsed.bots.get("bot:writer")?.instructions).toBe("Be concise.");
    expect(parsed.skills.get("skill:house style")?.content).toBe("# House style\n\nBe terse.");
  });

  it("never writes a credential into the archive", async () => {
    const { app } = buildApp({ scope: SCOPE });

    const response = await app.request("/api/team-config/export?token=good");
    const files = unzipSync(new Uint8Array(await response.arrayBuffer()));
    const all = Object.values(files)
      .map((bytes) => new TextDecoder().decode(bytes))
      .join("\n");

    for (const sentinel of [
      "SENTINEL-CIPHERTEXT",
      "SENTINEL-SECRET-ID",
      "SENTINEL-MCP-SECRET",
      "SENTINEL-CONNECTION-SECRET",
      "hunter2",
    ]) {
      expect(all, `${sentinel} must not appear in the archive`).not.toContain(sentinel);
    }
    // The proxy URL embeds a password, so it is dropped while the on/off flag survives.
    expect(all).not.toContain("proxy.internal");
    expect(all).toContain('"browserProxyEnabled": true');
  });

  it("answers 410 and does not read the database when the token is not valid", async () => {
    const { app, consumeTeamConfigToken } = buildApp({ scope: null });

    const response = await app.request("/api/team-config/export?token=used");

    expect(response.status).toBe(410);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(consumeTeamConfigToken).toHaveBeenCalledWith("used");
  });
});
