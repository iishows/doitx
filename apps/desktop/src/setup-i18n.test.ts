// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

type Messages = Record<string, Record<string, string>>;

interface SetupI18n {
  LOCALES: string[];
  LABELS: Record<string, string>;
  MESSAGES: Messages;
  RTL_LOCALES: Set<string>;
  matchLocale: (raw: string | null | undefined) => string;
}

const srcDir = path.dirname(fileURLToPath(import.meta.url));

let i18n: SetupI18n;

beforeAll(() => {
  new Function(readFileSync(path.join(srcDir, "setup-i18n.js"), "utf8"))();
  i18n = (window as unknown as { rakazoSetupI18n: SetupI18n }).rakazoSetupI18n;
});

function placeholders(message: string): string[] {
  return [...message.matchAll(/\{(\w+)\}/g)].map((match) => match[1] ?? "").sort();
}

describe("setup translations", () => {
  it("covers every locale with the English key set", () => {
    expect(i18n.LOCALES).toHaveLength(14);
    const englishKeys = Object.keys(i18n.MESSAGES.en).sort();

    for (const locale of i18n.LOCALES) {
      const messages = i18n.MESSAGES[locale];
      expect(messages, locale).toBeDefined();
      expect(Object.keys(messages ?? {}).sort(), locale).toEqual(englishKeys);
      for (const [key, message] of Object.entries(messages ?? {})) {
        expect(message.trim(), `${locale}.${key}`).not.toBe("");
      }
      expect(i18n.LABELS[locale], locale).toBeTruthy();
    }
  });

  it("keeps interpolation placeholders in every translation", () => {
    for (const locale of i18n.LOCALES) {
      for (const [key, message] of Object.entries(i18n.MESSAGES.en)) {
        expect(placeholders(i18n.MESSAGES[locale]?.[key] ?? ""), `${locale}.${key}`).toEqual(
          placeholders(message),
        );
      }
    }
  });

  it("matches browser locale tags the way the web app does", () => {
    expect(i18n.matchLocale("de-DE")).toBe("de");
    expect(i18n.matchLocale("pt")).toBe("pt-BR");
    expect(i18n.matchLocale("pt-BR")).toBe("pt-BR");
    expect(i18n.matchLocale("es-MX")).toBe("es");
    expect(i18n.matchLocale("zh-Hant-TW")).toBe("zh-TW");
    expect(i18n.matchLocale("zh-HK")).toBe("zh-TW");
    expect(i18n.matchLocale("zh-CN")).toBe("zh-CN");
    expect(i18n.matchLocale("iw")).toBe("he");
    expect(i18n.matchLocale("fr-CA")).toBe("fr");
    expect(i18n.matchLocale("xx")).toBe("en");
    expect(i18n.matchLocale(null)).toBe("en");
  });

  it("marks only Hebrew as right-to-left", () => {
    expect([...i18n.RTL_LOCALES]).toEqual(["he"]);
  });
});
