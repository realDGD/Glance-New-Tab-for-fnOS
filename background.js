import {
  canAcceptTargetResult,
  canNavigateToRecoveryTarget,
  chooseInitialNavigation,
  combineDockerProbeSignals,
  DEFAULT_SETTINGS,
  hostPermissionPattern,
  inferLanHealthUrl,
  inferLanNativeTargetUrl,
  inferFnOsBootstrapUrl,
  isGlanceDocument,
  isLanGlanceCandidate,
  isDockerFnConnectService,
  isSuccessfulHealthResponse,
  isFnOsUrl,
  isPrivateNetworkUrl,
  MAX_DOCKER_RECOVERY_ATTEMPTS,
  normalizeNavigableUrl,
  sanitizeSettings,
  shouldStopDockerRecovery,
  validateRecoverySettings
} from "./shared.js";

const PENDING_PREFIX = "pending-recovery:";
const LAN_DISCOVERY_PREFIX = "lan-discovery:";
const LAN_UNREACHABLE_PREFIX = "lan-unreachable:";
const LAN_ROUTES_KEY = "device-lan-routes";
const SESSION_WARM_KEY = "browser-session-warmed";
const MAX_NATIVE_AUTOMATIC_ATTEMPTS = 5;
const DOCKER_FRAME_READY_TTL_MS = 5000;
const LAN_DISCOVERY_TIMEOUT_MS = 2 * 60 * 1000;
const LAN_PROBE_TIMEOUT_MS = 1800;
let sessionClaimQueue = Promise.resolve();
const tabTransitionQueues = new Map();

function routeKey(targetUrl) {
  return normalizeNavigableUrl(targetUrl);
}

async function loadLanRoutes() {
  const stored = await chrome.storage.local.get(LAN_ROUTES_KEY);
  const routes = stored[LAN_ROUTES_KEY];
  return routes && typeof routes === "object" ? routes : {};
}

async function getLanRoute(targetUrl) {
  if (!targetUrl) {
    return null;
  }
  const routes = await loadLanRoutes();
  return routes[routeKey(targetUrl)] ?? null;
}

async function saveLanRoute(remoteTargetUrl, route) {
  const routes = await loadLanRoutes();
  routes[routeKey(remoteTargetUrl)] = {
    ...route,
    remoteTargetUrl: routeKey(remoteTargetUrl),
    learnedAt: Date.now()
  };
  await chrome.storage.local.set({ [LAN_ROUTES_KEY]: routes });
  await chrome.storage.session.remove(lanUnreachableKey(remoteTargetUrl));
  return routes[routeKey(remoteTargetUrl)];
}

async function removeLanRoute(remoteTargetUrl) {
  const routes = await loadLanRoutes();
  delete routes[routeKey(remoteTargetUrl)];
  await chrome.storage.local.set({ [LAN_ROUTES_KEY]: routes });
}

function discoveryKey(ownerTabId) {
  return `${LAN_DISCOVERY_PREFIX}${ownerTabId}`;
}

function lanUnreachableKey(targetUrl) {
  return `${LAN_UNREACHABLE_PREFIX}${routeKey(targetUrl)}`;
}

async function setLanDiscovery(ownerTabId, discovery) {
  await chrome.storage.session.set({ [discoveryKey(ownerTabId)]: discovery });
}

async function removeLanDiscovery(ownerTabId) {
  await chrome.storage.session.remove(discoveryKey(ownerTabId));
}

async function activeLanDiscoveries() {
  const stored = await chrome.storage.session.get(null);
  return Object.entries(stored)
    .filter(([key]) => key.startsWith(LAN_DISCOVERY_PREFIX))
    .map(([, value]) => value)
    .filter((value) => value && Number(value.expiresAt) > Date.now());
}

function scriptIdForPattern(pattern, suffix) {
  let hash = 2166136261;
  for (const character of pattern) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `fnos-lan-${(hash >>> 0).toString(16)}-${suffix}`;
}

async function ensureLanContentScripts(pattern) {
  const registrations = [
    {
      id: scriptIdForPattern(pattern, "page"),
      matches: [pattern],
      js: ["page-probe.js"],
      runAt: "document_start",
      world: "MAIN",
      persistAcrossSessions: true
    },
    {
      id: scriptIdForPattern(pattern, "content"),
      matches: [pattern],
      js: ["content.js"],
      runAt: "document_start",
      persistAcrossSessions: true
    }
  ];
  const existing = new Set(
    (await chrome.scripting.getRegisteredContentScripts()).map((entry) => entry.id)
  );
  const missing = registrations.filter((entry) => !existing.has(entry.id));
  if (missing.length) {
    await chrome.scripting.registerContentScripts(missing);
  }
}

