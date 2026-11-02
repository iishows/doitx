import { TEAM_CONFIG_VERSION, TeamConfigManifestSchema } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { buildTeamConfig, type TeamConfigExportSource } from "./team-config-export.js";

/**
 * A source shaped like a real workspace: bots in a section, a routine, a taught skill, an MCP server
 * that holds credentials, and an integration connection backed by a secret.
 */
function source(overrides: Partial<TeamConfigExportSource> = {}): TeamConfigExportSource {
  return {
    spaceName: "Marketing",
    exportedAt: "2026-11-06T00:00:00.000Z",
    sections: [{ id: "sec-1", name: "Content", position: 0 }],
    bots: [
      {
        id: "bot-1",
        name: "Writer",
        description: "Writes copy",
        instructions: "Be concise.",
        color: "#abcdef",
        avatarSet: "organic",
        notifyOnFinish: true,
        pinned: false,
        position: 0,
        memoryScope: "space",
        modelProvider: "anthropic",
        modelId: "claude-sonnet-5-5",
        thinkingLevel: "medium",
        disabledBuiltinTools: ["web_search"],
        teamChatAmbientEnabled: true,
        teamChatRules: "Stay on topic.",
        crossSpaceCommunication: false,
        browserProxyEnabled: true,
        sectionId: "sec-1",
        routines: [
          {
            name: "Morning digest",
            prompt: "Summarize the news.",
            crons: ["0 9 * * *"],
            timezone: "Asia/Shanghai",
            active: true,
            notify: true,
            webhookEnabled: false,
            githubEnabled: false,
            modelProvider: null,
            modelId: null,
            thinkingLevel: null,
          },
        ],
        mcpServers: [
          {
            server: {
              name: "linear",
              command: "npx linear-mcp",
              endpoint: null,
              secretId: "sec-live",
            },
          },
        ],
      },
    ],
    skills: [
      {
        name: "House style",
        description: "Our tone of voice",
        content: "# House style\n\nBe terse.",
      },
    ],
    connections: [
      {
        provider: "slack",
        displayName: "Marketing Slack",
        providerRef: "T0123",
        secretId: "secret-1",
      },
    ],
    modelPreferences: [
      { provider: "anthropic", modelId: "claude-sonnet-5-5", thinkingLevel: "medium" },
    ],
    approvalRules: [{ effect: "allow", matchKind: "tool", matchValue: "read_file" }],
    ...overrides,
  };
}

describe("buildTeamConfig", () => {
  it("produces a manifest the importer's schema accepts", () => {
    const { manifest } = buildTeamConfig(source());
    expect(manifest.version).toBe(TEAM_CONFIG_VERSION);
    const parsed = TeamConfigManifestSchema.safeParse(manifest);
    expect(parsed.success).toBe(true);
  });

  it("carries the bot's configuration, routines and MCP declaration", () => {
    const { bots, manifest } = buildTeamConfig(source());
    expect(bots).toHaveLength(1);
    const bot = bots[0]!;
    expect(bot.name).toBe("Writer");
    expect(bot.instructions).toBe("Be concise.");
    expect(bot.disabledBuiltinTools).toEqual(["web_search"]);
    expect(bot.sectionKey).toBe("section:content");
    expect(bot.routines[0]?.crons).toEqual(["0 9 * * *"]);
    expect(bot.routines[0]?.active).toBe(true);
    expect(bot.mcpServers[0]?.name).toBe("linear");
    // Skills are space-scoped, so they sit at the manifest level rather than on the bot.
    expect(manifest.skills[0]?.name).toBe("House style");
  });

  it("marks an exported MCP server as needing credentials the user must supply", () => {
    const { bots } = buildTeamConfig(source());
    expect(bots[0]!.mcpServers[0]?.requiresCredentials).toBe(true);
  });

  it("maps a bot's section to the exported section key and drops an unknown section", () => {
    const { bots, manifest } = buildTeamConfig(
      source({ bots: [{ ...source().bots[0]!, sectionId: "ghost" }] }),
    );
    expect(bots[0]!.sectionKey).toBeNull();
    expect(manifest.sections).toHaveLength(1);
  });

  it("slugs a non-Latin bot name without producing an empty key", () => {
    const { bots } = buildTeamConfig(
      source({ bots: [{ ...source().bots[0]!, name: "文案助手" }] }),
    );
    expect(bots[0]!.key).toBe("bot:bot-1");
  });

  it("truncates past the archive ceiling and says so", () => {
    const many = Array.from({ length: 201 }, (_, index) => ({
      ...source().bots[0]!,
      id: `bot-${index}`,
      name: `Bot ${index}`,
    }));
    const result = buildTeamConfig(source({ bots: many }));
    expect(result.truncated).toBe(true);
    expect(result.bots).toHaveLength(200);
  });
});

describe("team config export never leaks a credential", () => {
  // Values that look like the credentials this workspace actually stores. If any of them survives
  // into the serialized archive, a mapper above is reading a column it should not.
  const secretValues = [
    "sk-ant-api03-" + "REDACTED".repeat(4),
    "SLACK_TOKEN_" + "x".repeat(33),
    "GITHUB_TOKEN_" + "x".repeat(30),
    "postgres://user:hunter2@db.internal:5432/app",
  ] as const;

  it("emits none of the credential-shaped values planted on the source rows", () => {
    const { manifest, bots } = buildTeamConfig(
      source({
        bots: [
          {
            ...source().bots[0]!,
            // Planted on the real columns the row carries. Each must stay behind.
            browserProxyUrl: "http://user:hunter2@proxy.internal:8080",
            browserProxyCiphertext: secretValues[0],
            webhookSecretId: secretValues[1],
          },
        ],
        connections: [{ ...source().connections[0]!, secretId: secretValues[2] }],
      }),
    );
    const serialized = JSON.stringify({ manifest, bots });
    for (const value of secretValues) {
      expect(serialized).not.toContain(value);
    }
  });

  it("drops the connection's secretId, keeping only metadata", () => {
    const { manifest } = buildTeamConfig(source());
    const serialized = JSON.stringify(manifest);
    expect(serialized).not.toContain("secret-1");
    expect(serialized).not.toContain("secretId");
    expect(manifest.connections[0]).toEqual({
      key: "connection:slack",
      provider: "slack",
      displayName: "Marketing Slack",
      providerRef: "T0123",
    });
  });

  it("keeps only the browser-proxy on/off flag, never a proxy URL that may embed a password", () => {
    const { bots } = buildTeamConfig(
      source({
        bots: [
          {
            ...source().bots[0]!,
            browserProxyEnabled: true,
            browserProxyUrl: "http://user:hunter2@proxy.internal:8080",
          },
        ],
      }),
    );
    const serialized = JSON.stringify(bots);
    expect(bots[0]!.browserProxyEnabled).toBe(true);
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("browserProxyUrl");
  });
});
