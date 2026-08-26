const statusElement = document.querySelector("#status");
const targetLink = document.querySelector("#target-link");
const optionsButton = document.querySelector("#open-options");
const allowLanButton = document.querySelector("#allow-lan");

optionsButton.addEventListener("click", () => {
  void chrome.runtime.openOptionsPage();
});

function applyTheme(mode) {
  document.documentElement.dataset.theme = ["auto", "light", "dark"].includes(mode)
    ? mode
    : "auto";
}

async function start() {
  const response = await chrome.runtime.sendMessage({
    type: "OPEN_NEW_TAB"
  });

  if (response?.error) {
    throw new Error(response.error);
  }

  applyTheme(response?.themeMode);

  if (response?.action === "configure") {
    statusElement.textContent = "首次使用，请先填写你的飞牛主页地址。";
    optionsButton.textContent = "开始设置";
    document.body.classList.add("idle");
    return;
  }

  if (response?.action === "stay") {
    statusElement.textContent = "自动打开已暂停，可在扩展设置中重新启用。";
    document.body.classList.add("idle");
    return;
  }

  if (response?.action === "recovering-startup") {
    statusElement.textContent = "浏览器刚刚启动，正在先恢复 fnOS 登录，再进入 Glance…";
  } else if (response?.action === "checking-target") {
    statusElement.textContent = "正在载入 Glance；只有登录失效时才会进入 fnOS 恢复…";
  } else {
    statusElement.textContent = "正在跳转到设定的网址…";
  }
}

async function startLanSetup() {
  const initial = await chrome.runtime.sendMessage({ type: "GET_SETTINGS" });
  applyTheme(initial?.settings?.themeMode);
  const setup = await chrome.runtime.sendMessage({ type: "GET_LAN_SETUP" });
  if (setup?.error || setup?.action !== "permission-required") {
    throw new Error(setup?.error || "局域网识别状态已经失效，请重新打开新标签页");
  }

  document.body.classList.add("lan-setup", "idle");
  document.querySelector("h1").textContent = setup.docker
    ? "准备识别 Docker Glance"
    : "准备打开局域网 Glance";
  statusElement.textContent = setup.docker && !setup.hasTarget
    ? `已检测到 fnOS 局域网地址 ${setup.lanRootUrl}。允许后，请从 fnOS 桌面打开 Docker 中的 Glance，插件会自动验证并记住地址。`
    : setup.docker
      ? `已检测到 fnOS 局域网地址 ${setup.lanRootUrl}。允许后，插件会确认登录并打开已保存的局域网 Glance 地址 ${setup.lanTargetUrl}。`
      : `已检测到 fnOS 局域网地址 ${setup.lanRootUrl}，最终将打开 ${setup.lanTargetUrl}。首次需要允许访问；随后会先确认 fnOS 登录，再用新标签页打开局域网 Glance。`;
  allowLanButton.hidden = false;
  allowLanButton.textContent = setup.docker && !setup.hasTarget
    ? "允许并开始识别"
    : "允许并打开局域网 Glance";
  allowLanButton.addEventListener("click", async () => {
    try {
      allowLanButton.disabled = true;
      statusElement.textContent = "正在请求这台 NAS 的局域网访问权限…";
      const granted = await chrome.permissions.request({
        origins: [setup.originPattern]
      });
      if (!granted) {
        allowLanButton.disabled = false;
        statusElement.textContent = "未获得局域网权限。你可以再次允许，或者在扩展设置中手动填写地址。";
        return;
      }
      try {
        await fetch(setup.lanRootUrl, {
          cache: "no-store",
          credentials: "include",
          redirect: "follow",
          targetAddressSpace: "local"
        });
      } catch {
        // Chrome 142+ may use this foreground request to ask for Local Network Access.
        // The fnOS desktop navigation below remains the authoritative connection test.
      }
      statusElement.textContent = setup.docker && !setup.hasTarget
        ? "正在返回 fnOS 桌面；请打开 Docker 中的 Glance…"
        : setup.docker
          ? `权限已授予，正在确认会话并打开 ${setup.lanTargetUrl}…`
          : `权限已授予，正在通过 ${setup.lanRootUrl} 确认登录；随后将打开 ${setup.lanTargetUrl}…`;
      const response = await chrome.runtime.sendMessage({ type: "START_LAN_SETUP" });
      if (response?.error || response?.action === "permission-required") {
        throw new Error(response?.error || "Chrome 尚未授予局域网权限");
      }
    } catch (error) {
      allowLanButton.disabled = false;
      statusElement.textContent = `局域网识别启动失败：${error.message}`;
      document.body.classList.add("error");
    }
  });
}

const mode = new URLSearchParams(location.search).get("mode");
const entry = mode === "lan-setup" ? startLanSetup : start;

entry().catch(async (error) => {
  console.error(error);
  statusElement.textContent = `打开失败：${error.message}`;
  document.body.classList.add("error");
  try {
    const { settings } = await chrome.runtime.sendMessage({ type: "GET_SETTINGS" });
    if (settings?.targetUrl) {
      targetLink.href = settings.targetUrl;
      targetLink.hidden = false;
    }
  } catch {
    // 设置也无法读取时保留本地错误页。
  }
});
