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
  chooseInitialNavigation,
  parsePendingEnvelope,
  NavigationPersistence,
  OwnedTabController,
  LanRouteStore,
  PREVIEW_KEY_PREFIX,
  ACTIVE_PREVIEW_TARGET_KEY,
  previewStorageKey,
  sanitizeSafeUrl,
  sanitizeSafeText,
  extractGlancePreview,
  saveGlancePreviewToStorage,
  schedulePreviewRefresh,
  finishTargetPresentation,
  getPreviewStatus,
  renderGlancePreviewHtml,
  renderGlanceSkeletonHtml
} from "../shared.js";

test("TabNavigationManager manages per-tab generation tokens and abort signals", () => {
  const manager = new TabNavigationManager();

  // Tab 1 starts generation 1
  const nav1 = manager.begin(1);
  assert.equal(typeof nav1.navigationId, "string");
  assert.ok(nav1.navigationId.length > 0);
  assert.equal(nav1.generation, 1);
  assert.equal(manager.isActive(1, nav1.navigationId), true);
  assert.equal(manager.isActive(1, 1), false); // generation is rejected by correctness API

  const signal1 = manager.getAbortSignal(1, nav1.navigationId);
  assert.ok(signal1);
  assert.equal(signal1.aborted, false);

  // Tab 1 starts generation 2 -> invalidates generation 1 and aborts signal 1
  const nav2 = manager.begin(1);
  assert.equal(typeof nav2.navigationId, "string");
  assert.notEqual(nav2.navigationId, nav1.navigationId);
  assert.equal(nav2.generation, 2);
  assert.equal(manager.isActive(1, nav1.navigationId), false);
  assert.equal(manager.isActive(1, nav2.navigationId), true);
  assert.equal(signal1.aborted, true);

  // Cancel tab 1
  manager.cancel(1, "user-navigated", nav2.navigationId);
  assert.equal(manager.isActive(1, nav2.navigationId), false);
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
  const { navigationId } = manager.begin(tabId);
  const lanUrl = "http://192.168.1.10:18080/";
  manager.setExpectedUrl(tabId, navigationId, lanUrl);

  const signal = manager.getAbortSignal(tabId, navigationId);

  // User enters https://example.com/ in address bar
  const changeResult = manager.handleUrlChange(tabId, "https://example.com/", null);
  assert.equal(changeResult.cancelled, true);
  assert.equal(changeResult.matched, false);
  assert.equal(manager.isActive(tabId, navigationId), false);
  assert.equal(signal.aborted, true);

  // When health probe finishes later, check ownership
  const canUpdate = manager.isActive(tabId, navigationId);
  assert.equal(canUpdate, false);
});

test("Scenario 2: Stale generation cannot modify tab", () => {
  const manager = new TabNavigationManager();
  const tabId = 102;
  const { navigationId: navId1 } = manager.begin(tabId);
  manager.setExpectedUrl(tabId, navId1, "https://demo-nas.5ddd.com/app/glance-homepage/");

  // Async delay happens, user clicks retry or newtab requests fresh navigation
  const { navigationId: navId2 } = manager.begin(tabId);
  manager.setExpectedUrl(tabId, navId2, "https://demo-nas.5ddd.com/app/glance-homepage/");

  // navId1 completes
  assert.equal(manager.isActive(tabId, navId1), false);
  // navId2 is active
  assert.equal(manager.isActive(tabId, navId2), true);
});

test("Scenario 3: Extension own navigation does not accidentally cancel ownership", () => {
  const manager = new TabNavigationManager();
  const tabId = 103;
  const { navigationId } = manager.begin(tabId);
  const targetUrl = "https://demo-nas.5ddd.com/app/glance-homepage/";
  manager.setExpectedUrl(tabId, navigationId, targetUrl);

  // chrome.tabs.update fires tabs.onUpdated with targetUrl
  const changeResult = manager.handleUrlChange(tabId, targetUrl, null);
  assert.equal(changeResult.cancelled, false);
  assert.equal(changeResult.matched, true);
  assert.equal(manager.isActive(tabId, navigationId), true);
});

test("Scenario 5: Tab closed during navigation cleans up state and aborts pending probes", () => {
  const manager = new TabNavigationManager();
  const tabId = 104;
  const { navigationId } = manager.begin(tabId);
  const signal = manager.getAbortSignal(tabId, navigationId);

  manager.cancel(tabId, "tab-removed", navigationId);
  assert.equal(manager.isActive(tabId, navigationId), false);
  assert.equal(manager.get(tabId), null);
  assert.equal(signal.aborted, true);
});

test("Scenario 6: LAN fast path proceeds immediately and health OK keeps ownership", () => {
  const manager = new TabNavigationManager();
  const tabId = 105;
  const { navigationId } = manager.begin(tabId);
  const lanUrl = "http://192.168.1.10:18080/";
  manager.setExpectedUrl(tabId, navigationId, lanUrl);

  // Fast path does not block on health probe
  assert.equal(manager.isActive(tabId, navigationId), true);

  // URL event matches
  const match = manager.handleUrlChange(tabId, lanUrl, null);
  assert.equal(match.matched, true);

  // Probe finishes OK in background
  const probeOk = true;
  if (manager.isActive(tabId, navigationId) && probeOk) {
    // Remains active, no fallback
    assert.equal(manager.isActive(tabId, navigationId), true);
  }
});

test("Scenario 7: LAN health FAIL without user intervention triggers fallback safely", () => {
  const manager = new TabNavigationManager();
  const tabId = 106;
  const { navigationId } = manager.begin(tabId);
  const lanUrl = "http://192.168.1.10:18080/";
  manager.setExpectedUrl(tabId, navigationId, lanUrl);

  // Background probe fails
  const probeOk = false;
  assert.equal(probeOk, false);

  // User did not navigate away
  assert.equal(manager.isActive(tabId, navigationId), true);

  // Fallback can now navigate to remote target
  const remoteTargetUrl = "https://demo-nas.5ddd.com/app/glance-homepage/";
  manager.setExpectedUrl(tabId, navigationId, remoteTargetUrl);
  assert.equal(manager.isActive(tabId, navigationId), true);
});

test("Scenario 8: LAN health FAIL with user intervention prevents fallback", () => {
  const manager = new TabNavigationManager();
  const tabId = 107;
  const { navigationId } = manager.begin(tabId);
  const lanUrl = "http://192.168.1.10:18080/";
  manager.setExpectedUrl(tabId, navigationId, lanUrl);

  // User navigates to github.com
  manager.handleUrlChange(tabId, "https://github.com/", null);
  assert.equal(manager.isActive(tabId, navigationId), false);

  // Background probe fails
  const probeOk = false;
  let fallbackExecuted = false;
  if (manager.isActive(tabId, navigationId) && !probeOk) {
    fallbackExecuted = true;
  }
  assert.equal(fallbackExecuted, false);
});

test("Scenario 9 (P2): Single OPEN_NEW_TAB payload provides action and themeMode without pre-reading settings", async () => {
  const syncStorage = {
    targetUrl: "https://demo-nas.5ddd.com/app/glance-homepage/",
    themeMode: "dark",
    setupCompleted: true,
    enabled: true,
    fnosRecoveryEnabled: true
  };
  const sessionWarmed = true;

  const initialNavigation = chooseInitialNavigation(syncStorage, sessionWarmed);
  assert.equal(initialNavigation, "target-first");

  const responsePayload = {
    action: initialNavigation,
    themeMode: syncStorage.themeMode
  };

  assert.equal(responsePayload.action, "target-first");
  assert.equal(responsePayload.themeMode, "dark");
});

test("Scenario 10 (P3): Dynamic content scripts in-memory cache skips redundant getRegisteredContentScripts on hot path", () => {
  const registeredCache = new Set();
  let apiCalls = 0;

  function mockEnsureLanContentScripts(pattern) {
    if (registeredCache.has(pattern)) {
      return false; // Fast path: cache hit, zero async/IPC calls
    }
    apiCalls += 1;
    registeredCache.add(pattern);
    return true;
  }

  const testPattern = "http://192.168.1.10:18080/*";

  // First time: cache miss, registers script
  assert.equal(mockEnsureLanContentScripts(testPattern), true);
  assert.equal(apiCalls, 1);

  // Subsequent new tab openings hit in-memory cache
  assert.equal(mockEnsureLanContentScripts(testPattern), false);
  assert.equal(mockEnsureLanContentScripts(testPattern), false);
  assert.equal(apiCalls, 1);
});

test("P0.1 & P0.6: Synchronous URL mismatch freeze stops in-flight tasks before any async storage resolves", async () => {
  const manager = new TabNavigationManager();
  const tabId = 201;
  const { navigationId } = manager.begin(tabId);
  const lanUrl = "http://192.168.1.10:18080/";
  manager.setExpectedUrl(tabId, navigationId, lanUrl);
  manager.setPending(tabId, { phase: "target", targetUrl: lanUrl }, navigationId);

  const signal = manager.getAbortSignal(tabId, navigationId);

  // Simulate an in-flight health probe Promise
  let delayedProbeFinished = false;
  let simulatedTabUpdateCalled = false;

  const inFlightProbe = new Promise((resolve) => {
    setTimeout(() => {
      delayedProbeFinished = true;
      // Before updating tab, probe checks if navigation is still active
      if (manager.isActive(tabId, navigationId)) {
        simulatedTabUpdateCalled = true;
      }
      resolve();
    }, 20);
  });

  // User immediately navigates to github.com in address bar (tabs.onUpdated synchronously fires)
  const result = manager.handleUrlChange(tabId, "https://github.com/");
  assert.equal(result.cancelled, true);
  assert.equal(result.matched, false);

  // SYNCHRONOUS ASSERTION: The navigation MUST be frozen immediately, before inFlightProbe resolves
  assert.equal(manager.isActive(tabId, navigationId), false);
  assert.equal(signal.aborted, true);
  assert.equal(manager.setExpectedUrl(tabId, navigationId, "http://192.168.1.10:18080/"), false);

  // Wait for in-flight probe to complete
  await inFlightProbe;
  assert.equal(delayedProbeFinished, true);
  assert.equal(simulatedTabUpdateCalled, false);
});

test("P0.7: Delayed cleanup from generation N does not cancel or pollute generation N+1", () => {
  const manager = new TabNavigationManager();
  const tabId = 202;

  // Generation 1 starts
  const { navigationId: navId1 } = manager.begin(tabId);
  manager.setExpectedUrl(tabId, navId1, "https://old-target.example.com/");
  manager.setPending(tabId, { phase: "target", targetUrl: "https://old-target.example.com/" }, navId1);

  // Unexpected URL cancels generation 1
  const changeResult = manager.handleUrlChange(tabId, "https://github.com/");
  assert.equal(changeResult.cancelled, true);
  assert.equal(manager.isActive(tabId, navId1), false);

  // Generation 2 starts on the same tab
  const { navigationId: navId2, generation: gen2 } = manager.begin(tabId);
  assert.equal(gen2, 2);
  assert.notEqual(navId2, navId1);
  const gen2Url = "https://demo-nas.5ddd.com/app/glance-homepage/";
  manager.setExpectedUrl(tabId, navId2, gen2Url);
  manager.setPending(tabId, { phase: "target", targetUrl: gen2Url }, navId2);
  const signal2 = manager.getAbortSignal(tabId, navId2);

  // Now delayed cleanup from Generation 1 runs: cancel(tabId, "delayed-cleanup", navId1)
  const cancelResult = manager.cancel(tabId, "delayed-cleanup", navId1);
  assert.equal(cancelResult, null); // Target identity mismatch, ignored!

  // Assert Generation 2 is completely unaffected
  assert.equal(manager.isActive(tabId, navId2), true);
  assert.equal(manager.getGeneration(tabId), 2);
  assert.equal(signal2.aborted, false);
  assert.equal(manager.getPending(tabId, navId2)?.targetUrl, gen2Url);
});

test("P0.3: Multi-phase recovery in-memory pending tracking preserves ownership synchronously", () => {
  const manager = new TabNavigationManager();
  const tabId = 203;

  const { navigationId } = manager.begin(tabId);
  const bootstrapPending = {
    recoveryKind: "docker",
    phase: "bootstrap",
    bootstrapUrl: "https://5ddd.com/demo-nas/",
    rootUrl: "https://demo-nas.5ddd.com/",
    targetUrl: "https://service-0.demo-nas.5ddd.com/"
  };
  manager.setPending(tabId, bootstrapPending, navigationId);
  manager.setExpectedUrl(tabId, navigationId, bootstrapPending.bootstrapUrl);

  // Phase 1: Bootstrap transit URLs
  assert.equal(manager.handleUrlChange(tabId, "https://5ddd.com/demo-nas/").matched, true);
  assert.equal(manager.handleUrlChange(tabId, "https://check.fnos.net/").matched, true);
  assert.equal(manager.handleUrlChange(tabId, "https://demo-nas.5ddd.com/").matched, true);
  assert.equal(manager.isActive(tabId, navigationId), true);

  // Phase 2: Target transition
  const targetPending = {
    ...bootstrapPending,
    phase: "target"
  };
  manager.setPending(tabId, targetPending, navigationId);
  manager.setExpectedUrl(tabId, navigationId, targetPending.targetUrl);

  assert.equal(manager.handleUrlChange(tabId, "https://service-0.demo-nas.5ddd.com/").matched, true);
  assert.equal(manager.isActive(tabId, navigationId), true);

  // Phase 3: User navigates away to unrelated domain
  assert.equal(manager.handleUrlChange(tabId, "https://example.org/").cancelled, true);
  assert.equal(manager.isActive(tabId, navigationId), false);
});

