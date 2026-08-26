import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_SETTINGS } from "../shared.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = resolve(root, "manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const newTabCss = await readFile(resolve(root, "newtab.css"), "utf8");
const contentScript = await readFile(resolve(root, "content.js"), "utf8");

assert.equal(manifest.manifest_version, 3, "必须使用 Manifest V3");
assert.equal(manifest.name, "Glance New Tab for fnOS", "扩展品牌名称不一致");
assert.equal(packageJson.name, "glance-new-tab-for-fnos", "软件包名称不一致");
assert.equal(packageJson.license, "MIT", "软件包必须声明 MIT 许可证");
assert.equal(manifest.version, packageJson.version, "Manifest 与 package.json 版本不一致");
assert.equal(manifest.background?.type, "module", "后台脚本必须以 ES module 运行");
assert.equal(manifest.chrome_url_overrides?.newtab, "newtab.html", "缺少新标签页覆盖");
assert.equal(manifest.permissions?.includes("scripting"), true, "局域网页面识别需要 scripting 权限");
assert.equal(DEFAULT_SETTINGS.setupCompleted, false, "首次安装不应跳过地址配置");
assert.equal(DEFAULT_SETTINGS.targetUrl, "", "默认设置不应包含个人 NAS 地址");
assert.equal(DEFAULT_SETTINGS.rootUrl, "", "默认设置不应包含个人 fnOS 根地址");
assert.equal(DEFAULT_SETTINGS.healthUrl, "", "默认设置不应包含个人检测地址");
assert.match(
  newTabCss,
  /\[hidden\]\s*\{[^}]*display:\s*none\s*!important;/s,
  "hidden 元素不得被通用链接或按钮样式重新显示"
);
assert.equal(
  contentScript.includes("crypto.randomUUID"),
  false,
  "页面脚本不得依赖并非所有目标 Chrome 环境都提供的 crypto.randomUUID"
);

const forbiddenPermissions = new Set(["cookies", "webRequest", "webRequestBlocking", "history"]);
for (const permission of manifest.permissions ?? []) {
  assert.equal(
    forbiddenPermissions.has(permission),
    false,
    `不应申请高风险权限：${permission}`
  );
}

assert.equal(
  manifest.optional_host_permissions?.includes("http://*/*"),
  true,
  "应允许用户按需授权运行时发现的局域网 HTTP 主机"
);
assert.equal(
  manifest.host_permissions?.includes("http://*/*"),
  false,
  "局域网主机访问必须保持为可选权限"
);

const referencedFiles = new Set([
  "LICENSE",
  manifest.background.service_worker,
  manifest.chrome_url_overrides.newtab,
  manifest.options_page,
  ...(Object.values(manifest.icons ?? {})),
  ...(Object.values(manifest.action?.default_icon ?? {}))
]);
for (const entry of manifest.content_scripts ?? []) {
  for (const script of entry.js ?? []) {
    referencedFiles.add(script);
  }
  for (const stylesheet of entry.css ?? []) {
    referencedFiles.add(stylesheet);
  }
}

const htmlFiles = [...referencedFiles].filter((file) => file.endsWith(".html"));
for (const htmlFile of htmlFiles) {
  const html = await readFile(resolve(root, htmlFile), "utf8");
  for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const path = match[1];
    if (/^(?:https?:|chrome:|#)/.test(path)) {
      continue;
    }
    referencedFiles.add(path);
  }
}

for (const file of referencedFiles) {
  await access(resolve(root, file));
}

console.log(`扩展结构校验通过：${referencedFiles.size} 个引用文件均存在，且未申请 Cookie 等高风险权限。`);
