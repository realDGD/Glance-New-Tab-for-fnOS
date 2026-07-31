import {
  canAcceptTargetResult,
  canNavigateToRecoveryTarget,
  chooseInitialNavigation,
  combineDockerProbeSignals,
  DEFAULT_SETTINGS,
  inferFnOsBootstrapUrl,
  isDockerFnConnectService,
  isSuccessfulHealthResponse,
  isFnOsUrl,
  MAX_DOCKER_RECOVERY_ATTEMPTS,
  sanitizeSettings,
  shouldStopDockerRecovery,
  validateRecoverySettings
} from "./shared.js";

const PENDING_PREFIX = "pending-recovery:";
const SESSION_WARM_KEY = "browser-session-warmed";
const MAX_NATIVE_AUTOMATIC_ATTEMPTS = 5;
const DOCKER_FRAME_READY_TTL_MS = 5000;
let sessionClaimQueue = Promise.resolve();
const tabTransitionQueues = new Map();

async function loadSettings() {
  const saved = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  try {
    return sanitizeSettings(saved);
  } catch (error) {
    console.warn("Glance New Tab for fnOS 设置无效，已回退到默认值：", error);
    return { ...DEFAULT_SETTINGS };
  }
}

async function initializeSettings(openSetupWhenNeeded = false) {
  const existing = await chrome.storage.sync.get(null);
  if (Object.keys(existing).length === 0) {
    await chrome.storage.sync.set(DEFAULT_SETTINGS);
    if (openSetupWhenNeeded) {
      await chrome.runtime.openOptionsPage();
    }
    return;
  }

  // 0.1.x 曾包含开发机地址；没有 setupCompleted 标记说明仍是旧默认值。
  if (!Object.hasOwn(existing, "setupCompleted")) {
    await chrome.storage.sync.set({
      ...existing,
      setupCompleted: false,
      targetUrl: "",
      rootUrl: "",
      healthUrl: "",
      themeMode: "auto"
    });
    if (openSetupWhenNeeded) {
      await chrome.runtime.openOptionsPage();
    }
    return;
  }

  if (openSetupWhenNeeded && !existing.setupCompleted) {
    await chrome.runtime.openOptionsPage();
  }
}

function pendingKey(tabId) {
  return `${PENDING_PREFIX}${tabId}`;
}

async function getPending(tabId) {
  const key = pendingKey(tabId);
  const result = await chrome.storage.session.get(key);
  return result[key] ?? null;
}

async function setPending(tabId, pending) {
  await chrome.storage.session.set({ [pendingKey(tabId)]: pending });
}

async function removePending(tabId) {
  await chrome.storage.session.remove(pendingKey(tabId));
}

function serializeSessionClaim(task) {
  const result = sessionClaimQueue.then(task, task);
  sessionClaimQueue = result.catch(() => undefined);
  return result;
}

function serializeTabTransition(tabId, task) {
  const previous = tabTransitionQueues.get(tabId) ?? Promise.resolve();
  const current = previous.then(task, task);
  const queued = current.catch(() => undefined);
  tabTransitionQueues.set(tabId, queued);
  void current.finally(() => {
    if (tabTransitionQueues.get(tabId) === queued) {
      tabTransitionQueues.delete(tabId);
    }
  }).catch(() => undefined);
  return current;
}

async function markSessionAndCheckIfWarm() {
  return serializeSessionClaim(async () => {
    const stored = await chrome.storage.session.get(SESSION_WARM_KEY);
    const sessionWarmed = Boolean(stored[SESSION_WARM_KEY]);
    if (!sessionWarmed) {
      await chrome.storage.session.set({
        [SESSION_WARM_KEY]: {
          warmedAt: Date.now()
        }
      });
    }
    return sessionWarmed;
  });
}

async function probeAuth(checkUrl) {
  if (!isFnOsUrl(checkUrl)) {
    return { ok: false, reason: "invalid-check-url" };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetch(checkUrl, {
      cache: "no-store",
      credentials: "include",
      redirect: "follow",
      signal: controller.signal
    });
    const body = await response.text();
    return {
      ok: isSuccessfulHealthResponse(response.status, body),
      status: response.status
    };
  } catch (error) {
    return {
      ok: false,
      reason: error?.name === "AbortError" ? "timeout" : "network"
    };
  } finally {
    clearTimeout(timeout);
  }
}

