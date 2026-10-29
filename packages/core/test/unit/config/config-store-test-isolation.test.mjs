import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  ConfigStoreTestIsolationError,
  assertConfigDatabaseAccessAllowed
} from "@ccr/core/config/config-repository.ts";
import { APP_CONFIG_DB_FILE } from "@ccr/core/config/constants.ts";

const isolatedPathEnvs = ["CCR_INTERNAL_HOME_DIR", "CCR_INTERNAL_APP_DATA_DIR", "CCR_INTERNAL_USER_DATA_DIR"];

/** 在指定 env 组合下运行,结束后完整还原(测试进程共享 process.env)。 */
function withEnv(overrides, run) {
  const saved = new Map();
  for (const key of ["NODE_TEST_CONTEXT", ...isolatedPathEnvs]) {
    saved.set(key, process.env[key]);
  }
  try {
    for (const key of ["NODE_TEST_CONTEXT", ...isolatedPathEnvs]) {
      delete process.env[key];
    }
    for (const [key, value] of Object.entries(overrides)) {
      process.env[key] = value;
    }
    return run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

// 回归(2026-10-29):直接 `node --test` 运行单测时,测试会落到真实
// %APPDATA%/claude-code-router/config.sqlite,并把测试常量 HOST 写进用户配置。
test("未隔离的测试进程不得访问真实用户配置库", () => {
  withEnv({ NODE_TEST_CONTEXT: "child-v8" }, () => {
    assert.throws(
      () => assertConfigDatabaseAccessAllowed(APP_CONFIG_DB_FILE),
      (error) => error instanceof ConfigStoreTestIsolationError && /not isolated/.test(error.message)
    );
  });
});

test("已隔离的测试进程可以访问配置库", () => {
  withEnv({ NODE_TEST_CONTEXT: "child-v8", CCR_INTERNAL_HOME_DIR: path.join("C:", "tmp", "ccr-home") }, () => {
    assert.doesNotThrow(() => assertConfigDatabaseAccessAllowed(APP_CONFIG_DB_FILE));
  });
});

test("非测试进程不受限制", () => {
  withEnv({}, () => {
    assert.doesNotThrow(() => assertConfigDatabaseAccessAllowed(APP_CONFIG_DB_FILE));
  });
});

test("测试进程显式使用临时库路径时放行", () => {
  withEnv({ NODE_TEST_CONTEXT: "child-v8" }, () => {
    assert.doesNotThrow(() => assertConfigDatabaseAccessAllowed(path.join("C:", "tmp", "ccr-test", "config.sqlite")));
  });
});
