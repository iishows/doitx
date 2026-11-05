// @vitest-environment jsdom

import { i18n } from "@lingui/core";
import type * as UiWeb from "@rakazo/ui-web";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

type UiWebModule = typeof UiWeb;

/** Provider rows end with their "Connect" action; models show their name alone. */
const optionName = (entry: Element) => entry.textContent?.replace(/Connect$/, "");
const models = vi.hoisted(() => ({
  list: vi.fn(),
  role: vi.fn(),
  forRole: vi.fn(),
  setRole: vi.fn(),
  credentials: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  rename: vi.fn(),
  setDefault: vi.fn(),
  probeCatalog: vi.fn(),
  probeOpenAiCompatible: vi.fn(),
  beginOAuth: vi.fn(),
  cancelOAuth: vi.fn(),
  completeOAuth: vi.fn(),
  finishOAuth: vi.fn(),
  submitOAuthCode: vi.fn(),
}));

vi.mock("../lib/rpc", () => {
  const rpc = {
    models,
    bots: { list: vi.fn(async () => []), update: vi.fn() },
    me: vi.fn(),
  };
  return {
    selectedSpaceId: () => "space-1",
    rpc,
    rpcForSpace: () => rpc,
    createSpaceRpc: () => rpc,
  };
});
vi.mock("../lib/localized-provider-hint", () => ({
  localizedProviderHint: () => "API key",
  providerRowHint: () => null,
}));
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce(
      (text, part, index) => `${text}${index > 0 ? String(values[index - 1]) : ""}${part}`,
      "",
    );
  return {
    useLingui: () => ({ t }),
    Trans: ({ children }: { children?: ReactNode }) => children,
    Plural: ({ one, other, value }: { one: string; other: string; value: number }) =>
      value === 1 ? one : other,
  };
});
vi.mock("@rakazo/ui-web", async (importOriginal) => {
  const actual = await importOriginal<UiWebModule>();
  const Pass = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    ...actual,
    AlertDialog: ({ open, children }: { open?: boolean; children?: ReactNode }) =>
      open ? <div>{children}</div> : null,
    AlertDialogAction: ({
      children,
      onClick,
      disabled,
    }: {
      children?: ReactNode;
      onClick?: () => void;
      disabled?: boolean;
    }) => (
      <button type="button" disabled={disabled} onClick={onClick}>
        {children}
      </button>
    ),
    AlertDialogCancel: ({ children, onClick }: { children?: ReactNode; onClick?: () => void }) => (
      <button type="button" onClick={onClick}>
        {children}
      </button>
    ),
    AlertDialogContent: Pass,
    AlertDialogDescription: Pass,
    AlertDialogFooter: Pass,
    AlertDialogHeader: Pass,
    AlertDialogTitle: Pass,
    Button: ({
      children,
      onClick,
      disabled,
      variant: _variant,
      size: _size,
      ...props
    }: ComponentProps<"button"> & { variant?: string; size?: string }) => (
      <button type="button" disabled={disabled} onClick={onClick} {...props}>
        {children}
      </button>
    ),
    // Dialogs render inline, and only while open.
    Dialog: ({ open, children }: { open?: boolean; children?: ReactNode }) =>
      open ? <div>{children}</div> : null,
    DialogClose: Pass,
    DialogContent: Pass,
    DialogDescription: ({ children }: { children?: ReactNode }) => (
      <p data-testid="model-description">{children}</p>
    ),
    DialogHeader: Pass,
    DialogTitle: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
    Input: (props: ComponentProps<"input">) => <input {...props} />,
    ModelThinkingOptions: (props: {
      children?: ReactNode;
      maxTokens?: string;
      maxTokensLabel?: string;
      onMaxTokensChange?: (value: string) => void;
      contextWindow?: string;
      contextWindowLabel?: string;
      onContextWindowChange?: (value: string) => void;
    }) =>
      props.onMaxTokensChange ? (
        <>
          <input
            aria-label={props.maxTokensLabel}
            value={props.maxTokens ?? ""}
            onChange={(event) => props.onMaxTokensChange?.(event.target.value)}
          />
          {props.onContextWindowChange ? (
            <input
              aria-label={props.contextWindowLabel}
              value={props.contextWindow ?? ""}
              onChange={(event) => props.onContextWindowChange?.(event.target.value)}
            />
          ) : null}
          {props.children}
        </>
      ) : null,
    NativeSelect: (props: ComponentProps<"select">) => <select {...props} />,
    NativeSelectOption: (props: ComponentProps<"option">) => <option {...props} />,
  };
});

