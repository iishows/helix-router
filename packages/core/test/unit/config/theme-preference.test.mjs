import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// 本文件读写的是真实配置库(loadAppConfig 在空库时还会落盘),因此必须在
// 加载配置模块**之前**把运行时路径指向临时目录。动态 import 是关键:
// 静态 import 会在本文件求值前就执行模块顶层(即 CONFIGDIR 的解析)。
// 这样即使绕过 `npm test` 直接 `node --test` 也不会污染用户配置。
if (!process.env.CCR_INTERNAL_HOME_DIR) {
  const testHome = mkdtempSync(path.join(os.tmpdir(), "ccr-theme-preference-test-"));
  process.env.CCR_INTERNAL_HOME_DIR = testHome;
  process.env.CCR_INTERNAL_APP_DATA_DIR = path.join(testHome, "app-data");
  process.env.CCR_INTERNAL_USER_DATA_DIR = path.join(testHome, "user-data");
  // 库句柄在本进程内仍打开(Windows 上会 EBUSY),临时目录清理按尽力而为。
  test.after(() => {
    try {
      rmSync(testHome, { force: true, maxRetries: 5, recursive: true, retryDelay: 50 });
    } catch {
      // 临时目录残留无害。
    }
  });
}

// CJS 构建产物不支持顶层 await,故用惰性 Promise 承接动态 import。
const modules = Promise.all([
  import("@ccr/core/config/config-repository.ts"),
  import("@ccr/core/config/config.ts")
]).then(([repository, config]) => ({ ...repository, ...config }));

test("theme preference persistence changes only the theme field", async () => {
  const { loadPersistedAppConfig, replacePersistedAppConfig, loadAppConfig, saveAppConfig, saveAppThemePreference } = await modules;
  const current = await loadAppConfig();
  const markerHost = "theme-preference.test";
  await replacePersistedAppConfig({
    ...current,
    HOST: markerHost,
    theme: "system"
  });

  const savedTheme = await saveAppThemePreference("dark");
  const persisted = await loadPersistedAppConfig();

  assert.equal(savedTheme, "dark");
  assert.equal(persisted.theme, "dark");
  assert.equal(persisted.HOST, markerHost);
  assert.equal((await loadAppConfig()).theme, "dark");

  const staleConfig = {
    ...current,
    HOST: "theme-preference-stale-save.test",
    theme: "system"
  };
  await assert.rejects(saveAppConfig(staleConfig), /Configuration changed/);
  const savedConfig = await saveAppConfig({ ...await loadAppConfig(), HOST: staleConfig.HOST, theme: "system" });
  assert.equal(savedConfig.theme, "dark");
  assert.equal(savedConfig.HOST, staleConfig.HOST);
});

test("theme preference persistence rejects unsupported values", async () => {
  const { saveAppThemePreference } = await modules;
  await assert.rejects(
    saveAppThemePreference("sepia"),
    /Invalid theme preference/
  );
});
