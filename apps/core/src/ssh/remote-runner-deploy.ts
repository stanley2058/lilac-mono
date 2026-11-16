import { REMOTE_RUNNER_TARGETS, type RemoteRunnerTarget } from "@stanley2058/lilac-remote-runner";
import { createLogger, formatTaggedErrorForLog } from "@stanley2058/lilac-utils";
import { Panic, Result, type Result as ResultType } from "better-result";

import { captureRuntimeError, projectCapturedRuntimeError } from "../runtime/error-format";
import { preserveToolPanic } from "../tools/tool-result-adapters";
import {
  loadRemoteRunnerBinary,
  remoteRunnerTargetFor,
  type RemoteRunnerBinary,
} from "./remote-runner-binaries";
import { runSshCommand, SshCommandError, type SshCommandOutcome } from "./ssh-command";

const logger = createLogger({ module: "remote-runner-deploy" });

/** How long Core remembers that a host cannot run the native runner before probing it again. */
const UNSUPPORTED_RETRY_MS = 10 * 60 * 1000;
/** Deployment is shared by concurrent callers, so it runs on its own deadline. */
const DEPLOY_TIMEOUT_MS = 2 * 60 * 1000;

export type RemoteRunnerDeployment =
  | {
      readonly kind: "runner";
      readonly target: RemoteRunnerTarget;
      /** Remote command words that start the runner; the caller appends its missing-runner token. */
      readonly command: readonly string[];
    }
  | { readonly kind: "unsupported"; readonly reason: string };

/** A deployment step that did not finish; the caller reports it like any other SSH failure. */
export type RemoteRunnerDeployFailure =
  | { readonly kind: "ssh"; readonly outcome: SshCommandOutcome }
  | { readonly kind: "command"; readonly error: SshCommandError }
  | { readonly kind: "aborted" }
  | { readonly kind: "timed_out" };

type CachedDeployment = {
  readonly deployment: RemoteRunnerDeployment;
  readonly expiresAt: number;
};

const deployments = new Map<string, CachedDeployment>();
const deploymentGates = new Map<string, Promise<SharedDeployment>>();

// The probe and upload scripts reach the remote login shell, which may not be a POSIX shell, so
// they run under `sh` and are passed as single-quoted words without quotes or backslashes inside.
const PROBE_SCRIPT = `
os=$(uname -s 2>/dev/null) || os=unknown
machine=$(uname -m 2>/dev/null) || machine=unknown
base="\${XDG_CACHE_HOME:-$HOME/.cache}/lilac/remote-runner"
echo "platform $os $machine"
echo "base $base"
if command -v gzip >/dev/null 2>&1; then echo gzip; fi
for hash in "$@"; do
  bin="$base/$hash/lilac-remote"
  if [ -x "$bin" ] && "$bin" --version >/dev/null 2>&1; then echo "installed $hash"; fi
done
`;

const UPLOAD_SCRIPT = `
set -e
umask 077
dir="\${XDG_CACHE_HOME:-$HOME/.cache}/lilac/remote-runner/$1"
mkdir -p "$dir"
tmp=$(mktemp "$dir/upload.XXXXXX")
if [ "$2" = gzip ]; then
  gzip -dc >"$tmp" || { rm -f "$tmp"; exit 1; }
else
  cat >"$tmp" || { rm -f "$tmp"; exit 1; }
fi
chmod 700 "$tmp"
version=$("$tmp" --version) || { rm -f "$tmp"; exit 1; }
mv -f "$tmp" "$dir/lilac-remote"
echo "$version"
`;

/**
 * Printed with the call's token by the launch wrapper when the cached binary is gone, before any
 * command runs. The token is unpredictable, so a command cannot imitate the wrapper.
 */
export const REMOTE_RUNNER_MISSING_MARKER = "lilac-remote-runner-missing";

const LAUNCH_SCRIPT = `[ -x "$0" ] || { echo "${REMOTE_RUNNER_MISSING_MARKER}:$1" >&2; exit 127; }; exec "$0" rpc`;

export function quoteRemoteWord(value: string): string | undefined {
  if (value.includes("'") || value.includes("\\")) return undefined;
  return `'${value}'`;
}

type ProbeReport = {
  readonly os: string;
  readonly machine: string;
  readonly base: string;
  readonly gzip: boolean;
  readonly installed: ReadonlySet<string>;
};