import { rpc } from "../lib/rpc";
import { ModelSettingsOverlay } from "./ModelSettingsOverlay";

const STORED_PLACEHOLDER = "Paste a replacement key";
const localEndpointEntry = {
  provider: "local",
  providerName: "Local (self-hosted endpoint)",
  id: "local-endpoint",
  label: "Local endpoint",
  billing: "Your server",
  auth: "api-key" as const,
  placeholder: true,
  catalogProbe: true,
};

const deepseekEntry = {
  provider: "deepseek",
  providerName: "DeepSeek",
  id: "deepseek-chat",
  label: "DeepSeek Chat",
  billing: "API key",
  auth: "api-key" as const,
  authHint: "API key",
};
const openrouterEntry = {
  provider: "openrouter",
  providerName: "OpenRouter",
  id: "fixture/router-model",
  label: "Router model",
  billing: "API key",
  auth: "api-key" as const,
  authHint: "API key",
};
const compatibleEntry = {
  provider: "openai-compatible",
  providerName: "OpenAI-compatible",
  id: "custom",
  label: "Custom model",
  billing: "Your server",
  auth: "api-key" as const,
  authHint: "Custom server",
  placeholder: true,
};
const deepseekCredential = {
  id: "cred-deepseek",
  provider: "deepseek",
  label: "DeepSeek",
  hasKey: true,
  isDefault: true,
  modelId: "deepseek-chat",
};

function account(provider: string, modelId: string) {
  return {
    userId: "user-1",
    email: "ada@example.test",
    name: "Ada",
    spaceId: "space-1",
    isDeploymentOwner: false,
    isAdmin: false,
    needsModel: false,
    defaultProvider: provider,
    defaultModel: modelId,
    hostCredentialProvider: null,
    hostCredentialSource: null,
    computerHost: null,
    canChooseHostComputer: false,
    sandboxProvider: "docker",
    mcpStdioEnabled: false,
    avatarStyle: "organic" as const,
    billingEnabled: false,
    ticketBoardEnabled: false,
    navLinks: [],
    phoneCallsEnabled: false,
  };
}

function buttons(container: HTMLElement, text: string) {
  const found = [...container.querySelectorAll("button")].filter((entry) =>
    entry.textContent?.includes(text),
  );
  if (found.length === 0) throw new Error(`Missing button: ${text}`);
  return found;
}

function keyField(container: HTMLElement) {
  const input = container.querySelector("#model-api-key");
  if (!(input instanceof HTMLInputElement)) throw new Error("Missing API key field");
  return input;
}