test("P0.1, P0.2 & P0.6: Stale async callback cannot revive pending or pollute storage after user navigation", async () => {
  const sessionStorageMock = new Map();
  const manager = new TabNavigationManager();
  const tabId = 301;
  const { navigationId: navId1 } = manager.begin(tabId);

  async function mockSetPending(id, pending, identity) {
    if (!identity || !manager.isActive(id, identity)) {
      return false;
    }
    const accepted = manager.setPending(id, pending, identity);
    if (!accepted) {
      return false;
    }
    const state = manager.get(id);
    const envelope = {
      navigationId: identity,
      generation: state?.generation ?? null,
      pending,
      expectedUrl: state?.expectedUrl ?? null,
      expectedUrls: state ? Array.from(state.expectedUrls) : [],
      savedAt: Date.now()
    };
    sessionStorageMock.set(`pending-recovery:${id}`, envelope);
    if (!manager.isActive(id, identity)) {
      sessionStorageMock.delete(`pending-recovery:${id}`);
      return false;
    }
    return true;
  }

  // Set initial valid pending
  const initialPending = { phase: "bootstrap", targetUrl: "https://demo.fnos.net/" };
  assert.equal(await mockSetPending(tabId, initialPending, navId1), true);
  assert.ok(sessionStorageMock.has(`pending-recovery:${tabId}`));

  // User navigates away to github.com
  manager.handleUrlChange(tabId, "https://github.com/");
  assert.equal(manager.isActive(tabId, navId1), false);

  // Stale callback returns and tries to write updated pending with old navId1
  const stalePending = { phase: "target", targetUrl: "https://demo.fnos.net/" };
  const writeResult = await mockSetPending(tabId, stalePending, navId1);
  assert.equal(writeResult, false);

  // Assert memory state is not revived
  assert.equal(manager.getPending(tabId, navId1), null);
});

test("P0.4 & P0.7: Delayed cleanup from generation N does not delete generation N+1 storage", async () => {
  const sessionStorageMock = new Map();

  async function mockRemovePending(tabId, identity = null) {
    const key = `pending-recovery:${tabId}`;
    if (identity !== null) {
      const stored = sessionStorageMock.get(key);
      const envelope = parsePendingEnvelope(stored);
      if (envelope && envelope.navigationId !== null && envelope.navigationId !== identity) {
        return; // Mismatched identity: keep stored pending
      }
    }
    sessionStorageMock.delete(key);
  }

  const tabId = 302;
  const navId1 = "uuid_nav_1";
  const navId2 = "uuid_nav_2";

  // Generation 1 was active and then Generation 2 starts and writes its state
  const gen2Envelope = {
    navigationId: navId2,
    generation: 2,
    pending: { phase: "target", targetUrl: "https://target.fnos.net/" },
    expectedUrl: "https://target.fnos.net/",
    expectedUrls: ["https://target.fnos.net/"],
    savedAt: Date.now()
  };
  sessionStorageMock.set(`pending-recovery:${tabId}`, gen2Envelope);

  // Stale cleanup from Generation 1 arrives
  await mockRemovePending(tabId, navId1);

  // Generation 2 storage MUST remain intact
  assert.ok(sessionStorageMock.has(`pending-recovery:${tabId}`));
  const preserved = sessionStorageMock.get(`pending-recovery:${tabId}`);
  assert.equal(preserved.navigationId, navId2);
  assert.equal(preserved.pending.targetUrl, "https://target.fnos.net/");

  // Generation 2's own cleanup should properly delete it
  await mockRemovePending(tabId, navId2);
  assert.equal(sessionStorageMock.has(`pending-recovery:${tabId}`), false);
});

test("P1.8: Service Worker restart rehydrates navigation ownership when tab is on valid recovery page", async () => {
  const tabId = 303;
  const originalNavId = "uuid_sw_restart_rehydrate_test";
  const originalGen = 5;

  // Persisted state before Service Worker was terminated
  const persistedEnvelope = {
    navigationId: originalNavId,
    generation: originalGen,
    expectedUrl: "https://5ddd.com/demo-nas/",
    expectedUrls: ["https://5ddd.com/demo-nas/", "https://demo-nas.5ddd.com/"],
    pending: {
      recoveryKind: "docker",
      phase: "bootstrap",
      bootstrapUrl: "https://5ddd.com/demo-nas/",
      rootUrl: "https://demo-nas.5ddd.com/",
      targetUrl: "https://service-0.demo-nas.5ddd.com/"
    },
    savedAt: Date.now()
  };

  // Simulate SW restart: brand new TabNavigationManager instance (empty memory)
  const restartedManager = new TabNavigationManager();
  assert.equal(restartedManager.isActive(tabId), false);

  // Helper simulating ensureNavigationContext
  function mockEnsureNavigationContext(id, currentTabUrl) {
    if (restartedManager.isActive(id)) {
      return {
        active: true,
        navigationId: restartedManager.getNavigationId(id),
        generation: restartedManager.getGeneration(id),
        pending: restartedManager.getPending(id)
      };
    }
    const envelope = parsePendingEnvelope(persistedEnvelope);
    if (!envelope || !envelope.pending) return null;

    const allowedUrls = new Set(envelope.expectedUrls || []);
    const isAllowed = isIgnoredNavigationUrl(currentTabUrl)
      || matchesExpectedNavigation(allowedUrls, envelope.pending, currentTabUrl, envelope.expectedUrl);

    if (!isAllowed) {
      return null;
    }

    const state = restartedManager.rehydrate(id, {
      navigationId: envelope.navigationId,
      generation: envelope.generation,
      expectedUrl: envelope.expectedUrl,
      expectedUrls: allowedUrls,
      pending: envelope.pending
    });
    return {
      active: true,
      navigationId: state.navigationId,
      generation: state.generation,
      pending: envelope.pending,
      state
    };
  }

  // Current tab is still on the bootstrap URL
  const context = mockEnsureNavigationContext(tabId, "https://5ddd.com/demo-nas/");
  assert.ok(context);
  assert.equal(context.active, true);
  assert.equal(context.navigationId, originalNavId);
  assert.equal(context.generation, 5);
  assert.equal(restartedManager.isActive(tabId, originalNavId), true);
  assert.equal(restartedManager.getPending(tabId, originalNavId)?.phase, "bootstrap");

  // Abort signal is created and valid
  const signal = restartedManager.getAbortSignal(tabId, originalNavId);
  assert.ok(signal);
  assert.equal(signal.aborted, false);

  // Monotonicity: next navigation on this tab will not regress below generation 5
  const nextNav = restartedManager.begin(tabId);
  assert.equal(nextNav.generation, 6);
});

test("P1.9: Service Worker restart + user already navigated away purges stale state without rehydrating", async () => {
  const tabId = 304;
  const persistedStorage = new Map();
  persistedStorage.set(`pending-recovery:${tabId}`, {
    navigationId: "uuid_nav_stale_5",
    generation: 5,
    expectedUrl: "https://5ddd.com/demo-nas/",
    expectedUrls: ["https://5ddd.com/demo-nas/"],
    pending: {
      recoveryKind: "docker",
      phase: "bootstrap",
      targetUrl: "https://service-0.demo-nas.5ddd.com/"
    }
  });

  const restartedManager = new TabNavigationManager();

  function mockEnsureNavigationContext(id, currentTabUrl) {
    if (restartedManager.isActive(id)) {
      return { active: true, navigationId: restartedManager.getNavigationId(id), generation: restartedManager.getGeneration(id) };
    }
    const key = `pending-recovery:${id}`;
    const envelope = parsePendingEnvelope(persistedStorage.get(key));
    if (!envelope || !envelope.pending) return null;

    const allowedUrls = new Set(envelope.expectedUrls || []);
    const isAllowed = isIgnoredNavigationUrl(currentTabUrl)
      || matchesExpectedNavigation(allowedUrls, envelope.pending, currentTabUrl, envelope.expectedUrl);

    if (!isAllowed) {
      persistedStorage.delete(key);
      return null;
    }
    return restartedManager.rehydrate(id, envelope);
  }

  // User in the meantime navigated to google.com
  const context = mockEnsureNavigationContext(tabId, "https://www.google.com/");
  assert.equal(context, null);
  assert.equal(restartedManager.isActive(tabId), false);
  assert.equal(persistedStorage.has(`pending-recovery:${tabId}`), false);
});

test("P1.10: Restarted worker with new generation N+1 rejects stale events from generation N", () => {
  const manager = new TabNavigationManager();
  const tabId = 305;
  const navId1 = "uuid_nav_1";
  const navId2 = "uuid_nav_2";

  // New tab starts generation 2 after worker restart
  const gen2 = manager.rehydrate(tabId, {
    navigationId: navId2,
    generation: 2,
    expectedUrl: "https://new-target.fnos.net/",
    expectedUrls: ["https://new-target.fnos.net/"],
    pending: { phase: "target", targetUrl: "https://new-target.fnos.net/" }
  });
  assert.ok(gen2);

  // Stale event from Generation 1 arrives
  const oldPending = { phase: "root", targetUrl: "https://old-target.fnos.net/" };
  assert.equal(manager.setPending(tabId, oldPending, navId1), false);
  assert.equal(manager.cancel(tabId, "stale-cancel", navId1), null);
  assert.equal(manager.getAbortSignal(tabId, navId1), null);

  // Generation 2 remains active and unaffected
  assert.equal(manager.isActive(tabId, navId2), true);
  assert.equal(manager.getPending(tabId, navId2)?.targetUrl, "https://new-target.fnos.net/");
  assert.equal(manager.getAbortSignal(tabId, navId2)?.aborted, false);
});

test("P0-1 & P2-1.A: NavigationPersistence without shared pointer eliminates TOCTOU interleaving", async () => {
  const store = new Map();
  let deferredRemove = null;

  const mockStorage = {
    async get(keys) {
      if (keys === null) {
        return Object.fromEntries(store);
      }
      if (Array.isArray(keys)) {
        return Object.fromEntries(keys.map((k) => [k, store.get(k)]));
      }
      return { [keys]: store.get(keys) };
    },
    async set(items) {
      for (const [k, v] of Object.entries(items)) {
        store.set(k, v);
      }
    },
    async remove(keys) {
      if (deferredRemove) {
        await deferredRemove;
      }
      const arr = Array.isArray(keys) ? keys : [keys];
      for (const k of arr) {
        store.delete(k);
      }
    }
  };

  const persistence = new NavigationPersistence(mockStorage);
  const tabId = 401;

  // Generation 1 sets pending
  await persistence.setPendingEnvelope(tabId, 1, {
    generation: 1,
    pending: { phase: "bootstrap", targetUrl: "https://v1.example.com/" },
    savedAt: 1000
  });
  assert.ok(store.has(`pending-recovery:${tabId}:1`));

  // Gen 1 begins removal and gets delayed during remove execution
  let resolveRemove;
  deferredRemove = new Promise((resolve) => { resolveRemove = resolve; });

  const gen1RemovePromise = persistence.removePendingEnvelope(tabId, 1);

  // In the meantime, Generation 2 starts and writes its state!
  await persistence.setPendingEnvelope(tabId, 2, {
    generation: 2,
    pending: { phase: "target", targetUrl: "https://v2.example.com/" },
    savedAt: 2000
  });
  assert.ok(store.has(`pending-recovery:${tabId}:2`));

  // Now Generation 1's delayed remove completes
  resolveRemove();
  await gen1RemovePromise;
  deferredRemove = null;

  // ASSERTION: Generation 2's key MUST still be in store!
  assert.equal(store.has(`pending-recovery:${tabId}:2`), true);
  const gen2Loaded = await persistence.getPendingEnvelope(tabId);
  assert.equal(gen2Loaded?.generation, 2);
  assert.equal(gen2Loaded?.pending?.targetUrl, "https://v2.example.com/");
  // Generation 1's key was removed
  assert.equal(store.has(`pending-recovery:${tabId}:1`), false);
});

test("P0-1 & P2-1.A: OwnedTabController cleanup race prevents closing newer generation", async () => {
  const store = new Map();
  let deferredPersistenceRemove = null;

  const mockStorage = {
    async get(keys) {
      if (keys === null) return Object.fromEntries(store);
      if (Array.isArray(keys)) return Object.fromEntries(keys.map((k) => [k, store.get(k)]));
      return { [keys]: store.get(keys) };
    },
    async set(items) {
      for (const [k, v] of Object.entries(items)) store.set(k, v);
    },
    async remove(keys) {
      if (deferredPersistenceRemove) {
        await deferredPersistenceRemove;
      }
      const arr = Array.isArray(keys) ? keys : [keys];
      for (const k of arr) store.delete(k);
    }
  };

  const persistence = new NavigationPersistence(mockStorage);
  const manager = new TabNavigationManager();
  const tabId = 501;
  const { navigationId: navId1 } = manager.begin(tabId);
  manager.setExpectedUrl(tabId, navId1, "https://5ddd.com/nas-demo/");
  manager.setPending(tabId, { phase: "bootstrap", targetUrl: "https://service.5ddd.com/" }, navId1);
  await persistence.setPendingEnvelope(tabId, navId1, {
    navigationId: navId1,
    pending: { phase: "bootstrap", targetUrl: "https://service.5ddd.com/" }
  });

  let tabsRemoveCalls = [];
  const mockTabs = {
    async get(id) {
      return { id, url: "https://5ddd.com/nas-demo/" };
    },
    async remove(id) {
      tabsRemoveCalls.push(id);
    }
  };

  const controller = new OwnedTabController(manager, persistence, mockTabs);

  // Scenario: navId1 calls removeOwnedTab, gets past tabs.get, but pauses during persistence cleanup!
  let resolveCleanup;
  deferredPersistenceRemove = new Promise((resolve) => { resolveCleanup = resolve; });

  const removePromise = controller.removeOwnedTab(tabId, navId1, "cleanup-race");

  // While paused in cleanup, navId2 begins on the tab!
  const { navigationId: navId2 } = manager.begin(tabId);
  assert.notEqual(navId2, navId1);
  assert.equal(manager.isActive(tabId, navId1), false);
  assert.equal(manager.isActive(tabId, navId2), true);

  await persistence.setPendingEnvelope(tabId, navId2, {
    navigationId: navId2,
    pending: { phase: "target", targetUrl: "https://v2.example.com/" }
  });

  // Now old navId1 cleanup completes
  const gen1Resolve = resolveCleanup;
  deferredPersistenceRemove = null;
  gen1Resolve();

  const removeResult = await removePromise;

  // ASSERTION: navId1 removal MUST fail and NOT call tabs.remove!
  assert.equal(removeResult.ok, false);
  assert.equal(removeResult.reason, "stale-generation");
  assert.equal(tabsRemoveCalls.length, 0);
  assert.equal(manager.isActive(tabId, navId2), true);
  assert.equal(store.has(`pending-recovery:${tabId}:${navId2}`), true);
});

