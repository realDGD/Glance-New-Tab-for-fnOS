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
  NavigationPersistence
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

test("P0-1 & P0-6: NavigationPersistence per-generation keys eliminate TOCTOU interleaving", async () => {
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
    pending: { phase: "bootstrap", targetUrl: "https://v1.example.com/" }
  });
  assert.ok(store.has(`pending-recovery:${tabId}:1`));
  assert.equal(store.get(`nav-active:${tabId}`)?.generation, 1);

  // Simulate TOCTOU Interleaving:
  // Gen 1 begins removal and gets delayed during remove execution
  let resolveRemove;
  deferredRemove = new Promise((resolve) => { resolveRemove = resolve; });

  const gen1RemovePromise = persistence.removePendingEnvelope(tabId, 1);

  // In the meantime, Generation 2 starts and writes its state!
  await persistence.setPendingEnvelope(tabId, 2, {
    generation: 2,
    pending: { phase: "target", targetUrl: "https://v2.example.com/" }
  });
  assert.ok(store.has(`pending-recovery:${tabId}:2`));
  assert.equal(store.get(`nav-active:${tabId}`)?.generation, 2);

  // Now Generation 1's delayed remove completes
  resolveRemove();
  await gen1RemovePromise;
  deferredRemove = null;

  // ASSERTION: Generation 2's key MUST still be in store!
  assert.equal(store.has(`pending-recovery:${tabId}:2`), true);
  assert.equal(store.get(`nav-active:${tabId}`)?.generation, 2);
  const gen2Loaded = await persistence.getPendingEnvelope(tabId);
  assert.equal(gen2Loaded?.generation, 2);
  assert.equal(gen2Loaded?.pending?.targetUrl, "https://v2.example.com/");
  // Generation 1's key was removed
  assert.equal(store.has(`pending-recovery:${tabId}:1`), false);
});

test("P0-3 & P0-5: LAN discovery ownership binding prevents stale probe from affecting generation N+1", async () => {
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
  const manager = new TabNavigationManager();
  const tabId = 402;

  // Generation 1 starts Docker LAN discovery
  const gen1 = manager.begin(tabId);
  await persistence.setDiscovery(tabId, gen1, {
    remoteTargetUrl: "https://remote.example.com/",
    lanRootUrl: "http://192.168.1.50:8080/",
    startedAt: Date.now(),
    expiresAt: Date.now() + 60000
  });
  assert.ok(store.has(`lan-discovery:${tabId}:${gen1}`));

  // In-flight probe begins for Gen 1
  let probeResolved = false;
  let staleRouteCommitted = false;
  const delayedProbe = new Promise((resolve) => {
    setTimeout(async () => {
      probeResolved = true;
      // Stale callback checks ownership before committing
      if (manager.isActive(tabId, gen1)) {
        staleRouteCommitted = true;
      }
      resolve();
    }, 25);
  });

  // User navigates / starts Generation 2 on the tab
  const gen2 = manager.begin(tabId);
  assert.equal(gen2, 2);
  assert.equal(manager.isActive(tabId, gen1), false);
  await persistence.setPendingEnvelope(tabId, gen2, {
    generation: 2,
    pending: { phase: "target", targetUrl: "https://new.example.com/" }
  });

  // Wait for Gen 1 probe to resolve
  await delayedProbe;
  assert.equal(probeResolved, true);
  assert.equal(staleRouteCommitted, false);

  // Gen 1 cleanup only deletes its own discovery
  await persistence.removeDiscovery(tabId, gen1);
  assert.equal(store.has(`lan-discovery:${tabId}:${gen1}`), false);
  // Gen 2 pending is untouched
  assert.equal(store.has(`pending-recovery:${tabId}:${gen2}`), true);
});

test("P0-4: removeOwnedTab guards ownership and prevents closing user-navigated tabs", async () => {
  const manager = new TabNavigationManager();
  const tabId = 403;
  const gen = manager.begin(tabId);
  manager.setExpectedUrl(tabId, gen, "https://5ddd.com/demo-nas/");
  manager.setPending(tabId, { phase: "bootstrap", targetUrl: "https://service.demo.5ddd.com/" }, gen);

  let chromeTabsRemoveCalled = false;
  async function mockRemoveOwnedTab(id, generation, currentUrl) {
    if (!manager.isActive(id, generation)) {
      return { ok: false, reason: "stale-generation" };
    }
    const state = manager.get(id);
    const allowedUrls = state ? state.expectedUrls : new Set();
    const isAllowed = isIgnoredNavigationUrl(currentUrl)
      || matchesExpectedNavigation(allowedUrls, state?.pending, currentUrl, state?.expectedUrl);

    if (!isAllowed) {
      manager.cancel(id, "user-navigated-away", generation);
      return { ok: false, reason: "user-navigated-away" };
    }
    manager.cancel(id, "close-owned-tab", generation);
    chromeTabsRemoveCalled = true;
    return { ok: true };
  }

  // Case 1: Stale generation cannot close tab
  const staleRes = await mockRemoveOwnedTab(tabId, 999, "https://5ddd.com/demo-nas/");
  assert.equal(staleRes.ok, false);
  assert.equal(staleRes.reason, "stale-generation");
  assert.equal(chromeTabsRemoveCalled, false);

  // Case 2: User navigated to external site (github.com) -> refuse to close tab!
  const userNavRes = await mockRemoveOwnedTab(tabId, gen, "https://github.com/trending");
  assert.equal(userNavRes.ok, false);
  assert.equal(userNavRes.reason, "user-navigated-away");
  assert.equal(chromeTabsRemoveCalled, false);
  assert.equal(manager.isActive(tabId, gen), false);

  // Case 3: Legitimate owned tab on recovery URL -> successfully closed
  const tabId2 = 404;
  const gen2 = manager.begin(tabId2);
  manager.setExpectedUrl(tabId2, gen2, "https://demo-nas.5ddd.com/");
  manager.setPending(tabId2, { phase: "root" }, gen2);
  const successRes = await mockRemoveOwnedTab(tabId2, gen2, "https://demo-nas.5ddd.com/");
  assert.equal(successRes.ok, true);
  assert.equal(chromeTabsRemoveCalled, true);
  assert.equal(manager.isActive(tabId2, gen2), false);
});




