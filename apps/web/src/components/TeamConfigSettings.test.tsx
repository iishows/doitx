// @vitest-environment jsdom

import { i18n } from "@lingui/core";
import type * as Core from "@rakazo/core";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => `${text}${index > 0 ? values[index - 1] : ""}${part}`, "");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});

const teamConfigToken = vi.fn();
const teamConfigPreview = vi.fn();
const teamConfigCreate = vi.fn();
vi.mock("../lib/rpc", () => ({
  rpc: {
    export: {
      teamConfigToken: () => teamConfigToken(),
      teamConfigPreview: (input: unknown) => teamConfigPreview(input),
      teamConfigCreate: (input: unknown) => teamConfigCreate(input),
    },
  },
}));

vi.mock("@rakazo/core", async (importOriginal) => ({
  ...(await importOriginal<typeof Core>()),
  openAgentImportArchive: () => ({
    paths: ["manifest.json", "bots/chief.json"],
    read: () => "{}",
    size: () => 2,
  }),
}));

vi.mock("./ConfirmIdentityDialog", () => ({
  useIdentityConfirmation: () => ({
    withIdentityConfirmation: (action: () => Promise<unknown>) => action(),
    identityDialog: null,
  }),
}));

import { TeamConfigSettings } from "./TeamConfigSettings";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

const preview = {
  sourceWorkspace: "Marketing",
  exportedAt: "2026-11-06T00:00:00.000Z",
  bots: [
    {
      key: "bot:chief",
      name: "Chief of Staff",
      warnings: [],
      routines: 2,
      mcpServers: 1,
      needsCredentials: true,
      nameTaken: false,
    },
    {
      key: "bot:writer",
      name: "Writer",
      warnings: [],
      routines: 0,
      mcpServers: 0,
      needsCredentials: false,
      nameTaken: true,
    },
  ],
  counts: { sections: 1, connections: 0, skills: 0 },
  droppedPreferences: [{ provider: "anthropic" }],
};

beforeEach(() => {
  teamConfigToken.mockReset();
  teamConfigPreview.mockReset();
  teamConfigCreate.mockReset();
  i18n.load("en", {});
  i18n.activate("en");
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

async function render() {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<TeamConfigSettings />);
  });
}

/** Hand the file input a file and wait for the read it triggers. */
async function chooseFile() {
  const input = container!.querySelector<HTMLInputElement>('[data-testid="team-config-file"]')!;
  const file = new File(["zip"], "workspace.zip", { type: "application/zip" });
  Object.defineProperty(file, "arrayBuffer", { value: async () => new ArrayBuffer(4) });
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

describe("TeamConfigSettings", () => {
  it("downloads through a token, never a fetch", async () => {
    teamConfigToken.mockResolvedValue({ token: "tok-1" });
    const clicks: string[] = [];
    const original = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function click(this: HTMLAnchorElement) {
      clicks.push(this.href);
    };
    try {
      await render();
      const button = container!.querySelector<HTMLButtonElement>(
        '[data-testid="team-config-export"]',
      )!;
      await act(async () => {
        button.click();
      });
      expect(clicks[0]).toContain("/api/team-config/export?token=tok-1");
    } finally {
      HTMLAnchorElement.prototype.click = original;
    }
  });

  it("shows each bot with its counts, and ticks them all by default", async () => {
    teamConfigPreview.mockResolvedValue(preview);
    await render();
    await chooseFile();

    expect(container!.textContent).toContain("Chief of Staff");
    expect(container!.textContent).toContain("Writer");
    expect(container!.textContent).toContain("2 routines · 1 servers");
    expect(
      container!.querySelector<HTMLInputElement>('[data-testid="team-config-bot-bot:chief"]')!
        .checked,
    ).toBe(true);
    expect(container!.textContent).toContain("Import 2 bots");
  });

  it("sends only the bots left ticked", async () => {
    teamConfigPreview.mockResolvedValue(preview);
    teamConfigCreate.mockResolvedValue({ created: [{ key: "bot:writer", name: "Writer" }] });
    await render();
    await chooseFile();

    const chief = container!.querySelector<HTMLInputElement>(
      '[data-testid="team-config-bot-bot:chief"]',
    )!;
    await act(async () => {
      chief.click();
    });
    const create = container!.querySelector<HTMLButtonElement>(
      '[data-testid="team-config-create"]',
    )!;
    await act(async () => {
      create.click();
    });

    expect(teamConfigCreate).toHaveBeenCalledWith({
      files: [
        { path: "manifest.json", content: "{}" },
        { path: "bots/chief.json", content: "{}" },
      ],
      selection: { keys: ["bot:writer"] },
    });
    expect(container!.textContent).toContain("Created 1 bot.");
  });

  it("names a dropped model preference rather than failing with it", async () => {
    teamConfigPreview.mockResolvedValue(preview);
    await render();
    await chooseFile();
    expect(container!.textContent).toContain("anthropic");
  });

  it("says a foreign file is not a workspace archive", async () => {
    teamConfigPreview.mockRejectedValue(new Error("not_an_archive"));
    await render();
    await chooseFile();
    expect(container!.querySelector('[data-testid="team-config-error"]')?.textContent).toContain(
      "not_an_archive",
    );
  });
});