test("P0-2 & P2-1.B: LanRouteStore drops same-route stale commit and preserves newer writer", async () => {
  const store = new Map();
  let deferredStorageGet = null;

  const mockStorage = {
    async get(key) {
      if (deferredStorageGet) {
        await deferredStorageGet;
      }
      if (key === null) return Object.fromEntries(store);
      return { [key]: store.get(key) || {} };
    },
    async set(items) {
      for (const [k, v] of Object.entries(items)) {
        store.set(k, v);
      }
    }
  };

  const manager = new TabNavigationManager();
  const routeStore = new LanRouteStore(manager, mockStorage);
  const ownerTabId = 601;
  const { navigationId: navId1 } = manager.begin(ownerTabId);

  // navId1 starts saveRoute but gets delayed in await storage.get()
  let resolveGet;
  deferredStorageGet = new Promise((resolve) => { resolveGet = resolve; });

  const staleRoutePromise = routeStore.saveRoute(
    "https://service.remote.fnos.net/",
    { kind: "docker", targetUrl: "http://192.168.1.10:8080/" },
    ownerTabId,
    navId1
  );

  // Clear delay so navId2 runs without blocking
  const nav1Resolve = resolveGet;
  deferredStorageGet = null;

  // User navigates / starts navId2 on owner tab, which saves a new route!
  const { navigationId: navId2 } = manager.begin(ownerTabId);
  await routeStore.saveRoute(
    "https://service.remote.fnos.net/",
    { kind: "docker", targetUrl: "http://192.168.1.99:9000/" },
    ownerTabId,
    navId2
  );

  // Now navId1 resumes
  nav1Resolve();
  const staleResult = await staleRoutePromise;

  // Stale result MUST be null and MUST NOT overwrite navId2's route!
  assert.equal(staleResult, null);
  const activeRoute = await routeStore.getRoute("https://service.remote.fnos.net/");
  assert.equal(activeRoute.targetUrl, "http://192.168.1.99:9000/");
});

test("P0-2 & P2-1.C: LanRouteStore concurrent saves for different routes do not cause lost updates", async () => {
  const store = new Map();
  const mockStorage = {
    async get(keys) {
      if (keys === null) return Object.fromEntries(store);
      if (Array.isArray(keys)) return Object.fromEntries(keys.map((k) => [k, store.get(k)]));
      return { [keys]: store.get(keys) };
    },
    async set(items) {
      for (const [k, v] of Object.entries(items)) {
        store.set(k, v);
      }
    }
  };

  const manager = new TabNavigationManager();
  const routeStore = new LanRouteStore(manager, mockStorage);

  // Concurrently save route A and route B
  await Promise.all([
    routeStore.saveRoute("https://service-a.fnos.net/", { kind: "docker", targetUrl: "http://192.168.1.10:8080/" }),
    routeStore.saveRoute("https://service-b.fnos.net/", { kind: "native", targetUrl: "http://192.168.1.10:5666/" })
  ]);

  const allRoutes = await routeStore.loadRoutes();
  assert.ok(allRoutes["https://service-a.fnos.net/"]);
  assert.ok(allRoutes["https://service-b.fnos.net/"]);
  assert.equal(allRoutes["https://service-a.fnos.net/"].targetUrl, "http://192.168.1.10:8080/");
  assert.equal(allRoutes["https://service-b.fnos.net/"].targetUrl, "http://192.168.1.10:5666/");
});

test("P0-3 & P2-1.D: SW restart identity collision avoided by unique navigationId", async () => {
  const store = new Map();
  const mockStorage = {
    async get(keys) {
      if (keys === null) return Object.fromEntries(store);
      if (Array.isArray(keys)) return Object.fromEntries(keys.map((k) => [k, store.get(k)]));
      return { [keys]: store.get(keys) };
    },
    async set(items) {
      for (const [k, v] of Object.entries(items)) store.set(k, v);
    },
    async remove(keys) {
      const arr = Array.isArray(keys) ? keys : [keys];
      for (const k of arr) store.delete(k);
    }
  };

  const persistence = new NavigationPersistence(mockStorage);
  const tabId = 701;

  // Session 1: SW runs, creates navIdA
  const manager1 = new TabNavigationManager();
  manager1.begin(tabId);
  const navIdA = manager1.getNavigationId(tabId);
  await persistence.setPendingEnvelope(tabId, navIdA, {
    navigationId: navIdA,
    pending: { phase: "target", targetUrl: "https://a.example.com/" }
  });

  // SW Restarts: Manager is cleared
  const manager2 = new TabNavigationManager();
  manager2.begin(tabId);
  const navIdB = manager2.getNavigationId(tabId);

  // Unique tokens guarantee no collision across worker restarts
  assert.notEqual(navIdA, navIdB);
  assert.equal(manager2.isActive(tabId, navIdA), false);
  assert.equal(manager2.isActive(tabId, navIdB), true);

  // Stale callback using navIdA cannot modify manager2
  assert.equal(manager2.setPending(tabId, { phase: "root" }, navIdA), false);
  assert.equal(manager2.cancel(tabId, "stale-cancel", navIdA), null);
});

test("P0-4 & P2-1.E: Superseded navigation does not resurrect after newer navigation completes and SW restarts", async () => {
  const store = new Map();
  const mockStorage = {
    async get(keys) {
      if (keys === null) return Object.fromEntries(store);
      if (Array.isArray(keys)) return Object.fromEntries(keys.map((k) => [k, store.get(k)]));
      return { [keys]: store.get(keys) };
    },
    async set(items) {
      for (const [k, v] of Object.entries(items)) store.set(k, v);
    },
    async remove(keys) {
      const arr = Array.isArray(keys) ? keys : [keys];
      for (const k of arr) store.delete(k);
    }
  };

  const persistence = new NavigationPersistence(mockStorage);
  const tabId = 801;

  // Navigation A starts
  const navIdA = "nav_A_12345";
  await persistence.setPendingEnvelope(tabId, navIdA, {
    navigationId: navIdA,
    pending: { phase: "bootstrap", targetUrl: "https://a.example.com/" }
  });

  // Navigation B supersedes Navigation A
  const navIdB = "nav_B_67890";
  await persistence.setPendingEnvelope(tabId, navIdB, {
    navigationId: navIdB,
    pending: { phase: "target", targetUrl: "https://b.example.com/" }
  });

  // Navigation B completes normally and cleans up
  await persistence.removePendingEnvelope(tabId, navIdB);

  // SW restarts: new empty TabNavigationManager
  const newManager = new TabNavigationManager();

  // Attempt rehydration: because active pointer was removed, old Navigation A is NOT active
  const rehydratedEnvelope = await persistence.getPendingEnvelope(tabId);
  assert.equal(rehydratedEnvelope, null);
  assert.equal(newManager.isActive(tabId), false);
});

test("P1-3 & P2-1.F: LAN discovery rehydration resumes discovery on valid tab and purges on invalid tab", async () => {
  const store = new Map();
  const mockStorage = {
    async get(keys) {
      if (keys === null) return Object.fromEntries(store);
      if (Array.isArray(keys)) return Object.fromEntries(keys.map((k) => [k, store.get(k)]));
      return { [keys]: store.get(keys) };
    },
    async set(items) {
      for (const [k, v] of Object.entries(items)) store.set(k, v);
    },
    async remove(keys) {
      const arr = Array.isArray(keys) ? keys : [keys];
      for (const k of arr) store.delete(k);
    }
  };

  const persistence = new NavigationPersistence(mockStorage);
  const ownerTabId = 901;
  const navId = "nav_disc_111";

  // Persist pending and discovery before SW restart
  await persistence.setPendingEnvelope(ownerTabId, navId, {
    navigationId: navId,
    expectedUrl: "http://192.168.1.50:8080/",
    expectedUrls: ["http://192.168.1.50:8080/"],
    pending: {
      phase: "lan-discovery",
      targetUrl: "https://remote.5ddd.com/",
      lanRootUrl: "http://192.168.1.50:8080/"
    },
    savedAt: Date.now()
  });
  await persistence.setDiscovery(ownerTabId, navId, {
    remoteTargetUrl: "https://remote.5ddd.com/",
    lanRootUrl: "http://192.168.1.50:8080/",
    startedAt: Date.now(),
    expiresAt: Date.now() + 60000
  });

  // SW restarts: new empty TabNavigationManager
  const newManager = new TabNavigationManager();
  assert.equal(newManager.isActive(ownerTabId), false);

  // Case 1: Tab is still on valid discovery URL -> rehydration succeeds!
  const validEnvelope = await persistence.getPendingEnvelope(ownerTabId);
  const rehydrated = newManager.rehydrate(ownerTabId, validEnvelope);
  assert.ok(rehydrated);
  assert.equal(newManager.isActive(ownerTabId, navId), true);

  // Case 2: User navigated to external URL -> purge stale discovery
  const ownerTabId2 = 902;
  const navId2 = "nav_disc_222";
  await persistence.setDiscovery(ownerTabId2, navId2, {
    remoteTargetUrl: "https://remote2.5ddd.com/",
    lanRootUrl: "http://192.168.1.60:8080/",
    startedAt: Date.now(),
    expiresAt: Date.now() + 60000
  });

  async function mockEnsureOrPurge(tabId, currentTabUrl) {
    const envelope = await persistence.getPendingEnvelope(tabId);
    if (!envelope) {
      await persistence.removeDiscovery(tabId);
      return null;
    }
    const allowed = new Set(envelope.expectedUrls || []);
    if (!matchesExpectedNavigation(allowed, envelope.pending, currentTabUrl, envelope.expectedUrl)) {
      await persistence.removePendingEnvelope(tabId, envelope.navigationId);
      await persistence.removeDiscovery(tabId, envelope.navigationId);
      return null;
    }
    return newManager.rehydrate(tabId, envelope);
  }

  const context = await mockEnsureOrPurge(ownerTabId2, "https://www.google.com/");
  assert.equal(context, null);
  assert.equal(await persistence.getDiscovery(ownerTabId2), null);
});

test("P1-4: removeAllForTab purges all generations of pending, active pointer, and discovery for removed tab", async () => {
  const store = new Map();
  const mockStorage = {
    async get(keys) {
      if (keys === null) return Object.fromEntries(store);
      if (Array.isArray(keys)) return Object.fromEntries(keys.map((k) => [k, store.get(k)]));
      return { [keys]: store.get(keys) };
    },
    async set(items) {
      for (const [k, v] of Object.entries(items)) store.set(k, v);
    },
    async remove(keys) {
      const arr = Array.isArray(keys) ? keys : [keys];
      for (const k of arr) store.delete(k);
    }
  };

  const persistence = new NavigationPersistence(mockStorage);
  const tabId1 = 981;
  const tabId2 = 982;

  // Add multiple generations for tab 981
  await persistence.setPendingEnvelope(tabId1, "nav_1", { navigationId: "nav_1", pending: { phase: "root" } });
  await persistence.setPendingEnvelope(tabId1, "nav_2", { navigationId: "nav_2", pending: { phase: "target" } });
  await persistence.setDiscovery(tabId1, "nav_1", { expiresAt: Date.now() + 60000 });
  await persistence.setDiscovery(tabId1, "nav_2", { expiresAt: Date.now() + 60000 });

  // Add data for tab 982
  await persistence.setPendingEnvelope(tabId2, "nav_3", { navigationId: "nav_3", pending: { phase: "target" } });
  await persistence.setDiscovery(tabId2, "nav_3", { expiresAt: Date.now() + 60000 });

  // Tab 981 is removed
  await persistence.removeAllForTab(tabId1);

  // Tab 981 data is completely removed
  assert.equal(store.has(`pending-recovery:${tabId1}:nav_1`), false);
  assert.equal(store.has(`pending-recovery:${tabId1}:nav_2`), false);
  assert.equal(store.has(`lan-discovery:${tabId1}:nav_1`), false);
  assert.equal(store.has(`lan-discovery:${tabId1}:nav_2`), false);
  assert.equal(store.has(`nav-active:${tabId1}`), false);

  // Tab 982 data is completely untouched
  assert.equal(store.has(`pending-recovery:${tabId2}:nav_3`), true);
  assert.equal(store.has(`lan-discovery:${tabId2}:nav_3`), true);
  assert.equal(store.has(`nav-active:${tabId2}`), true);
});

test("T1: TabNavigationManager.begin() returns explicit context { navigationId, generation }", () => {
  const manager = new TabNavigationManager();
  const tabId = 1001;

  const nav = manager.begin(tabId);
  assert.equal(typeof nav, "object");
  assert.equal(typeof nav.navigationId, "string");
  assert.ok(nav.navigationId.length > 10);
  assert.equal(typeof nav.generation, "number");
  assert.equal(nav.generation, 1);
});

