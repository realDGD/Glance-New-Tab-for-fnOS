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
