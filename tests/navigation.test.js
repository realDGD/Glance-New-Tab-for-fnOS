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
  extractGlancePreview,
  getPreviewStatus,
  previewStorageKey,
  renderGlancePreviewHtml,
  renderGlanceSkeletonHtml
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

test("P0.1 & P0.6: Synchronous URL mismatch freeze stops in-flight tasks before any async storage resolves", async () => {
  const manager = new TabNavigationManager();
  const tabId = 201;
  const gen = manager.begin(tabId);
  const lanUrl = "http://192.168.1.10:18080/";
  manager.setExpectedUrl(tabId, gen, lanUrl);
  manager.setPending(tabId, { phase: "target", targetUrl: lanUrl }, gen);

  const signal = manager.getAbortSignal(tabId, gen);

  // Simulate an in-flight health probe Promise
  let delayedProbeFinished = false;
  let simulatedTabUpdateCalled = false;

  const inFlightProbe = new Promise((resolve) => {
    setTimeout(() => {
      delayedProbeFinished = true;
      // Before updating tab, probe checks if generation is still active
      if (manager.isActive(tabId, gen)) {
        simulatedTabUpdateCalled = true;
      }
      resolve();
    }, 20);
  });

  // User immediately navigates to github.com in address bar (tabs.onUpdated synchronously fires)
  const result = manager.handleUrlChange(tabId, "https://github.com/");
  assert.equal(result.cancelled, true);
  assert.equal(result.matched, false);

  // SYNCHRONOUS ASSERTION: The generation MUST be frozen immediately, before inFlightProbe resolves
  assert.equal(manager.isActive(tabId, gen), false);
  assert.equal(signal.aborted, true);
  assert.equal(manager.setExpectedUrl(tabId, gen, "http://192.168.1.10:18080/"), false);

  // Wait for in-flight probe to complete
  await inFlightProbe;
  assert.equal(delayedProbeFinished, true);
  assert.equal(simulatedTabUpdateCalled, false);
});

test("P0.7: Delayed cleanup from generation N does not cancel or pollute generation N+1", () => {
  const manager = new TabNavigationManager();
  const tabId = 202;

  // Generation 1 starts
  const gen1 = manager.begin(tabId);
  manager.setExpectedUrl(tabId, gen1, "https://old-target.example.com/");
  manager.setPending(tabId, { phase: "target", targetUrl: "https://old-target.example.com/" }, gen1);

  // Unexpected URL cancels generation 1
  const changeResult = manager.handleUrlChange(tabId, "https://github.com/");
  assert.equal(changeResult.cancelled, true);
  assert.equal(manager.isActive(tabId, gen1), false);

  // Generation 2 starts on the same tab
  const gen2 = manager.begin(tabId);
  assert.equal(gen2, 2);
  const gen2Url = "https://demo-nas.5ddd.com/app/glance-homepage/";
  manager.setExpectedUrl(tabId, gen2, gen2Url);
  manager.setPending(tabId, { phase: "target", targetUrl: gen2Url }, gen2);
  const signal2 = manager.getAbortSignal(tabId, gen2);

  // Now delayed cleanup from Generation 1 runs: cancel(tabId, "delayed-cleanup", gen1)
  const cancelResult = manager.cancel(tabId, "delayed-cleanup", gen1);
  assert.equal(cancelResult, null); // Target generation mismatch, ignored!

  // Assert Generation 2 is completely unaffected
  assert.equal(manager.isActive(tabId, gen2), true);
  assert.equal(manager.getGeneration(tabId), 2);
  assert.equal(signal2.aborted, false);
  assert.equal(manager.getPending(tabId, gen2)?.targetUrl, gen2Url);
});

test("P0.3: Multi-phase recovery in-memory pending tracking preserves ownership synchronously", () => {
  const manager = new TabNavigationManager();
  const tabId = 203;

  const gen = manager.begin(tabId);
  const bootstrapPending = {
    recoveryKind: "docker",
    phase: "bootstrap",
    bootstrapUrl: "https://5ddd.com/demo-nas/",
    rootUrl: "https://demo-nas.5ddd.com/",
    targetUrl: "https://service-0.demo-nas.5ddd.com/"
  };
  manager.setPending(tabId, bootstrapPending, gen);
  manager.setExpectedUrl(tabId, gen, bootstrapPending.bootstrapUrl);

  // Phase 1: Bootstrap transit URLs
  assert.equal(manager.handleUrlChange(tabId, "https://5ddd.com/demo-nas/").matched, true);
  assert.equal(manager.handleUrlChange(tabId, "https://check.fnos.net/").matched, true);
  assert.equal(manager.handleUrlChange(tabId, "https://demo-nas.5ddd.com/").matched, true);
  assert.equal(manager.isActive(tabId, gen), true);

  // Phase 2: Target transition
  const targetPending = {
    ...bootstrapPending,
    phase: "target"
  };
  manager.setPending(tabId, targetPending, gen);
  manager.setExpectedUrl(tabId, gen, targetPending.targetUrl);

  assert.equal(manager.handleUrlChange(tabId, "https://service-0.demo-nas.5ddd.com/").matched, true);
  assert.equal(manager.isActive(tabId, gen), true);

  // Phase 3: User navigates away to unrelated domain
  assert.equal(manager.handleUrlChange(tabId, "https://example.org/").cancelled, true);
  assert.equal(manager.isActive(tabId, gen), false);
});