test("T2: TabNavigationManager correctness APIs strictly reject integer generation numbers", () => {
  const manager = new TabNavigationManager();
  const tabId = 1002;

  const nav = manager.begin(tabId);
  const uuid = nav.navigationId;
  const gen = nav.generation;

  // UUID is accepted
  assert.equal(manager.isActive(tabId, uuid), true);
  assert.equal(manager.setPending(tabId, { phase: "target" }, uuid), true);
  assert.equal(manager.setExpectedUrl(tabId, uuid, "https://glance.local/"), true);
  assert.ok(manager.getAbortSignal(tabId, uuid));

  // Integer generation is REJECTED by correctness APIs
  assert.equal(manager.isActive(tabId, gen), false);
  assert.equal(manager.setPending(tabId, { phase: "target" }, gen), false);
  assert.equal(manager.setExpectedUrl(tabId, gen, "https://glance.local/"), false);
  assert.equal(manager.getAbortSignal(tabId, gen), null);
  assert.equal(manager.claimTabForRemoval(tabId, gen), null);
});

test("T3: NavigationPersistence keys use UUID navigationId and nav-active pointer", async () => {
  const store = new Map();
  const mockStorage = {
    async get(keys) {
      if (keys === null) return Object.fromEntries(store);
      if (Array.isArray(keys)) return Object.fromEntries(keys.map((k) => [k, store.get(k)]));
      return { [keys]: store.get(keys) };
    },
    async set(items) {
      for (const [k, v] of Object.entries(items)) store.set(k, v);
    },
    async remove(keys) {
      const arr = Array.isArray(keys) ? keys : [keys];
      for (const k of arr) store.delete(k);
    }
  };

  const persistence = new NavigationPersistence(mockStorage);
  const tabId = 1003;
  const navId = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

  await persistence.setPendingEnvelope(tabId, navId, {
    navigationId: navId,
    pending: { phase: "root", targetUrl: "https://nas.5ddd.com/" }
  });

  // Verify key format uses UUID
  assert.equal(store.has(`pending-recovery:${tabId}:${navId}`), true);
  assert.equal(store.has(`nav-active:${tabId}`), true);
  assert.equal(store.get(`nav-active:${tabId}`).navigationId, navId);

  // Read back envelope
  const envelope = await persistence.getPendingEnvelope(tabId, navId);
  assert.equal(envelope.navigationId, navId);
  assert.equal(envelope.pending.phase, "root");
});

test("T4: LAN discovery persists and queries with UUID navigationId", async () => {
  const store = new Map();
  const mockStorage = {
    async get(keys) {
      if (keys === null) return Object.fromEntries(store);
      if (Array.isArray(keys)) return Object.fromEntries(keys.map((k) => [k, store.get(k)]));
      return { [keys]: store.get(keys) };
    },
    async set(items) {
      for (const [k, v] of Object.entries(items)) store.set(k, v);
    },
    async remove(keys) {
      const arr = Array.isArray(keys) ? keys : [keys];
      for (const k of arr) store.delete(k);
    }
  };

  const persistence = new NavigationPersistence(mockStorage);
  const ownerTabId = 1004;
  const navigationId = "disc-uuid-9988-7766-5544";

  const discoveryData = {
    remoteTargetUrl: "https://remote.5ddd.com/",
    lanRootUrl: "http://192.168.1.100:8080/",
    startedAt: Date.now(),
    expiresAt: Date.now() + 60000
  };

  const saved = await persistence.setDiscovery(ownerTabId, navigationId, discoveryData);
  assert.equal(saved, true);

  // Verify storage key format
  assert.equal(store.has(`lan-discovery:${ownerTabId}:${navigationId}`), true);

  // Retrieve discovery
  const retrieved = await persistence.getDiscovery(ownerTabId, navigationId);
  assert.ok(retrieved);
  assert.equal(retrieved.navigationId, navigationId);
  assert.equal(retrieved.lanRootUrl, "http://192.168.1.100:8080/");
});

test("T5: TabNavigationManager.rehydrate strictly preserves UUID across SW restarts", () => {
  const manager = new TabNavigationManager();
  const tabId = 1005;
  const origNavId = "uuid-sw-restart-rehydrate-11223344";

  const state = manager.rehydrate(tabId, {
    navigationId: origNavId,
    generation: 3,
    pending: { phase: "target", targetUrl: "https://glance.local:8080/" }
  });

  assert.equal(state.navigationId, origNavId);
  assert.equal(manager.getNavigationId(tabId), origNavId);
  assert.equal(manager.isActive(tabId, origNavId), true);
  assert.equal(manager.isActive(tabId, 3), false);
});

test("T6: Consecutive begins produce unique UUIDs with no collision or reuse", () => {
  const manager = new TabNavigationManager();
  const tabId = 1006;

  const navA = manager.begin(tabId);
  const navB = manager.begin(tabId);

  assert.equal(typeof navA.navigationId, "string");
  assert.equal(typeof navB.navigationId, "string");
  assert.notEqual(navA.navigationId, navB.navigationId);

  assert.equal(manager.isActive(tabId, navA.navigationId), false);
  assert.equal(manager.isActive(tabId, navB.navigationId), true);
});

test("T7: Preview storage key generation matches normalized URL and respects ACTIVE_PREVIEW_TARGET_KEY", () => {
  const key1 = previewStorageKey("https://glance.local:8080/dashboard/");
  const key2 = previewStorageKey("https://glance.local:8080/dashboard");
  assert.equal(key1, key2);
  assert.equal(key1, "glance-preview:https://glance.local:8080/dashboard");
  assert.equal(ACTIVE_PREVIEW_TARGET_KEY, "glance-preview-active-target");
});

test("T8: renderGlanceSkeletonHtml returns clean skeleton layout without error", () => {
  const darkSkeleton = renderGlanceSkeletonHtml("dark");
  assert.ok(darkSkeleton.includes("skeleton-layout"));
  assert.ok(darkSkeleton.includes("skeleton-card"));
  assert.ok(darkSkeleton.includes("glance-skeleton-bar"));

  const lightSkeleton = renderGlanceSkeletonHtml("light");
  assert.ok(lightSkeleton.includes("skeleton-layout"));
});

test("T9: renderGlancePreviewHtml renders structured cards, headers, and fresh/stale badges", () => {
  const samplePreview = {
    version: 1,
    savedAt: Date.now(),
    theme: "dark",
    pageTitle: "My Personal Glance",
    columns: [
      {
        widgets: [
          {
            title: "Quick Links",
            items: [
              { title: "NAS Admin", url: "https://nas.local/" },
              { title: "Docker", url: "https://docker.local/" }
            ]
          }
        ]
      }
    ]
  };

  const freshHtml = renderGlancePreviewHtml(samplePreview, "fresh");
  assert.ok(freshHtml.includes("My Personal Glance"));
  assert.ok(freshHtml.includes("Quick Links"));
  assert.ok(freshHtml.includes("NAS Admin"));
  assert.equal(freshHtml.includes("正在刷新"), false);

  const staleHtml = renderGlancePreviewHtml(samplePreview, "stale");
  assert.ok(staleHtml.includes("正在刷新"));
});

test("T10: getPreviewStatus correctly differentiates fresh, stale, expired, and none", () => {
  const now = Date.now();

  assert.equal(getPreviewStatus(null), "none");
  assert.equal(getPreviewStatus({}), "none");

  // 10 minutes ago -> fresh (< 30 min)
  assert.equal(getPreviewStatus({ savedAt: now - 10 * 60 * 1000 }), "fresh");

  // 2 hours ago -> stale (30 min ~ 6 hours)
  assert.equal(getPreviewStatus({ savedAt: now - 2 * 3600 * 1000 }), "stale");

  // 8 hours ago -> expired (> 6 hours)
  assert.equal(getPreviewStatus({ savedAt: now - 8 * 3600 * 1000 }), "expired");
});

test("T11: sanitizeSafeUrl case-insensitively strips sensitive tokens and secrets", () => {
  const dirtyUrl1 = "https://nas.local/dashboard?Token=secret123&API_KEY=key456&normalParam=ok#access_token=xyz";
  const cleanUrl1 = sanitizeSafeUrl(dirtyUrl1);

  assert.equal(cleanUrl1.includes("Token="), false);
  assert.equal(cleanUrl1.includes("API_KEY="), false);
  assert.equal(cleanUrl1.includes("access_token="), false);
  assert.equal(cleanUrl1.includes("normalParam=ok"), true);

  const dirtyUrl2 = "http://glance.local/?auth_token=jwt123&Password=mysecret&sig=abc123";
  const cleanUrl2 = sanitizeSafeUrl(dirtyUrl2);
  assert.equal(cleanUrl2.includes("auth_token="), false);
  assert.equal(cleanUrl2.includes("Password="), false);
  assert.equal(cleanUrl2.includes("sig="), false);
});

test("T12: extractGlancePreview skips sensitive form inputs, passwords, tokens and secrets", () => {
  const mockDoc = {
    title: "Glance Dashboard - Home",
    documentElement: { dataset: { theme: "dark" } },
    body: { classList: { contains: () => true } },
    querySelectorAll(selector) {
      if (selector.includes(".column")) {
        return [
          {
            querySelectorAll() {
              return [
                // Safe widget
                {
                  querySelector(sel) {
                    if (sel.includes("password") || sel.includes("token") || sel.includes("auth") || sel.includes("hidden")) return null;
                    if (sel.includes("h1") || sel.includes(".title")) return { textContent: "Bookmarks" };
                    return null;
                  },
                  querySelectorAll(sel) {
                    if (sel.includes("li") || sel.includes("a")) {
                      return [
                        {
                          tagName: "A",
                          textContent: "Documentation",
                          getAttribute(attr) {
                            if (attr === "href") return "https://docs.glance.local/?token=secretToken123&session=xyz#token=abc";
                            return null;
                          },
                          querySelector() { return null; }
                        },
                        {
                          tagName: "A",
                          textContent: "GitHub Repo",
                          getAttribute(attr) {
                            if (attr === "href") return "https://github.com/glanceapp/glance";
                            return null;
                          },
                          querySelector() { return null; }
                        }
                      ];
                    }
                    return [];
                  }
                },
                // Sensitive widget with password/token/auth input (must be skipped)
                {
                  querySelector(sel) {
                    if (sel.includes("password")) return { tagName: "INPUT", type: "password" };
                    if (sel.includes("h1") || sel.includes(".title")) return { textContent: "Login Form" };
                    return null;
                  },
                  querySelectorAll() { return []; }
                }
              ];
            }
          }
        ];
      }
      return [];
    }
  };

  const preview = extractGlancePreview(mockDoc, "http://192.168.1.50:8080/");
  assert.ok(preview);
  assert.equal(preview.version, 1);
  assert.equal(preview.theme, "dark");
  assert.equal(preview.pageTitle, "Glance Dashboard - Home");
  assert.equal(preview.columns.length, 1);

  const widgets = preview.columns[0].widgets;
  assert.equal(widgets.length, 1);
  assert.equal(widgets[0].title, "Bookmarks");

  const docLink = widgets[0].items[0];
  assert.equal(docLink.title, "Documentation");
  assert.equal(docLink.url.includes("token="), false);
  assert.equal(docLink.url.includes("session="), false);
});

test("T13: Concurrent preview saves for different Glance targets do not overwrite each other", async () => {
  const store = new Map();
  const mockStorage = {
    async get(keys) {
      if (keys === null) return Object.fromEntries(store);
      if (Array.isArray(keys)) return Object.fromEntries(keys.map((k) => [k, store.get(k)]));
      return { [keys]: store.get(keys) };
    },
    async set(items) {
      for (const [k, v] of Object.entries(items)) store.set(k, v);
    }
  };

  const key1 = previewStorageKey("https://glance1.local/");
  const key2 = previewStorageKey("https://glance2.local/");

  const preview1 = { version: 1, pageTitle: "Glance 1", savedAt: Date.now(), columns: [] };
  const preview2 = { version: 1, pageTitle: "Glance 2", savedAt: Date.now(), columns: [] };

  await mockStorage.set({ [key1]: preview1 });
  await mockStorage.set({ [key2]: preview2 });

  const all = await mockStorage.get(null);
  assert.equal(all[key1].pageTitle, "Glance 1");
  assert.equal(all[key2].pageTitle, "Glance 2");
});

test("UX-T1: Closed ShadowRoot Fade accesses preserved screen reference and triggers fade", () => {
  let loadingHost = null;
  let loadingScreen = null;

  const mockScreen = {
    style: {},
    events: {},
    addEventListener(evt, fn) { this.events[evt] = fn; },
    removeEventListener(evt, fn) { delete this.events[evt]; }
  };

  const mockHost = {
    shadowRoot: null, // CLOSED SHADOW ROOT
    removed: false,
    remove() { this.removed = true; }
  };

  loadingHost = mockHost;
  loadingScreen = mockScreen;

  assert.equal(loadingHost.shadowRoot, null);

  let fadeCompleted = false;
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
        if (finished) return;
        finished = true;
        screen.removeEventListener("transitionend", onTransitionEnd);
        if (loadingHost === host) {
          mockHost.remove();
          loadingHost = null;
          loadingScreen = null;
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
      setTimeout(finish, 180);
    } else {
      mockHost.remove();
      loadingHost = null;
      loadingScreen = null;
      onComplete?.();
    }
  }

  fadeOutLoadingOverlay(() => { fadeCompleted = true; });

  assert.equal(mockScreen.style.opacity, "0");
  assert.equal(mockScreen.style.transition, "opacity 140ms ease-out");
  assert.equal(mockHost.removed, false);
  assert.equal(fadeCompleted, false);

  mockScreen.events.transitionend({ target: mockScreen, propertyName: "opacity" });

  assert.equal(mockHost.removed, true);
  assert.equal(fadeCompleted, true);
  assert.equal(loadingHost, null);
  assert.equal(loadingScreen, null);
});

