/**
 * Shell commands that can destroy data or take over the machine when nobody is watching.
 *
 * The tool gate asks the owner about these even when approvals are otherwise skipped, so a space
 * left on "Never ask" still cannot be talked into wiping a disk by text it read on the web. The
 * classifier is deliberately simple: it splits a command line into the segments a shell would run
 * and looks for a destructive verb applied to a dangerous target. It is not a sandbox — a script
 * can hide intent — it only keeps the obvious ones from running unattended.
 */

export type DangerousCommandVerdict = {
  dangerous: boolean;
  /** Short, plain-language reasons, shown on the approval card. */
  reasons: string[];
};

const SAFE: DangerousCommandVerdict = { dangerous: false, reasons: [] };

/** Targets where a recursive delete destroys a disk, a home folder or the working tree. */
const DANGEROUS_TARGET =
  /^(?:\/|\/\*|~|~\/|~\/\*|\$HOME|\$\{HOME\}|\$HOME\/\*|\*|\.|\.\/\*|\/etc|\/etc\/\*|\/usr|\/usr\/\*|\/var|\/var\/\*|\/bin|\/boot|\/boot\/\*|\/dev|\/dev\/\*|[a-zA-Z]:[\\/]|[a-zA-Z]:[\\/]\*)$/;

/** Block devices, where a raw write ends the machine. */
const BLOCK_DEVICE = /^\/dev\/(?:sd[a-z]|nvme\d|hd[a-z]|vd[a-z]|mmcblk\d|disk\d)/;