function parseProbe(stdout: string): ProbeReport | undefined {
  let os: string | undefined;
  let machine: string | undefined;
  let base: string | undefined;
  let gzip = false;
  const installed = new Set<string>();
  for (const line of stdout.split("\n")) {
    const [kind, ...rest] = line.split(" ");
    if (kind === "platform") [os, machine] = rest;
    if (kind === "base") base = rest.join(" ");
    if (kind === "gzip") gzip = true;
    if (kind === "installed" && rest[0]) installed.add(rest[0]);
  }
  if (!os || !machine || !base) return undefined;
  return { os, machine, base, gzip, installed };
}

async function loadAvailableBinaries(): Promise<Map<RemoteRunnerTarget, RemoteRunnerBinary>> {
  const available = new Map<RemoteRunnerTarget, RemoteRunnerBinary>();
  for (const target of REMOTE_RUNNER_TARGETS) {
    const binary = await loadRemoteRunnerBinary(target);
    binary.match({
      ok: (value) => {
        available.set(target, value);
      },
      err: (error) =>
        logger.debug("remote runner binary unavailable", formatTaggedErrorForLog(error)),
    });
  }
  return available;
}

function sshFailure(
  outcome: ResultType<SshCommandOutcome, SshCommandError>,
): RemoteRunnerDeployFailure | SshCommandOutcome {
  return outcome.match<RemoteRunnerDeployFailure | SshCommandOutcome>({
    ok: (value) =>
      value.timedOut || value.aborted || value.exitCode === 255
        ? { kind: "ssh", outcome: value }
        : value,
    err: (error) => ({ kind: "command", error }),
  });
}

function isDeployFailure(
  value: RemoteRunnerDeployFailure | SshCommandOutcome,
): value is RemoteRunnerDeployFailure {
  return "kind" in value;
}

async function deploy(params: {
  readonly host: string;
  readonly deadline: number;
}): Promise<ResultType<RemoteRunnerDeployment, RemoteRunnerDeployFailure>> {
  const binaries = await loadAvailableBinaries();
  if (binaries.size === 0) {
    return Result.ok({ kind: "unsupported", reason: "no remote runner binaries are built" });
  }
  const probeScript = quoteRemoteWord(PROBE_SCRIPT);
  const probed = sshFailure(
    await runSshCommand({
      host: params.host,
      remoteArgs: [
        "sh",
        "-c",
        probeScript ?? "",
        "lilac-probe",
        ...[...binaries.values()].map((binary) => binary.hash),
      ],
      stdin: new Blob([]),
      timeoutMs: Math.max(1, params.deadline - Date.now()),
    }),
  );
  if (isDeployFailure(probed)) return Result.err(probed);
  // A failing probe is a connection or shell failure, which the caller reports like any SSH error.
  if (probed.exitCode !== 0) return Result.err({ kind: "ssh", outcome: probed });
  const report = parseProbe(probed.stdout);
  if (!report) {
    return Result.ok({ kind: "unsupported", reason: "the host did not answer the runner probe" });
  }
  const target = remoteRunnerTargetFor(report.os, report.machine);
  const binary = target ? binaries.get(target) : undefined;
  if (!target || !binary) {
    return Result.ok({
      kind: "unsupported",
      reason: `no remote runner is bundled for ${report.os} ${report.machine}`,
    });
  }
  const runnerPath = quoteRemoteWord(`${report.base}/${binary.hash}/lilac-remote`);
  if (!runnerPath) {
    return Result.ok({ kind: "unsupported", reason: "the remote cache path cannot be quoted" });
  }
  const deployment: RemoteRunnerDeployment = {
    kind: "runner",
    target,
    command: ["sh", "-c", quoteRemoteWord(LAUNCH_SCRIPT) ?? "", runnerPath],
  };
  if (report.installed.has(binary.hash)) return Result.ok(deployment);

  const uploadScript = quoteRemoteWord(UPLOAD_SCRIPT);
  const uploaded = sshFailure(
    await runSshCommand({
      host: params.host,
      remoteArgs: [
        "sh",
        "-c",
        uploadScript ?? "",
        "lilac-upload",
        binary.hash,
        report.gzip ? "gzip" : "raw",
      ],
      stdin: new Blob([report.gzip ? binary.gzipped : binary.raw]),
      timeoutMs: Math.max(1, params.deadline - Date.now()),
    }),
  );
  if (isDeployFailure(uploaded)) return Result.err(uploaded);
  if (uploaded.exitCode !== 0 || !uploaded.stdout.startsWith("lilac-remote ")) {
    const detail = uploaded.stderr.trim().split("\n").at(-1) ?? "";
    return Result.ok({
      kind: "unsupported",
      reason: `the remote runner could not be installed or started${detail ? `: ${detail}` : ""}`,
    });
  }
  logger.info("remote runner installed", { host: params.host });
  return Result.ok(deployment);
}

