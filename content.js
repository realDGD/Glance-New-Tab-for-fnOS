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
  const PAGE_SETTLE_MS = 80;
  const COMPLETION_HOLD_MS = 30;

  let badge;
  let badgeText;
  let badgeButton;
  let loadingHost;
  let loadingText;
  let loadingButton;
  let loadingManuallyDismissed = false;
  let stopped = false;

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

  function ensureLoadingOverlay(settings) {
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
        display: grid;
        place-items: center;
        overflow: hidden;
        color: #17243d;
        background:
          radial-gradient(circle at 20% 15%, rgba(52,122,240,.15), transparent 34rem),
          radial-gradient(circle at 82% 86%, rgba(56,198,165,.16), transparent 32rem),
          #f5f7fb;
        font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        -webkit-font-smoothing: antialiased;
      }
      .screen.dark {
        color: #f0f4fc;
        background:
          radial-gradient(circle at 20% 15%, rgba(52,122,240,.22), transparent 34rem),
          radial-gradient(circle at 82% 86%, rgba(56,198,165,.13), transparent 32rem),
          #0e1420;
      }
      .card {
        width: min(440px, calc(100vw - 44px));
        padding: 42px 34px 34px;
        text-align: center;
      }
      .animation {
        position: relative;
        width: 106px;
        height: 106px;
        margin: 0 auto 28px;
      }
      .ring {
        position: absolute;
        inset: 3px;
        border: 2px solid rgba(52,122,240,.13);
        border-top-color: #347af0;
        border-radius: 50%;
        animation: spin 1.15s linear infinite;
      }
      .ring.secondary {
        inset: 13px;
        border-color: rgba(56,198,165,.12);
        border-right-color: #38c6a5;
        animation-duration: 1.7s;
        animation-direction: reverse;
      }
      .mark {
        position: absolute;
        inset: 24px;
        display: grid;
        place-items: center;
        border-radius: 17px;
        color: white;
        background: #347af0;
        box-shadow: 0 12px 28px rgba(52,122,240,.28);
        font-size: 25px;
        font-weight: 850;
        animation: breathe 1.8s ease-in-out infinite alternate;
      }
      h1 {
        margin: 0;
        font-size: 22px;
        letter-spacing: -.02em;
      }
      p {
        min-height: 42px;
        margin: 10px auto 19px;
        color: #6f7c92;
        font-size: 14px;
        line-height: 1.55;
      }
      .dark p { color: #a7b4c9; }
      .dots {
        display: flex;
        justify-content: center;
        gap: 7px;
      }
      .dots i {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: #347af0;
        animation: dot 1.2s ease-in-out infinite;
      }
      .dots i:nth-child(2) { animation-delay: .16s; }
      .dots i:nth-child(3) { animation-delay: .32s; }
      button {
        display: none;
        min-height: 38px;
        margin: 23px auto 0;
        padding: 0 15px;
        border: 1px solid rgba(52,122,240,.25);
        border-radius: 9px;
        color: #285fae;
        background: rgba(255,255,255,.7);
        font: 650 13px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        cursor: pointer;
      }
      .dark button {
        border-color: rgba(140,179,255,.3);
        color: #c4d8ff;
        background: rgba(32,44,65,.85);
      }
      button.visible { display: block; }
      @keyframes spin { to { transform: rotate(360deg); } }
      @keyframes breathe { to { transform: scale(.94); box-shadow: 0 8px 20px rgba(52,122,240,.2); } }
      @keyframes dot {
        0%, 75%, 100% { transform: translateY(0); opacity: .35; }
        35% { transform: translateY(-5px); opacity: 1; }
      }
      @media (prefers-reduced-motion: reduce) {
        .ring, .mark, .dots i { animation-duration: 3s; }
      }
    `;

    const screen = document.createElement("div");
    screen.className = `screen${useDarkTheme(settings) ? " dark" : ""}`;
    const card = document.createElement("div");
    card.className = "card";
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
    dots.append(
      document.createElement("i"),
      document.createElement("i"),
      document.createElement("i")
    );
    loadingButton = document.createElement("button");
    loadingButton.type = "button";
    loadingButton.textContent = "显示 FN Connect / fnOS 页面";
    loadingButton.addEventListener("click", () => {
      loadingManuallyDismissed = true;
      removeLoadingOverlay();
      setBadge("请在 fnOS 页面完成登录，成功后将自动打开 Glance。");
    });

    card.append(animation, title, loadingText, dots, loadingButton);
    screen.append(card);
    shadow.append(style, screen);
    host.style.setProperty("all", "initial", "important");
    document.documentElement.append(host);
    loadingHost = host;
  }

  function setLoading(message, settings, showPageButton = false) {
    if (loadingManuallyDismissed) {
      return;
    }
    removeBadge();
    ensureLoadingOverlay(settings);
    if (loadingText) {
      loadingText.textContent = message;
    }
    loadingButton?.classList.toggle("visible", showPageButton);
  }

  function removeLoadingOverlay() {
    loadingHost?.remove();
    loadingHost = null;
    loadingText = null;
    loadingButton = null;
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

      const id = crypto.randomUUID();
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
    const pageResult = await pageProbe(localizeFnOsUrl(checkUrl));
    if (pageResult.ok || pageResult.reason !== "cross-origin") {
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
    setLoading("正在检查并恢复 fnOS 登录状态…", settings);
    await waitForDocument();
    await new Promise((resolve) => window.setTimeout(resolve, PAGE_SETTLE_MS));

    const initialFailure = pageAuthenticationFailure();
    if (initialFailure) {
      setLoading(authenticationFailureMessage(initialFailure), settings);
      await send({ type: "AUTH_INVALID", reason: initialFailure });
      return;
    }

    if (pending.phase === "target" && isCurrentPage(pending.targetUrl)) {
      setLoading("Glance 已响应，正在完成页面渲染…", settings);
      await waitForVisualReady();
      const renderedFailure = pageAuthenticationFailure();
      if (renderedFailure) {
        setLoading(authenticationFailureMessage(renderedFailure), settings);
        await send({ type: "AUTH_INVALID", reason: renderedFailure });
        return;
      }
      stopped = true;
      setLoading("Glance 已就绪。", settings);
      await send({ type: "TARGET_READY" });
      await startKeepAlive(settings);
      await new Promise((resolve) => window.setTimeout(resolve, COMPLETION_HOLD_MS));
      removeLoadingOverlay();
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
    if (
      hello.settings?.enabled
      && hello.settings?.fnosRecoveryEnabled
      && isCurrentPage(hello.settings.targetUrl)
      && directFailure
    ) {
      setLoading(authenticationFailureMessage(directFailure), hello.settings);
      await send({
        type: "START_RECOVERY_CURRENT",
        reason: directFailure
      });
      return;
    }

    await startKeepAlive(hello.settings);
  }

  void main();
})();
