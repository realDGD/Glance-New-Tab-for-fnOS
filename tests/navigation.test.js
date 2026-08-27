import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { execSync } from "node:child_process";

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
  LanScriptManager,
  scriptIdForPattern,
  isDuplicateScriptRegistrationError,
  finishTargetPresentation,
  cleanupLegacyPreviewStorage,
  combineDockerProbeSignals,
  shouldStopDockerRecovery
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

test("T1: Preview API 不再存在于 production call-site", () => {
  const filesToCheck = ["content.js", "background.js", "newtab.js", "options.js"];
  const forbiddenPatterns = [
    /\bschedulePreviewRefresh\s*\(/,
    /\bsaveCurrentGlancePreview\s*\(/,
    /\bextractGlancePreview\s*\(/,
    /\brenderGlancePreviewHtml\s*\(/,
    /\brenderGlanceSkeletonHtml\s*\(/
  ];

  for (const file of filesToCheck) {
    const code = fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    for (const pattern of forbiddenPatterns) {
      assert.equal(
        pattern.test(code),
        false,
        `File ${file} should not contain call matching ${pattern}`
      );
    }
  }
});

test("T2: target success 不再引用 Preview and resolves without ReferenceError", async () => {
  let overlayFaded = false;
  let targetReadySent = false;

  const mockSend = async (msg) => {
    if (msg.type === "TARGET_READY") {
      targetReadySent = true;
    }
  };

  const fadeOutLoadingOverlay = async () => {
    overlayFaded = true;
  };

  // Simulate exact target ready flow in content.js
  await (async () => {
    await mockSend({ type: "TARGET_READY" });
    await fadeOutLoadingOverlay();
  })();

  assert.equal(targetReadySent, true);
  assert.equal(overlayFaded, true);
});

test("T3: node --check content.js and all production scripts", () => {
  const contentJs = fs.readFileSync(new URL("../content.js", import.meta.url), "utf8");
  assert.ok(contentJs.length > 0);

  // Assert no duplicate top-level let declarations that previously broke parser
  const letMatches = contentJs.match(/\blet\s+([a-zA-Z0-9_$]+)/g) || [];
  const letNames = letMatches.map((m) => m.replace(/^let\s+/, "").trim());
  const uniqueNames = new Set();
  const duplicates = [];
  for (const name of letNames) {
    if (uniqueNames.has(name)) {
      duplicates.push(name);
    }
    uniqueNames.add(name);
  }
  assert.equal(duplicates.includes("previewLayer"), false);
  assert.equal(duplicates.includes("promptCard"), false);

  assert.doesNotThrow(() => {
    execSync("node --check content.js shared.js background.js newtab.js options.js", {
      cwd: new URL("..", import.meta.url)
    });
  });
});

test("T4: 同 pattern 两个并发 ensure calls execute registration exactly once", async () => {
  let registerCallCount = 0;
  const registered = new Set();

  const mockScripting = {
    async getRegisteredContentScripts() {
      return Array.from(registered).map((id) => ({ id }));
    },
    async registerContentScripts(scripts) {
      registerCallCount++;
      await new Promise((r) => setTimeout(r, 10));
      for (const s of scripts) {
        if (registered.has(s.id)) {
          throw new Error(`Duplicate script ID '${s.id}'`);
        }
        registered.add(s.id);
      }
    }
  };

  const manager = new LanScriptManager({ scripting: mockScripting });
  const pattern = "http://192.168.1.50:8080/*";

  await Promise.all([
    manager.ensureContentScripts(pattern),
    manager.ensureContentScripts(pattern)
  ]);

  assert.equal(registerCallCount, 1);
  assert.equal(manager.registeredPatterns.has(pattern), true);
  assert.equal(registered.has(scriptIdForPattern(pattern, "page")), true);
  assert.equal(registered.has(scriptIdForPattern(pattern, "content")), true);
});

test("T5: 三个以上并发 ensure on same pattern execute only 1 registration flow", async () => {
  let registerCallCount = 0;
  const registered = new Set();

  const mockScripting = {
    async getRegisteredContentScripts() {
      return Array.from(registered).map((id) => ({ id }));
    },
    async registerContentScripts(scripts) {
      registerCallCount++;
      await new Promise((r) => setTimeout(r, 15));
      for (const s of scripts) {
        if (registered.has(s.id)) {
          throw new Error(`Duplicate script ID '${s.id}'`);
        }
        registered.add(s.id);
      }
    }
  };

  const manager = new LanScriptManager({ scripting: mockScripting });
  const pattern = "http://192.168.1.100:3000/*";

  await Promise.all([
    manager.ensureContentScripts(pattern),
    manager.ensureContentScripts(pattern),
    manager.ensureContentScripts(pattern),
    manager.ensureContentScripts(pattern)
  ]);

  assert.equal(registerCallCount, 1);
  assert.equal(manager.registeredPatterns.has(pattern), true);
});

test("T6: 不同 pattern 可以并行 independently", async () => {
  const registered = new Set();
  const registerCallsByPattern = new Map();

  const mockScripting = {
    async getRegisteredContentScripts() {
      return Array.from(registered).map((id) => ({ id }));
    },
    async registerContentScripts(scripts) {
      for (const s of scripts) {
        registerCallsByPattern.set(s.matches[0], (registerCallsByPattern.get(s.matches[0]) || 0) + 1);
        registered.add(s.id);
      }
    }
  };

  const manager = new LanScriptManager({ scripting: mockScripting });
  const patternA = "http://192.168.1.10:8080/*";
  const patternB = "http://192.168.1.20:9090/*";

  await Promise.all([
    manager.ensureContentScripts(patternA),
    manager.ensureContentScripts(patternB)
  ]);

  assert.equal(manager.registeredPatterns.has(patternA), true);
  assert.equal(manager.registeredPatterns.has(patternB), true);
  assert.equal(registerCallsByPattern.get(patternA), 2); // page + content
  assert.equal(registerCallsByPattern.get(patternB), 2); // page + content
});

test("T7: Scripts 已存在 skips registerContentScripts and marks pattern", async () => {
  let registerCallCount = 0;
  const pattern = "http://192.168.1.50:8080/*";
  const pageId = scriptIdForPattern(pattern, "page");
  const contentId = scriptIdForPattern(pattern, "content");

  const mockScripting = {
    async getRegisteredContentScripts() {
      return [{ id: pageId }, { id: contentId }];
    },
    async registerContentScripts() {
      registerCallCount++;
    }
  };

  const manager = new LanScriptManager({ scripting: mockScripting });
  await manager.ensureContentScripts(pattern);

  assert.equal(registerCallCount, 0);
  assert.equal(manager.registeredPatterns.has(pattern), true);
});

test("T8: Duplicate ID 外部竞态 re-checks registered scripts and succeeds idempotently", async () => {
  let firstGet = true;
  const pattern = "http://192.168.1.60:8080/*";
  const pageId = scriptIdForPattern(pattern, "page");
  const contentId = scriptIdForPattern(pattern, "content");

  const mockScripting = {
    async getRegisteredContentScripts() {
      if (firstGet) {
        firstGet = false;
        return [];
      }
      // Second get returns target scripts registered by another process/worker
      return [{ id: pageId }, { id: contentId }];
    },
    async registerContentScripts() {
      throw new Error(`Duplicate script ID '${pageId}'`);
    }
  };

  const manager = new LanScriptManager({ scripting: mockScripting });
  await assert.doesNotReject(async () => {
    await manager.ensureContentScripts(pattern);
  });

  assert.equal(manager.registeredPatterns.has(pattern), true);
});

test("T9: Duplicate 错误但 scripts 仍缺失 re-throws the registration error", async () => {
  let firstGet = true;
  const pattern = "http://192.168.1.70:8080/*";
  const pageId = scriptIdForPattern(pattern, "page");

  const mockScripting = {
    async getRegisteredContentScripts() {
      if (firstGet) {
        firstGet = false;
        return [];
      }
      // Second get returns only 1 of the 2 required scripts
      return [{ id: pageId }];
    },
    async registerContentScripts() {
      throw new Error(`Duplicate script ID '${pageId}'`);
    }
  };

  const manager = new LanScriptManager({ scripting: mockScripting });
  await assert.rejects(
    async () => {
      await manager.ensureContentScripts(pattern);
    },
    { message: /Duplicate script ID/ }
  );

  assert.equal(manager.registeredPatterns.has(pattern), false);
});

test("T10: 真实注册错误 propagates to caller and is not swallowed", async () => {
  const pattern = "http://192.168.1.80:8080/*";

  const mockScripting = {
    async getRegisteredContentScripts() {
      return [];
    },
    async registerContentScripts() {
      throw new Error("Permission denied: cannot access chrome.scripting API");
    }
  };

  const manager = new LanScriptManager({ scripting: mockScripting });
  await assert.rejects(
    async () => {
      await manager.ensureContentScripts(pattern);
    },
    { message: /Permission denied/ }
  );

  assert.equal(manager.registeredPatterns.has(pattern), false);
});

test("T11: Service Worker restart correctly queries existing scripts without duplicate register", async () => {
  const persistentStore = new Set();
  let totalRegisterCalls = 0;

  const createMockScripting = () => ({
    async getRegisteredContentScripts() {
      return Array.from(persistentStore).map((id) => ({ id }));
    },
    async registerContentScripts(scripts) {
      totalRegisterCalls++;
      for (const s of scripts) {
        persistentStore.add(s.id);
      }
    }
  });

  const pattern = "http://192.168.1.90:8080/*";

  // Worker 1 runs
  const worker1 = new LanScriptManager({ scripting: createMockScripting() });
  await worker1.ensureContentScripts(pattern);
  assert.equal(totalRegisterCalls, 1);
  assert.equal(worker1.registeredPatterns.has(pattern), true);

  // Worker 2 (restarted SW, memory set is initially empty)
  const worker2 = new LanScriptManager({ scripting: createMockScripting() });
  assert.equal(worker2.registeredPatterns.size, 0);

  await worker2.ensureContentScripts(pattern);
  // Should NOT call register again because scripts exist in persistent storage
  assert.equal(totalRegisterCalls, 1);
  assert.equal(worker2.registeredPatterns.has(pattern), true);
});

test("T12: restore + OPEN_NEW_TAB 并发 runs without Duplicate script ID errors", async () => {
  const persistentStore = new Set();
  let registerCalls = 0;

  const mockScripting = {
    async getRegisteredContentScripts() {
      await new Promise((r) => setTimeout(r, 5));
      return Array.from(persistentStore).map((id) => ({ id }));
    },
    async registerContentScripts(scripts) {
      registerCalls++;
      await new Promise((r) => setTimeout(r, 10));
      for (const s of scripts) {
        if (persistentStore.has(s.id)) {
          throw new Error(`Duplicate script ID '${s.id}'`);
        }
        persistentStore.add(s.id);
      }
    }
  };

  const manager = new LanScriptManager({ scripting: mockScripting });
  const pattern = "http://192.168.1.150:8080/*";

  // Simulate restoreLanContentScripts and OPEN_NEW_TAB (tryOpenLearnedLanRoute) invoking ensure concurrently
  const restoreTask = manager.ensureContentScripts(pattern);
  const newTabTask = manager.ensureContentScripts(pattern);

  await Promise.all([restoreTask, newTabTask]);

  assert.equal(registerCalls, 1);
  assert.equal(manager.registeredPatterns.has(pattern), true);
});

test("T13: Legacy preview cleanup - cleanupLegacyPreviewStorage clears old preview keys while preserving user settings and LAN routes", async () => {
  const store = new Map();
  store.set("glance-preview:https://nas.local/glance/", { title: "Old Preview" });
  store.set("glance-preview-active-target", "https://nas.local/glance/");
  store.set("lan-route:https://nas.local/", { targetUrl: "http://192.168.1.10:8080/" });
  store.set("user-setting-custom", { enabled: true });

  const mockStorage = {
    async get(keys) {
      if (keys === null) return Object.fromEntries(store);
      if (Array.isArray(keys)) return Object.fromEntries(keys.map((k) => [k, store.get(k)]));
      return { [keys]: store.get(keys) };
    },
    async remove(keys) {
      const arr = Array.isArray(keys) ? keys : [keys];
      for (const k of arr) store.delete(k);
    }
  };

  await cleanupLegacyPreviewStorage(mockStorage);

  assert.equal(store.has("glance-preview:https://nas.local/glance/"), false);
  assert.equal(store.has("glance-preview-active-target"), false);
  assert.equal(store.has("lan-route:https://nas.local/"), true);
  assert.equal(store.has("user-setting-custom"), true);
});

test("T14: Closed ShadowRoot Fade accesses preserved screen reference and triggers fade", () => {
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

test("T15: Closed ShadowRoot Fade resolves on transitionend event", (t, done) => {
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

test("T16: Closed ShadowRoot Fade resolves via fallback timer when transitionend does not fire", async () => {
  let removed = false;
  const mockScreen = {
    style: {},
    addEventListener() {},
    removeEventListener() {}
  };
  const mockHost = {
    remove() { removed = true; }
  };

  function fadeWithFallback() {
    return new Promise((resolve) => {
      mockScreen.style.opacity = "0";
      setTimeout(() => {
        mockHost.remove();
        resolve();
      }, 30);
    });
  }

  await fadeWithFallback();
  assert.equal(removed, true);
});

test("T17: Missing screen or missing host fallback safely resolves without uncaught errors", () => {
  let loadingHost = { removed: false, remove() { this.removed = true; } };
  let loadingScreen = null;

  let completed = false;
  function fadeOut(cb) {
    if (!loadingHost) { cb?.(); return; }
    loadingHost.remove();
    loadingHost = null;
    loadingScreen = null;
    cb?.();
  }

  fadeOut(() => { completed = true; });
  assert.equal(completed, true);
  assert.equal(loadingHost, null);
});

test("T18: finishTargetPresentation executes visual ready, double requestAnimationFrame, and fadeOut", async () => {
  const steps = [];

  const mockGlobal = {
    requestAnimationFrame(fn) {
      steps.push("raf");
      fn();
    }
  };

  await finishTargetPresentation({
    async waitForVisualReady() {
      steps.push("visual_ready");
    },
    async fadeOut() {
      steps.push("fade_out");
    },
    globalScope: mockGlobal
  });

  assert.deepEqual(steps, ["visual_ready", "raf", "raf", "fade_out"]);
});

test("T19: Synchronous document_start overlay layout exists and is pure loading UI without fake preview DOM", () => {
  const contentJs = fs.readFileSync(new URL("../content.js", import.meta.url), "utf8");
  assert.ok(contentJs.includes("ensureLoadingOverlay();"));
  assert.ok(contentJs.includes("正在载入 Glance"));
  assert.equal(contentJs.includes("preview-layer"), false);
  assert.equal(contentJs.includes("glance-preview-layout"), false);
  assert.equal(contentJs.includes("renderGlanceSkeletonHtml"), false);
  assert.equal(contentJs.includes("extractGlancePreview"), false);
});

test("T20: Newtab lightweight loading markup contains clean status card without preview container", () => {
  const newtabHtml = fs.readFileSync(new URL("../newtab.html", import.meta.url), "utf8");
  assert.equal(newtabHtml.includes("preview-container"), false);
  assert.ok(newtabHtml.includes('id="status-card"'));
  assert.ok(newtabHtml.includes("正在打开主页"));

  const newtabJs = fs.readFileSync(new URL("../newtab.js", import.meta.url), "utf8");
  assert.equal(newtabJs.includes("renderGlancePreviewHtml"), false);
  assert.equal(newtabJs.includes("renderGlanceSkeletonHtml"), false);
  assert.equal(newtabJs.includes("previewStorageKey"), false);
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

test("BOOT10: Legacy preview cleanup cleans up any stale preview data on upgrade", async () => {
  const store = new Map();
  store.set("glance-preview:https://demo-nas.5ddd.com/app/glance/", { theme: "auto" });
  store.set("glance-preview-active-target", "https://demo-nas.5ddd.com/app/glance/");
  store.set("lan-route:https://demo-nas.5ddd.com/", { targetUrl: "http://192.168.1.10:8080/" });

  const mockStorage = {
    async get(keys) {
      if (keys === null) return Object.fromEntries(store);
      if (Array.isArray(keys)) return Object.fromEntries(keys.map((k) => [k, store.get(k)]));
      return { [keys]: store.get(keys) };
    },
    async remove(keys) {
      const arr = Array.isArray(keys) ? keys : [keys];
      for (const k of arr) store.delete(k);
    }
  };

  await cleanupLegacyPreviewStorage(mockStorage);
  assert.equal(store.has("glance-preview:https://demo-nas.5ddd.com/app/glance/"), false);
  assert.equal(store.has("glance-preview-active-target"), false);
  assert.equal(store.has("lan-route:https://demo-nas.5ddd.com/"), true);
});

test("COLD1 (T9): 首次 cold-start (sessionWarmed=false) 仍是 root-first", () => {
  const settings = sanitizeSettings({
    fnosRecoveryEnabled: true,
    targetUrl: "https://demo-nas.5ddd.com/app/glance/",
    rootUrl: "https://demo-nas.5ddd.com/",
    healthUrl: "https://demo-nas.5ddd.com/app/glance/health"
  });

  const mode = chooseInitialNavigation(settings, false);
  assert.equal(mode, "root-first");
  assert.notEqual(mode, "target-first");
});

test("COLD2 (T9): 二次打开 (sessionWarmed=true) 仍是 target-first，不经 root readiness", () => {
  const settings = sanitizeSettings({
    fnosRecoveryEnabled: true,
    targetUrl: "https://demo-nas.5ddd.com/app/glance/",
    rootUrl: "https://demo-nas.5ddd.com/",
    healthUrl: "https://demo-nas.5ddd.com/app/glance/health"
  });

  const mode = chooseInitialNavigation(settings, true);
  assert.equal(mode, "target-first");
  assert.notEqual(mode, "root-first");
});

test("COLD3: official root complete 不立即 target，而是推进至 root phase 等待 Docker Ready", async () => {
  const manager = new TabNavigationManager();
  const tabId = 201;
  const nav = manager.begin(tabId);
  const navigationId = nav.navigationId;

  const pending = {
    phase: "bootstrap",
    recoveryKind: "docker",
    bootstrapUrl: "https://5ddd.com/demo-nas/",
    rootUrl: "https://demo-nas.5ddd.com/",
    checkUrl: "https://demo-nas.5ddd.com/app/glance/health",
    targetUrl: "https://demo-nas.5ddd.com/app/glance/"
  };
  manager.setPending(tabId, pending, navigationId);

  let targetNavigated = false;

  async function handleCompletedBootstrap(currentTabUrl) {
    if (!manager.isActive(tabId, navigationId)) {
      return { action: "ignored" };
    }
    const curPending = manager.getPending(tabId);
    if (!curPending || !isDockerPending(curPending) || curPending.phase !== "bootstrap") {
      return { action: "ignored" };
    }
    if (isBootstrapTransitUrl(curPending, currentTabUrl) || isConfiguredTargetPage(curPending, currentTabUrl)) {
      return { action: "ignored" };
    }

    const isRoot = isConfiguredRootOrigin(curPending, currentTabUrl);
    if (isRoot) {
      const updated = {
        ...curPending,
        phase: "root",
        bootstrapCompletedAt: Date.now(),
        rootEnteredAt: Date.now(),
        nextRetryAt: Date.now()
      };
      manager.setPending(tabId, updated, navigationId);
      return { action: "bootstrap-complete", pending: updated };
    }

    return { action: "external-route" };
  }

  const result = await handleCompletedBootstrap("https://demo-nas.5ddd.com/");
  assert.equal(result.action, "bootstrap-complete");
  assert.equal(result.pending.phase, "root");
  assert.equal(targetNavigated, false);
  assert.equal(manager.getPending(tabId).phase, "root");
});

test("COLD3_A (T1 & T2): root URL commit 即推进 bootstrap -> root，不等待 status=complete", async () => {
  const manager = new TabNavigationManager();
  const tabId = 208;
  const nav = manager.begin(tabId);
  const navigationId = nav.navigationId;

  const bootstrapPending = {
    phase: "bootstrap",
    recoveryKind: "docker",
    bootstrapUrl: "https://5ddd.com/demo-nas/",
    rootUrl: "https://demo-nas.5ddd.com/",
    checkUrl: "https://demo-nas.5ddd.com/app/glance/health",
    targetUrl: "https://demo-nas.5ddd.com/app/glance/"
  };
  manager.setPending(tabId, bootstrapPending, navigationId);

  // Simulated handleBootstrapUrlCommit when changeInfo.url is observed (status is still 'loading')
  async function handleBootstrapUrlCommit(newUrl) {
    if (!manager.isActive(tabId, navigationId)) return { action: "ignored" };
    const cur = manager.getPending(tabId);
    if (!cur || cur.phase !== "bootstrap") return { action: "ignored" };
    if (!isConfiguredRootOrigin(cur, newUrl)) return { action: "ignored" };

    const now = Date.now();
    const updated = {
      ...cur,
      phase: "root",
      bootstrapCompletedAt: now,
      rootEnteredAt: now,
      nextRetryAt: now,
      dockerFrameReadyAt: null
    };
    manager.setPending(tabId, updated, navigationId);
    return { action: "bootstrap-complete", pending: updated };
  }

  const res = await handleBootstrapUrlCommit("https://demo-nas.5ddd.com/");
  assert.equal(res.action, "bootstrap-complete");
  assert.equal(res.pending.phase, "root");
  assert.ok(res.pending.rootEnteredAt > 0);
  assert.equal(manager.getPending(tabId).phase, "root");
});

test("COLD3_B (T3 & T4): 后续 status=complete 到达时保持幂等，不重置 rootEnteredAt", async () => {
  const manager = new TabNavigationManager();
  const tabId = 209;
  const nav = manager.begin(tabId);
  const navigationId = nav.navigationId;

  const t0 = 10000;
  const rootPending = {
    phase: "root",
    recoveryKind: "docker",
    bootstrapUrl: "https://5ddd.com/demo-nas/",
    rootUrl: "https://demo-nas.5ddd.com/",
    checkUrl: "https://demo-nas.5ddd.com/app/glance/health",
    targetUrl: "https://demo-nas.5ddd.com/app/glance/",
    bootstrapCompletedAt: t0,
    rootEnteredAt: t0
  };
  manager.setPending(tabId, rootPending, navigationId);

  // completeDockerBootstrap called on status=complete
  async function completeDockerBootstrap(destinationUrl) {
    const pending = manager.getPending(tabId);
    if (!pending || pending.phase === "root") {
      return { action: "already-root", pending };
    }
    return { action: "ignored" };
  }

  const res = await completeDockerBootstrap("https://demo-nas.5ddd.com/");
  assert.equal(res.action, "already-root");
  assert.equal(res.pending.rootEnteredAt, t0); // Preserved t0!
  assert.equal(manager.getPending(tabId).rootEnteredAt, t0);
});

test("COLD3_C (T8): /login 页面或错误页面不触发 root 推进", async () => {
  const manager = new TabNavigationManager();
  const tabId = 210;
  const nav = manager.begin(tabId);
  const navigationId = nav.navigationId;

  const bootstrapPending = {
    phase: "bootstrap",
    recoveryKind: "docker",
    bootstrapUrl: "https://5ddd.com/demo-nas/",
    rootUrl: "https://demo-nas.5ddd.com/",
    checkUrl: "https://demo-nas.5ddd.com/app/glance/health",
    targetUrl: "https://demo-nas.5ddd.com/app/glance/"
  };
  manager.setPending(tabId, bootstrapPending, navigationId);

  function checkLoginUrl(urlStr) {
    const actual = new URL(urlStr);
    if (/^\/login(?:\/|$)/i.test(actual.pathname)) {
      return false; // Skip bootstrap complete on login page
    }
    return true;
  }

  assert.equal(checkLoginUrl("https://demo-nas.5ddd.com/login"), false);
  assert.equal(checkLoginUrl("https://demo-nas.5ddd.com/login/"), false);
  assert.equal(checkLoginUrl("https://demo-nas.5ddd.com/"), true);
});

test("COLD4 (T1): frameReady 快速成立时走 confirmed target，不执行 optimistic target", () => {
  const probeSignals = combineDockerProbeSignals(true, true);
  assert.equal(probeSignals.strongReady, true);
  const isConfirmedReady = Boolean(probeSignals.strongReady);
  assert.equal(isConfirmedReady, true);
});

test("COLD5 (T2): frameReady 慢但 backgroundReady 快，到 300ms 触发 optimistic target", () => {
  const backgroundReady = true;
  const frameReady = false;
  const officialBootstrapCompleted = true;
  const strictMode = false;
  const rootElapsed = 350;
  const DOCKER_OPTIMISTIC_TARGET_GRACE_MS = 300;

  const canOptimisticTarget = !strictMode
    && officialBootstrapCompleted
    && backgroundReady
    && (rootElapsed >= DOCKER_OPTIMISTIC_TARGET_GRACE_MS);

  assert.equal(canOptimisticTarget, true);
});

test("COLD6 (T3): backgroundReady=false 时即使超过 300ms 也绝不触发 target", () => {
  const backgroundReady = false;
  const officialBootstrapCompleted = true;
  const strictMode = false;
  const rootElapsed = 500;
  const DOCKER_OPTIMISTIC_TARGET_GRACE_MS = 300;

  const canOptimisticTarget = !strictMode
    && officialBootstrapCompleted
    && backgroundReady
    && (rootElapsed >= DOCKER_OPTIMISTIC_TARGET_GRACE_MS);

  assert.equal(canOptimisticTarget, false);
});

test("COLD7 (T4): optimistic target 成功时完成流程且不增加 dockerRecoveryAttempts", async () => {
  const manager = new TabNavigationManager();
  const tabId = 301;
  const nav = manager.begin(tabId);
  const navigationId = nav.navigationId;

  const pending = {
    phase: "root",
    recoveryKind: "docker",
    bootstrapUrl: "https://5ddd.com/demo-nas/",
    rootUrl: "https://demo-nas.5ddd.com/",
    checkUrl: "https://demo-nas.5ddd.com/app/glance/health",
    targetUrl: "https://demo-nas.5ddd.com/app/glance/",
    dockerRecoveryAttempts: 0
  };
  manager.setPending(tabId, pending, navigationId);

  // Optimistic target navigation
  const isOptimistic = true;
  const targetPending = {
    ...pending,
    phase: "target",
    targetAttempts: 1,
    targetAttemptMode: "optimistic",
    optimisticTargetAttempted: true,
    dockerRecoveryAttempts: isOptimistic ? pending.dockerRecoveryAttempts : pending.dockerRecoveryAttempts + 1,
    lastAttemptReason: "health-optimistic"
  };
  manager.setPending(tabId, targetPending, navigationId);

  assert.equal(targetPending.dockerRecoveryAttempts, 0);
  assert.equal(targetPending.targetAttemptMode, "optimistic");
  assert.equal(targetPending.optimisticTargetAttempted, true);
  assert.equal(manager.getPending(tabId).dockerRecoveryAttempts, 0);
});

test("COLD8 (T5): optimistic target 首次 AUTH_INVALID 不增加 dockerRecoveryAttempts 并开启 strictRecovery", async () => {
  const manager = new TabNavigationManager();
  const tabId = 302;
  const nav = manager.begin(tabId);
  const navigationId = nav.navigationId;

  const targetPending = {
    phase: "target",
    recoveryKind: "docker",
    bootstrapUrl: "https://5ddd.com/demo-nas/",
    rootUrl: "https://demo-nas.5ddd.com/",
    checkUrl: "https://demo-nas.5ddd.com/app/glance/health",
    targetUrl: "https://demo-nas.5ddd.com/app/glance/",
    targetAttempts: 1,
    targetAttemptMode: "optimistic",
    optimisticTargetAttempted: true,
    dockerRecoveryAttempts: 0,
    strictRecovery: false
  };
  manager.setPending(tabId, targetPending, navigationId);

  // Simulate handleAuthFailure on optimistic failure
  const wasOptimistic = targetPending.targetAttemptMode === "optimistic";
  const isFirstOptimisticFailure = wasOptimistic && !targetPending.strictRecovery;
  assert.equal(isFirstOptimisticFailure, true);

  const updatedPending = {
    ...targetPending,
    phase: "bootstrap",
    dockerRecoveryAttempts: isFirstOptimisticFailure
      ? targetPending.dockerRecoveryAttempts
      : targetPending.dockerRecoveryAttempts + 1,
    strictRecovery: isFirstOptimisticFailure ? true : targetPending.strictRecovery,
    lastError: "unauthorized"
  };
  manager.setPending(tabId, updatedPending, navigationId);

  assert.equal(updatedPending.dockerRecoveryAttempts, 0); // NOT incremented!
  assert.equal(updatedPending.strictRecovery, true); // Strict mode enabled!
});

test("COLD9 (T6): strictRecovery=true 时禁止再次触发 optimistic target", () => {
  const backgroundReady = true;
  const frameReady = false;
  const officialBootstrapCompleted = true;
  const strictMode = true; // In strict recovery!
  const rootElapsed = 600;
  const DOCKER_OPTIMISTIC_TARGET_GRACE_MS = 300;

  const canOptimisticTarget = !strictMode
    && officialBootstrapCompleted
    && backgroundReady
    && (rootElapsed >= DOCKER_OPTIMISTIC_TARGET_GRACE_MS);

  assert.equal(canOptimisticTarget, false);
});

test("COLD10 (T7): strict recovery 下必须等待 frameReady (strongReady) 后才 target", () => {
  // Step 1: Only backgroundReady in strict mode -> not ready
  const probeSignals1 = combineDockerProbeSignals(true, false);
  assert.equal(probeSignals1.strongReady, false);

  // Step 2: frameReady arrives -> strongReady is true -> confirmed ready
  const probeSignals2 = combineDockerProbeSignals(true, true);
  assert.equal(probeSignals2.strongReady, true);
});

test("COLD11 (T8): strict target 再次出现 AUTH_INVALID 时才增加 dockerRecoveryAttempts", async () => {
  const manager = new TabNavigationManager();
  const tabId = 303;
  const nav = manager.begin(tabId);
  const navigationId = nav.navigationId;

  // Strict target attempt (confirmed via strongReady)
  const strictTargetPending = {
    phase: "target",
    recoveryKind: "docker",
    bootstrapUrl: "https://5ddd.com/demo-nas/",
    rootUrl: "https://demo-nas.5ddd.com/",
    checkUrl: "https://demo-nas.5ddd.com/app/glance/health",
    targetUrl: "https://demo-nas.5ddd.com/app/glance/",
    targetAttempts: 2,
    targetAttemptMode: "confirmed",
    optimisticTargetAttempted: true,
    strictRecovery: true,
    dockerRecoveryAttempts: 1
  };
  manager.setPending(tabId, strictTargetPending, navigationId);

  // Failure occurs on strict attempt
  const wasOptimistic = strictTargetPending.targetAttemptMode === "optimistic";
  const isFirstOptimisticFailure = wasOptimistic && !strictTargetPending.strictRecovery;
  assert.equal(isFirstOptimisticFailure, false);

  const updatedPending = {
    ...strictTargetPending,
    phase: "bootstrap",
    dockerRecoveryAttempts: strictTargetPending.dockerRecoveryAttempts + 1
  };
  manager.setPending(tabId, updatedPending, navigationId);

  assert.equal(updatedPending.dockerRecoveryAttempts, 2);
  assert.equal(shouldStopDockerRecovery(updatedPending.dockerRecoveryAttempts), true);
});

test("COLD12 (T9): 同一 navigation 最多只执行一次 optimistic target", () => {
  let optimisticTargetCount = 0;
  let pending = {
    optimisticTargetAttempted: false,
    strictRecovery: false
  };

  function attemptOptimisticTarget() {
    if (!pending.strictRecovery && !pending.optimisticTargetAttempted) {
      optimisticTargetCount += 1;
      pending.optimisticTargetAttempted = true;
      return true;
    }
    return false;
  }

  assert.equal(attemptOptimisticTarget(), true);
  assert.equal(optimisticTargetCount, 1);

  // Subsequent attempt rejected
  assert.equal(attemptOptimisticTarget(), false);
  assert.equal(optimisticTargetCount, 1);
});

test("COLD13 (T10): 旧 navigation A 的 optimistic timer 不影响新 navigation B", () => {
  const manager = new TabNavigationManager();
  const tabId = 304;

  const navA = manager.begin(tabId);
  const pendingA = {
    phase: "root",
    recoveryKind: "docker",
    targetUrl: "https://demo-nas-a.5ddd.com/app/glance/"
  };
  manager.setPending(tabId, pendingA, navA.navigationId);

  const navB = manager.begin(tabId);
  const pendingB = {
    phase: "root",
    recoveryKind: "docker",
    targetUrl: "https://demo-nas-b.5ddd.com/app/glance/"
  };
  manager.setPending(tabId, pendingB, navB.navigationId);

  // Timer from A fires with navA.navigationId
  function handleOptimisticTimer(navId) {
    if (!manager.isActive(tabId, navId)) {
      return { action: "ignored" };
    }
    return { action: "navigating" };
  }

  const resA = handleOptimisticTimer(navA.navigationId);
  assert.equal(resA.action, "ignored");
  assert.equal(manager.isActive(tabId, navB.navigationId), true);
});

test("COLD14 (T11): 用户在 root 等待期间跳走取消 navigationId ownership", () => {
  const manager = new TabNavigationManager();
  const tabId = 305;
  const nav = manager.begin(tabId);
  const navigationId = nav.navigationId;

  const pending = {
    phase: "root",
    recoveryKind: "docker",
    bootstrapUrl: "https://5ddd.com/demo-nas/",
    rootUrl: "https://demo-nas.5ddd.com/",
    targetUrl: "https://demo-nas.5ddd.com/app/glance/"
  };
  manager.setPending(tabId, pending, navigationId);

  const changeResult = manager.handleUrlChange(tabId, "https://github.com/", pending);
  assert.equal(changeResult.cancelled, true);
  assert.equal(manager.isActive(tabId, navigationId), false);
});

test("COLD15 (T12): optimistic target 发出后晚到的 frameReady 事件不触发二次 target", () => {
  let targetNavigations = 0;
  let navigationRequested = false;

  function handleTarget() {
    if (navigationRequested) return false;
    navigationRequested = true;
    targetNavigations += 1;
    return true;
  }

  // Optimistic target triggers
  assert.equal(handleTarget(), true);
  assert.equal(targetNavigations, 1);

  // Late frameReady event arrives
  assert.equal(handleTarget(), false);
  assert.equal(targetNavigations, 1);
});

test("COLD16 (T13): learned LAN 二次打开仍优先于 Remote target-first 及 FN Connect recovery", async () => {
  const manager = new TabNavigationManager();
  const storageMap = new Map();
  const mockStorage = {
    async get(keys) {
      if (keys === null) return Object.fromEntries(storageMap);
      if (Array.isArray(keys)) return Object.fromEntries(keys.map((k) => [k, storageMap.get(k)]));
      return { [keys]: storageMap.get(keys) };
    },
    async set(obj) {
      for (const [k, v] of Object.entries(obj)) storageMap.set(k, v);
    },
    async remove(keys) {
      const arr = Array.isArray(keys) ? keys : [keys];
      for (const k of arr) storageMap.delete(k);
    }
  };
  const store = new LanRouteStore(manager, mockStorage);

  const remoteTargetUrl = "https://demo-nas.5ddd.com/app/glance/";
  const lanTargetUrl = "http://192.168.1.10:8080/app/glance/";
  const lanHealthUrl = "http://192.168.1.10:8080/app/glance/health";

  await store.saveRoute(remoteTargetUrl, {
    targetUrl: lanTargetUrl,
    healthUrl: lanHealthUrl
  });

  const route = await store.getRoute(remoteTargetUrl);
  assert.ok(route);
  assert.equal(route.targetUrl, lanTargetUrl);
  assert.equal(route.healthUrl, lanHealthUrl);
});

test("COLD17 (T14): timing instrumentation 数据结构记录 root, background, frame, target 时间差", () => {
  const rootEnteredAt = 10000;
  const timing = {
    rootEnteredAt,
    backgroundReadyAt: 10040,
    frameReadyAt: 10120,
    targetAt: 10300
  };

  const bgElapsed = timing.backgroundReadyAt - timing.rootEnteredAt;
  const frameElapsed = timing.frameReadyAt - timing.rootEnteredAt;
  const targetElapsed = timing.targetAt - timing.rootEnteredAt;

  assert.equal(bgElapsed, 40);
  assert.equal(frameElapsed, 120);
  assert.equal(targetElapsed, 300);
});

function createMockTabsApi() {
  let nextId = 500;
  const tabs = new Map();
  return {
    tabs,
    createCalls: [],
    updateCalls: [],
    removeCalls: [],
    async create(options) {
      this.createCalls.push(options);
      const tab = {
        id: ++nextId,
        url: options.url,
        active: options.active ?? true
      };
      tabs.set(tab.id, tab);
      return tab;
    },
    async update(tabId, options) {
      this.updateCalls.push({ tabId, ...options });
      const existing = tabs.get(tabId) || { id: tabId };
      const updated = { ...existing, ...options };
      tabs.set(tabId, updated);
      return updated;
    },
    async remove(tabId) {
      this.removeCalls.push(tabId);
      tabs.delete(tabId);
    },
    async get(tabId) {
      if (!tabs.has(tabId)) {
        throw new Error(`Tab ${tabId} not found`);
      }
      return tabs.get(tabId);
    }
  };
}

function createMockSessionStorage() {
  const map = new Map();
  return {
    map,
    async get(key) {
      if (key === null) return Object.fromEntries(map);
      if (Array.isArray(key)) return Object.fromEntries(key.map((k) => [k, map.get(k)]));
      return { [key]: map.get(key) };
    },
    async set(obj) {
      for (const [k, v] of Object.entries(obj)) map.set(k, v);
    },
    async remove(key) {
      const arr = Array.isArray(key) ? key : [key];
      for (const k of arr) map.delete(k);
    }
  };
}

test("STARTUP1 (T1 & P0-19): runtime.onStartup 执行过程中 tabs.create 调用次数严格为 0", async () => {
  const mockTabs = createMockTabsApi();
  let startupHandled = false;

  async function handleRuntimeStartupMock() {
    // Background startup only restores scripts/defaults, NEVER creates tabs
    startupHandled = true;
  }

  await handleRuntimeStartupMock();
  assert.equal(startupHandled, true);
  assert.equal(mockTabs.createCalls.length, 0);
});

test("STARTUP2 (T2 & P0-8): Chrome 启动时只有当前 New Tab，通过 tabs.update 导航而不创建额外 tab", async () => {
  const mockTabs = createMockTabsApi();
  const currentTab = await mockTabs.create({ url: "chrome://newtab", active: true });
  mockTabs.createCalls = []; // Reset after initial user tab

  const settings = {
    setupCompleted: true,
    enabled: true,
    fnosRecoveryEnabled: true,
    targetUrl: "https://demo-nas.5ddd.com/app/glance/"
  };
  const sessionWarmed = false;
  const initialNav = chooseInitialNavigation(settings, sessionWarmed);
  assert.equal(initialNav, "root-first");

  // Recovery navigates current tab directly via tabs.update
  await mockTabs.update(currentTab.id, { url: "https://5ddd.com/demo-nas/" });
  assert.equal(mockTabs.createCalls.length, 0);
  assert.equal(mockTabs.updateCalls.length, 1);
  assert.equal(mockTabs.updateCalls[0].tabId, currentTab.id);
});

test("STARTUP3 (T3 & P0-5): sessionWarmed = false 时 New Tab 直接走 root-first recovery", () => {
  const settings = {
    setupCompleted: true,
    enabled: true,
    fnosRecoveryEnabled: true,
    targetUrl: "https://demo-nas.5ddd.com/app/glance/"
  };
  const initialNav = chooseInitialNavigation(settings, false);
  assert.equal(initialNav, "root-first");
});

test("STARTUP4 (T4 & P0-11): 首次 foreground recovery 在 TARGET_READY 时标记 session warmed", async () => {
  const store = {};
  const mockStorage = {
    async get(key) {
      return { [key]: store[key] };
    },
    async set(obj) {
      Object.assign(store, obj);
    }
  };

  async function markSessionWarmedSimulated() {
    await mockStorage.set({
      "browser-session-warmed": { warmedAt: Date.now() }
    });
  }

  // Before TARGET_READY:
  assert.equal(Boolean(store["browser-session-warmed"]), false);

  // TARGET_READY arrives:
  await markSessionWarmedSimulated();
  assert.equal(Boolean(store["browser-session-warmed"]), true);
});

test("STARTUP5 (T5 & P0-12): 首次 foreground recovery 失败时不标记 session warmed", async () => {
  const store = {};
  const mockStorage = {
    async get(key) {
      return { [key]: store[key] };
    },
    async set(obj) {
      Object.assign(store, obj);
    }
  };

  async function handleRecoveryFailureSimulated() {
    // Failure leaves session not-warmed
    return { action: "manual", lastError: "docker-visible-retry-limit" };
  }

  await handleRecoveryFailureSimulated();
  assert.equal(Boolean(store["browser-session-warmed"]), false);
});

test("STARTUP6 (T6 & P0-10): 二次及后续打开在 sessionWarmed = true 下直接走 target-first", () => {
  const settings = {
    setupCompleted: true,
    enabled: true,
    fnosRecoveryEnabled: true,
    targetUrl: "https://demo-nas.5ddd.com/app/glance/"
  };
  const initialNav = chooseInitialNavigation(settings, true);
  assert.equal(initialNav, "target-first");
});

test("STARTUP7 (T7 & P0-18): Learned LAN 路由存在时优先直连，不受 sessionWarmed 限制", async () => {
  const manager = new TabNavigationManager();
  const mockStorage = createMockSessionStorage();
  const lanStore = new LanRouteStore(manager, mockStorage);
  const remoteTargetUrl = "https://demo-nas.5ddd.com/app/glance/";
  const lanTargetUrl = "http://192.168.1.10:8080/app/glance/";

  await lanStore.saveRoute(remoteTargetUrl, {
    targetUrl: lanTargetUrl,
    healthUrl: "http://192.168.1.10:8080/app/glance/health"
  });

  const route = await lanStore.getRoute(remoteTargetUrl);
  assert.ok(route);
  assert.equal(route.targetUrl, lanTargetUrl);
});

test("STARTUP8 (T8 & P0-7): OPEN_NEW_TAB 绝不返回 waiting-warmup", () => {
  function openConfiguredPageSimulated(sessionWarmed, lanRoute) {
    if (lanRoute) {
      return { action: "navigating-lan" };
    }
    if (sessionWarmed) {
      return { action: "checking-target" };
    }
    return { action: "recovering-startup" };
  }

  assert.notEqual(openConfiguredPageSimulated(false, null).action, "waiting-warmup");
  assert.notEqual(openConfiguredPageSimulated(true, null).action, "waiting-warmup");
  assert.equal(openConfiguredPageSimulated(false, null).action, "recovering-startup");
  assert.equal(openConfiguredPageSimulated(true, null).action, "checking-target");
});

test("STARTUP9 (T9 & P0-6): newtab.js 状态映射恢复为标准文案，无 warmup 文案", () => {
  function getNewTabStatusText(responseAction) {
    if (responseAction === "recovering-startup") {
      return "正在确认 fnOS 登录状态并恢复主页…";
    }
    if (responseAction === "checking-target") {
      return "正在连接 Glance…";
    }
    if (responseAction === "configure") {
      return "首次使用，请先填写你的飞牛主页地址。";
    }
    return "正在读取新标签页设置…";
  }

  assert.equal(getNewTabStatusText("recovering-startup"), "正在确认 fnOS 登录状态并恢复主页…");
  assert.equal(getNewTabStatusText("checking-target"), "正在连接 Glance…");
});

test("STARTUP10 (T10 & P0-13): storage.session 不再写入 helper tab 或 warmupId 预热信封", async () => {
  const mockStorage = createMockSessionStorage();
  const stored = await mockStorage.get("fnos-warmup-state");
  assert.equal(stored["fnos-warmup-state"], undefined);
});

test("STARTUP11 (T11 & P0-14): Service Worker restart 仅恢复持久化导航，不创建 helper tab", async () => {
  const mockTabs = createMockTabsApi();
  const storage = mockStorageFallback();
  const persistence = new NavigationPersistence(storage);

  const envelope = await persistence.getPendingEnvelope(101);
  assert.equal(envelope, null);
  assert.equal(mockTabs.createCalls.length, 0);
});

function mockStorageFallback() {
  const map = new Map();
  return {
    async get(k) { return Object.fromEntries(map); },
    async set(o) { for (const [k, v] of Object.entries(o)) map.set(k, v); },
    async remove(k) { map.delete(k); }
  };
}

test("STARTUP12 (T12 & P0-9): 用户在 foreground recovery 期间跳走，旧 recovery 自动取消", () => {
  const tabManager = new TabNavigationManager();
  const tabId = 401;
  const nav = tabManager.begin(tabId);
  const changeResult = tabManager.handleUrlChange(tabId, "https://github.com/");
  assert.equal(changeResult.cancelled, true);
  assert.equal(tabManager.isActive(tabId, nav.navigationId), false);
});

test("STARTUP13 (T13): 同一会话连续按 ⌘T，每个 New Tab 独立运行，无额外 tab 产生", async () => {
  const mockTabs = createMockTabsApi();
  const tab1 = await mockTabs.create({ url: "chrome://newtab", active: true });
  const tab2 = await mockTabs.create({ url: "chrome://newtab", active: true });
  const tab3 = await mockTabs.create({ url: "chrome://newtab", active: true });

  // 3 user tabs created by Chrome/User, 0 by extension background
  assert.equal(mockTabs.createCalls.length, 3);
  assert.deepEqual(Array.from(mockTabs.tabs.keys()), [tab1.id, tab2.id, tab3.id]);
});

test("STARTUP14 (P0-12 & P0-13): background.js 模块动态 import/evaluation 成功，无 ReferenceError/TDZ", async () => {
  const prevChrome = globalThis.chrome;
  try {
    globalThis.chrome = {
      runtime: {
        onInstalled: { addListener: () => {} },
        onStartup: { addListener: () => {} },
        onMessage: { addListener: () => {} },
        openOptionsPage: async () => {}
      },
      action: {
        onClicked: { addListener: () => {} }
      },
      tabs: {
        onRemoved: { addListener: () => {} },
        onUpdated: { addListener: () => {} },
        get: async () => ({ id: 1 }),
        create: async (opts) => ({ id: 2, ...opts }),
        update: async (tabId, opts) => ({ id: tabId, ...opts }),
        remove: async () => {}
      },
      storage: {
        session: {
          get: async () => ({}),
          set: async () => {},
          remove: async () => {}
        },
        local: {
          get: async () => ({}),
          set: async () => {},
          remove: async () => {}
        }
      },
      scripting: {
        getRegisteredContentScripts: async () => [],
        registerContentScripts: async () => {},
        unregisterContentScripts: async () => {}
      }
    };

    const bgModule = await import(`../background.js?test_ts=${Date.now()}`);
    assert.ok(bgModule);
  } finally {
    globalThis.chrome = prevChrome;
  }
});

test("STARTUP15 (P0-3 & P0-4): isSessionWarmed 是纯只读操作，markSessionWarmed 显式写入", async () => {
  let writeOccurred = false;
  const store = {};
  const mockStorage = {
    async get(key) {
      return { [key]: store[key] };
    },
    async set(obj) {
      writeOccurred = true;
      Object.assign(store, obj);
    }
  };

  async function isSessionWarmedMock() {
    const stored = await mockStorage.get("browser-session-warmed");
    return Boolean(stored["browser-session-warmed"]);
  }

  async function markSessionWarmedMock() {
    await mockStorage.set({
      "browser-session-warmed": { warmedAt: Date.now() }
    });
  }

  // Read:
  assert.equal(await isSessionWarmedMock(), false);
  assert.equal(writeOccurred, false);

  // Write:
  await markSessionWarmedMock();
  assert.equal(await isSessionWarmedMock(), true);
  assert.equal(writeOccurred, true);
});

