import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_SETTINGS } from "../shared.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = resolve(root, "manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));

assert.equal(manifest.manifest_version, 3, "必须使用 Manifest V3");
assert.equal(manifest.name, "Glance New Tab for fnOS", "扩展品牌名称不一致");
assert.equal(packageJson.name, "glance-new-tab-for-fnos", "软件包名称不一致");
assert.equal(packageJson.license, "MIT", "软件包必须声明 MIT 许可证");
assert.equal(manifest.version, packageJson.version, "Manifest 与 package.json 版本不一致");
assert.equal(manifest.background?.type, "module", "后台脚本必须以 ES module 运行");
assert.equal(manifest.chrome_url_overrides?.newtab, "newtab.html", "缺少新标签页覆盖");
assert.equal(DEFAULT_SETTINGS.setupCompleted, false, "首次安装不应跳过地址配置");
assert.equal(DEFAULT_SETTINGS.targetUrl, "", "默认设置不应包含个人 NAS 地址");
assert.equal(DEFAULT_SETTINGS.rootUrl, "", "默认设置不应包含个人 fnOS 根地址");
assert.equal(DEFAULT_SETTINGS.healthUrl, "", "默认设置不应包含个人检测地址");

const forbiddenPermissions = new Set(["cookies", "webRequest", "webRequestBlocking", "history"]);
for (const permission of manifest.permissions ?? []) {
  assert.equal(
    forbiddenPermissions.has(permission),
    false,
    `不应申请高风险权限：${permission}`
  );
}

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
