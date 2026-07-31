(() => {
  if (window.top === window) {
    return;
  }

  let current;
  try {
    current = new URL(window.location.href);
  } catch {
    return;
  }
  if (current.pathname.replace(/\/+$/, "") !== "/api/healthz") {
    return;
  }

  const PROBE_DELAYS_MS = [400, 800, 1200];

  function waitForDocument() {
    if (document.readyState !== "loading") {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      document.addEventListener("DOMContentLoaded", resolve, { once: true });
    });
  }

  function inspectResult() {
    const title = document.title?.trim() ?? "";
    const body = document.body?.innerText?.trim() ?? "";
    const content = `${title}\n${body}`;
    if (
      /\binvalid\s+token\b/i.test(content)
      || /FN\s*Connect[\s\S]{0,160}(?:暂无权限|无权限)[\s\S]{0,60}(?:访问)?(?:该)?服务/i
        .test(content)
    ) {
      return "denied";
    }
    if (body === "" || body.toLowerCase() === "ok") {
      return "ready";
    }
    return "unknown";
  }

  async function main() {
    await waitForDocument();
    await new Promise((resolve) => window.setTimeout(resolve, 50));

    const result = inspectResult();
    await chrome.runtime.sendMessage({
      type: "DOCKER_FRAME_PROBE_RESULT",
      result
    }).catch(() => null);
    if (result === "ready") {
      return;
    }

    const round = Math.max(
      0,
      Number.parseInt(current.searchParams.get("__keep_fnnas_probe_round") ?? "0", 10)
    );
    const delay = PROBE_DELAYS_MS[Math.min(round, PROBE_DELAYS_MS.length - 1)];
    window.setTimeout(() => {
      current.searchParams.set("__keep_fnnas_probe", String(Date.now()));
      current.searchParams.set("__keep_fnnas_probe_round", String(round + 1));
      window.location.replace(current.href);
    }, delay);
  }

  void main();
})();
