import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

// Reproduces the failure chain from the bug report end to end:
//   child.stdout.on("data") -> console.info -> write -> Error: EPIPE: broken pipe, write
// A build without the guard dies; the guard has to keep the process alive.
//
// Both children are identical apart from loading the guard first, so the
// difference in outcome can only come from the guard.

// Walk up until the monorepo root is found: the test runs both from source and
// from .test-dist, where a fixed relative path would point at the wrong place.
const relativeGuardPath = path.join("packages", "core", "src", "platform", "console-guard.ts");
function findGuardModule() {
  let dir = __dirname;
  for (let depth = 0; depth < 12; depth += 1) {
    const candidate = path.join(dir, relativeGuardPath);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`could not locate ${relativeGuardPath} from ${__dirname}`);
}
const guardModule = findGuardModule();

function childBody(withGuard) {
  return `
const { pathToFileURL } = require("node:url");
(async () => {
  if (${withGuard}) {
    const mod = await import(pathToFileURL(${JSON.stringify(guardModule)}).href);
    mod.installConsoleWriteGuard();
  }
  let ticks = 0;
  const timer = setInterval(() => {
    ticks += 1;
    console.info("[gateway] relayed child output " + ticks);
    if (ticks > 200) { clearInterval(timer); process.exit(0); }
  }, 20);
})();
`;
}

function runChild(withGuard) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", "-e", childBody(withGuard)], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stderr = "";
    child.stderr.on("data", (c) => (stderr += c.toString()));
    // The reader goes away, so the child's stdout pipe is broken from here on.
    setTimeout(() => child.stdout.destroy(), 300);

    const killer = setTimeout(() => {
      child.kill();
      resolve({ survived: true, stderr });
    }, 3000);

    child.on("exit", (code, signal) => {
      clearTimeout(killer);
      resolve({ survived: false, code, signal, stderr });
    });
  });
}

test("guard keeps a process alive when its console pipe breaks", async () => {
  const withoutGuard = await runChild(false);
  const withGuard = await runChild(true);

  assert.equal(withoutGuard.survived, false, "control case must die to prove the setup is valid");
  assert.match(withoutGuard.stderr, /EPIPE|broken pipe/i);

  assert.equal(withGuard.survived, true, "guarded process must survive the broken pipe");
});
