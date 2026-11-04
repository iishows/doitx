(() => {
  const bridge = window.rakazoSetup;
  const i18n = window.rakazoSetupI18n;
  document.documentElement.dataset.platform = bridge?.platform ?? "browser";

  const form = document.getElementById("setup");
  const serverUrl = document.getElementById("server-url");
  const panelNew = document.getElementById("panel-new");
  const panelExisting = document.getElementById("panel-existing");
  const stackSection = document.getElementById("stack");
  const stackPhase = document.getElementById("stack-phase");
  const stackOutput = document.getElementById("stack-output");
  const stackDetail = document.getElementById("stack-detail");
  const stackDetails = document.getElementById("stack-details");
  const stackProgress = document.getElementById("stack-progress");
  const stackProgressFill = document.getElementById("stack-progress-fill");
  const stackDockerHelp = document.getElementById("stack-docker-help");
  const status = document.getElementById("status");
  const checkButton = document.getElementById("check");
  const continueButton = document.getElementById("continue");
  const quitButton = document.getElementById("quit");
  const localeSelect = document.getElementById("setup-locale");
  const themeToggle = document.getElementById("theme-toggle");

  const STACK_POLL_MS = 1000;
  const LOCALE_STORAGE_KEY = "rakazo.setupLocale";
  const THEME_STORAGE_KEY = "rakazo.setupTheme";
  const PHASE_KEYS = {
    "checking-docker": "phaseGettingReady",
    preparing: "phaseGettingReady",
    pulling: "phaseDownloading",
    starting: "phaseStarting",
    "waiting-healthy": "phaseAlmostReady",
    ready: "phaseReady",
  };
  const TERMINAL_PHASES = new Set([
    "idle",
    "docker-missing",
    "docker-not-running",
    "ready",
    "failed",
  ]);
  const PHASE_PROGRESS = {
    "checking-docker": 0.06,
    preparing: 0.12,
    pulling: 0.2,
    starting: 0.82,
    "waiting-healthy": 0.92,
    ready: 1,
  };
  /** Docker reports bytes pulled but never a total, so the bar approaches the next phase without reaching it. */
  const PULL_SPAN = 0.6;
  const PULL_SCALE_BYTES = 1.2e9;

  let defaultLocalUrl = "";
  let cloudUrl = "";
  /** Bumped on user edits, mode switches, and new async runs; a run left behind is stale. */
  let requestGeneration = 0;
  /** Generation of the check in flight; an edit or mode switch retires it and releases its lock. */
  let activeCheck = 0;
  let stackPolling = false;
  let lastStack = null;
  let lastProgress = 0;
  let detailsOpen = false;
  /** Set when a failure opened the output; a retry closes it again, a person's own click does not. */
  let detailsOpenedByFailure = false;
  /** Resolves the poll wait early when the main process pushes a new state. */
  let wakePoll = null;
  /** Last status line, kept as a key so switching language can re-render it. */
  let lastStatus = null;
  let currentLocale = i18n.matchLocale(readStored(LOCALE_STORAGE_KEY) ?? navigator.language);
  let currentTheme = readInitialTheme();

  function readStored(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  function writeStored(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      // A blocked storage area only costs persistence, not the current choice.
    }
  }

  function readInitialTheme() {
    const stored = readStored(THEME_STORAGE_KEY);
    if (stored === "light" || stored === "dark") return stored;
    return typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-color-scheme: light)").matches
      ? "light"
      : "dark";
  }

  function t(key, vars) {
    const table = i18n.MESSAGES[currentLocale] ?? i18n.MESSAGES.en;
    const message = table[key] ?? i18n.MESSAGES.en[key] ?? key;
    if (vars === undefined) return message;
    return message.replace(/\{(\w+)\}/g, (whole, name) => vars[name] ?? whole);
  }

  function selectedMode() {
    const checked = form.querySelector('input[name="mode"]:checked');
    return checked === null ? "cloud" : checked.value;
  }

  function renderStatus() {
    if (lastStatus === null) return;
    status.textContent = lastStatus.key ? t(lastStatus.key, lastStatus.vars) : lastStatus.text;
    if (lastStatus.tone === undefined) status.removeAttribute("data-tone");
    else status.setAttribute("data-tone", lastStatus.tone);
  }

  function setStatus(key, vars, tone) {
    lastStatus = { key, vars, tone };
    renderStatus();
  }

  /** Main-process errors are already English prose; keep them as-is across locale changes. */
  function setStatusText(text, tone) {
    lastStatus = { text, tone };
    renderStatus();
  }

  function clearStatus() {
    lastStatus = null;
    status.textContent = "";
    status.removeAttribute("data-tone");
  }

  function applyTheme(theme, persist) {
    currentTheme = theme;
    document.documentElement.dataset.theme = theme;
    const label = t(theme === "light" ? "switchToDark" : "switchToLight");
    themeToggle.setAttribute("aria-label", label);
    themeToggle.setAttribute("title", label);
    if (persist) writeStored(THEME_STORAGE_KEY, theme);
    if (typeof bridge?.setTheme === "function") void bridge.setTheme(theme);
  }

  function applyLocale(locale) {
    currentLocale = locale;
    const root = document.documentElement;
    root.lang = locale;
    root.dir = i18n.RTL_LOCALES.has(locale) ? "rtl" : "ltr";
    document.title = t("appTitle");

    for (const node of document.querySelectorAll("[data-i18n]")) {
      node.textContent = t(node.dataset.i18n);
    }
    for (const node of document.querySelectorAll("[data-i18n-aria-label]")) {
      node.setAttribute("aria-label", t(node.dataset.i18nAriaLabel));
    }
    for (const node of document.querySelectorAll("[data-i18n-title]")) {
      node.setAttribute("title", t(node.dataset.i18nTitle));
    }

    localeSelect.value = locale;
    // The toggle's own label depends on both theme and language.
    applyTheme(currentTheme, false);
    renderStatus();
    // Re-render the live stack so its phase, size, and button match the new language.
    // Only while "This computer" owns the form: renderStack also resets the busy state.
    if (selectedMode() === "new" && lastStack !== null) renderStack(lastStack);
    else if (selectedMode() !== "new") continueButton.textContent = t("continue");
  }

  function setBusy(busy) {
    checkButton.disabled = busy;
    continueButton.disabled = busy;
  }

  /** A save in flight cannot be cancelled, so the choice it commits must not change under it. */
  function lockMode(locked) {
    for (const input of form.querySelectorAll('input[name="mode"]')) input.disabled = locked;
  }

  function syncPanels() {
    const mode = selectedMode();
    panelNew.hidden = mode !== "new";
    panelExisting.hidden = mode !== "existing";
    checkButton.hidden = mode !== "existing";
    if (mode !== "new") continueButton.textContent = t("continue");
    clearStatus();
  }

  function isDockerPhase(phase) {
    return phase === "docker-missing" || phase === "docker-not-running";
  }

  function downloadedBytes(stack) {
    return Object.values(stack.layerBytes ?? {}).reduce((total, bytes) => total + bytes, 0);
  }

  function formatBytes(bytes) {
    if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
    if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
    if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} kB`;
    return `${Math.round(bytes)} B`;
  }

  function progressFor(stack) {
    const base = PHASE_PROGRESS[stack.phase] ?? 0;
    if (stack.phase !== "pulling") return base;
    return base + PULL_SPAN * (1 - Math.exp(-downloadedBytes(stack) / PULL_SCALE_BYTES));
  }

  function renderProgress(stack) {
    const running = stack.phase in PHASE_PROGRESS;
    stackProgress.hidden = !running;
    if (!running) {
      lastProgress = 0;
      stackProgressFill.style.width = "0%";
      return;
    }
    // A retry restarts at its phase; otherwise the bar only ever moves forward.
    lastProgress =
      stack.phase === "checking-docker"
        ? progressFor(stack)
        : Math.max(lastProgress, progressFor(stack));
    const percent = (lastProgress * 100).toFixed(1);
    stackProgressFill.style.width = `${percent}%`;
    stackProgress.setAttribute("aria-valuenow", percent);
  }

  function renderDetails(stack) {
    const bytes = stack.phase === "pulling" ? downloadedBytes(stack) : 0;
    stackDetail.textContent = bytes > 0 ? t("downloaded", { size: formatBytes(bytes) }) : "";

    // A new attempt clears the output, so drop an expansion the person did not ask for.
    if (stack.phase === "checking-docker" && detailsOpenedByFailure) {
      detailsOpen = false;
      detailsOpenedByFailure = false;
    }
    const hasOutput = stack.output.length > 0;
    // A failure asks the person to read the output, so open it for them.
    if (stack.phase === "failed" && hasOutput && !detailsOpen) {
      detailsOpen = true;
      detailsOpenedByFailure = true;
    }
    stackDetails.hidden = !hasOutput;
    stackDetails.setAttribute("aria-expanded", String(detailsOpen && hasOutput));
    stackOutput.hidden = !(detailsOpen && hasOutput);
    if (!stackOutput.hidden) {
      stackOutput.textContent = stack.output.join("\n");
      stackOutput.scrollTop = stackOutput.scrollHeight;
    }
  }

  function renderStack(stack) {
    lastStack = stack;
    const { phase } = stack;
    stackSection.hidden = phase === "idle";
    if (phase === "idle") {
      continueButton.textContent = t("continue");
      return;
    }
    const failed = isDockerPhase(phase) || phase === "failed";
    const phaseKey = PHASE_KEYS[phase];
    stackPhase.textContent = failed ? stack.message : phaseKey ? t(phaseKey) : "";
    if (failed) stackPhase.setAttribute("data-tone", "error");
    else if (phase === "ready") stackPhase.setAttribute("data-tone", "ok");
    else stackPhase.removeAttribute("data-tone");

    renderProgress(stack);
    renderDetails(stack);
    stackDockerHelp.hidden = !isDockerPhase(phase);

    if (isDockerPhase(phase)) continueButton.textContent = t("checkAgain");
    else if (phase === "failed") continueButton.textContent = t("retry");
    else continueButton.textContent = t("continue");
    setBusy(!TERMINAL_PHASES.has(phase));
  }

  async function save(mode, url) {
    const generation = ++requestGeneration;
    setBusy(true);
    lockMode(true);
    setStatus("connecting");
    try {
      const saved = await bridge.save({ mode, serverUrl: url });
      if (!saved.ok) setStatusText(saved.error ?? t("saveFailed"), "error");
    } catch {
      setStatus("saveRetry", undefined, "error");
    } finally {
      lockMode(false);
      // A newer run may own the controls by now; only their owner unlocks them.
      if (generation === requestGeneration) setBusy(false);
    }
  }

  /** Wakes on the next pushed state, and on the timer if a push is ever missed. */
  function waitForStackChange() {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        if (wakePoll === finish) wakePoll = null;
        resolve();
      };
      wakePoll = finish;
      setTimeout(finish, STACK_POLL_MS);
    });
  }

  /**
   * Follows a start already in flight until it settles. Leaving "This computer"
   * ends the follow so the stack becoming ready never saves over that choice.
   */
  async function followStack() {
    if (stackPolling) return;
    stackPolling = true;
    try {
      while (true) {
        const stack = await bridge.stack.state();
        if (stack === null) throw new Error("Setup is not active");
        // Checked after the await: a mode change during it hands the form to the change
        // handler, and a save it started must stay busy and must not be re-rendered over.
        if (selectedMode() !== "new") return;
        renderStack(stack);
        if (TERMINAL_PHASES.has(stack.phase)) {
          if (stack.phase === "ready" && selectedMode() === "new") {
            const current = await bridge.state();
            if (selectedMode() !== "new") return;
            defaultLocalUrl = current.defaultLocalUrl;
            await save("new", defaultLocalUrl);
          }
          return;
        }
        await waitForStackChange();
      }
    } catch {
      // Only report a follow the person still sees; leaving "new" already handed the form back.
      if (selectedMode() === "new") {
        setStatus("stackFollowFailed", undefined, "error");
        setBusy(false);
      }
    } finally {
      stackPolling = false;
    }
  }

  async function runStack() {
    const generation = ++requestGeneration;
    clearStatus();
    setBusy(true);
    try {
      // A queued start still reads `idle`; leave the panel as it is and let the follow render it.
      const started = await bridge.stack.start();
      // The person left "This computer" mid-start; the next pushed state re-attaches the follow.
      if (generation !== requestGeneration) return;
      if (started !== null && started.phase !== "idle") renderStack(started);
    } catch {
      if (generation === requestGeneration) {
        setStatus("stackStartFailed", undefined, "error");
        setBusy(false);
      }
      return;
    }
    await followStack();
  }

  async function check() {
    const value = serverUrl.value;
    if (value.trim() === "") {
      setStatus("enterAddress", undefined, "error");
      return null;
    }

    const generation = ++requestGeneration;
    activeCheck = generation;
    setBusy(true);
    setStatus("checking");
    try {
      const result = await bridge.test(value);
      // The address or the mode changed under the test, so its result speaks for neither.
      if (generation !== requestGeneration) return result;
      if (result.ok) {
        serverUrl.value = result.url;
        setStatus("answered", { url: result.url }, "ok");
      } else {
        setStatusText(result.error ?? t("unreachable"), "error");
      }
      return result;
    } catch {
      if (generation === requestGeneration) {
        setStatus("checkFailed", undefined, "error");
      }
      return null;
    } finally {
      if (activeCheck === generation) activeCheck = 0;
      // Only the run that still owns the controls may unlock them.
      if (generation === requestGeneration) setBusy(false);
    }
  }

  form.addEventListener("change", (event) => {
    if (event.target instanceof HTMLInputElement && event.target.name === "mode") {
      requestGeneration++;
      // The interrupted check completes stale and stays silent, so retire its lock here.
      const interruptedCheck = activeCheck !== 0;
      activeCheck = 0;
      syncPanels();
      // Unlock immediately when nothing on this mode owns the controls; followStack exits on its
      // next poll.
      if (selectedMode() !== "new" || interruptedCheck) setBusy(false);
    }
  });

  serverUrl.addEventListener("input", () => {
    // An edited address invalidates the pending check; retire it and hand the controls back so
    // its late result changes nothing.
    if (activeCheck === 0) return;
    requestGeneration++;
    activeCheck = 0;
    clearStatus();
    setBusy(false);
  });

  checkButton.addEventListener("click", () => {
    void check();
  });

  stackDetails.addEventListener("click", () => {
    detailsOpen = !detailsOpen;
    detailsOpenedByFailure = false;
    if (lastStack !== null) renderDetails(lastStack);
  });

  stackDockerHelp.addEventListener("click", (event) => {
    const link = event.target instanceof HTMLElement ? event.target.dataset.link : undefined;
    if (link) void bridge.openLink(link);
  });

  for (const locale of i18n.LOCALES) {
    const option = document.createElement("option");
    option.value = locale;
    option.textContent = i18n.LABELS[locale];
    localeSelect.append(option);
  }

  localeSelect.addEventListener("change", () => {
    writeStored(LOCALE_STORAGE_KEY, localeSelect.value);
    applyLocale(localeSelect.value);
  });

  themeToggle.addEventListener("click", () => {
    applyTheme(currentTheme === "light" ? "dark" : "light", true);
  });

  quitButton.addEventListener("click", () => {
    if (bridge === undefined) {
      window.close();
      return;
    }
    void bridge.quit();
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const mode = selectedMode();
    if (mode === "new") void runStack();
    // Cloud is an existing server at a fixed address.
    else void save("existing", mode === "cloud" ? cloudUrl : serverUrl.value);
  });

  /** Pushed state keeps progress moving even when the OS throttles this window's timers. */
  function watchStack() {
    bridge.stack.onChange(() => {
      wakePoll?.();
      // A follow that ended on an error restarts here instead of leaving the panel frozen;
      // hold the controls until it has rendered the state it is restarting on.
      if (!stackPolling && selectedMode() === "new") {
        setBusy(true);
        void followStack();
      }
    });
  }

  // Paint the saved or system choice before the first await; init then fills in state.
  applyLocale(currentLocale);

  async function init() {
    if (bridge === undefined) {
      setStatus("bridgeUnavailable", undefined, "error");
      setBusy(true);
      return;
    }

    watchStack();
    // Continue needs the Cloud address and any saved choice before it can submit.
    setBusy(true);
    try {
      const state = await bridge.state();
      if (state === null) throw new Error("Setup is not active");
      defaultLocalUrl = state.defaultLocalUrl;
      cloudUrl = state.cloudUrl;
      if (state.saved !== null) {
        const savedCloud = state.saved.mode === "existing" && state.saved.serverUrl === cloudUrl;
        const mode = savedCloud ? "cloud" : state.saved.mode;
        const modeInput = document.querySelector(`input[name="mode"][value="${mode}"]`);
        if (modeInput !== null) modeInput.checked = true;
        if (mode === "existing") serverUrl.value = state.saved.serverUrl;
      }
      // A relaunch with the stack down starts it before this window opens; show that
      // attempt instead of the saved mode, and follow it while it is still running.
      const stack = await bridge.stack.state();
      const attached = stack !== null && stack.phase !== "idle";
      if (attached) document.getElementById("mode-new").checked = true;
      syncPanels();
      setBusy(false);
      if (state.error) setStatusText(state.error, "error");
      if (attached) {
        renderStack(stack);
        if (!TERMINAL_PHASES.has(stack.phase)) void followStack();
      } else if (selectedMode() === "existing") {
        serverUrl.focus();
      } else {
        continueButton.focus();
      }
    } catch {
      setStatus("setupFailed", undefined, "error");
      setBusy(true);
    }
  }

  void init();
})();
