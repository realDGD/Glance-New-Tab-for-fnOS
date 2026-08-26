export const DEFAULT_SETTINGS = Object.freeze({
  setupCompleted: false,
  enabled: true,
  targetUrl: "",
  fnosRecoveryEnabled: true,
  rootUrl: "",
  healthUrl: "",
  keepAliveEnabled: true,
  keepAliveMinutes: 10,
  recoveryTimeoutSeconds: 120,
  themeMode: "auto"
});

const SAFE_PROTOCOLS = new Set(["http:", "https:", "file:", "about:", "chrome:"]);
const FNOS_CONNECT_SUFFIXES = ["5ddd.com", "fnos.net"];
export const MAX_DOCKER_RECOVERY_ATTEMPTS = 2;

function parseIPv4(hostname) {
  const parts = String(hostname ?? "").split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) {
    return null;
  }
  const octets = parts.map(Number);
  return octets.every((octet) => octet >= 0 && octet <= 255) ? octets : null;
}

function clampInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(maximum, Math.max(minimum, parsed));
}

export function normalizeNavigableUrl(value) {
  let candidate = String(value ?? "").trim();
  if (!candidate) {
    throw new Error("网址不能为空");
  }

  if (!/^[a-z][a-z\d+.-]*:/i.test(candidate)) {
    candidate = `https://${candidate}`;
  }

  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error("网址格式不正确");
  }

  if (!SAFE_PROTOCOLS.has(parsed.protocol)) {
    throw new Error(`不允许使用 ${parsed.protocol} 协议`);
  }

  if (parsed.protocol === "about:" && parsed.href !== "about:blank") {
    throw new Error("仅允许 about:blank");
  }

  return parsed.href;
}

export function isFnOsHostname(hostname) {
  const normalized = String(hostname ?? "").toLowerCase().replace(/\.$/, "");
  return FNOS_CONNECT_SUFFIXES.some((suffix) => (
    normalized === suffix || normalized.endsWith(`.${suffix}`)
  ));
}

export function isFnOsUrl(value) {
  try {
    const parsed = new URL(normalizeNavigableUrl(value));
    return (parsed.protocol === "http:" || parsed.protocol === "https:")
      && isFnOsHostname(parsed.hostname);
  } catch {
    return false;
  }
}

export function isPrivateNetworkHostname(hostname) {
  const normalized = String(hostname ?? "").toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized.endsWith(".local")) {
    return true;
  }

  const ipv4 = parseIPv4(normalized);
  if (ipv4) {
    return ipv4[0] === 10
      || ipv4[0] === 127
      || (ipv4[0] === 169 && ipv4[1] === 254)
      || (ipv4[0] === 172 && ipv4[1] >= 16 && ipv4[1] <= 31)
      || (ipv4[0] === 192 && ipv4[1] === 168);
  }

  const isIPv6 = normalized.includes(":");
  return isIPv6 && (
    normalized === "::1"
    || normalized.startsWith("fc")
    || normalized.startsWith("fd")
    || /^fe[89ab]/.test(normalized)
  );
}

export function isPrivateNetworkUrl(value) {
  try {
    const parsed = new URL(normalizeNavigableUrl(value));
    return (parsed.protocol === "http:" || parsed.protocol === "https:")
      && isPrivateNetworkHostname(parsed.hostname);
  } catch {
    return false;
  }
}

export function hostPermissionPattern(value) {
  const parsed = new URL(normalizeNavigableUrl(value));
  if (!new Set(["http:", "https:"]).has(parsed.protocol)) {
    throw new Error("局域网权限只支持 http 或 https 地址");
  }
  return `${parsed.protocol}//${parsed.hostname}/*`;
}

export function appendUrlPath(baseUrl, path) {
  const base = new URL(normalizeNavigableUrl(baseUrl));
  const basePath = base.pathname.endsWith("/") ? base.pathname : `${base.pathname}/`;
  base.pathname = `${basePath}${String(path).replace(/^\/+/, "")}`;
  base.search = "";
  base.hash = "";
  return base.href;
}

