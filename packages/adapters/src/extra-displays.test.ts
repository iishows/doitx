import { execFile, execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  extraDisplayActionCommand,
  observeExtraDisplayCommand,
  parseExtraDisplayObservation,
} from "./extra-displays.js";

const run = promisify(execFile);
const cleanups: string[] = [];

afterEach(() => {
  for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * Fake X tools. scrot appends its display name in slow steps, so overlapping calls on a shared
 * file interleave, and writes enough bytes that the wrapping base64 below splits the output.
 */
function fakeTools() {
  const bin = mkdtempSync(path.join(tmpdir(), "rakazo-observe-bin-"));
  cleanups.push(bin);
  writeFileSync(
    path.join(bin, "scrot"),
    '#!/bin/sh\nfor i in 1 2 3 4 5; do head -c 100 /dev/zero | tr "\\0" "$DISPLAY_CHAR" >> "$2"; sleep 0.05; done\n',
  );
  writeFileSync(path.join(bin, "xdotool"), "#!/bin/sh\necho X=12\necho Y=34\n");
  // Wraps at 76 columns like GNU base64, whatever the host's base64 does. Call the host's
  // base64 by path: a Windows-style PATH is not searchable inside an already-running shell.
  const realBase64 = execFileSync("sh", ["-c", "command -v base64"], { encoding: "utf8" }).trim();
  writeFileSync(
    path.join(bin, "base64"),
    `#!/bin/sh\n${JSON.stringify(realBase64)} "$@" | tr -d "\\n" | fold -w 76\n`,
  );
  for (const tool of ["scrot", "xdotool", "base64"]) chmodSync(path.join(bin, tool), 0o755);
  return bin;
}

describe("observing an extra display", () => {
  it("keeps overlapping screenshots of one display apart and removes them", async () => {
    const bin = fakeTools();
    // A display number no other test uses, so only this test's files are counted.
    const displayNumber = 90_000 + process.pid;
    // Ask the same shell that writes the temporary files where /tmp points on this host.
    const owned = async () => {
      const { stdout } = await run("sh", ["-c", "ls /tmp/rakazo 2>/dev/null || true"]);
      return stdout.split("\n").filter((name) => name.startsWith(`observe-${displayNumber}-`));
    };
    const observe = (char: string) =>
      run("sh", ["-c", observeExtraDisplayCommand({ display: ":7", displayNumber })], {
        env: {
          ...process.env,
          PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
          DISPLAY_CHAR: char,
        },
      });
    const outputs = await Promise.all([observe("a"), observe("b")]);
    for (const [index, char] of ["a", "b"].entries()) {
      const observed = parseExtraDisplayObservation(outputs[index]!.stdout);
      expect(Buffer.from(observed.image).toString()).toBe(char.repeat(500));
      expect(observed.cursor).toEqual({ x: 12, y: 34 });
    }
    expect(await owned()).toEqual([]);
  });
});

describe("extra display scroll", () => {
  const layout = { display: ":3" } as Parameters<typeof extraDisplayActionCommand>[0];

  it("moves the pointer to the scroll's point before turning the wheel", () => {
    expect(
      extraDisplayActionCommand(layout, {
        kind: "scroll",
        direction: "down",
        amount: 4,
        x: 600.4,
        y: 420,
      }),
    ).toBe("DISPLAY=:3 xdotool mousemove 600 420 click --repeat 4 5");
  });

  it("scrolls sideways with the left and right wheel buttons", () => {
    expect(
      extraDisplayActionCommand(layout, {
        kind: "scroll",
        direction: "left",
        amount: 2,
        x: 40,
        y: 300,
      }),
    ).toBe("DISPLAY=:3 xdotool mousemove 40 300 click --repeat 2 6");
    expect(
      extraDisplayActionCommand(layout, { kind: "scroll", direction: "right", amount: 2 }),
    ).toBe("DISPLAY=:3 xdotool click --repeat 2 7");
  });

  it("turns the wheel where the pointer is without a point", () => {
    expect(extraDisplayActionCommand(layout, { kind: "scroll", direction: "up", amount: 2 })).toBe(
      "DISPLAY=:3 xdotool click --repeat 2 4",
    );
  });
});