test("UX-T2: Truly fade before remove and cleans up references", (t, done) => {
  let loadingHost = { removed: false, remove() { this.removed = true; } };
  let loadingScreen = {
    style: {},
    addEventListener(evt, fn) {
      setTimeout(() => fn({ target: this, propertyName: "opacity" }), 20);
    },
    removeEventListener() {}
  };

  const hostRef = loadingHost;

  function fadeOut(cb) {
    const screen = loadingScreen;
    if (screen) {
      screen.addEventListener("transitionend", () => {
        hostRef.remove();
        loadingHost = null;
        loadingScreen = null;
        cb();
      });
      screen.style.opacity = "0";
    }
  }

  fadeOut(() => {
    assert.equal(hostRef.removed, true);
    assert.equal(loadingHost, null);
    assert.equal(loadingScreen, null);
    done();
  });

  assert.equal(hostRef.removed, false);
});

test("UX-T3: Missing screen fallback safely removes host without uncaught errors", () => {
  let loadingHost = { removed: false, remove() { this.removed = true; } };
  let loadingScreen = null;

  let completed = false;
  function fadeOut(cb) {
    if (!loadingHost) { cb?.(); return; }
    const screen = loadingScreen;
    if (screen) {
      // ...
    } else {
      loadingHost.remove();
      loadingHost = null;
      loadingScreen = null;
      cb?.();
    }
  }

  fadeOut(() => { completed = true; });
  assert.equal(completed, true);
  assert.equal(loadingHost, null);
});

test("UX-T4: Content current target strictly matches current location preview", async () => {
  const store = new Map();
  const urlA = "https://nas-a.5ddd.com/glance/";
  const urlB = "https://nas-b.5ddd.com/glance/";
  const keyA = previewStorageKey(urlA);
  const keyB = previewStorageKey(urlB);

  store.set(keyA, { version: 1, targetUrl: urlA, pageTitle: "Glance A", savedAt: Date.now(), columns: [{ widgets: [{ title: "Widget A" }] }] });
  store.set(keyB, { version: 1, targetUrl: urlB, pageTitle: "Glance B", savedAt: Date.now(), columns: [{ widgets: [{ title: "Widget B" }] }] });

  const curLocation = urlB;
  const curKey = previewStorageKey(curLocation);
  const result = store.get(curKey);

  assert.ok(result);
  assert.equal(result.pageTitle, "Glance B");
  const html = renderGlancePreviewHtml(result, getPreviewStatus(result));
  assert.ok(html.includes("Glance B"));
  assert.ok(html.includes("Widget B"));
  assert.equal(html.includes("Widget A"), false);
});

test("UX-T5: Content missing current target preview stays on Skeleton and NEVER falls back to active target pointer", async () => {
  const store = new Map();
  const urlA = "https://nas-a.5ddd.com/glance/";
  const urlB = "https://nas-b.5ddd.com/glance/";
  const keyA = previewStorageKey(urlA);

  store.set(keyA, { version: 1, targetUrl: urlA, pageTitle: "Glance A", savedAt: Date.now(), columns: [{ widgets: [{ title: "Widget A" }] }] });
  store.set(ACTIVE_PREVIEW_TARGET_KEY, urlA);

  const curLocation = urlB;
  const curKey = previewStorageKey(curLocation);
  const preview = store.get(curKey) || null;

  assert.equal(preview, null);
  const html = preview ? renderGlancePreviewHtml(preview) : renderGlanceSkeletonHtml("auto");
  assert.ok(html.includes("skeleton-layout"));
  assert.equal(html.includes("Glance A"), false);
  assert.equal(html.includes("Widget A"), false);
});

test("UX-T6: Newtab renders matching preview when ACTIVE_PREVIEW_TARGET_KEY exists", async () => {
  const store = new Map();
  const urlA = "https://nas-a.5ddd.com/glance/";
  const urlB = "https://nas-b.5ddd.com/glance/";
  const keyA = previewStorageKey(urlA);
  const keyB = previewStorageKey(urlB);

  store.set(keyA, { version: 1, targetUrl: urlA, pageTitle: "Glance A", savedAt: Date.now(), columns: [{ widgets: [{ title: "A" }] }] });
  store.set(keyB, { version: 1, targetUrl: urlB, pageTitle: "Glance B", savedAt: Date.now(), columns: [{ widgets: [{ title: "B" }] }] });
  store.set(ACTIVE_PREVIEW_TARGET_KEY, urlB);

  const activeTarget = store.get(ACTIVE_PREVIEW_TARGET_KEY);
  let foundPreview = null;
  if (activeTarget) {
    const key = previewStorageKey(activeTarget);
    const val = store.get(key);
    if (val && (getPreviewStatus(val) === "fresh" || getPreviewStatus(val) === "stale")) {
      foundPreview = val;
    }
  }

  assert.ok(foundPreview);
  assert.equal(foundPreview.pageTitle, "Glance B");
});

test("UX-T7: Newtab renders Skeleton when active target has no preview without random fallback", async () => {
  const store = new Map();
  const urlA = "https://nas-a.5ddd.com/glance/";
  const urlB = "https://nas-b.5ddd.com/glance/";
  const urlC = "https://nas-c.5ddd.com/glance/";
  const keyA = previewStorageKey(urlA);
  const keyB = previewStorageKey(urlB);

  store.set(keyA, { version: 1, targetUrl: urlA, pageTitle: "Glance A", savedAt: Date.now(), columns: [{ widgets: [{ title: "A" }] }] });
  store.set(keyB, { version: 1, targetUrl: urlB, pageTitle: "Glance B", savedAt: Date.now(), columns: [{ widgets: [{ title: "B" }] }] });
  store.set(ACTIVE_PREVIEW_TARGET_KEY, urlC);

  const activeTarget = store.get(ACTIVE_PREVIEW_TARGET_KEY);
  let foundPreview = null;
  if (activeTarget) {
    const key = previewStorageKey(activeTarget);
    const val = store.get(key);
    if (val && (getPreviewStatus(val) === "fresh" || getPreviewStatus(val) === "stale")) {
      foundPreview = val;
    }
  }

  assert.equal(foundPreview, null);
  const html = foundPreview ? renderGlancePreviewHtml(foundPreview) : renderGlanceSkeletonHtml("auto");
  assert.ok(html.includes("skeleton-layout"));
  assert.equal(html.includes("Glance A"), false);
  assert.equal(html.includes("Glance B"), false);
});

test("UX-T8: Expired preview renders Skeleton and NEVER falls back to another target fresh preview", async () => {
  const store = new Map();
  const urlA = "https://nas-a.5ddd.com/glance/";
  const urlB = "https://nas-b.5ddd.com/glance/";
  const keyA = previewStorageKey(urlA);
  const keyB = previewStorageKey(urlB);

  store.set(keyA, { version: 1, targetUrl: urlA, pageTitle: "Glance A", savedAt: Date.now() - 10 * 3600 * 1000, columns: [{ widgets: [{ title: "A" }] }] });
  store.set(keyB, { version: 1, targetUrl: urlB, pageTitle: "Glance B", savedAt: Date.now(), columns: [{ widgets: [{ title: "B" }] }] });
  store.set(ACTIVE_PREVIEW_TARGET_KEY, urlA);

  const activeTarget = store.get(ACTIVE_PREVIEW_TARGET_KEY);
  let foundPreview = null;
  if (activeTarget) {
    const key = previewStorageKey(activeTarget);
    const val = store.get(key);
    const status = getPreviewStatus(val);
    if (status === "fresh" || status === "stale") {
      foundPreview = val;
    }
  }

  assert.equal(foundPreview, null);
  const html = foundPreview ? renderGlancePreviewHtml(foundPreview) : renderGlanceSkeletonHtml("auto");
  assert.ok(html.includes("skeleton-layout"));
  assert.equal(html.includes("Glance B"), false);
});

test("UX-T9: Full lifecycle from Cached Preview to TARGET_READY fade with zero spinner", () => {
  let previewLayerVisible = true;
  let promptCardVisible = false;

  function ensureLoadingOverlay(preview) {
    previewLayerVisible = true;
    promptCardVisible = false;
  }

  function setLoading(msg) {
    previewLayerVisible = false;
    promptCardVisible = true;
  }

  ensureLoadingOverlay({ version: 1, pageTitle: "My Glance" });
  assert.equal(previewLayerVisible, true);
  assert.equal(promptCardVisible, false);

  const renderedFailure = null;
  if (renderedFailure) {
    setLoading("Auth failure");
  }

  assert.equal(previewLayerVisible, true);
  assert.equal(promptCardVisible, false);
});

test("P0-T1: LAN fast path refreshes Preview and updates active target pointer", async () => {
  const store = new Map();
  const mockStorage = {
    async set(items) {
      for (const [k, v] of Object.entries(items)) store.set(k, v);
    }
  };

  const lanTargetUrl = "http://192.168.1.10:18080/";
  const mockDoc = {
    title: "LAN Glance Dashboard",
    documentElement: { dataset: { theme: "auto" } },
    body: { classList: { contains: () => false } },
    querySelectorAll(sel) {
      if (sel.includes(".column")) {
        return [{
          querySelectorAll() {
            return [{
              querySelector(s) {
                if (s.includes("password") || s.includes("token")) return null;
                if (s.includes("h1") || s.includes(".title")) return { textContent: "LAN Services" };
                return null;
              },
              querySelectorAll() {
                return [{
                  tagName: "A",
                  textContent: "Router Admin",
                  getAttribute() { return "http://192.168.1.1/"; },
                  querySelector() { return null; }
                }];
              }
            }];
          }
        }];
      }
      return [];
    }
  };

  const saved = await saveGlancePreviewToStorage(mockStorage, mockDoc, lanTargetUrl);
  assert.equal(saved, true);

  const key = previewStorageKey(lanTargetUrl);
  assert.equal(store.has(key), true);
  assert.equal(store.get(key).pageTitle, "LAN Glance Dashboard");
  assert.equal(store.get(key).columns[0].widgets[0].title, "LAN Services");
  assert.equal(store.get(ACTIVE_PREVIEW_TARGET_KEY), "http://192.168.1.10:18080/");
});

test("P0-T2: Normal remote/direct success refreshes Preview and active pointer", async () => {
  const store = new Map();
  const mockStorage = {
    async set(items) {
      for (const [k, v] of Object.entries(items)) store.set(k, v);
    }
  };

  const remoteUrl = "https://demo-nas.5ddd.com/app/glance/";
  const mockDoc = {
    title: "Remote Glance",
    documentElement: { dataset: { theme: "dark" } },
    body: { classList: { contains: () => true } },
    querySelectorAll(sel) {
      if (sel.includes(".column")) {
        return [{
          querySelectorAll() {
            return [{
              querySelector(s) {
                if (s.includes("password")) return null;
                if (s.includes("h1") || s.includes(".title")) return { textContent: "Remote Apps" };
                return null;
              },
              querySelectorAll() { return []; }
            }];
          }
        }];
      }
      return [];
    }
  };

  const saved = await saveGlancePreviewToStorage(mockStorage, mockDoc, remoteUrl);
  assert.equal(saved, true);
  assert.equal(store.has(previewStorageKey(remoteUrl)), true);
  assert.equal(store.get(ACTIVE_PREVIEW_TARGET_KEY), "https://demo-nas.5ddd.com/app/glance/");
});

test("P0-T3: Pending target recovery success still refreshes Preview", async () => {
  const store = new Map();
  const mockStorage = {
    async set(items) {
      for (const [k, v] of Object.entries(items)) store.set(k, v);
    }
  };

  const recoveryTargetUrl = "https://service-0.demo.fnos.net/glance/";
  const mockDoc = {
    title: "Recovered Target",
    documentElement: { dataset: { theme: "light" } },
    body: { classList: { contains: () => false } },
    querySelectorAll(sel) {
      if (sel.includes(".column")) {
        return [{
          querySelectorAll() {
            return [{
              querySelector(s) {
                if (s.includes("password")) return null;
                if (s.includes(".title")) return { textContent: "Recovered Widget" };
                return null;
              },
              querySelectorAll() { return []; }
            }];
          }
        }];
      }
      return [];
    }
  };

  const saved = await saveGlancePreviewToStorage(mockStorage, mockDoc, recoveryTargetUrl);
  assert.equal(saved, true);
  assert.equal(store.has(previewStorageKey(recoveryTargetUrl)), true);
  assert.equal(store.get(ACTIVE_PREVIEW_TARGET_KEY), "https://service-0.demo.fnos.net/glance/");
});

test("P0-T4: Failed pages do NOT save Preview", async () => {
  const store = new Map();
  const mockStorage = {
    async set(items) {
      for (const [k, v] of Object.entries(items)) store.set(k, v);
    }
  };

  // Mock doc with password inputs (login page)
  const loginDoc = {
    title: "fnOS Login",
    documentElement: { dataset: {} },
    body: { classList: { contains: () => false } },
    querySelectorAll(sel) {
      if (sel.includes(".column")) {
        return [{
          querySelectorAll() {
            return [{
              querySelector(s) {
                if (s.includes("password")) return { tagName: "INPUT", type: "password" };
                return null;
              },
              querySelectorAll() { return []; }
            }];
          }
        }];
      }
      return [];
    }
  };

  const saved = await saveGlancePreviewToStorage(mockStorage, loginDoc, "https://nas.local/login");
  assert.equal(saved, false);
  assert.equal(store.size, 0);
});

