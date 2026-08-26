import test from "node:test";
import assert from "node:assert/strict";

import {
  canAcceptTargetResult,
  canNavigateToRecoveryTarget,
  chooseInitialNavigation,
  combineDockerProbeSignals,
  DEFAULT_SETTINGS,
  hostPermissionPattern,
  inferLanHealthUrl,
  inferLanNativeTargetUrl,
  inferFnOsBootstrapUrl,
  inferFnOsHealthUrl,
  inferFnOsRootUrl,
  isDockerFnConnectService,
  isGlanceDocument,
  isLanGlanceCandidate,
  isFnOsUrl,
  isPrivateNetworkHostname,
  isPrivateNetworkUrl,
  isSamePage,
  isSuccessfulHealthResponse,
  MAX_DOCKER_RECOVERY_ATTEMPTS,
  normalizeNavigableUrl,
  sanitizeSettings,
  shouldStopDockerRecovery,
  validateRecoverySettings
} from "../shared.js";

test("normalizes ordinary hostnames to HTTPS", () => {
  assert.equal(
    normalizeNavigableUrl("example.com/dashboard"),
    "https://example.com/dashboard"
  );
});

test("supports the safe schemes needed by custom new-tab pages", () => {
  assert.equal(normalizeNavigableUrl("about:blank"), "about:blank");
  assert.equal(normalizeNavigableUrl("chrome://history/"), "chrome://history/");
  assert.equal(normalizeNavigableUrl("file:///tmp/home.html"), "file:///tmp/home.html");
  assert.throws(() => normalizeNavigableUrl("javascript:alert(1)"), /不允许/);
  assert.throws(() => normalizeNavigableUrl("data:text/html,test"), /不允许/);
});

test("recognizes fnOS Connect hostnames but not lookalike domains", () => {
  assert.equal(isFnOsUrl("demo-nas.5ddd.com/app/glance-homepage/"), true);
  assert.equal(isFnOsUrl("service-0.demo-nas.5ddd.com/"), true);
  assert.equal(isFnOsUrl("https://5ddd.com/demo-nas/"), true);
  assert.equal(isFnOsUrl("https://evil5ddd.com/app/test/"), false);
  assert.equal(isFnOsUrl("https://5ddd.com.example.org/"), false);
});

test("recognizes private LAN hosts without accepting public lookalikes", () => {
  for (const hostname of [
    "10.0.0.10",
    "172.16.0.1",
    "172.31.255.254",
    "192.168.1.10",
    "localhost",
    "gdnashost.local",
    "fd00::1"
  ]) {
    assert.equal(isPrivateNetworkHostname(hostname), true, hostname);
  }
  for (const hostname of [
    "172.15.0.1",
    "172.32.0.1",
    "192.169.1.1",
    "8.8.8.8",
    "fcevil.example"
  ]) {
    assert.equal(isPrivateNetworkHostname(hostname), false, hostname);
  }
  assert.equal(isPrivateNetworkUrl("http://10.0.0.10:5000/"), true);
  assert.equal(isPrivateNetworkUrl("https://demo-nas.5ddd.com/"), false);
  assert.equal(
    hostPermissionPattern("http://10.0.0.10:18080/"),
    "http://10.0.0.10/*"
  );
  assert.equal(
    hostPermissionPattern("http://[fd00::1]:18080/"),
    "http://[fd00::1]/*"
  );
});

test("derives native LAN routes while Docker health follows the mapped port", () => {
  const nativeTarget = inferLanNativeTargetUrl(
    "https://demo-nas.5ddd.com/app/glance-homepage/",
    "http://10.0.0.10:5000/"
  );
  assert.equal(
    nativeTarget,
    "http://10.0.0.10:5000/app/glance-homepage/"
  );
  assert.equal(
    inferLanHealthUrl(nativeTarget, false),
    "http://10.0.0.10:5000/app/glance-homepage/__fnos/health"
  );
  assert.equal(
    inferLanHealthUrl("http://10.0.0.10:18080/", true),
    "http://10.0.0.10:18080/api/healthz"
  );
});

