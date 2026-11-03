import { Plural, Trans, useLingui } from "@lingui/react/macro";
import type { ThinkingLevel } from "@rakazo/contracts";
import {
  CLOUDFLARE_AI_GATEWAY_PROVIDER_ID,
  cloudflareModelRouting,
  DOITX_PROVIDER_ID,
  isCloudflareModelProvider,
  LOCAL_PROVIDER_ID,
} from "@rakazo/contracts";
import { pickCatalogModelId, popularModelProvidersFirst } from "@rakazo/core";
import {
  Button,
  Input,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@rakazo/ui-web";
import { Check, Copy } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  ModelPreflightFeedback,
  modelPreflightTestingLabel,
} from "../components/ModelConnectionPreflightNotice";
import { PageLoading } from "../components/PageLoading";
import { SignupSurvey } from "../components/SignupSurvey";
import { useCopyText } from "../lib/copy-text";
import type { ModelCatalogEntry } from "../lib/model-auth";
import type { ModelPreflightFailure } from "../lib/model-connection-preflight";
import {
  modelPreflightSuccessMessage,
  runModelConnectionPreflight,
} from "../lib/model-connection-preflight";
import { rpc } from "../lib/rpc";
import { useModelOAuthSignIn } from "../lib/use-model-oauth-signin";
import { errorText } from "../lib/user-error";

/** Doitx credits sit among the providers as the one choice that needs no account of its own. */
const CREDITS_OPTION = "__rakazo_credits__";
/** A provider whose catalog entry offers both sign-in and a key appears once per way to connect. */
type ProviderAuth = "sign-in" | "key";

/** The two endpoints a deployment offers, router first. */
const MAIN_PROVIDER_OPTIONS: ReadonlyArray<{ provider: string; auth?: ProviderAuth }> = [
  { provider: DOITX_PROVIDER_ID },
  { provider: LOCAL_PROVIDER_ID },
];

function providerOptionValue(provider: string, auth?: ProviderAuth): string {
  return auth ? `${provider}:${auth}` : provider;
}
const FIRST_BOT_NAME = "Chief";
const FIRST_BOT_SPAWN_KEY = "onboarding:first";
const FIRST_BOT_LOCK = "rakazo:onboarding-first-bot";

/** Survives StrictMode remounts; concurrent first-bot creates share one in-flight attempt. */
let firstBotEnsure: Promise<{ id: string }> | null = null;

function findFirstBot(
  bots: Array<{ id: string; name: string; spawnKey: string | null }>,
): { id: string } | undefined {
  const bySpawnKey = bots.find((bot) => bot.spawnKey === FIRST_BOT_SPAWN_KEY);
  if (bySpawnKey) return { id: bySpawnKey.id };
  // Legacy first-run Chief created before spawnKey was set.
  const byName = bots.find((bot) => bot.name === FIRST_BOT_NAME);
  return byName ? { id: byName.id } : undefined;
}

async function createOrReuseFirstBot(): Promise<{ id: string }> {
  const existing = await rpc.bots.list();
  const reuse = findFirstBot(existing);
  if (reuse) return reuse;
  try {
    const created = await rpc.bots.create({
      name: FIRST_BOT_NAME,
      description: "",
      instructions: "",
      notifyOnFinish: true,
      spawnKey: FIRST_BOT_SPAWN_KEY,
    });
    return { id: created.id };
  } catch (error) {
    // Another tab won the unique (spaceId, spawnKey) race; reuse that bot only.
    const afterConflict = await rpc.bots.list();
    const winner = afterConflict.find((bot) => bot.spawnKey === FIRST_BOT_SPAWN_KEY);
    if (winner) return { id: winner.id };
    throw error;
  }
}

async function withFirstBotLock<T>(run: () => Promise<T>): Promise<T> {
  const locks = globalThis.navigator?.locks;
  if (!locks?.request) return run();
  return locks.request(FIRST_BOT_LOCK, run);
}

async function ensureFirstBot(): Promise<{ id: string }> {
  if (firstBotEnsure) return firstBotEnsure;
  // Web Lock serializes cross-tab creates; module promise covers same-tab StrictMode.
  // spawnKey makes create idempotent when locks are unavailable.
  // Clear after settle so a later empty-space visit re-lists instead of reusing a deleted id.
  firstBotEnsure = withFirstBotLock(createOrReuseFirstBot).finally(() => {
    firstBotEnsure = null;
  });
  return firstBotEnsure;
}