async function typeInto(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function click(element: Element | null | undefined) {
  if (!(element instanceof HTMLElement)) throw new Error("Missing element");
  await act(async () => element.click());
  await act(async () => {
    await Promise.resolve();
  });
}

function section(role: "main" | "approval") {
  const found = document.querySelector(`[data-testid="model-role-${role}"]`);
  if (!found) throw new Error(`Missing ${role} model list`);
  return found;
}

/** Visible names of the open picker's options. */
function pickerOptions() {
  return [...document.querySelectorAll<HTMLElement>('[role="option"]')].map(optionName);
}

async function openPicker(label: string, role: "main" | "approval" = "main") {
  await click(section(role).querySelector(`button[aria-label="${label}"]`));
}

async function choose(option: string) {
  await click(
    [...document.querySelectorAll('[role="option"]')].find((entry) => optionName(entry) === option),
  );
}

/** Picks a model or a not-connected provider from one of the list's pickers. */
async function pick(label: string, option: string, role: "main" | "approval" = "main") {
  await openPicker(label, role);
  await choose(option);
}

/** Opens the connection dialog for the main model's first row through its options menu. */
async function manage() {
  await click(
    section("main").querySelector(
      '[data-testid="model-role-row-1"] button[aria-label$=" options"]',
    ),
  );
  await click(
    [...document.querySelectorAll('[role="menuitem"]')].find((entry) =>
      entry.textContent?.startsWith("Manage "),
    ),
  );
}

function titles(container: HTMLElement) {
  return [...container.querySelectorAll('[data-testid="model-connection-title"]')].map(
    (entry) => entry.textContent,
  );
}

function testQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

async function renderSettings(
  embedded = true,
  queryClient = testQueryClient(),
  scope: "account" | "space" = "account",
) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <ModelSettingsOverlay embedded={embedded} scope={scope} onClose={() => undefined} />
      </QueryClientProvider>,
    );
  });
  await act(async () => {
    await Promise.resolve();
  });
  return {
    container,
    async unmount() {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

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
  Element.prototype.scrollIntoView = () => undefined;
  i18n.loadAndActivate({ locale: "en", messages: {} });
  vi.mocked(rpc.me).mockResolvedValue(account("deepseek", "deepseek-chat"));
  models.list.mockResolvedValue([deepseekEntry]);
  models.credentials.mockResolvedValue([]);
  models.connect.mockResolvedValue({});
  models.disconnect.mockResolvedValue(undefined);
  models.forRole.mockImplementation(() => models.list());
  models.setRole.mockImplementation(
    async ({ role: _role, expectedUserId: _user, ...patch }: Record<string, unknown>) => ({
      primary: null,
      backups: [],
      ...patch,
    }),
  );
  // The main role's first slot is the space default once its provider is connected.
  models.role.mockImplementation(async ({ role }: { role: string }) => {
    if (role !== "main") return { primary: null, backups: [] };
    const [me, credentials] = await Promise.all([rpc.me(), models.credentials()]);
    const connected =
      !me.needsModel &&
      (credentials as { provider: string }[]).some(
        (entry) => entry.provider === me.defaultProvider,
      );
    return {
      primary: connected ? { provider: me.defaultProvider, modelId: me.defaultModel } : null,
      backups: [],
    };
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
  vi.clearAllMocks();
});

it("reopens on cached models without a spinner and refreshes them behind it", async () => {
  models.credentials.mockResolvedValue([deepseekCredential]);
  const queryClient = testQueryClient();
  const first = await renderSettings(true, queryClient);
  expect(first.container.querySelector('[data-testid="model-role-row-1"]')).not.toBeNull();
  await first.unmount();

  const hold = new Promise<never>(() => undefined);
  models.list.mockReturnValue(hold);
  models.role.mockReturnValue(hold);
  models.forRole.mockReturnValue(hold);
  const listCalls = models.list.mock.calls.length;
  const roleCalls = models.role.mock.calls.length;
  const view = await renderSettings(true, queryClient);
  try {
    expect(view.container.querySelector('[aria-label="Loading model catalog…"]')).toBeNull();
    expect(view.container.querySelector('[data-testid="model-role-row-1"]')).not.toBeNull();
    expect(models.list.mock.calls.length).toBeGreaterThan(listCalls);
    expect(models.role.mock.calls.length).toBeGreaterThan(roleCalls);
  } finally {
    await view.unmount();
  }
});

it("shows a stored BYOK key when provider settings reopen", async () => {
  models.credentials.mockResolvedValue([deepseekCredential]);

  const view = await renderSettings();
  try {
    expect(view.container.querySelector("#model-api-key")).toBeNull();
    await manage();
    expect(titles(view.container)).toEqual(["DeepSeek"]);
    const input = keyField(view.container);
    expect(input.value).toBe("");
    expect(input.placeholder).toBe(STORED_PLACEHOLDER);
    expect(input.type).toBe("password");
    expect(view.container.textContent).not.toContain("sk-");
    expect(buttons(view.container, "Replace API key")[0]?.disabled).toBe(true);

    await typeInto(input, "sk-replacement-key");
    expect(keyField(view.container).value).toBe("sk-replacement-key");

    await typeInto(keyField(view.container), "");
    expect(keyField(view.container).value).toBe("");
    expect(keyField(view.container).placeholder).toBe(STORED_PLACEHOLDER);

    await typeInto(keyField(view.container), "sk-replacement-key");
    await click(buttons(view.container, "Replace API key")[0]);
    expect(models.connect).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "deepseek", apiKey: "sk-replacement-key" }),
    );
    // A saved connection closes its dialog; reopening shows the stored key again.
    expect(view.container.querySelector("#model-api-key")).toBeNull();
    await manage();
    expect(keyField(view.container).value).toBe("");
    expect(keyField(view.container).placeholder).toBe(STORED_PLACEHOLDER);

    models.credentials.mockResolvedValue([]);
    await click(buttons(view.container, "Disconnect")[0]);
    const confirm = buttons(view.container, "Disconnect");
    await click(confirm[confirm.length - 1]);
    expect(models.disconnect).toHaveBeenCalledWith({
      provider: "deepseek",
      credentialId: "cred-deepseek",
    });
    expect(view.container.querySelector("#model-api-key")).toBeNull();

    await pick("Change Main model", "DeepSeek");
    expect(titles(view.container)).toEqual(["Connect DeepSeek"]);
    expect(keyField(view.container).value).toBe("");
    expect(keyField(view.container).placeholder).toBe("sk-…");
  } finally {
    await view.unmount();
  }
});

