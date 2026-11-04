import type { Auth } from "@rakazo/auth";
import {
  TEAM_CONFIG_MANIFEST_PATH,
  teamConfigBotPath,
  teamConfigSkillPath,
} from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { buildTeamConfig, readTeamConfigSource } from "@rakazo/db";
import type { Hono } from "hono";

import { type ArchiveFile, zipStream } from "./account-export.js";

const encoder = new TextEncoder();

/** Configuration is text, so this is generous; it only exists to bound a runaway generator. */
const TEAM_CONFIG_MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;

/**
 * The manifest first, then one file per bot and one per skill. The file names come from the manifest
 * entries rather than from the bodies, so the two can never disagree about where an item lives. A
 * skill's body is its Markdown, written as-is; wrapping it in JSON would cost headroom against the
 * per-file limit without adding anything.
 */
async function* teamConfigArchiveFiles(
  source: Parameters<typeof buildTeamConfig>[0],
): AsyncGenerator<ArchiveFile> {
  const { manifest, bots, skills } = buildTeamConfig(source);
  yield {
    path: TEAM_CONFIG_MANIFEST_PATH,
    data: [encoder.encode(JSON.stringify(manifest, null, 2))],
  };
  for (const [index, bot] of bots.entries()) {
    const key = manifest.bots[index]?.key ?? String(index);
    yield { path: teamConfigBotPath(key), data: [encoder.encode(JSON.stringify(bot, null, 2))] };
  }
  for (const skill of skills) {
    yield { path: teamConfigSkillPath(skill.key), data: [encoder.encode(skill.content)] };
  }
}

export function teamConfigFilename(now = new Date()): string {
  return `rakazo-team-config-${now.toISOString().slice(0, 10)}.zip`;
}

/**
 * `GET /api/team-config/export?token=`: a plain navigation, so the browser or Electron saves the
 * download itself. The one-time token is the only credential, and because there is no session it
 * carries the space to read.
 */
export function mountTeamConfigExportRoute(
  app: Hono,
  deps: {
    prisma: PrismaClient;
    auth: Pick<Auth, "consumeTeamConfigToken">;
  },
): void {
  app.get("/api/team-config/export", async (c) => {
    const scope = await deps.auth.consumeTeamConfigToken(c.req.query("token") ?? "");
    if (!scope) return c.text("Export link expired", 410, { "cache-control": "no-store" });

    const now = new Date();
    const source = await readTeamConfigSource(deps.prisma, scope.spaceId, now);
    // Config only, so the archive stays small; the shared cap keeps a runaway generator bounded.
    const body = zipStream(teamConfigArchiveFiles(source), TEAM_CONFIG_MAX_ARCHIVE_BYTES);
    return new Response(body, {
      headers: {
        "content-type": "application/zip",
        "content-disposition": `attachment; filename="${teamConfigFilename(now)}"`,
        "cache-control": "no-store",
      },
    });
  });
}
