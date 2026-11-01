import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("checks the browser proxy relay against fake HTTP and SOCKS5 upstreams", () => {
  const tests = fileURLToPath(
    new URL("../../computer/test_browser_proxy_relay.py", import.meta.url),
  );
  expect(() => execFileSync("python3", [tests], { timeout: 60_000, stdio: "pipe" })).not.toThrow();
});
