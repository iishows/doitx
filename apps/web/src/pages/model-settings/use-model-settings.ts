import { useLingui } from "@lingui/react/macro";
import type { Me, SettingsScope, ThinkingLevel } from "@rakazo/contracts";
import {
  CLOUDFLARE_AI_GATEWAY_PROVIDER_ID,
  cloudflareModelRouting,
  connectionDisplayName,
  DEFAULT_MODEL_CONTEXT_WINDOW,
  DEFAULT_MODEL_MAX_TOKENS,
  isCloudflareModelProvider,
  LOCAL_PROVIDER_ID,
  MAX_MODEL_CONTEXT_WINDOW,
  MAX_MODEL_MAX_TOKENS,
} from "@rakazo/contracts";
import type { ConnectionFormFields } from "@rakazo/core";
import {
  clampCatalogThinkingLevel,
  connectionFormFields,
  connectionFormModelId,
  connectionMaxTokensField,
  modelConnectRequest,
  popularModelProvidersFirst,
} from "@rakazo/core";
import { fetchFresh } from "@rakazo/core/query";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useCopyText } from "../../lib/copy-text";
import type { ModelCatalogEntry } from "../../lib/model-auth";
import type { ModelPreflightFailure } from "../../lib/model-connection-preflight";
import {
  classifyModelConnectionFailure,
  loadStoredModelAuth,
  modelPreflightSuccessMessage,
  runModelConnectionPreflight,
} from "../../lib/model-connection-preflight";
import { useSpaceQueries } from "../../lib/query";
import { useSpaceRpc } from "../../lib/space-rpc";
import { useModelOAuthSignIn } from "../../lib/use-model-oauth-signin";
import { errorText } from "../../lib/user-error";

const NO_CATALOG: ModelCatalogEntry[] = [];
const NO_CREDENTIALS: never[] = [];

export type ModelConnectIntent = {
  /** False keeps the current main model; the connection is for a fallback or another role. */
  makeDefault: boolean;
  onConnected?: (choice: {
    provider: string;
    modelId: string;
    credentialId?: string;
  }) => void | Promise<void>;
};

