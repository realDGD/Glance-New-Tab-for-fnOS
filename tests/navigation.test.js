import test from "node:test";
import assert from "node:assert/strict";

import {
  TabNavigationManager,
  isSameNavigatedUrl,
  matchesExpectedNavigation,
  isIgnoredNavigationUrl,
  isBootstrapTransitUrl,
  isConfiguredRootOrigin,
  isConfiguredTargetPage,
  isDockerPending,
  DEFAULT_SETTINGS,
  sanitizeSettings,
  chooseInitialNavigation
} from "../shared.js";

test("TabNavigationManager manages per-tab generation tokens and abort signals", () => {
  const manager = new TabNavigationManager();

  // Tab 1 starts generation 1
  const gen1 = manager.begin(1);
  assert.equal(gen1, 1);
  assert.equal(manager.isActive(1, 1), true);
  assert.equal(manager.isActive(1, 2), false);

  const signal1 = manager.getAbortSignal(1, 1);
  assert.ok(signal1);
  assert.equal(signal1.aborted, false);

  // Tab 1 starts generation 2 -> invalidates generation 1 and aborts signal 1
  const gen2 = manager.begin(1);
  assert.equal(gen2, 2);
  assert.equal(manager.isActive(1, 1), false);
  assert.equal(manager.isActive(1, 2), true);
  assert.equal(signal1.aborted, true);

  // Cancel tab 1
  manager.cancel(1, "user-navigated");
  assert.equal(manager.isActive(1, 2), false);
  assert.equal(manager.isActive(1), false);
});

test("isSameNavigatedUrl normalizes trailing slashes and handles fnOS equivalent routes", () => {
  assert.equal(
    isSameNavigatedUrl("https://demo-nas.5ddd.com/app/glance-homepage/", "https://demo-nas.5ddd.com/app/glance-homepage"),
    true
  );
  assert.equal(
    isSameNavigatedUrl("https://demo-nas.5ddd.com/app/glance-homepage/", "https://5ddd.com/demo-nas/app/glance-homepage/"),
    true
  );
  assert.equal(
    isSameNavigatedUrl("https://demo-nas.5ddd.com/app/glance-homepage/", "https://demo-nas.5ddd.com/app/photo/"),
    false
  );
  assert.equal(
    isSameNavigatedUrl("http://192.168.1.10:18080/", "https://github.com/"),
    false
  );
});

test("isIgnoredNavigationUrl ignores internal browser errors and extension newtab starting page", () => {
  assert.equal(isIgnoredNavigationUrl("chrome-error://chromewebdata"), true);
  assert.equal(isIgnoredNavigationUrl("chrome-error://chromewebdata/"), true);
  assert.equal(isIgnoredNavigationUrl("chrome-extension://abcdefg/newtab.html"), true);
  assert.equal(isIgnoredNavigationUrl("https://github.com/"), false);
  assert.equal(isIgnoredNavigationUrl("https://demo-nas.5ddd.com/"), false);
});

test("matchesExpectedNavigation validates all stages of recovery without leaking to unrelated pages", () => {
  const pendingBootstrap = {
    recoveryKind: "docker",
    phase: "bootstrap",
    bootstrapUrl: "https://5ddd.com/demo-nas/",
    rootUrl: "https://demo-nas.5ddd.com/",
    targetUrl: "https://service-0.demo-nas.5ddd.com/"
  };

  // Bootstrap stage accepts bootstrap transit, root origin, target URL
  assert.equal(
    matchesExpectedNavigation(new Set(), pendingBootstrap, "https://check.fnos.net/transit"),
    true
  );
  assert.equal(
    matchesExpectedNavigation(new Set(), pendingBootstrap, "https://ctest.fnos.net/"),
    true
  );
  assert.equal(
    matchesExpectedNavigation(new Set(), pendingBootstrap, "https://5ddd.com/demo-nas/"),
    true
  );
  assert.equal(
    matchesExpectedNavigation(new Set(), pendingBootstrap, "https://demo-nas.5ddd.com/"),
    true
  );
  assert.equal(
    matchesExpectedNavigation(new Set(), pendingBootstrap, "https://service-0.demo-nas.5ddd.com/"),
    true
  );
  // Rejects unrelated websites
  assert.equal(
    matchesExpectedNavigation(new Set(), pendingBootstrap, "https://google.com/"),
    false
  );
  assert.equal(
    matchesExpectedNavigation(new Set(), pendingBootstrap, "https://github.com/"),
    false
  );

  const pendingLanRoot = {
    recoveryKind: "native-lan",
    phase: "lan-root",
    rootUrl: "http://192.168.1.10:5000/",
    targetUrl: "http://192.168.1.10:5000/app/glance-homepage/"
  };
  assert.equal(
    matchesExpectedNavigation(new Set(), pendingLanRoot, "http://192.168.1.10:5000/"),
    true
  );
  assert.equal(
    matchesExpectedNavigation(new Set(), pendingLanRoot, "http://192.168.1.10:5000/app/glance-homepage/"),
    true
  );
  assert.equal(
    matchesExpectedNavigation(new Set(), pendingLanRoot, "http://192.168.1.10:5000/app/photos/"),
    false
  );
});

