const WRITE_ERROR_CODES = new Set([
  "EPIPE",
  "ERR_STREAM_DESTROYED",
  "ERR_STREAM_WRITE_AFTER_END"
]);

type ConsoleMethod = (...args: unknown[]) => void;

const guardedMethods = ["debug", "error", "info", "log", "trace", "warn"] as const;

let installed = false;

export function isIgnorableConsoleWriteError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const candidate = error as { code?: unknown; message?: unknown };
  if (typeof candidate.code === "string" && WRITE_ERROR_CODES.has(candidate.code)) {
    return true;
  }

  return typeof candidate.message === "string" && /broken pipe|EPIPE/i.test(candidate.message);
}

/**
 * Keeps console writes from crashing the process when stdout/stderr are gone.
 *
 * On Windows the packaged Electron main process logs through a synchronous
 * write stream. Once the console handle detaches, every `console.*` call throws
 * EPIPE out of `writeSync` and takes down the whole app. Logging must never be
 * able to do that, so failed writes are dropped instead.
 */
export function installConsoleWriteGuard(): void {
  if (installed) {
    return;
  }
  installed = true;

  for (const stream of [process.stdout, process.stderr]) {
    if (!stream || typeof stream.on !== "function") {
      continue;
    }
    // Without a listener a failed write emits an unhandled "error" event which
    // is just as fatal as the synchronous throw.
    stream.on("error", () => {});
  }

  const target = console as unknown as Record<string, ConsoleMethod | undefined>;
  for (const method of guardedMethods) {
    const original = target[method];
    if (typeof original !== "function") {
      continue;
    }
    target[method] = (...args: unknown[]) => {
      try {
        original.apply(console, args);
      } catch (error) {
        if (!isIgnorableConsoleWriteError(error)) {
          throw error;
        }
      }
    };
  }
}
