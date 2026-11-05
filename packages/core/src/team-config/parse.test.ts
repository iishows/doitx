import {
  TEAM_CONFIG_FORMAT,
  TEAM_CONFIG_VERSION,
  type TeamConfigFile,
  teamConfigSkillPath,
} from "@rakazo/contracts";
import { describe, expect, it } from "vitest";

import { parseTeamConfig, TeamConfigParseError } from "./parse.js";

function botBody(key: string, name: string) {
  return {
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
  };
}

function manifest(bots: Array<{ key: string; name: string }>) {
  return {
    format: TEAM_CONFIG_FORMAT,
    version: TEAM_CONFIG_VERSION,
    exportedAt: "2026-11-06T00:00:00.000Z",
    sourceWorkspace: "My Workspace",
    bots: bots.map((bot) => ({ ...bot, warnings: [] })),
    sections: [],
    connections: [],
    skills: [],
    modelPreferences: [],
    approvalRules: [],
  };
}

function archive(
  manifestValue: unknown,
  bodies: Record<string, unknown> = {},
  skills: Record<string, string> = {},
): TeamConfigFile[] {
  return [
    { path: "manifest.json", content: JSON.stringify(manifestValue) },
    ...Object.entries(bodies).map(([key, body]) => ({
      path: `bots/${encodeURIComponent(key)}.json`,
      content: JSON.stringify(body),
    })),
    ...Object.entries(skills).map(([key, content]) => ({
      path: teamConfigSkillPath(key),
      content,
    })),
  ];
}

