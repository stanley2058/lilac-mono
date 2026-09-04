declare const __LILAC_TOOL_BUILD_ID__: string | undefined;

import { chmodSync, rmSync } from "node:fs";
import { Result, TaggedError, type Result as ResultType } from "better-result";

import type { CliInvocationRequest } from "./invocation-runtime";

const WORKER_ARG = "--__lilac-tools-worker";
const DIRECT_ARG = "--__lilac-tools-direct";
const CAPTURED_ARG = "--__lilac-tools-captured";
const BUILD_ID = typeof __LILAC_TOOL_BUILD_ID__ === "string" ? __LILAC_TOOL_BUILD_ID__ : "dev";

class LauncherProtocolInvalid extends TaggedError("LauncherProtocolInvalid")<{
  readonly message: string;
}> {}

function protocolInvalid(): ResultType<never, LauncherProtocolInvalid> {
  return Result.err(
    new LauncherProtocolInvalid({
      message: "Invalid resident worker protocol",
    }),
  );
}

async function runDirect(): Promise<void> {
  const { runMainEntrypoint } = await import("./client");
  await runMainEntrypoint();
}

async function runCapturedDirect(request: CliInvocationRequest): Promise<void> {
  const { runCapturedCliInvocation } = await import("./client");
  const response = await runCapturedCliInvocation(request, new AbortController().signal);
  await Promise.all([
    response.stdout.length === 0 ? undefined : Bun.write(Bun.stdout, response.stdout),
    response.stderr.length === 0 ? undefined : Bun.write(Bun.stderr, response.stderr),
  ]);
  process.exitCode = response.exitCode;
}

export function decodeInvocationRequest(
  value: unknown,
): ResultType<CliInvocationRequest, LauncherProtocolInvalid> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return protocolInvalid();
  }
  const record = value as Record<string, unknown>;
  if (record.buildId !== BUILD_ID) return protocolInvalid();
  if (!Array.isArray(record.args) || !record.args.every((arg) => typeof arg === "string")) {
    return protocolInvalid();
  }
  if (typeof record.cwd !== "string" || typeof record.stdin !== "string") {
    return protocolInvalid();
  }
  if (
    (record.stdinIsTTY !== undefined && typeof record.stdinIsTTY !== "boolean") ||
    typeof record.stdoutIsTTY !== "boolean"
  ) {
    return protocolInvalid();
  }
  if (typeof record.env !== "object" || record.env === null || Array.isArray(record.env)) {
    return protocolInvalid();
  }
  const envEntries = Object.entries(record.env);
  if (!envEntries.every((entry) => typeof entry[1] === "string")) return protocolInvalid();
  if (
    record.stdoutColumns !== undefined &&
    (typeof record.stdoutColumns !== "number" || !Number.isInteger(record.stdoutColumns))
  ) {
    return protocolInvalid();
  }
  return Result.ok({
    buildId: BUILD_ID,
    args: record.args as string[],
    cwd: record.cwd,
    env: Object.fromEntries(envEntries) as Record<string, string>,
    stdin: record.stdin,
    ...(record.stdinIsTTY === undefined ? {} : { stdinIsTTY: record.stdinIsTTY as boolean }),
    stdoutIsTTY: record.stdoutIsTTY,
    ...(record.stdoutColumns === undefined
      ? {}
      : { stdoutColumns: record.stdoutColumns as number }),
  });
}

async function runWorker(socketPath: string): Promise<void> {
  const { runCapturedCliInvocation, warmCliWorker } = await import("./client");
  await warmCliWorker();
  let server: ReturnType<typeof Bun.serve>;
  const stop = (force: boolean): void => {
    server.stop(force);
    rmSync(socketPath, { force: true });
  };
  server = Bun.serve({
    unix: socketPath,
    async fetch(request) {
      const pathname = new URL(request.url).pathname;
      if (pathname === "/health") {
        return Response.json({
          buildId: BUILD_ID,
          pid: process.pid,
          executable: process.env.LILAC_TOOL_WORKER_EXECUTABLE,
        });
      }
      if (pathname === "/shutdown" && request.method === "POST") {
        setImmediate(() => stop(false));
        return Response.json({ ok: true });
      }
      if (pathname !== "/invoke" || request.method !== "POST") {
        return new Response("Not found", { status: 404 });
      }
      const requestPayload = (
        await Result.tryPromise({
          try: () => request.json(),
          catch: () => undefined,
        })
      ).match({ ok: (value) => value, err: () => undefined });
      const invocation = decodeInvocationRequest(requestPayload).match({
        ok: (value) => value,
        err: () => undefined,
      });
      if (!invocation) return new Response("Invalid invocation", { status: 400 });
      const response = await runCapturedCliInvocation(invocation, request.signal);
      return new Response(new Blob([response.stdout, response.stderr]), {
        headers: {
          "content-type": "application/octet-stream",
          "x-lilac-exit-code": String(response.exitCode),
          "x-lilac-stdout-bytes": String(Buffer.byteLength(response.stdout)),
        },
      });
    },
  });
  chmodSync(socketPath, 0o600);

  process.once("SIGINT", () => stop(true));
  process.once("SIGTERM", () => stop(true));
}

async function runCapturedEntrypoint(): Promise<void> {
  const requestPayload = await Bun.stdin.json();
  const request = decodeInvocationRequest(requestPayload).match({
    ok: (value) => value,
    err: () => undefined,
  });
  if (!request) {
    reportLauncherDefect();
    return;
  }
  await runCapturedDirect(request);
}

async function runDirectEntrypoint(): Promise<void> {
  process.argv.splice(2, 1);
  await runDirect();
}

async function runEntrypoint(): Promise<void> {
  if (process.argv[2] === DIRECT_ARG) {
    await runDirectEntrypoint();
    return;
  }
  if (process.argv[2] === CAPTURED_ARG) {
    await runCapturedEntrypoint();
    return;
  }
  if (process.argv[2] === WORKER_ARG) {
    const socketPath = process.argv[3];
    if (!socketPath) {
      reportLauncherDefect();
      return;
    }
    await runWorker(socketPath);
    return;
  }
  await runDirect();
}

function reportLauncherDefect(): void {
  process.stderr.write(
    `${JSON.stringify({
      status: "error",
      error: {
        kind: "internal",
        code: "bridge_launcher_defect",
        message: "Internal tool launcher failure",
        retryable: false,
      },
    })}\n`,
  );
  process.exitCode = 1;
}

async function startEntrypoint(): Promise<void> {
  const result = await Result.tryPromise({
    try: runEntrypoint,
    catch: () => undefined,
  });
  result.match({ ok: () => undefined, err: reportLauncherDefect });
}

void startEntrypoint();
