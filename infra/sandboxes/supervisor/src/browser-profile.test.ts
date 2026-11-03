import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  browserProfilePathForScreen,
  prepareBrowserProfileCommand,
  stopScreensCommand,
} from "./supervisor-logic.js";

const fixtures: string[] = [];
afterEach(() => {
  for (const directory of fixtures.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "rakazo-profile-test-"));
  fixtures.push(root);
  const home = path.join(root, "home");
  const runtime = path.join(root, "runtime");
  const shared = path.join(home, ".browser-profiles/chromium");
  mkdirSync(shared, { recursive: true });
  mkdirSync(runtime);
  const profile = (bot: string) => browserProfilePathForScreen(bot).replace("/home/rakazo", home);
  // The generated scripts are POSIX shell, so they see POSIX paths; Node still reads and
  // writes the same files through the native paths above.
  const homeShell = posixPath(home);
  const runtimeShell = posixPath(runtime);
  const run = (script: string) => {
    // GNU cp's reflink optimization has no macOS equivalent; all copy semantics remain intact.
    const portable =
      process.platform === "darwin" ? script.replaceAll(" --reflink=auto", "") : script;
    return spawnSync(
      bashBinary(),
      [
        "-eu",
        "-c",
        portable.replaceAll("/tmp/rakazo", runtimeShell).replaceAll("/home/rakazo", homeShell),
      ],
      {
        encoding: "utf8",
        timeout: 10_000,
      },
    );
  };
  return { shared, profile, run, runtime };
}

describe("durable independent browser profiles", () => {
  // The stop script finds and kills the browser through /proc/<pid>/cmdline, which has no
  // Windows equivalent; it runs for real on the Linux hosts the computer uses.
  it.skipIf(process.platform === "win32")(
    "keeps both bots' data through stop and restart without copying the default profile",
    () => {
    const { shared, profile, run } = fixture();
    writeFileSync(path.join(shared, "login"), "legacy-session");
    for (const bot of ["writer", "reader"]) {
      expect(run(prepareBrowserProfileCommand(bot)).status).toBe(0);
      expect(existsSync(path.join(profile(bot), "login"))).toBe(false);
      writeFileSync(path.join(profile(bot), "login"), `${bot}-session`);
    }
    expect(
      run(
        stopScreensCommand([
          { screenId: "writer", index: 0 },
          { screenId: "reader", index: 1 },
        ]),
      ).status,
    ).toBe(0);
    for (const bot of ["writer", "reader"]) {
      expect(run(prepareBrowserProfileCommand(bot)).status).toBe(0);
      expect(readFileSync(path.join(profile(bot), "login"), "utf8")).toBe(`${bot}-session`);
    }
    expect(run(prepareBrowserProfileCommand("new-bot")).status).toBe(0);
    expect(existsSync(path.join(profile("new-bot"), "login"))).toBe(false);
    expect(readFileSync(path.join(shared, "login"), "utf8")).toBe("legacy-session");
    },
  );
});

/** The shell to run, resolved against the real PATH (a test may not replace it). */
function bashBinary(): string {
  const extensions = process.platform === "win32" ? [".exe", ""] : [""];
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = path.join(directory, `bash${extension}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return "bash";
}

/** The shell's own spelling of a path; on Windows MSYS renders it under /tmp or /c. */
function posixPath(target: string): string {
  if (process.platform !== "win32") return target;
  const directory = spawnSync(bashBinary(), ["-c", 'cd "$1" && pwd', "bash", path.dirname(target)], {
    encoding: "utf8",
  }).stdout.trim();
  return path.posix.join(directory, path.basename(target));
}