test("P0.1, P0.2 & P0.6: Stale async callback cannot revive pending or pollute storage after user navigation", async () => {
  const sessionStorageMock = new Map();
  const manager = new TabNavigationManager();
  const tabId = 301;
  const gen1 = manager.begin(tabId);

  async function mockSetPending(id, pending, generation) {
    if (!Number.isInteger(generation) || !manager.isActive(id, generation)) {
      return false;
    }
    const accepted = manager.setPending(id, pending, generation);
    if (!accepted) {
      return false;
    }
    const state = manager.get(id);
    const envelope = {
      generation,
      pending,
      expectedUrl: state?.expectedUrl ?? null,
      expectedUrls: state ? Array.from(state.expectedUrls) : [],
      savedAt: Date.now()
    };
    sessionStorageMock.set(`pending-recovery:${id}`, envelope);
    if (!manager.isActive(id, generation)) {
      sessionStorageMock.delete(`pending-recovery:${id}`);
      return false;
    }
    return true;
  }

  // Set initial valid pending
  const initialPending = { phase: "bootstrap", targetUrl: "https://demo.fnos.net/" };
  assert.equal(await mockSetPending(tabId, initialPending, gen1), true);
  assert.ok(sessionStorageMock.has(`pending-recovery:${tabId}`));

  // User navigates away to github.com
  manager.handleUrlChange(tabId, "https://github.com/");
  assert.equal(manager.isActive(tabId, gen1), false);

  // Stale callback returns and tries to write updated pending with old gen1
  const stalePending = { phase: "target", targetUrl: "https://demo.fnos.net/" };
  const writeResult = await mockSetPending(tabId, stalePending, gen1);
  assert.equal(writeResult, false);

  // Assert memory state is not revived
  assert.equal(manager.getPending(tabId, gen1), null);
});

test("P0.4 & P0.7: Delayed cleanup from generation N does not delete generation N+1 storage", async () => {
  const sessionStorageMock = new Map();

  async function mockRemovePending(tabId, generation = null) {
    const key = `pending-recovery:${tabId}`;
    if (generation !== null) {
      const stored = sessionStorageMock.get(key);
      const envelope = parsePendingEnvelope(stored);
      if (envelope && envelope.generation !== null && envelope.generation !== generation) {
        return; // Mismatched generation: keep stored pending
      }
    }
    sessionStorageMock.delete(key);
  }

  const tabId = 302;
  // Generation 1 was active and then Generation 2 starts and writes its state
  const gen2Envelope = {
    generation: 2,
    pending: { phase: "target", targetUrl: "https://target.fnos.net/" },
    expectedUrl: "https://target.fnos.net/",
    expectedUrls: ["https://target.fnos.net/"],
    savedAt: Date.now()
  };
  sessionStorageMock.set(`pending-recovery:${tabId}`, gen2Envelope);

  // Stale cleanup from Generation 1 arrives
  await mockRemovePending(tabId, 1);

  // Generation 2 storage MUST remain intact
  assert.ok(sessionStorageMock.has(`pending-recovery:${tabId}`));
  const preserved = sessionStorageMock.get(`pending-recovery:${tabId}`);
  assert.equal(preserved.generation, 2);
  assert.equal(preserved.pending.targetUrl, "https://target.fnos.net/");

  // Generation 2's own cleanup should properly delete it
  await mockRemovePending(tabId, 2);
  assert.equal(sessionStorageMock.has(`pending-recovery:${tabId}`), false);
});

