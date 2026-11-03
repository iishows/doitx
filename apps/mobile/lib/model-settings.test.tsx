// @vitest-environment jsdom

import { notifyManager } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act, createElement, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ModelConnection from "../app/(settings)/model-connection";
import Models from "../app/(settings)/models";
import type { ModelConnectionRequest } from "./model-connection-request";
import { modelConnectionRequest, openModelConnection } from "./model-connection-request";
import { modelPickerRequest } from "./model-picker-selection";
import { queryClient } from "./query";

const { push, back, params, rpcCalls, saved } = vi.hoisted(() => ({
  push: vi.fn(),
  back: vi.fn(),
  params: {} as { requestId?: string; spaceId?: string },
  rpcCalls: [] as [string, unknown, { requestContext?: { headers: object } }?][],
  saved: {
    hasKey: false,
    label: "Fixture",
    held: null as Promise<void> | null,
    failMe: false,
  },
}));

vi.mock("./session", () => ({ currentSessionGeneration: () => 1 }));
vi.mock("./side-insets", () => ({ useSideInsets: () => ({}) }));
vi.mock("./api", () => ({
  currentApiBase: () => "https://app.example.test",
  captureApiRequestContext: async (spaceId = "space-fixture") => ({
    headers: { "x-rakazo-space-id": spaceId },
  }),
  selectedSpaceId: () => "space-fixture",
  rpc: async (
    procedure: string,
    input?: unknown,
    options?: { requestContext?: { headers: object } },
  ) => {
    rpcCalls.push([procedure, input, options]);
    if (saved.held) await saved.held;
    if (saved.failMe && procedure === "me") throw new Error("offline");
    if (procedure === "me")
      return {
        userId: "user-fixture",
        spaceId: "space-fixture",
        defaultProvider: "local",
        defaultModel: "model-fixture",
      };
    if (procedure === "models/role") return { primary: null, backups: [] };
    if (procedure === "models/connect") return { id: "credential-new" };
    if (procedure === "models/forRole") return [];
    if (procedure === "models/list")
      return [
        {
          provider: "local",
          providerName: "Local (self-hosted endpoint)",
          id: "model-fixture",
          label: "Fixture",
        },
        // Deployment-funded models still leave room for a personal key.
        {
          provider: "doitx",
          providerName: "Doitx Router",
          id: "doitx-fixture",
          label: "Doitx Fixture",
        },
      ];
    if (procedure === "models/credentials")
      return [
        {
          id: "credential-fixture",
          provider: "local",
          modelId: "model-fixture",
          hasKey: saved.hasKey,
          label: saved.label,
        },
      ];
    return [];
  },
}));
vi.mock("expo-router", () => ({
  useRouter: () => ({ push, back }),
  useNavigation: () => ({ setOptions: vi.fn() }),
  useLocalSearchParams: () => params,
  useFocusEffect: (effect: () => (() => void) | undefined) => useEffect(effect, [effect]),
}));
vi.mock("@expo/ui/community/menu", () => ({
  MenuView: ({ children }: { children?: ReactNode }) => createElement("div", {}, children),
}));
vi.mock("expo-clipboard", () => ({ setStringAsync: vi.fn() }));
vi.mock("./appearance", () => ({ mobileTokens: () => ({}) }));
vi.mock("./native", () => ({
  native: new Proxy({}, { get: (_target, name) => String(name) }),
  useResolvedAppearance: () => "light",
  useThemedStyles: (createStyles: () => unknown) => createStyles(),
}));
vi.mock("./user-error", () => ({
  errorText: (_: unknown, fallback = "Something went wrong. Try again.") => fallback,
}));
vi.mock("./i18n", () => {
  const t = (text: string) => text;
  return { useI18n: () => ({ t }) };
});
vi.mock("./message-action-sheet", () => ({ presentMessageActionSheet: vi.fn() }));
vi.mock("../components/native-switch", () => ({ NativeSwitch: () => null }));
vi.mock("../components/native-symbol", () => ({ NativeSymbol: () => null }));
vi.mock("../components/row-accessories", () => ({ Chevron: () => null, Checkmark: () => null }));
vi.mock("../components/native-action-button", () => ({
  NativeActionButton: ({
    label,
    accessibilityLabel,
    onPress,
    disabled,
  }: {
    label?: string;
    accessibilityLabel?: string;
    onPress: () => void;
    disabled?: boolean;
  }) =>
    createElement(
      "button",
      { type: "button", onClick: onPress, disabled, "aria-label": accessibilityLabel },
      label,
    ),
}));
vi.mock("react-native", () => {
  const view = ({ children }: { children?: ReactNode }) => createElement("div", {}, children);
  return {
    AccessibilityInfo: { announceForAccessibility: vi.fn() },
    ActivityIndicator: () => createElement("span", {}, "Loading"),
    Alert: { alert: vi.fn() },
    Keyboard: { dismiss: vi.fn() },
    Platform: { OS: "ios" },
    PlatformColor: (name: string) => name,
    useWindowDimensions: () => ({ width: 390, height: 844, scale: 3, fontScale: 1 }),
    Linking: { openURL: vi.fn() },
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    ScrollView: view,
    View: view,
    Text: view,
    Pressable: ({ children, onPress }: { children?: ReactNode; onPress: () => void }) =>
      createElement("button", { type: "button", onClick: onPress }, children),
    TextInput: ({
      accessibilityLabel,
      placeholder,
      value,
      onChangeText,
      secureTextEntry,
    }: {
      accessibilityLabel?: string;
      placeholder?: string;
      value: string;
      onChangeText: (value: string) => void;
      secureTextEntry?: boolean;
    }) =>
      createElement("input", {
        "aria-label": accessibilityLabel,
        placeholder,
        value,
        type: secureTextEntry ? "password" : "text",
        onInput: (event: { currentTarget: HTMLInputElement }) =>
          onChangeText(event.currentTarget.value),
      }),
  };
});
vi.mock("react-native-safe-area-context", () => ({
  SafeAreaView: ({ children }: { children?: ReactNode }) => createElement("div", {}, children),
}));