it("shows no output limit for a managed provider until one is saved", async () => {
  vi.mocked(rpc.me).mockResolvedValue(account("doitx", "doitx-router"));
  models.list.mockResolvedValue([
    {
      provider: "doitx",
      providerName: "Doitx Router",
      id: "doitx-router",
      label: "Doitx Router",
      billing: "Doitx",
      auth: "api-key" as const,
      placeholder: true,
    },
  ]);
  models.credentials.mockResolvedValue([
    {
      id: "cred-doitx",
      provider: "doitx",
      label: "Doitx Router",
      hasKey: true,
      isDefault: true,
      modelId: "doitx-router",
    },
  ]);

  const view = await renderSettings();
  try {
    await manage();
    const limit = view.container.querySelector<HTMLInputElement>(
      'input[aria-label="Maximum output tokens"]',
    );
    if (!limit) throw new Error("Missing output limit field");
    expect(limit.value).toBe("");
  } finally {
    await view.unmount();
  }
});

it("saves an edited output limit without sending a half-typed replacement key", async () => {
  models.credentials.mockResolvedValue([deepseekCredential]);

  const view = await renderSettings();
  try {
    await manage();
    const limit = view.container.querySelector<HTMLInputElement>(
      'input[aria-label="Maximum output tokens"]',
    );
    if (!limit) throw new Error("Missing output limit field");
    await typeInto(limit, "4096");
    await typeInto(keyField(view.container), "sk-ab");
    await click(buttons(view.container, "Save").find((entry) => entry.textContent === "Save"));
    expect(models.connect).toHaveBeenCalledTimes(1);
    const input = models.connect.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(input).toMatchObject({ provider: "deepseek", maxTokens: 4096 });
    expect(input).not.toHaveProperty("apiKey");
    // A limits-only save keeps the dialog and the half-typed key.
    expect(keyField(view.container).value).toBe("sk-ab");
  } finally {
    await view.unmount();
  }
});

it("saves a context window edited for the selected model", async () => {
  models.credentials.mockResolvedValue([deepseekCredential]);

  const view = await renderSettings();
  try {
    await manage();
    const windowField = view.container.querySelector<HTMLInputElement>(
      'input[aria-label="Context window"]',
    );
    if (!windowField) throw new Error("Missing context window field");
    // Empty until a window is saved for this model, so the model card wins.
    expect(windowField.value).toBe("");
    await typeInto(windowField, "32000");
    await click(buttons(view.container, "Save").find((entry) => entry.textContent === "Save"));
    expect(models.connect).toHaveBeenCalledTimes(1);
    expect(models.connect.mock.calls[0]?.[0]).toMatchObject({
      provider: "deepseek",
      contextWindow: 32000,
    });
  } finally {
    await view.unmount();
  }
});

it("leaves the key field empty until a key is saved", async () => {
  const view = await renderSettings();
  try {
    await pick("Change Main model", "DeepSeek");
    const input = keyField(view.container);
    expect(input.value).toBe("");
    expect(input.placeholder).toBe("sk-…");
    expect(view.container.textContent).not.toContain(STORED_PLACEHOLDER);
  } finally {
    await view.unmount();
  }
});

it("labels the empty main slot by what runs there", async () => {
  vi.mocked(rpc.me).mockResolvedValue({
    ...account("deepseek", "deepseek-chat"),
    needsModel: true,
  });
  const view = await renderSettings();
  try {
    expect(section("main").querySelector('[data-testid="model-role-default"]')?.textContent).toBe(
      "Choose a model",
    );
    expect(
      section("approval").querySelector('[data-testid="model-role-default"]')?.textContent,
    ).toBe("Choose a model");
  } finally {
    await view.unmount();
  }

  vi.mocked(rpc.me).mockResolvedValue(account("deepseek", "deepseek-chat"));
  models.credentials.mockResolvedValue([deepseekCredential]);
  const connected = await renderSettings();
  try {
    expect(section("main").querySelector('[data-testid="model-role-default"]')).toBeNull();
    expect(
      section("main").querySelector('[data-testid="model-role-row-1"]')?.textContent,
    ).toContain("DeepSeek Chat");
  } finally {
    await connected.unmount();
  }
});