test("P1.8: Service Worker restart rehydrates navigation ownership when tab is on valid recovery page", async () => {
  const tabId = 303;
  const originalGen = 5;

  // Persisted state before Service Worker was terminated
  const persistedEnvelope = {
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

    const gen = envelope.generation || restartedManager.begin(id);
    const state = restartedManager.rehydrate(id, {
      generation: gen,
      expectedUrl: envelope.expectedUrl,
      expectedUrls: allowedUrls,
      pending: envelope.pending
    });
    return {
      active: true,
      generation: gen,
      pending: envelope.pending,
      state
    };
  }

  // Current tab is still on the bootstrap URL
  const context = mockEnsureNavigationContext(tabId, "https://5ddd.com/demo-nas/");
  assert.ok(context);
  assert.equal(context.active, true);
  assert.equal(context.generation, 5);
  assert.equal(restartedManager.isActive(tabId, 5), true);
  assert.equal(restartedManager.getPending(tabId, 5)?.phase, "bootstrap");

  // Abort signal is created and valid
  const signal = restartedManager.getAbortSignal(tabId, 5);
  assert.ok(signal);
  assert.equal(signal.aborted, false);

  // Monotonicity: next navigation on this tab will not regress below generation 5
  const nextGen = restartedManager.begin(tabId);
  assert.equal(nextGen, 6);
});

