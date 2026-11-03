import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const computerRoot = fileURLToPath(new URL("../../computer/", import.meta.url));
const localBinSnippet = path.join(computerRoot, "rakazo-local-bin.sh");

// Debian /etc/profile replaces PATH, then sources /etc/profile.d/*.sh. Bash login
// shells (`bash -lc`) do that before any home profile. Reproduce that order in a
// throwaway home so the test does not depend on the host's /etc/profile.
const LOGIN_SHELL_STARTUP = [
  "set -u",
  'if [ "$(id -u)" -eq 0 ]; then',
  '  PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"',
  "else",
  '  PATH="/usr/local/bin:/usr/bin:/bin:/usr/local/games:/usr/games"',
  "fi",
  "export PATH",
  '. "$RAKAZO_LOCAL_BIN_SNIPPET"',
  'if [ -f "$HOME/.bash_profile" ]; then',
  '  . "$HOME/.bash_profile"',
  'elif [ -f "$HOME/.bash_login" ]; then',
  '  . "$HOME/.bash_login"',
  'elif [ -f "$HOME/.profile" ]; then',
  '  . "$HOME/.profile"',
  "fi",
].join("\n");

/** One home, in the two forms the two sides of this test need. */
type Home = {
  /** Where Node writes files: a native path for this host. */
  fs: string;
  /** What the shell sees: POSIX on Windows, where MSYS maps the temp dir to /tmp. */
  shell: string;
};

describe("agent shell PATH after Debian login startup", () => {
  const homes: string[] = [];

  afterEach(() => {
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  });

  it.each(["sh", "bash"])(
    "keeps the sandbox home bin visible with no home profile (%s)",
    (shell) => {
      const home = createHome();
      installHello(home.fs);

      const result = loginShell(home, 'printf "%s\\n" "$PATH"; hello', LOGIN_SHELL_STARTUP, shell);

      expect(result.stdout.split("\n")[0]?.split(":")[0]).toBe(`${home.shell}/.local/bin`);
      expect(result.stdout).toContain("hello-from-local-bin");
    },
  );

  it("does not duplicate an entry that is already present", () => {
    const home = createHome();
    const preset = `${home.shell}/.local/bin:/usr/bin:/bin`;

    const result = loginShell(
      home,
      'printf "%s" "$PATH"',
      // Skip the Debian reset so the snippet sees the supervisor PATH intact.
      [
        `PATH=${shellQuote(preset)}`,
        "export PATH",
        `. ${shellQuote(posixPath(localBinSnippet))}`,
        `. ${shellQuote(posixPath(localBinSnippet))}`,
      ].join("\n"),
    );

    expect(result.stdout).toBe(preset);
  });

  it("does not treat a longer path prefix as the sandbox bin", () => {
    const home = createHome();
    const lookalikeFs = `${home.fs}/.local/bin-extra`;
    mkdirSync(lookalikeFs, { recursive: true });
    const lookalike = posixPath(lookalikeFs);

    const result = loginShell(
      home,
      'printf "%s" "$PATH"',
      `PATH=${shellQuote(`${lookalike}:/usr/bin`)}\nexport PATH\n. ${shellQuote(posixPath(localBinSnippet))}`,
    );

    expect(result.stdout.split(":")).toEqual([`${home.shell}/.local/bin`, lookalike, "/usr/bin"]);
  });

  it("leaves PATH alone when HOME is unset", () => {
    const result = execFileSync(
      shellBinary("sh"),
      [
        "-c",
        `unset HOME\n. ${shellQuote(posixPath(localBinSnippet))}\nprintf "%s" "$PATH"`,
      ],
      {
        encoding: "utf8",
        env: { PATH: "/usr/bin:/bin" },
      },
    );

    expect(result).toBe("/usr/bin:/bin");
  });

  it("still leaves the sandbox bin on PATH when a home profile prepends another directory", () => {
    const home = createHome();
    mkdirSync(path.join(home.fs, "bin"));
    writeFileSync(path.join(home.fs, ".profile"), 'PATH="$HOME/bin:$PATH"\nexport PATH\n');

    const result = loginShell(home, 'printf "%s" "$PATH"');

    const entries = result.stdout.split(":");
    expect(entries[0]).toBe(`${home.shell}/bin`);
    expect(entries).toContain(`${home.shell}/.local/bin`);
  });

  it("installs the snippet where Debian login shells source it", () => {
    const dockerfile = readFileSync(path.join(computerRoot, "Dockerfile"), "utf8");
    const copy = "COPY --chmod=644 rakazo-local-bin.sh /etc/profile.d/rakazo-local-bin.sh";
    const copyAt = dockerfile.indexOf(copy);
    const userAt = dockerfile.indexOf("USER 1000:1000");
    expect(copyAt).toBeGreaterThan(-1);
    expect(userAt).toBeGreaterThan(copyAt);
    expect(dockerfile).toContain("/etc/profile.d/rakazo-local-bin.sh");
  });

  function createHome(): Home {
    const fs = mkdtempSync(path.join(tmpdir(), "rakazo-local-bin-"));
    homes.push(fs);
    return { fs, shell: posixPath(fs) };
  }
});

function installHello(home: string): void {
  const directory = path.join(home, ".local", "bin");
  mkdirSync(directory, { recursive: true });
  const hello = path.join(directory, "hello");
  writeFileSync(hello, "#!/bin/sh\nprintf 'hello-from-local-bin\\n'\n");
  chmodSync(hello, 0o755);
}

function loginShell(
  home: Home,
  command: string,
  startup = LOGIN_SHELL_STARTUP,
  shell = "sh",
): { stdout: string } {
  const stdout = execFileSync(shellBinary(shell), ["-c", `${startup}\n${command}`], {
    encoding: "utf8",
    env: {
      HOME: home.shell,
      LOGNAME: "rakazo",
      // The PATH the snippet runs with, so it must stay POSIX for the snippet's parsing.
      PATH: `${home.shell}/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
      USER: "rakazo",
      RAKAZO_LOCAL_BIN_SNIPPET: posixPath(localBinSnippet),
    },
  });
  return { stdout: stdout.trim() };
}

/**
 * The shell to run, resolved against the real PATH before a test replaces PATH for the
 * snippet. Resolving "sh" through that replacement would search Debian's directories and
 * miss a shell that lives elsewhere, such as Git's sh.exe on Windows.
 */
function shellBinary(name: string): string {
  const extensions = process.platform === "win32" ? [".exe", ""] : [""];
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = path.join(directory, `${name}${extension}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return name;
}

/**
 * The shell's own spelling of a path. On Windows that is MSYS form (/tmp/...), which is
 * what the snippet manipulates; elsewhere it is the path unchanged.
 */
function posixPath(target: string): string {
  if (process.platform !== "win32") return target;
  // Ask the shell for its view of the containing directory (works for files and dirs
  // alike), then reattach the name unchanged.
  const directory = execFileSync(
    shellBinary("sh"),
    ["-c", 'cd "$1" && pwd', "sh", path.dirname(target)],
    { encoding: "utf8" },
  ).trim();
  return path.posix.join(directory, path.basename(target));
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