it("connects a provider from Add fallback without replacing the main model, then picks its model", async () => {
  models.list.mockResolvedValue([deepseekEntry, openrouterEntry]);
  models.credentials.mockResolvedValue([deepseekCredential]);
  const view = await renderSettings();
  try {
    await openPicker("Add fallback");
    expect(pickerOptions()).toContain("OpenRouter");
    await choose("OpenRouter");
    expect(titles(view.container)).toEqual(["Connect OpenRouter"]);
    await typeInto(keyField(view.container), "sk-fixture-router");
    models.credentials.mockResolvedValue([
      deepseekCredential,
      {
        id: "cred-openrouter",
        provider: "openrouter",
        label: "OpenRouter",
        hasKey: true,
        isDefault: false,
        modelId: openrouterEntry.id,
      },
    ]);
    await click(buttons(view.container, "Connect API key")[0]);
    expect(models.connect).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openrouter",
        apiKey: "sk-fixture-router",
        modelId: openrouterEntry.id,
        makeDefault: false,
      }),
    );
    // The key belongs to the provider; its models are then chosen in the reopened picker.
    expect(titles(view.container)).toEqual([]);
    expect(models.setRole).not.toHaveBeenCalled();
    expect(pickerOptions()).toEqual([openrouterEntry.label]);
    await choose(openrouterEntry.label);
    expect(models.setRole).toHaveBeenCalledTimes(1);
    // The unchanged main model is left out, so the save cannot rewrite it.
    const [saved] = vi.mocked(models.setRole).mock.calls[0]!;
    expect(saved).toMatchObject({
      role: "main",
      backups: [
        { provider: "openrouter", modelId: openrouterEntry.id, credentialId: "cred-openrouter" },
      ],
    });
    expect(saved).not.toHaveProperty("primary");
  } finally {
    await view.unmount();
  }
});

it("connects the main model from the empty default row as the space default", async () => {
  vi.mocked(rpc.me).mockResolvedValue({
    ...account("deepseek", "deepseek-chat"),
    needsModel: true,
  });
  const view = await renderSettings();
  try {
    await pick("Change Main model", "DeepSeek");
    expect(titles(view.container)).toEqual(["Connect DeepSeek"]);
    await typeInto(keyField(view.container), "sk-fixture-deepseek");
    const loads = models.role.mock.calls.length;
    await click(buttons(view.container, "Connect API key")[0]);
    expect(models.connect).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "deepseek",
        apiKey: "sk-fixture-deepseek",
        makeDefault: true,
        scope: "account",
      }),
    );
    // The connection already made it the main model, so the list reloads instead of writing.
    expect(models.setRole).not.toHaveBeenCalled();
    expect(models.role.mock.calls.length).toBeGreaterThan(loads);
    expect(titles(view.container)).toEqual([]);
  } finally {
    await view.unmount();
  }
});

it("shows a Space only its own role lists and makes a new connection its main model there", async () => {
  vi.mocked(rpc.me).mockResolvedValue({
    ...account("deepseek", "deepseek-chat"),
    needsModel: true,
  });
  const view = await renderSettings(true, testQueryClient(), "space");
  try {
    expect(view.container.querySelector('[data-testid="model-role-main"]')).not.toBeNull();
    expect(view.container.querySelector('[data-testid="model-role-approval"]')).not.toBeNull();
    // Connections are the account's, so a Space does not list or add them.
    expect(view.container.querySelector('[data-testid="model-providers"]')).toBeNull();
    expect(models.role).toHaveBeenCalledWith(
      expect.objectContaining({ role: "main", scope: "space" }),
      expect.anything(),
    );
    await pick("Change Main model", "DeepSeek");
    await typeInto(keyField(view.container), "sk-fixture-deepseek");
    await click(buttons(view.container, "Connect API key")[0]);
    expect(models.connect).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "deepseek", makeDefault: true, scope: "space" }),
    );
  } finally {
    await view.unmount();
  }
});

