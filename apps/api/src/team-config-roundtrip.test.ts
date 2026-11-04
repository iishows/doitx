import type { Actor, TeamConfigFile } from "@rakazo/contracts";
import {
  TEAM_CONFIG_MANIFEST_PATH,
  TeamConfigFilesSchema,
  teamConfigBotPath,
  teamConfigSkillPath,
} from "@rakazo/contracts";
import { parseTeamConfig } from "@rakazo/core";
import { buildTeamConfig, type TeamConfigExportSource } from "@rakazo/db";
import { describe, expect, it } from "vitest";
import type { AgentImportServices } from "./agent-import.js";
import { buildTeamConfigBot } from "./team-config-import.js";

/**
 * The export side and the import side are written independently, so this pins the round trip:
 * a workspace exported to an archive and read back must yield the same bot configuration. It is
 * the only test that would catch the two halves drifting apart.
 */

const actor: Actor = {
  userId: "user-1",
  spaceId: "space-1",
  email: "user@example.test",
  isDeploymentOwner: false,
};

function services(overrides: Partial<AgentImportServices> = {}): AgentImportServices {
  return {
    prisma: { user: { findUnique: async () => ({ timezone: "UTC" }) } } as never,
    createBot: async () => {
      throw new Error("not used");
    },
    hasModelConnection: async () => true,
    connectedProviders: async () => new Set(),
    mcpCredentialValues: async () => null,
    validateBotModel: async () => null,
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

const source: TeamConfigExportSource = {
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
      memoryScope: null,
      modelProvider: "anthropic",
      modelId: "claude-sonnet-5-5",
      thinkingLevel: null,
      disabledBuiltinTools: [],
      teamChatAmbientEnabled: false,
      teamChatRules: "",
      crossSpaceCommunication: false,
      browserProxyEnabled: false,
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
        { server: { name: "linear", command: "npx linear-mcp", endpoint: null, secretId: null } },
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
  connections: [],
  modelPreferences: [],
  approvalRules: [],
};

/** Assemble the archive the exporter would write, then read it back the way an importer does. */
function roundTrip(input: TeamConfigExportSource = source): TeamConfigFile[] {
  const { manifest, bots, skills } = buildTeamConfig(input);
  return [
    { path: TEAM_CONFIG_MANIFEST_PATH, content: JSON.stringify(manifest) },
    ...bots.map((bot) => ({
      path: teamConfigBotPath(bot.key),
      content: JSON.stringify(bot),
    })),
    ...skills.map((skill) => ({
      path: teamConfigSkillPath(skill.key),
      content: skill.content,
    })),
  ];
}

describe("team-config round trip", () => {
  it("reads back the bot the exporter wrote", async () => {
    const parsed = parseTeamConfig(roundTrip());
    const entry = parsed.manifest.bots[0]!;
    const built = await buildTeamConfigBot(services(), actor, parsed.bots.get(entry.key)!);

    expect(built.plan.suggestedName).toBe("Writer");
    expect(built.plan.suggestedDescription).toBe("Writes copy");
    expect(built.plan.instructions[0]?.content).toBe("Be concise.");
    expect(built.plan.model).toMatchObject({
      provider: "anthropic",
      modelId: "claude-sonnet-5-5",
      status: "ready",
    });
  });

  it("keeps a routine's schedule and prompt across the round trip", async () => {
    const parsed = parseTeamConfig(roundTrip());
    const entry = parsed.manifest.bots[0]!;
    const built = await buildTeamConfigBot(services(), actor, parsed.bots.get(entry.key)!);

    const routine = built.routineInputs.get(built.plan.routines[0]!.id);
    expect(routine).toMatchObject({
      name: "Morning digest",
      prompt: "Summarize the news.",
      crons: ["0 9 * * *"],
      timezone: "Asia/Shanghai",
    });
  });

  it("keeps an MCP server's command across the round trip", async () => {
    const parsed = parseTeamConfig(roundTrip());
    const entry = parsed.manifest.bots[0]!;
    const built = await buildTeamConfigBot(services(), actor, parsed.bots.get(entry.key)!);

    const server = [...built.mcpConfigs.values()][0];
    expect(server?.config).toMatchObject({
      transport: "stdio",
      command: "npx",
      args: ["linear-mcp"],
    });
  });

  it("round-trips a skill, body included", () => {
    const parsed = parseTeamConfig(roundTrip());

    expect(parsed.manifest.skills[0]?.name).toBe("House style");
    expect(parsed.skills.get(parsed.manifest.skills[0]!.key)?.content).toBe(
      "# House style\n\nBe terse.",
    );
  });

  it("imports a skill at the size the skill editor itself allows", () => {
    // The body is the whole point of the split: a full-size skill used to push the manifest past
    // the per-file limit, so the archive exported fine and was then rejected on import.
    const heading = "# Long\n\n";
    const content = `${heading}${"x".repeat(100_000 - heading.length)}`;
    const files = roundTrip({
      ...source,
      skills: [{ name: "Long", description: "Big", content }],
    });

    expect(TeamConfigFilesSchema.safeParse(files).success).toBe(true);
    const parsed = parseTeamConfig(files);
    expect(parsed.skills.get(parsed.manifest.skills[0]!.key)?.content).toBe(content);
  });

  it("carries no credential-shaped value in the archive", () => {
    // The exporter's allow-list is the guard; this asserts an archive with credentials in the
    // source still ships none of them.
    const withSecrets = buildTeamConfig({
      ...source,
      connections: [
        { provider: "slack", displayName: "Slack", providerRef: "T1", secretId: "secret-1" },
      ],
      bots: [
        {
          ...source.bots[0]!,
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
    });
    const bytes = JSON.stringify(withSecrets);
    expect(bytes).not.toContain("secret-1");
    expect(bytes).not.toContain("sec-live");
  });
});
