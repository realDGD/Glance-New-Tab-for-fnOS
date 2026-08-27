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
  isDockerPending,
  isSuccessfulHealthResponse,
  isFnOsUrl,
  isPrivateNetworkUrl,
  isBootstrapTransitUrl,
  isConfiguredRootOrigin,
  isConfiguredTargetPage,
  LanRouteStore,
  LanScriptManager,
  MAX_DOCKER_RECOVERY_ATTEMPTS,
  NavigationPersistence,
  normalizeNavigableUrl,
  OwnedTabController,
  parsePendingEnvelope,
  sanitizeSettings,
  shouldStopDockerRecovery,
  TabNavigationManager,
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
const tabNavigations = new TabNavigationManager();
const navPersistence = new NavigationPersistence();
const lanRouteStore = new LanRouteStore(tabNavigations);
const ownedTabController = new OwnedTabController(tabNavigations, navPersistence);
const lanScriptManager = new LanScriptManager();

void restoreLanContentScripts().catch((error) => {
  console.error("Failed to restore LAN content scripts on startup:", error);
});

function routeKey(targetUrl) {
  return normalizeNavigableUrl(targetUrl);
}

async function loadLanRoutes() {
  return lanRouteStore.loadRoutes();
}

async function getLanRoute(targetUrl) {
  return lanRouteStore.getRoute(targetUrl);
}

async function saveLanRoute(remoteTargetUrl, route, ownerTabId = null, navigationId = null) {
  return lanRouteStore.saveRoute(remoteTargetUrl, route, ownerTabId, navigationId);
}

async function removeLanRoute(remoteTargetUrl) {
  return lanRouteStore.removeRoute(remoteTargetUrl);
}

function lanUnreachableKey(targetUrl) {
  return `${LAN_UNREACHABLE_PREFIX}${routeKey(targetUrl)}`;
}

async function setLanDiscovery(ownerTabId, discovery, navigationId) {
  if (!navigationId || !tabNavigations.isActive(ownerTabId, navigationId)) {
    return false;
  }
  return navPersistence.setDiscovery(ownerTabId, navigationId, discovery);
}

async function removeLanDiscovery(ownerTabId, navigationId = null) {
  await navPersistence.removeDiscovery(ownerTabId, navigationId);
}

async function activeLanDiscoveries() {
  return navPersistence.listActiveDiscoveries();
}

async function ensureLanContentScripts(pattern) {
  return lanScriptManager.ensureContentScripts(pattern);
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
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

async function saveSettings(settings) {
  const sanitized = sanitizeSettings(settings);
  await chrome.storage.sync.set(sanitized);
  return sanitized;
}

async function ensureInstalledDefaults(openSetupWhenNeeded = false) {
  const current = await chrome.storage.sync.get(null);
  const existing = { ...DEFAULT_SETTINGS, ...current };
  const missing = {};
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    if (current[key] === undefined) {
      missing[key] = value;
    }
  }
  if (Object.keys(missing).length) {
    await chrome.storage.sync.set(missing);
  }

  if (existing.setupCompleted && existing.targetUrl) {
    return;
  }

  if (openSetupWhenNeeded && !existing.setupCompleted) {
    await chrome.runtime.openOptionsPage();
  }
}

async function getPending(tabId, identity = null) {
  const memory = tabNavigations.getPending(tabId, identity);
  if (memory) {
    return memory;
  }
  const envelope = await navPersistence.getPendingEnvelope(tabId, identity);
  return envelope?.pending ?? null;
}

async function setPending(tabId, pending, identity) {
  if (!identity || !tabNavigations.isActive(tabId, identity)) {
    return false;
  }

  const accepted = tabNavigations.setPending(tabId, pending, identity);
  if (!accepted) {
    return false;
  }

  const state = tabNavigations.get(tabId);
  const navigationId = state?.navigationId || (typeof identity === "string" ? identity : null);
  const envelope = {
    navigationId,
    generation: state?.generation ?? null,
    pending,
    expectedUrl: state?.expectedUrl ?? null,
    expectedUrls: state ? Array.from(state.expectedUrls) : [],
    savedAt: Date.now()
  };

  await navPersistence.setPendingEnvelope(tabId, navigationId, envelope);

  if (!tabNavigations.isActive(tabId, navigationId)) {
    await removePending(tabId, navigationId);
    return false;
  }

  return true;
}

async function removePending(tabId, identity = null) {
  tabNavigations.setPending(tabId, null, identity);
  await navPersistence.removePendingEnvelope(tabId, identity);
}

