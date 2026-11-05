import type {
  ModelCatalogEntry,
  ModelConnectInput,
  ModelCredential,
  ModelHeaderRow,
  SettingsScope,
  ThinkingLevel,
} from "@rakazo/contracts";
import {
  contextWindowForModel,
  DEFAULT_MODEL_CONTEXT_WINDOW,
  isCloudflareModelProvider,
  LOCAL_PROVIDER_ID,
  ModelHeaderRowsSchema,
  modelHeadersInput,
  OPENAI_COMPATIBLE_PROVIDER_ID,
  openAiCompatibleConnectReady,
  parseModelContextWindow,
  parseModelMaxImagesPerPrompt,
  parseModelMaxTokens,
  savedCompatibleEndpointMatches,
} from "@rakazo/contracts";
import {
  COMPATIBLE_THINKING_LEVELS,
  clampCatalogThinkingLevel,
  connectionMaxTokensField,
  pickCatalogModelId,
} from "./model-providers.js";

type CatalogModel = Pick<
  ModelCatalogEntry,
  "provider" | "id" | "recommended" | "thinkingLevels" | "placeholder"
>;
type DefaultModel = { defaultProvider: string | null; defaultModel: string | null };

/** What a connection form edits, as the strings and toggles its fields hold. */
export type ConnectionFormFields = {
  enabledModelIds: string[];
  baseUrl: string;
  reasoning: boolean;
  thinkingLevel: ThinkingLevel | null;
  maxTokens: string;
  contextWindow: string;
  supportsImages: boolean;
  maxImagesPerPrompt: string;
  accountId: string;
  gatewayId: string;
};

/**
 * The model a connection form opens on. An OpenAI-compatible connection keeps its own model, so
 * a new one starts empty rather than borrowing another server's. A catalog provider keeps the
 * model on screen while the catalog still lists it, else the connection's, else the default's.
 */
export function connectionFormModelId(input: {
  catalog: readonly CatalogModel[];
  provider: string;
  credential?: Pick<ModelCredential, "modelId">;
  defaults?: DefaultModel | null;
  current?: string;
}): string {
  const { catalog, provider, credential, defaults, current } = input;
  if (provider === OPENAI_COMPATIBLE_PROVIDER_ID) return credential?.modelId ?? "";
  return (
    catalog.find((entry) => entry.provider === provider && entry.id === current)?.id ??
    pickCatalogModelId(
      catalog,
      provider,
      credential?.modelId ??
        (provider === defaults?.defaultProvider ? defaults.defaultModel : null),
    )
  );
}

/**
 * The fields a form shows for a saved connection, or a new one when `credential` is undefined.
 * A stored effort is bound to the model it was saved with, and is clamped to what `modelId` runs.
 */
export function connectionFormFields(input: {
  catalog: readonly CatalogModel[];
  provider: string;
  modelId: string;
  credential?: Pick<
    ModelCredential,
    | "modelId"
    | "enabledModelIds"
    | "baseUrl"
    | "reasoning"
    | "thinkingLevel"
    | "maxTokens"
    | "contextWindow"
    | "modelContextWindows"
    | "supportsImages"
    | "maxImagesPerPrompt"
    | "accountId"
    | "gatewayId"
  >;
  /** Prefills a new OpenAI-compatible connection, such as the Ollama Cloud preset. */
  presetBaseUrl?: string;
}): ConnectionFormFields {
  const { catalog, provider, modelId, credential, presetBaseUrl } = input;
  const compatible = provider === OPENAI_COMPATIBLE_PROVIDER_ID;
  const supportedThinking = compatible
    ? credential?.reasoning
      ? COMPATIBLE_THINKING_LEVELS
      : []
    : catalog.find((entry) => entry.provider === provider && entry.id === modelId)?.thinkingLevels;
  return {
    enabledModelIds: credential?.enabledModelIds ?? [],
    baseUrl: compatible ? (credential?.baseUrl ?? presetBaseUrl ?? "") : "",
    reasoning: credential?.reasoning ?? false,
    thinkingLevel: clampCatalogThinkingLevel(
      credential?.modelId === modelId ? credential.thinkingLevel : null,
      supportedThinking,
    ) as ThinkingLevel | null,
    maxTokens: connectionMaxTokensField(provider, credential?.maxTokens),
    contextWindow: (() => {
      const saved = credential ? contextWindowForModel(credential, modelId) : undefined;
      // A compatible endpoint always needs a window. A catalog model keeps its own
      // unless one was saved, so an unrelated save never overrides the model card.
      if (compatible) return String(saved ?? DEFAULT_MODEL_CONTEXT_WINDOW);
      return saved === undefined ? "" : String(saved);
    })(),
    supportsImages: credential?.supportsImages ?? false,
    maxImagesPerPrompt: String(credential?.maxImagesPerPrompt ?? ""),
    accountId: credential?.accountId ?? "",
    gatewayId: credential?.gatewayId ?? "",
  };
}

