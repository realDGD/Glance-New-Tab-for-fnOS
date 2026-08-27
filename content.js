(() => {
  const REQUEST_EVENT = "keep-fnnas-login:probe-request";
  const RESPONSE_EVENT = "keep-fnnas-login:probe-response";
  const PROBE_DELAYS_MS = [250, 500, 1000];
  const PROBE_TIMEOUT_MS = 1500;
  const ROOT_GRACE_MS = 1000;
  const DOCKER_FAST_MIN_ROOT_DWELL_MS = 700;
  const DOCKER_FAST_READY_STABILITY_MS = 300;
  const DOCKER_BOOTSTRAP_MIN_ROOT_DWELL_MS = 500;
  const DOCKER_BOOTSTRAP_READY_STABILITY_MS = 250;
  const DOCKER_BOOTSTRAP_FALLBACK_GRACE_MS = 1600;
  const DOCKER_MIN_ROOT_DWELL_MS = 2200;
  const DOCKER_READY_STABILITY_MS = 1000;
  const DOCKER_FALLBACK_GRACE_MS = 5000;
  const BOOTSTRAP_PAGE_TIMEOUT_MS = 7000;
  const LAN_DISCOVERY_TIMEOUT_MS = 2 * 60 * 1000;
  const PAGE_SETTLE_MS = 80;
  const COMPLETION_HOLD_MS = 30;

  let badge;
  let badgeText;
  let badgeButton;
  let loadingHost;
  let loadingScreen;
  let loadingText;
  let loadingButton;
  let previewLayer;
  let promptCard;
  let loadingManuallyDismissed = false;
  let stopped = false;
  let probeSequence = 0;

  function send(message) {
    return chrome.runtime.sendMessage(message).catch(() => null);
  }

  function waitForDocument() {
    if (document.readyState !== "loading") {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      document.addEventListener("DOMContentLoaded", resolve, { once: true });
    });
  }

  function normalizedPath(pathname) {
    return pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  }

  function fnOsAddress(value) {
    try {
      const url = new URL(value);
      const hostname = url.hostname.toLowerCase();
      const suffix = hostname === "5ddd.com" || hostname.endsWith(".5ddd.com")
        ? "5ddd.com"
        : hostname === "fnos.net" || hostname.endsWith(".fnos.net")
          ? "fnos.net"
          : "";
      if (!suffix) {
        return null;
      }

      const segments = url.pathname.split("/").filter(Boolean);
      const isBareHost = hostname === suffix;
      const hostnameLabels = isBareHost
        ? []
        : hostname.slice(0, -(suffix.length + 1)).split(".");
      const identity = isBareHost ? segments.shift() : hostnameLabels.at(-1);
      if (!identity) {
        return null;
      }

      return {
        identity,
        isBareHost,
        route: normalizedPath(`/${segments.join("/")}`),
        servicePrefix: isBareHost ? "" : hostnameLabels.slice(0, -1).join("."),
        suffix,
        url
      };
    } catch {
      return null;
    }
  }

  function isCurrentPage(targetUrl) {
    try {
      const target = new URL(targetUrl);
      if (
        target.origin === location.origin
        && normalizedPath(target.pathname) === normalizedPath(location.pathname)
      ) {
        return true;
      }

      const targetAddress = fnOsAddress(target.href);
      const currentAddress = fnOsAddress(location.href);
      return Boolean(
        targetAddress
        && currentAddress
        && targetAddress.suffix === currentAddress.suffix
        && targetAddress.identity === currentAddress.identity
        && targetAddress.servicePrefix === currentAddress.servicePrefix
        && targetAddress.route === currentAddress.route
      );
    } catch {
      return false;
    }
  }

  function isExactCurrentPage(targetUrl) {
    try {
      const target = new URL(targetUrl);
      return target.origin === location.origin
        && normalizedPath(target.pathname) === normalizedPath(location.pathname);
    } catch {
      return false;
    }
  }

  function isFnConnectBootstrapPage(bootstrapUrl) {
    if (isExactCurrentPage(bootstrapUrl)) {
      return true;
    }
    const hostname = location.hostname.toLowerCase();
    return hostname === "check.fnos.net" || hostname === "ctest.fnos.net";
  }

  function isCurrentRootOrigin(rootUrl) {
    try {
      return new URL(rootUrl).origin === location.origin;
    } catch {
      return false;
    }
  }

  function localizeFnOsUrl(url) {
    const requested = fnOsAddress(url);
    const current = fnOsAddress(location.href);
    if (
      !requested
      || !current
      || requested.suffix !== current.suffix
      || requested.identity !== current.identity
      || requested.servicePrefix !== current.servicePrefix
    ) {
      return url;
    }

    const localized = new URL(location.origin);
    localized.pathname = current.isBareHost
      ? `/${current.identity}${requested.route}`
      : requested.route;
    return localized.href;
  }

  function isDockerRecovery(pending) {
    if (pending?.recoveryKind === "docker") {
      return true;
    }
    try {
      const target = new URL(pending.targetUrl);
      const root = new URL(pending.rootUrl);
      const check = new URL(pending.checkUrl);
      return target.origin === check.origin
        && target.origin !== root.origin
        && check.pathname.replace(/\/+$/, "") === "/api/healthz";
    } catch {
      return false;
    }
  }

  function pageAuthenticationFailure() {
    const title = document.title ?? "";
    const body = document.body?.innerText?.slice(0, 10000) ?? "";
    const content = `${title}\n${body}`;
    if (/\binvalid\s+token\b/i.test(content)) {
      return "invalid-token";
    }
    if (
      /FN\s*Connect[\s\S]{0,160}(?:暂无权限|无权限)[\s\S]{0,60}(?:访问)?(?:该)?服务/i
        .test(content)
    ) {
      return "fn-connect-permission-denied";
    }
    return "";
  }

  function authenticationFailureMessage(reason) {
    return reason === "fn-connect-permission-denied"
      ? "FN Connect 尚未授权该服务，正在通过 fnOS 根页面恢复…"
      : "登录状态已失效，正在通过 fnOS 根页面恢复…";
  }

  function pageContainsLoginForm() {
    const passwordInputs = [...document.querySelectorAll('input[type="password"]')];
    return passwordInputs.some((element) => {
      const style = getComputedStyle(element);
      return !element.disabled && style.display !== "none" && style.visibility !== "hidden";
    });
  }

  function useDarkTheme(settings) {
    if (settings?.themeMode === "dark") {
      return true;
    }
    if (settings?.themeMode === "light") {
      return false;
    }
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
  }

  const PREVIEW_KEY_PREFIX = "glance-preview:";
  const ACTIVE_PREVIEW_TARGET_KEY = "glance-preview-active-target";
  const PREVIEW_TTL_FRESH_MS = 30 * 60 * 1000;
  const PREVIEW_TTL_STALE_MS = 6 * 60 * 60 * 1000;

  const SENSITIVE_QUERY_KEYS = new Set([
    "token", "access_token", "refresh_token", "auth", "auth_token",
    "authorization", "key", "api_key", "apikey", "secret", "session",
    "sessionid", "sid", "ticket", "sig", "signature", "code", "jwt",
    "credential", "credentials", "password", "passwd", "pwd"
  ]);

  function normalizeNavigableUrl(value) {
    const parsed = new URL(value);
    if (!new Set(["http:", "https:"]).has(parsed.protocol)) {
      throw new Error("只支持 HTTP 或 HTTPS 网址");
    }
    parsed.hash = "";
    if (parsed.pathname.length > 1) {
      parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    }
    return parsed.href;
  }

  function previewStorageKey(targetUrl) {
    const norm = normalizeNavigableUrl(targetUrl);
    const parsed = new URL(norm);
    if (parsed.pathname.length > 1) {
      parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    }
    return `${PREVIEW_KEY_PREFIX}${parsed.href}`;
  }

  function sanitizeSafeUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== "string") {
      return "";
    }
    try {
      const parsed = new URL(rawUrl, "https://glance.local");
      for (const key of [...parsed.searchParams.keys()]) {
        if (SENSITIVE_QUERY_KEYS.has(key.toLowerCase())) {
          parsed.searchParams.delete(key);
        }
      }
      const lowerHash = parsed.hash.toLowerCase();
      for (const key of SENSITIVE_QUERY_KEYS) {
        if (lowerHash.includes(key)) {
          parsed.hash = "";
          break;
        }
      }
      return parsed.href;
    } catch {
      return "";
    }
  }

  function sanitizeSafeText(text, maxLength = 80) {
    if (!text || typeof text !== "string") {
      return "";
    }
    const clean = text.replace(/[\x00-\x1F\x7F-\x9F]/g, " ").trim();
    if (/\b(?:bearer\s+[a-zA-Z\d._-]+|access_token|password\s*=|secret\s*=)/i.test(clean)) {
      return "";
    }
    return clean.slice(0, maxLength);
  }

  function escapeHtml(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function getPreviewStatus(preview) {
    if (!preview || typeof preview !== "object" || !preview.savedAt) {
      return "none";
    }
    const age = Date.now() - preview.savedAt;
    if (age < PREVIEW_TTL_FRESH_MS) {
      return "fresh";
    }
    if (age < PREVIEW_TTL_STALE_MS) {
      return "stale";
    }
    return "expired";
  }

  function renderGlanceSkeletonHtml() {
    return `
      <div class="glance-preview-layout skeleton-layout" aria-hidden="true">
        <div class="glance-preview-header">
          <div class="glance-skeleton-bar glance-skeleton-title"></div>
          <div class="glance-skeleton-bar glance-skeleton-time"></div>
        </div>
        <div class="glance-preview-columns">
          <div class="glance-preview-col">
            <div class="glance-preview-card skeleton-card">
              <div class="glance-skeleton-bar card-title"></div>
              <div class="glance-skeleton-bar card-line"></div>
              <div class="glance-skeleton-bar card-line short"></div>
            </div>
            <div class="glance-preview-card skeleton-card">
              <div class="glance-skeleton-bar card-title"></div>
              <div class="glance-skeleton-bar card-line"></div>
            </div>
          </div>
          <div class="glance-preview-col">
            <div class="glance-preview-card skeleton-card">
              <div class="glance-skeleton-bar card-title"></div>
              <div class="glance-skeleton-bar card-line"></div>
              <div class="glance-skeleton-bar card-line"></div>
            </div>
          </div>
          <div class="glance-preview-col">
            <div class="glance-preview-card skeleton-card">
              <div class="glance-skeleton-bar card-title"></div>
              <div class="glance-skeleton-bar card-line short"></div>
            </div>
            <div class="glance-preview-card skeleton-card">
              <div class="glance-skeleton-bar card-title"></div>
              <div class="glance-skeleton-bar card-line"></div>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  function renderGlancePreviewHtml(preview, status = "fresh") {
    if (!preview || !Array.isArray(preview.columns) || preview.columns.length === 0) {
      return renderGlanceSkeletonHtml();
    }
    const staleNotice = status === "stale"
      ? `<div class="glance-preview-stale-badge">缓存预览 · 正在刷新</div>`
      : "";

    const columnsHtml = preview.columns.map((col) => {
      const widgetsHtml = (col.widgets || []).map((w) => {
        const titleHtml = w.title ? `<div class="glance-card-header">${escapeHtml(w.title)}</div>` : "";
        const itemsHtml = (w.items || []).map((item) => `
          <div class="glance-card-item">
            <span class="glance-card-item-title">${escapeHtml(item.title)}</span>
          </div>
        `).join("");
        return `
          <div class="glance-preview-card">
            ${titleHtml}
            <div class="glance-card-body">${itemsHtml}</div>
          </div>
        `;
      }).join("");
      return `<div class="glance-preview-col">${widgetsHtml}</div>`;
    }).join("");

    return `
      <div class="glance-preview-layout" aria-hidden="true">
        <div class="glance-preview-header">
          <div class="glance-preview-title">${escapeHtml(preview.pageTitle || "Glance")}</div>
          ${staleNotice}
        </div>
        <div class="glance-preview-columns">
          ${columnsHtml}
        </div>
      </div>
    `;
  }

  function extractGlancePreview(rootDocument, targetUrl) {
    if (!rootDocument || typeof rootDocument.querySelectorAll !== "function") {
      return null;
    }
    try {
      const title = sanitizeSafeText(rootDocument.title || "Glance", 60);
      const theme = rootDocument.documentElement?.dataset?.theme
        || (rootDocument.body?.classList?.contains("dark") ? "dark" : "auto");

      const columnElements = rootDocument.querySelectorAll(".column, [class*='column'], .grid-col");
      const columns = [];

      const processWidget = (widgetEl) => {
        if (typeof widgetEl.querySelector === "function" && widgetEl.querySelector('input[type="password"], input[name*="password" i], input[name*="token" i], input[name*="auth" i], input[type="hidden"], textarea, form')) {
          return null;
        }

        const titleEl = typeof widgetEl.querySelector === "function" ? widgetEl.querySelector("h1, h2, h3, h4, h5, h6, .title, [class*='title']") : null;
        const widgetTitle = sanitizeSafeText(titleEl?.textContent || "", 50);

        const itemEls = typeof widgetEl.querySelectorAll === "function" ? widgetEl.querySelectorAll("li, a, .item, [class*='item']") : [];
        const items = [];
        for (const itemEl of Array.from(itemEls).slice(0, 12)) {
          const itemText = sanitizeSafeText(itemEl.textContent || "", 60);
          if (itemText) {
            const linkHref = itemEl.tagName === "A"
              ? itemEl.getAttribute?.("href")
              : (typeof itemEl.querySelector === "function" ? itemEl.querySelector("a")?.getAttribute?.("href") : null);
            items.push({
              title: itemText,
              url: linkHref ? sanitizeSafeUrl(linkHref) : ""
            });
          }
        }

        return {
          title: widgetTitle,
          items: items.length > 0 ? items : []
        };
      };

      if (columnElements.length > 0) {
        for (const colEl of Array.from(columnElements).slice(0, 4)) {
          const widgetEls = colEl.querySelectorAll(".widget, .card, [class*='widget'], [class*='card']");
          const widgets = [];
          for (const w of Array.from(widgetEls).slice(0, 8)) {
            const parsed = processWidget(w);
            if (parsed) widgets.push(parsed);
          }
          if (widgets.length > 0) {
            columns.push({ widgets });
          }
        }
      } else {
        const widgetEls = rootDocument.querySelectorAll(".widget, .card, [class*='widget'], [class*='card']");
        const widgets = [];
        for (const w of Array.from(widgetEls).slice(0, 16)) {
          const parsed = processWidget(w);
          if (parsed) widgets.push(parsed);
        }
        if (widgets.length > 0) {
          columns.push({ widgets });
        }
      }

      return {
        version: 1,
        savedAt: Date.now(),
        targetUrl: normalizeNavigableUrl(targetUrl),
        theme,
        pageTitle: title,
        columns
      };
    } catch {
      return null;
    }
  }

  let previewLayer = null;
  let promptCard = null;

  function ensureLoadingOverlay(settings = null) {
    if (loadingHost || !document.documentElement) {
      return;
    }

    const host = document.createElement("div");
    host.id = "keep-fnnas-login-loading";
    const shadow = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = `
      :host { all: initial; }
      .screen {
        position: fixed;
        z-index: 2147483647;
        inset: 0;
        overflow: hidden;
        color: #17243d;
        background:
          radial-gradient(circle at 20% 15%, rgba(52,122,240,.15), transparent 34rem),
          radial-gradient(circle at 82% 86%, rgba(56,198,165,.16), transparent 32rem),
          #f5f7fb;
        font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        -webkit-font-smoothing: antialiased;
        pointer-events: none;
        user-select: none;
        box-sizing: border-box;
      }
      .screen.dark {
        color: #f0f4fc;
        background:
          radial-gradient(circle at 20% 15%, rgba(52,122,240,.22), transparent 34rem),
          radial-gradient(circle at 82% 86%, rgba(56,198,165,.13), transparent 32rem),
          #0e1420;
      }
      .preview-layer {
        width: 100vw;
        min-height: 100vh;
        padding: 2.5rem 3.5rem;
        box-sizing: border-box;
      }
      .glance-preview-layout {
        max-width: 1400px;
        margin: 0 auto;
        display: flex;
        flex-direction: column;
        gap: 1.5rem;
      }
      .glance-preview-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 0.5rem 0;
      }
      .glance-preview-title {
        font-size: 1.75rem;
        font-weight: 700;
        letter-spacing: -0.02em;
      }
      .glance-preview-stale-badge {
        font-size: 0.8rem;
        font-weight: 500;
        padding: 0.25rem 0.65rem;
        border-radius: 9999px;
        background: rgba(43, 111, 244, 0.12);
        color: #2b6ff4;
        border: 1px solid rgba(43, 111, 244, 0.2);
      }
      .screen.dark .glance-preview-stale-badge {
        background: rgba(43, 111, 244, 0.2);
        color: #8cb3ff;
      }
      .glance-preview-columns {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
        gap: 1.5rem;
        align-items: start;
      }
      .glance-preview-col {
        display: flex;
        flex-direction: column;
        gap: 1.25rem;
      }
      .glance-preview-card {
        border: 1px solid rgba(44, 62, 92, 0.1);
        border-radius: 1rem;
        background: rgba(255, 255, 255, 0.85);
        box-shadow: 0 4px 20px rgba(0, 0, 0, 0.04);
        padding: 1.25rem 1.35rem;
        backdrop-filter: blur(12px);
        display: flex;
        flex-direction: column;
        gap: 0.85rem;
      }
      .screen.dark .glance-preview-card {
        border-color: rgba(190, 208, 240, 0.1);
        background: rgba(22, 29, 43, 0.8);
        box-shadow: 0 4px 20px rgba(0, 0, 0, 0.2);
      }
      .glance-card-header {
        font-size: 1.05rem;
        font-weight: 650;
        color: #162033;
      }
      .screen.dark .glance-card-header {
        color: #eef3ff;
      }
      .glance-card-body {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
      }
      .glance-card-item {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 0.35rem 0;
        border-bottom: 1px solid rgba(44, 62, 92, 0.06);
        font-size: 0.9rem;
        color: #4b5870;
      }
      .screen.dark .glance-card-item {
        border-bottom-color: rgba(190, 208, 240, 0.08);
        color: #aebad0;
      }
      .glance-skeleton-bar {
        background: linear-gradient(90deg, rgba(44, 62, 92, 0.06) 25%, rgba(44, 62, 92, 0.12) 50%, rgba(44, 62, 92, 0.06) 75%);
        background-size: 200% 100%;
        animation: shimmer 1.8s infinite;
        border-radius: 6px;
      }
      .screen.dark .glance-skeleton-bar {
        background: linear-gradient(90deg, rgba(190, 208, 240, 0.06) 25%, rgba(190, 208, 240, 0.12) 50%, rgba(190, 208, 240, 0.06) 75%);
        background-size: 200% 100%;
      }
      .glance-skeleton-title { width: 140px; height: 28px; }
      .glance-skeleton-time { width: 80px; height: 20px; }
      .skeleton-card .card-title { width: 50%; height: 18px; margin-bottom: 0.5rem; }
      .skeleton-card .card-line { width: 90%; height: 14px; }
      .skeleton-card .card-line.short { width: 60%; }
      @keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }

      .card {
        display: none;
        width: min(440px, calc(100vw - 44px));
        margin: 15vh auto 0;
        padding: 42px 34px 34px;
        text-align: center;
        pointer-events: auto;
      }
      .animation { position: relative; width: 106px; height: 106px; margin: 0 auto 28px; }
      .ring { position: absolute; inset: 3px; border: 2px solid rgba(52,122,240,.13); border-top-color: #347af0; border-radius: 50%; animation: spin 1.15s linear infinite; }
      .ring.secondary { inset: 13px; border-color: rgba(56,198,165,.12); border-right-color: #38c6a5; animation-duration: 1.7s; animation-direction: reverse; }
      .mark { position: absolute; inset: 24px; display: grid; place-items: center; border-radius: 17px; color: white; background: #347af0; box-shadow: 0 12px 28px rgba(52,122,240,.28); font-size: 25px; font-weight: 850; animation: breathe 1.8s ease-in-out infinite alternate; }
      h1 { margin: 0; font-size: 22px; letter-spacing: -.02em; }
      p { min-height: 42px; margin: 10px auto 19px; color: #6f7c92; font-size: 14px; line-height: 1.55; }
      .screen.dark p { color: #a7b4c9; }
      .dots { display: flex; justify-content: center; gap: 7px; }
      .dots i { width: 6px; height: 6px; border-radius: 50%; background: #347af0; animation: dot 1.2s ease-in-out infinite; }
      .dots i:nth-child(2) { animation-delay: .16s; }
      .dots i:nth-child(3) { animation-delay: .32s; }
      button { display: none; min-height: 38px; margin: 23px auto 0; padding: 0 15px; border: 1px solid rgba(52,122,240,.25); border-radius: 9px; color: #285fae; background: rgba(255,255,255,.7); font: 650 13px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; cursor: pointer; }
      .screen.dark button { border-color: rgba(140,179,255,.3); color: #c4d8ff; background: rgba(32,44,65,.85); }
      button.visible { display: block; }
      @keyframes spin { to { transform: rotate(360deg); } }
      @keyframes breathe { to { transform: scale(.94); box-shadow: 0 8px 20px rgba(52,122,240,.2); } }
      @keyframes dot { 0%, 75%, 100% { transform: translateY(0); opacity: .35; } 35% { transform: translateY(-5px); opacity: 1; } }
      @media (prefers-reduced-motion: reduce) { .ring, .mark, .dots i { animation-duration: 3s; } }
    `;

    const screen = document.createElement("div");
    screen.className = `screen${useDarkTheme(settings) ? " dark" : ""}`;

    previewLayer = document.createElement("div");
    previewLayer.className = "preview-layer";
    previewLayer.innerHTML = renderGlanceSkeletonHtml();

    promptCard = document.createElement("div");
    promptCard.className = "card";
    const animation = document.createElement("div");
    animation.className = "animation";
    const ring = document.createElement("span");
    ring.className = "ring";
    const secondaryRing = document.createElement("span");
    secondaryRing.className = "ring secondary";
    const mark = document.createElement("span");
    mark.className = "mark";
    mark.textContent = "G";
    animation.append(ring, secondaryRing, mark);

    const title = document.createElement("h1");
    title.textContent = "正在载入 Glance";
    loadingText = document.createElement("p");
    loadingText.textContent = "正在检查并恢复 fnOS 登录状态…";
    const dots = document.createElement("div");
    dots.className = "dots";
    dots.append(document.createElement("i"), document.createElement("i"), document.createElement("i"));
    loadingButton = document.createElement("button");
    loadingButton.type = "button";
    loadingButton.textContent = "显示 FN Connect / fnOS 页面";
    loadingButton.addEventListener("click", () => {
      loadingManuallyDismissed = true;
      removeLoadingOverlay();
      setBadge("请在 fnOS 页面完成登录，成功后将自动打开 Glance。");
    });

    promptCard.append(animation, title, loadingText, dots, loadingButton);
    screen.append(previewLayer, promptCard);
    shadow.append(style, screen);
    host.style.setProperty("all", "initial", "important");
    document.documentElement.append(host);
    loadingHost = host;
    loadingScreen = screen;

    // Asynchronously check storage for current location preview ONLY (no cross-target fallback)
    void (async () => {
      try {
        const curKey = previewStorageKey(location.href);
        const stored = await chrome.storage.local.get([curKey]);
        const preview = stored?.[curKey];
        if (preview && previewLayer && (!promptCard || promptCard.style.display === "none" || !promptCard.style.display)) {
          const status = getPreviewStatus(preview);
          if (status === "fresh" || status === "stale") {
            if (preview.theme === "dark") {
              screen.classList.add("dark");
            } else if (preview.theme === "light") {
              screen.classList.remove("dark");
            }
            previewLayer.innerHTML = renderGlancePreviewHtml(preview, status);
          }
        }
      } catch {
        // Keep skeleton
      }
    })();
  }

  function setLoading(message, settings, showPageButton = false) {
    if (loadingManuallyDismissed) {
      return;
    }
    removeBadge();
    ensureLoadingOverlay(settings);
    if (previewLayer) {
      previewLayer.style.display = "none";
    }
    if (promptCard) {
      promptCard.style.display = "block";
    }
    if (loadingText) {
      loadingText.textContent = message;
    }
    loadingButton?.classList.toggle("visible", showPageButton);
  }

  function removeLoadingOverlay() {
    loadingHost?.remove();
    loadingHost = null;
    loadingScreen = null;
    loadingText = null;
    loadingButton = null;
    previewLayer = null;
    promptCard = null;
  }

  function fadeOutLoadingOverlay(onComplete = null) {
    if (!loadingHost) {
      onComplete?.();
      return;
    }
    const host = loadingHost;
    const screen = loadingScreen;

    if (screen) {
      let finished = false;
      const finish = () => {
        if (finished) {
          return;
        }
        finished = true;
        screen.removeEventListener("transitionend", onTransitionEnd);
        if (loadingHost === host) {
          removeLoadingOverlay();
        } else {
          host.remove();
        }
        onComplete?.();
      };

      const onTransitionEnd = (e) => {
        if (e.target === screen && (e.propertyName === "opacity" || !e.propertyName)) {
          finish();
        }
      };

      screen.addEventListener("transitionend", onTransitionEnd);
      screen.style.transition = "opacity 140ms ease-out";
      screen.style.opacity = "0";

      // Fallback timer in case transitionend does not fire
      window.setTimeout(finish, 180);
    } else {
      removeLoadingOverlay();
      onComplete?.();
    }
  }

  async function waitForVisualReady() {
    await waitForDocument();
    const hasRenderableContent = () => {
      if (!document.body) {
        return false;
      }
      if (document.body.innerText?.trim()) {
        return true;
      }
      return [...document.body.children].some((element) => {
        if (["SCRIPT", "STYLE", "LINK", "TEMPLATE"].includes(element.tagName)) {
          return false;
        }
        return element.getClientRects().length > 0;
      });
    };
    while (!hasRenderableContent()) {
      await new Promise((resolve) => window.requestAnimationFrame(resolve));
    }
    await new Promise((resolve) => window.requestAnimationFrame(() => {
      window.requestAnimationFrame(resolve);
    }));
  }

  function ensureBadge() {
    if (badge || !document.documentElement) {
      return;
    }

    const host = document.createElement("div");
    host.id = "keep-fnnas-login-status";
    const shadow = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = `
      :host { all: initial; }
      .box {
        position: fixed;
        z-index: 2147483647;
        top: 16px;
        right: 16px;
        display: flex;
        align-items: center;
        gap: 10px;
        max-width: min(420px, calc(100vw - 32px));
        padding: 11px 14px;
        border: 1px solid rgba(255,255,255,.2);
        border-radius: 12px;
        color: #fff;
        background: rgba(20, 27, 41, .93);
        box-shadow: 0 10px 32px rgba(0,0,0,.25);
        font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        -webkit-font-smoothing: antialiased;
        backdrop-filter: blur(14px);
      }
      .dot {
        width: 8px;
        height: 8px;
        flex: 0 0 auto;
        border-radius: 50%;
        background: #58d7b1;
        box-shadow: 0 0 0 5px rgba(88,215,177,.13);
        animation: pulse 1.2s ease-in-out infinite alternate;
      }
      button {
        display: none;
        flex: 0 0 auto;
        padding: 5px 9px;
        border: 0;
        border-radius: 7px;
        color: #122039;
        background: #fff;
        font: 600 12px/1.3 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        cursor: pointer;
      }
      button.visible { display: inline-block; }
      @keyframes pulse { to { opacity: .45; } }
    `;

    const box = document.createElement("div");
    box.className = "box";
    const dot = document.createElement("span");
    dot.className = "dot";
    badgeText = document.createElement("span");
    badgeText.textContent = "正在恢复 fnOS 登录…";
    badgeButton = document.createElement("button");
    badgeButton.type = "button";
    badgeButton.textContent = "重新检测";
    badgeButton.addEventListener("click", async () => {
      badgeButton.classList.remove("visible");
      badgeText.textContent = "正在重新检测 fnOS 登录…";
      const response = await send({ type: "MANUAL_RETRY" });
      if (response?.action !== "navigating") {
        window.setTimeout(() => window.location.reload(), 200);
      }
    });
    box.append(dot, badgeText, badgeButton);
    shadow.append(style, box);
    host.style.setProperty("all", "initial", "important");
    document.documentElement.append(host);
    badge = host;
  }

  function setBadge(message, showRetry = false) {
    ensureBadge();
    if (badgeText) {
      badgeText.textContent = message;
    }
    badgeButton?.classList.toggle("visible", showRetry);
  }

  function removeBadge() {
    badge?.remove();
    badge = null;
    badgeText = null;
    badgeButton = null;
  }

  function createProbeId() {
    probeSequence = (probeSequence + 1) % Number.MAX_SAFE_INTEGER;
    const randomValues = new Uint32Array(2);
    try {
      if (typeof globalThis.crypto?.getRandomValues === "function") {
        globalThis.crypto.getRandomValues(randomValues);
      } else {
        randomValues[0] = Math.floor(Math.random() * 0x100000000);
        randomValues[1] = Math.floor(Math.random() * 0x100000000);
      }
    } catch {
      randomValues[0] = Math.floor(Math.random() * 0x100000000);
      randomValues[1] = Math.floor(Math.random() * 0x100000000);
    }
    return [
      "probe",
      Date.now().toString(36),
      probeSequence.toString(36),
      randomValues[0].toString(36),
      randomValues[1].toString(36)
    ].join("-");
  }

  function pageProbe(url) {
    return new Promise((resolve) => {
      let parsed;
      try {
        parsed = new URL(url);
      } catch {
        resolve({ ok: false, reason: "invalid-url", via: "page" });
        return;
      }

      if (parsed.origin !== location.origin) {
        resolve({ ok: false, reason: "cross-origin", via: "page" });
        return;
      }

      const id = createProbeId();
      const timeout = window.setTimeout(() => {
        window.removeEventListener(RESPONSE_EVENT, onResponse);
        resolve({ ok: false, reason: "timeout", via: "page" });
      }, PROBE_TIMEOUT_MS);

      function onResponse(event) {
        if (event.detail?.id !== id) {
          return;
        }
        window.clearTimeout(timeout);
        window.removeEventListener(RESPONSE_EVENT, onResponse);
        resolve({ ...event.detail, via: "page" });
      }

      window.addEventListener(RESPONSE_EVENT, onResponse);
      window.dispatchEvent(new CustomEvent(REQUEST_EVENT, {
        detail: { id, url: parsed.href }
      }));
    });
  }

  async function probeAuth(checkUrl) {
    let pageResult;
    try {
      pageResult = await pageProbe(localizeFnOsUrl(checkUrl));
    } catch {
      pageResult = { ok: false, reason: "probe-error", via: "page" };
    }
    if (pageResult.ok) {
      return pageResult;
    }
    const backgroundResult = await send({ type: "PROBE_AUTH" });
    return {
      ...(backgroundResult ?? { ok: false }),
      via: backgroundResult?.via ?? "background"
    };
  }

  function createDockerProbeFrame(checkUrl) {
    let probeUrl;
    try {
      probeUrl = new URL(checkUrl);
    } catch {
      return null;
    }
    probeUrl.searchParams.set("__keep_fnnas_probe", String(Date.now()));

    const frame = document.createElement("iframe");
    frame.id = "keep-fnnas-login-docker-probe";
    frame.src = probeUrl.href;
    frame.setAttribute("aria-hidden", "true");
    frame.setAttribute("tabindex", "-1");
    frame.style.cssText = [
      "position:fixed",
      "left:-10000px",
      "top:-10000px",
      "width:1px",
      "height:1px",
      "opacity:0",
      "pointer-events:none",
      "border:0"
    ].join(";");
    document.documentElement.append(frame);
    return frame;
  }

  async function recoverPending(pending, settings) {
    if (pending.phase === "lan-discovery") {
      await waitForDocument();
      removeLoadingOverlay();
      setBadge("请从 fnOS 桌面打开 Docker 中的 Glance，插件会自动识别局域网地址。");
      window.setTimeout(() => {
        if (!stopped) {
          setBadge("Docker Glance 识别已超时，点击后可以重新检测。", true);
        }
      }, LAN_DISCOVERY_TIMEOUT_MS);
      return;
    }

    if (pending.phase === "lan-helper") {
      await waitForDocument();
      removeLoadingOverlay();
      setBadge("fnOS 局域网会话已恢复，正在新标签页确认 Glance。");
      return;
    }

    if (pending.phase === "lan-root") {
      await waitForDocument();
      removeLoadingOverlay();
      setBadge("正在确认 fnOS 局域网登录状态；如出现登录页面，请先完成登录。");
      let round = 0;
      const openTarget = async () => {
        setBadge("fnOS 登录已恢复，正在新标签页打开 Glance…");
        const response = await send({ type: "LAN_NATIVE_READY" });
        if (response?.action === "navigating") {
          stopped = true;
          return;
        }
        stopped = true;
        setBadge("自动打开 Glance 未完成，点击后重新检测。", true);
      };
      const check = async () => {
        if (stopped) {
          return;
        }
        const result = await probeAuth(pending.checkUrl);
        if (result.ok) {
          await openTarget();
          return;
        }
        if (pageContainsLoginForm()) {
          setBadge("请完成 fnOS 登录；成功后将自动打开 Glance。");
        }
        const delay = PROBE_DELAYS_MS[Math.min(round, PROBE_DELAYS_MS.length - 1)];
        round += 1;
        window.setTimeout(() => void check(), delay);
      };
      await check();
      return;
    }

    if (pending.phase === "target" && isCurrentPage(pending.targetUrl)) {
      ensureLoadingOverlay(settings);
      await waitForVisualReady();
      const renderedFailure = pageAuthenticationFailure();
      if (renderedFailure) {
        setLoading(authenticationFailureMessage(renderedFailure), settings);
        await send({ type: "AUTH_INVALID", reason: renderedFailure });
        return;
      }
      stopped = true;
      await send({ type: "TARGET_READY" });

      try {
        const preview = extractGlancePreview(document, pending.targetUrl);
        if (preview && preview.columns?.length > 0) {
          const key = previewStorageKey(pending.targetUrl);
          const normTarget = normalizeNavigableUrl(pending.targetUrl);
          await chrome.storage.local.set({
            [key]: preview,
            [ACTIVE_PREVIEW_TARGET_KEY]: normTarget
          });
        }
      } catch {
        // Ignore preview save error
      }

      await startKeepAlive(
        pending.recoveryKind === "native-lan"
          ? { ...settings, healthUrl: pending.checkUrl }
          : settings
      );
      await new Promise((resolve) => window.requestAnimationFrame(() => {
        window.requestAnimationFrame(resolve);
      }));
      fadeOutLoadingOverlay();
      return;
    }

    setLoading("正在检查并恢复 fnOS 登录状态…", settings);
    await waitForDocument();
    await new Promise((resolve) => window.setTimeout(resolve, PAGE_SETTLE_MS));

    const initialFailure = pageAuthenticationFailure();
    if (initialFailure) {
      setLoading(authenticationFailureMessage(initialFailure), settings);
      await send({ type: "AUTH_INVALID", reason: initialFailure });
      return;
    }

    const dockerRecovery = isDockerRecovery(pending);
    if (dockerRecovery && pending.phase === "bootstrap") {
      if (isFnConnectBootstrapPage(pending.bootstrapUrl)) {
        setLoading(
          "正在通过 FN Connect 官方入口解析 NAS 并选择连接线路…",
          settings
        );
        window.setTimeout(() => {
          setLoading(
            "FN Connect 仍在检测连接线路；如需查看详情，可以显示官方页面。",
            settings,
            true
          );
        }, BOOTSTRAP_PAGE_TIMEOUT_MS);
        return;
      }

      if (!isCurrentRootOrigin(pending.rootUrl)) {
        setLoading(
          "正在等待 FN Connect 官方入口完成最终线路跳转…",
          settings
        );
        return;
      }

      const completion = await send({ type: "BOOTSTRAP_COMPLETE" });
      if (completion?.pending) {
        pending = completion.pending;
      }
    }

    setLoading(
      dockerRecovery && pending.bootstrapCompletedAt
        ? "FN Connect 官方线路检测已完成，正在确认 Docker 服务…"
        : "正在通过 fnOS 官方页面恢复登录…",
      settings
    );
    const officialBootstrapCompleted = Boolean(
      dockerRecovery && Number(pending.bootstrapCompletedAt ?? 0)
    );
    const dockerProbeFrame = (
      dockerRecovery && pending.phase !== "manual"
    )
      ? createDockerProbeFrame(pending.checkUrl)
      : null;
    let navigationRequested = false;
    let dockerFallbackRequested = false;
    let dockerHealthReadyAt = 0;
    let probeRound = 0;

    function showManualLogin(message, showRetry = false) {
      removeLoadingOverlay();
      setBadge(message, showRetry);
    }

    async function tryTargetAfterGrace() {
      if (stopped || navigationRequested || pending.phase === "manual") {
        return;
      }
      if (dockerRecovery && dockerFallbackRequested) {
        return;
      }
      if (pageContainsLoginForm()) {
        showManualLogin("请在 fnOS 官方页面完成登录，成功后将自动打开主页。");
        return;
      }

      if (dockerRecovery) {
        dockerFallbackRequested = true;
        setLoading(
          "静默检测暂未响应，正在进行一次 Docker 兼容性检查…",
          settings
        );
      }
      navigationRequested = true;
      const response = await send({ type: "TRY_TARGET" });
      if (response?.action === "navigating") {
        stopped = true;
        return;
      }

      navigationRequested = false;
      if (response?.action === "manual") {
        pending.phase = "manual";
        showManualLogin(
          "自动恢复多次未成功；请先完成 fnOS 登录，再重新检测。",
          true
        );
      }
    }

    const rootElapsedAtStart = Date.now() - Number(pending.rootEnteredAt ?? Date.now());
    const fallbackGraceMs = dockerRecovery
      ? officialBootstrapCompleted
        ? DOCKER_BOOTSTRAP_FALLBACK_GRACE_MS
        : DOCKER_FALLBACK_GRACE_MS
      : ROOT_GRACE_MS;
    const fallbackTimer = window.setTimeout(() => {
      void tryTargetAfterGrace();
    }, Math.max(0, fallbackGraceMs - rootElapsedAtStart));

    async function tick() {
      if (stopped) {
        return;
      }

      const result = await probeAuth(pending.checkUrl);
      if (stopped) {
        return;
      }
      if (result.ok) {
        if (pending.phase === "manual") {
          showManualLogin(
            dockerRecovery
              ? "fnOS 会话有效，但 Docker 服务连续两次未授权；请重新检测。"
              : "已检测到 fnOS 会话，点击后重试主页。",
            true
          );
          return;
        }
        if (dockerRecovery) {
          const now = Date.now();
          const strongReady = Boolean(result.strongReady);
          const minimumRootDwellMs = officialBootstrapCompleted
            ? DOCKER_BOOTSTRAP_MIN_ROOT_DWELL_MS
            : strongReady
              ? DOCKER_FAST_MIN_ROOT_DWELL_MS
              : DOCKER_MIN_ROOT_DWELL_MS;
          const readyStabilityMs = officialBootstrapCompleted
            ? DOCKER_BOOTSTRAP_READY_STABILITY_MS
            : strongReady
              ? DOCKER_FAST_READY_STABILITY_MS
              : DOCKER_READY_STABILITY_MS;
          if (!dockerHealthReadyAt) {
            dockerHealthReadyAt = now;
          }
          const rootElapsed = now - Number(pending.rootEnteredAt ?? now);
          const readyElapsed = now - dockerHealthReadyAt;
          if (
            rootElapsed < minimumRootDwellMs
            || readyElapsed < readyStabilityMs
          ) {
            setLoading(
              strongReady
                ? officialBootstrapCompleted
                  ? "FN Connect 官方检测与 Docker 检测均已通过，正在打开 Glance…"
                  : "FN Connect 双重检测已通过，正在快速打开 Docker Glance…"
                : "fnOS 会话已恢复，正在等待 FN Connect 完成 Docker 服务授权…",
              settings
            );
            return;
          }
        }
        if (navigationRequested) {
          return;
        }
        navigationRequested = true;
        setLoading("fnOS 登录已恢复，正在打开 Glance…", settings);
        const response = await send({
          type: "AUTH_READY",
          via: result.via
        });
        if (response?.action === "navigating") {
          stopped = true;
          dockerProbeFrame?.remove();
        } else {
          navigationRequested = false;
        }
        return;
      }

      if (dockerRecovery) {
        dockerHealthReadyAt = 0;
      }
      const elapsed = Date.now() - Number(pending.startedAt ?? Date.now());
      if (pending.phase === "manual") {
        showManualLogin(
          dockerRecovery
            ? "Docker 服务连续两次未能获得 FN Connect 授权；请重新检测。"
            : "自动恢复多次未成功；请先完成 fnOS 登录，再重新检测。",
          true
        );
        return;
      }

      if (pageContainsLoginForm()) {
        showManualLogin("请在 fnOS 官方页面完成登录，成功后将自动打开主页。");
        return;
      }

      if (elapsed >= Number(settings.recoveryTimeoutSeconds) * 1000) {
        setLoading(
          "仍在等待 fnOS 会话；如果需要手动登录，可以显示 fnOS 页面。",
          settings,
          true
        );
      }

      const rootElapsed = Date.now() - Number(pending.rootEnteredAt ?? Date.now());
      if (rootElapsed >= fallbackGraceMs) {
        await tryTargetAfterGrace();
      }
    }

    await tick();
    async function scheduleNextProbe() {
      if (stopped) {
        window.clearTimeout(fallbackTimer);
        return;
      }
      const delay = PROBE_DELAYS_MS[Math.min(probeRound, PROBE_DELAYS_MS.length - 1)];
      probeRound += 1;
      window.setTimeout(async () => {
        await tick();
        await scheduleNextProbe();
      }, delay);
    }
    await scheduleNextProbe();
  }

  async function startKeepAlive(settings) {
    if (!settings.keepAliveEnabled || !settings.healthUrl) {
      return;
    }

    let localizedHealthUrl;
    try {
      localizedHealthUrl = localizeFnOsUrl(settings.healthUrl);
    } catch {
      return;
    }
    if (new URL(localizedHealthUrl).origin !== location.origin) {
      return;
    }

    const intervalMs = Math.max(1, Number(settings.keepAliveMinutes)) * 60 * 1000;
    window.setInterval(() => {
      void pageProbe(localizedHealthUrl);
    }, intervalMs);
  }

  async function main() {
    const hello = await send({ type: "CONTENT_HELLO" });
    if (!hello || hello.error) {
      return;
    }

    if (hello.pending) {
      await recoverPending(hello.pending, hello.settings);
      return;
    }

    await waitForDocument();
    await new Promise((resolve) => window.setTimeout(resolve, PAGE_SETTLE_MS));
    const directFailure = pageAuthenticationFailure();
    const isConfiguredTarget = isCurrentPage(hello.settings.targetUrl)
      || isExactCurrentPage(hello.deviceRoute?.targetUrl);
    if (
      hello.settings?.enabled
      && hello.settings?.fnosRecoveryEnabled
      && isConfiguredTarget
      && directFailure
    ) {
      setLoading(authenticationFailureMessage(directFailure), hello.settings);
      await send({
        type: "START_RECOVERY_CURRENT",
        reason: directFailure
      });
      return;
    }

    await startKeepAlive(
      isExactCurrentPage(hello.deviceRoute?.targetUrl)
        ? { ...hello.settings, healthUrl: hello.deviceRoute.healthUrl }
        : hello.settings
    );

    if (!directFailure) {
      await waitForVisualReady();
      fadeOutLoadingOverlay();
    }
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "LAN_DISCOVERY_STATUS" && message.message) {
      removeLoadingOverlay();
      setBadge(message.message);
    } else if (message?.type === "LAN_DISCOVERY_COMPLETE") {
      stopped = true;
      removeLoadingOverlay();
      removeBadge();
    }
  });

  // Synchronously initialize the Preview / Skeleton overlay at document_start
  ensureLoadingOverlay();

  void main();
})();
