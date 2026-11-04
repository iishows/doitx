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

const teamConfigPreview = vi.fn<(_input: unknown) => Promise<unknown>>(() => Promise.resolve());
const teamConfigCreate = vi.fn<(_input: unknown) => Promise<unknown>>(() => Promise.resolve());
const rpcForSpace = vi.fn((_spaceId: string) => ({
  export: {
    teamConfigPreview: (input: unknown) => teamConfigPreview(input),
    teamConfigCreate: (input: unknown) => teamConfigCreate(input),
  },
}));
vi.mock("../../lib/rpc", () => ({ rpcForSpace: (spaceId: string) => rpcForSpace(spaceId) }));

vi.mock("@rakazo/core", async (importOriginal) => ({
  ...(await importOriginal<typeof Core>()),
  openAgentImportArchive: () => ({
    paths: ["manifest.json", "bots/chief.json"],
    read: () => "{}",
    size: () => 2,
  }),
}));

import { ImportWorkspaceDialog } from "./ImportWorkspaceDialog";

let root: Root | null = null;
let container: HTMLDivElement | null = null;
const done = vi.fn();

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
  teamConfigPreview.mockReset();
  teamConfigCreate.mockReset();
  rpcForSpace.mockClear();
  done.mockReset();
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
    root!.render(
      <ImportWorkspaceDialog
        spaceId="space-2"
        spaceName="Target"
        onClose={() => undefined}
        onDone={done}
      />,
    );
  });
}

/** The dialog portals into `document.body`, so assertions read from there. */
function view(): HTMLElement {
  return document.body;
}

/** Hand the file input a file and wait for the read it triggers. */
async function chooseFile() {
  const input = view().querySelector<HTMLInputElement>('[data-testid="import-workspace-file"]')!;
  const file = new File(["zip"], "workspace.zip", { type: "application/zip" });
  Object.defineProperty(file, "arrayBuffer", { value: async () => new ArrayBuffer(4) });
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

describe("ImportWorkspaceDialog", () => {
  // A browser only opens a file chooser from a user gesture, so the dialog must offer a control
  // that does it. Without one the dialog opens onto nothing and can never be used.
  it("opens the file chooser from a visible control", async () => {
    await render();
    const input = view().querySelector<HTMLInputElement>('[data-testid="import-workspace-file"]')!;
    let clicked = 0;
    input.click = () => {
      clicked += 1;
    };
    const choose = view().querySelector<HTMLButtonElement>(
      '[data-testid="import-workspace-choose"]',
    )!;
    await act(async () => {
      choose.click();
    });
    expect(clicked).toBe(1);
  });

  it("reads and previews into the space the menu belongs to", async () => {
    teamConfigPreview.mockResolvedValue(preview);
    await render();
    await chooseFile();

    expect(rpcForSpace).toHaveBeenCalledWith("space-2");
    expect(view().textContent).toContain("Chief of Staff");
    expect(view().textContent).toContain("Writer");
    expect(view().textContent).toContain("2 routines · 1 servers");
  });

  it("ticks every bot by default", async () => {
    teamConfigPreview.mockResolvedValue(preview);
    await render();
    await chooseFile();

    expect(
      view().querySelector<HTMLInputElement>('[data-testid="import-workspace-bot-bot:chief"]')!
        .checked,
    ).toBe(true);
    expect(view().textContent).toContain("Import 2 bots");
  });

  it("sends only the bots left ticked", async () => {
    teamConfigPreview.mockResolvedValue(preview);
    teamConfigCreate.mockResolvedValue({ created: [{ key: "bot:writer", name: "Writer" }] });
    await render();
    await chooseFile();

    const chief = view().querySelector<HTMLInputElement>(
      '[data-testid="import-workspace-bot-bot:chief"]',
    )!;
    await act(async () => {
      chief.click();
    });
    const create = view().querySelector<HTMLButtonElement>(
      '[data-testid="import-workspace-create"]',
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
    expect(done).toHaveBeenCalledWith("Created 1 bot.");
  });

  it("names a dropped model preference rather than failing with it", async () => {
    teamConfigPreview.mockResolvedValue(preview);
    await render();
    await chooseFile();
    expect(view().textContent).toContain("anthropic");
  });

  it("says a foreign file is not a workspace archive", async () => {
    teamConfigPreview.mockRejectedValue(new Error("not_an_archive"));
    await render();
    await chooseFile();
    expect(view().querySelector('[data-testid="import-workspace-error"]')?.textContent).toContain(
      "not_an_archive",
    );
  });
});