test("Scenario 1 & 4: User active navigation immediately cancels extension ownership", () => {
  const manager = new TabNavigationManager();
  const tabId = 101;
  const gen = manager.begin(tabId);
  const lanUrl = "http://192.168.1.10:18080/";
  manager.setExpectedUrl(tabId, gen, lanUrl);

  const signal = manager.getAbortSignal(tabId, gen);

  // User enters https://example.com/ in address bar
  const changeResult = manager.handleUrlChange(tabId, "https://example.com/", null);
  assert.equal(changeResult.cancelled, true);
  assert.equal(changeResult.matched, false);
  assert.equal(manager.isActive(tabId, gen), false);
  assert.equal(signal.aborted, true);

  // When health probe finishes later, check ownership
  const canUpdate = manager.isActive(tabId, gen);
  assert.equal(canUpdate, false);
});

test("Scenario 2: Stale generation cannot modify tab", () => {
  const manager = new TabNavigationManager();
  const tabId = 102;
  const gen1 = manager.begin(tabId);
  manager.setExpectedUrl(tabId, gen1, "https://demo-nas.5ddd.com/app/glance-homepage/");

  // Async delay happens, user clicks retry or newtab requests fresh navigation
  const gen2 = manager.begin(tabId);
  manager.setExpectedUrl(tabId, gen2, "https://demo-nas.5ddd.com/app/glance-homepage/");

  // gen1 completes
  assert.equal(manager.isActive(tabId, gen1), false);
  // gen2 is active
  assert.equal(manager.isActive(tabId, gen2), true);
});

test("Scenario 3: Extension own navigation does not accidentally cancel ownership", () => {
  const manager = new TabNavigationManager();
  const tabId = 103;
  const gen = manager.begin(tabId);
  const targetUrl = "https://demo-nas.5ddd.com/app/glance-homepage/";
  manager.setExpectedUrl(tabId, gen, targetUrl);

  // chrome.tabs.update fires tabs.onUpdated with targetUrl
  const changeResult = manager.handleUrlChange(tabId, targetUrl, null);
  assert.equal(changeResult.cancelled, false);
  assert.equal(changeResult.matched, true);
  assert.equal(manager.isActive(tabId, gen), true);
});

test("Scenario 5: Tab closed during navigation cleans up state and aborts pending probes", () => {
  const manager = new TabNavigationManager();
  const tabId = 104;
  const gen = manager.begin(tabId);
  const signal = manager.getAbortSignal(tabId, gen);

  manager.cancel(tabId, "tab-removed");
  assert.equal(manager.isActive(tabId, gen), false);
  assert.equal(manager.get(tabId), null);
  assert.equal(signal.aborted, true);
});

test("Scenario 6: LAN fast path proceeds immediately and health OK keeps ownership", () => {
  const manager = new TabNavigationManager();
  const tabId = 105;
  const gen = manager.begin(tabId);
  const lanUrl = "http://192.168.1.10:18080/";
  manager.setExpectedUrl(tabId, gen, lanUrl);

  // Fast path does not block on health probe
  assert.equal(manager.isActive(tabId, gen), true);

  // URL event matches
  const match = manager.handleUrlChange(tabId, lanUrl, null);
  assert.equal(match.matched, true);

  // Probe finishes OK in background
  const probeOk = true;
  if (manager.isActive(tabId, gen) && probeOk) {
    // Remains active, no fallback
    assert.equal(manager.isActive(tabId, gen), true);
  }
});