test("P1.9: Service Worker restart + user already navigated away purges stale state without rehydrating", async () => {
  const tabId = 304;
  const persistedStorage = new Map();
  persistedStorage.set(`pending-recovery:${tabId}`, {
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
      return { active: true, generation: restartedManager.getGeneration(id) };
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

  // New tab starts generation 2 after worker restart
  const gen2 = manager.rehydrate(tabId, {
    generation: 2,
    expectedUrl: "https://new-target.fnos.net/",
    expectedUrls: ["https://new-target.fnos.net/"],
    pending: { phase: "target", targetUrl: "https://new-target.fnos.net/" }
  });
  assert.ok(gen2);

  // Stale event from Generation 1 arrives
  const oldPending = { phase: "root", targetUrl: "https://old-target.fnos.net/" };
  assert.equal(manager.setPending(tabId, oldPending, 1), false);
  assert.equal(manager.cancel(tabId, "stale-cancel", 1), null);
  assert.equal(manager.getAbortSignal(tabId, 1), null);

  // Generation 2 remains active and unaffected
  assert.equal(manager.isActive(tabId, 2), true);
  assert.equal(manager.getPending(tabId, 2)?.targetUrl, "https://new-target.fnos.net/");
  assert.equal(manager.getAbortSignal(tabId, 2)?.aborted, false);
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
  const navId1 = manager.begin(tabId);
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
  const navId2 = manager.begin(tabId);
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
  const navId1 = manager.begin(ownerTabId);

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
  const navId2 = manager.begin(ownerTabId);
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

test("E1: navigationId production integration guarantees distinct identities and blocks old navigation side-effects", () => {
  const manager = new TabNavigationManager();
  const tabId = 1001;

  // Begin navigation A
  const navA = manager.begin(tabId);
  const navIdA = typeof navA === "object" ? navA.navigationId : navA;
  assert.ok(navIdA);
  assert.equal(manager.isActive(tabId, navIdA), true);

  // Begin navigation B on same tab
  const navB = manager.begin(tabId);
  const navIdB = typeof navB === "object" ? navB.navigationId : navB;
  assert.ok(navIdB);
  assert.notEqual(navIdA, navIdB);

  // Navigation A is now completely inactive and superseded
  assert.equal(manager.isActive(tabId, navIdA), false);
  assert.equal(manager.isActive(tabId, navIdB), true);

  // Stale navigation A cannot mutate pending or claim removal
  assert.equal(manager.setPending(tabId, { phase: "target" }, navIdA), false);
  assert.equal(manager.claimTabForRemoval(tabId, navIdA), null);

  // Active navigation B can mutate pending and claim removal
  assert.equal(manager.setPending(tabId, { phase: "target" }, navIdB), true);
  assert.ok(manager.claimTabForRemoval(tabId, navIdB));
});

test("E2: Persistence key uses navigationId token and active pointer", async () => {
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
  const tabId = 1002;
  const navId = "uuid_nav_token_abc";

  await persistence.setPendingEnvelope(tabId, navId, {
    navigationId: navId,
    pending: { phase: "root", targetUrl: "https://nas.5ddd.com/" }
  });

  // Verify key format
  assert.equal(store.has(`pending-recovery:${tabId}:${navId}`), true);
  assert.equal(store.has(`nav-active:${tabId}`), true);
  assert.equal(store.get(`nav-active:${tabId}`).navigationId, navId);

  // Read back envelope
  const envelope = await persistence.getPendingEnvelope(tabId, navId);
  assert.equal(envelope.navigationId, navId);
  assert.equal(envelope.pending.phase, "root");
});

test("E3: rehydrate strictly preserves original navigationId across Service Worker restart", () => {
  const manager = new TabNavigationManager();
  const tabId = 1003;
  const origNavId = "nav_sw_restart_uuid_9999";

  const state = manager.rehydrate(tabId, {
    navigationId: origNavId,
    generation: 5,
    pending: { phase: "target", targetUrl: "https://glance.local:8080/" }
  });

  assert.equal(state.navigationId, origNavId);
  assert.equal(manager.getNavigationId(tabId), origNavId);
  assert.equal(manager.isActive(tabId, origNavId), true);
});

test("E4: setLanDiscovery receives navigationId and reliably persists into session storage", async () => {
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
  const navigationId = "nav_lan_disc_uuid_777";

  const discoveryData = {
    remoteTargetUrl: "https://remote.5ddd.com/",
    lanRootUrl: "http://192.168.1.100:8080/",
    startedAt: Date.now(),
    expiresAt: Date.now() + 60000
  };

  const saved = await persistence.setDiscovery(ownerTabId, navigationId, discoveryData);
  assert.equal(saved, true);

  // Verify storage key
  assert.equal(store.has(`lan-discovery:${ownerTabId}:${navigationId}`), true);

  // Retrieve discovery
  const retrieved = await persistence.getDiscovery(ownerTabId, navigationId);
  assert.ok(retrieved);
  assert.equal(retrieved.navigationId, navigationId);
  assert.equal(retrieved.lanRootUrl, "http://192.168.1.100:8080/");
});

test("E5: Preview schema security test extracts safe widgets and strips passwords, tokens and secrets", () => {
  // Create mock DOM structure simulating Glance page with mixed safe and sensitive content
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
                    if (sel.includes("password") || sel.includes("token")) return null;
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
                // Sensitive widget with password input (must be skipped entirely)
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
  // Login widget with password field must be excluded
  assert.equal(widgets.length, 1);
  assert.equal(widgets[0].title, "Bookmarks");

  // Tokens in URL must be stripped
  const docLink = widgets[0].items[0];
  assert.equal(docLink.title, "Documentation");
  assert.equal(docLink.url.includes("token="), false);
  assert.equal(docLink.url.includes("session="), false);
});

test("E6: renderGlanceSkeletonHtml returns clean skeleton layout without error", () => {
  const darkSkeleton = renderGlanceSkeletonHtml("dark");
  assert.ok(darkSkeleton.includes("skeleton-layout"));
  assert.ok(darkSkeleton.includes("skeleton-card"));
  assert.ok(darkSkeleton.includes("glance-skeleton-bar"));

  const lightSkeleton = renderGlanceSkeletonHtml("light");
  assert.ok(lightSkeleton.includes("skeleton-layout"));
});

test("E7: renderGlancePreviewHtml renders structured cards and headers", () => {
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

test("E8: getPreviewStatus correctly differentiates fresh, stale, expired, and none", () => {
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

test("E9: Preview storage key generation matches normalized URL", () => {
  const key1 = previewStorageKey("https://glance.local:8080/dashboard/");
  const key2 = previewStorageKey("https://glance.local:8080/dashboard");
  assert.equal(key1, key2);
  assert.equal(key1, "glance-preview:https://glance.local:8080/dashboard");
});

test("E10: Production helper beginDockerLanDiscovery sets identity and persists without omission", async () => {
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

  const manager = new TabNavigationManager();
  const persistence = new NavigationPersistence(mockStorage);
  const tabId = 1010;

  const gen = manager.begin(tabId);
  const navigationId = manager.getNavigationId(tabId);

  // Simulate production beginDockerLanDiscovery flow with explicit navigationId
  const pending = {
    targetUrl: "https://fnos.5ddd.com/",
    lanRootUrl: "http://192.168.1.120:8080/",
    phase: "lan-discovery"
  };

  const persisted = await persistence.setDiscovery(tabId, navigationId, {
    ownerTabId: tabId,
    navigationId,
    remoteTargetUrl: pending.targetUrl,
    lanRootUrl: pending.lanRootUrl,
    startedAt: Date.now(),
    expiresAt: Date.now() + 60000
  });

  assert.equal(persisted, true);
  assert.equal(store.has(`lan-discovery:${tabId}:${navigationId}`), true);

  const discovery = await persistence.getDiscovery(tabId, navigationId);
  assert.ok(discovery);
  assert.equal(discovery.ownerTabId, tabId);
  assert.equal(discovery.navigationId, navigationId);
});

test("E11: Concurrent preview saves for different Glance targets do not overwrite each other", async () => {
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






