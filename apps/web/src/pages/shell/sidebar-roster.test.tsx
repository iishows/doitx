// @vitest-environment jsdom
import type { Bot, Group, Space } from "@rakazo/contracts";
import { act, createRef } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SidebarRoster } from "./sidebar-roster";
import { sidebarGroupsForSpaces } from "./space-sidebar";

// The roster's copy is not under test.
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children?: unknown }) => <>{children}</>,
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw(strings, ...values),
  }),
}));

function bot(id: string, name: string, unread: boolean): Bot {
  return {
    id,
    name,
    title: "",
    description: "",
    instructions: "",
    color: "#4d9bff",
    notifyOnFinish: false,
    pinned: false,
    sectionId: null,
    archivedAt: null,
    unread,
    parentBotId: null,
    memoryScope: null,
    threadId: `thread-${id}`,
    preview: "",
    status: "idle",
    runErrorId: null,
    computerMode: "off",
    updatedAt: new Date(2026, 0, 1).toISOString(),
  } as unknown as Bot;
}

function space(id: string, name: string, bots: Bot[]): Space {
  return {
    id,
    name,
    canRename: true,
    canDelete: false,
    bots,
    groups: [] as Group[],
    botSections: [],
  } as unknown as Space;
}

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function renderRoster(spaces: Space[]) {
  const groups = sidebarGroupsForSpaces(spaces, "");
  act(() =>
    root.render(
      <SidebarRoster
        sidebarGroups={groups}
        collapsedSidebarSections={new Set<string>()}
        bootstrapMe={{ spaceId: spaces[0]?.id ?? "none" }}
        botSections={[]}
        spaces={spaces}
        rosterDropKey={null}
        setRosterDropKey={() => undefined}
        rosterDropAction={() => null}
        applyRosterDrop={() => undefined}
        openSpaceChat={() => undefined}
        spaceMenuAnchor={createRef<HTMLElement>()}
        setSpaceMenu={() => undefined}
        setRenameSectionTarget={() => undefined}
        setDeleteSectionTarget={() => undefined}
        toggleSidebarSection={() => undefined}
        openSpace={null}
        toggleSidebarSpace={() => undefined}
        searching={false}
        inGroup={false}
        active={undefined}
        activeGroup={undefined}
        botsSidebarDensity="comfortable"
        dismissedRunErrorIds={new Set<string>()}
        displayedRunError={null}
        draggedBotId={null}
        setDraggedBotId={() => undefined}
        botMenu={null}
        setBotMenu={() => undefined}
        reorderRosterBot={() => undefined}
        activeSnapshot={null}
        botMenuContent={null}
      />,
    ),
  );
}

it("shows each workspace's unread count on its header", () => {
  renderRoster([
    space("first", "First", [bot("a", "Alpha", true), bot("b", "Beta", true)]),
    space("second", "Second", [bot("c", "Gamma", false)]),
  ]);

  const badges = [...container.querySelectorAll("[data-roster-space-unread]")];
  expect(badges.map((badge) => badge.getAttribute("data-roster-space-unread"))).toEqual(["2"]);
});

it("reads the count out with the header that carries it", () => {
  renderRoster([
    space("first", "First", [bot("a", "Alpha", true)]),
    space("second", "Second", [bot("c", "Gamma", false)]),
  ]);

  const spoken = container.querySelector("#roster-space-unread-first");
  expect(spoken?.textContent).toBe("1 (unread)");
  // The visible number is hidden from screen readers so the count is not read
  // twice; only the described-by text carries it.
  const visible = container.querySelector("[data-roster-space-unread] > span");
  expect(visible?.getAttribute("aria-hidden")).toBe("true");
  // The header's aria-label replaces its text, so the count is tied on with
  // aria-describedby instead of being dropped from the accessibility tree.
  const header = container.querySelector('[aria-describedby="roster-space-unread-first"]');
  expect(header?.getAttribute("aria-label")).toContain("First");
});

it("leaves a workspace with no unread chats unbadged", () => {
  renderRoster([
    space("first", "First", [bot("a", "Alpha", false)]),
    space("second", "Second", [bot("c", "Gamma", false)]),
  ]);

  expect(container.querySelector("[data-roster-space-unread]")).toBeNull();
});
