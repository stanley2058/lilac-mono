import path from "node:path";

/** Rust targets Core ships a runner for; `scripts/build-remote-runner.ts` builds each one. */
export const REMOTE_RUNNER_TARGETS = [
  "x86_64-unknown-linux-musl",
  "aarch64-unknown-linux-musl",
  "x86_64-apple-darwin",
  "aarch64-apple-darwin",
] as const;

export type RemoteRunnerTarget = (typeof REMOTE_RUNNER_TARGETS)[number];

export const REMOTE_RUNNER_BINARY_NAME = "lilac-remote";

/** Built binaries live at `<dist>/<target>/lilac-remote`, in a checkout and in the image. */
export const REMOTE_RUNNER_DIST_DIR = path.join(import.meta.dir, "dist");

export function remoteRunnerBinaryPath(target: RemoteRunnerTarget): string {
  return path.join(REMOTE_RUNNER_DIST_DIR, target, REMOTE_RUNNER_BINARY_NAME);
}