test("only considers a different service on the same LAN NAS a discovery candidate", () => {
  const root = "http://10.0.0.10:5000/";
  assert.equal(isLanGlanceCandidate("http://10.0.0.10:18080/", root), true);
  assert.equal(isLanGlanceCandidate(root, root), false);
  assert.equal(isLanGlanceCandidate("http://10.0.0.11:18080/", root), false);
  assert.equal(isLanGlanceCandidate("https://example.org/", root), false);
});

test("recognizes Glance using several stable document signals instead of its title", () => {
  const glanceDocument = `<!doctype html>
    <html data-theme="default" data-scheme="dark"><head>
    <script>const pageData = { slug: "home" };</script>
    <link rel="manifest" href="/manifest.json?v=1">
    <link rel="stylesheet" href="/static/abc123/css/bundle.css">
    <title>Completely customized</title></head></html>`;
  assert.equal(isGlanceDocument(glanceDocument), true);
  assert.equal(isGlanceDocument("<html><title>Glance</title></html>"), false);
});

test("infers NAS root and official health endpoint for Docker service domains", () => {
  const target = "https://service-0.demo-nas.5ddd.com/";
  assert.equal(inferFnOsRootUrl(target), "https://demo-nas.5ddd.com/");
  assert.equal(inferFnOsBootstrapUrl(target), "https://5ddd.com/demo-nas/");
  assert.equal(
    inferFnOsHealthUrl(target),
    "https://service-0.demo-nas.5ddd.com/api/healthz"
  );

  const settings = sanitizeSettings({
    ...DEFAULT_SETTINGS,
    setupCompleted: true,
    targetUrl: target
  });
  assert.equal(settings.rootUrl, "https://demo-nas.5ddd.com/");
  assert.equal(settings.healthUrl, `${target}api/healthz`);
  assert.equal(
    isDockerFnConnectService(settings.targetUrl, settings.rootUrl, settings.healthUrl),
    true
  );
  assert.doesNotThrow(() => validateRecoverySettings(settings));
  assert.equal(
    isDockerFnConnectService(
      settings.targetUrl,
      settings.rootUrl,
      "https://other-service.demo-nas.5ddd.com/api/healthz"
    ),
    false
  );
});

test("infers the official FN Connect bootstrap route for bare-domain URLs", () => {
  assert.equal(
    inferFnOsBootstrapUrl("https://5ddd.com/demo-nas/app/glance-homepage/"),
    "https://5ddd.com/demo-nas/"
  );
  assert.equal(
    inferFnOsBootstrapUrl("https://service.demo-nas.fnos.net/"),
    "https://fnos.net/demo-nas/"
  );
});

test("allows one controlled Docker retry before switching to manual mode", () => {
  assert.equal(MAX_DOCKER_RECOVERY_ATTEMPTS, 2);
  assert.equal(shouldStopDockerRecovery(0), false);
  assert.equal(shouldStopDockerRecovery(1), false);
  assert.equal(shouldStopDockerRecovery(2), true);
});

test("never lets stale root-page messages interrupt the official bootstrap", () => {
  assert.equal(canNavigateToRecoveryTarget("root"), true);
  assert.equal(canNavigateToRecoveryTarget("bootstrap"), false);
  assert.equal(canNavigateToRecoveryTarget("target"), false);
  assert.equal(canNavigateToRecoveryTarget("manual"), false);
  assert.equal(canAcceptTargetResult("target"), true);
  assert.equal(canAcceptTargetResult("bootstrap"), false);
  assert.equal(canAcceptTargetResult("root"), false);
});

test("uses the fast Docker path only when both independent probes are ready", () => {
  assert.deepEqual(combineDockerProbeSignals(true, true), {
    ok: true,
    backgroundReady: true,
    frameReady: true,
    strongReady: true,
    signalCount: 2
  });
  assert.deepEqual(combineDockerProbeSignals(true, false), {
    ok: true,
    backgroundReady: true,
    frameReady: false,
    strongReady: false,
    signalCount: 1
  });
  assert.equal(combineDockerProbeSignals(false, false).ok, false);
});

test("infers root and health URLs for a subdomain app route", () => {
  const target = "https://demo-nas.5ddd.com/app/glance-homepage/";
  assert.equal(inferFnOsRootUrl(target), "https://demo-nas.5ddd.com/");
  assert.equal(
    inferFnOsHealthUrl(target),
    "https://demo-nas.5ddd.com/app/glance-homepage/__fnos/health"
  );
  assert.equal(
    isDockerFnConnectService(
      target,
      "https://demo-nas.5ddd.com/",
      "https://demo-nas.5ddd.com/app/glance-homepage/__fnos/health"
    ),
    false
  );
});

