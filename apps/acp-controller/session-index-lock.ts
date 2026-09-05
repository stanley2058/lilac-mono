import { dlopen, FFIType, read } from "bun:ffi";
import fs, { type FileHandle } from "node:fs/promises";
import { getSystemErrorName } from "node:util";

import { Result, type Result as ResultType } from "better-result";

import { captureExternal } from "./external-adapters.ts";
import {
  ExternalOperationFailed,
  SessionIndexLockTimedOut,
  WorkAndCleanupFailed,
} from "./failures.ts";

const flockSymbol = {
  args: [FFIType.i32, FFIType.i32],
  returns: FFIType.i32,
} as const;
const errnoSymbol = { args: [], returns: FFIType.ptr } as const;

function openFlockApi() {
  if (process.platform === "darwin") {
    const library = dlopen("/usr/lib/libSystem.B.dylib", {
      flock: flockSymbol,
      __error: errnoSymbol,
    });
    return {
      lock: (fd: number) => library.symbols.flock(fd, 2 | 4),
      errno: () => {
        const pointer = library.symbols.__error();
        return pointer === null ? 5 : read.i32(pointer);
      },
      [Symbol.dispose]: () => library.close(),
    };
  }
  const library = dlopen("libc.so.6", {
    flock: flockSymbol,
    __errno_location: errnoSymbol,
  });
  return {
    lock: (fd: number) => library.symbols.flock(fd, 2 | 4),
    errno: () => {
      const pointer = library.symbols.__errno_location();
      return pointer === null ? 5 : read.i32(pointer);
    },
    [Symbol.dispose]: () => library.close(),
  };
}

async function waitForLock(
  file: FileHandle,
  api: ReturnType<typeof openFlockApi>,
): Promise<ResultType<void, ExternalOperationFailed | SessionIndexLockTimedOut>> {
  const deadline = Date.now() + 5_000;
  while (true) {
    if (api.lock(file.fd) === 0) return Result.ok(undefined);
    const code = getSystemErrorName(-api.errno());
    if (code === "EINTR") continue;
    if (code !== "EAGAIN" && code !== "EWOULDBLOCK") {
      return Result.err(
        new ExternalOperationFailed({
          operation: "acquire-session-lock",
          code,
          cause: new Error(`Session index lock failed: ${code}`),
          message: `Session index lock failed: ${code}`,
        }),
      );
    }
    if (Date.now() >= deadline) {
      return Result.err(
        new SessionIndexLockTimedOut({
          message: "Timed out waiting for the session index lock.",
        }),
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

export type SessionIndexLockFailure =
  | ExternalOperationFailed
  | SessionIndexLockTimedOut
  | WorkAndCleanupFailed<ExternalOperationFailed | SessionIndexLockTimedOut>;

export async function acquireSessionIndexLock(
  directory: string,
): Promise<ResultType<FileHandle, SessionIndexLockFailure>> {
  return Result.gen(async function* () {
    using api = yield* Result.await(
      captureExternal("acquire-session-lock", async () => openFlockApi()),
    );
    const file = yield* Result.await(
      captureExternal("acquire-session-lock", () => fs.open(directory, "r")),
    );
    // Lock the directory inode: replacing index.json and abandoned legacy index.lock directories cannot detach this lock.
    const locked = await waitForLock(file, api);
    const failure = locked.match({ ok: () => null, err: (error) => error });
    if (!failure) return Result.ok(file);
    const closed = await captureExternal("remove-session-lock", () => file.close());
    return closed.match<ResultType<FileHandle, SessionIndexLockFailure>>({
      ok: () => Result.err(failure),
      err: (cleanup) =>
        Result.err(
          new WorkAndCleanupFailed({
            primary: failure,
            cleanup,
            message: `${failure.message} Session index lock cleanup also failed.`,
          }),
        ),
    });
  });
}
