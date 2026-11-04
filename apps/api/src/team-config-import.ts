import type { ImportedMcpServer } from "@rakazo/adapters";
import type {
  Actor,
  AgentImportNeed,
  AgentImportPlan,
  AgentImportStatus,
  CreateRoutineInput as CreateRoutineInputType,
  McpServerConfigInput,
  TeamConfigBot,
  TeamConfigMcpServer,
} from "@rakazo/contracts";
import { CreateRoutineInput, isValidTimeZone } from "@rakazo/contracts";
import { mcpServerImportable } from "@rakazo/core";
import type { AgentImportServices, Built } from "./agent-import.js";

/**
 * Turns one bot from a team-config archive into the same `Built` shape the vendor import
 * produces, so both are written by `materializeImportedBot` and obey the same validation.
 *
 * The payload is already structured — `buildTeamConfig` wrote it — so nothing is parsed here,
 * only mapped from the archive's field names to the plan's.
 */

/**
 * Fields a team archive carries that this import path does not write yet. They are reported as
 * skipped rather than dropped silently, so the checklist says what did not travel.
 */
const UNSUPPORTED_BOT_FIELDS = [
  "teamChatAmbientEnabled",
  "teamChatRules",
  "crossSpaceCommunication",
  "browserProxyEnabled",
  "memoryScope",
  "pinned",
  "position",
  "sectionKey",
  "thinkingLevel",
  "disabledBuiltinTools",
] as const;

function skippedBotFields(bot: TeamConfigBot): AgentImportPlan["skipped"] {
  return UNSUPPORTED_BOT_FIELDS.flatMap((field) => {
    const value = bot[field];
    // A flag left at its default (`false`, `0`, `""`, `[]`) is not a loss worth reporting;
    // only a value the user actually set is.
    const set = Array.isArray(value)
      ? value.length > 0
      : value !== null && value !== undefined && value !== false && value !== 0 && value !== "";
    return set ? [{ path: `${bot.name}.${field}`, reason: "unsupported" as const }] : [];
  });
}

/** The bot's instructions travel as one document; they were one document when exported. */
function instructionPlan(bot: TeamConfigBot): AgentImportPlan["instructions"] {
  const content = bot.instructions.trim();
  if (!content) return [];
  return [
    {
      id: "instructions:instructions.md",
      title: "instructions.md",
      content,
      role: "working",
      stock: false,
      mentions: [],
    },
  ];
}

/**
 * MCP servers as the preview shows them, plus the config each is saved from. A server whose
 * archive entry has neither a command nor an endpoint cannot be run here and is refused. An
 * address this deployment refuses is kept as a setup item instead: the archive still carries the
 * connector, and importing it must not fail the rest of the workspace.
 */
async function mcpServerPlan<PreparedKey>(
  services: AgentImportServices<PreparedKey>,
  bot: TeamConfigBot,
): Promise<{
  plans: AgentImportPlan["mcpServers"];
  configs: Map<string, ImportedMcpServer & { slug: string }>;
}> {
  const plans: AgentImportPlan["mcpServers"] = [];
  const configs = new Map<string, ImportedMcpServer & { slug: string }>();
  for (const server of bot.mcpServers) {
    const id = `mcp:${server.key}`;
    const config = mcpConfig(services, server);
    if (!config) {
      plans.push({
        id,
        title: server.name,
        name: server.name,
        content: describeServer(server),
        warnings: ["unsupported_command"],
        status: { kind: "unsupported", reason: "unsupported_command" },
      });
      continue;
    }
    const needs: AgentImportNeed[] = [];
    if (server.requiresCredentials) needs.push({ kind: "credentials", names: [] });
    if (config.transport !== "stdio" && (await services.mcpEndpointProblem(config.endpoint))) {
      needs.push({ kind: "endpoint" });
    }
    const status: AgentImportStatus =
      needs.length > 0 ? { kind: "needs_setup", needs } : { kind: "ready" };
    plans.push({
      id,
      title: server.name,
      name: config.slug,
      content: describeServer(server),
      warnings: [],
      status,
    });
    configs.set(id, {
      id,
      title: server.name,
      content: describeServer(server),
      config,
      warnings: [],
      status,
      slug: config.slug,
    });
  }
  return { plans, configs };
}

/**
 * The transport a declaration implies; an archive entry with neither is not runnable. The archive
 * stores the command as one line, so it is split into program and arguments and both are checked
 * against the same policy the vendor import applies to a source's JSON.
 */