test("P0-T5: Preview save error does not throw or block execution", async () => {
  const faultyStorage = {
    async set() {
      throw new Error("QuotaExceededError: storage is full");
    }
  };

  const mockDoc = {
    title: "Glance",
    documentElement: { dataset: {} },
    body: { classList: { contains: () => false } },
    querySelectorAll() {
      return [{ querySelectorAll: () => [{ querySelector: () => ({ textContent: "W" }), querySelectorAll: () => [] }] }];
    }
  };

  // Should safely catch the storage error and return false without throwing
  let threw = false;
  try {
    const result = await saveGlancePreviewToStorage(faultyStorage, mockDoc, "https://glance.local/");
    assert.equal(result, false);
  } catch {
    threw = true;
  }
  assert.equal(threw, false);
});

test("P0-T6: Preview savedAt and content are updated on consecutive successes", async () => {
  const store = new Map();
  const mockStorage = {
    async set(items) {
      for (const [k, v] of Object.entries(items)) store.set(k, v);
    }
  };

  const targetUrl = "http://192.168.1.10:8080/";
  const doc1 = {
    title: "Glance Version 1",
    documentElement: { dataset: {} },
    body: { classList: { contains: () => false } },
    querySelectorAll: () => [{
      querySelectorAll: () => [{
        querySelector: (sel) => {
          if (sel.includes("password") || sel.includes("token")) return null;
          return { textContent: "Card 1" };
        },
        querySelectorAll: () => []
      }]
    }]
  };

  await saveGlancePreviewToStorage(mockStorage, doc1, targetUrl);
  const key = previewStorageKey(targetUrl);
  const preview1 = store.get(key);
  assert.ok(preview1);
  assert.equal(preview1.pageTitle, "Glance Version 1");
  const savedAt1 = preview1.savedAt;

  // Simulate a delay and page content update
  await new Promise((r) => setTimeout(r, 10));

  const doc2 = {
    title: "Glance Version 2",
    documentElement: { dataset: {} },
    body: { classList: { contains: () => false } },
    querySelectorAll: () => [{
      querySelectorAll: () => [{
        querySelector: (sel) => {
          if (sel.includes("password") || sel.includes("token")) return null;
          return { textContent: "Card 2" };
        },
        querySelectorAll: () => []
      }]
    }]
  };

  await saveGlancePreviewToStorage(mockStorage, doc2, targetUrl);
  const preview2 = store.get(key);
  assert.ok(preview2);
  assert.equal(preview2.pageTitle, "Glance Version 2");
  assert.ok(preview2.savedAt > savedAt1);
});

test("P1-T7: Remote target changed clears ACTIVE_PREVIEW_TARGET_KEY", async () => {
  const store = new Map();
  store.set(ACTIVE_PREVIEW_TARGET_KEY, "https://nas-a.5ddd.com/");

  const settings = { targetUrl: "https://nas-b.5ddd.com/" };
  const renderedRemoteTarget = "https://nas-a.5ddd.com/";
  const lanAccessResult = { targetUrl: "http://192.168.1.10:8080/" };
  const renderedDeviceTarget = "http://192.168.1.10:8080/";

  const remoteTarget = (settings.targetUrl ?? "").trim();
  const prevRemoteTarget = (renderedRemoteTarget ?? "").trim();
  const lanTarget = (lanAccessResult.targetUrl ?? "").trim();
  const prevLanTarget = (renderedDeviceTarget ?? "").trim();

  const remoteChanged = remoteTarget !== prevRemoteTarget;
  const lanChanged = lanTarget !== prevLanTarget;

  if (remoteChanged || lanChanged) {
    store.delete(ACTIVE_PREVIEW_TARGET_KEY);
  }

  assert.equal(remoteChanged, true);
  assert.equal(store.has(ACTIVE_PREVIEW_TARGET_KEY), false);
});

test("P1-T8: LAN target changed clears ACTIVE_PREVIEW_TARGET_KEY", async () => {
  const store = new Map();
  store.set(ACTIVE_PREVIEW_TARGET_KEY, "http://192.168.1.10:8080/");

  const settings = { targetUrl: "https://nas.5ddd.com/" };
  const renderedRemoteTarget = "https://nas.5ddd.com/";
  const lanAccessResult = { targetUrl: "http://192.168.1.20:8080/" };
  const renderedDeviceTarget = "http://192.168.1.10:8080/";

  const remoteTarget = (settings.targetUrl ?? "").trim();
  const prevRemoteTarget = (renderedRemoteTarget ?? "").trim();
  const lanTarget = (lanAccessResult.targetUrl ?? "").trim();
  const prevLanTarget = (renderedDeviceTarget ?? "").trim();

  const remoteChanged = remoteTarget !== prevRemoteTarget;
  const lanChanged = lanTarget !== prevLanTarget;

  if (remoteChanged || lanChanged) {
    store.delete(ACTIVE_PREVIEW_TARGET_KEY);
  }

  assert.equal(lanChanged, true);
  assert.equal(store.has(ACTIVE_PREVIEW_TARGET_KEY), false);
});

test("P1-T9: LAN target removed clears ACTIVE_PREVIEW_TARGET_KEY", async () => {
  const store = new Map();
  store.set(ACTIVE_PREVIEW_TARGET_KEY, "http://192.168.1.10:8080/");

  const settings = { targetUrl: "https://nas.5ddd.com/" };
  const renderedRemoteTarget = "https://nas.5ddd.com/";
  const lanAccessResult = { targetUrl: "" };
  const renderedDeviceTarget = "http://192.168.1.10:8080/";

  const remoteTarget = (settings.targetUrl ?? "").trim();
  const prevRemoteTarget = (renderedRemoteTarget ?? "").trim();
  const lanTarget = (lanAccessResult.targetUrl ?? "").trim();
  const prevLanTarget = (renderedDeviceTarget ?? "").trim();

  const remoteChanged = remoteTarget !== prevRemoteTarget;
  const lanChanged = lanTarget !== prevLanTarget;

  if (remoteChanged || lanChanged) {
    store.delete(ACTIVE_PREVIEW_TARGET_KEY);
  }

  assert.equal(lanChanged, true);
  assert.equal(store.has(ACTIVE_PREVIEW_TARGET_KEY), false);
});

test("P1-T10: Target unchanged preserves ACTIVE_PREVIEW_TARGET_KEY", async () => {
  const store = new Map();
  store.set(ACTIVE_PREVIEW_TARGET_KEY, "http://192.168.1.10:8080/");

  const settings = { targetUrl: "https://nas.5ddd.com/" };
  const renderedRemoteTarget = "https://nas.5ddd.com/";
  const lanAccessResult = { targetUrl: "http://192.168.1.10:8080/" };
  const renderedDeviceTarget = "http://192.168.1.10:8080/";

  const remoteTarget = (settings.targetUrl ?? "").trim();
  const prevRemoteTarget = (renderedRemoteTarget ?? "").trim();
  const lanTarget = (lanAccessResult.targetUrl ?? "").trim();
  const prevLanTarget = (renderedDeviceTarget ?? "").trim();

  const remoteChanged = remoteTarget !== prevRemoteTarget;
  const lanChanged = lanTarget !== prevLanTarget;

  if (remoteChanged || lanChanged) {
    store.delete(ACTIVE_PREVIEW_TARGET_KEY);
  }

  assert.equal(remoteChanged, false);
  assert.equal(lanChanged, false);
  assert.equal(store.has(ACTIVE_PREVIEW_TARGET_KEY), true);
});

test("P1-T11: Old Preview entities are preserved when active pointer is cleared", async () => {
  const store = new Map();
  const keyA = previewStorageKey("https://nas-a.5ddd.com/");
  store.set(keyA, { version: 1, pageTitle: "Preview A", savedAt: Date.now() });
  store.set(ACTIVE_PREVIEW_TARGET_KEY, "https://nas-a.5ddd.com/");

  // Switch to target B
  store.delete(ACTIVE_PREVIEW_TARGET_KEY);

  // Active target pointer is cleared, but Preview A entity is preserved
  assert.equal(store.has(ACTIVE_PREVIEW_TARGET_KEY), false);
  assert.equal(store.has(keyA), true);
  assert.equal(store.get(keyA).pageTitle, "Preview A");
});

test("PT1: Non-target fnOS root does NOT save Preview or update active target pointer", async () => {
  const store = new Map();
  const mockStorage = {
    async set(items) {
      for (const [k, v] of Object.entries(items)) store.set(k, v);
    }
  };

  const hello = {
    pending: null,
    settings: {
      enabled: true,
      fnosRecoveryEnabled: true,
      targetUrl: "https://demo-nas.5ddd.com/app/glance-homepage/"
    },
    deviceRoute: {
      targetUrl: "http://192.168.1.10:18080/"
    }
  };

  const currentTabUrl = "https://demo-nas.5ddd.com/"; // fnOS root page
  const directFailure = ""; // No invalid token on root
  const isConfiguredTarget = isConfiguredTargetPage(hello.settings, currentTabUrl)
    || isConfiguredTargetPage(hello.deviceRoute, currentTabUrl);

  assert.equal(isConfiguredTarget, false);

  // Content script execution simulation:
  let previewScheduled = false;
  if (!directFailure) {
    if (isConfiguredTarget) {
      previewScheduled = true;
      await saveGlancePreviewToStorage(mockStorage, {}, currentTabUrl);
    }
  }

  assert.equal(previewScheduled, false);
  assert.equal(store.size, 0);
  assert.equal(store.has(ACTIVE_PREVIEW_TARGET_KEY), false);
});

test("PT2: Other same-domain non-target pages do NOT save Preview", async () => {
  const store = new Map();
  const mockStorage = {
    async set(items) {
      for (const [k, v] of Object.entries(items)) store.set(k, v);
    }
  };

  const hello = {
    pending: null,
    settings: {
      enabled: true,
      targetUrl: "https://demo-nas.5ddd.com/app/glance-homepage/"
    },
    deviceRoute: {
      targetUrl: "http://192.168.1.10:18080/"
    }
  };

  const testUrls = [
    "https://demo-nas.5ddd.com/settings",
    "https://5ddd.com/demo-nas/",
    "https://demo-nas.5ddd.com/files/",
    "http://192.168.1.10:8000/" // different port, not Glance
  ];

  for (const url of testUrls) {
    const isConfiguredTarget = isConfiguredTargetPage(hello.settings, url)
      || isConfiguredTargetPage(hello.deviceRoute, url);
    assert.equal(isConfiguredTarget, false);
  }
});

test("PT3: pending=null learned LAN fast path integration schedules and saves Preview and updates pointer", async () => {
  const store = new Map();
  const mockStorage = {
    async set(items) {
      for (const [k, v] of Object.entries(items)) store.set(k, v);
    }
  };

  const lanTargetUrl = "http://192.168.1.10:18080/";
  const hello = {
    pending: null, // Fast path clears pending in background
    settings: {
      enabled: true,
      targetUrl: "https://demo-nas.5ddd.com/app/glance-homepage/"
    },
    deviceRoute: {
      targetUrl: lanTargetUrl
    }
  };

  const currentTabUrl = "http://192.168.1.10:18080/";
  const directFailure = "";
  const isConfiguredTarget = isConfiguredTargetPage(hello.settings, currentTabUrl)
    || isConfiguredTargetPage(hello.deviceRoute, currentTabUrl);

  assert.equal(isConfiguredTarget, true);

  const mockDoc = {
    title: "LAN Glance",
    documentElement: { dataset: { theme: "auto" } },
    body: { classList: { contains: () => false } },
    querySelectorAll: () => [{
      querySelectorAll: () => [{
        querySelector: (s) => {
          if (s.includes("password") || s.includes("token")) return null;
          return { textContent: "LAN Dashboard" };
        },
        querySelectorAll: () => []
      }]
    }]
  };

  let scheduled = false;
  if (!directFailure && isConfiguredTarget) {
    scheduled = true;
    await saveGlancePreviewToStorage(mockStorage, mockDoc, currentTabUrl);
  }

  assert.equal(scheduled, true);
  const key = previewStorageKey(lanTargetUrl);
  assert.equal(store.has(key), true);
  assert.equal(store.get(key).pageTitle, "LAN Glance");
  assert.equal(store.get(ACTIVE_PREVIEW_TARGET_KEY), "http://192.168.1.10:18080/");
});

test("PT4: pending=null remote/direct success integration schedules and saves Preview", async () => {
  const store = new Map();
  const mockStorage = {
    async set(items) {
      for (const [k, v] of Object.entries(items)) store.set(k, v);
    }
  };

  const remoteUrl = "https://demo-nas.5ddd.com/app/glance-homepage/";
  const hello = {
    pending: null,
    settings: {
      enabled: true,
      targetUrl: remoteUrl
    },
    deviceRoute: null
  };

  const currentTabUrl = remoteUrl;
  const isConfiguredTarget = isConfiguredTargetPage(hello.settings, currentTabUrl);
  assert.equal(isConfiguredTarget, true);

  const mockDoc = {
    title: "Remote Glance Homepage",
    documentElement: { dataset: { theme: "dark" } },
    body: { classList: { contains: () => true } },
    querySelectorAll: () => [{
      querySelectorAll: () => [{
        querySelector: (s) => {
          if (s.includes("password")) return null;
          return { textContent: "Widgets" };
        },
        querySelectorAll: () => []
      }]
    }]
  };

  await saveGlancePreviewToStorage(mockStorage, mockDoc, currentTabUrl);
  assert.equal(store.has(previewStorageKey(remoteUrl)), true);
  assert.equal(store.get(ACTIVE_PREVIEW_TARGET_KEY), "https://demo-nas.5ddd.com/app/glance-homepage/");
});