// Cache updates reach the screen inside act instead of on a later timer.
notifyManager.setScheduler((callback) => callback());

let container: HTMLDivElement;
let root: Root;

function button(label: string) {
  return [...container.querySelectorAll("button")].find((entry) => entry.textContent === label);
}

async function renderConnection(request: Partial<ModelConnectionRequest> = {}) {
  params.requestId = openModelConnection({
    provider: "local",
    credentialId: "credential-fixture",
    makeDefault: false,
    target: { scope: "account" },
    ...request,
  });
  await act(async () => root.render(createElement(ModelConnection)));
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  queryClient.clear();
  rpcCalls.length = 0;
  delete params.spaceId;
  back.mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await renderConnection();
  const advanced = button("Advanced");
  expect(advanced).toBeDefined();
  await act(async () => advanced!.click());
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function field(label: string): HTMLInputElement | null {
  return container.querySelector(`input[aria-label="${label}"]`);
}
async function change(label: string, value: string) {
  const input = field(label)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function authenticate() {
  await change("API key", "fixture-key-123");
}

async function remount(render: () => Promise<void>) {
  await act(async () => root.unmount());
  root = createRoot(container);
  await render();
}

async function notConnectedChoices() {
  await remount(async () => {
    await act(async () => root.render(createElement(Models)));
  });
  const add = [...container.querySelectorAll("button")].find((entry) =>
    entry.textContent?.includes("Add fallback"),
  );
  expect(add).toBeDefined();
  await act(async () => add!.click());
  const route = push.mock.calls.at(-1)?.[0] as { params: { requestId: string } };
  return modelPickerRequest(route.params.requestId)!.connectChoices ?? [];
}

it("offers providers to connect without repeating a connected one", async () => {
  expect((await notConnectedChoices()).map((choice) => choice.label)).toEqual(["Doitx Router"]);
});

it("hands a connected model back to the slot that asked for it", async () => {
  const onConnected = vi.fn(async () => undefined);
  await remount(() => renderConnection({ credentialId: null, makeDefault: true, onConnected }));
  await authenticate();
  const save = button("Connect API key")!;
  await act(async () => save.click());
  expect(rpcCalls.find(([procedure]) => procedure === "models/connect")?.[1]).toMatchObject({
    provider: "local",
    modelId: "model-fixture",
    makeDefault: true,
    scope: "account",
  });
  expect(onConnected).toHaveBeenCalledWith({
    provider: "local",
    modelId: "model-fixture",
    credentialId: "credential-new",
  });
  expect(back).toHaveBeenCalledOnce();
});

describe("a Space's model override", () => {
  const otherSpace = { headers: { "x-rakazo-space-id": "space-other" } };

  it("edits that Space's lists in that Space and leaves connections to the account", async () => {
    params.spaceId = "space-other";
    await notConnectedChoices();
    expect(rpcCalls).toContainEqual([
      "models/role",
      { role: "main", expectedUserId: "user-fixture", scope: "space" },
      { requestContext: otherSpace },
    ]);
    expect(container.textContent).not.toContain("Add provider");
    const picker = modelPickerRequest(
      (push.mock.calls.at(-1)![0] as { params: { requestId: string } }).params.requestId,
    )!;
    const connect = picker.continueTo?.(picker.connectChoices![0]!) as unknown as {
      params: { requestId: string };
    };
    expect(modelConnectionRequest(connect.params.requestId)?.target).toEqual({
      scope: "space",
      spaceId: "space-other",
    });
  });

  it("connects through that Space so a new main model lands in its override", async () => {
    const onConnected = vi.fn(async () => undefined);
    await remount(() =>
      renderConnection({
        credentialId: null,
        makeDefault: true,
        target: { scope: "space", spaceId: "space-other" },
        onConnected,
      }),
    );
    await authenticate();
    const save = button("Connect API key")!;
    await act(async () => save.click());
    const connect = rpcCalls.find(([procedure]) => procedure === "models/connect");
    expect(connect?.[1]).toMatchObject({ makeDefault: true, scope: "space" });
    expect(connect?.[2]).toEqual({ requestContext: otherSpace });
  });
});

it("paints a revisit from cache without a spinner and refreshes behind it", async () => {
  await remount(async () => {
    await act(async () => root.render(createElement(Models)));
  });
  expect(container.textContent).toContain("Fixture");
  let release!: () => void;
  saved.held = new Promise((resolve) => {
    release = resolve;
  });
  saved.label = "Renamed fixture";
  try {
    rpcCalls.length = 0;
    await remount(async () => {
      await act(async () => root.render(createElement(Models)));
    });
    expect(container.textContent).not.toContain("Loading");
    expect(container.textContent).not.toContain("Renamed fixture");
    expect(rpcCalls.map(([procedure]) => procedure)).toContain("models/credentials");

    await act(async () => release());
    expect(container.textContent).toContain("Renamed fixture");
  } finally {
    saved.held = null;
    saved.label = "Fixture";
  }
});

it("offers a retry when the first load fails, then shows the model lists", async () => {
  queryClient.clear();
  saved.failMe = true;
  try {
    await remount(async () => {
      await act(async () => root.render(createElement(Models)));
    });
    expect(container.textContent).not.toContain("Add fallback");
    expect(container.textContent).toContain("Could not load model settings");
    saved.failMe = false;
    const retry = [...container.querySelectorAll("button")].find(
      (entry) => entry.textContent === "Retry",
    );
    await act(async () => retry!.click());
    expect(container.textContent).toContain("Add fallback");
    expect(container.textContent).not.toContain("Could not load model settings");
  } finally {
    saved.failMe = false;
  }
});