/** Whether an OpenAI-compatible form can save: a URL, a model, valid headers, and a key if one is needed. */
export function compatibleConnectionReady(input: {
  apiKey: string;
  baseUrl: string;
  modelId: string;
  headerRows: ModelHeaderRow[] | null;
  credential?: Pick<ModelCredential, "hasKey" | "baseUrl">;
}): boolean {
  const { apiKey, credential, headerRows, modelId } = input;
  const baseUrl = input.baseUrl.trim();
  return openAiCompatibleConnectReady({
    apiKey:
      apiKey ||
      (credential?.hasKey && savedCompatibleEndpointMatches(baseUrl, credential.baseUrl)
        ? "stored"
        : ""),
    baseUrl,
    modelId:
      headerRows !== null && !ModelHeaderRowsSchema.safeParse(headerRows).success ? "" : modelId,
  });
}

export type ConnectionFormDraft = Omit<ConnectionFormFields, "enabledModelIds"> & {
  apiKey: string;
  modelId: string;
  enabledModelIds: readonly string[];
  headerRows: ModelHeaderRow[] | null;
};

/** A field whose number is out of range; each app words the message. */
export type ConnectionFormInvalidField = "maxTokens" | "maxImagesPerPrompt" | "contextWindow";

export type ModelConnectRequest =
  | { status: "incomplete" }
  | { status: "invalid"; field: ConnectionFormInvalidField }
  | {
      status: "ready";
      input: ModelConnectInput;
      /** A catalog provider's save without a new key: limits and gateway ids only. */
      savingLimitOnly: boolean;
      /** The model the saved connection runs. */
      activeModelId: string;
    };

/**
 * The `models.connect` input for a connection form. `settingsOnly` saves a catalog provider's
 * limits and gateway ids without the key field. `makeDefault` is sent with its scope when set.
 */