it("shows Cloudflare account and gateway fields for a new and a saved connection", async () => {
  const entry = {
    provider: "cloudflare-ai-gateway",
    providerName: "Cloudflare AI Gateway",
    id: "workers-ai/@cf/meta/llama-3.1-8b-instruct",
    label: "Llama",
    billing: "API key",
    auth: "api-key" as const,
    authHint: "API key",
  };
  vi.mocked(rpc.me).mockResolvedValue(account(entry.provider, entry.id));
  models.list.mockResolvedValue([entry]);
  models.credentials.mockResolvedValue([]);

  const fresh = await renderSettings();
  try {
    await pick("Change Main model", "Cloudflare AI Gateway");
    const accountId = fresh.container.querySelector("#cloudflare-account-id");
    const gatewayId = fresh.container.querySelector("#cloudflare-gateway-id");
    expect(accountId).toBeInstanceOf(HTMLInputElement);
    expect(gatewayId).toBeInstanceOf(HTMLInputElement);
    expect((accountId as HTMLInputElement).value).toBe("");
    expect((gatewayId as HTMLInputElement).value).toBe("");
    expect(fresh.container.textContent).toContain("Account ID");
    expect(fresh.container.textContent).toContain("Gateway ID");
  } finally {
    await fresh.unmount();
  }

  models.credentials.mockResolvedValue([
    {
      id: "cred-cf",
      provider: entry.provider,
      label: "Cloudflare AI Gateway",
      hasKey: true,
      isDefault: true,
      accountId: "acct1234",
      gatewayId: "gateway-1",
      modelId: entry.id,
    },
  ]);
  const saved = await renderSettings();
  try {
    await manage();
    expect(
      (saved.container.querySelector("#cloudflare-account-id") as HTMLInputElement).value,
    ).toBe("acct1234");
    expect(
      (saved.container.querySelector("#cloudflare-gateway-id") as HTMLInputElement).value,
    ).toBe("gateway-1");
  } finally {
    await saved.unmount();
  }
});

it("lists the local endpoint's models when asked", async () => {
  vi.mocked(rpc.me).mockResolvedValue(account("local", "local-endpoint"));
  models.list.mockResolvedValue([
    {
      provider: "local",
      providerName: "Local (self-hosted endpoint)",
      id: "local-endpoint",
      label: "Local endpoint",
      billing: "Your server",
      auth: "api-key" as const,
      placeholder: true,
      catalogProbe: true,
    },
  ]);
  models.credentials.mockResolvedValue([
    {
      id: "cred-local",
      provider: "local",
      label: "Local",
      hasKey: false,
      isDefault: true,
      modelId: "local-endpoint",
    },
  ]);
  models.probeCatalog.mockResolvedValue({ models: ["qwen3:4b", "llama3.1:8b"] });

  const view = await renderSettings();
  try {
    await manage();
    await click(buttons(view.container, "Find models")[0]);
    expect(models.probeCatalog).toHaveBeenCalledWith({
      provider: "local",
      apiKey: "",
      credentialId: "cred-local",
    });
    expect(view.container.textContent).toContain("qwen3:4b");
    expect(view.container.textContent).toContain("llama3.1:8b");
  } finally {
    await view.unmount();
  }
});

const compatibleCredential = {
  id: "cred-compatible",
  provider: "openai-compatible",
  label: "Local",
  hasKey: false,
  isDefault: true,
  baseUrl: "http://127.0.0.1:8000/v1",
  modelId: "model-a",
  enabledModelIds: ["model-a"],
};

it("probes a saved connection's models with the key the server stores", async () => {
  vi.mocked(rpc.me).mockResolvedValue(account("local", "local-endpoint"));
  models.list.mockResolvedValue([localEndpointEntry]);
  models.credentials.mockResolvedValue([
    {
      id: "cred-local",
      provider: "local",
      label: "Local (self-hosted endpoint)",
      hasKey: true,
      isDefault: true,
      modelId: "local-endpoint",
    },
  ]);
  models.probeCatalog.mockResolvedValue({ models: ["qwen3:4b", "llama3.1:8b"] });

  const view = await renderSettings();
  try {
    await openProvider("Local (self-hosted endpoint)");
    await click(buttons(view.container, "Find models")[0]);
    // The client sends no key; the server uses the connection's stored one.
    expect(models.probeCatalog).toHaveBeenCalledWith({
      provider: "local",
      apiKey: "",
      credentialId: "cred-local",
    });
    expect(view.container.textContent).toContain("qwen3:4b");
  } finally {
    await view.unmount();
  }
});

it("deletes a connection from its Providers row", async () => {
  models.credentials.mockResolvedValue([deepseekCredential, workCredential]);
  const view = await renderSettings();
  try {
    const row = view.container.querySelector('[data-testid="model-provider-cred-deepseek-work"]');
    const remove = row?.querySelector<HTMLButtonElement>(
      'button[aria-label="Delete DeepSeek (Work)"]',
    );
    if (!remove) throw new Error("Missing delete button");
    await click(remove);
    await click(buttons(view.container, "Delete")[0]);
    expect(models.disconnect).toHaveBeenCalledWith({
      provider: "deepseek",
      credentialId: "cred-deepseek-work",
    });
  } finally {
    await view.unmount();
  }
});

