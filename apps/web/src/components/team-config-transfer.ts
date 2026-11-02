import type { TeamConfigFile } from "@rakazo/contracts";
import { openAgentImportArchive } from "@rakazo/core";
import { rpcForSpace } from "../lib/rpc";

/**
 * The workspace export/import calls, each bound to one space rather than the selected one. Acting
 * from the space menu must reach the space the menu belongs to, so every call goes through
 * `rpcForSpace` and the server reads it from `x-rakazo-space-id`.
 */

export async function issueTeamConfigToken(spaceId: string): Promise<string> {
  const { token } = await rpcForSpace(spaceId).export.teamConfigToken();
  return token;
}

/** A navigation, not a fetch, so the browser or Electron saves the stream itself. */
export function downloadTeamConfig(token: string): void {
  const link = document.createElement("a");
  link.href = `/api/team-config/export?token=${encodeURIComponent(token)}`;
  link.download = "";
  document.body.append(link);
  link.click();
  link.remove();
}

/** Reads an archive the user picked into the text entries the import RPC expects. */
export function readTeamConfigArchive(data: Uint8Array): TeamConfigFile[] {
  const archive = openAgentImportArchive(data);
  return archive.paths.map((path) => ({ path, content: archive.read(path) }));
}

export function previewTeamConfig(spaceId: string, files: TeamConfigFile[]) {
  return rpcForSpace(spaceId).export.teamConfigPreview({ files });
}

export function createTeamConfigBots(spaceId: string, files: TeamConfigFile[], keys: string[]) {
  return rpcForSpace(spaceId).export.teamConfigCreate({ files, selection: { keys } });
}
