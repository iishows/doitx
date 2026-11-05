import { describe, expect, it } from "vitest";
import {
  TEAM_CONFIG_FORMAT,
  TEAM_CONFIG_MAX_BOTS,
  TEAM_CONFIG_VERSION,
  TeamConfigBotSchema,
  TeamConfigManifestSchema,
  TeamConfigManifestV2Schema,
  TeamConfigManifestV3Schema,
  TeamConfigSelectionSchema,
} from "./team-config.js";

const bot = {
  key: "bot:writer",
  name: "Writer",
  description: "",
  instructions: "Write things.",
  color: "#123456",
  avatarSet: "organic" as const,
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
  browserProxyEnabled: false,
  sectionKey: null,
  routines: [],
  mcpServers: [],
};

const manifest = {
  format: TEAM_CONFIG_FORMAT,
  version: TEAM_CONFIG_VERSION,
  exportedAt: "2026-11-06T00:00:00.000Z",
  sourceWorkspace: "My Workspace",
  bots: [{ key: "bot:writer", name: "Writer", warnings: [] }],
  sections: [],
  connections: [],
};

describe("team config manifest", () => {
  it("accepts a minimal archive", () => {
    expect(TeamConfigManifestSchema.safeParse(manifest).success).toBe(true);
  });

  it("rejects an archive that is not ours, even when the rest looks right", () => {
    // The format tag is what stops an account export zip from being read as a team config.
    expect(
      TeamConfigManifestSchema.safeParse({ ...manifest, format: "rakazo-account-export" }).success,
    ).toBe(false);
    expect(TeamConfigManifestSchema.safeParse({ ...manifest, format: undefined }).success).toBe(
      false,
    );
  });

  it("rejects an unknown archive version so a newer exporter cannot be half-read", () => {
    expect(TeamConfigManifestSchema.safeParse({ ...manifest, version: 1 }).success).toBe(false);
    expect(
      TeamConfigManifestSchema.safeParse({ ...manifest, version: TEAM_CONFIG_VERSION + 1 }).success,
    ).toBe(false);
    expect(
      TeamConfigManifestSchema.safeParse({ ...manifest, version: String(TEAM_CONFIG_VERSION) })
        .success,
    ).toBe(false);
  });

  it("keeps a version 3 manifest readable", () => {
    const v3 = { ...manifest, version: 3 };
    expect(TeamConfigManifestV3Schema.safeParse(v3).success).toBe(true);
    // The current schema only accepts the version it writes.
    expect(TeamConfigManifestSchema.safeParse(v3).success).toBe(false);
  });

  it("keeps a version 2 manifest readable, with its inlined skill bodies", () => {
    const v2 = {
      ...manifest,
      version: 2,
      skills: [{ key: "skill:style", name: "Style", description: "", content: "# Style" }],
    };
    expect(TeamConfigManifestV2Schema.safeParse(v2).success).toBe(true);
    // The current schema expects a summary plus a separate file, so it does not read the old shape.
    expect(TeamConfigManifestSchema.safeParse(v2).success).toBe(false);
  });

  it("keeps a skill body out of the manifest", () => {
    expect(
      TeamConfigManifestSchema.safeParse({
        ...manifest,
        skills: [{ key: "skill:style", name: "Style", description: "", content: "# Style" }],
      }).success,
    ).toBe(false);
  });

  it("requires the fields the preview reads and defaults the warning list", () => {
    expect(TeamConfigManifestSchema.safeParse({}).success).toBe(false);
    const parsed = TeamConfigManifestSchema.safeParse({
      ...manifest,
      bots: [{ key: "bot:writer", name: "Writer" }],
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error("expected the manifest to parse");
    expect(parsed.data.bots[0]?.warnings).toEqual([]);
  });

  it("rejects a manifest whose bot list exceeds the archive ceiling", () => {
    const bots = Array.from({ length: TEAM_CONFIG_MAX_BOTS + 1 }, (_, index) => ({
      key: `bot:${index}`,
      name: `Bot ${index}`,
      warnings: [],
    }));
    expect(TeamConfigManifestSchema.safeParse({ ...manifest, bots }).success).toBe(false);
  });
});

describe("team config bot", () => {
  it("accepts a bot with no optional configuration", () => {
    expect(TeamConfigBotSchema.safeParse(bot).success).toBe(true);
  });

  it("has no field that could carry a credential", () => {
    // A bot row holds a webhook secret and a browser-proxy ciphertext; neither may appear here.
    for (const forbidden of [
      "webhookSecretId",
      "browserProxyCiphertext",
      "browserProxy",
      "secretId",
      "apiKey",
      "token",
      "ciphertext",
    ]) {
      expect(TeamConfigBotSchema.safeParse({ ...bot, [forbidden]: "x" }).success).toBe(false);
    }
  });

  it("keeps an MCP server's command and endpoint but no environment or headers", () => {
    const parsed = TeamConfigBotSchema.safeParse({
      ...bot,
      mcpServers: [
        {
          key: "mcp:linear",
          name: "linear",
          command: "npx linear-mcp",
          endpoint: "https://mcp.linear.app",
        },
      ],
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error("expected the bot to parse");
    expect(parsed.data.mcpServers[0]?.endpoint).toBe("https://mcp.linear.app");
    // `requiresCredentials` is defaulted rather than required, so an exporter cannot forget it.
    expect(parsed.data.mcpServers[0]?.requiresCredentials).toBe(false);

    // The credential-bearing columns are rejected outright, so a careless exporter cannot smuggle
    // them in by adding a field the mapper happens to read.
    for (const leaked of [
      { env: { LINEAR_KEY: "x" } },
      { headers: { authorization: "Bearer x" } },
      { secretId: "sec-live" },
      { url: "https://mcp.linear.app" },
    ]) {
      const withLeak = TeamConfigBotSchema.safeParse({
        ...bot,
        mcpServers: [{ key: "mcp:linear", name: "linear", ...leaked }],
      });
      expect(withLeak.success, `expected ${Object.keys(leaked)[0]} to be rejected`).toBe(false);
    }
  });
});

describe("team config selection", () => {
  it("accepts an empty selection, meaning the user ticked nothing", () => {
    expect(TeamConfigSelectionSchema.safeParse({ keys: [] }).success).toBe(true);
  });

  it("rejects a selection larger than the archive could hold", () => {
    const keys = Array.from({ length: TEAM_CONFIG_MAX_BOTS + 1 }, (_, index) => `bot:${index}`);
    expect(TeamConfigSelectionSchema.safeParse({ keys }).success).toBe(false);
  });
});
