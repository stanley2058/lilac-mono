import { AsyncLocalStorage } from "node:async_hooks";

export type CliInvocationRequest = {
  readonly buildId: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly stdin: string;
  readonly stdinIsTTY?: boolean;
  readonly stdoutIsTTY: boolean;
  readonly stdoutColumns?: number;
};

export type CliInvocationResponse = {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
};

type InvocationState = {
  readonly request: CliInvocationRequest;
  readonly signal: AbortSignal;
  readonly stdout: string[];
  readonly stderr: string[];
  exitCode: number;
  operatorToken?: string;
  operatorRequestId?: string;
};

const invocationStorage = new AsyncLocalStorage<InvocationState>();

function activeInvocation(): InvocationState | undefined {
  return invocationStorage.getStore();
}

export async function captureCliInvocation(
  request: CliInvocationRequest,
  signal: AbortSignal,
  operation: () => Promise<void>,
): Promise<CliInvocationResponse> {
  const state: InvocationState = {
    request,
    signal,
    stdout: [],
    stderr: [],
    exitCode: 0,
  };
  await invocationStorage.run(state, operation);
  return {
    stdout: state.stdout.join(""),
    stderr: state.stderr.join(""),
    exitCode: state.exitCode,
  };
}

export function runtimeArgs(): readonly string[] {
  return activeInvocation()?.request.args ?? process.argv.slice(2);
}

export function runtimeCwd(): string {
  return activeInvocation()?.request.cwd ?? process.cwd();
}

export function runtimeEnv(name: string): string | undefined {
  const invocation = activeInvocation();
  return invocation ? invocation.request.env[name] : process.env[name];
}

export function runtimeSignal(): AbortSignal | undefined {
  return activeInvocation()?.signal;
}

export function runtimeStdinIsTTY(): boolean | undefined {
  const invocation = activeInvocation();
  return invocation ? invocation.request.stdinIsTTY : process.stdin.isTTY;
}

export function runtimeStdoutIsTTY(): boolean {
  return activeInvocation()?.request.stdoutIsTTY ?? process.stdout.isTTY === true;
}

export function runtimeStdoutColumns(): number | undefined {
  const invocation = activeInvocation();
  return invocation ? invocation.request.stdoutColumns : process.stdout.columns;
}

export async function readRuntimeStdin(): Promise<string> {
  const invocation = activeInvocation();
  if (invocation) return invocation.request.stdin;

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function writeRuntimeStdout(value: string): void {
  const invocation = activeInvocation();
  if (invocation) {
    invocation.stdout.push(value);
    return;
  }
  process.stdout.write(value);
}

export function writeRuntimeStderr(value: string): void {
  const invocation = activeInvocation();
  if (invocation) {
    invocation.stderr.push(value);
    return;
  }
  process.stderr.write(value);
}

export function setRuntimeExitCode(exitCode: number): void {
  const invocation = activeInvocation();
  if (invocation) {
    invocation.exitCode = exitCode;
    return;
  }
  process.exitCode = exitCode;
}

export function setRuntimeOperator(token: string, requestId: string): void {
  const invocation = activeInvocation();
  if (invocation) {
    invocation.operatorToken = token;
    invocation.operatorRequestId = requestId;
    return;
  }
  directOperatorToken = token;
  directOperatorRequestId = requestId;
}

let directOperatorToken: string | undefined;
let directOperatorRequestId: string | undefined;

export function runtimeOperator(): { token?: string; requestId?: string } {
  const invocation = activeInvocation();
  return invocation
    ? { token: invocation.operatorToken, requestId: invocation.operatorRequestId }
    : { token: directOperatorToken, requestId: directOperatorRequestId };
}

export function hasCapturedInvocation(): boolean {
  return activeInvocation() !== undefined;
}