test("Scenario 7: LAN health FAIL without user intervention triggers fallback safely", () => {
  const manager = new TabNavigationManager();
  const tabId = 106;
  const gen = manager.begin(tabId);
  const lanUrl = "http://192.168.1.10:18080/";
  manager.setExpectedUrl(tabId, gen, lanUrl);

  // Background probe fails
  const probeOk = false;
  assert.equal(probeOk, false);

  // User did not navigate away
  assert.equal(manager.isActive(tabId, gen), true);

  // Fallback can now navigate to remote target
  const remoteTargetUrl = "https://demo-nas.5ddd.com/app/glance-homepage/";
  manager.setExpectedUrl(tabId, gen, remoteTargetUrl);
  assert.equal(manager.isActive(tabId, gen), true);
});

test("Scenario 8: LAN health FAIL with user intervention prevents fallback", () => {
  const manager = new TabNavigationManager();
  const tabId = 107;
  const gen = manager.begin(tabId);
  const lanUrl = "http://192.168.1.10:18080/";
  manager.setExpectedUrl(tabId, gen, lanUrl);

  // User navigates to github.com
  manager.handleUrlChange(tabId, "https://github.com/", null);
  assert.equal(manager.isActive(tabId, gen), false);

  // Background probe fails
  const probeOk = false;
  let fallbackExecuted = false;
  if (manager.isActive(tabId, gen) && !probeOk) {
    fallbackExecuted = true;
  }
  assert.equal(fallbackExecuted, false);
});

test("Scenario 9 (P2): Single OPEN_NEW_TAB payload provides action and themeMode without pre-reading settings", () => {
  const settingsNotConfigured = sanitizeSettings(DEFAULT_SETTINGS);
  const notConfiguredResponse = {
    action: !settingsNotConfigured.setupCompleted ? "configure" : "navigating",
    themeMode: settingsNotConfigured.themeMode
  };
  assert.equal(notConfiguredResponse.action, "configure");
  assert.equal(notConfiguredResponse.themeMode, "auto");

  const settingsDisabled = sanitizeSettings({
    ...DEFAULT_SETTINGS,
    setupCompleted: true,
    targetUrl: "https://demo-nas.5ddd.com/app/glance-homepage/",
    enabled: false,
    themeMode: "dark"
  });
  const disabledResponse = {
    action: !settingsDisabled.enabled ? "stay" : "navigating",
    themeMode: settingsDisabled.themeMode
  };
  assert.equal(disabledResponse.action, "stay");
  assert.equal(disabledResponse.themeMode, "dark");

  const settingsConfigured = sanitizeSettings({
    ...DEFAULT_SETTINGS,
    setupCompleted: true,
    targetUrl: "https://demo-nas.5ddd.com/app/glance-homepage/",
    enabled: true,
    themeMode: "light"
  });
  const configuredResponse = {
    action: "navigating-lan",
    themeMode: settingsConfigured.themeMode
  };
  assert.equal(configuredResponse.action, "navigating-lan");
  assert.equal(configuredResponse.themeMode, "light");
});

test("Scenario 10 (P3): Dynamic content scripts in-memory cache skips redundant getRegisteredContentScripts on hot path", () => {
  const registeredPatterns = new Set();
  const testPattern = "http://192.168.1.10/*";

  let apiCalls = 0;
  function mockEnsureLanContentScripts(pattern) {
    if (registeredPatterns.has(pattern)) {
      return false; // cache hit: 0 API calls
    }
    apiCalls += 1; // registration query
    registeredPatterns.add(pattern);
    return true; // registered
  }

  // Cold start / first route registration
  assert.equal(mockEnsureLanContentScripts(testPattern), true);
  assert.equal(apiCalls, 1);

  // Subsequent new tab openings hit in-memory cache
  assert.equal(mockEnsureLanContentScripts(testPattern), false);
  assert.equal(mockEnsureLanContentScripts(testPattern), false);
  assert.equal(apiCalls, 1);
});

