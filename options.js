import {
  DEFAULT_SETTINGS,
  hostPermissionPattern,
  inferFnOsHealthUrl,
  inferFnOsRootUrl,
  isFnOsUrl,
  isPrivateNetworkUrl,
  normalizeNavigableUrl,
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
const lanTargetUrl = document.querySelector("#lan-target-url");
const lanAccess = document.querySelector("#lan-access");
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
let saving = false;
let renderedRemoteTarget = "";
let renderedDeviceTarget = "";

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

function render(settings, deviceRoute = null) {
  renderedRemoteTarget = settings.targetUrl;
  renderedDeviceTarget = deviceRoute?.targetUrl ?? "";
  setupNotice.hidden = settings.setupCompleted;
  enabled.checked = settings.enabled;
  targetUrl.value = settings.targetUrl;
  recoveryEnabled.checked = settings.fnosRecoveryEnabled;
  rootUrl.value = settings.rootUrl;
  healthUrl.value = settings.healthUrl;
  lanTargetUrl.value = deviceRoute?.targetUrl ?? "";
  recoveryTimeout.value = settings.recoveryTimeoutSeconds;
  keepAliveEnabled.checked = settings.keepAliveEnabled;
  keepAliveMinutes.value = settings.keepAliveMinutes;
  themeMode.value = settings.themeMode;
  applyTheme(settings.themeMode);
  updateEnabledStates();
  void updateFileAccessNotice();
  void updateLanAccessNotice();
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

async function requestLanAccessIfNeeded() {
  const value = lanTargetUrl.value.trim();
  if (!value) {
    return { granted: true, targetUrl: "" };
  }
  const normalized = normalizeNavigableUrl(value);
  if (!isPrivateNetworkUrl(normalized)) {
    throw new Error("本机局域网主页必须使用 10.x、172.16-31.x、192.168.x 等私有网络地址");
  }
  const pattern = hostPermissionPattern(normalized);
  const granted = await chrome.permissions.request({ origins: [pattern] });
  if (granted) {
    try {
      await fetch(normalized, {
        cache: "no-store",
        credentials: "include",
        redirect: "follow",
        targetAddressSpace: "local"
      });
    } catch {
      // This foreground request also gives Chrome 142+ a chance to request LNA.
    }
  }
  return { granted, targetUrl: normalized, pattern };
}

async function updateLanAccessNotice() {
  const value = lanTargetUrl.value.trim();
  if (!value) {
    lanAccess.hidden = true;
    return;
  }
  try {
    const normalized = normalizeNavigableUrl(value);
    if (!isPrivateNetworkUrl(normalized)) {
      throw new Error("不是私有网络地址");
    }
    const allowed = await chrome.permissions.contains({
      origins: [hostPermissionPattern(normalized)]
    });
    lanAccess.hidden = false;
    lanAccess.textContent = allowed
      ? "已允许访问这台 NAS；局域网地址只保存在当前设备。"
      : "保存时 Chrome 会请求访问这台 NAS，用于健康检查与 Glance 识别。";
    lanAccess.dataset.kind = allowed ? "success" : "warning";
  } catch (error) {
    lanAccess.hidden = false;
    lanAccess.textContent = error.message;
    lanAccess.dataset.kind = "error";
  }
}

async function save() {
  saving = true;
  try {
    const settings = collect();
    validateRecoverySettings(settings);
    const lanAccessResult = await requestLanAccessIfNeeded();
    const hasFileAccess = await requestFileAccessIfNeeded(settings);
    if (!lanAccessResult.granted) {
      throw new Error("未获得这台 NAS 的局域网访问权限");
    }

    await chrome.storage.sync.set(settings);
    const routeResponse = await chrome.runtime.sendMessage({
      type: "SAVE_DEVICE_LAN_TARGET",
      targetUrl: lanAccessResult.targetUrl
    });
    if (routeResponse?.error) {
      throw new Error(routeResponse.error);
    }
    render(settings, routeResponse?.route ?? null);
    showStatus(
      hasFileAccess ? "设置已保存。" : "设置已保存，但本地文件权限尚未开启。",
      hasFileAccess ? "success" : "warning"
    );
    return settings;
  } finally {
    saving = false;
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  save().catch((error) => showStatus(error.message, "error"));
});

recoveryEnabled.addEventListener("change", updateEnabledStates);
keepAliveEnabled.addEventListener("change", updateEnabledStates);
themeMode.addEventListener("change", () => applyTheme(themeMode.value));
targetUrl.addEventListener("input", () => {
  void updateFileAccessNotice();
  if (
    targetUrl.value.trim() !== renderedRemoteTarget
    && lanTargetUrl.value.trim() === renderedDeviceTarget
  ) {
    lanTargetUrl.value = "";
    void updateLanAccessNotice();
  }
});
lanTargetUrl.addEventListener("input", () => void updateLanAccessNotice());

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
  render({ ...DEFAULT_SETTINGS }, null);
  showStatus("地址已清空；填写你的飞牛地址后再保存。", "warning");
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (saving || areaName !== "sync" || !Object.keys(changes).length) {
    return;
  }
  void chrome.runtime.sendMessage({ type: "GET_SETTINGS" }).then((response) => {
    try {
      render(sanitizeSettings(response.settings), response.deviceRoute);
    } catch {
      // 正在编辑的无效中间值不由外部变化覆盖。
    }
  });
});

chrome.runtime.sendMessage({ type: "GET_SETTINGS" })
  .then((response) => render(sanitizeSettings(response.settings), response.deviceRoute))
  .catch((error) => showStatus(`读取设置失败：${error.message}`, "error"));
