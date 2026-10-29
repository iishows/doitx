import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertComputerHomeWritable, assertOpenedDirectoryBeneathRoot } from "./home-ownership.js";

const roots: string[] = [];
const DIRECTORY_OPEN_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

/**
 * Windows-only stand-in for an entry the sandbox wrote that the host cannot stat.
 * icacls DENY covers a path and everything below it, so lstat and opendir underneath
 * both surface EPERM/EACCES, the same refusal a sandbox-written symlink produces.
 * Resolves to a function that lifts the rule again, or undefined when icacls is
 * unavailable so the caller can skip rather than assert against an unrestricted home.
 */
async function denyReadAccess(target: string): Promise<(() => Promise<void>) | undefined> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  const user = process.env.USERNAME ?? "*";
  try {
    await run("icacls", [target, "/deny", `${user}:(OI)(CI)(RX)`], { windowsHide: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return async () => {
    await run("icacls", [target, "/remove:d", user], { windowsHide: true }).catch(() => undefined);
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

// Windows reports synthetic `uid 0`/`gid 0` and directory modes without execute
// bits, so every case here would either fail or pass vacuously. CI runs Linux.
describe.skipIf(process.platform === "win32")("computer home ownership", () => {
  it("rejects a missing home instead of creating it as root", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "rakazo-home-missing-"));
    roots.push(parent);

    await expect(
      assertComputerHomeWritable(path.join(parent, "missing"), 1000, 1000),
    ).rejects.toThrow(/does not exist/);
  });

  it("rejects a symlink as the home root", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "rakazo-home-root-link-"));
    roots.push(parent);
    const outside = path.join(parent, "outside");
    const home = path.join(parent, "home");
    await mkdir(outside);
    await symlink(outside, home);

    await expect(assertComputerHomeWritable(home, 1000, 1000)).rejects.toThrow(/symbolic link/);
  });

  it("rejects a writable regular file as the home root", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "rakazo-home-file-root-"));
    roots.push(parent);
    const home = path.join(parent, "home");
    await writeFile(home, "{}");
    await chmod(home, 0o600);

    const stat = await lstat(home);
    await expect(assertComputerHomeWritable(home, stat.uid, stat.gid)).rejects.toThrow(
      /must be a directory/,
    );
  });

  it("rejects an existing entry that the host-run computer cannot write", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "rakazo-home-writable-"));
    roots.push(parent);
    const home = path.join(parent, "home");
    const file = path.join(home, "profile.json");
    await mkdir(home);
    await chmod(home, 0o777);
    await writeFile(file, "{}");
    await chmod(file, 0o400);

    const stat = await lstat(home);
    await expect(assertComputerHomeWritable(home, stat.uid + 1, stat.gid + 1)).rejects.toThrow(
      /chown -R/,
    );
  });

  it("accepts writable files owned by the sandbox user", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "rakazo-home-writable-file-"));
    roots.push(parent);
    const home = path.join(parent, "home");
    const file = path.join(home, "profile.json");
    await mkdir(home);
    await writeFile(file, "{}");
    await chmod(file, 0o644);

    const stat = await lstat(file);
    await expect(assertComputerHomeWritable(home, stat.uid, stat.gid)).resolves.toBeUndefined();
  });

  it("accepts sandbox-owned read-only git object files", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "rakazo-home-git-object-"));
    roots.push(parent);
    const home = path.join(parent, "home");
    const object = path.join(home, "repo", ".git", "objects", "ab", "cdef");
    await mkdir(path.dirname(object), { recursive: true });
    await writeFile(object, "blob");
    await chmod(object, 0o444);

    const stat = await lstat(object);
    await expect(assertComputerHomeWritable(home, stat.uid, stat.gid)).resolves.toBeUndefined();
  });

  it("rejects a read-only file owned by someone else", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "rakazo-home-foreign-readonly-"));
    roots.push(parent);
    const home = path.join(parent, "home");
    const file = path.join(home, "object");
    await mkdir(home);
    await chmod(home, 0o777);
    await writeFile(file, "blob");
    await chmod(file, 0o444);

    const stat = await lstat(file);
    await expect(assertComputerHomeWritable(home, stat.uid + 1, stat.gid + 1)).rejects.toThrow(
      /chown -R/,
    );
  });

  it("rejects an owner-owned file the owner cannot read", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "rakazo-home-unreadable-"));
    roots.push(parent);
    const home = path.join(parent, "home");
    const file = path.join(home, "profile.json");
    await mkdir(home);
    await writeFile(file, "{}");
    await chmod(file, 0o000);

    const stat = await lstat(file);
    await expect(assertComputerHomeWritable(home, stat.uid, stat.gid)).rejects.toThrow(/chown -R/);
  });

  it("rejects an owner-owned world-writable file the owner cannot write", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "rakazo-home-world-writable-"));
    roots.push(parent);
    const home = path.join(parent, "home");
    const file = path.join(home, "profile.json");
    await mkdir(home);
    await writeFile(file, "{}");
    await chmod(file, 0o002);

    const stat = await lstat(file);
    await expect(assertComputerHomeWritable(home, stat.uid, stat.gid)).rejects.toThrow(/chown -R/);
  });

  it("rejects an owner-owned directory that is not writable", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "rakazo-home-dir-mode-"));
    roots.push(parent);
    const home = path.join(parent, "home");
    await mkdir(home);
    await chmod(home, 0o555);

    const stat = await lstat(home);
    await expect(assertComputerHomeWritable(home, stat.uid, stat.gid)).rejects.toThrow(/chown -R/);
  });

  it("does not follow symlinks while checking host-run compatibility", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "rakazo-home-writable-link-"));
    roots.push(parent);
    const home = path.join(parent, "home");
    const outside = path.join(parent, "outside");
    await mkdir(home);
    await writeFile(outside, "outside");
    await chmod(outside, 0o400);
    await symlink(outside, path.join(home, "link"));

    const stat = await lstat(home);
    await expect(assertComputerHomeWritable(home, stat.uid, stat.gid)).resolves.toBeUndefined();
  });

  it.skipIf(process.platform !== "linux")(
    "rejects an opened directory that was moved outside the home",
    async () => {
      const parent = await mkdtemp(path.join(tmpdir(), "rakazo-home-moved-"));
      roots.push(parent);
      const home = path.join(parent, "home");
      const outside = path.join(parent, "outside");
      const child = path.join(home, "nested");
      await mkdir(child, { recursive: true });
      await mkdir(outside, { recursive: true });
      const handle = await open(child, DIRECTORY_OPEN_FLAGS);
      try {
        await rename(child, path.join(outside, "nested"));
        await expect(assertOpenedDirectoryBeneathRoot(handle, home)).rejects.toThrow(
          /escaped validated root/,
        );
      } finally {
        await handle.close();
      }
    },
  );
});

