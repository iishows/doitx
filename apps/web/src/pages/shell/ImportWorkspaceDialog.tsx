import { Trans, useLingui } from "@lingui/react/macro";
import type { TeamConfigFile, TeamConfigPreview } from "@rakazo/contracts";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Spinner,
} from "@rakazo/ui-web";
import { useRef, useState } from "react";
import {
  createTeamConfigBots,
  previewTeamConfig,
  readTeamConfigArchive,
} from "../../components/team-config-transfer";
import { errorText } from "../../lib/user-error";

/**
 * Build a workspace from someone else's: pick an archive, tick which bots to create, confirm. The
 * archive carries no credentials, so an imported connection is a declaration the user still has to
 * authorise. Mounted only while open; the parent unmounts it from `onClose`.
 */
export function ImportWorkspaceDialog({
  spaceId,
  spaceName,
  onClose,
  onDone,
}: {
  spaceId: string;
  spaceName: string;
  onClose: () => void;
  onDone: (summary: string) => void;
}) {
  const { t } = useLingui();
  const fileInput = useRef<HTMLInputElement>(null);
  const [reading, setReading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [preview, setPreview] = useState<TeamConfigPreview | null>(null);
  const [files, setFiles] = useState<TeamConfigFile[]>([]);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const busy = reading || creating;

  async function choose(file: File) {
    setError(null);
    setReading(true);
    setPreview(null);
    try {
      const next = readTeamConfigArchive(new Uint8Array(await file.arrayBuffer()));
      const found = await previewTeamConfig(spaceId, next);
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
      const { created } = await createTeamConfigBots(spaceId, files, [...ticked]);
      onDone(created.length === 1 ? t`Created 1 bot.` : t`Created ${created.length} bots.`);
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
    <Dialog open onOpenChange={(open) => (open || busy ? undefined : onClose())}>
      <DialogContent data-testid="import-workspace-dialog">
        <DialogHeader>
          <DialogTitle>{t`Import into ${spaceName}`}</DialogTitle>
          <DialogDescription>
            <Trans>Credentials are never included; imported connections need authorising.</Trans>
          </DialogDescription>
        </DialogHeader>

        <input
          ref={fileInput}
          type="file"
          accept=".zip,application/zip"
          className="hidden"
          data-testid="import-workspace-file"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void choose(file);
          }}
        />

        {preview ? null : (
          <Button
            variant="outline"
            className="rounded-full"
            disabled={busy}
            data-testid="import-workspace-choose"
            onClick={() => fileInput.current?.click()}
          >
            {reading ? <Spinner /> : null}
            <Trans>Choose file</Trans>
          </Button>
        )}

        {error ? (
          <p
            role="alert"
            className="text-[12.5px] text-destructive"
            data-testid="import-workspace-error"
          >
            {error}
          </p>
        ) : null}

        {preview ? (
          <div className="space-y-3" data-testid="import-workspace-preview">
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
                    data-testid={`import-workspace-bot-${bot.key}`}
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
                <Trans>
                  Bots with servers needing credentials will not run until you add them.
                </Trans>
              </p>
            ) : null}
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="ghost" className="rounded-full" disabled={creating} onClick={onClose}>
            <Trans>Cancel</Trans>
          </Button>
          {preview ? (
            <Button
              className="rounded-full"
              disabled={creating || ticked.size === 0}
              data-testid="import-workspace-create"
              onClick={() => void create()}
            >
              {creating ? <Spinner /> : null}
              {ticked.size === 1 ? t`Import 1 bot` : t`Import ${ticked.size} bots`}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