function recoveryKind(settings) {
  return isDockerFnConnectService(
    settings.targetUrl,
    settings.rootUrl,
    settings.healthUrl
  )
    ? "docker"
    : "native";
}

function isDockerPending(pending) {
  return pending?.recoveryKind === "docker"
    || isDockerFnConnectService(
      pending?.targetUrl,
      pending?.rootUrl,
      pending?.checkUrl
    );
}

async function beginRecovery(tabId, settings, source = "new-tab") {
  validateRecoverySettings(settings);
  const now = Date.now();
  const kind = recoveryKind(settings);
  const dockerRecovery = kind === "docker";
  const pending = {
    targetUrl: settings.targetUrl,
    rootUrl: settings.rootUrl,
    checkUrl: settings.healthUrl,
    bootstrapUrl: dockerRecovery
      ? inferFnOsBootstrapUrl(settings.targetUrl)
      : "",
    startedAt: now,
    bootstrapEnteredAt: dockerRecovery ? now : null,
    bootstrapCompletedAt: null,
    rootEnteredAt: dockerRecovery ? null : now,
    phase: dockerRecovery ? "bootstrap" : "root",
    recoveryKind: kind,
    targetAttempts: 0,
    postRecoveryAttempts: 0,
    dockerRecoveryAttempts: 0,
    dockerFrameReadyAt: null,
    nextRetryAt: now,
    source
  };
  await setPending(tabId, pending);
  await chrome.tabs.update(tabId, {
    url: dockerRecovery ? pending.bootstrapUrl : pending.rootUrl
  });
}

async function beginTargetFirst(tabId, settings, source = "new-tab") {
  validateRecoverySettings(settings);
  const now = Date.now();
  const kind = recoveryKind(settings);
  const dockerRecovery = kind === "docker";
  const pending = {
    targetUrl: settings.targetUrl,
    rootUrl: settings.rootUrl,
    checkUrl: settings.healthUrl,
    bootstrapUrl: dockerRecovery
      ? inferFnOsBootstrapUrl(settings.targetUrl)
      : "",
    startedAt: now,
    bootstrapEnteredAt: null,
    bootstrapCompletedAt: null,
    rootEnteredAt: null,
    phase: "target",
    recoveryKind: kind,
    targetAttempts: 1,
    postRecoveryAttempts: 0,
    dockerRecoveryAttempts: 0,
    dockerFrameReadyAt: null,
    nextRetryAt: now,
    lastAttemptReason: "target-first",
    lastAttemptAt: now,
    source
  };
  await setPending(tabId, pending);
  await chrome.tabs.update(tabId, { url: pending.targetUrl });
}

async function openConfiguredPage(tabId, source = "new-tab") {
  const settings = await loadSettings();
  if (!settings.setupCompleted || !settings.targetUrl) {
    return { action: "configure", settings };
  }
  if (!settings.enabled) {
    return { action: "stay", settings };
  }

  const usesFnOsRecovery = settings.fnosRecoveryEnabled && isFnOsUrl(settings.targetUrl);
  const sessionWarmed = usesFnOsRecovery
    ? await markSessionAndCheckIfWarm()
    : true;
  const initialNavigation = chooseInitialNavigation(settings, sessionWarmed);
  if (initialNavigation === "root-first") {
    await beginRecovery(tabId, settings, `${source}-cold-start`);
    return { action: "recovering-startup" };
  }
  if (initialNavigation === "target-first") {
    await beginTargetFirst(tabId, settings, `${source}-target-first`);
    return { action: "checking-target" };
  }

  await removePending(tabId);
  await chrome.tabs.update(tabId, { url: settings.targetUrl });
  return { action: "navigating" };
}