export function inferLanNativeTargetUrl(remoteTargetUrl, lanRootUrl) {
  const remote = new URL(normalizeNavigableUrl(remoteTargetUrl));
  const root = new URL(normalizeNavigableUrl(lanRootUrl));
  if (!isPrivateNetworkUrl(root.href)) {
    throw new Error("局域网 fnOS 地址必须使用私有网络主机");
  }
  root.pathname = remote.pathname;
  root.search = remote.search;
  root.hash = remote.hash;
  return root.href;
}

export function inferLanHealthUrl(targetUrl, docker = false) {
  const target = new URL(normalizeNavigableUrl(targetUrl));
  if (docker) {
    return appendUrlPath(target.href, "api/healthz");
  }
  const segments = pathSegments(target);
  const appIndex = segments.indexOf("app");
  const appId = appIndex >= 0 ? segments[appIndex + 1] : "";
  if (!appId) {
    throw new Error("无法从局域网原生应用地址识别应用 ID");
  }
  target.pathname = `/${segments.slice(0, appIndex + 2).join("/")}/__fnos/health`;
  target.search = "";
  target.hash = "";
  return target.href;
}

export function isLanGlanceCandidate(candidateUrl, lanRootUrl) {
  try {
    const candidate = new URL(normalizeNavigableUrl(candidateUrl));
    const root = new URL(normalizeNavigableUrl(lanRootUrl));
    if (
      !isPrivateNetworkUrl(candidate.href)
      || candidate.hostname !== root.hostname
      || !new Set(["http:", "https:"]).has(candidate.protocol)
    ) {
      return false;
    }
    const normalizePath = (path) => path.length > 1 ? path.replace(/\/+$/, "") : path;
    return candidate.origin !== root.origin
      || normalizePath(candidate.pathname) !== normalizePath(root.pathname);
  } catch {
    return false;
  }
}

