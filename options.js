import {
  DEFAULT_SETTINGS,
  inferFnOsHealthUrl,
  inferFnOsRootUrl,
  isFnOsUrl,
  sanitizeSettings,
  validateRecoverySettings
} from "./shared.js";

const form = document.querySelector("#settings-form");
const enabled = document.querySelector("#enabled");
const targetUrl = document.querySelector("#target-url");
const recoveryEnabled = document.querySelector("#recovery-enabled");
const recoveryFields = document.querySelector("#recovery-fields");
const rootUrl = document.querySelector("#root-url");
const healthUrl = document.querySelector("#health-url");
const recoveryTimeout = document.querySelector("#recovery-timeout");
const keepAliveEnabled = document.querySelector("#keepalive-enabled");
const keepAliveMinutes = document.querySelector("#keepalive-minutes");
const inferUrlsButton = document.querySelector("#infer-urls");
const testButton = document.querySelector("#test-recovery");
const resetButton = document.querySelector("#reset-settings");
const status = document.querySelector("#save-status");
const fileAccess = document.querySelector("#file-access");
const setupNotice = document.querySelector("#setup-notice");
const themeMode = document.querySelector("#theme-mode");

function applyTheme(mode) {
  document.documentElement.dataset.theme = ["auto", "light", "dark"].includes(mode)
    ? mode
    : "auto";
}

function showStatus(message, kind = "success") {
  status.textContent = message;
  status.dataset.kind = kind;
  window.clearTimeout(showStatus.timeout);
  showStatus.timeout = window.setTimeout(() => {
    status.textContent = "";
    delete status.dataset.kind;
  }, 5000);
}

function render(settings) {
  setupNotice.hidden = settings.setupCompleted;
  enabled.checked = settings.enabled;
  targetUrl.value = settings.targetUrl;
  recoveryEnabled.checked = settings.fnosRecoveryEnabled;
  rootUrl.value = settings.rootUrl;
  healthUrl.value = settings.healthUrl;
  recoveryTimeout.value = settings.recoveryTimeoutSeconds;
  keepAliveEnabled.checked = settings.keepAliveEnabled;
  keepAliveMinutes.value = settings.keepAliveMinutes;
  themeMode.value = settings.themeMode;
  applyTheme(settings.themeMode);
  updateEnabledStates();
  void updateFileAccessNotice();
}

function updateEnabledStates() {
  recoveryFields.classList.toggle("disabled", !recoveryEnabled.checked);
  for (const control of recoveryFields.querySelectorAll("input, button")) {
    control.disabled = !recoveryEnabled.checked;
  }
  keepAliveMinutes.disabled = !keepAliveEnabled.checked;
}

function collect() {
  return sanitizeSettings({
    setupCompleted: true,
    enabled: enabled.checked,
    targetUrl: targetUrl.value,
    fnosRecoveryEnabled: recoveryEnabled.checked,
    rootUrl: rootUrl.value,
    healthUrl: healthUrl.value,
    recoveryTimeoutSeconds: recoveryTimeout.value,
    keepAliveEnabled: keepAliveEnabled.checked,
    keepAliveMinutes: keepAliveMinutes.value,
    themeMode: themeMode.value
  });
}

function inferRecoveryUrls() {
  if (!isFnOsUrl(targetUrl.value)) {
    throw new Error("主页网址需要是 5ddd.com 或 fnos.net 的应用地址");
  }
  rootUrl.value = inferFnOsRootUrl(targetUrl.value);
  healthUrl.value = inferFnOsHealthUrl(targetUrl.value);
}

async function requestFileAccessIfNeeded(settings) {
  if (!settings.targetUrl.startsWith("file:")) {
    return true;
  }
  const alreadyAllowed = await chrome.extension.isAllowedFileSchemeAccess();
  if (alreadyAllowed) {
    return true;
  }
  try {
    return await chrome.permissions.request({ origins: ["file:///*"] });
  } catch {
    return false;
  }
}

async function updateFileAccessNotice() {
  if (!targetUrl.value.trim().toLowerCase().startsWith("file:")) {
    fileAccess.hidden = true;
    return;
  }
  const allowed = await chrome.extension.isAllowedFileSchemeAccess();
  fileAccess.hidden = false;
  fileAccess.textContent = allowed
    ? "已允许访问本地文件。"
    : "尚未允许访问本地文件。保存时 Chrome 会请求权限；也可在扩展详情中开启“允许访问文件网址”。";
  fileAccess.dataset.kind = allowed ? "success" : "warning";
}

async function save() {
  const settings = collect();
  validateRecoverySettings(settings);
  const hasFileAccess = await requestFileAccessIfNeeded(settings);
  await chrome.storage.sync.set(settings);
  render(settings);
  showStatus(
    hasFileAccess ? "设置已保存。" : "设置已保存，但本地文件权限尚未开启。",
    hasFileAccess ? "success" : "warning"
  );
  return settings;
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  save().catch((error) => showStatus(error.message, "error"));
});

recoveryEnabled.addEventListener("change", updateEnabledStates);
keepAliveEnabled.addEventListener("change", updateEnabledStates);
themeMode.addEventListener("change", () => applyTheme(themeMode.value));
targetUrl.addEventListener("input", () => void updateFileAccessNotice());

inferUrlsButton.addEventListener("click", () => {
  try {
    inferRecoveryUrls();
    showStatus("已根据主页网址填写 fnOS 地址。");
  } catch (error) {
    showStatus(error.message, "error");
  }
});

testButton.addEventListener("click", async () => {
  try {
    await save();
    const response = await chrome.runtime.sendMessage({ type: "TEST_RECOVERY" });
    if (response?.error) {
      throw new Error(response.error);
    }
    showStatus("已在新标签页启动登录恢复测试。");
  } catch (error) {
    showStatus(error.message, "error");
  }
});

resetButton.addEventListener("click", () => {
  if (!window.confirm("确定清除当前地址并恢复首次使用状态吗？")) {
    return;
  }
  render({ ...DEFAULT_SETTINGS });
  showStatus("地址已清空；填写你的飞牛地址后再保存。", "warning");
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "sync" || !Object.keys(changes).length) {
    return;
  }
  void chrome.storage.sync.get(DEFAULT_SETTINGS).then((saved) => {
    try {
      render(sanitizeSettings(saved));
    } catch {
      // 正在编辑的无效中间值不由外部变化覆盖。
    }
  });
});

chrome.storage.sync.get(DEFAULT_SETTINGS)
  .then((saved) => render(sanitizeSettings(saved)))
  .catch((error) => showStatus(`读取设置失败：${error.message}`, "error"));