test("preserves a Connect identifier prefix on the bare domain", () => {
  const target = "https://5ddd.com/demo-nas/app/glance-homepage/";
  assert.equal(inferFnOsRootUrl(target), "https://5ddd.com/demo-nas/");
  assert.equal(
    inferFnOsHealthUrl(target),
    "https://5ddd.com/demo-nas/app/glance-homepage/__fnos/health"
  );
});

test("sanitizes numeric limits and validates recovery hosts", () => {
  const settings = sanitizeSettings({
    ...DEFAULT_SETTINGS,
    setupCompleted: true,
    targetUrl: "https://demo-nas.5ddd.com/app/glance-homepage/",
    keepAliveMinutes: 0,
    recoveryTimeoutSeconds: 9999
  });
  assert.equal(settings.keepAliveMinutes, 1);
  assert.equal(settings.recoveryTimeoutSeconds, 600);
  assert.doesNotThrow(() => validateRecoverySettings(settings));

  assert.throws(
    () => validateRecoverySettings({
      ...settings,
      rootUrl: "https://example.org/"
    }),
    /根网址/
  );
});

test("compares a target page while ignoring a trailing slash", () => {
  assert.equal(
    isSamePage(
      "https://demo-nas.5ddd.com/app/glance-homepage",
      "https://demo-nas.5ddd.com/app/glance-homepage/"
    ),
    true
  );
  assert.equal(
    isSamePage(
      "https://demo-nas.5ddd.com/",
      "https://demo-nas.5ddd.com/app/glance-homepage/"
    ),
    false
  );
});

test("treats fnOS subdomain and bare Connect routes as the same page", () => {
  assert.equal(
    isSamePage(
      "https://demo-nas.5ddd.com/app/glance-homepage/",
      "https://5ddd.com/demo-nas/app/glance-homepage/"
    ),
    true
  );
  assert.equal(
    isSamePage(
      "https://other.5ddd.com/app/glance-homepage/",
      "https://5ddd.com/demo-nas/app/glance-homepage/"
    ),
    false
  );
});

test("does not confuse a Docker service domain with the NAS root domain", () => {
  assert.equal(
    isSamePage(
      "https://service-0.demo-nas.5ddd.com/",
      "https://demo-nas.5ddd.com/"
    ),
    false
  );
  assert.equal(
    isSamePage(
      "https://service-0.demo-nas.5ddd.com/",
      "https://service-0.demo-nas.5ddd.com"
    ),
    true
  );
});

test("accepts native ok and official Glance empty health responses", () => {
  assert.equal(isSuccessfulHealthResponse(200, "ok\n"), true);
  assert.equal(isSuccessfulHealthResponse(200, ""), true);
  assert.equal(isSuccessfulHealthResponse(204, ""), true);
  assert.equal(isSuccessfulHealthResponse(403, ""), false);
  assert.equal(
    isSuccessfulHealthResponse(200, "FN Connect 暂无权限访问该服务..."),
    false
  );
});

test("ships without a personal NAS identifier and defaults to automatic theme", () => {
  const settings = sanitizeSettings(DEFAULT_SETTINGS);
  assert.equal(settings.setupCompleted, false);
  assert.equal(settings.targetUrl, "");
  assert.equal(settings.rootUrl, "");
  assert.equal(settings.healthUrl, "");
  assert.equal(settings.themeMode, "auto");
  assert.throws(() => validateRecoverySettings(settings), /主页网址/);
});

test("uses root-first only for the first fnOS new tab in a browser session", () => {
  const settings = sanitizeSettings({
    ...DEFAULT_SETTINGS,
    setupCompleted: true,
    targetUrl: "https://demo-nas.5ddd.com/app/glance-homepage/"
  });
  assert.equal(chooseInitialNavigation(settings, false), "root-first");
  assert.equal(chooseInitialNavigation(settings, true), "target-first");
  assert.equal(
    chooseInitialNavigation({
      ...settings,
      fnosRecoveryEnabled: false
    }, false),
    "direct"
  );
});