/**
 * Returns the runner command for a host, probing and uploading it on first use. Concurrent callers
 * for one host share a single deployment. Failures that come from SSH itself are not cached.
 */
export async function resolveRemoteRunner(params: {
  readonly host: string;
  readonly deadline: number;
  readonly signal?: AbortSignal;
}): Promise<ResultType<RemoteRunnerDeployment, RemoteRunnerDeployFailure>> {
  const cached = deployments.get(params.host);
  if (cached && cached.expiresAt > Date.now()) return Result.ok(cached.deployment);
  const shared = deploymentGates.get(params.host) ?? startDeployment(params.host);
  const outcome = await waitForDeployment(shared, params.deadline, params.signal);
  if (outcome.kind === "panic") return preserveToolPanic(outcome.panic);
  return outcome.result;
}

/** A shared deployment's outcome. It never rejects, so every waiter can observe a Panic. */
type SharedDeployment =
  | {
      readonly kind: "result";
      readonly result: ResultType<RemoteRunnerDeployment, RemoteRunnerDeployFailure>;
    }
  | { readonly kind: "panic"; readonly panic: Panic };

async function settleDeployment(params: {
  readonly host: string;
  readonly deadline: number;
}): Promise<SharedDeployment> {
  const captured = await Result.tryPromise({
    try: () => deploy(params),
    catch: captureRuntimeError,
  });
  return captured.match<SharedDeployment>({
    ok: (result) => ({ kind: "result", result }),
    err: (capture) => {
      const failure = projectCapturedRuntimeError(
        capture,
        "Opaque remote runner deployment failure",
      );
      if (Panic.is(failure)) return { kind: "panic", panic: failure };
      return {
        kind: "result",
        result: Result.err({
          kind: "command",
          error: new SshCommandError({
            operation: "spawn",
            cause: failure,
            message: failure.message,
          }),
        }),
      };
    },
  });
}

function startDeployment(host: string): Promise<SharedDeployment> {
  const params = { host, deadline: Date.now() + DEPLOY_TIMEOUT_MS };
  const started = settleDeployment(params).then((outcome) => {
    if (deploymentGates.get(host) === started) deploymentGates.delete(host);
    if (outcome.kind === "panic") return outcome;
    outcome.result.match({
      ok: (deployment) =>
        deployments.set(params.host, {
          deployment,
          expiresAt:
            deployment.kind === "runner"
              ? Number.POSITIVE_INFINITY
              : Date.now() + UNSUPPORTED_RETRY_MS,
        }),
      err: () => undefined,
    });
    return outcome;
  });
  deploymentGates.set(host, started);
  return started;
}

/** Waits for a shared deployment under one caller's own deadline and cancellation. */
async function waitForDeployment(
  shared: Promise<SharedDeployment>,
  deadline: number,
  signal: AbortSignal | undefined,
): Promise<SharedDeployment> {
  if (signal?.aborted) return { kind: "result", result: Result.err({ kind: "aborted" }) };
  const settled = Promise.withResolvers<SharedDeployment>();
  const onAbort = () =>
    settled.resolve({ kind: "result", result: Result.err({ kind: "aborted" }) });
  const timer = setTimeout(
    () => settled.resolve({ kind: "result", result: Result.err({ kind: "timed_out" }) }),
    Math.max(0, deadline - Date.now()),
  );
  signal?.addEventListener("abort", onAbort, { once: true });
  void shared.then(settled.resolve);
  return await settled.promise.finally(() => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  });
}

/** Forgets a host's deployment, for example after its cached binary disappeared. */
export function invalidateRemoteRunner(host: string): void {
  deployments.delete(host);
}