// Windows exposes no POSIX ownership, so the walk skips mode checks but must still
// validate existence and shape. Regression guard: a plain home allocated by the host
// used to be refused here because its synthetic uid/gid never matched the sandbox pair.
describe.skipIf(process.platform !== "win32")("computer home ownership on Windows", () => {
  it("accepts a home the host allocated, including nested files", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "rakazo-home-win-"));
    roots.push(home);
    await mkdir(path.join(home, "repo", ".git", "objects", "ab"), { recursive: true });
    await writeFile(path.join(home, "repo", ".git", "objects", "ab", "cdef"), "blob");
    await writeFile(path.join(home, "profile.json"), "{}");

    await expect(assertComputerHomeWritable(home, 0, 0)).resolves.toBeUndefined();
  });

  it("still rejects a missing home instead of creating it as root", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "rakazo-home-win-missing-"));
    roots.push(parent);

    await expect(assertComputerHomeWritable(path.join(parent, "missing"), 0, 0)).rejects.toThrow(
      /does not exist/,
    );
  });

  it("still rejects a regular file as the home root", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "rakazo-home-win-file-"));
    roots.push(parent);
    const home = path.join(parent, "home");
    await writeFile(home, "{}");

    await expect(assertComputerHomeWritable(home, 0, 0)).rejects.toThrow(/must be a directory/);
  });

  // A home is bind mounted into a Linux sandbox, so the sandbox can leave entries on it
  // that Windows keeps but refuses to describe. Chromium's SingletonCookie and
  // SingletonSocket are the live case: symlinks the sandbox creates, which Windows lstat
  // answers with EACCES. The walk used to fail on that and provisioning reported the home
  // as not writable. An access rule Windows honours but POSIX would not reproduces the
  // same refusal from the host, without needing a container.
  it("skips entries Windows refuses to stat instead of refusing the whole home", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "rakazo-home-win-unstattable-"));
    roots.push(parent);
    const home = path.join(parent, "home");
    const sandboxWritten = path.join(home, ".browser-profiles");
    await mkdir(sandboxWritten, { recursive: true });
    await writeFile(path.join(sandboxWritten, "Preferences"), "{}");
    const releaseAccess = await denyReadAccess(sandboxWritten);
    if (!releaseAccess) return;
    try {
      // Guard the premise: without a real refusal this case would pass vacuously.
      await expect(lstat(path.join(sandboxWritten, "Preferences"))).rejects.toMatchObject({
        code: "EPERM",
      });

      await expect(assertComputerHomeWritable(home, 0, 0)).resolves.toBeUndefined();
    } finally {
      await releaseAccess();
    }
  });
});