it("offers a saved compatible model in the main picker and uses it", async () => {
  vi.mocked(rpc.me).mockResolvedValue(account("openai-compatible", "model-a"));
  models.list.mockResolvedValue([compatibleEntry]);
  models.credentials.mockResolvedValue([
    { ...compatibleCredential, enabledModelIds: ["model-a", "model-b"] },
  ]);
  const view = await renderSettings();
  try {
    await openPicker("Change model-a");
    expect(pickerOptions()).toEqual(expect.arrayContaining(["model-a", "model-b"]));
    await choose("model-b");
    expect(models.setRole).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "main",
        primary: {
          provider: "openai-compatible",
          modelId: "model-b",
          credentialId: "cred-compatible",
        },
        backups: [],
      }),
      expect.anything(),
    );
  } finally {
    await view.unmount();
  }
});

it("lists not-connected providers by name alone", async () => {
  models.list.mockResolvedValue([deepseekEntry, compatibleEntry]);
  const view = await renderSettings();
  try {
    await openPicker("Change Main model");
    expect(pickerOptions()).toEqual(["DeepSeek", "OpenAI-compatible"]);
    expect(document.querySelectorAll("[cmdk-group-heading]")).toHaveLength(0);
  } finally {
    await view.unmount();
  }
});

it("offers a saved Ollama connection's models without the Ollama preset", async () => {
  models.list.mockResolvedValue([compatibleEntry]);
  models.credentials.mockResolvedValue([
    {
      id: "fixture",
      label: "OpenAI-compatible",
      provider: "openai-compatible",
      modelId: "fixture-model",
      baseUrl: "https://ollama.com/",
      hasKey: true,
    },
  ]);
  const view = await renderSettings(false);
  try {
    await openPicker("Change Main model");
    expect(pickerOptions()).toEqual(["fixture-model"]);
  } finally {
    await view.unmount();
  }
});

it("folds the key form behind Or paste an API key once a subscription is signed in", async () => {
  vi.mocked(rpc.me).mockResolvedValue(account("anthropic", "claude-fixture"));
  models.list.mockResolvedValue([
    {
      provider: "anthropic",
      providerName: "Anthropic",
      id: "claude-fixture",
      label: "Claude fixture",
      billing: "",
      signIn: "auth-url",
    },
  ]);
  models.credentials.mockResolvedValue([
    {
      id: "fixture",
      label: "Anthropic",
      provider: "anthropic",
      modelId: "claude-fixture",
      hasKey: false,
      authKind: "oauth",
    },
  ]);
  const view = await renderSettings();
  try {
    await manage();
    expect(view.container.querySelector("#model-api-key")).toBeNull();
    // OAuth runs take the window from the subscription, so the field would be discarded.
    expect(view.container.querySelector('input[aria-label="Context window"]')).toBeNull();
    await click(buttons(view.container, "Or paste an API key")[0]);
    expect(keyField(view.container)).toBeTruthy();
    expect(buttons(view.container, "Connect API key")).toHaveLength(1);
    expect(view.container.textContent).not.toContain("Replace API key");
  } finally {
    await view.unmount();
  }
});

function providersSection() {
  const found = document.querySelector('[data-testid="model-providers"]');
  if (!found) throw new Error("Missing Providers section");
  return found as HTMLElement;
}

/** Opens a connection's page from the Providers list. */
async function openProvider(name: string) {
  await click(
    [...providersSection().querySelectorAll("button")].find((entry) => entry.textContent === name),
  );
}

const workCredential = {
  ...deepseekCredential,
  id: "cred-deepseek-work",
  label: "Work",
  isDefault: false,
};

it("lists every connection under Providers and adds another for a connected provider", async () => {
  models.credentials.mockResolvedValue([deepseekCredential, workCredential]);
  const view = await renderSettings();
  try {
    expect(
      [...providersSection().querySelectorAll('[data-testid^="model-provider-"]')].map(
        (row) => row.textContent,
      ),
    ).toEqual(["DeepSeek", "DeepSeek (Work)"]);
    await click(buttons(providersSection() as HTMLElement, "Add provider")[0]);
    expect(pickerOptions()).toContain("DeepSeek");
    await choose("DeepSeek");
    expect(titles(view.container)).toEqual(["Connect DeepSeek"]);
    expect(keyField(view.container).placeholder).toBe("sk-…");
    await typeInto(keyField(view.container), "sk-fixture-personal");
    await click(buttons(view.container, "Connect API key")[0]);
    expect(models.connect).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "deepseek",
        apiKey: "sk-fixture-personal",
        credentialId: null,
        makeDefault: false,
      }),
    );
    expect(models.setRole).not.toHaveBeenCalled();
    expect(titles(view.container)).toEqual([]);
  } finally {
    await view.unmount();
  }
});