async function ensureNavigationContext(tabId) {
  if (!Number.isInteger(tabId)) {
    return null;
  }

  if (tabNavigations.isActive(tabId)) {
    return {
      active: true,
      navigationId: tabNavigations.getNavigationId(tabId),
      generation: tabNavigations.getGeneration(tabId),
      pending: tabNavigations.getPending(tabId),
      state: tabNavigations.get(tabId)
    };
  }

  const envelope = await navPersistence.getPendingEnvelope(tabId);
  if (!envelope || !envelope.pending || !envelope.navigationId) {
    return null;
  }

  let currentTab;
  try {
    currentTab = await chrome.tabs.get(tabId);
  } catch {
    await removePending(tabId, envelope.navigationId);
    await removeLanDiscovery(tabId, envelope.navigationId);
    return null;
  }

  if (typeof currentTab?.url !== "string") {
    await removePending(tabId, envelope.navigationId);
    await removeLanDiscovery(tabId, envelope.navigationId);
    return null;
  }

  const allowedUrls = new Set(envelope.expectedUrls || []);
  const isAllowed = isIgnoredNavigationUrl(currentTab.url)
    || matchesExpectedNavigation(allowedUrls, envelope.pending, currentTab.url, envelope.expectedUrl);

  if (!isAllowed) {
    await removePending(tabId, envelope.navigationId);
    await removeLanDiscovery(tabId, envelope.navigationId);
    return null;
  }

  const state = tabNavigations.rehydrate(tabId, {
    navigationId: envelope.navigationId,
    generation: envelope.generation,
    expectedUrl: envelope.expectedUrl,
    expectedUrls: allowedUrls,
    pending: envelope.pending
  });

  return {
    active: true,
    navigationId: envelope.navigationId,
    generation: state.generation,
    pending: envelope.pending,
    state
  };
}

function beginNavigation(tabId) {
  const context = tabNavigations.begin(tabId);
  return context.navigationId;
}

async function cancelNavigation(tabId, reason = "cancelled", targetIdentity = null) {
  tabNavigations.cancel(tabId, reason, targetIdentity);
  tabTransitionQueues.delete(tabId);
  await removePending(tabId, targetIdentity);
  await removeLanDiscovery(tabId, targetIdentity);
  try {
    await chrome.action.setBadgeText({ text: "" });
  } catch {
    // Ignore badge error
  }
}

async function navigateOwnedTab(tabId, identity, url, options = {}) {
  if (!tabNavigations.isActive(tabId, identity)) {
    return { ok: false, reason: "stale-generation" };
  }

  let targetUrl;
  try {
    targetUrl = normalizeNavigableUrl(url);
  } catch (error) {
    await cancelNavigation(tabId, "invalid-url", identity);
    return { ok: false, error };
  }

  tabNavigations.setExpectedUrl(tabId, identity, targetUrl);
  try {
    const updatedTab = await chrome.tabs.update(tabId, {
      url: targetUrl,
      ...options
    });
    return { ok: true, tab: updatedTab };
  } catch (error) {
    if (tabNavigations.isActive(tabId, identity)) {
      await cancelNavigation(tabId, "tab-update-failed", identity);
    }
    return { ok: false, error };
  }
}

