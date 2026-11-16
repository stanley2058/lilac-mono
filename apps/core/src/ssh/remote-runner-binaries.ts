import crypto from "node:crypto";
import { gzipSync } from "node:zlib";

import { remoteRunnerBinaryPath, type RemoteRunnerTarget } from "@stanley2058/lilac-remote-runner";
import { Result, TaggedError, type Result as ResultType } from "better-result";

import { captureRuntimeError, projectCapturedRuntimeError } from "../runtime/error-format";
import { preserveToolPanic } from "../tools/tool-result-adapters";

export type RemoteRunnerBinary = {
  readonly target: RemoteRunnerTarget;
  readonly hash: string;
  readonly size: number;
  readonly gzipped: Uint8Array<ArrayBuffer>;
  readonly raw: Uint8Array<ArrayBuffer>;
};

export class RemoteRunnerBinaryMissingError extends TaggedError("RemoteRunnerBinaryMissingError")<{
  readonly target: RemoteRunnerTarget;
  readonly filePath: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

const loaded = new Map<
  RemoteRunnerTarget,
  Promise<ResultType<RemoteRunnerBinary, RemoteRunnerBinaryMissingError>>
>();

const MACHINE_ARCHITECTURES = new Map<string, "x86_64" | "aarch64">([
  ["x86_64", "x86_64"],
  ["amd64", "x86_64"],
  ["aarch64", "aarch64"],
  ["arm64", "aarch64"],
]);

/** Maps `uname -s` and `uname -m` output to the bundled target for that host. */
export function remoteRunnerTargetFor(os: string, machine: string): RemoteRunnerTarget | undefined {
  const cpu = MACHINE_ARCHITECTURES.get(machine);
  if (!cpu) return undefined;
  if (os === "Linux") return `${cpu}-unknown-linux-musl`;
  if (os === "Darwin") return `${cpu}-apple-darwin`;
  return undefined;
}

async function readBinary(
  target: RemoteRunnerTarget,
): Promise<ResultType<RemoteRunnerBinary, RemoteRunnerBinaryMissingError>> {
  const filePath = remoteRunnerBinaryPath(target);
  const read = (
    await Result.tryPromise({
      try: async () => new Uint8Array(await Bun.file(filePath).arrayBuffer()),
      catch: captureRuntimeError,
    })
  ).mapError((captured) =>
    projectCapturedRuntimeError(captured, "Opaque remote runner binary read failure"),
  );
  return read.match<() => ResultType<RemoteRunnerBinary, RemoteRunnerBinaryMissingError>>({
    ok: (raw) => () =>
      Result.ok({
        target,
        hash: crypto.createHash("sha256").update(raw).digest("hex"),
        size: raw.byteLength,
        gzipped: new Uint8Array(gzipSync(raw, { level: 9 })),
        raw,
      }),
    err: (error) => () =>
      Result.err(
        new RemoteRunnerBinaryMissingError({
          target,
          filePath,
          cause: preserveToolPanic(error),
          message: `The ${target} remote runner is not built (${filePath}); run bun run build:remote-runner`,
        }),
      ),
  })();
}

export function loadRemoteRunnerBinary(
  target: RemoteRunnerTarget,
): Promise<ResultType<RemoteRunnerBinary, RemoteRunnerBinaryMissingError>> {
  const cached = loaded.get(target);
  if (cached) return cached;
  const pending = readBinary(target).then((result) => {
    // A missing binary may be built later in a development checkout, so only successes stay cached.
    result.match({ ok: () => undefined, err: () => loaded.delete(target) });
    return result;
  });
  loaded.set(target, pending);
  return pending;
}
