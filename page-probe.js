(() => {
  const REQUEST_EVENT = "keep-fnnas-login:probe-request";
  const RESPONSE_EVENT = "keep-fnnas-login:probe-response";

  function respond(detail) {
    window.dispatchEvent(new CustomEvent(RESPONSE_EVENT, { detail }));
  }

  window.addEventListener(REQUEST_EVENT, async (event) => {
    const id = event.detail?.id;
    const requestedUrl = event.detail?.url;
    if (typeof id !== "string" || typeof requestedUrl !== "string") {
      return;
    }

    let parsed;
    try {
      parsed = new URL(requestedUrl, window.location.href);
    } catch {
      respond({ id, ok: false, reason: "invalid-url" });
      return;
    }

    // MAIN world 只替扩展做同源健康检查，不会成为跨站请求代理。
    if (parsed.origin !== window.location.origin) {
      respond({ id, ok: false, reason: "cross-origin" });
      return;
    }

    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 1500);
    try {
      const response = await fetch(parsed.href, {
        cache: "no-store",
        credentials: "include",
        redirect: "follow",
        signal: controller.signal
      });
      const body = (await response.text()).trim().toLowerCase();
      respond({
        id,
        ok: response.ok && (body === "" || body === "ok"),
        status: response.status
      });
    } catch (error) {
      respond({
        id,
        ok: false,
        reason: error?.name === "AbortError" ? "timeout" : "network"
      });
    } finally {
      window.clearTimeout(timeout);
    }
  });
})();