async function removeOwnedTab(tabId, identity, reason = "close-owned-tab") {
  tabTransitionQueues.delete(tabId);
  return ownedTabController.removeOwnedTab(tabId, identity, reason);
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

async function probeAuth(checkUrl, { signal = null } = {}) {
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

  try {
    const response = await fetchWithTimeout(checkUrl, 1500, signal);
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
  }
}

async function fetchWithTimeout(url, timeoutMs = LAN_PROBE_TIMEOUT_MS, outerSignal = null) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let onOuterAbort;
  if (outerSignal) {
    if (outerSignal.aborted) {
      clearTimeout(timeout);
      throw new DOMException("Aborted", "AbortError");
    }
    onOuterAbort = () => controller.abort();
    outerSignal.addEventListener("abort", onOuterAbort, { once: true });
  }

  try {
    return await fetch(url, {
      cache: "no-store",
      credentials: "include",
      redirect: "follow",
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
    if (outerSignal && onOuterAbort) {
      outerSignal.removeEventListener("abort", onOuterAbort);
    }
  }
}

async function probeLanHealth(route, { signal = null } = {}) {
  try {
    const pattern = hostPermissionPattern(route.targetUrl);
    if (!await chrome.permissions.contains({ origins: [pattern] })) {
      return { ok: false, reason: "permission-required", pattern };
    }
    const response = await fetchWithTimeout(route.healthUrl, 1000, signal);
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

async function probeGlanceCandidate(candidateUrl, { signal = null } = {}) {
  try {
    const healthUrl = inferLanHealthUrl(candidateUrl, true);
    const healthResponse = await fetchWithTimeout(healthUrl, LAN_PROBE_TIMEOUT_MS, signal);
    const healthBody = await healthResponse.text();
    if (!isSuccessfulHealthResponse(healthResponse.status, healthBody)) {
      return { ok: false, reason: "health-check", healthUrl };
    }

    const documentResponse = await fetchWithTimeout(candidateUrl, LAN_PROBE_TIMEOUT_MS, signal);
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

async function beginRecovery(tabId, settings, source = "new-tab", explicitNavigationId = null) {
  validateRecoverySettings(settings);
  const navigationId = explicitNavigationId ?? (tabNavigations.getNavigationId(tabId) || beginNavigation(tabId));
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
  const targetUrl = dockerRecovery ? pending.bootstrapUrl : pending.rootUrl;
  tabNavigations.setExpectedUrl(tabId, navigationId, targetUrl);
  await setPending(tabId, pending, navigationId);
  await navigateOwnedTab(
    tabId,
    navigationId,
    targetUrl
  );
}

async function beginTargetFirst(tabId, settings, source = "new-tab", explicitNavigationId = null) {
  validateRecoverySettings(settings);
  const navigationId = explicitNavigationId ?? (tabNavigations.getNavigationId(tabId) || beginNavigation(tabId));
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
  tabNavigations.setExpectedUrl(tabId, navigationId, pending.targetUrl);
  await setPending(tabId, pending, navigationId);
  await navigateOwnedTab(tabId, navigationId, pending.targetUrl);
}

async function fallbackFromUnreachableLan(tabId, navigationId, settings) {
  if (!tabNavigations.isActive(tabId, navigationId)) {
    return;
  }

  const sessionWarmed = await markSessionAndCheckIfWarm();
  if (!tabNavigations.isActive(tabId, navigationId)) {
    return;
  }

  const initialNavigation = chooseInitialNavigation(settings, sessionWarmed);
  if (initialNavigation === "root-first") {
    await beginRecovery(tabId, settings, "lan-fallback-cold-start", navigationId);
    return;
  }
  if (initialNavigation === "target-first") {
    await beginTargetFirst(tabId, settings, "lan-fallback-target-first", navigationId);
    return;
  }

  await removePending(tabId, navigationId);
  await navigateOwnedTab(tabId, navigationId, settings.targetUrl);
}

async function runBackgroundLanHealthCheck({
  tabId,
  navigationId,
  route,
  settings,
  unreachableKey,
  signal
}) {
  let health;
  try {
    health = await probeLanHealth(route, { signal });
  } catch {
    health = { ok: false, reason: "network" };
  }

  if (!tabNavigations.isActive(tabId, navigationId)) {
    return;
  }

  if (health.ok) {
    await chrome.storage.session.remove(unreachableKey);
    return;
  }

  await chrome.storage.session.set({
    [unreachableKey]: Date.now() + 30_000
  });

  if (!tabNavigations.isActive(tabId, navigationId)) {
    return;
  }

  await fallbackFromUnreachableLan(tabId, navigationId, settings);
}

async function tryOpenLearnedLanRoute(tabId, settings, navigationId) {
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

  const pattern = hostPermissionPattern(route.targetUrl);
  if (!await chrome.permissions.contains({ origins: [pattern] })) {
    return null;
  }

  void ensureLanContentScripts(pattern).catch((error) => {
    console.error("Failed to ensure LAN content scripts in fast path:", error);
  });

  if (!tabNavigations.isActive(tabId, navigationId)) {
    return null;
  }

  await removePending(tabId, navigationId);
  const nav = await navigateOwnedTab(tabId, navigationId, route.targetUrl);
  if (!nav.ok) {
    return null;
  }

  const signal = tabNavigations.getAbortSignal(tabId, navigationId);
  void runBackgroundLanHealthCheck({
    tabId,
    navigationId,
    route,
    settings,
    unreachableKey,
    signal
  });

  return { action: "navigating-lan", route };
}

async function openConfiguredPage(tabId, source = "new-tab", explicitNavigationId = null) {
  const navigationId = explicitNavigationId ?? beginNavigation(tabId);
  const settings = await loadSettings();
  if (!settings.setupCompleted || !settings.targetUrl) {
    return { action: "configure", themeMode: settings.themeMode, settings };
  }
  if (!settings.enabled) {
    return { action: "stay", themeMode: settings.themeMode, settings };
  }

  const lanNavigation = await tryOpenLearnedLanRoute(tabId, settings, navigationId);
  if (lanNavigation) {
    return { ...lanNavigation, themeMode: settings.themeMode };
  }

  const usesFnOsRecovery = settings.fnosRecoveryEnabled && isFnOsUrl(settings.targetUrl);
  const sessionWarmed = usesFnOsRecovery
    ? await markSessionAndCheckIfWarm()
    : true;

  if (!tabNavigations.isActive(tabId, navigationId)) {
    return { action: "cancelled", themeMode: settings.themeMode };
  }

  const initialNavigation = chooseInitialNavigation(settings, sessionWarmed);
  if (initialNavigation === "root-first") {
    await beginRecovery(tabId, settings, `${source}-cold-start`, navigationId);
    return { action: "recovering-startup", themeMode: settings.themeMode };
  }
  if (initialNavigation === "target-first") {
    await beginTargetFirst(tabId, settings, `${source}-target-first`, navigationId);
    return { action: "checking-target", themeMode: settings.themeMode };
  }

  await removePending(tabId, navigationId);
  await navigateOwnedTab(tabId, navigationId, settings.targetUrl);
  return { action: "navigating", themeMode: settings.themeMode };
}

async function navigateToTarget(tabId, pending, reason, explicitNavigationId = null) {
  const navigationId = explicitNavigationId ?? (tabNavigations.getNavigationId(tabId) || beginNavigation(tabId));
  if (!tabNavigations.isActive(tabId, navigationId)) {
    return { action: "ignored" };
  }
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
  const isOptimistic = reason === "health-optimistic" || reason.includes("optimistic");
  const postRecoveryAttempts = Number(pending.postRecoveryAttempts ?? 0);
  const dockerRecoveryAttempts = Number(
    pending.dockerRecoveryAttempts ?? pending.postRecoveryAttempts ?? 0
  );
  if (
    dockerRecovery
    && pending.phase !== "target"
    && !isOptimistic
    && dockerRecoveryAttempts >= MAX_DOCKER_RECOVERY_ATTEMPTS
  ) {
    await setPending(tabId, {
      ...pending,
      phase: "manual",
      lastError: "docker-visible-retry-limit"
    }, navigationId);
    return { action: "manual" };
  }

  const updated = {
    ...pending,
    phase: "target",
    targetAttempts: Number(pending.targetAttempts ?? 0) + 1,
    targetAttemptMode: isOptimistic ? "optimistic" : "confirmed",
    optimisticTargetAttempted: isOptimistic ? true : Boolean(pending.optimisticTargetAttempted),
    postRecoveryAttempts: pending.phase === "target"
      ? postRecoveryAttempts
      : isOptimistic
        ? postRecoveryAttempts
        : postRecoveryAttempts + 1,
    dockerRecoveryAttempts: pending.phase === "target"
      ? dockerRecoveryAttempts
      : isOptimistic
        ? dockerRecoveryAttempts
        : dockerRecoveryAttempts + 1,
    dockerFrameReadyAt: null,
    lastAttemptReason: reason,
    lastAttemptAt: Date.now()
  };
  await setPending(tabId, updated, navigationId);
  await navigateOwnedTab(tabId, navigationId, updated.targetUrl);
  return { action: "navigating" };
}

async function handleAuthFailure(tabId, reason = "authentication-failed", explicitNavigationId = null) {
  const navigationId = explicitNavigationId ?? (tabNavigations.getNavigationId(tabId) || beginNavigation(tabId));
  if (!tabNavigations.isActive(tabId, navigationId)) {
    return { action: "ignored" };
  }
  const pending = await getPending(tabId, navigationId);
  if (!pending || !canAcceptTargetResult(pending.phase)) {
    return { action: "ignored" };
  }

  if (pending.recoveryKind === "native-lan" && Number.isInteger(pending.helperTabId)) {
    const helperTabId = pending.helperTabId;
    const helperNavId = tabNavigations.getNavigationId(helperTabId) || beginNavigation(helperTabId);
    await setPending(helperTabId, {
      ...pending,
      phase: "lan-root",
      helperTabId: null,
      lastError: reason,
      rootEnteredAt: Date.now()
    }, helperNavId);
    try {
      await navigateOwnedTab(helperTabId, helperNavId, pending.rootUrl, { active: true });
    } catch {
      // The helper may have been closed; a later new tab will restart recovery.
    }
    await removeOwnedTab(tabId, navigationId, "lan-target-auth-failed");
    return { action: "recovering-lan" };
  }

  const attempts = Number(pending.targetAttempts ?? 0);
  const dockerRecovery = isDockerPending(pending);
  const wasOptimistic = pending.targetAttemptMode === "optimistic"
    || pending.lastAttemptReason === "health-optimistic";
  const isFirstOptimisticFailure = dockerRecovery && wasOptimistic && !pending.strictRecovery;

  const dockerRecoveryAttempts = Number(
    pending.dockerRecoveryAttempts ?? pending.postRecoveryAttempts ?? 0
  );
  const manual = dockerRecovery
    ? (!isFirstOptimisticFailure && shouldStopDockerRecovery(dockerRecoveryAttempts))
    : attempts >= MAX_NATIVE_AUTOMATIC_ATTEMPTS;
  const backoffMs = dockerRecovery
    ? (manual ? 0 : isFirstOptimisticFailure ? 300 : 1200)
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
    strictRecovery: isFirstOptimisticFailure ? true : Boolean(pending.strictRecovery),
    optimisticTargetAttempted: wasOptimistic ? true : Boolean(pending.optimisticTargetAttempted),
    lastError: reason
  };
  await setPending(tabId, updated, navigationId);
  const nextUrl = manual || !dockerRecovery ? updated.rootUrl : updated.bootstrapUrl;
  await navigateOwnedTab(tabId, navigationId, nextUrl);
  return {
    action: manual
      ? "manual"
      : dockerRecovery
        ? "returning-through-bootstrap"
        : "returning-to-root"
  };
}

async function completeDockerBootstrap(tabId, destinationUrl = "", allowExternal = false, explicitNavigationId = null) {
  const navigationId = explicitNavigationId ?? tabNavigations.getNavigationId(tabId);
  const pending = await getPending(tabId, navigationId);
  if (!pending || !isDockerPending(pending) || pending.phase !== "bootstrap" || !navigationId) {
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
  await setPending(tabId, updated, navigationId);
  return { action: "bootstrap-complete", pending: updated };
}

function lanSetupPageUrl() {
  const page = new URL(chrome.runtime.getURL("newtab.html"));
  page.searchParams.set("mode", "lan-setup");
  return page.href;
}

async function showLanSetup(tabId, pending, lanRootUrl, route = null, explicitNavigationId = null) {
  const navigationId = explicitNavigationId ?? (tabNavigations.getNavigationId(tabId) || beginNavigation(tabId));
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
  tabNavigations.setExpectedUrl(tabId, navigationId, lanSetupPageUrl());
  await setPending(tabId, updated, navigationId);
  await navigateOwnedTab(tabId, navigationId, lanSetupPageUrl());
  return { action: "lan-permission", pending: updated };
}

async function beginDockerLanDiscovery(tabId, pending, explicitNavigationId = null) {
  const navigationId = explicitNavigationId ?? (tabNavigations.getNavigationId(tabId) || beginNavigation(tabId));
  const updated = {
    ...pending,
    phase: "lan-discovery",
    rootUrl: pending.lanRootUrl,
    rootEnteredAt: Date.now(),
    nextRetryAt: Date.now()
  };
  tabNavigations.setExpectedUrl(tabId, navigationId, pending.lanRootUrl);
  await setPending(tabId, updated, navigationId);
  const persisted = await setLanDiscovery(tabId, {
    ownerTabId: tabId,
    navigationId,
    remoteTargetUrl: pending.targetUrl,
    lanRootUrl: pending.lanRootUrl,
    startedAt: Date.now(),
    expiresAt: Date.now() + LAN_DISCOVERY_TIMEOUT_MS
  }, navigationId);
  if (!persisted || !tabNavigations.isActive(tabId, navigationId)) {
    return { action: "ignored" };
  }
  await chrome.action.setBadgeBackgroundColor({ color: "#347af0" });
  await chrome.action.setBadgeText({ text: "识别" });
  await navigateOwnedTab(tabId, navigationId, pending.lanRootUrl);
  return { action: "lan-discovery" };
}

async function beginNativeLanRecovery(tabId, pending, explicitNavigationId = null) {
  const navigationId = explicitNavigationId ?? (tabNavigations.getNavigationId(tabId) || beginNavigation(tabId));
  const route = await saveLanRoute(pending.targetUrl, {
    kind: "native",
    targetUrl: pending.lanTargetUrl,
    healthUrl: pending.lanHealthUrl,
    rootUrl: pending.lanRootUrl
  }, tabId, navigationId);
  if (!route || !tabNavigations.isActive(tabId, navigationId)) {
    return { action: "ignored" };
  }
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
  tabNavigations.setExpectedUrl(tabId, navigationId, route.rootUrl);
  await setPending(tabId, updated, navigationId);
  await navigateOwnedTab(tabId, navigationId, route.rootUrl);
  return { action: "lan-root" };
}

async function startPermittedLanSetup(tabId) {
  const navContext = await ensureNavigationContext(tabId);
  const navigationId = navContext?.navigationId ?? beginNavigation(tabId);
  const pending = navContext?.pending ?? await getPending(tabId, navigationId);
  if (!pending || pending.phase !== "lan-permission" || !pending.lanRootUrl) {
    return { action: "ignored" };
  }
  const pattern = hostPermissionPattern(pending.lanRootUrl);
  if (!await chrome.permissions.contains({ origins: [pattern] })) {
    return { action: "permission-required", pattern };
  }
  await ensureLanContentScripts(pattern);
  if (isDockerPending(pending) && !pending.lanTargetUrl) {
    return beginDockerLanDiscovery(tabId, pending, navigationId);
  }
  if (isDockerPending(pending)) {
    const route = await saveLanRoute(pending.targetUrl, {
      kind: "docker",
      targetUrl: pending.lanTargetUrl,
      healthUrl: pending.lanHealthUrl,
      rootUrl: pending.lanRootUrl
    }, tabId, navigationId);
    if (!route || !tabNavigations.isActive(tabId, navigationId)) {
      return { action: "ignored" };
    }
    const signal = tabNavigations.getAbortSignal(tabId, navigationId);
    if ((await probeLanHealth(route, { signal })).ok) {
      if (!tabNavigations.isActive(tabId, navigationId)) {
        return { action: "ignored" };
      }
      await removePending(tabId, navigationId);
      await navigateOwnedTab(tabId, navigationId, route.targetUrl);
      return { action: "navigating-lan" };
    }
    if (!tabNavigations.isActive(tabId, navigationId)) {
      return { action: "ignored" };
    }
    return beginDockerLanDiscovery(tabId, pending, navigationId);
  }
  return beginNativeLanRecovery(tabId, pending, navigationId);
}

async function openNativeLanTarget(helperTabId, pending, explicitNavigationId = null) {
  if (!pending || pending.phase !== "lan-root") {
    return { action: "ignored" };
  }
  const helperNavId = explicitNavigationId ?? (tabNavigations.getNavigationId(helperTabId) || beginNavigation(helperTabId));
  const helperPending = { ...pending, phase: "lan-helper" };
  await setPending(helperTabId, helperPending, helperNavId);
  const helperTab = await chrome.tabs.get(helperTabId);
  const targetTab = await chrome.tabs.create({
    url: "about:blank",
    active: true,
    openerTabId: helperTabId,
    windowId: helperTab.windowId
  });
  const targetNavId = beginNavigation(targetTab.id);
  const targetPending = {
    ...pending,
    phase: "target",
    helperTabId,
    targetAttempts: Number(pending.targetAttempts ?? 0) + 1,
    lastAttemptReason: "lan-health-ready",
    lastAttemptAt: Date.now()
  };
  tabNavigations.setExpectedUrl(targetTab.id, targetNavId, pending.targetUrl);
  await setPending(targetTab.id, targetPending, targetNavId);
  await navigateOwnedTab(targetTab.id, targetNavId, pending.targetUrl);
  return { action: "navigating", tabId: targetTab.id };
}

async function handlePrivateLanNavigation(tabId, tabUrl) {
  if (!isPrivateNetworkUrl(tabUrl)) {
    return false;
  }
  const navContext = await ensureNavigationContext(tabId);
  const pending = navContext?.pending ?? await getPending(tabId);
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
  const navigationId = navContext?.navigationId ?? (tabNavigations.getNavigationId(tabId) || beginNavigation(tabId));
  if (!await chrome.permissions.contains({ origins: [pattern] })) {
    await showLanSetup(tabId, pending, lanRootUrl, compatibleStoredRoute, navigationId);
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
  await setPending(tabId, setupPending, navigationId);
  if (isDockerPending(pending)) {
    if (setupPending.lanTargetUrl) {
      const route = await saveLanRoute(pending.targetUrl, {
        kind: "docker",
        targetUrl: setupPending.lanTargetUrl,
        healthUrl: setupPending.lanHealthUrl,
        rootUrl: lanRootUrl
      }, tabId, navigationId);
      if (route) {
        const signal = tabNavigations.getAbortSignal(tabId, navigationId);
        if ((await probeLanHealth(route, { signal })).ok) {
          if (tabNavigations.isActive(tabId, navigationId)) {
            await removePending(tabId, navigationId);
            await navigateOwnedTab(tabId, navigationId, route.targetUrl);
            return true;
          }
          return true;
        }
      }
    }
    if (tabNavigations.isActive(tabId, navigationId)) {
      await beginDockerLanDiscovery(tabId, setupPending, navigationId);
    }
  } else {
    if (tabNavigations.isActive(tabId, navigationId)) {
      await beginNativeLanRecovery(tabId, setupPending, navigationId);
    }
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
    const ownerTabId = discovery.ownerTabId;
    const navigationId = discovery.navigationId || discovery.generation;
    if (!ownerTabId || !navigationId) {
      continue;
    }
    if (!tabNavigations.isActive(ownerTabId, navigationId)) {
      const navContext = await ensureNavigationContext(ownerTabId);
      if (!navContext || navContext.navigationId !== navigationId || !tabNavigations.isActive(ownerTabId, navigationId)) {
        await removeLanDiscovery(ownerTabId, navigationId);
        continue;
      }
    }

    const signal = tabNavigations.getAbortSignal(ownerTabId, navigationId);
    const result = await probeGlanceCandidate(tabUrl, { signal });

    if (!tabNavigations.isActive(ownerTabId, navigationId)) {
      return false;
    }

    if (!result.ok) {
      await notifyLanDiscovery(
        ownerTabId,
        "检测到的服务不是 Glance，请从 fnOS 桌面重新打开 Docker Glance。"
      );
      continue;
    }

    const route = await saveLanRoute(discovery.remoteTargetUrl, {
      kind: "docker",
      targetUrl: result.targetUrl,
      healthUrl: result.healthUrl,
      rootUrl: discovery.lanRootUrl
    }, ownerTabId, navigationId);

    if (!route || !tabNavigations.isActive(ownerTabId, navigationId)) {
      return false;
    }

    await removeLanDiscovery(ownerTabId, navigationId);
    await removePending(ownerTabId, navigationId);
    await removePending(tabId);
    await chrome.action.setBadgeText({ text: "" });

    if (tabId !== ownerTabId) {
      await removeOwnedTab(ownerTabId, navigationId, "lan-discovery-closed-desktop");
    } else {
      try {
        await chrome.tabs.sendMessage(tabId, { type: "LAN_DISCOVERY_COMPLETE" });
      } catch {
        // The verified Glance page may finish before its content script attaches.
      }
      if (route.targetUrl !== tabUrl) {
        await navigateOwnedTab(tabId, navigationId, route.targetUrl);
      }
    }
    return true;
  }
  return false;
}

async function handleCompletedBootstrapNavigation(tabId, tabUrl) {
  return serializeTabTransition(tabId, async () => {
    const navContext = await ensureNavigationContext(tabId);
    const pending = navContext?.pending;
    if (
      !pending
      || !isDockerPending(pending)
      || pending.phase !== "bootstrap"
      || isBootstrapTransitUrl(pending, tabUrl)
      || isConfiguredTargetPage(pending, tabUrl)
      || !navContext?.navigationId
    ) {
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

    const isRoot = isConfiguredRootOrigin(pending, tabUrl);
    if (isRoot) {
      await completeDockerBootstrap(tabId, tabUrl, false, navContext.navigationId);
      return;
    }

    const completion = await completeDockerBootstrap(tabId, tabUrl, true, navContext.navigationId);
    if (completion.action !== "bootstrap-complete") {
      return;
    }
    await navigateToTarget(
      tabId,
      completion.pending,
      "official-bootstrap-external-route",
      navContext.navigationId
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
    const navigationId = beginNavigation(tab.id);
    await beginRecovery(tab.id, settings, "settings-test", navigationId);
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
      const navigationId = beginNavigation(senderTabId);
      const settings = await loadSettings();
      validateRecoverySettings(settings);
      await beginRecovery(
        senderTabId,
        settings,
        `${message.reason ?? "authentication-failed"}-page`,
        navigationId
      );
      return { action: "recovering" };
    });
  }

  if (type === "CONTENT_HELLO") {
    const navContext = await ensureNavigationContext(senderTabId);
    const settings = await loadSettings();
    return {
      navigationId: navContext?.navigationId ?? null,
      pending: navContext?.pending ?? null,
      settings,
      deviceRoute: await getLanRoute(settings.targetUrl)
    };
  }

  if (type === "GET_LAN_SETUP") {
    const navContext = await ensureNavigationContext(senderTabId);
    const pending = navContext?.pending;
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
      const navContext = await ensureNavigationContext(senderTabId);
      return openNativeLanTarget(senderTabId, navContext?.pending, navContext?.navigationId);
    });
  }

  if (type === "BOOTSTRAP_COMPLETE") {
    return serializeTabTransition(
      senderTabId,
      async () => {
        const navContext = await ensureNavigationContext(senderTabId);
        if (!navContext?.navigationId) {
          return { action: "ignored" };
        }
        const pending = navContext?.pending;
        if (!pending || pending.phase !== "bootstrap") {
          return { action: "ignored", pending };
        }
        const completion = await completeDockerBootstrap(senderTabId, sender.url, false, navContext.navigationId);
        return completion;
      }
    );
  }

  if (type === "BOOTSTRAP_FALLBACK") {
    return serializeTabTransition(
      senderTabId,
      async () => {
        const explicitNavigationId = message.navigationId;
        const navContext = await ensureNavigationContext(senderTabId);
        const navigationId = explicitNavigationId || navContext?.navigationId;
        if (!navigationId || !tabNavigations.isActive(senderTabId, navigationId)) {
          return { action: "ignored" };
        }
        const pending = await getPending(senderTabId, navigationId);
        if (!pending || !isDockerPending(pending) || pending.phase !== "bootstrap") {
          return { action: "ignored" };
        }

        let currentTab;
        try {
          currentTab = await chrome.tabs.get(senderTabId);
        } catch {
          return { action: "ignored" };
        }
        const currentUrl = currentTab?.url || sender.url || "";
        if (!isBootstrapTransitUrl(pending, currentUrl) && !isSamePage(pending.bootstrapUrl, currentUrl)) {
          return { action: "ignored" };
        }

        const completion = await completeDockerBootstrap(
          senderTabId,
          pending.rootUrl,
          true,
          navigationId
        );
        if (completion.action !== "bootstrap-complete") {
          return { action: "ignored" };
        }

        await navigateOwnedTab(
          senderTabId,
          navigationId,
          pending.rootUrl
        );

        return { action: "fallback-to-root", pending: completion.pending };
      }
    );
  }

  if (type === "PROBE_AUTH") {
    const navContext = await ensureNavigationContext(senderTabId);
    const pending = navContext?.pending;
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

    const signal = tabNavigations.getAbortSignal(senderTabId, navContext?.navigationId);
    const backgroundResult = await probeAuth(checkUrl, { signal });
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
      const navContext = await ensureNavigationContext(senderTabId);
      const pending = navContext?.pending;
      if (!pending || !canNavigateToRecoveryTarget(pending.phase) || !navContext?.navigationId) {
        return { action: "ignored" };
      }
      const reason = message.via === "optimistic"
        ? "health-optimistic"
        : message.via === "confirmed"
          ? "health-confirmed"
          : message.via === "page"
            ? "health"
            : "health-background";
      return navigateToTarget(
        senderTabId,
        pending,
        reason,
        navContext.navigationId
      );
    });
  }

  if (type === "DOCKER_FRAME_PROBE_RESULT") {
    return serializeTabTransition(senderTabId, async () => {
      const navContext = await ensureNavigationContext(senderTabId);
      const pending = navContext?.pending;
      if (
        !pending
        || !isDockerPending(pending)
        || pending.phase !== "root"
        || sender.frameId === 0
        || typeof sender.url !== "string"
        || !navContext?.navigationId
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
        }, navContext.navigationId);
        chrome.tabs.sendMessage(senderTabId, {
          type: "DOCKER_FRAME_READY",
          navigationId: navContext.navigationId
        }, { frameId: 0 }).catch(() => null);
        return { action: "ready" };
      }
      if (pending.dockerFrameReadyAt) {
        await setPending(senderTabId, {
          ...pending,
          dockerFrameReadyAt: null
        }, navContext.navigationId);
      }
      return { action: "waiting" };
    });
  }

  if (type === "TRY_TARGET") {
    return serializeTabTransition(senderTabId, async () => {
      const navContext = await ensureNavigationContext(senderTabId);
      const pending = navContext?.pending;
      if (!pending || !canNavigateToRecoveryTarget(pending.phase) || !navContext?.navigationId) {
        return { action: "ignored" };
      }
      return navigateToTarget(senderTabId, pending, "root-grace-period", navContext.navigationId);
    });
  }

  if (type === "AUTH_INVALID") {
    return serializeTabTransition(
      senderTabId,
      async () => {
        const navContext = await ensureNavigationContext(senderTabId);
        if (!navContext?.navigationId) {
          return { action: "ignored" };
        }
        return handleAuthFailure(senderTabId, message.reason, navContext.navigationId);
      }
    );
  }

  if (type === "TARGET_READY") {
    return serializeTabTransition(senderTabId, async () => {
      const navContext = await ensureNavigationContext(senderTabId);
      const pending = navContext?.pending;
      if (
        !pending
        || !canAcceptTargetResult(pending.phase)
        || typeof sender.url !== "string"
        || !isConfiguredTargetPage(pending, sender.url)
      ) {
        return { action: "ignored" };
      }
      const helperTabId = Number(pending.helperTabId);
      await cancelNavigation(senderTabId, "target-ready", navContext?.navigationId);
      if (Number.isInteger(helperTabId)) {
        const helperNavId = tabNavigations.getNavigationId(helperTabId);
        if (helperNavId) {
          await removeOwnedTab(helperTabId, helperNavId, "target-ready-helper");
        } else {
          await cancelNavigation(helperTabId, "target-ready-helper");
        }
      }
      return { action: "complete" };
    });
  }

  if (type === "MANUAL_RETRY") {
    return serializeTabTransition(senderTabId, async () => {
      const navContext = await ensureNavigationContext(senderTabId);
      const pending = navContext?.pending ?? await getPending(senderTabId);
      if (!pending) {
        return { action: "ignored" };
      }
      const navigationId = beginNavigation(senderTabId);
      const dockerRecovery = isDockerPending(pending);
      if (pending.phase === "lan-discovery") {
        await removeLanDiscovery(senderTabId, navigationId);
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
      await setPending(senderTabId, updated, navigationId);
      if (dockerRecovery) {
        await navigateOwnedTab(senderTabId, navigationId, updated.bootstrapUrl);
        return { action: "navigating" };
      }
      return { action: "retrying" };
    });
  }

  return { action: "ignored" };
}

chrome.runtime.onInstalled.addListener(() => {
  void ensureInstalledDefaults(true)
    .then(() => restoreLanContentScripts())
    .catch((error) => {
      console.error("Failed to restore LAN content scripts on install:", error);
    });
});

chrome.runtime.onStartup.addListener(() => {
  void ensureInstalledDefaults(false)
    .then(() => restoreLanContentScripts())
    .catch((error) => {
      console.error("Failed to restore LAN content scripts on startup:", error);
    });
});

chrome.action.onClicked.addListener(() => {
  void chrome.runtime.openOptionsPage();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void cancelNavigation(tabId, "tab-removed");
  void navPersistence.removeAllForTab(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (typeof changeInfo.url === "string") {
    const result = tabNavigations.handleUrlChange(tabId, changeInfo.url);
    if (result.cancelled) {
      void cancelNavigation(tabId, "url-mismatch", result.navigationId || result.generation);
    }
  }

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
    .then((response) => sendResponse(response))
    .catch((error) => {
      console.error("Glance background message handling error:", error);
      sendResponse({ error: error.message });
    });
  return true;
});