describe("parseTeamConfig", () => {
  it("reads the manifest and every bot the manifest lists", () => {
    const files = archive(manifest([{ key: "bot:writer", name: "Writer" }]), {
      "bot:writer": botBody("bot:writer", "Writer"),
    });

    const parsed = parseTeamConfig(files);

    expect(parsed.manifest.sourceWorkspace).toBe("My Workspace");
    expect([...parsed.bots.keys()]).toEqual(["bot:writer"]);
    expect(parsed.bots.get("bot:writer")?.instructions).toBe("Do the thing.");
  });

  it("names a foreign zip honestly rather than calling it malformed", () => {
    const foreign = archive({ ...manifest([]), format: "rakazo-account-export" });

    expect(() => parseTeamConfig(foreign)).toThrowError(
      expect.objectContaining({ reason: "format" }) as never,
    );
  });

  it("imports a version 3 archive and upgrades it to the current version", () => {
    const files = archive(
      {
        ...manifest([{ key: "bot:writer", name: "Writer" }]),
        version: 3,
        skills: [{ key: "skill:style", name: "Style", description: "" }],
      },
      { "bot:writer": botBody("bot:writer", "Writer") },
      { "skill:style": "# Style" },
    );

    const parsed = parseTeamConfig(files);

    expect(parsed.manifest.version).toBe(TEAM_CONFIG_VERSION);
    expect(parsed.bots.get("bot:writer")?.instructions).toBe("Do the thing.");
    // Skill bodies still come from their own files in a version 3 archive.
    expect(parsed.skills.get("skill:style")?.content).toBe("# Style");
  });

  it("refuses an archive from a newer app instead of half-reading it", () => {
    const newer = archive({ ...manifest([]), version: TEAM_CONFIG_VERSION + 1 });

    expect(() => parseTeamConfig(newer)).toThrowError(
      expect.objectContaining({ reason: "version" }) as never,
    );
  });

  it("refuses a zip with no manifest at all", () => {
    expect(() => parseTeamConfig([{ path: "readme.md", content: "hi" }])).toThrowError(
      expect.objectContaining({ reason: "not_an_archive" }) as never,
    );
  });

  it("refuses a bot the manifest does not list, so an archive cannot smuggle one in", () => {
    // A body is present for a key the manifest never mentions.
    const files = archive(manifest([{ key: "bot:writer", name: "Writer" }]), {
      "bot:writer": botBody("bot:writer", "Writer"),
      "bot:smuggled": botBody("bot:smuggled", "Smuggled"),
    });

    const parsed = parseTeamConfig(files);

    expect(parsed.bots.has("bot:smuggled")).toBe(false);
    expect([...parsed.bots.keys()]).toEqual(["bot:writer"]);
  });

  it("lets the manifest key win over the key inside a bot body", () => {
    const files = archive(manifest([{ key: "bot:writer", name: "Writer" }]), {
      "bot:writer": { ...botBody("bot:elsewhere", "Writer"), instructions: "Real." },
    });

    const parsed = parseTeamConfig(files);

    expect(parsed.bots.get("bot:writer")?.key).toBe("bot:writer");
  });

  it("refuses a listed bot whose file is missing", () => {
    const files = archive(manifest([{ key: "bot:writer", name: "Writer" }]));

    expect(() => parseTeamConfig(files)).toThrowError(
      expect.objectContaining({ reason: "missing_bot" }) as never,
    );
  });

  it("reads a skill body from its own file", () => {
    const files = archive(
      {
        ...manifest([]),
        skills: [{ key: "skill:style", name: "Style", description: "Our tone" }],
      },
      {},
      { "skill:style": "# Style\n\nBe terse." },
    );

    const parsed = parseTeamConfig(files);

    expect(parsed.skills.get("skill:style")).toEqual({
      key: "skill:style",
      name: "Style",
      description: "Our tone",
      content: "# Style\n\nBe terse.",
    });
  });

  it("refuses a listed skill whose file is missing", () => {
    const files = archive({
      ...manifest([]),
      skills: [{ key: "skill:style", name: "Style", description: "" }],
    });

    expect(() => parseTeamConfig(files)).toThrowError(
      expect.objectContaining({ reason: "missing_skill" }) as never,
    );
  });

  it("ignores a skill file the manifest does not list", () => {
    const files = archive(manifest([]), {}, { "skill:smuggled": "Be evil." });

    const parsed = parseTeamConfig(files);

    expect(parsed.skills.size).toBe(0);
  });

  it("imports a version 2 archive, whose skill bodies were inlined in the manifest", () => {
    const v2 = {
      ...manifest([]),
      version: 2,
      skills: [{ key: "skill:style", name: "Style", description: "Our tone", content: "# Style" }],
    };

    const parsed = parseTeamConfig([{ path: "manifest.json", content: JSON.stringify(v2) }]);

    // Normalized to the current shape for everything downstream.
    expect(parsed.manifest.version).toBe(TEAM_CONFIG_VERSION);
    expect(parsed.manifest.skills).toEqual([
      { key: "skill:style", name: "Style", description: "Our tone" },
    ]);
    expect(parsed.skills.get("skill:style")?.content).toBe("# Style");
  });

  it("refuses a bot body that carries an unexpected field", () => {
    const files = archive(manifest([{ key: "bot:writer", name: "Writer" }]), {
      // A credential-shaped extra field must not be silently accepted.
      "bot:writer": { ...botBody("bot:writer", "Writer"), browserProxyUrl: "http://u:p@h:1" },
    });

    expect(() => parseTeamConfig(files)).toThrowError(
      expect.objectContaining({ reason: "malformed" }) as never,
    );
  });

  it("refuses a manifest that is not valid JSON", () => {
    expect(() => parseTeamConfig([{ path: "manifest.json", content: "{ not json" }])).toThrowError(
      expect.objectContaining({ reason: "malformed" }) as never,
    );
  });

  it("carries a typed reason on every failure", () => {
    try {
      parseTeamConfig([]);
      expect.unreachable("expected a parse failure");
    } catch (error) {
      expect(error).toBeInstanceOf(TeamConfigParseError);
      expect((error as TeamConfigParseError).reason).toBe("not_an_archive");
    }
  });
});
