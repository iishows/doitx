import { Trans, useLingui } from "@lingui/react/macro";
import {
  isIdentityConfirmationRequired,
  type TeamConfigPreview,
  type TeamConfigPreviewInput,
} from "@rakazo/contracts";
import { openAgentImportArchive } from "@rakazo/core";
import { Button, Spinner } from "@rakazo/ui-web";
import { useRef, useState } from "react";
import { rpc } from "../lib/rpc";
import { errorText } from "../lib/user-error";
import { SuccessPop } from "./ai/primitives";
import { useIdentityConfirmation } from "./ConfirmIdentityDialog";

/**
 * One workspace's whole configuration: download it as a zip, or build a workspace from someone
 * else's. The archive carries no credentials, so an imported connection is a declaration the user
 * still has to authorise.
 */
export function TeamConfigSettings() {
  const { t } = useLingui();
  const { withIdentityConfirmation, identityDialog } = useIdentityConfirmation();
  const fileInput = useRef<HTMLInputElement>(null);
  const [exporting, setExporting] = useState(false);
  const [reading, setReading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [preview, setPreview] = useState<TeamConfigPreview | null>(null);
  const [files, setFiles] = useState<TeamConfigPreviewInput["files"]>([]);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function download() {
    setError(null);
    setExporting(true);
    try {
      const { token } = await withIdentityConfirmation(() => rpc.export.teamConfigToken());
      // A download link, not a fetch, so the browser or Electron saves the stream natively.
      const link = document.createElement("a");
      link.href = `/api/team-config/export?token=${encodeURIComponent(token)}`;
      link.download = "";
      link.click();
    } catch (err) {
      if (!isIdentityConfirmationRequired(err)) {
        setError(errorText(err, t`The workspace could not be downloaded.`));
      }
    } finally {
      setExporting(false);
    }
  }

  async function choose(file: File) {
    setError(null);
    setDone(null);
    setReading(true);
    setPreview(null);
    try {
      const archive = openAgentImportArchive(new Uint8Array(await file.arrayBuffer()));
      const next = archive.paths.map((path) => ({ path, content: archive.read(path) }));
      const found = await rpc.export.teamConfigPreview({ files: next });
      setFiles(next);
      setPreview(found);
      // Every bot starts ticked: importing a workspace is the point, and untick is the exception.
      setTicked(new Set(found.bots.map((bot) => bot.key)));
    } catch (err) {
      setError(errorText(err, t`That file is not a workspace archive.`));
    } finally {
      setReading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  async function create() {
    if (!preview) return;
    setError(null);
    setCreating(true);
    try {
      const { created } = await rpc.export.teamConfigCreate({
        files,
        selection: { keys: [...ticked] },
      });
      setPreview(null);
      setFiles([]);
      setDone(created.length === 1 ? t`Created 1 bot.` : t`Created ${created.length} bots.`);
    } catch (err) {
      setError(errorText(err, t`The workspace could not be imported.`));
    } finally {
      setCreating(false);
    }
  }

  const missingCredentials = preview
    ? preview.bots.filter((bot) => ticked.has(bot.key) && bot.needsCredentials).length
    : 0;

  return (
    <div className="space-y-3" data-testid="team-config-settings">
      <p className="text-[12.5px] text-muted-foreground">
        <Trans>
          Download this workspace's bots, skills, sections and connections as a file, or build a
          workspace from one. Credentials are never included.
        </Trans>
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          className="rounded-full"
          disabled={exporting}
          data-testid="team-config-export"
          onClick={() => void download()}
        >
          {exporting ? <Spinner /> : null}
          <Trans>Download workspace</Trans>
        </Button>
        <Button
          variant="outline"
          className="rounded-full"
          disabled={reading || creating}
          data-testid="team-config-import"
          onClick={() => fileInput.current?.click()}
        >
          {reading ? <Spinner /> : null}
          <Trans>Import workspace</Trans>
        </Button>
        <input
          ref={fileInput}
          type="file"
          accept=".zip,application/zip"
          className="hidden"
          data-testid="team-config-file"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void choose(file);
          }}
        />
      </div>

      {error ? (
        <p role="alert" className="text-[12.5px] text-destructive" data-testid="team-config-error">
          {error}
        </p>
      ) : null}
      {done ? <SuccessPop label={done} /> : null}

      {preview ? (
        <div
          className="space-y-3 rounded-2xl border border-border p-4"
          data-testid="team-config-preview"
        >
          <p className="text-[12.5px] text-muted-foreground">
            {t`From ${preview.sourceWorkspace}. Choose the bots to create.`}
          </p>
          <ul className="space-y-2">
            {preview.bots.map((bot) => (
              <li key={bot.key} className="flex items-start gap-2">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={ticked.has(bot.key)}
                  disabled={creating}
                  data-testid={`team-config-bot-${bot.key}`}
                  onChange={(event) => {
                    setTicked((current) => {
                      const next = new Set(current);
                      if (event.target.checked) next.add(bot.key);
                      else next.delete(bot.key);
                      return next;
                    });
                  }}
                />
                <span className="text-[13px]">
                  <span className="font-medium">{bot.name}</span>
                  {bot.nameTaken ? (
                    <span className="text-muted-foreground">
                      {" "}
                      · {t`a name is taken, it is renamed`}
                    </span>
                  ) : null}
                  <span className="block text-[12px] text-muted-foreground">
                    {t`${bot.routines} routines · ${bot.mcpServers} servers`}
                    {bot.needsCredentials ? ` · ${t`needs credentials`}` : ""}
                  </span>
                </span>
              </li>
            ))}
          </ul>
          {preview.counts.sections || preview.counts.skills || preview.counts.connections ? (
            <p className="text-[12px] text-muted-foreground">
              {t`Also adds ${preview.counts.sections} sections, ${preview.counts.skills} skills and ${preview.counts.connections} connections.`}
            </p>
          ) : null}
          {preview.droppedPreferences.length ? (
            <p className="text-[12px] text-muted-foreground">
              {t`Model preferences for ${preview.droppedPreferences
                .map((item) => item.provider)
                .join(", ")} are skipped: connect those providers first.`}
            </p>
          ) : null}
          {missingCredentials ? (
            <p className="text-[12px] text-muted-foreground">
              <Trans>Bots with servers needing credentials will not run until you add them.</Trans>
            </p>
          ) : null}
          <div className="flex items-center gap-2">
            <Button
              className="rounded-full"
              disabled={creating || ticked.size === 0}
              data-testid="team-config-create"
              onClick={() => void create()}
            >
              {creating ? <Spinner /> : null}
              {ticked.size === 1 ? t`Import 1 bot` : t`Import ${ticked.size} bots`}
            </Button>
            <Button
              variant="ghost"
              className="rounded-full"
              disabled={creating}
              onClick={() => {
                setPreview(null);
                setFiles([]);
                setError(null);
              }}
            >
              <Trans>Cancel</Trans>
            </Button>
          </div>
        </div>
      ) : null}
      {identityDialog}
    </div>
  );
}