function mcpConfig<PreparedKey>(
  services: AgentImportServices<PreparedKey>,
  server: TeamConfigMcpServer,
): McpServerConfigInput | null {
  const slug = mcpSlug(server.name);
  const command = typeof server.command === "string" ? server.command.trim() : "";
  if (command) {
    const [program, ...args] = command.split(/\s+/);
    if (!mcpServerImportable({ command: program, args })) return null;
    if (!services.stdioAllowed(program!)) return null;
    return {
      transport: "stdio",
      slug,
      name: server.name,
      description: "",
      enabled: true,
      command: program!,
      args,
      env: {},
    };
  }
  const endpoint = typeof server.endpoint === "string" ? server.endpoint.trim() : "";
  if (endpoint && mcpServerImportable({ url: endpoint })) {
    return {
      transport: "streamable_http",
      slug,
      name: server.name,
      description: "",
      enabled: true,
      endpoint,
      headers: {},
    };
  }
  return null;
}

/** MCP slugs have their own character set; an archive name may not already be one. */
function mcpSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return /^[a-z0-9]/.test(slug) ? slug : `server-${slug}`.slice(0, 64);
}

function describeServer(server: TeamConfigMcpServer): string {
  return server.command ?? server.endpoint ?? server.name;
}

function routinePlans(
  bot: TeamConfigBot,
  fallbackZone: string,
): {
  plans: AgentImportPlan["routines"];
  inputs: Map<string, CreateRoutineInputType>;
  skipped: AgentImportPlan["skipped"];
} {
  const plans: AgentImportPlan["routines"] = [];
  const inputs = new Map<string, CreateRoutineInputType>();
  const skipped: AgentImportPlan["skipped"] = [];
  for (const routine of bot.routines) {
    const id = `routine:${routine.key}`;
    const timezone = routine.timezone || fallbackZone;
    const parsed = CreateRoutineInput.safeParse({
      // Replaced by the new bot's id when the routine is written.
      botId: "pending",
      name: routine.name,
      prompt: routine.prompt,
      crons: routine.crons,
      timezone,
      active: false,
    });
    if (!parsed.success) {
      skipped.push({ path: `${bot.name}/routines: ${routine.name}`, reason: "unsupported" });
      continue;
    }
    inputs.set(id, parsed.data);
    plans.push({
      id,
      title: routine.name,
      content: `${routine.crons.join(", ")} (${timezone})\n\n${routine.prompt}`,
      warnings: [],
      status: { kind: "ready" },
    });
  }
  return { plans, inputs, skipped };
}

/**
 * The model the archive named, checked against what the importing user can reach: `ready` when
 * a connection exists, `needs_key` when the provider is known but unconnected, `unknown` when
 * the model is not offered. No archive entry leaves the bot's model at its default.
 */
async function modelPlan<PreparedKey>(
  services: AgentImportServices<PreparedKey>,
  actor: Actor,
  bot: TeamConfigBot,
): Promise<AgentImportPlan["model"]> {
  const provider = bot.modelProvider;
  const modelId = bot.modelId;
  if (!provider || !modelId) return null;
  const problem = await services.validateBotModel(actor, provider, modelId);
  const connected = await services.hasModelConnection(actor, provider);
  return {
    id: "model",
    title: `${provider}/${modelId}`,
    provider,
    modelId,
    status: problem === null ? "ready" : connected ? "unknown" : "needs_key",
  };
}

export async function buildTeamConfigBot<PreparedKey>(
  services: AgentImportServices<PreparedKey>,
  actor: Actor,
  bot: TeamConfigBot,
): Promise<Built> {
  const { plans: mcpServers, configs: mcpConfigs } = await mcpServerPlan(services, bot);
  const saved = (
    await services.prisma.user.findUnique({
      where: { id: actor.userId },
      select: { timezone: true },
    })
  )?.timezone;
  const fallbackZone = saved && isValidTimeZone(saved) ? saved : "UTC";
  const { plans: routines, inputs: routineInputs, skipped } = routinePlans(bot, fallbackZone);

  return {
    plan: {
      source: "team-config",
      suggestedName: bot.name,
      suggestedDescription: bot.description,
      instructions: instructionPlan(bot),
      // Memory is space-scoped and imported once for the whole archive, not per bot.
      memory: [],
      // Skills are space-scoped for the same reason.
      skills: [],
      model: await modelPlan(services, actor, bot),
      mcpServers,
      routines,
      // A team archive carries no API keys by design; a connection is re-authorised on import.
      apiKeys: [],
      skipped: [...skippedBotFields(bot), ...skipped],
    },
    // No credential values travel in a team archive, so there is nothing to encrypt.
    settings: null,
    routineInputs,
    mcpConfigs,
    connectedKeyIds: new Set(),
  };
}