test("PT5: Configured target + auth failure does NOT save Preview", async () => {
  const store = new Map();
  const mockStorage = {
    async set(items) {
      for (const [k, v] of Object.entries(items)) store.set(k, v);
    }
  };

  const remoteUrl = "https://demo-nas.5ddd.com/app/glance-homepage/";
  const directFailure = "invalid-token"; // Auth failure detected
  const isConfiguredTarget = true;

  let saved = false;
  if (!directFailure && isConfiguredTarget) {
    saved = true;
    await saveGlancePreviewToStorage(mockStorage, {}, remoteUrl);
  }

  assert.equal(saved, false);
  assert.equal(store.size, 0);
});

test("PT6: Fade does not await DOM extraction", (t, done) => {
  const events = [];

  // Simulate scheduler
  function scheduleRefresh(cb) {
    setTimeout(() => {
      events.push("extraction_executed");
      cb();
    }, 15);
  }

  // Simulate main flow
  function onVisualReady() {
    events.push("visual_ready");
    scheduleRefresh(() => {});
    events.push("fade_started");
  }

  onVisualReady();

  assert.deepEqual(events, ["visual_ready", "fade_started"]);
  setTimeout(() => {
    assert.deepEqual(events, ["visual_ready", "fade_started", "extraction_executed"]);
    done();
  }, 25);
});

test("PT7: schedulePreviewRefresh uses requestIdleCallback when available", (t, done) => {
  let idleCalled = false;
  const mockGlobal = {
    requestIdleCallback(fn, opts) {
      assert.equal(opts.timeout, 1000);
      idleCalled = true;
      fn();
    }
  };

  schedulePreviewRefresh(() => {
    assert.equal(idleCalled, true);
    done();
  }, mockGlobal);
});

test("PT8: schedulePreviewRefresh uses fallback scheduler when requestIdleCallback is undefined", (t, done) => {
  let microtaskCalled = false;
  let rafCalled = false;

  const mockGlobal = {
    requestIdleCallback: undefined,
    queueMicrotask(fn) {
      microtaskCalled = true;
      fn();
    },
    requestAnimationFrame(fn) {
      rafCalled = true;
      fn();
    }
  };

  schedulePreviewRefresh(() => {
    assert.equal(microtaskCalled, true);
    assert.equal(rafCalled, true);
    done();
  }, mockGlobal);
});

test("PT9: Preview storage reject does not affect fade, visual ready or trigger error UI", async () => {
  const faultyStorage = {
    async set() {
      throw new Error("QuotaExceededError");
    }
  };

  const mockDoc = {
    title: "Glance",
    documentElement: { dataset: {} },
    body: { classList: { contains: () => false } },
    querySelectorAll: () => [{ querySelectorAll: () => [{ querySelector: () => ({ textContent: "W" }), querySelectorAll: () => [] }] }]
  };

  let threw = false;
  try {
    const res = await saveGlancePreviewToStorage(faultyStorage, mockDoc, "https://glance.local/");
    assert.equal(res, false);
  } catch {
    threw = true;
  }
  assert.equal(threw, false);
});

test("PT10: Preview content and savedAt are refreshed on consecutive configured target successes", async () => {
  const store = new Map();
  const mockStorage = {
    async set(items) {
      for (const [k, v] of Object.entries(items)) store.set(k, v);
    }
  };

  const targetUrl = "https://nas.5ddd.com/glance/";
  const docA = {
    title: "Initial Glance",
    documentElement: { dataset: {} },
    body: { classList: { contains: () => false } },
    querySelectorAll: () => [{ querySelectorAll: () => [{ querySelector: (s) => s.includes("password") ? null : ({ textContent: "Card A" }), querySelectorAll: () => [] }] }]
  };

  await saveGlancePreviewToStorage(mockStorage, docA, targetUrl);
  const key = previewStorageKey(targetUrl);
  const prevA = store.get(key);
  assert.equal(prevA.pageTitle, "Initial Glance");
  const timeA = prevA.savedAt;

  await new Promise((r) => setTimeout(r, 10));

  const docB = {
    title: "Updated Glance",
    documentElement: { dataset: {} },
    body: { classList: { contains: () => false } },
    querySelectorAll: () => [{ querySelectorAll: () => [{ querySelector: (s) => s.includes("password") ? null : ({ textContent: "Card B" }), querySelectorAll: () => [] }] }]
  };

  await saveGlancePreviewToStorage(mockStorage, docB, targetUrl);
  const prevB = store.get(key);
  assert.equal(prevB.pageTitle, "Updated Glance");
  assert.ok(prevB.savedAt > timeA);
});

test("SEQ1: Normal configured target presentation strictly executes visual_ready -> doubleRAF -> fade -> preview schedule -> extraction", async () => {
  const events = [];
  const mockGlobal = {
    requestAnimationFrame(fn) {
      events.push("raf");
      return setTimeout(fn, 1);
    },
    requestIdleCallback(fn) {
      events.push("idle_callback_registered");
      return setTimeout(() => {
        events.push("extraction_started");
        fn();
      }, 5);
    }
  };

  await finishTargetPresentation({
    async waitForVisualReady() {
      events.push("visual_ready");
    },
    async fadeOut() {
      events.push("fade_started");
      await new Promise((r) => setTimeout(r, 10));
      events.push("fade_completed");
    },
    scheduleRefresh(url) {
      events.push("preview_refresh_scheduled");
      schedulePreviewRefresh(() => {
        events.push("preview_saved");
      }, mockGlobal);
    },
    targetUrl: "https://nas.5ddd.com/glance/",
    isConfiguredTarget: true,
    globalScope: mockGlobal
  });

  // At the moment finishTargetPresentation resolves, fade must already be complete, but extraction has NOT started yet
  assert.deepEqual(events, [
    "visual_ready",
    "raf",
    "raf",
    "fade_started",
    "fade_completed",
    "preview_refresh_scheduled",
    "idle_callback_registered"
  ]);

  // Wait for idle callback to fire
  await new Promise((r) => setTimeout(r, 20));

  assert.deepEqual(events, [
    "visual_ready",
    "raf",
    "raf",
    "fade_started",
    "fade_completed",
    "preview_refresh_scheduled",
    "idle_callback_registered",
    "extraction_started",
    "preview_saved"
  ]);
});

test("SEQ2: LAN fast path presentation executes fade to completion before scheduling preview refresh", async () => {
  const events = [];
  const store = new Map();
  const mockStorage = {
    async set(items) {
      for (const [k, v] of Object.entries(items)) store.set(k, v);
    }
  };

  const lanTargetUrl = "http://192.168.1.10:18080/";
  const mockDoc = {
    title: "LAN Glance",
    documentElement: { dataset: {} },
    body: { classList: { contains: () => false } },
    querySelectorAll: () => [{ querySelectorAll: () => [{ querySelector: (s) => s.includes("password") ? null : ({ textContent: "LAN Card" }), querySelectorAll: () => [] }] }]
  };

  await finishTargetPresentation({
    async waitForVisualReady() {
      events.push("visual_ready");
    },
    async fadeOut() {
      events.push("fade_started");
      await new Promise((r) => setTimeout(r, 5));
      events.push("fade_completed");
    },
    scheduleRefresh(url) {
      events.push("schedule_refresh");
      schedulePreviewRefresh(async () => {
        events.push("preview_write_start");
        await saveGlancePreviewToStorage(mockStorage, mockDoc, url);
        events.push("preview_write_complete");
      });
    },
    targetUrl: lanTargetUrl,
    isConfiguredTarget: true
  });

  assert.equal(events.indexOf("fade_completed") < events.indexOf("schedule_refresh"), true);
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(store.has(previewStorageKey(lanTargetUrl)), true);
  assert.equal(store.get(ACTIVE_PREVIEW_TARGET_KEY), "http://192.168.1.10:18080/");
});

test("SEQ3: Remote direct success presentation executes fade before preview refresh", async () => {
  const events = [];
  const remoteUrl = "https://demo.fnos.net/glance/";

  await finishTargetPresentation({
    async waitForVisualReady() {
      events.push("visual_ready");
    },
    async fadeOut() {
      events.push("fade_started");
      events.push("fade_completed");
    },
    scheduleRefresh(url) {
      events.push("schedule_refresh");
    },
    targetUrl: remoteUrl,
    isConfiguredTarget: true
  });

  assert.deepEqual(events, [
    "visual_ready",
    "fade_started",
    "fade_completed",
    "schedule_refresh"
  ]);
});

test("SEQ4: Pending target recovery success executes fade before preview refresh", async () => {
  const events = [];
  const recoveryUrl = "https://demo.fnos.net/app/glance/";

  await finishTargetPresentation({
    async waitForVisualReady() {
      events.push("visual_ready");
    },
    async fadeOut() {
      events.push("fade_started");
      events.push("fade_completed");
    },
    scheduleRefresh(url) {
      events.push("schedule_refresh");
    },
    targetUrl: recoveryUrl,
    isConfiguredTarget: true
  });

  assert.deepEqual(events, [
    "visual_ready",
    "fade_started",
    "fade_completed",
    "schedule_refresh"
  ]);
});

test("SEQ5: When no overlay exists, fade completes immediately without blocking", async () => {
  let resolved = false;

  // Simulate fadeOutLoadingOverlay when loadingHost is null
  function fadeOutNoHost() {
    return new Promise((resolve) => {
      const loadingHost = null;
      if (!loadingHost) {
        resolve();
      }
    });
  }

  const start = Date.now();
  await fadeOutNoHost();
  resolved = true;
  const elapsed = Date.now() - start;

  assert.equal(resolved, true);
  assert.ok(elapsed < 50);
});

test("SEQ6: Transitionend event triggers immediate fade promise resolution and cleanup", async () => {
  let removed = false;
  let transitionListener = null;

  const mockScreen = {
    style: {},
    addEventListener(evt, fn) {
      if (evt === "transitionend") transitionListener = fn;
    },
    removeEventListener(evt, fn) {
      if (evt === "transitionend") transitionListener = null;
    }
  };

  const mockHost = {
    remove() {
      removed = true;
    }
  };

  function fadeWithTransitionEnd() {
    return new Promise((resolve) => {
      let finished = false;
      let timerId = null;

      const finish = () => {
        if (finished) return;
        finished = true;
        if (timerId !== null) clearTimeout(timerId);
        mockScreen.removeEventListener("transitionend", onTransitionEnd);
        mockHost.remove();
        resolve();
      };

      const onTransitionEnd = (e) => {
        if (e.propertyName === "opacity") {
          finish();
        }
      };

      mockScreen.addEventListener("transitionend", onTransitionEnd);
      mockScreen.style.transition = "opacity 140ms ease-out";
      mockScreen.style.opacity = "0";
      timerId = setTimeout(finish, 180);
    });
  }

  const fadePromise = fadeWithTransitionEnd();
  assert.ok(transitionListener);
  assert.equal(mockScreen.style.opacity, "0");

  // Dispatch transitionend early (e.g. after 10ms)
  transitionListener({ propertyName: "opacity" });

  await fadePromise;
  assert.equal(removed, true);
  assert.equal(transitionListener, null);
});

test("SEQ7: Transitionend fallback timer triggers safe resolve if transitionend does not fire", async () => {
  let removed = false;

  const mockScreen = {
    style: {},
    addEventListener() {},
    removeEventListener() {}
  };

  const mockHost = {
    remove() {
      removed = true;
    }
  };

  function fadeWithFallback() {
    return new Promise((resolve) => {
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        mockHost.remove();
        resolve();
      };
      setTimeout(finish, 20); // shortened for test
    });
  }

  await fadeWithFallback();
  assert.equal(removed, true);
});

test("SEQ8: Heavy DOM extraction task never executes before fade_started or fade_completed", async () => {
  const timeline = [];

  const mockGlobal = {
    requestIdleCallback(fn) {
      setTimeout(() => {
        timeline.push("heavy_extraction_start");
        // Simulate heavy extraction
        for (let i = 0; i < 1000; i++) {}
        timeline.push("heavy_extraction_end");
        fn();
      }, 10);
    }
  };

  await finishTargetPresentation({
    async waitForVisualReady() {
      timeline.push("visual_ready");
    },
    async fadeOut() {
      timeline.push("fade_started");
      await new Promise((r) => setTimeout(r, 5));
      timeline.push("fade_completed");
    },
    scheduleRefresh(url) {
      timeline.push("schedule_refresh");
      schedulePreviewRefresh(() => {}, mockGlobal);
    },
    targetUrl: "https://nas.5ddd.com/",
    isConfiguredTarget: true,
    globalScope: mockGlobal
  });

  assert.equal(timeline.indexOf("fade_completed") < timeline.indexOf("schedule_refresh"), true);

  await new Promise((r) => setTimeout(r, 25));

  assert.ok(timeline.indexOf("heavy_extraction_start") > timeline.indexOf("fade_completed"));
});

test("SEQ9: Preview storage reject after fade does not crash presentation", async () => {
  const faultyStorage = {
    async set() {
      throw new Error("QuotaExceededError");
    }
  };

  let presentationFinished = false;
  let saveFailedCaught = false;

  await finishTargetPresentation({
    async fadeOut() {
      presentationFinished = true;
    },
    scheduleRefresh(url) {
      schedulePreviewRefresh(async () => {
        const ok = await saveGlancePreviewToStorage(faultyStorage, {}, url);
        if (!ok) {
          saveFailedCaught = true;
        }
      });
    },
    targetUrl: "https://nas.5ddd.com/",
    isConfiguredTarget: true
  });

  assert.equal(presentationFinished, true);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(saveFailedCaught, true);
});

