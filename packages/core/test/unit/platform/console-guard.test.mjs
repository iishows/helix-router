import assert from "node:assert/strict";
import test from "node:test";
import {
  installConsoleWriteGuard,
  isIgnorableConsoleWriteError
} from "@ccr/core/platform/console-guard.ts";

function brokenPipeError() {
  return Object.assign(new Error("EPIPE: broken pipe, write"), { code: "EPIPE", errno: -4047, syscall: "write" });
}

test("console guard recognises broken pipe write failures", () => {
  assert.equal(isIgnorableConsoleWriteError(brokenPipeError()), true);
  assert.equal(isIgnorableConsoleWriteError({ code: "ERR_STREAM_DESTROYED" }), true);
  assert.equal(isIgnorableConsoleWriteError(new Error("write EPIPE")), true);
});

test("console guard leaves unrelated logging errors alone", () => {
  assert.equal(isIgnorableConsoleWriteError(undefined), false);
  assert.equal(isIgnorableConsoleWriteError("EPIPE"), false);
  assert.equal(isIgnorableConsoleWriteError(new Error("permission denied")), false);
  assert.equal(isIgnorableConsoleWriteError({ code: "EACCES" }), false);
});

test("console writes survive a detached stdout but still surface real failures", () => {
  let failure = brokenPipeError();
  const originalInfo = console.info;
  const writes = [];

  console.info = (...args) => {
    writes.push(args.join(" "));
    throw failure;
  };

  try {
    installConsoleWriteGuard();

    // EPIPE from a detached console is swallowed: the app keeps running.
    assert.doesNotThrow(() => console.info("gateway output"));

    // Anything else is a genuine bug and must not be hidden.
    failure = new Error("disk on fire");
    assert.throws(() => console.info("gateway output"), /disk on fire/);
  } finally {
    console.info = originalInfo;
  }

  assert.deepEqual(writes, ["gateway output", "gateway output"]);
});
