import { describe, expect, it } from "vitest";
import { BotBrowserProxyInputSchema, BotBrowserProxyUrlSchema, UpdateBotInput } from "./domain.js";

describe("bot browser proxy contract", () => {
  it("accepts the supported upstream schemes with a host and port", () => {
    for (const url of [
      "http://proxy.example:8080",
      "https://proxy.example:8443",
      "socks5://proxy.example:1080",
      "socks5h://proxy.example:1080",
      "socks5://10.0.0.1:1080",
    ]) {
      expect(BotBrowserProxyUrlSchema.safeParse(url).success, url).toBe(true);
    }
  });

  it("rejects a scheme Chromium cannot route", () => {
    for (const url of [
      "ftp://proxy.example:21",
      "file:///etc/passwd",
      "proxy.example:8080",
      "just-a-string",
    ]) {
      expect(BotBrowserProxyUrlSchema.safeParse(url).success, url).toBe(false);
    }
  });

  it("rejects a URL with no host or no port", () => {
    expect(BotBrowserProxyUrlSchema.safeParse("http://proxy.example").success).toBe(false);
    expect(BotBrowserProxyUrlSchema.safeParse("socks5://:1080").success).toBe(false);
  });

  it("keeps credentials out of the URL so they never land in a log or the argv", () => {
    const result = BotBrowserProxyUrlSchema.safeParse("socks5://user:secret@proxy.example:1080");
    expect(result.success).toBe(false);
  });

  it("carries an optional write-only password", () => {
    const parsed = BotBrowserProxyInputSchema.parse({
      enabled: true,
      url: "socks5://proxy.example:1080",
      username: "user",
    });
    expect(parsed.password).toBeUndefined();

    const withPassword = BotBrowserProxyInputSchema.parse({
      enabled: true,
      url: "socks5://proxy.example:1080",
      username: "user",
      password: "secret",
    });
    expect(withPassword.password).toBe("secret");
  });

  it("accepts the proxy on the bot update input and allows clearing it", () => {
    const base = { botId: "bot-1" };
    expect(
      UpdateBotInput.safeParse({
        ...base,
        browserProxy: { enabled: true, url: "http://proxy.example:8080" },
      }).success,
    ).toBe(true);
    expect(UpdateBotInput.safeParse({ ...base, browserProxy: null }).success).toBe(true);
    // Omitting the field leaves the stored setting untouched.
    expect(UpdateBotInput.safeParse(base).success).toBe(true);
  });

  it("rejects an invalid proxy through the bot update input", () => {
    expect(
      UpdateBotInput.safeParse({
        botId: "bot-1",
        browserProxy: { enabled: true, url: "not-a-proxy" },
      }).success,
    ).toBe(false);
  });
});