it("replaces one connection's key and disconnects only that connection", async () => {
  models.credentials.mockResolvedValue([deepseekCredential, workCredential]);
  const view = await renderSettings();
  try {
    await openProvider("DeepSeek (Work)");
    expect(titles(view.container)).toEqual(["DeepSeek (Work)"]);
    await typeInto(keyField(view.container), "sk-fixture-rotated");
    await click(buttons(view.container, "Replace API key")[0]);
    expect(models.connect).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "deepseek",
        apiKey: "sk-fixture-rotated",
        credentialId: "cred-deepseek-work",
      }),
    );

    await openProvider("DeepSeek (Work)");
    await click(buttons(view.container, "Disconnect")[0]);
    const confirm = buttons(view.container, "Disconnect");
    await click(confirm[confirm.length - 1]);
    expect(models.disconnect).toHaveBeenCalledWith({
      provider: "deepseek",
      credentialId: "cred-deepseek-work",
    });
  } finally {
    await view.unmount();
  }
});

it("keeps another connection's form when an earlier save finishes", async () => {
  models.list.mockResolvedValue([deepseekEntry, openrouterEntry]);
  models.credentials.mockResolvedValue([deepseekCredential]);
  let finishSave!: (value: unknown) => void;
  models.connect.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishSave = resolve;
      }),
  );
  const view = await renderSettings();
  try {
    await openPicker("Add fallback");
    await choose("OpenRouter");
    await typeInto(keyField(view.container), "sk-fixture-router");
    await click(buttons(view.container, "Connect API key")[0]);
    // Fields wait for the save, so it cannot overwrite edits made meanwhile.
    expect(keyField(view.container).closest("fieldset")?.disabled).toBe(true);
    // The main model's connection opens while the first key still saves.
    await manage();
    expect(titles(view.container)).toEqual(["DeepSeek"]);
    await act(async () => {
      finishSave({ ...deepseekCredential, id: "cred-openrouter", provider: "openrouter" });
    });
    expect(titles(view.container)).toEqual(["DeepSeek"]);
    // The finished save's slot picker does not take over.
    expect(pickerOptions()).toEqual([]);
  } finally {
    await view.unmount();
  }
});

it("renames a connection", async () => {
  models.rename.mockResolvedValue({ ok: true });
  models.credentials.mockResolvedValue([deepseekCredential, workCredential]);
  const view = await renderSettings();
  try {
    await openProvider("DeepSeek (Work)");
    const input = view.container.querySelector<HTMLInputElement>("input[maxlength]");
    if (!input) throw new Error("Missing name field");
    expect(input.value).toBe("Work");
    await typeInto(input, "Client work");
    await act(async () => {
      input.form?.requestSubmit();
    });
    expect(models.rename).toHaveBeenCalledWith({
      credentialId: "cred-deepseek-work",
      label: "Client work",
    });
  } finally {
    await view.unmount();
  }
});

it("shows what a disconnect left, not a read sent before it", async () => {
  models.credentials.mockResolvedValue([deepseekCredential, workCredential]);
  const queryClient = testQueryClient();
  const first = await renderSettings(true, queryClient);
  await first.unmount();

  // The revisit's background read still lists Work when the disconnect lands.
  let releaseStale: () => void = () => undefined;
  models.credentials
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseStale = () => resolve([deepseekCredential, workCredential]);
        }),
    )
    .mockResolvedValue([deepseekCredential]);
  const providerNames = () =>
    [...providersSection().querySelectorAll("button")].map((entry) => entry.textContent);
  const view = await renderSettings(true, queryClient);
  try {
    expect(providerNames()).toContain("DeepSeek (Work)");
    await openProvider("DeepSeek (Work)");
    await click(buttons(view.container, "Disconnect")[0]);
    const confirm = buttons(view.container, "Disconnect");
    await click(confirm[confirm.length - 1]);
    await act(async () => releaseStale());
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(providerNames()).not.toContain("DeepSeek (Work)");
  } finally {
    await view.unmount();
  }
});
