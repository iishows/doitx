import type { Actor, TeamConfigBot } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import type { AgentImportServices } from "./agent-import.js";
import { buildTeamConfigBot } from "./team-config-import.js";

const actor: Actor = {
  userId: "user-1",
  spaceId: "space-1",
  email: "user@example.test",
  isDeploymentOwner: false,
};

function services(overrides: Partial<AgentImportServices> = {}): AgentImportServices {
  return {
    prisma: { user: { findUnique: async () => ({ timezone: "Europe/Berlin" }) } } as never,
    createBot: async () => {
      throw new Error("not used");
    },
    hasModelConnection: async () => false,
    connectedProviders: async () => new Set(),
    mcpCredentialValues: async () => null,
    validateBotModel: async () => "Connect that model provider first",
    stdioAllowed: () => true,
    mcpEndpointProblem: async () => null,
    prepareModelKey: async () => ({}),
    writeModelKey: async () => null,
    afterModelKey: () => undefined,
    prepareMcpServer: async () => null,
    insertMcpServer: async () => {
      throw new Error("not used");
    },
    findBot: async () => null,
    assertRoutineSchedule: () => undefined,
    routineNextRunAt: () => null,
    routineRowData: (_actor, input) => ({ ...input }) as never,
    announceRoutine: async () => undefined,
    notifyThread: async () => undefined,
    ...overrides,
  };
}

function bot(overrides: Partial<TeamConfigBot> = {}): TeamConfigBot {
  return {
    key: "chief",
    name: "Chief of Staff",
    description: "Keeps the calendar.",
    instructions: "Be brief.",
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
    browserProxyEnabled: false,
    sectionKey: null,
    routines: [],
    mcpServers: [],
    ...overrides,
  };
}

describe("buildTeamConfigBot", () => {
  it("maps the instructions into one working document", async () => {
    const built = await buildTeamConfigBot(services(), actor, bot());
    expect(built.plan.instructions).toEqual([
      expect.objectContaining({
        title: "instructions.md",
        content: "Be brief.",
        role: "working",
      }),
    ]);
    expect(built.plan.suggestedName).toBe("Chief of Staff");
    expect(built.plan.source).toBe("team-config");
  });

  it("carries no memory or skills: those are space-scoped", async () => {
    const built = await buildTeamConfigBot(services(), actor, bot());
    expect(built.plan.memory).toEqual([]);
    expect(built.plan.skills).toEqual([]);
  });

  it("reports a set field it cannot write instead of dropping it silently", async () => {
    const built = await buildTeamConfigBot(
      services(),
      actor,
      bot({ pinned: true, thinkingLevel: "high", teamChatRules: "Be nice." }),
    );
    const paths = built.plan.skipped.map((item) => item.path);
    expect(paths).toContain("Chief of Staff.pinned");
    expect(paths).toContain("Chief of Staff.thinkingLevel");
    expect(paths).toContain("Chief of Staff.teamChatRules");
  });

  it("does not report a field left at its default", async () => {
    const built = await buildTeamConfigBot(services(), actor, bot());
    expect(built.plan.skipped).toEqual([]);
  });

  it("builds an MCP server from a command, marking the ones that need credentials", async () => {
    const built = await buildTeamConfigBot(
      services(),
      actor,
      bot({
        mcpServers: [
          { key: "docs", name: "docs", command: "npx docs-server", requiresCredentials: true },
          { key: "search", name: "search", endpoint: "https://mcp.example.test/rpc" },
        ],
      }),
    );
    expect(built.plan.mcpServers.map((server) => server.name)).toEqual(["docs", "search"]);
    expect(built.plan.mcpServers[0]!.status.kind).toBe("needs_setup");
    expect(built.plan.mcpServers[1]!.status.kind).toBe("ready");
    expect(built.mcpConfigs.get("mcp:docs")?.config).toMatchObject({
      transport: "stdio",
      command: "npx",
      args: ["docs-server"],
    });
  });

  it("refuses a server with neither a command nor an endpoint", async () => {
    const built = await buildTeamConfigBot(
      services(),
      actor,
      bot({ mcpServers: [{ key: "empty", name: "empty", requiresCredentials: false }] }),
    );
    expect(built.plan.mcpServers[0]!.status).toEqual({
      kind: "unsupported",
      reason: "unsupported_command",
    });
    expect(built.mcpConfigs.size).toBe(0);
  });

  it("keeps a connector whose address this deployment refuses, as a setup item", async () => {
    const built = await buildTeamConfigBot(
      services({ mcpEndpointProblem: async () => "Connector URL resolves to a private address" }),
      actor,
      bot({
        mcpServers: [
          {
            key: "nas",
            name: "nas",
            endpoint: "https://mcp.home.example/rpc",
            requiresCredentials: true,
          },
        ],
      }),
    );
    expect(built.plan.mcpServers[0]!.status).toEqual({
      kind: "needs_setup",
      needs: [{ kind: "credentials", names: [] }, { kind: "endpoint" }],
    });
    expect(built.mcpConfigs.get("mcp:nas")?.config).toMatchObject({
      transport: "streamable_http",
      endpoint: "https://mcp.home.example/rpc",
    });
  });

  it("refuses a command this deployment does not run", async () => {
    const built = await buildTeamConfigBot(
      services({ stdioAllowed: () => false }),
      actor,
      bot({ mcpServers: [{ key: "docs", name: "docs", command: "npx docs-server" }] }),
    );
    expect(built.plan.mcpServers[0]!.status).toEqual({
      kind: "unsupported",
      reason: "unsupported_command",
    });
    expect(built.mcpConfigs.size).toBe(0);
  });

  it("falls back to the user's timezone when a routine names none", async () => {
    const built = await buildTeamConfigBot(
      services(),
      actor,
      bot({
        routines: [
          {
            key: "morning",
            name: "morning",
            prompt: "Say good morning",
            crons: ["0 9 * * *"],
            timezone: "",
            active: true,
            notify: true,
            webhookEnabled: false,
            githubEnabled: false,
            modelProvider: null,
            modelId: null,
            thinkingLevel: null,
          },
        ],
      }),
    );
    expect(built.plan.routines).toHaveLength(1);
    expect(built.routineInputs.get("routine:morning")).toMatchObject({
      name: "morning",
      crons: ["0 9 * * *"],
      timezone: "Europe/Berlin",
      // Imported routines start paused.
      active: false,
    });
  });

  it("marks a model needs_key when its provider has no connection", async () => {
    const built = await buildTeamConfigBot(
      services({ hasModelConnection: async () => false, validateBotModel: async () => "no" }),
      actor,
      bot({ modelProvider: "openrouter", modelId: "anthropic/claude-sonnet-4.6" }),
    );
    expect(built.plan.model).toMatchObject({
      provider: "openrouter",
      modelId: "anthropic/claude-sonnet-4.6",
      status: "needs_key",
    });
  });

  it("marks a model ready when the user can reach it", async () => {
    const built = await buildTeamConfigBot(
      services({ hasModelConnection: async () => true, validateBotModel: async () => null }),
      actor,
      bot({ modelProvider: "openrouter", modelId: "anthropic/claude-sonnet-4.6" }),
    );
    expect(built.plan.model?.status).toBe("ready");
  });

  it("never carries an API key: a team archive has none to give", async () => {
    const built = await buildTeamConfigBot(services(), actor, bot());
    expect(built.plan.apiKeys).toEqual([]);
    expect(built.settings).toBeNull();
  });
});
