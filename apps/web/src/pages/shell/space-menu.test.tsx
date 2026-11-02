// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

// Only the menu wiring is under test; the dialog copy is not.
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => `${text}${index > 0 ? values[index - 1] : ""}${part}`, "");
  return {
    useLingui: () => ({ t }),
    Trans: ({ children }: { children: ReactNode }) => children,
    Plural: ({ one }: { one: ReactNode }) => one,
  };
});

const issueTeamConfigToken = vi.fn(async (_spaceId: string) => "tok-1");
const downloadTeamConfig = vi.fn((_token: string) => undefined);
vi.mock("../../components/team-config-transfer", () => ({
  issueTeamConfigToken: (spaceId: string) => issueTeamConfigToken(spaceId),
  downloadTeamConfig: (token: string) => downloadTeamConfig(token),
}));

const selectSpace = vi.fn(() => true);
vi.mock("../../lib/rpc", () => ({ selectSpace: () => selectSpace() }));

import type { Space } from "@rakazo/contracts";
import { ShellDialogs, type ShellDialogsState } from "./shell-dialogs";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  issueTeamConfigToken.mockClear();
  downloadTeamConfig.mockClear();
});

const space = {
  id: "space-2",
  name: "Marketing",
  canDelete: true,
  botCount: 3,
} as unknown as Space;

/** Only the setters the menu touches matter; the rest are inert. */
function dialogsState(): ShellDialogsState {
  const noop = vi.fn();
  return {
    deleteTarget: null,
    deleteGroupTarget: null,
    deleteSpaceTarget: null,
    importSpaceTarget: null,
    spaceMenu: { id: "space-2", position: { x: 0, y: 0 } },
    spaceMenuAnchor: { current: null },
    clearTarget: null,
    newSectionTarget: null,
    renameSectionTarget: null,
    deleteSectionTarget: null,
    newSpaceOpen: false,
    createBotOpen: false,
    commandPaletteOpen: false,
    setDeleteTarget: noop,
    setDeleteGroupTarget: noop,
    setImportSpaceTarget: noop,
    setDeleteSpaceTarget: noop,
    setSpaceMenu: noop,
    closeSpaceMenu: noop,
    setClearTarget: noop,
    setNewSectionTarget: noop,
    setRenameSectionTarget: noop,
    setDeleteSectionTarget: noop,
    setNewSpaceOpen: noop,
    setCreateBotOpen: noop,
    setCommandPaletteOpen: noop,
  } as unknown as ShellDialogsState;
}

async function render() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <ShellDialogs
        dialogs={dialogsState()}
        rpc={{} as never}
        spaces={[space]}
        bots={[]}
        activeId={undefined}
        activeGroupId={undefined}
        alive={{ current: true }}
        navigate={() => undefined}
        setPanel={() => undefined}
        refreshBots={async () => undefined}
        removeSpace={async () => undefined}
        openSpaceSettings={() => undefined}
        closeMobileSidebar={() => undefined}
        createBot={async () => undefined}
        clearOpenThread={() => undefined}
        deleteRoutineDialogProps={null}
      />,
    );
  });
}

function menuItem(label: string): HTMLElement | undefined {
  return [...document.body.querySelectorAll('[role="menuitem"]')].find((node) =>
    node.textContent?.includes(label),
  ) as HTMLElement | undefined;
}

it("offers export and import on the space menu", async () => {
  await render();
  expect(menuItem("Export workspace configuration")).toBeTruthy();
  expect(menuItem("Import workspace configuration")).toBeTruthy();
});

it("exports the workspace the menu belongs to", async () => {
  await render();
  await act(async () => {
    menuItem("Export workspace configuration")!.click();
  });
  expect(issueTeamConfigToken).toHaveBeenCalledWith("space-2");
  expect(downloadTeamConfig).toHaveBeenCalledWith("tok-1");
});