async function navigateToTarget(tabId, pending, reason) {
  if (pending.phase === "manual") {
    return { action: "manual" };
  }
  if (!canNavigateToRecoveryTarget(pending.phase)) {
    return { action: "ignored" };
  }
  if (Date.now() < Number(pending.nextRetryAt ?? 0)) {
    return {
      action: "waiting",
      waitMs: Number(pending.nextRetryAt) - Date.now()
    };
  }

  const dockerRecovery = isDockerPending(pending);
  const postRecoveryAttempts = Number(pending.postRecoveryAttempts ?? 0);
  const dockerRecoveryAttempts = Number(
    pending.dockerRecoveryAttempts ?? pending.postRecoveryAttempts ?? 0
  );
  if (
    dockerRecovery
    && pending.phase !== "target"
    && dockerRecoveryAttempts >= MAX_DOCKER_RECOVERY_ATTEMPTS
  ) {
    await setPending(tabId, {
      ...pending,
      phase: "manual",
      lastError: "docker-visible-retry-limit"
    });
    return { action: "manual" };
  }

  const updated = {
    ...pending,
    phase: "target",
    targetAttempts: Number(pending.targetAttempts ?? 0) + 1,
    postRecoveryAttempts: pending.phase === "target"
      ? postRecoveryAttempts
      : postRecoveryAttempts + 1,
    dockerRecoveryAttempts: pending.phase === "target"
      ? dockerRecoveryAttempts
      : dockerRecoveryAttempts + 1,
    dockerFrameReadyAt: null,
    lastAttemptReason: reason,
    lastAttemptAt: Date.now()
  };
  await setPending(tabId, updated);
  await chrome.tabs.update(tabId, { url: updated.targetUrl });
  return { action: "navigating" };
}

async function handleAuthFailure(tabId, reason = "authentication-failed") {
  const pending = await getPending(tabId);
  if (!pending || !canAcceptTargetResult(pending.phase)) {
    return { action: "ignored" };
  }

  const attempts = Number(pending.targetAttempts ?? 0);
  const dockerRecovery = isDockerPending(pending);
  const dockerRecoveryAttempts = Number(
    pending.dockerRecoveryAttempts ?? pending.postRecoveryAttempts ?? 0
  );
  const manual = dockerRecovery
    ? shouldStopDockerRecovery(dockerRecoveryAttempts)
    : attempts >= MAX_NATIVE_AUTOMATIC_ATTEMPTS;
  const backoffMs = dockerRecovery
    ? (manual ? 0 : 1200)
    : Math.min(30000, Math.max(2500, 1500 * (2 ** attempts)));
  const now = Date.now();
  const bootstrapUrl = dockerRecovery
    ? pending.bootstrapUrl || inferFnOsBootstrapUrl(pending.targetUrl)
    : "";
  const updated = {
    ...pending,
    bootstrapUrl,
    phase: manual ? "manual" : dockerRecovery ? "bootstrap" : "root",
    bootstrapEnteredAt: !manual && dockerRecovery ? now : null,
    bootstrapCompletedAt: null,
    rootEnteredAt: manual || !dockerRecovery ? now : null,
    nextRetryAt: now + backoffMs,
    dockerFrameReadyAt: null,
    lastError: reason
  };
  await setPending(tabId, updated);
  await chrome.tabs.update(tabId, {
    url: manual || !dockerRecovery ? updated.rootUrl : updated.bootstrapUrl
  });
  return {
    action: manual
      ? "manual"
      : dockerRecovery
        ? "returning-through-bootstrap"
        : "returning-to-root"
  };
}

function isConfiguredRootOrigin(pending, value) {
  try {
    return new URL(pending.rootUrl).origin === new URL(value).origin;
  } catch {
    return false;
  }
}

function isConfiguredTargetPage(pending, value) {
  try {
    const expected = new URL(pending.targetUrl);
    const actual = new URL(value);
    const normalizePath = (path) => path.length > 1 ? path.replace(/\/+$/, "") : path;
    return expected.origin === actual.origin
      && normalizePath(expected.pathname) === normalizePath(actual.pathname);
  } catch {
    return false;
  }
}

async function completeDockerBootstrap(tabId, destinationUrl = "", allowExternal = false) {
  const pending = await getPending(tabId);
  if (!pending || !isDockerPending(pending) || pending.phase !== "bootstrap") {
    return { action: "ignored", pending };
  }
  if (
    !allowExternal
    && (!destinationUrl || !isConfiguredRootOrigin(pending, destinationUrl))
  ) {
    return { action: "ignored", pending };
  }

  const now = Date.now();
  const updated = {
    ...pending,
    phase: "root",
    bootstrapCompletedAt: now,
    rootEnteredAt: now,
    nextRetryAt: now,
    dockerFrameReadyAt: null
  };
  await setPending(tabId, updated);
  return { action: "bootstrap-complete", pending: updated };
}