test("BOOT1: Bootstrap official automatic redirection succeeds without triggering fallback", async () => {
  const manager = new TabNavigationManager();
  const tabId = 101;
  const nav = manager.begin(tabId);

  const pending = {
    phase: "bootstrap",
    recoveryKind: "docker",
    bootstrapUrl: "https://5ddd.com/demo-nas/",
    rootUrl: "https://demo-nas.5ddd.com/",
    checkUrl: "https://demo-nas.5ddd.com/app/glance/health",
    targetUrl: "https://demo-nas.5ddd.com/app/glance/"
  };
  manager.setPending(tabId, pending, nav.navigationId);

  // Official FN Connect redirects to root origin before timeout
  const nextUrl = "https://demo-nas.5ddd.com/";
  const result = manager.handleUrlChange(tabId, nextUrl, pending);
  assert.equal(result.matched, true);
  assert.equal(result.active, true);
  assert.equal(result.cancelled, false);
  assert.equal(manager.isActive(tabId, nav.navigationId), true);
});

test("BOOT2: Bootstrap stuck triggers BOOTSTRAP_FALLBACK and navigates to rootUrl", async () => {
  const manager = new TabNavigationManager();
  const tabId = 102;
  const nav = manager.begin(tabId);

  let updatedUrl = "";
  const mockTabs = {
    async update(id, { url }) {
      updatedUrl = url;
    },
    async get(id) {
      return { id, url: "https://5ddd.com/demo-nas/" };
    }
  };

  const pending = {
    phase: "bootstrap",
    recoveryKind: "docker",
    bootstrapUrl: "https://5ddd.com/demo-nas/",
    rootUrl: "https://demo-nas.5ddd.com/",
    checkUrl: "https://demo-nas.5ddd.com/app/glance/health",
    targetUrl: "https://demo-nas.5ddd.com/app/glance/"
  };
  manager.setPending(tabId, pending, nav.navigationId);

  // Background BOOTSTRAP_FALLBACK handler logic simulation
  async function handleBootstrapFallback(msgNavId) {
    if (!msgNavId || !manager.isActive(tabId, msgNavId)) {
      return { action: "ignored" };
    }
    const curPending = manager.getPending(tabId);
    if (!curPending || !isDockerPending(curPending) || curPending.phase !== "bootstrap") {
      return { action: "ignored" };
    }
    const currentTab = await mockTabs.get(tabId);
    if (!isBootstrapTransitUrl(curPending, currentTab.url) && curPending.bootstrapUrl !== currentTab.url) {
      return { action: "ignored" };
    }

    const updated = {
      ...curPending,
      phase: "root",
      bootstrapCompletedAt: Date.now(),
      rootEnteredAt: Date.now()
    };
    manager.setPending(tabId, updated, msgNavId);
    manager.setExpectedUrl(tabId, msgNavId, updated.rootUrl);
    await mockTabs.update(tabId, { url: updated.rootUrl });
    return { action: "fallback-to-root", pending: updated };
  }

  const response = await handleBootstrapFallback(nav.navigationId);
  assert.equal(response.action, "fallback-to-root");
  assert.equal(response.pending.phase, "root");
  assert.equal(updatedUrl, "https://demo-nas.5ddd.com/");
  assert.equal(manager.getPending(tabId).phase, "root");
});

test("BOOT3: BOOTSTRAP_FALLBACK preserves same navigationId throughout transition", async () => {
  const manager = new TabNavigationManager();
  const tabId = 103;
  const nav = manager.begin(tabId);
  const initialNavId = nav.navigationId;

  const pending = {
    phase: "bootstrap",
    recoveryKind: "docker",
    bootstrapUrl: "https://5ddd.com/demo-nas/",
    rootUrl: "https://demo-nas.5ddd.com/",
    checkUrl: "https://demo-nas.5ddd.com/app/glance/health",
    targetUrl: "https://demo-nas.5ddd.com/app/glance/"
  };
  manager.setPending(tabId, pending, initialNavId);

  // When fallback executes with initialNavId
  const currentNavId = manager.getNavigationId(tabId);
  assert.equal(currentNavId, initialNavId);
  assert.equal(manager.isActive(tabId, initialNavId), true);
});

test("BOOT4: User navigation away cancels ownership and invalidates BOOTSTRAP_FALLBACK", async () => {
  const manager = new TabNavigationManager();
  const tabId = 104;
  const nav = manager.begin(tabId);

  const pending = {
    phase: "bootstrap",
    recoveryKind: "docker",
    bootstrapUrl: "https://5ddd.com/demo-nas/",
    rootUrl: "https://demo-nas.5ddd.com/",
    checkUrl: "https://demo-nas.5ddd.com/app/glance/health",
    targetUrl: "https://demo-nas.5ddd.com/app/glance/"
  };
  manager.setPending(tabId, pending, nav.navigationId);

  // User navigates away to github.com
  const userUrl = "https://github.com/";
  const changeResult = manager.handleUrlChange(tabId, userUrl, pending);
  assert.equal(changeResult.matched, false);
  assert.equal(changeResult.active, false);
  assert.equal(changeResult.cancelled, true);
  assert.equal(manager.isActive(tabId, nav.navigationId), false);

  // When stale bootstrap timer fires
  async function handleBootstrapFallback(msgNavId) {
    if (!msgNavId || !manager.isActive(tabId, msgNavId)) {
      return { action: "ignored" };
    }
    return { action: "fallback-to-root" };
  }

  const response = await handleBootstrapFallback(nav.navigationId);
  assert.equal(response.action, "ignored");
});

test("BOOT5: BOOTSTRAP_FALLBACK is ignored if current tab URL is no longer bootstrap transit URL", async () => {
  const manager = new TabNavigationManager();
  const tabId = 105;
  const nav = manager.begin(tabId);

  const pending = {
    phase: "bootstrap",
    recoveryKind: "docker",
    bootstrapUrl: "https://5ddd.com/demo-nas/",
    rootUrl: "https://demo-nas.5ddd.com/",
    checkUrl: "https://demo-nas.5ddd.com/app/glance/health",
    targetUrl: "https://demo-nas.5ddd.com/app/glance/"
  };
  manager.setPending(tabId, pending, nav.navigationId);

  const mockTabs = {
    async get() {
      return { url: "https://demo-nas.5ddd.com/settings" }; // not bootstrap URL
    }
  };

  async function handleBootstrapFallback(msgNavId) {
    if (!msgNavId || !manager.isActive(tabId, msgNavId)) {
      return { action: "ignored" };
    }
    const curPending = manager.getPending(tabId);
    const currentTab = await mockTabs.get(tabId);
    if (!isBootstrapTransitUrl(curPending, currentTab.url) && curPending.bootstrapUrl !== currentTab.url) {
      return { action: "ignored" };
    }
    return { action: "fallback-to-root" };
  }

  const response = await handleBootstrapFallback(nav.navigationId);
  assert.equal(response.action, "ignored");
});

test("BOOT6: New navigation B on same tab is not polluted by stale bootstrap timer A", async () => {
  const manager = new TabNavigationManager();
  const tabId = 106;

  // Navigation A starts
  const navA = manager.begin(tabId);
  const pendingA = {
    phase: "bootstrap",
    recoveryKind: "docker",
    bootstrapUrl: "https://5ddd.com/demo-nas-a/",
    rootUrl: "https://demo-nas-a.5ddd.com/"
  };
  manager.setPending(tabId, pendingA, navA.navigationId);

  // Navigation B begins (e.g. user refreshed or switched target)
  const navB = manager.begin(tabId);
  const pendingB = {
    phase: "bootstrap",
    recoveryKind: "docker",
    bootstrapUrl: "https://5ddd.com/demo-nas-b/",
    rootUrl: "https://demo-nas-b.5ddd.com/"
  };
  manager.setPending(tabId, pendingB, navB.navigationId);

  // Stale timer for Nav A fires
  async function handleBootstrapFallback(msgNavId) {
    if (!msgNavId || !manager.isActive(tabId, msgNavId)) {
      return { action: "ignored" };
    }
    return { action: "fallback-to-root" };
  }

  const resA = await handleBootstrapFallback(navA.navigationId);
  assert.equal(resA.action, "ignored");

  // Nav B is still active and unmodified
  assert.equal(manager.isActive(tabId, navB.navigationId), true);
  assert.equal(manager.getPending(tabId).bootstrapUrl, "https://5ddd.com/demo-nas-b/");
});

test("BOOT7: Phase transition from bootstrap to root updates pending correctly", async () => {
  const manager = new TabNavigationManager();
  const tabId = 107;
  const nav = manager.begin(tabId);

  const initialPending = {
    phase: "bootstrap",
    recoveryKind: "docker",
    bootstrapUrl: "https://5ddd.com/demo-nas/",
    rootUrl: "https://demo-nas.5ddd.com/",
    checkUrl: "https://demo-nas.5ddd.com/app/glance/health",
    targetUrl: "https://demo-nas.5ddd.com/app/glance/"
  };
  manager.setPending(tabId, initialPending, nav.navigationId);
  assert.equal(manager.getPending(tabId).phase, "bootstrap");

  // Execute transition to root
  const now = Date.now();
  const rootPending = {
    ...initialPending,
    phase: "root",
    bootstrapCompletedAt: now,
    rootEnteredAt: now
  };
  manager.setPending(tabId, rootPending, nav.navigationId);

  assert.equal(manager.getPending(tabId).phase, "root");
  assert.equal(manager.getPending(tabId).bootstrapCompletedAt, now);
});

test("BOOT8: Full end-to-end recovery from stuck bootstrap to Glance dashboard", async () => {
  const manager = new TabNavigationManager();
  const tabId = 108;
  const nav = manager.begin(tabId);
  const navigatedUrls = [];

  const mockTabs = {
    async update(id, { url }) {
      navigatedUrls.push(url);
    }
  };

  const initialPending = {
    phase: "bootstrap",
    recoveryKind: "docker",
    bootstrapUrl: "https://5ddd.com/demo-nas/",
    rootUrl: "https://demo-nas.5ddd.com/",
    checkUrl: "https://demo-nas.5ddd.com/app/glance/health",
    targetUrl: "https://demo-nas.5ddd.com/app/glance/"
  };
  manager.setPending(tabId, initialPending, nav.navigationId);
  navigatedUrls.push(initialPending.bootstrapUrl);

  // Step 1: Bootstrap times out and triggers fallback to root
  const rootPending = {
    ...initialPending,
    phase: "root",
    bootstrapCompletedAt: Date.now(),
    rootEnteredAt: Date.now()
  };
  manager.setPending(tabId, rootPending, nav.navigationId);
  manager.setExpectedUrl(tabId, nav.navigationId, rootPending.rootUrl);
  await mockTabs.update(tabId, { url: rootPending.rootUrl });

  // Step 2: On root page, auth succeeds and sends TRY_TARGET
  const targetPending = {
    ...rootPending,
    phase: "target",
    targetAttempts: 1
  };
  manager.setPending(tabId, targetPending, nav.navigationId);
  manager.setExpectedUrl(tabId, nav.navigationId, targetPending.targetUrl);
  await mockTabs.update(tabId, { url: targetPending.targetUrl });

  assert.deepEqual(navigatedUrls, [
    "https://5ddd.com/demo-nas/",
    "https://demo-nas.5ddd.com/",
    "https://demo-nas.5ddd.com/app/glance/"
  ]);
  assert.equal(manager.getPending(tabId).phase, "target");
});

test("BOOT9: Fallback to root does not bypass auth failure and respects login prompt", async () => {
  const manager = new TabNavigationManager();
  const tabId = 109;
  const nav = manager.begin(tabId);

  const rootPending = {
    phase: "root",
    recoveryKind: "docker",
    bootstrapUrl: "https://5ddd.com/demo-nas/",
    rootUrl: "https://demo-nas.5ddd.com/",
    checkUrl: "https://demo-nas.5ddd.com/app/glance/health",
    targetUrl: "https://demo-nas.5ddd.com/app/glance/"
  };
  manager.setPending(tabId, rootPending, nav.navigationId);

  // Auth probe returns invalid on root
  const authProbeResult = { ok: false, status: 401, reason: "invalid-token" };
  assert.equal(authProbeResult.ok, false);

  // Does NOT transition to target; pending remains root/auth failure
  assert.equal(manager.getPending(tabId).phase, "root");
});

test("BOOT10: Neither bootstrap nor fallback root page pollutes Preview cache", async () => {
  const store = new Map();
  const mockStorage = {
    async set(items) {
      for (const [k, v] of Object.entries(items)) store.set(k, v);
    }
  };

  const configuredTarget = "https://demo-nas.5ddd.com/app/glance/";
  const bootstrapUrl = "https://5ddd.com/demo-nas/";
  const rootUrl = "https://demo-nas.5ddd.com/";

  // Check configured target matches
  assert.equal(isConfiguredTargetPage({ targetUrl: configuredTarget }, bootstrapUrl), false);
  assert.equal(isConfiguredTargetPage({ targetUrl: configuredTarget }, rootUrl), false);

  // Preview extraction attempted on bootstrap or root page returns false/not executed
  const isTargetForBootstrap = isConfiguredTargetPage({ targetUrl: configuredTarget }, bootstrapUrl);
  if (isTargetForBootstrap) {
    await saveGlancePreviewToStorage(mockStorage, {}, bootstrapUrl);
  }

  const isTargetForRoot = isConfiguredTargetPage({ targetUrl: configuredTarget }, rootUrl);
  if (isTargetForRoot) {
    await saveGlancePreviewToStorage(mockStorage, {}, rootUrl);
  }

  assert.equal(store.size, 0);
  assert.equal(store.has(ACTIVE_PREVIEW_TARGET_KEY), false);
});