const SEGMENT_SPLIT = /(?:&&|\|\||[;|\n]|\$\(|`)/;

function segments(command: string): string[] {
  return command
    .split(SEGMENT_SPLIT)
    .map((part) => part.trim())
    .filter(Boolean);
}

function words(segment: string): string[] {
  return segment.split(/\s+/).filter(Boolean);
}

/** Drop the quotes a shell would have removed before the command ever ran. */
function unquote(token: string): string {
  const match = /^(['"])(.*)\1$/.exec(token);
  return match?.[2] ?? token;
}

/** True for `-rf`, `-fr`, `-R`, and the long forms; a bundle carries every short flag it names. */
function hasShortFlags(token: string, letters: string[]): boolean {
  if (!token.startsWith("-") || token.startsWith("--")) return false;
  const bundle = token.replace(/^-+/, "");
  return letters.some((letter) => bundle.includes(letter));
}

/** Commands whose line this classifier reads, wherever a wrapper such as `sudo` puts them. */
const KNOWN_VERBS = new Set([
  "rm",
  "rmdir",
  "del",
  "ri",
  "Remove-Item",
  "dd",
  "shred",
  "wipefs",
  "fdisk",
  "sgdisk",
  "parted",
  "diskpart",
  "sdformat",
  "Clear-Disk",
  "Format-Volume",
  "Initialize-Disk",
  "chmod",
  "chown",
  "chgrp",
  "takeown",
  "icacls",
]);

/**
 * The command's own words. `sudo -u root rm -rf /`, `command rm`, and `busybox rm` all run the
 * delete one step removed, and their options can be mixed in, so start at the first known verb.
 */
function commandWords(segment: string): string[] {
  const tokens = words(segment);
  const start = tokens.findIndex(
    (token) => KNOWN_VERBS.has(basename(token)) || /^mkfs(?:\.\w+)?$/.test(basename(token)),
  );
  return start === -1 ? [] : tokens.slice(start);
}

function basename(token: string): string {
  return unquote(token).split(/[\\/]/).pop() ?? token;
}

function deleteVerdict(segment: string): string | undefined {
  const tokens = commandWords(segment);
  if (tokens.length === 0) return undefined;
  const verb = basename(tokens[0]!);
  const posix = verb === "rm";
  const windows = verb === "Remove-Item" || verb === "ri" || verb === "del" || verb === "rmdir";
  if (!posix && !windows) return undefined;

  const rest = tokens.slice(1);
  const recursive = rest.some(
    (token) =>
      token === "--recursive" ||
      token === "-Recurse" ||
      token === "/s" ||
      hasShortFlags(token, ["r", "R"]),
  );
  // Windows switches look like `/s`; a path like `/` or `/etc` is a target, not a switch.
  const targets = rest
    .map(unquote)
    .filter((token) => !token.startsWith("-") && !/^\/[a-zA-Z]$/.test(token));
  const hitsDangerousTarget = targets.some((target) => DANGEROUS_TARGET.test(target));
  if (!recursive || !hitsDangerousTarget) return undefined;

  const forced = rest.some(
    (token) =>
      token === "--force" || token === "-Force" || token === "/q" || hasShortFlags(token, ["f"]),
  );
  return forced
    ? "Recursively force-deleting a whole folder or drive"
    : "Recursively deleting a whole folder or drive";
}

function diskVerdict(segment: string): string | undefined {
  // Any command can aim a redirect at a disk device, so this needs no known verb.
  if (/>\s*\/dev\/(?:sd|nvme|hd|vd)/.test(segment)) return "Writing over a disk device";
  const tokens = commandWords(segment);
  const verb = basename(tokens[0] ?? "");
  if (!verb) return undefined;
  if (verb === "dd") {
    const writesToDevice = tokens.some(
      (token) => token.startsWith("of=") && BLOCK_DEVICE.test(token.slice(3)),
    );
    return writesToDevice ? "Writing raw data over a disk device" : undefined;
  }
  if (/^mkfs(?:\.\w+)?$/.test(verb)) return "Reformatting a disk";
  if (
    [
      "wipefs",
      "fdisk",
      "sgdisk",
      "parted",
      "diskpart",
      "sdformat",
      "Clear-Disk",
      "Format-Volume",
      "Initialize-Disk",
    ].includes(verb)
  ) {
    return "Repartitioning or reformatting a disk";
  }
  if (verb === "shred") return "Overwriting files so they cannot be recovered";
  return undefined;
}

function permissionVerdict(segment: string): string | undefined {
  const tokens = commandWords(segment);
  const verb = basename(tokens[0] ?? "");
  if (!verb || !["chmod", "chown", "chgrp", "takeown", "icacls"].includes(verb)) return undefined;
  const recursive = tokens.some(
    (token) => token === "--recursive" || hasShortFlags(token, ["r", "R"]),
  );
  if (!recursive) return undefined;
  const targets = tokens.slice(1).filter((token) => !token.startsWith("-"));
  const target = targets[targets.length - 1];
  if (!target || !DANGEROUS_TARGET.test(target)) return undefined;
  return "Changing ownership or permissions across a whole system folder";
}

const PIPE_TO_SHELL =
  /(?:curl|wget|iwr|Invoke-WebRequest|Invoke-RestMethod)\b[^|]*\|\s*(?:sudo\s+)?(?:ba|z|k|fi|da)?sh\b|(?:curl|wget)\b[^|]*\|\s*(?:powershell|pwsh)\b/i;

const FORK_BOMB = /:\s*\(\s*\)\s*\{[^}]*:\s*\|\s*:/;

/** A here-document only writes bytes; what it writes is not what this line runs. */
const HEREDOC = /<<-?\s*['"]?\w+/;

function classifySegment(segment: string): string[] {
  if (HEREDOC.test(segment)) return [];
  const reasons: string[] = [];
  for (const check of [deleteVerdict, diskVerdict, permissionVerdict]) {
    const reason = check(segment);
    if (reason) reasons.push(reason);
  }
  return reasons;
}

/** Cut a here-document body: it only writes bytes, and is not the line this command runs. */
function stripHeredocBodies(command: string): string {
  const lines = command.split(/\r?\n/);
  const kept: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    kept.push(line);
    const opener = /<<-?\s*['"]?(\w+)['"]?/.exec(line);
    if (!opener) continue;
    const terminator = opener[1]!;
    index += 1;
    while (index < lines.length && lines[index]!.trim() !== terminator) index += 1;
  }
  return kept.join("\n");
}

/** Judge one shell command line; an empty verdict means nothing matched. */
export function classifyDangerousCommand(command: string): DangerousCommandVerdict {
  if (!command.trim()) return SAFE;
  const normalized = stripHeredocBodies(command.replace(/\\\r?\n/g, " "));
  if (!normalized.trim()) return SAFE;
  const reasons: string[] = [];
  // These read the whole line: a pipe and a fork bomb both span segments.
  if (PIPE_TO_SHELL.test(normalized))
    reasons.push("Piping a downloaded script straight into a shell");
  if (FORK_BOMB.test(normalized)) reasons.push("A fork bomb");
  for (const segment of segments(normalized)) {
    for (const reason of classifySegment(segment)) {
      if (!reasons.includes(reason)) reasons.push(reason);
    }
  }
  return reasons.length > 0 ? { dangerous: true, reasons } : SAFE;
}

/** The shell-style tools whose `command` argument the classifier reads. */
const SHELL_TOOL_NAMES = new Set(["shell", "user_computer_shell"]);

/**
 * Judge a tool call. Only shell-style tools carry a command string, and only a string is read; a
 * missing or non-string argument means there is nothing to judge.
 */
export function classifyDangerousToolCall(
  toolName: string,
  args: unknown,
): DangerousCommandVerdict {
  if (!SHELL_TOOL_NAMES.has(toolName)) return SAFE;
  if (!args || typeof args !== "object") return SAFE;
  const command = (args as { command?: unknown }).command;
  if (typeof command !== "string") return SAFE;
  return classifyDangerousCommand(command);
}