function isBootstrapTransitUrl(pending, value) {
  try {
    const actual = new URL(value);
    const expected = new URL(pending.bootstrapUrl);
    const actualPath = actual.pathname.length > 1
      ? actual.pathname.replace(/\/+$/, "")
      : actual.pathname;
    const expectedPath = expected.pathname.length > 1
      ? expected.pathname.replace(/\/+$/, "")
      : expected.pathname;
    return (
      actual.origin === expected.origin && actualPath === expectedPath
    ) || actual.hostname === "check.fnos.net" || actual.hostname === "ctest.fnos.net";
  } catch {
    return false;
  }
}

async function handleCompletedBootstrapNavigation(tabId, tabUrl) {
  return serializeTabTransition(tabId, async () => {
    const pending = await getPending(tabId);
    if (
      !pending
      || !isDockerPending(pending)
      || pending.phase !== "bootstrap"
      || isBootstrapTransitUrl(pending, tabUrl)
      || isConfiguredTargetPage(pending, tabUrl)
    ) {
      return;
    }

    if (isConfiguredRootOrigin(pending, tabUrl)) {
      return;
    }

    let actual;
    try {
      actual = new URL(tabUrl);
    } catch {
      return;
    }
    if (!new Set(["http:", "https:"]).has(actual.protocol)) {
      return;
    }
    if (/^\/login(?:\/|$)/i.test(actual.pathname)) {
      return;
    }

    const completion = await completeDockerBootstrap(tabId, tabUrl, true);
    if (completion.action !== "bootstrap-complete") {
      return;
    }
    await navigateToTarget(
      tabId,
      completion.pending,
      "official-bootstrap-external-route"
    );
  });
}

