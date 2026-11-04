import type { Actor, TeamConfigFile } from "@rakazo/contracts";
import {
  TEAM_CONFIG_FORMAT,
  TEAM_CONFIG_MANIFEST_PATH,
  TEAM_CONFIG_VERSION,
  teamConfigBotPath,
  teamConfigSkillPath,
} from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { AgentImportServices } from "./agent-import.js";
import { createTeamConfig, previewTeamConfig } from "./team-config-apply.js";

const actor: Actor = {
  userId: "user-1",
  spaceId: "space-1",
  email: "user@example.test",
  isDeploymentOwner: false,
};

const botBody = (key: string, name: string) => ({
  key,
  name,
  description: "",
  instructions: "Do the thing.",
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
});

interface SkillFixture {
  key: string;
  name: string;
  description: string;
  content: string;
}

/** An archive with the given bots and skills, so the test reads only what it needs. */
function archive(bots: Array<{ key: string; name: string }>, skills: SkillFixture[] = []) {
  const manifest = {
    format: TEAM_CONFIG_FORMAT,
    version: TEAM_CONFIG_VERSION,
    exportedAt: "2026-11-06T00:00:00.000Z",
    sourceWorkspace: "Marketing",
    bots: bots.map((bot) => ({ ...bot, warnings: [] })),
    sections: [],
    connections: [],
    skills: skills.map(({ key, name, description }) => ({ key, name, description })),
    modelPreferences: [],
    approvalRules: [],
  };
  return [
    { path: TEAM_CONFIG_MANIFEST_PATH, content: JSON.stringify(manifest) },
    ...bots.map((bot) => ({
      path: teamConfigBotPath(bot.key),
      content: JSON.stringify(botBody(bot.key, bot.name)),
    })),
    ...skills.map((skill) => ({
      path: teamConfigSkillPath(skill.key),
      content: skill.content,
    })),
  ] satisfies TeamConfigFile[];
}

/** A Prisma stand-in: reads the given rows, and records what a create wrote. */
function fakeDb(rows: Record<string, unknown[]> = {}) {
  const written: { model: string; data: unknown }[] = [];
  const model = (name: string) =>
    new Proxy(
      {},
      {
        get: (_, method: string) => async (args?: { data?: unknown }) => {
          if (method === "aggregate") return { _max: { position: null } };
          if (method === "findFirst" || method === "findUnique") return rows[name]?.[0] ?? null;
          if (method === "findMany") return rows[name] ?? [];
          if (method === "createMany" || method === "upsert") return { count: 0 };
          if (args && "data" in args) {
            written.push({ model: name, data: args.data });
            return { id: `${name}-1`, ...(args.data as object) };
          }
          return rows[name] ?? [];
        },
      },
    );
  return { prisma: new Proxy({}, { get: (_, name: string) => model(name) }) as never, written };
}

function services(overrides: Partial<AgentImportServices> = {}): {
  services: AgentImportServices;
  written: { model: string; data: unknown }[];
} {
  const { prisma, written } = fakeDb();
  return {
    written,
    services: {
      prisma,
      createBot: async () => {
        throw new Error("not used");
      },
      hasModelConnection: async () => false,
      connectedProviders: async () => new Set(),
      mcpCredentialValues: async () => null,
      validateBotModel: async () => "no",
      stdioAllowed: () => true,
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
    },
  };
}

describe("previewTeamConfig", () => {
  it("lists every bot the manifest names, with its warning and counts", async () => {
    const preview = await previewTeamConfig(services().services, actor, {
      files: archive([{ key: "bot:1", name: "Writer" }]),
    });
    expect(preview.sourceWorkspace).toBe("Marketing");
    expect(preview.bots).toEqual([
      expect.objectContaining({ key: "bot:1", name: "Writer", routines: 0, mcpServers: 0 }),
    ]);
  });

  it("writes nothing: a preview is safe to call as the user ticks bots", async () => {
    const { services: svc, written } = services();
    await previewTeamConfig(svc, actor, { files: archive([{ key: "bot:1", name: "Writer" }]) });
    expect(written).toEqual([]);
  });
});

describe("createTeamConfig", () => {
  it("creates only the bots the selection names", async () => {
    const createBot = vi.fn(async () => ({ id: "bot-1", name: "Writer" }) as never);
    const { services: svc } = services({ createBot });
    const result = await createTeamConfig(svc, actor, {
      files: archive([
        { key: "bot:1", name: "Writer" },
        { key: "bot:2", name: "Editor" },
      ]),
      selection: { keys: ["bot:1"] },
    });
    expect(createBot).toHaveBeenCalledTimes(1);
    expect(result.created).toEqual([{ key: "bot:1", name: "Writer" }]);
  });

  it("writes a skill's body, which only exists in its own file", async () => {
    const { services: svc, written } = services();
    await createTeamConfig(svc, actor, {
      files: archive(
        [],
        [{ key: "skill:style", name: "Style", description: "Tone", content: "# Style" }],
      ),
      selection: { keys: [] },
    });

    expect(written).toContainEqual({
      model: "agentSkill",
      data: expect.objectContaining({ name: "Style", description: "Tone", content: "# Style" }),
    });
  });

  it("creates no bot when nothing is selected", async () => {
    const createBot = vi.fn(async () => ({ id: "bot-1" }) as never);
    const { services: svc } = services({ createBot });
    const result = await createTeamConfig(svc, actor, {
      files: archive([{ key: "bot:1", name: "Writer" }]),
      selection: { keys: [] },
    });
    expect(createBot).not.toHaveBeenCalled();
    expect(result.created).toEqual([]);
  });
});