export function isGlanceDocument(value) {
  const html = String(value ?? "");
  const signals = [
    /\bconst\s+pageData\s*=\s*\{/i.test(html),
    /<link[^>]+rel=["']manifest["'][^>]+manifest\.json/i.test(html),
    /\/static\/[^/"']+\/css\/bundle\.css/i.test(html),
    /\bdata-(?:theme|scheme)=["']/i.test(html)
  ];
  return signals.filter(Boolean).length >= 3;
}

function pathSegments(url) {
  return url.pathname.split("/").filter(Boolean);
}

function parseFnOsHostname(hostname) {
  const normalized = String(hostname ?? "").toLowerCase().replace(/\.$/, "");
  const suffix = FNOS_CONNECT_SUFFIXES.find((candidate) => (
    normalized === candidate || normalized.endsWith(`.${candidate}`)
  ));
  if (!suffix) {
    return null;
  }
  if (normalized === suffix) {
    return {
      isBareHost: true,
      nasId: "",
      servicePrefix: "",
      suffix
    };
  }

  const labels = normalized.slice(0, -(suffix.length + 1)).split(".");
  return {
    isBareHost: false,
    nasId: labels.at(-1) ?? "",
    servicePrefix: labels.slice(0, -1).join("."),
    suffix
  };
}

export function inferFnOsRootUrl(targetUrl) {
  const parsed = new URL(normalizeNavigableUrl(targetUrl));
  if (!isFnOsUrl(parsed.href)) {
    throw new Error("目标网址不是 fnOS 的 5ddd.com 或 fnos.net 地址");
  }

  const segments = pathSegments(parsed);
  const appIndex = segments.indexOf("app");
  const host = parseFnOsHostname(parsed.hostname);
  if (host.isBareHost) {
    const prefix = appIndex > 0 ? segments.slice(0, appIndex) : segments.slice(0, 1);
    parsed.pathname = prefix.length ? `/${prefix.join("/")}/` : "/";
  } else {
    parsed.hostname = `${host.nasId}.${host.suffix}`;
    parsed.pathname = "/";
  }
  parsed.search = "";
  parsed.hash = "";
  return parsed.href;
}

export function inferFnOsHealthUrl(targetUrl) {
  const parsed = new URL(normalizeNavigableUrl(targetUrl));
  if (!isFnOsUrl(parsed.href)) {
    throw new Error("目标网址不是 fnOS 的 5ddd.com 或 fnos.net 地址");
  }

  const segments = pathSegments(parsed);
  const appIndex = segments.indexOf("app");
  const appId = appIndex >= 0 ? segments[appIndex + 1] : "";
  parsed.pathname = appId
    ? `/${segments.slice(0, appIndex + 2).join("/")}/__fnos/health`
    : "/api/healthz";
  parsed.search = "";
  parsed.hash = "";
  return parsed.href;
}

export function inferFnOsBootstrapUrl(targetUrl) {
  const parsed = new URL(normalizeNavigableUrl(targetUrl));
  if (!isFnOsUrl(parsed.href)) {
    throw new Error("目标网址不是 fnOS 的 5ddd.com 或 fnos.net 地址");
  }

  const host = parseFnOsHostname(parsed.hostname);
  const segments = pathSegments(parsed);
  const nasId = host.isBareHost ? segments[0] : host.nasId;
  if (!nasId) {
    throw new Error("无法从目标网址识别飞牛 ID");
  }

  parsed.hostname = host.suffix;
  parsed.pathname = `/${nasId}/`;
  parsed.search = "";
  parsed.hash = "";
  return parsed.href;
}

export function isDockerFnConnectService(targetUrl, rootUrl, healthUrl) {
  try {
    const target = new URL(normalizeNavigableUrl(targetUrl));
    const root = new URL(normalizeNavigableUrl(rootUrl));
    const health = new URL(normalizeNavigableUrl(healthUrl));
    const healthPath = health.pathname.length > 1
      ? health.pathname.replace(/\/+$/, "")
      : health.pathname;
    return isFnOsUrl(target.href)
      && isFnOsUrl(root.href)
      && isFnOsUrl(health.href)
      && target.origin === health.origin
      && target.origin !== root.origin
      && healthPath === "/api/healthz";
  } catch {
    return false;
  }
}

export function shouldStopDockerRecovery(attempts) {
  return Number(attempts) >= MAX_DOCKER_RECOVERY_ATTEMPTS;
}

export function canNavigateToRecoveryTarget(phase) {
  return phase === "root";
}

export function canAcceptTargetResult(phase) {
  return phase === "target";
}

export function combineDockerProbeSignals(backgroundReady, frameReady) {
  const normalizedBackgroundReady = Boolean(backgroundReady);
  const normalizedFrameReady = Boolean(frameReady);
  return {
    ok: normalizedBackgroundReady || normalizedFrameReady,
    backgroundReady: normalizedBackgroundReady,
    frameReady: normalizedFrameReady,
    strongReady: normalizedBackgroundReady && normalizedFrameReady,
    signalCount: Number(normalizedBackgroundReady) + Number(normalizedFrameReady)
  };
}

export function sanitizeSettings(input = {}) {
  const merged = { ...DEFAULT_SETTINGS, ...input };
  const rawTargetUrl = String(merged.targetUrl ?? "").trim();
  const targetUrl = rawTargetUrl ? normalizeNavigableUrl(rawTargetUrl) : "";

  let rootUrl = String(merged.rootUrl ?? "").trim();
  let healthUrl = String(merged.healthUrl ?? "").trim();
  if (!rootUrl && isFnOsUrl(targetUrl)) {
    rootUrl = inferFnOsRootUrl(targetUrl);
  }
  if (!healthUrl && isFnOsUrl(targetUrl)) {
    healthUrl = inferFnOsHealthUrl(targetUrl);
  }

  return {
    setupCompleted: Boolean(merged.setupCompleted && targetUrl),
    enabled: Boolean(merged.enabled),
    targetUrl,
    fnosRecoveryEnabled: Boolean(merged.fnosRecoveryEnabled),
    rootUrl: rootUrl ? normalizeNavigableUrl(rootUrl) : "",
    healthUrl: healthUrl ? normalizeNavigableUrl(healthUrl) : "",
    keepAliveEnabled: Boolean(merged.keepAliveEnabled),
    keepAliveMinutes: clampInteger(merged.keepAliveMinutes, 10, 1, 120),
    recoveryTimeoutSeconds: clampInteger(merged.recoveryTimeoutSeconds, 120, 15, 600),
    themeMode: ["auto", "light", "dark"].includes(merged.themeMode)
      ? merged.themeMode
      : "auto"
  };
}

export function validateRecoverySettings(settings) {
  if (!settings.targetUrl) {
    throw new Error("请先填写要作为新标签页打开的主页网址");
  }
  if (!settings.fnosRecoveryEnabled) {
    return;
  }
  if (!isFnOsUrl(settings.targetUrl)) {
    throw new Error("登录恢复只支持 5ddd.com 与 fnos.net 地址");
  }
  if (!isFnOsUrl(settings.rootUrl)) {
    throw new Error("fnOS 根网址必须是 5ddd.com 或 fnos.net 地址");
  }
  if (!isFnOsUrl(settings.healthUrl)) {
    throw new Error("会话检测网址必须是 5ddd.com 或 fnos.net 地址");
  }
}

export function chooseInitialNavigation(settings, sessionWarmed) {
  if (settings.fnosRecoveryEnabled && isFnOsUrl(settings.targetUrl)) {
    return sessionWarmed ? "target-first" : "root-first";
  }
  return "direct";
}

export function isSuccessfulHealthResponse(status, body) {
  const normalizedBody = String(body ?? "").trim().toLowerCase();
  return Number(status) >= 200
    && Number(status) < 300
    && (normalizedBody === "" || normalizedBody === "ok");
}

export function isSamePage(left, right) {
  try {
    const a = new URL(left);
    const b = new URL(right);
    const normalizePath = (path) => path.length > 1 ? path.replace(/\/+$/, "") : path;
    if (a.origin === b.origin && normalizePath(a.pathname) === normalizePath(b.pathname)) {
      return true;
    }

    const fnOsRoute = (url) => {
      const host = parseFnOsHostname(url.hostname);
      if (!host) {
        return null;
      }

      const segments = pathSegments(url);
      const identity = host.isBareHost ? segments.shift() : host.nasId;
      if (!identity) {
        return null;
      }
      return [
        host.suffix,
        identity,
        host.servicePrefix,
        normalizePath(`/${segments.join("/")}`)
      ].join(":");
    };

    const aRoute = fnOsRoute(a);
    return aRoute !== null && aRoute === fnOsRoute(b);
  } catch {
    return false;
  }
}

export function isDockerPending(pending) {
  return pending?.recoveryKind === "docker"
    || isDockerFnConnectService(
      pending?.targetUrl,
      pending?.rootUrl,
      pending?.checkUrl
    );
}

export function isSameNavigatedUrl(expected, actual) {
  if (!expected || !actual) {
    return false;
  }
  try {
    if (expected === actual) {
      return true;
    }
    const exp = new URL(normalizeNavigableUrl(expected));
    const act = new URL(normalizeNavigableUrl(actual));
    const normalizePath = (p) => p.length > 1 ? p.replace(/\/+$/, "") : p;
    if (
      exp.origin === act.origin
      && normalizePath(exp.pathname) === normalizePath(act.pathname)
      && exp.search === act.search
    ) {
      return true;
    }
    return isSamePage(exp.href, act.href);
  } catch {
    return false;
  }
}

export function isBootstrapTransitUrl(pending, value) {
  try {
    const actual = new URL(normalizeNavigableUrl(value));
    if (actual.hostname === "check.fnos.net" || actual.hostname === "ctest.fnos.net") {
      return true;
    }
    if (!pending?.bootstrapUrl) {
      return false;
    }
    const expected = new URL(normalizeNavigableUrl(pending.bootstrapUrl));
    const normalizePath = (p) => p.length > 1 ? p.replace(/\/+$/, "") : p;
    return actual.origin === expected.origin
      && normalizePath(actual.pathname) === normalizePath(expected.pathname);
  } catch {
    return false;
  }
}

export function isConfiguredRootOrigin(pending, value) {
  try {
    if (!pending?.rootUrl) {
      return false;
    }
    return new URL(normalizeNavigableUrl(pending.rootUrl)).origin
      === new URL(normalizeNavigableUrl(value)).origin;
  } catch {
    return false;
  }
}

export function isConfiguredRootPage(pending, value) {
  try {
    if (!pending?.rootUrl) {
      return false;
    }
    if (isSamePage(pending.rootUrl, value)) {
      return true;
    }
    const expected = new URL(normalizeNavigableUrl(pending.rootUrl));
    const actual = new URL(normalizeNavigableUrl(value));
    if (expected.origin !== actual.origin) {
      return false;
    }
    const actualPath = actual.pathname.length > 1
      ? actual.pathname.replace(/\/+$/, "")
      : actual.pathname;
    const expectedPath = expected.pathname.length > 1
      ? expected.pathname.replace(/\/+$/, "")
      : expected.pathname;
    return actualPath === expectedPath || actualPath === "/login" || actualPath === "";
  } catch {
    return false;
  }
}

export function isConfiguredTargetPage(pending, value) {
  try {
    if (!pending?.targetUrl) {
      return false;
    }
    const expected = new URL(normalizeNavigableUrl(pending.targetUrl));
    const actual = new URL(normalizeNavigableUrl(value));
    const normalizePath = (path) => path.length > 1 ? path.replace(/\/+$/, "") : path;
    return expected.origin === actual.origin
      && normalizePath(expected.pathname) === normalizePath(actual.pathname);
  } catch {
    return false;
  }
}

export function isIgnoredNavigationUrl(url) {
  if (!url || typeof url !== "string") {
    return true;
  }
  if (url.startsWith("chrome-error://")) {
    return true;
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "chrome-extension:" && parsed.pathname.endsWith("newtab.html")) {
      return true;
    }
  } catch {
    // Ignore invalid url parse
  }
  return false;
}

export function matchesExpectedNavigation(
  expectedUrls,
  pending,
  newUrl,
  primaryExpectedUrl = null
) {
  if (primaryExpectedUrl && isSameNavigatedUrl(primaryExpectedUrl, newUrl)) {
    return true;
  }

  if (expectedUrls) {
    for (const expected of expectedUrls) {
      if (isSameNavigatedUrl(expected, newUrl)) {
        return true;
      }
    }
  }

  if (pending) {
    if (isDockerPending(pending) && pending.phase === "bootstrap") {
      if (pending.bootstrapUrl && isBootstrapTransitUrl(pending, newUrl)) {
        return true;
      }
      if (pending.rootUrl && isConfiguredRootPage(pending, newUrl)) {
        return true;
      }
      if (
        pending.targetUrl
        && (isConfiguredTargetPage(pending, newUrl) || isSamePage(pending.targetUrl, newUrl))
      ) {
        return true;
      }
    }

    if (["root", "target", "manual", "lan-root"].includes(pending.phase)) {
      if (pending.rootUrl && isConfiguredRootPage(pending, newUrl)) {
        return true;
      }
      if (
        pending.targetUrl
        && (isConfiguredTargetPage(pending, newUrl) || isSamePage(pending.targetUrl, newUrl))
      ) {
        return true;
      }
      if (
        pending.lanRootUrl
        && isConfiguredRootPage({ rootUrl: pending.lanRootUrl }, newUrl)
      ) {
        return true;
      }
      if (
        pending.lanTargetUrl
        && isConfiguredTargetPage({ targetUrl: pending.lanTargetUrl }, newUrl)
      ) {
        return true;
      }
    }

    if (pending.phase === "lan-permission") {
      try {
        const parsed = new URL(newUrl);
        if (
          parsed.pathname.endsWith("newtab.html")
          && parsed.searchParams.get("mode") === "lan-setup"
        ) {
          return true;
        }
      } catch {
        // Ignore
      }
    }

    if (pending.phase === "lan-discovery") {
      if (
        pending.lanRootUrl
        && isConfiguredRootPage({ rootUrl: pending.lanRootUrl }, newUrl)
      ) {
        return true;
      }
      if (pending.lanRootUrl && isLanGlanceCandidate(newUrl, pending.lanRootUrl)) {
        return true;
      }
    }
  }

  return false;
}

export function parsePendingEnvelope(stored) {
  if (!stored || typeof stored !== "object") {
    return null;
  }
  if ("pending" in stored && stored.pending) {
    return {
      generation: Number.isInteger(Number(stored.generation)) ? Number(stored.generation) : null,
      pending: stored.pending,
      expectedUrl: typeof stored.expectedUrl === "string" ? stored.expectedUrl : null,
      expectedUrls: Array.isArray(stored.expectedUrls) ? stored.expectedUrls : [],
      savedAt: Number(stored.savedAt) || 0
    };
  }
  return {
    generation: null,
    pending: stored,
    expectedUrl: null,
    expectedUrls: [],
    savedAt: 0
  };
}

export class NavigationPersistence {
  constructor(storageAdapter = null) {
    this._storage = storageAdapter;
  }

  get storage() {
    if (this._storage) {
      return this._storage;
    }
    if (typeof chrome !== "undefined" && chrome?.storage?.session) {
      return chrome.storage.session;
    }
    return null;
  }

  pendingKey(tabId, generation) {
    return `pending-recovery:${tabId}:${generation}`;
  }

  activeNavKey(tabId) {
    return `nav-active:${tabId}`;
  }

  discoveryKey(ownerTabId, generation) {
    return `lan-discovery:${ownerTabId}:${generation}`;
  }

  async getActivePointer(tabId) {
    const s = this.storage;
    if (!s) {
      return null;
    }
    const key = this.activeNavKey(tabId);
    const res = await s.get(key);
    return res[key] ?? null;
  }

  async getPendingEnvelope(tabId, generation = null) {
    const s = this.storage;
    if (!s) {
      return null;
    }
    let targetGen = generation;
    if (targetGen === null) {
      const active = await this.getActivePointer(tabId);
      if (active && Number.isInteger(active.generation)) {
        targetGen = active.generation;
      }
    }
    if (targetGen !== null) {
      const key = this.pendingKey(tabId, targetGen);
      const res = await s.get(key);
      const stored = res[key];
      if (stored) {
        return parsePendingEnvelope(stored);
      }
    }
    // Fallback for legacy single key
    const legacyKey = `pending-recovery:${tabId}`;
    const legacyRes = await s.get(legacyKey);
    const legacyStored = legacyRes[legacyKey];
    if (legacyStored) {
      const parsed = parsePendingEnvelope(legacyStored);
      if (parsed && (generation === null || parsed.generation === generation)) {
        return parsed;
      }
    }
    return null;
  }

  async setPendingEnvelope(tabId, generation, envelope) {
    const s = this.storage;
    if (!s || !Number.isInteger(generation)) {
      return false;
    }
    const key = this.pendingKey(tabId, generation);
    const activeKey = this.activeNavKey(tabId);
    await s.set({
      [key]: envelope,
      [activeKey]: { generation, updatedAt: Date.now() }
    });
    return true;
  }

  async removePendingEnvelope(tabId, generation) {
    const s = this.storage;
    if (!s) {
      return;
    }
    const keysToRemove = [];
    if (Number.isInteger(generation)) {
      keysToRemove.push(this.pendingKey(tabId, generation));
    }
    const legacyKey = `pending-recovery:${tabId}`;
    keysToRemove.push(legacyKey);
    await s.remove(keysToRemove);

    const activeKey = this.activeNavKey(tabId);
    const activeRes = await s.get(activeKey);
    const active = activeRes[activeKey];
    if (active && (generation === null || active.generation === generation)) {
      await s.remove(activeKey);
    }
  }

  async getDiscovery(ownerTabId, generation = null) {
    const s = this.storage;
    if (!s) {
      return null;
    }
    if (generation !== null) {
      const key = this.discoveryKey(ownerTabId, generation);
      const res = await s.get(key);
      return res[key] ?? null;
    }
    const all = await s.get(null);
    for (const [key, value] of Object.entries(all || {})) {
      if (key.startsWith(`lan-discovery:${ownerTabId}:`)) {
        if (value && Number(value.expiresAt) > Date.now()) {
          return value;
        }
      }
    }
    return null;
  }

  async setDiscovery(ownerTabId, generation, discovery) {
    const s = this.storage;
    if (!s || !Number.isInteger(generation)) {
      return false;
    }
    const key = this.discoveryKey(ownerTabId, generation);
    await s.set({
      [key]: {
        ...discovery,
        ownerTabId,
        generation
      }
    });
    return true;
  }

  async removeDiscovery(ownerTabId, generation = null) {
    const s = this.storage;
    if (!s) {
      return;
    }
    if (generation !== null) {
      const key = this.discoveryKey(ownerTabId, generation);
      await s.remove(key);
      return;
    }
    const all = await s.get(null);
    const keysToRemove = Object.keys(all || {}).filter((k) => (
      k === `lan-discovery:${ownerTabId}` || k.startsWith(`lan-discovery:${ownerTabId}:`)
    ));
    if (keysToRemove.length > 0) {
      await s.remove(keysToRemove);
    }
  }

  async listActiveDiscoveries() {
    const s = this.storage;
    if (!s) {
      return [];
    }
    const all = await s.get(null);
    const now = Date.now();
    return Object.entries(all || {})
      .filter(([key]) => key.startsWith("lan-discovery:"))
      .map(([, val]) => val)
      .filter((val) => val && Number(val.expiresAt) > now && Number.isInteger(val.generation));
  }
}

export class TabNavigationManager {
  constructor() {
    this.states = new Map();
    this.latestGenerations = new Map();
  }

  begin(tabId) {
    const previous = this.states.get(tabId);
    if (previous?.abortController) {
      try {
        previous.abortController.abort();
      } catch {
        // Ignore
      }
    }
    const lastGen = this.latestGenerations.get(tabId) ?? (previous?.generation ?? 0);
    const generation = lastGen + 1;
    this.latestGenerations.set(tabId, generation);
    const abortController = new AbortController();
    const state = {
      tabId,
      generation,
      expectedUrl: null,
      expectedUrls: new Set(),
      pending: null,
      abortController,
      cancelled: false,
      startedAt: Date.now()
    };
    this.states.set(tabId, state);
    return generation;
  }

  rehydrate(tabId, { generation, expectedUrl = null, expectedUrls = [], pending = null } = {}) {
    if (!Number.isInteger(generation) || generation <= 0) {
      return null;
    }
    const previous = this.states.get(tabId);
    if (previous?.abortController) {
      try {
        previous.abortController.abort();
      } catch {
        // Ignore
      }
    }
    const lastGen = this.latestGenerations.get(tabId) ?? 0;
    this.latestGenerations.set(tabId, Math.max(lastGen, generation));

    let normalizedExpected = null;
    if (expectedUrl) {
      try {
        normalizedExpected = normalizeNavigableUrl(expectedUrl);
      } catch {
        normalizedExpected = null;
      }
    }

    const normalizedSet = new Set();
    if (normalizedExpected) {
      normalizedSet.add(normalizedExpected);
    }
    for (const item of expectedUrls || []) {
      try {
        normalizedSet.add(normalizeNavigableUrl(item));
      } catch {
        // Ignore invalid URL
      }
    }

    const abortController = new AbortController();
    const state = {
      tabId,
      generation,
      expectedUrl: normalizedExpected,
      expectedUrls: normalizedSet,
      pending,
      abortController,
      cancelled: false,
      startedAt: Date.now()
    };
    this.states.set(tabId, state);
    return state;
  }

  get(tabId) {
    return this.states.get(tabId) ?? null;
  }

  getGeneration(tabId) {
    return this.states.get(tabId)?.generation ?? null;
  }

  getLatestGeneration(tabId) {
    return this.latestGenerations.get(tabId) ?? null;
  }

  getAbortSignal(tabId, generation = null) {
    const state = this.states.get(tabId);
    if (!state || state.cancelled) {
      return null;
    }
    if (generation !== null && state.generation !== generation) {
      return null;
    }
    return state.abortController?.signal ?? null;
  }

  isActive(tabId, generation = null) {
    const state = this.states.get(tabId);
    if (!state || state.cancelled) {
      return false;
    }
    if (generation !== null && state.generation !== generation) {
      return false;
    }
    return true;
  }

  setPending(tabId, pending, generation = null) {
    const state = this.states.get(tabId);
    if (!state || state.cancelled || (generation !== null && state.generation !== generation)) {
      return false;
    }
    state.pending = pending;
    return true;
  }

  getPending(tabId, generation = null) {
    const state = this.states.get(tabId);
    if (!state || state.cancelled || (generation !== null && state.generation !== generation)) {
      return null;
    }
    return state.pending ?? null;
  }

  setExpectedUrl(tabId, generation, url) {
    const state = this.states.get(tabId);
    if (!state || state.cancelled || (generation !== null && state.generation !== generation)) {
      return false;
    }
    try {
      const normalized = normalizeNavigableUrl(url);
      state.expectedUrl = normalized;
      state.expectedUrls.add(normalized);
      return true;
    } catch {
      return false;
    }
  }

  addExpectedUrl(tabId, generation, url) {
    const state = this.states.get(tabId);
    if (!state || state.cancelled || (generation !== null && state.generation !== generation)) {
      return false;
    }
    try {
      const normalized = normalizeNavigableUrl(url);
      state.expectedUrls.add(normalized);
      return true;
    } catch {
      return false;
    }
  }

  handleUrlChange(tabId, newUrl, fallbackPending = null) {
    const state = this.states.get(tabId);
    if (!state || state.cancelled) {
      return { active: false, matched: false, cancelled: false, generation: state?.generation ?? null };
    }

    if (isIgnoredNavigationUrl(newUrl)) {
      return { active: true, matched: true, cancelled: false, generation: state.generation };
    }

    const pending = state.pending ?? fallbackPending;
    if (matchesExpectedNavigation(state.expectedUrls, pending, newUrl, state.expectedUrl)) {
      this.addExpectedUrl(tabId, state.generation, newUrl);
      return { active: true, matched: true, cancelled: false, generation: state.generation };
    }

    this.cancel(tabId, "url-mismatch", state.generation);
    return { active: false, matched: false, cancelled: true, generation: state.generation };
  }

  cancel(tabId, reason = "cancelled", targetGeneration = null) {
    const state = this.states.get(tabId);
    if (!state) {
      return null;
    }
    if (targetGeneration !== null && state.generation !== targetGeneration) {
      return null;
    }
    state.cancelled = true;
    if (state.abortController) {
      try {
        state.abortController.abort();
      } catch {
        // Ignore
      }
    }
    this.states.delete(tabId);
    return state;
  }

  clear() {
    for (const [tabId] of this.states) {
      this.cancel(tabId, "clear");
    }
    this.states.clear();
    this.latestGenerations.clear();
  }
}