async function handleMessage(message, sender) {
  const type = message?.type;
  const senderTabId = sender.tab?.id;

  if (type === "OPEN_NEW_TAB") {
    const tabId = senderTabId ?? Number(message.tabId);
    if (!Number.isInteger(tabId)) {
      throw new Error("无法确定当前标签页");
    }
    return openConfiguredPage(tabId);
  }

  if (type === "TEST_RECOVERY") {
    const settings = await loadSettings();
    validateRecoverySettings(settings);
    const tab = await chrome.tabs.create({ url: "about:blank", active: true });
    await beginRecovery(tab.id, settings, "settings-test");
    return { action: "recovering", tabId: tab.id };
  }

  if (type === "GET_SETTINGS") {
    return { settings: await loadSettings() };
  }

  if (!Number.isInteger(senderTabId)) {
    return { action: "ignored" };
  }

  if (type === "START_RECOVERY_CURRENT") {
    return serializeTabTransition(senderTabId, async () => {
      const settings = await loadSettings();
      validateRecoverySettings(settings);
      await beginRecovery(
        senderTabId,
        settings,
        `${message.reason ?? "authentication-failed"}-page`
      );
      return { action: "recovering" };
    });
  }

  if (type === "CONTENT_HELLO") {
    return {
      pending: await getPending(senderTabId),
      settings: await loadSettings()
    };
  }

  if (type === "BOOTSTRAP_COMPLETE") {
    return serializeTabTransition(
      senderTabId,
      () => completeDockerBootstrap(senderTabId, sender.url)
    );
  }

  if (type === "PROBE_AUTH") {
    const pending = await getPending(senderTabId);
    const frameReady = Boolean(
      pending
      && isDockerPending(pending)
      && Date.now() - Number(pending.dockerFrameReadyAt ?? 0)
        <= DOCKER_FRAME_READY_TTL_MS
    );
    const settings = pending ? null : await loadSettings();
    const checkUrl = pending?.checkUrl ?? settings?.healthUrl;
    if (!checkUrl) {
      return { ok: false, reason: "not-configured" };
    }

    const backgroundResult = await probeAuth(checkUrl);
    if (!pending || !isDockerPending(pending)) {
      return backgroundResult;
    }

    const signals = combineDockerProbeSignals(backgroundResult.ok, frameReady);
    return {
      ...backgroundResult,
      ...signals,
      via: signals.strongReady
        ? "dual"
        : signals.frameReady
          ? "frame"
          : "background"
    };
  }

  if (type === "AUTH_READY") {
    return serializeTabTransition(senderTabId, async () => {
      const pending = await getPending(senderTabId);
      if (!pending || !canNavigateToRecoveryTarget(pending.phase)) {
        return { action: "ignored" };
      }
      return navigateToTarget(
        senderTabId,
        pending,
        message.via === "page" ? "health" : "health-background"
      );
    });
  }

  if (type === "DOCKER_FRAME_PROBE_RESULT") {
    return serializeTabTransition(senderTabId, async () => {
      const pending = await getPending(senderTabId);
      if (
        !pending
        || !isDockerPending(pending)
        || pending.phase !== "root"
        || sender.frameId === 0
        || typeof sender.url !== "string"
      ) {
        return { action: "ignored" };
      }

      let expected;
      let actual;
      try {
        expected = new URL(pending.checkUrl);
        actual = new URL(sender.url);
      } catch {
        return { action: "ignored" };
      }
      if (
        expected.origin !== actual.origin
        || expected.pathname.replace(/\/+$/, "") !== actual.pathname.replace(/\/+$/, "")
      ) {
        return { action: "ignored" };
      }

      if (message.result === "ready") {
        await setPending(senderTabId, {
          ...pending,
          dockerFrameReadyAt: Date.now()
        });
        return { action: "ready" };
      }
      return { action: "waiting" };
    });
  }

  if (type === "TRY_TARGET") {
    return serializeTabTransition(senderTabId, async () => {
      const pending = await getPending(senderTabId);
      if (!pending || !canNavigateToRecoveryTarget(pending.phase)) {
        return { action: "ignored" };
      }
      return navigateToTarget(senderTabId, pending, "root-grace-period");
    });
  }

  if (type === "AUTH_INVALID") {
    return serializeTabTransition(
      senderTabId,
      () => handleAuthFailure(senderTabId, message.reason)
    );
  }

  if (type === "TARGET_READY") {
    return serializeTabTransition(senderTabId, async () => {
      const pending = await getPending(senderTabId);
      if (
        !pending
        || !canAcceptTargetResult(pending.phase)
        || typeof sender.url !== "string"
        || !isConfiguredTargetPage(pending, sender.url)
      ) {
        return { action: "ignored" };
      }
      await removePending(senderTabId);
      return { action: "complete" };
    });
  }

  if (type === "MANUAL_RETRY") {
    return serializeTabTransition(senderTabId, async () => {
      const pending = await getPending(senderTabId);
      if (!pending) {
        return { action: "ignored" };
      }
      const dockerRecovery = isDockerPending(pending);
      const now = Date.now();
      const updated = {
        ...pending,
        bootstrapUrl: dockerRecovery
          ? pending.bootstrapUrl || inferFnOsBootstrapUrl(pending.targetUrl)
          : "",
        phase: dockerRecovery ? "bootstrap" : "root",
        targetAttempts: 0,
        postRecoveryAttempts: 0,
        dockerRecoveryAttempts: 0,
        dockerFrameReadyAt: null,
        bootstrapEnteredAt: dockerRecovery ? now : null,
        bootstrapCompletedAt: null,
        rootEnteredAt: dockerRecovery ? null : now,
        nextRetryAt: now
      };
      await setPending(senderTabId, updated);
      if (dockerRecovery) {
        await chrome.tabs.update(senderTabId, { url: updated.bootstrapUrl });
        return { action: "navigating" };
      }
      return { action: "retrying" };
    });
  }

  return { action: "ignored" };
}

chrome.runtime.onInstalled.addListener(() => {
  void initializeSettings(true);
});

chrome.runtime.onStartup.addListener(() => {
  void initializeSettings(false);
});

chrome.action.onClicked.addListener(() => {
  void chrome.runtime.openOptionsPage();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void removePending(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && typeof tab.url === "string") {
    void handleCompletedBootstrapNavigation(tabId, tab.url);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch((error) => {
      console.error("Glance New Tab for fnOS 消息处理失败：", error);
      sendResponse({ error: error?.message ?? String(error) });
    });
  return true;
});