export function modelConnectRequest(input: {
  form: ConnectionFormDraft;
  selected: Pick<
    ModelCatalogEntry,
    "provider" | "providerName" | "id" | "thinkingLevels" | "placeholder"
  >;
  credential?: Pick<
    ModelCredential,
    "modelId" | "thinkingLevel" | "contextWindow" | "modelContextWindows"
  >;
  credentialId: string | null;
  settingsOnly?: boolean;
  makeDefault?: { makeDefault: boolean; scope: SettingsScope };
}): ModelConnectRequest {
  const { form, selected, credential, credentialId, settingsOnly = false, makeDefault } = input;
  const compatible = selected.provider === OPENAI_COMPATIBLE_PROVIDER_ID;
  const baseUrl = form.baseUrl.trim();
  const modelId = form.modelId.trim();
  const newKey = settingsOnly ? "" : form.apiKey.trim();
  // The local endpoint is often keyless, so a first connection there may be saved
  // with an empty key: the server still answers a probe, which discovers its models.
  const keyless = selected.provider === LOCAL_PROVIDER_ID;
  const savingLimitOnly = !compatible && !newKey && !keyless;
  // The form's id wins: a probe can discover a model the catalog has not listed yet,
  // and that is the one to save. A placeholder stands in for models a probe discovers,
  // so it is never saved as a model itself.
  const activeModelId = compatible ? modelId : modelId || (selected.placeholder ? "" : selected.id);
  if (compatible) {
    if (!baseUrl || !modelId) return { status: "incomplete" };
  } else if (savingLimitOnly) {
    if (!credential) return { status: "incomplete" };
  } else if (!keyless && newKey.length < 8) {
    return { status: "incomplete" };
  }
  const maxTokens = form.maxTokens.trim() ? parseModelMaxTokens(form.maxTokens) : undefined;
  if ((compatible || form.maxTokens.trim()) && maxTokens === undefined) {
    return { status: "invalid", field: "maxTokens" };
  }
  const maxImagesPerPrompt = compatible
    ? parseModelMaxImagesPerPrompt(form.maxImagesPerPrompt, form.supportsImages)
    : undefined;
  if (
    compatible &&
    form.supportsImages &&
    form.maxImagesPerPrompt.trim() &&
    maxImagesPerPrompt === undefined
  ) {
    return { status: "invalid", field: "maxImagesPerPrompt" };
  }
  // Every provider can carry a per-model window; only a compatible connection requires one.
  const contextWindow = form.contextWindow.trim()
    ? parseModelContextWindow(form.contextWindow)
    : undefined;
  if ((compatible || form.contextWindow.trim()) && contextWindow === undefined) {
    return { status: "invalid", field: "contextWindow" };
  }
  // An emptied field on a model that had its own window clears that override; an
  // untouched empty field means "use the model's own window" and sends nothing.
  const clearContextWindow =
    !compatible &&
    !form.contextWindow.trim() &&
    credential !== undefined &&
    contextWindowForModel(credential, modelId || (selected.placeholder ? "" : selected.id)) !==
      undefined;
  // The staged effort belongs to the model on screen. Clamp it before a connect or a limit
  // save so a previous model's level cannot stick.
  const thinkingLevel = clampCatalogThinkingLevel(
    form.thinkingLevel,
    compatible ? (form.reasoning ? COMPATIBLE_THINKING_LEVELS : []) : selected.thinkingLevels,
  ) as ThinkingLevel | null;
  const label = selected.providerName ?? selected.provider;
  if (compatible) {
    return {
      status: "ready",
      savingLimitOnly,
      activeModelId,
      input: {
        provider: selected.provider,
        baseUrl,
        headers: modelHeadersInput(form.headerRows),
        modelId,
        // The server adds the default itself.
        enabledModelIds: form.enabledModelIds.filter((id) => id !== modelId),
        reasoning: form.reasoning,
        thinkingLevel,
        maxTokens,
        contextWindow,
        supportsImages: form.supportsImages,
        maxImagesPerPrompt:
          form.supportsImages && !form.maxImagesPerPrompt.trim() ? null : maxImagesPerPrompt,
        ...makeDefault,
        apiKey: form.apiKey.trim() || undefined,
        label,
        credentialId,
      },
    };
  }
  const modelChanged = (credential?.modelId ?? null) !== (activeModelId || null);
  const storedThinking =
    credential?.modelId === activeModelId ? (credential.thinkingLevel ?? null) : null;
  return {
    status: "ready",
    savingLimitOnly,
    activeModelId,
    input: {
      provider: selected.provider,
      ...(newKey ? { apiKey: newKey } : {}),
      ...(isCloudflareModelProvider(selected.provider)
        ? { accountId: form.accountId.trim(), gatewayId: form.gatewayId.trim() }
        : {}),
      ...(activeModelId ? { modelId: activeModelId } : {}),
      // A limits-only save leaves the stored effort alone while the model and effort stay
      // put. Changing either sends the clamped level, including null, so the previous
      // model's effort is not reused.
      ...(!savingLimitOnly || modelChanged || (form.thinkingLevel ?? null) !== storedThinking
        ? { thinkingLevel }
        : {}),
      ...makeDefault,
      maxTokens: maxTokens ?? null,
      ...(contextWindow !== undefined
        ? { contextWindow }
        : clearContextWindow
          ? { contextWindow: null }
          : {}),
      label,
      credentialId,
    },
  };
}