/** `scope` is where a connection made for an empty main model becomes that model. */
export function useModelSettings(onClose: () => void, scope: SettingsScope) {
  const rpc = useSpaceRpc();
  const intentRef = useRef<ModelConnectIntent | null>(null);
  // Sign-in finishes later; it keeps the slot it was started for even if the dialog closes.
  const oauthChoiceRef = useRef<{
    choice: { provider: string; modelId: string };
    intent: ModelConnectIntent | null;
  } | null>(null);
  const { t } = useLingui();
  // What the space has is cached, so a revisit paints at once and refreshes behind it.
  const queries = useSpaceQueries();
  const queryClient = useQueryClient();
  const catalogQuery = {
    queryKey: queries.models.list.queryKey(),
    queryFn: () => rpc.models.list(),
  };
  const credentialsQuery = {
    queryKey: queries.models.credentials.queryKey(),
    queryFn: () => rpc.models.credentials(),
  };
  const meQuery = { queryKey: queries.me.queryKey(), queryFn: () => rpc.me() };
  const catalog = useQuery(catalogQuery).data ?? NO_CATALOG;
  const credentials = useQuery(credentialsQuery).data ?? NO_CREDENTIALS;
  const me: Me | null = useQuery(meQuery).data ?? null;
  const [provider, setProvider] = useState("");
  // The connection the dialog edits; null connects a new one.
  const [credentialId, setCredentialIdState] = useState<string | null>(null);
  const credentialIdRef = useRef(credentialId);
  const setCredentialId = (next: string | null) => {
    credentialIdRef.current = next;
    setCredentialIdState(next);
  };
  const [modelId, setModelId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [accountId, setAccountId] = useState("");
  const [gatewayId, setGatewayId] = useState("");
  const [reasoning, setReasoning] = useState(false);
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel | null>(null);
  const [maxTokens, setMaxTokens] = useState(String(DEFAULT_MODEL_MAX_TOKENS));
  const [contextWindow, setContextWindow] = useState(String(DEFAULT_MODEL_CONTEXT_WINDOW));
  const [supportsImages, setSupportsImages] = useState(false);
  const [maxImagesPerPrompt, setMaxImagesPerPrompt] = useState("");
  const [codeCopied, copyOAuthCode] = useCopyText();
  const [loading, setLoading] = useState(
    () =>
      queryClient.getQueryData(catalogQuery.queryKey) === undefined ||
      queryClient.getQueryData(credentialsQuery.queryKey) === undefined ||
      queryClient.getQueryData(meQuery.queryKey) === undefined,
  );
  const [pending, setPending] = useState<"connect" | "settings" | "disconnect" | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [preflightTesting, setPreflightTesting] = useState(false);
  const [preflightTarget, setPreflightTarget] = useState<"api-key" | "sign-in" | null>(null);
  const [preflightSuccess, setPreflightSuccess] = useState<string | null>(null);
  const [preflightFailure, setPreflightFailure] = useState<ModelPreflightFailure | null>(null);
  /** The local endpoint's own model ids, after "Find models"; null until asked. */
  const [foundModels, setFoundModels] = useState<string[] | null>(null);
  const preflightRevisionRef = useRef(0);
  const refreshRevisionRef = useRef(0);
  const selectionRevisionRef = useRef(0);
  const formRevisionRef = useRef(0);
  const selectedLabelRef = useRef<string | undefined>(undefined);

  const {
    oauth,
    pasteCode,
    setPasteCode,
    oauthPending,
    popupBlocked,
    cancelOAuthAttempt,
    startSubscriptionSignIn,
    submitOAuthCode,
  } = useModelOAuthSignIn({
    onClearError: () => setError(null),
    onError: setError,
    onFinished: async (_controller, credentialId) => {
      // A new account's later saves update it rather than adding another.
      setCredentialId(credentialId);
      await refresh();
      const started = oauthChoiceRef.current;
      oauthChoiceRef.current = null;
      if (started) await started.intent?.onConnected?.({ ...started.choice, credentialId });
    },
  });

  /**
   * `keepForm` reloads the lists without resetting the open connection's fields. Every refresh but
   * the one on open follows a change, so by default it never reuses a read sent before that change.
   */
  async function refresh({
    keepForm = false,
    reuse = false,
  }: {
    keepForm?: boolean;
    reuse?: boolean;
  } = {}) {
    const refreshRevision = ++refreshRevisionRef.current;
    const selectionRevision = keepForm ? -1 : selectionRevisionRef.current;
    const [nextCatalog, nextCredentials, nextMe] = await Promise.all([
      fetchFresh(queryClient, catalogQuery, { reuse }),
      fetchFresh(queryClient, credentialsQuery, { reuse }),
      fetchFresh(queryClient, meQuery, { reuse }),
    ]);
    if (refreshRevision !== refreshRevisionRef.current) return undefined;
    applyLoaded(nextCatalog, nextCredentials, nextMe, selectionRevision);
    return nextCredentials;
  }

  /** Points the form at the saved choice, unless the user picked something since the load began. */
  function applyLoaded(
    nextCatalog: ModelCatalogEntry[],
    nextCredentials: typeof credentials,
    nextMe: Me,
    selectionRevision: number,
  ) {
    const nextProvider =
      provider && nextCatalog.some((entry) => entry.provider === provider)
        ? provider
        : (nextMe.defaultProvider ?? nextCatalog[0]?.provider ?? "");
    const nextCredential = credentialIdRef.current
      ? nextCredentials.find((entry) => entry.id === credentialIdRef.current)
      : undefined;
    // A connection removed elsewhere leaves the dialog connecting a new one.
    if (credentialIdRef.current && !nextCredential) setCredentialId(null);
    const nextModel = connectionFormModelId({
      catalog: nextCatalog,
      provider: nextProvider,
      credential: nextCredential,
      defaults: nextMe,
      current: modelId,
    });
    if (selectionRevision === selectionRevisionRef.current) {
      invalidatePreflight();
      setProvider(nextProvider);
      setModelId(nextModel);
      applyFields(
        connectionFormFields({
          catalog: nextCatalog,
          provider: nextProvider,
          modelId: nextModel,
          credential: nextCredential,
        }),
      );
    }
  }

  function applyFields(fields: ConnectionFormFields) {
    setReasoning(fields.reasoning);
    setThinkingLevel(fields.thinkingLevel);
    setMaxTokens(fields.maxTokens);
    setContextWindow(fields.contextWindow);
    setSupportsImages(fields.supportsImages);
    setMaxImagesPerPrompt(fields.maxImagesPerPrompt);
    setAccountId(fields.accountId);
    setGatewayId(fields.gatewayId);
  }

  useLayoutEffect(() => {
    const cachedCatalog = queryClient.getQueryData(catalogQuery.queryKey);
    const cachedCredentials = queryClient.getQueryData(credentialsQuery.queryKey);
    const cachedMe = queryClient.getQueryData(meQuery.queryKey);
    // Before paint, so a revisit opens on the saved choice rather than an empty form.
    if (cachedCatalog && cachedCredentials && cachedMe) {
      applyLoaded(cachedCatalog, cachedCredentials, cachedMe, selectionRevisionRef.current);
    }
    void refresh({ reuse: true })
      .catch((err: unknown) => setError(errorText(err, t`Could not load model settings`)))
      .finally(() => setLoading(false));
    return () => {
      refreshRevisionRef.current += 1;
    };
  }, []);

  const groups = useMemo(() => {
    const grouped = new Map<string, ModelCatalogEntry[]>();
    for (const entry of catalog) {
      const entries = grouped.get(entry.provider) ?? [];
      entries.push(entry);
      grouped.set(entry.provider, entries);
    }
    return popularModelProvidersFirst(
      [...grouped].map(([id, entries]) => ({
        id,
        name: entries[0]?.providerName ?? id,
        entries,
      })),
      (group) => group.id,
    );
  }, [catalog, credentials]);
  const credentialByProvider = useMemo(
    () => new Map(credentials.map((entry) => [entry.provider, entry])),
    [credentials],
  );
  const modelsForProvider = catalog.filter((entry) => entry.provider === provider);
  const selected = modelsForProvider.find((entry) => entry.id === modelId) ?? modelsForProvider[0];
  selectedLabelRef.current = selected?.label;
  const selectedProviderName = groups.find((group) => group.id === provider)?.name ?? provider;
  const credential = credentialId
    ? credentials.find((entry) => entry.id === credentialId)
    : undefined;
  const selectedConnectionName = credential
    ? connectionDisplayName(
        credential,
        groups.find((group) => group.id === provider)?.name ?? provider,
        modelsForProvider[0]?.providerName ? [modelsForProvider[0].providerName] : [],
      )
    : selectedProviderName;
  const disconnectName = selectedConnectionName;
  const hostCredentialSource = me?.hostCredentialSource ?? "";
  const isCloudflareGateway = provider === CLOUDFLARE_AI_GATEWAY_PROVIDER_ID;
  const isCloudflare = isCloudflareModelProvider(provider);
  const cloudflareRoutingReady =
    !isCloudflare || cloudflareModelRouting({ provider, accountId, gatewayId }) !== undefined;
  const currentEntry = catalog.find(
    (entry) => entry.provider === me?.defaultProvider && entry.id === me?.defaultModel,
  );
  // Space still bills the host while this provider matches; model id alone is not credentials.
  const usingServerCredentials = provider === me?.hostCredentialProvider;
  const acceptsKey = selected?.auth !== "oauth";
  // The local endpoint is often keyless, so its connect and test buttons stay live
  // with the key field empty; other providers need a real key to save or probe.
  const keyOptional = selected?.provider === LOCAL_PROVIDER_ID;
  const subscriptionSignIn = selected?.signIn !== undefined;
  // Effort levels for the staged catalog model — "off" stays out, matching the
  // per-bot Thinking picker.
  const catalogThinkingLevels = selected
    ? (selected.thinkingLevels ?? []).filter((level) => level !== "off")
    : [];
  const busy = pending !== null || oauthPending;
  // Saved-connection settings edited without a new key (output limit, gateway ids).
  const settingsDirty =
    Boolean(credential) &&
    (maxTokens.trim() !== connectionMaxTokensField(provider, credential?.maxTokens) ||
      (isCloudflare &&
        (accountId.trim() !== (credential?.accountId ?? "") ||
          gatewayId.trim() !== (credential?.gatewayId ?? ""))));

  function invalidatePreflight() {
    preflightRevisionRef.current += 1;
    setPreflightTesting(false);
    setPreflightTarget(null);
    setPreflightSuccess(null);
    setPreflightFailure(null);
    setFoundModels(null);
  }

  function preflightStillCurrent(revision: number): boolean {
    return revision === preflightRevisionRef.current;
  }

  function updateApiKey(nextApiKey: string) {
    setApiKey(nextApiKey);
    // A probed id belongs to the list that key returned; another key lists again.
    if (!catalog.some((entry) => entry.provider === provider && entry.id === modelId)) {
      setModelId("");
    }
    invalidatePreflight();
  }

  /** Opens a connection (by id) or a new one (null) for the provider. */
  function chooseProvider(nextProvider: string, targetCredentialId: string | null = null) {
    cancelOAuthAttempt();
    formRevisionRef.current += 1;
    selectionRevisionRef.current += 1;
    const nextCredential = targetCredentialId
      ? credentials.find((entry) => entry.id === targetCredentialId)
      : undefined;
    setCredentialId(nextCredential?.id ?? null);
    const nextModelId = connectionFormModelId({
      catalog,
      provider: nextProvider,
      credential: nextCredential,
      defaults: me,
    });
    setProvider(nextProvider);
    setModelId(nextModelId);
    applyFields(
      connectionFormFields({
        catalog,
        provider: nextProvider,
        modelId: nextModelId,
        credential: nextCredential,
      }),
    );
    setApiKey("");
    invalidatePreflight();
    setError(null);
    setNotice(null);
  }

  /** Adopts the first id a probe listed, the way the upstream form preselects one. */
  function adoptFoundModels(models: string[]) {
    setFoundModels(models);
    if (models.length > 0 && !models.includes(modelId)) setModelId(models[0]!);
  }

  /** Picks one of the ids "Find models" listed for the connection's own model. */
  function selectFoundModel(nextModelId: string) {
    setModelId(nextModelId);
    setPreflightFailure(null);
    setPreflightSuccess(null);
    setError(null);
    setNotice(null);
  }

  async function testApiKeyConnection() {
    if (!selected?.catalogProbe) return;
    const revision = preflightRevisionRef.current;
    setPreflightTarget("api-key");
    setPreflightTesting(true);
    setPreflightSuccess(null);
    setPreflightFailure(null);
    setError(null);
    setNotice(null);
    // Check the model the connection will run, not the provider's catalog stand-in:
    // an unconfigured endpoint has no model yet, so nothing is checked against the list.
    const result = await runModelConnectionPreflight({
      authKind: "api-key",
      provider: selected.provider,
      apiKey,
      modelId: modelId.trim() || undefined,
      catalogProbe: true,
      probeCatalog: rpc.models.probeCatalog,
    });
    if (!preflightStillCurrent(revision)) return;
    setPreflightTesting(false);
    if (result.ok) {
      setPreflightSuccess(modelPreflightSuccessMessage(result.discoveredModels.length));
      return;
    }
    setPreflightFailure(result.failure);
  }

  /**
   * Lists the models the local endpoint actually serves, the way the upstream
   * connection form did. `Test API key` answers pass/fail; this shows the ids.
   */
  async function findModels() {
    if (!selected?.catalogProbe) return;
    const revision = preflightRevisionRef.current;
    setPreflightTarget("api-key");
    setPreflightTesting(true);
    setPreflightSuccess(null);
    setPreflightFailure(null);
    setFoundModels(null);
    setError(null);
    setNotice(null);
    try {
      const { models } = await rpc.models.probeCatalog({
        provider: selected.provider,
        apiKey,
      });
      if (!preflightStillCurrent(revision)) return;
      adoptFoundModels(models);
      // The list itself is the result; only an empty one needs saying out loud.
      if (models.length === 0) setPreflightSuccess(modelPreflightSuccessMessage(0));
    } catch (error) {
      if (!preflightStillCurrent(revision)) return;
      setPreflightFailure(classifyModelConnectionFailure(error, { modelId: selected.id }));
    } finally {
      if (preflightStillCurrent(revision)) setPreflightTesting(false);
    }
  }

  async function testOAuthConnection() {
    if (!selected) return;
    const revision = preflightRevisionRef.current;
    setPreflightTarget("sign-in");
    setPreflightTesting(true);
    setPreflightSuccess(null);
    setPreflightFailure(null);
    setError(null);
    setNotice(null);
    const stored = await loadStoredModelAuth(
      selected.provider,
      () => rpc.models.credentials(),
      selected.id,
      credentialIdRef.current,
    );
    if (!preflightStillCurrent(revision)) return;
    const result = await runModelConnectionPreflight({
      authKind: "oauth",
      provider: selected.provider,
      ...stored,
    });
    if (!preflightStillCurrent(revision)) return;
    setPreflightTesting(false);
    if (result.ok) {
      setPreflightSuccess(t`A subscription credential is stored securely.`);
      return;
    }
    setPreflightFailure(result.failure);
  }

  // settingsOnly saves a connected catalog provider's limits and gateway ids
  // without touching the key field; key replacement stays on its own button.
  async function connectKey({ settingsOnly = false }: { settingsOnly?: boolean } = {}) {
    if (!selected) return;
    // Closing the dialog mid-save must not drop the slot this connection is for.
    const intent = intentRef.current;
    const request = modelConnectRequest({
      form: {
        apiKey,
        modelId,
        enabledModelIds: [],
        baseUrl: "",
        headerRows: null,
        reasoning,
        thinkingLevel,
        maxTokens,
        contextWindow,
        supportsImages,
        maxImagesPerPrompt,
        accountId,
        gatewayId,
      },
      selected,
      credential,
      credentialId: credential?.id ?? null,
      settingsOnly,
      ...(intent ? { makeDefault: { makeDefault: intent.makeDefault, scope } } : {}),
    });
    if (request.status === "incomplete") return;
    if (request.status === "invalid") {
      setError(
        request.field === "maxTokens"
          ? t`Enter a whole number from 1 to ${MAX_MODEL_MAX_TOKENS} for maximum output tokens.`
          : request.field === "maxImagesPerPrompt"
            ? t`Enter a whole number from 1 to 1000 for the image limit.`
            : t`Enter a whole number from 1 to ${MAX_MODEL_CONTEXT_WINDOW} for the context limit.`,
      );
      return;
    }
    const { input, savingLimitOnly, activeModelId } = request;
    setError(null);
    setNotice(null);
    setPending(settingsOnly ? "settings" : "connect");
    // Opening another connection while this saves leaves that form alone; field edits
    // in this form still adopt the connection the save creates.
    const form = formRevisionRef.current;
    const stillSelected = () => form === formRevisionRef.current;
    try {
      const saved = await rpc.models.connect(input);
      if (!stillSelected()) {
        await refresh({ keepForm: true });
        return;
      }
      // Saving again edits the connection just made instead of adding another.
      if (saved?.id) setCredentialId(saved.id);
      if (!settingsOnly) setApiKey("");
      await refresh();
      if (!stillSelected()) return;
      if (!settingsOnly)
        await intent?.onConnected?.({
          provider: selected.provider,
          modelId: activeModelId,
          credentialId: saved?.id,
        });
      // A fresh connection speaks for itself through the Active model row.
      if (savingLimitOnly) setNotice(t`Saved.`);
    } catch (err) {
      if (stillSelected()) setError(errorText(err, t`Could not connect this provider`));
    } finally {
      setPending(null);
    }
  }

  async function disconnectCredential() {
    if (!selected || !credential) return;
    cancelOAuthAttempt();
    setError(null);
    setNotice(null);
    setPending("disconnect");
    try {
      await rpc.models.disconnect({ provider: selected.provider, credentialId: credential.id });
      setCredentialId(null);
      setApiKey("");
      setThinkingLevel(null);
      await refresh();
      setNotice(t`Disconnected ${disconnectName}.`);
    } catch (err) {
      setError(errorText(err, t`Could not disconnect this provider`));
    } finally {
      setPending(null);
    }
  }

  function handleClose() {
    cancelOAuthAttempt(false);
    onClose();
  }

  function beginSelectedSubscriptionSignIn() {
    if (!selected) return;
    setNotice(null);
    const intent = intentRef.current;
    oauthChoiceRef.current = {
      choice: { provider: selected.provider, modelId: selected.id },
      intent,
    };
    void startSubscriptionSignIn({
      provider: selected.provider,
      credentialId: credential?.id ?? null,
      modelId: selected.id,
      ...(intent ? { makeDefault: intent.makeDefault, scope } : {}),
      thinkingLevel: clampCatalogThinkingLevel(
        thinkingLevel,
        selected.thinkingLevels,
      ) as ThinkingLevel | null,
      label: selected.providerName ?? selected.provider,
    });
  }

  return {
    intentRef,
    refresh,
    acceptsKey,
    accountId,
    apiKey,
    beginSelectedSubscriptionSignIn,
    busy,
    cancelOAuthAttempt,
    catalog,
    catalogThinkingLevels,
    chooseProvider,
    cloudflareRoutingReady,
    codeCopied,
    confirmDisconnect,
    connectKey,
    contextWindow,
    copyOAuthCode,
    credential,
    credentialByProvider,
    credentials,
    currentEntry,
    disconnectCredential,
    disconnectName,
    error,
    findModels,
    foundModels,
    gatewayId,
    groups,
    handleClose,
    hostCredentialSource,
    invalidatePreflight,
    isCloudflare,
    isCloudflareGateway,
    keyOptional,
    loading,
    maxImagesPerPrompt,
    maxTokens,
    me,
    modelId,
    modelsForProvider,
    notice,
    oauth,
    oauthPending,
    pasteCode,
    pending,
    popupBlocked,
    preflightFailure,
    preflightSuccess,
    preflightTarget,
    preflightTesting,
    provider,
    reasoning,
    selected,
    selectedConnectionName,
    selectedProviderName,
    selectionRevisionRef,
    selectFoundModel,
    setAccountId,
    setConfirmDisconnect,
    setContextWindow,
    setError,
    setGatewayId,
    setMaxImagesPerPrompt,
    setMaxTokens,
    setModelId,
    setNotice,
    setPasteCode,
    setReasoning,
    setSupportsImages,
    setThinkingLevel,
    settingsDirty,
    submitOAuthCode,
    subscriptionSignIn,
    supportsImages,
    testApiKeyConnection,
    testOAuthConnection,
    thinkingLevel,
    updateApiKey,
    usingServerCredentials,
  };
}
export type ModelSettingsState = ReturnType<typeof useModelSettings>;