export function OnboardingPage() {
  const { t } = useLingui();
  const navigate = useNavigate();
  const fieldId = useId();
  // The URL holds the survey and model steps, so /onboarding/survey and /onboarding/model open directly.
  const { step: routeStep } = useParams();
  const linkedStep = routeStep === "survey" || routeStep === "model" ? routeStep : undefined;
  const [creatingBot, setCreatingBot] = useState(false);
  const [surveyDone, setSurveyDone] = useState(false);
  const step = creatingBot ? "bot" : surveyDone ? "loading" : (linkedStep ?? "loading");
  const [billingEnabled, setBillingEnabled] = useState(false);
  // The step after the survey; null until me loads.
  const [afterSurvey, setAfterSurvey] = useState<"model" | "bot" | null>(null);
  const [catalog, setCatalog] = useState<ModelCatalogEntry[]>([]);
  const [provider, setProvider] = useState("");
  const [providerAuth, setProviderAuth] = useState<ProviderAuth | undefined>();
  const [credits, setCredits] = useState(false);
  const [modelId, setModelId] = useState("");
  const modelIdRef = useRef(modelId);
  modelIdRef.current = modelId;
  const [apiKey, setApiKey] = useState("");
  const [accountId, setAccountId] = useState("");
  const [gatewayId, setGatewayId] = useState("");
  const [_thinkingLevel, setThinkingLevel] = useState<ThinkingLevel | null>(null);
  const createStartedRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [preflightTesting, setPreflightTesting] = useState(false);
  const [preflightTarget, setPreflightTarget] = useState<"api-key" | null>(null);
  const [preflightSuccess, setPreflightSuccess] = useState<string | null>(null);
  const [preflightFailure, setPreflightFailure] = useState<ModelPreflightFailure | null>(null);
  const preflightRevisionRef = useRef(0);
  const [codeCopied, copyOAuthCode] = useCopyText();

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
    onFinished: async () => {
      goTo("bot");
    },
  });

  useEffect(() => {
    void Promise.all([rpc.me(), rpc.models.list().catch(() => [])])
      .then(([me, models]) => {
        setBillingEnabled(me.billingEnabled);
        setCatalog(models);
        const next = me.needsModel ? "model" : "bot";
        setAfterSurvey(next);
        if (!linkedStep) goTo(me.needsSignupSurvey ? "survey" : next);
      })
      .catch(() => {
        setAfterSurvey("bot");
        if (!linkedStep) goTo("bot");
      });
  }, []);

  useEffect(() => {
    if (!surveyDone || !afterSurvey) return;
    setSurveyDone(false);
    goTo(afterSurvey);
  }, [surveyDone, afterSurvey]);

  function goTo(next: "survey" | "model" | "bot") {
    if (next === "bot") setCreatingBot(true);
    navigate(next === "bot" ? "/onboarding" : `/onboarding/${next}`, { replace: true });
  }

  const providers = useMemo(() => {
    const seen = new Map<string, ModelCatalogEntry>();
    for (const entry of catalog) {
      if (!seen.has(entry.provider)) seen.set(entry.provider, entry);
    }
    return popularModelProvidersFirst([...seen.values()], (entry) => entry.provider);
  }, [catalog]);

  const modelsForProvider = useMemo(
    () => catalog.filter((entry) => entry.provider === provider),
    [catalog, provider],
  );

  const selected = modelsForProvider.find((entry) => entry.id === modelId) ?? modelsForProvider[0];
  const isCloudflareGateway = provider === CLOUDFLARE_AI_GATEWAY_PROVIDER_ID;
  const isCloudflare = isCloudflareModelProvider(provider);
  const cloudflareRoutingReady =
    !isCloudflare || cloudflareModelRouting({ provider, accountId, gatewayId }) !== undefined;
  const subscriptionSignIn = selected?.signIn !== undefined && providerAuth !== "key";
  const acceptsKey = selected?.auth !== "oauth" && providerAuth !== "sign-in";
  const signInLabel = selected?.oauthLabel ?? t`Sign in`;
  const canSaveModel = Boolean(
    selected &&
      modelId.trim() &&
      !oauthPending &&
      cloudflareRoutingReady &&
      acceptsKey &&
      apiKey.trim(),
  );
  // Subscriptions and the common API providers first; every other provider follows.
  const providerOptions = useMemo(() => {
    const byId = new Map(providers.map((entry) => [entry.provider, entry]));
    // Beside the subscriptions, the key-based options say API.
    const optionLabel = (id: string) => byId.get(id)?.providerName ?? id;
    const main = [
      ...(billingEnabled ? [{ value: CREDITS_OPTION, label: t`Doitx credits` }] : []),
      ...MAIN_PROVIDER_OPTIONS.filter((option) => byId.has(option.provider)).map((option) => ({
        value: providerOptionValue(option.provider, option.auth),
        label: optionLabel(option.provider),
      })),
    ];
    const rest = providers
      .filter(
        (entry) => !MAIN_PROVIDER_OPTIONS.some((option) => option.provider === entry.provider),
      )
      .map((entry) => ({ value: entry.provider, label: entry.providerName ?? entry.provider }));
    return { main, rest };
  }, [billingEnabled, providers]);
  // Base UI Select.Value only resolves labels when Root gets `items`.
  const providerItems = useMemo(
    () => [...providerOptions.main, ...providerOptions.rest],
    [providerOptions],
  );
  const modelItems = useMemo(
    () => modelsForProvider.map((entry) => ({ value: entry.id, label: entry.label })),
    [modelsForProvider],
  );

  function invalidatePreflight() {
    preflightRevisionRef.current += 1;
    setPreflightTesting(false);
    setPreflightTarget(null);
    setPreflightSuccess(null);
    setPreflightFailure(null);
  }

  function updateApiKey(nextApiKey: string) {
    setApiKey(nextApiKey);
    invalidatePreflight();
  }

  function selectProvider(option: string) {
    if (option === providerOptionValue(provider, providerAuth)) return;
    const [nextProvider = option, auth] = option.split(":") as [string, ProviderAuth?];
    cancelOAuthAttempt();
    setProvider(nextProvider);
    setProviderAuth(auth);
    setApiKey("");
    setAccountId("");
    setGatewayId("");
    setModelId(pickCatalogModelId(catalog, nextProvider));
    setThinkingLevel(null);
    invalidatePreflight();
    setError(null);
    setNotice(null);
  }

  function preflightStillCurrent(revision: number): boolean {
    return revision === preflightRevisionRef.current;
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
    const result = await runModelConnectionPreflight({
      authKind: "api-key",
      provider: selected.provider,
      apiKey,
      modelId: selected.id,
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

  async function saveModel() {
    if (!canSaveModel) return;
    setError(null);
    try {
      if (apiKey) {
        await rpc.models.connect({
          provider,
          apiKey,
          ...(isCloudflare ? { accountId: accountId.trim(), gatewayId: gatewayId.trim() } : {}),
          modelId,
          label: selected?.providerName ?? provider,
        });
      }
      goTo("bot");
    } catch (err) {
      setError(errorText(err, t`Could not save model`));
    }
  }

  async function fundWithCredits() {
    setError(null);
    try {
      await rpc.billing.selectFunding({ funding: "credits" });
      window.location.assign("/onboarding");
    } catch {
      setError(t`Could not open billing`);
    }
  }

  function beginSelectedSubscriptionSignIn() {
    if (!selected?.id) return;
    void startSubscriptionSignIn({
      provider: selected.provider,
      modelId: selected.id,
      label: selected.providerName ?? selected.provider,
    });
  }

  async function createFirstBot() {
    if (createStartedRef.current) return;
    createStartedRef.current = true;
    setError(null);
    try {
      const bot = await ensureFirstBot();
      // Onboarding continues conversationally in the thread: greeting first,
      // then the focus choice (immediate for the first bot).
      const started = await rpc.onboarding
        .start({ botId: bot.id })
        .then(() => true)
        .catch(() => false);
      if (started) {
        await rpc.onboarding.promptFocus({ botId: bot.id }).catch(() => undefined);
      }
      navigate(`/app/${bot.id}`);
    } catch (err) {
      createStartedRef.current = false;
      setError(errorText(err, t`Could not create your bot`));
    }
  }

  useEffect(() => {
    if (step !== "bot") return;
    void createFirstBot();
  }, [step]);

  // Loading, and creating the first bot, both wait on one spinner until the chat opens.
  if (step === "loading" || (step === "bot" && !error)) return <PageLoading />;

  return (
    <div className="min-h-full bg-background px-6 py-12">
      <div className="mx-auto w-full max-w-[560px]">
        {step === "survey" ? <SignupSurvey onDone={() => setSurveyDone(true)} /> : null}
        {step === "model" ? (
          <div>
            <h1 className="text-[32px] font-medium text-foreground">
              <Trans>Connect a model</Trans>
            </h1>
            <div className="mt-8 block text-sm font-medium text-foreground">
              <span>
                <Trans>Provider</Trans>
              </span>
              <Select
                value={
                  credits
                    ? CREDITS_OPTION
                    : provider
                      ? providerOptionValue(provider, providerAuth)
                      : null
                }
                onValueChange={(value) => {
                  if (typeof value !== "string" || !value) return;
                  if (value === CREDITS_OPTION) {
                    cancelOAuthAttempt();
                    setProvider("");
                    setProviderAuth(undefined);
                    setCredits(true);
                    setError(null);
                    return;
                  }
                  setCredits(false);
                  selectProvider(value);
                }}
                items={providerItems}
              >
                <SelectTrigger aria-label={t`Provider`} className="mt-2 w-full">
                  <SelectValue placeholder={t`Choose a provider`} />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {providerOptions.main.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                  {providerOptions.main.length && providerOptions.rest.length ? (
                    <SelectSeparator />
                  ) : null}
                  <SelectGroup>
                    {providerOptions.rest.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
            {provider ? (
              <>
                {subscriptionSignIn ? (
                  <div className="mt-4">
                    {oauth ? (
                      <div className="rounded-lg border border-border px-3.5 py-3">
                        {oauth.mode === "auth-url" ? (
                          <>
                            <p className="text-sm text-muted-foreground">
                              <Trans>
                                Sign in at{" "}
                                <a
                                  href={oauth.verificationUri}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="text-foreground underline"
                                >
                                  {new URL(oauth.verificationUri).hostname}
                                </a>
                                , then paste the code here.
                              </Trans>
                            </p>
                            <div className="mt-3 flex items-center gap-2">
                              <Input
                                value={pasteCode}
                                onChange={(e) => setPasteCode(e.target.value)}
                                aria-label={t`Authorization code`}
                                autoComplete="off"
                                spellCheck={false}
                              />
                              <Button
                                disabled={!pasteCode.trim()}
                                onClick={() => void submitOAuthCode()}
                              >
                                <Trans>Submit</Trans>
                              </Button>
                            </div>
                            <p className="mt-2 text-sm text-muted-foreground">
                              <Plural
                                value={Math.ceil(oauth.expiresInSeconds / 60)}
                                one="Waiting for sign-in — the link expires in about # minute."
                                other="Waiting for sign-in — the link expires in about # minutes."
                              />
                            </p>
                          </>
                        ) : (
                          <>
                            <p className="text-sm text-muted-foreground">
                              {popupBlocked ? (
                                <Trans>
                                  Open{" "}
                                  <a
                                    href={oauth.verificationUri}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="text-foreground underline"
                                  >
                                    {oauth.verificationUri.replace(/^https:\/\//, "")}
                                  </a>{" "}
                                  and enter this code:
                                </Trans>
                              ) : (
                                <Trans>
                                  A sign-in tab opened at{" "}
                                  <a
                                    href={oauth.verificationUri}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="text-foreground underline"
                                  >
                                    {oauth.verificationUri.replace(/^https:\/\//, "")}
                                  </a>
                                  . Enter this code there — this window keeps waiting:
                                </Trans>
                              )}
                            </p>
                            <div className="mt-2 flex items-center gap-3">
                              <p className="font-mono text-[22px] tracking-[0.2em] text-foreground">
                                {oauth.userCode}
                              </p>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => copyOAuthCode(oauth.userCode)}
                              >
                                {codeCopied ? (
                                  <Check size={14} strokeWidth={1.8} aria-hidden="true" />
                                ) : (
                                  <Copy size={14} strokeWidth={1.8} aria-hidden="true" />
                                )}
                                {codeCopied ? <Trans>Copied</Trans> : <Trans>Copy</Trans>}
                              </Button>
                            </div>
                            <p className="mt-2 text-sm text-muted-foreground">
                              <Plural
                                value={Math.ceil(oauth.expiresInSeconds / 60)}
                                one="Waiting for sign-in — the code expires in about # minute."
                                other="Waiting for sign-in — the code expires in about # minutes."
                              />
                            </p>
                          </>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          className="mt-2 -ml-2 text-muted-foreground"
                          onClick={() => cancelOAuthAttempt()}
                        >
                          <Trans>Cancel</Trans>
                        </Button>
                      </div>
                    ) : (
                      <Button
                        disabled={oauthPending}
                        onClick={() => beginSelectedSubscriptionSignIn()}
                      >
                        {oauthPending ? <Trans>Starting…</Trans> : signInLabel}
                      </Button>
                    )}
                  </div>
                ) : null}
                {isCloudflare && acceptsKey ? (
                  <div className="mt-4 grid gap-4">
                    <label
                      htmlFor={`${fieldId}-account-id`}
                      className="block text-sm font-medium text-foreground"
                    >
                      <Trans>Account ID</Trans>
                      <Input
                        id={`${fieldId}-account-id`}
                        value={accountId}
                        onChange={(event) => setAccountId(event.target.value)}
                        autoComplete="off"
                        spellCheck={false}
                        className="mt-2"
                      />
                    </label>
                    {isCloudflareGateway ? (
                      <label
                        htmlFor={`${fieldId}-gateway-id`}
                        className="block text-sm font-medium text-foreground"
                      >
                        <Trans>Gateway ID</Trans>
                        <Input
                          id={`${fieldId}-gateway-id`}
                          value={gatewayId}
                          onChange={(event) => setGatewayId(event.target.value)}
                          autoComplete="off"
                          spellCheck={false}
                          className="mt-2"
                        />
                      </label>
                    ) : null}
                  </div>
                ) : null}
                {acceptsKey ? (
                  <label
                    htmlFor={`${fieldId}-api-key`}
                    className="mt-4 block text-sm font-medium text-foreground"
                  >
                    {subscriptionSignIn ? (
                      <Trans>Or paste an API key</Trans>
                    ) : (
                      <Trans>API key</Trans>
                    )}
                    <Input
                      id={`${fieldId}-api-key`}
                      value={apiKey}
                      onChange={(e) => updateApiKey(e.target.value)}
                      placeholder="sk-…"
                      type="password"
                      autoComplete="new-password"
                      className="mt-2"
                    />
                  </label>
                ) : null}
                {acceptsKey && selected?.catalogProbe ? (
                  <>
                    <Button
                      type="button"
                      variant="outline"
                      className="mt-3"
                      disabled={preflightTesting || apiKey.trim().length < 8}
                      onClick={() => void testApiKeyConnection()}
                    >
                      {modelPreflightTestingLabel(
                        preflightTesting && preflightTarget === "api-key",
                        "api-key",
                      )}
                    </Button>
                    {preflightTarget === "api-key" ? (
                      <ModelPreflightFeedback
                        success={preflightSuccess}
                        failure={preflightFailure}
                      />
                    ) : null}
                  </>
                ) : null}
                {/* The model is chosen once the account is connected; sign-in uses the default. */}
                {acceptsKey && apiKey.trim() ? (
                  <div className="mt-6 block text-sm text-foreground">
                    <span className="font-medium">
                      <Trans>Model</Trans>
                    </span>
                    <Select
                      value={selected?.id ?? modelId}
                      onValueChange={(value) => {
                        if (typeof value !== "string" || !value) return;
                        if (value === modelId) return;
                        cancelOAuthAttempt();
                        setModelId(value);
                        setThinkingLevel(null);
                        invalidatePreflight();
                      }}
                      items={modelItems}
                    >
                      <SelectTrigger aria-label={t`Model`} className="mt-2 w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          {modelsForProvider.map((entry) => (
                            <SelectItem key={`${entry.provider}:${entry.id}`} value={entry.id}>
                              {entry.label}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </div>
                ) : null}
              </>
            ) : null}
            {notice ? (
              <p className="mt-3 text-sm text-success" role="status">
                {notice}
              </p>
            ) : null}
            {error ? <p className="mt-3 text-sm text-destructive">{error}</p> : null}
            <Button
              className="mt-6"
              disabled={!credits && !canSaveModel}
              onClick={() => void (credits ? fundWithCredits() : saveModel())}
            >
              <Trans>Continue</Trans>
            </Button>
          </div>
        ) : null}
        {step === "bot" ? (
          <div>
            <p className="text-sm text-destructive">{error}</p>
            <Button className="mt-4" onClick={() => void createFirstBot()}>
              <Trans>Try again</Trans>
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