async function restoreLanContentScripts() {
  const patterns = new Set();
  for (const route of Object.values(await loadLanRoutes())) {
    try {
      patterns.add(hostPermissionPattern(route.targetUrl));
    } catch {
      // Ignore stale device-only routes from older versions.
    }
  }
  for (const pattern of patterns) {
    if (await chrome.permissions.contains({ origins: [pattern] })) {
      await ensureLanContentScripts(pattern);
    }
  }
}

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

  // 旧版本可能没有 setupCompleted 标记，需要清除遗留默认地址。
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
  const remoteFnOsUrl = isFnOsUrl(checkUrl);
  const privateLanUrl = isPrivateNetworkUrl(checkUrl);
  if (!remoteFnOsUrl && !privateLanUrl) {
    return { ok: false, reason: "invalid-check-url" };
  }

  if (privateLanUrl) {
    const pattern = hostPermissionPattern(checkUrl);
    if (!await chrome.permissions.contains({ origins: [pattern] })) {
      return { ok: false, reason: "permission-required", pattern };
    }
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

async function fetchWithTimeout(url, timeoutMs = LAN_PROBE_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      cache: "no-store",
      credentials: "include",
      redirect: "follow",
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function probeLanHealth(route) {
  try {
    const pattern = hostPermissionPattern(route.targetUrl);
    if (!await chrome.permissions.contains({ origins: [pattern] })) {
      return { ok: false, reason: "permission-required", pattern };
    }
    const response = await fetchWithTimeout(route.healthUrl, 1000);
    const body = await response.text();
    return {
      ok: isSuccessfulHealthResponse(response.status, body),
      status: response.status,
      pattern
    };
  } catch (error) {
    return {
      ok: false,
      reason: error?.name === "AbortError" ? "timeout" : "network"
    };
  }
}

async function probeGlanceCandidate(candidateUrl) {
  try {
    const healthUrl = inferLanHealthUrl(candidateUrl, true);
    const healthResponse = await fetchWithTimeout(healthUrl);
    const healthBody = await healthResponse.text();
    if (!isSuccessfulHealthResponse(healthResponse.status, healthBody)) {
      return { ok: false, reason: "health-check", healthUrl };
    }

    const documentResponse = await fetchWithTimeout(candidateUrl);
    const html = await documentResponse.text();
    if (!documentResponse.ok || !isGlanceDocument(html)) {
      return { ok: false, reason: "not-glance", healthUrl };
    }
    return {
      ok: true,
      targetUrl: new URL(documentResponse.url || candidateUrl).href,
      healthUrl
    };
  } catch (error) {
    return {
      ok: false,
      reason: error?.name === "AbortError" ? "timeout" : "network"
    };
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

async function tryOpenLearnedLanRoute(tabId, settings) {
  if (!settings.fnosRecoveryEnabled || !isFnOsUrl(settings.targetUrl)) {
    return null;
  }
  const route = await getLanRoute(settings.targetUrl);
  if (!route?.targetUrl || !route?.healthUrl) {
    return null;
  }
  const unreachableKey = lanUnreachableKey(settings.targetUrl);
  const suppressed = await chrome.storage.session.get(unreachableKey);
  if (Number(suppressed[unreachableKey] ?? 0) > Date.now()) {
    return null;
  }
  const health = await probeLanHealth(route);
  if (!health.ok) {
    await chrome.storage.session.set({
      [unreachableKey]: Date.now() + 30_000
    });
    return null;
  }
  await chrome.storage.session.remove(unreachableKey);
  await ensureLanContentScripts(health.pattern);
  await removePending(tabId);
  await chrome.tabs.update(tabId, { url: route.targetUrl });
  return { action: "navigating-lan", route };
}

async function openConfiguredPage(tabId, source = "new-tab") {
  const settings = await loadSettings();
  if (!settings.setupCompleted || !settings.targetUrl) {
    return { action: "configure", settings };
  }
  if (!settings.enabled) {
    return { action: "stay", settings };
  }

  const lanNavigation = await tryOpenLearnedLanRoute(tabId, settings);
  if (lanNavigation) {
    return lanNavigation;
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

  if (pending.recoveryKind === "native-lan" && Number.isInteger(pending.helperTabId)) {
    const helperTabId = pending.helperTabId;
    await setPending(helperTabId, {
      ...pending,
      phase: "lan-root",
      helperTabId: null,
      lastError: reason,
      rootEnteredAt: Date.now()
    });
    await removePending(tabId);
    try {
      await chrome.tabs.update(helperTabId, { active: true, url: pending.rootUrl });
      await chrome.tabs.remove(tabId);
    } catch {
      // The helper may have been closed; a later new tab will restart recovery.
    }
    return { action: "recovering-lan" };
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

function lanSetupPageUrl() {
  const page = new URL(chrome.runtime.getURL("newtab.html"));
  page.searchParams.set("mode", "lan-setup");
  return page.href;
}

async function showLanSetup(tabId, pending, lanRootUrl, route = null) {
  const dockerRecovery = isDockerPending(pending);
  const targetUrl = route?.targetUrl || (
    dockerRecovery ? "" : inferLanNativeTargetUrl(pending.targetUrl, lanRootUrl)
  );
  const updated = {
    ...pending,
    phase: "lan-permission",
    lanRootUrl,
    lanTargetUrl: targetUrl,
    lanHealthUrl: targetUrl
      ? inferLanHealthUrl(targetUrl, dockerRecovery)
      : "",
    rootEnteredAt: Date.now(),
    nextRetryAt: Date.now()
  };
  await setPending(tabId, updated);
  await chrome.tabs.update(tabId, { url: lanSetupPageUrl() });
  return { action: "lan-permission", pending: updated };
}

async function beginDockerLanDiscovery(tabId, pending) {
  const updated = {
    ...pending,
    phase: "lan-discovery",
    rootUrl: pending.lanRootUrl,
    rootEnteredAt: Date.now(),
    nextRetryAt: Date.now()
  };
  await setPending(tabId, updated);
  await setLanDiscovery(tabId, {
    ownerTabId: tabId,
    remoteTargetUrl: pending.targetUrl,
    lanRootUrl: pending.lanRootUrl,
    startedAt: Date.now(),
    expiresAt: Date.now() + LAN_DISCOVERY_TIMEOUT_MS
  });
  await chrome.action.setBadgeBackgroundColor({ color: "#347af0" });
  await chrome.action.setBadgeText({ text: "识别" });
  await chrome.tabs.update(tabId, { url: pending.lanRootUrl });
  return { action: "lan-discovery" };
}

async function beginNativeLanRecovery(tabId, pending) {
  const route = await saveLanRoute(pending.targetUrl, {
    kind: "native",
    targetUrl: pending.lanTargetUrl,
    healthUrl: pending.lanHealthUrl,
    rootUrl: pending.lanRootUrl
  });
  const updated = {
    ...pending,
    phase: "lan-root",
    recoveryKind: "native-lan",
    remoteTargetUrl: pending.targetUrl,
    targetUrl: route.targetUrl,
    rootUrl: route.rootUrl,
    checkUrl: route.healthUrl,
    rootEnteredAt: Date.now(),
    nextRetryAt: Date.now()
  };
  await setPending(tabId, updated);
  await chrome.tabs.update(tabId, { url: route.rootUrl });
  return { action: "lan-root" };
}

async function startPermittedLanSetup(tabId) {
  const pending = await getPending(tabId);
  if (!pending || pending.phase !== "lan-permission" || !pending.lanRootUrl) {
    return { action: "ignored" };
  }
  const pattern = hostPermissionPattern(pending.lanRootUrl);
  if (!await chrome.permissions.contains({ origins: [pattern] })) {
    return { action: "permission-required", pattern };
  }
  await ensureLanContentScripts(pattern);
  if (isDockerPending(pending) && !pending.lanTargetUrl) {
    return beginDockerLanDiscovery(tabId, pending);
  }
  if (isDockerPending(pending)) {
    const route = await saveLanRoute(pending.targetUrl, {
      kind: "docker",
      targetUrl: pending.lanTargetUrl,
      healthUrl: pending.lanHealthUrl,
      rootUrl: pending.lanRootUrl
    });
    if ((await probeLanHealth(route)).ok) {
      await removePending(tabId);
      await chrome.tabs.update(tabId, { url: route.targetUrl });
      return { action: "navigating-lan" };
    }
    return beginDockerLanDiscovery(tabId, pending);
  }
  return beginNativeLanRecovery(tabId, pending);
}

async function openNativeLanTarget(helperTabId, pending) {
  if (!pending || pending.phase !== "lan-root") {
    return { action: "ignored" };
  }
  const helperPending = { ...pending, phase: "lan-helper" };
  await setPending(helperTabId, helperPending);
  const helperTab = await chrome.tabs.get(helperTabId);
  const targetTab = await chrome.tabs.create({
    url: "about:blank",
    active: true,
    openerTabId: helperTabId,
    windowId: helperTab.windowId
  });
  await setPending(targetTab.id, {
    ...pending,
    phase: "target",
    helperTabId,
    targetAttempts: Number(pending.targetAttempts ?? 0) + 1,
    lastAttemptReason: "lan-health-ready",
    lastAttemptAt: Date.now()
  });
  await chrome.tabs.update(targetTab.id, { url: pending.targetUrl });
  return { action: "navigating", tabId: targetTab.id };
}

async function handlePrivateLanNavigation(tabId, tabUrl) {
  if (!isPrivateNetworkUrl(tabUrl)) {
    return false;
  }
  const pending = await getPending(tabId);
  if (!pending) {
    return false;
  }
  if (
    pending.phase === "target"
    && pending.recoveryKind === "native-lan"
    && isConfiguredTargetPage(pending, tabUrl)
  ) {
    return false;
  }
  if (pending.phase === "lan-discovery" || pending.phase === "lan-helper") {
    return true;
  }
  if (pending.phase === "lan-root") {
    return true;
  }
  if (!["bootstrap", "root", "target", "lan-permission"].includes(pending.phase)) {
    return false;
  }

  const actualUrl = new URL(tabUrl);
  const lanRootUrl = new URL("/", actualUrl.origin).href;
  const pattern = hostPermissionPattern(lanRootUrl);
  const storedRoute = await getLanRoute(pending.targetUrl);
  const compatibleStoredRoute = storedRoute
    && new URL(storedRoute.targetUrl).hostname === new URL(lanRootUrl).hostname
      ? storedRoute
      : null;
  if (!await chrome.permissions.contains({ origins: [pattern] })) {
    await showLanSetup(tabId, pending, lanRootUrl, compatibleStoredRoute);
    return true;
  }

  await ensureLanContentScripts(pattern);
  const setupPending = {
    ...pending,
    lanRootUrl,
    lanTargetUrl: compatibleStoredRoute?.targetUrl || (
      isDockerPending(pending) ? "" : inferLanNativeTargetUrl(pending.targetUrl, lanRootUrl)
    ),
    lanHealthUrl: compatibleStoredRoute?.healthUrl || ""
  };
  if (!setupPending.lanHealthUrl && setupPending.lanTargetUrl) {
    setupPending.lanHealthUrl = inferLanHealthUrl(
      setupPending.lanTargetUrl,
      isDockerPending(pending)
    );
  }
  await setPending(tabId, setupPending);
  if (isDockerPending(pending)) {
    if (setupPending.lanTargetUrl) {
      const route = await saveLanRoute(pending.targetUrl, {
        kind: "docker",
        targetUrl: setupPending.lanTargetUrl,
        healthUrl: setupPending.lanHealthUrl,
        rootUrl: lanRootUrl
      });
      if ((await probeLanHealth(route)).ok) {
        await removePending(tabId);
        await chrome.tabs.update(tabId, { url: route.targetUrl });
        return true;
      }
    }
    await beginDockerLanDiscovery(tabId, setupPending);
  } else {
    await beginNativeLanRecovery(tabId, setupPending);
  }
  return true;
}

async function notifyLanDiscovery(ownerTabId, message) {
  try {
    await chrome.tabs.sendMessage(ownerTabId, {
      type: "LAN_DISCOVERY_STATUS",
      message
    });
  } catch {
    // The desktop may still be loading; the persistent badge remains visible.
  }
}

async function handleLanDiscoveryCandidate(tabId, tabUrl) {
  if (!isPrivateNetworkUrl(tabUrl)) {
    return false;
  }
  const discoveries = await activeLanDiscoveries();
  for (const discovery of discoveries) {
    if (!isLanGlanceCandidate(tabUrl, discovery.lanRootUrl)) {
      continue;
    }
    const result = await probeGlanceCandidate(tabUrl);
    if (!result.ok) {
      await notifyLanDiscovery(
        discovery.ownerTabId,
        "检测到的服务不是 Glance，请从 fnOS 桌面重新打开 Docker Glance。"
      );
      continue;
    }

    const route = await saveLanRoute(discovery.remoteTargetUrl, {
      kind: "docker",
      targetUrl: result.targetUrl,
      healthUrl: result.healthUrl,
      rootUrl: discovery.lanRootUrl
    });
    await removeLanDiscovery(discovery.ownerTabId);
    await removePending(discovery.ownerTabId);
    await removePending(tabId);
    await chrome.action.setBadgeText({ text: "" });
    if (tabId !== discovery.ownerTabId) {
      try {
        await chrome.tabs.remove(discovery.ownerTabId);
      } catch {
        // The user may have closed the desktop tab while Glance was opening.
      }
    } else {
      try {
        await chrome.tabs.sendMessage(tabId, { type: "LAN_DISCOVERY_COMPLETE" });
      } catch {
        // The verified Glance page may finish before its content script attaches.
      }
      if (route.targetUrl !== tabUrl) {
        await chrome.tabs.update(tabId, { url: route.targetUrl });
      }
    }
    return true;
  }
  return false;
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
    const settings = await loadSettings();
    return {
      settings,
      deviceRoute: await getLanRoute(settings.targetUrl)
    };
  }

  if (type === "SAVE_DEVICE_LAN_TARGET") {
    const settings = await loadSettings();
    if (!settings.targetUrl) {
      throw new Error("请先保存远程主页地址");
    }
    const localTarget = String(message.targetUrl ?? "").trim();
    if (!localTarget) {
      await removeLanRoute(settings.targetUrl);
      return { action: "removed" };
    }
    const targetUrl = normalizeNavigableUrl(localTarget);
    if (!isPrivateNetworkUrl(targetUrl)) {
      throw new Error("本机局域网主页必须使用私有网络地址");
    }
    const pattern = hostPermissionPattern(targetUrl);
    if (!await chrome.permissions.contains({ origins: [pattern] })) {
      return { action: "permission-required", pattern };
    }
    await ensureLanContentScripts(pattern);
    const docker = isDockerFnConnectService(
      settings.targetUrl,
      settings.rootUrl,
      settings.healthUrl
    );
    const existing = await getLanRoute(settings.targetUrl);
    const route = await saveLanRoute(settings.targetUrl, {
      kind: docker ? "docker" : "native",
      targetUrl,
      healthUrl: inferLanHealthUrl(targetUrl, docker),
      rootUrl: existing?.rootUrl ?? ""
    });
    return { action: "saved", route };
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
    const settings = await loadSettings();
    return {
      pending: await getPending(senderTabId),
      settings,
      deviceRoute: await getLanRoute(settings.targetUrl)
    };
  }

  if (type === "GET_LAN_SETUP") {
    const pending = await getPending(senderTabId);
    if (!pending || pending.phase !== "lan-permission") {
      return { action: "ignored" };
    }
    return {
      action: "permission-required",
      docker: isDockerPending(pending),
      lanRootUrl: pending.lanRootUrl,
      lanTargetUrl: pending.lanTargetUrl,
      originPattern: hostPermissionPattern(pending.lanRootUrl),
      hasTarget: Boolean(pending.lanTargetUrl)
    };
  }

  if (type === "START_LAN_SETUP") {
    return serializeTabTransition(
      senderTabId,
      () => startPermittedLanSetup(senderTabId)
    );
  }

  if (type === "LAN_NATIVE_READY") {
    return serializeTabTransition(senderTabId, async () => {
      const pending = await getPending(senderTabId);
      return openNativeLanTarget(senderTabId, pending);
    });
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
      const helperTabId = Number(pending.helperTabId);
      await removePending(senderTabId);
      if (Number.isInteger(helperTabId)) {
        await removePending(helperTabId);
        try {
          await chrome.tabs.remove(helperTabId);
        } catch {
          // The helper tab may already have been closed manually.
        }
      }
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
      if (pending.phase === "lan-discovery") {
        await removeLanDiscovery(senderTabId);
        await chrome.action.setBadgeText({ text: "" });
      }
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
  void initializeSettings(true).then(() => restoreLanContentScripts());
});

chrome.runtime.onStartup.addListener(() => {
  void initializeSettings(false).then(() => restoreLanContentScripts());
});

chrome.action.onClicked.addListener(() => {
  void chrome.runtime.openOptionsPage();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void removePending(tabId);
  void removeLanDiscovery(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && typeof tab.url === "string") {
    void (async () => {
      if (await handleLanDiscoveryCandidate(tabId, tab.url)) {
        return;
      }
      if (await handlePrivateLanNavigation(tabId, tab.url)) {
        return;
      }
      await handleCompletedBootstrapNavigation(tabId, tab.url);
    })();
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
