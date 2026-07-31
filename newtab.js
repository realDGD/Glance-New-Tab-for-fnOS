const statusElement = document.querySelector("#status");
const targetLink = document.querySelector("#target-link");
const optionsButton = document.querySelector("#open-options");

optionsButton.addEventListener("click", () => {
  void chrome.runtime.openOptionsPage();
});

function applyTheme(mode) {
  document.documentElement.dataset.theme = ["auto", "light", "dark"].includes(mode)
    ? mode
    : "auto";
}

async function start() {
  const initial = await chrome.runtime.sendMessage({ type: "GET_SETTINGS" });
  if (initial?.error) {
    throw new Error(initial.error);
  }
  applyTheme(initial?.settings?.themeMode);

  if (!initial?.settings?.setupCompleted || !initial.settings.targetUrl) {
    statusElement.textContent = "首次使用，请先填写你的飞牛主页地址。";
    optionsButton.textContent = "开始设置";
    document.body.classList.add("idle");
    return;
  }

  const currentTab = await chrome.tabs.getCurrent();
  const response = await chrome.runtime.sendMessage({
    type: "OPEN_NEW_TAB",
    tabId: currentTab?.id
  });

  if (response?.error) {
    throw new Error(response.error);
  }

  if (response?.action === "stay") {
    statusElement.textContent = "自动打开已暂停，可在扩展设置中重新启用。";
    document.body.classList.add("idle");
    return;
  }

  if (response?.action === "configure") {
    statusElement.textContent = "请先完成飞牛地址设置。";
    optionsButton.textContent = "开始设置";
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

start().catch(async (error) => {
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
