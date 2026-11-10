import { sshExecBash } from "../../ssh/ssh-exec";
import { z } from "zod";
import path from "node:path";
import { Result, TaggedError, type Result as ResultType } from "better-result";
import {
  serverToolFailure,
  type ServerToolFailure,
  type ServerToolResult,
} from "@stanley2058/lilac-plugin-runtime";
import { defineServerTool, type ServerTool, type ServerToolCallOptions } from "../types";

import { readConfiguredSshHosts, requireConfiguredSshHostResult } from "../../ssh/ssh-config";

const DEFAULT_SSH_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const MAX_OUTPUT_CHARS = 200_000;

function sshFailure(kind: ServerToolFailure["kind"], message: string): ServerToolFailure {
  return serverToolFailure({
    kind,
    code: `ssh_${kind}`,
    message,
    retryable: kind === "unavailable" || kind === "timeout",
  });
}

async function requireSshHost(host: string): Promise<ResultType<void, ServerToolFailure>> {
  return (await requireConfiguredSshHostResult(host)).mapError((error) =>
    sshFailure(error._tag === "SshConfigReadError" ? "unavailable" : "not_found", error.message),
  );
}

const sshProbeOutputSchema = z.strictObject({
  ok: z.literal(true),
  system: z.strictObject({
    uname: z.strictObject({ s: z.string(), m: z.string(), r: z.string() }),
    osRelease: z.strictObject({ id: z.string(), versionId: z.string() }),
    user: z.string(),
    home: z.string(),
    shell: z.string(),
    pwd: z.string(),
  }),
  cwd: z.strictObject({ attempted: z.string(), used: z.string() }),
  git: z.strictObject({
    isRepo: z.boolean(),
    topLevel: z.string(),
    head: z.string(),
    branch: z.string(),
    statusPorcelain: z.string(),
  }),
  expectedTools: z.array(z.string()),
  tools: z.record(
    z.string(),
    z.strictObject({ present: z.boolean(), path: z.string(), version: z.string() }),
  ),
});

export type SshProbeOutput = z.output<typeof sshProbeOutputSchema>;

export class SshProbeOutputInvalid extends TaggedError("SshProbeOutputInvalid")<{
  readonly message: string;
}> {}

export function decodeSshProbeOutput(
  text: string,
): ResultType<SshProbeOutput, SshProbeOutputInvalid> {
  const parsedResult = Result.try({
    try: (): unknown => JSON.parse(text),
    catch: () => new SshProbeOutputInvalid({ message: "SSH probe returned invalid JSON" }),
  });
  const parsedOutcome = parsedResult.match<
    | { readonly kind: "success"; readonly parsed: unknown }
    | { readonly kind: "failure"; readonly error: SshProbeOutputInvalid }
  >({
    ok: (parsed) => ({ kind: "success", parsed }),
    err: (error) => ({ kind: "failure", error }),
  });
  if (parsedOutcome.kind === "failure") return Result.err(parsedOutcome.error);
  const { parsed } = parsedOutcome;
  const decoded = sshProbeOutputSchema.safeParse(parsed);
  if (decoded.success) return Result.ok(decoded.data);
  return Result.err(
    new SshProbeOutputInvalid({ message: "SSH probe returned an invalid response contract" }),
  );
}

const emptyInputSchema = z.object({});

const runInputSchema = z.object({
  host: z
    .string()
    .min(1)
    .describe("SSH host alias from ~/.ssh/config (or a valid ssh destination like user@host)."),
  cmd: z.string().min(1).describe("Command to execute on the remote host."),
  cwd: z
    .string()
    .optional()
    .describe(
      "Optional working directory on the remote host. If provided, the command runs after `cd`.",
    ),
  timeoutMs: z.coerce
    .number()
    .int()
    .positive()
    .max(24 * 60 * 60 * 1000)
    .optional()
    .describe("Timeout in ms (default: 10 minutes)."),
});

type RunInput = z.infer<typeof runInputSchema>;

const probeInputSchema = z.object({
  host: z
    .string()
    .min(1)
    .describe("SSH host alias from ~/.ssh/config. Use ssh.hosts to list configured aliases."),
  cwd: z
    .string()
    .optional()
    .describe(
      "Optional working directory to probe (used for git context). Defaults to the remote default directory.",
    ),
  timeoutMs: z.coerce
    .number()
    .int()
    .positive()
    .max(24 * 60 * 60 * 1000)
    .optional()
    .describe("Timeout in ms (default: 10 minutes)."),
});

type ProbeInput = z.infer<typeof probeInputSchema>;

let cachedProbeScript: string | null = null;
async function loadProbeScript(): Promise<string> {
  if (cachedProbeScript) return cachedProbeScript;
  const p = path.join(import.meta.dir, "ssh-probe.sh");
  cachedProbeScript = await Bun.file(p).text();
  return cachedProbeScript;
}

export class SSH implements ServerTool {
  id = "ssh";
  private readonly tool: ServerTool;

  constructor() {
    const catalog = async () => {
      const { hosts, readError } = await readConfiguredSshHosts();
      return { hidden: hosts.length === 0 && readError === undefined };
    };

    this.tool = defineServerTool({
      id: this.id,
      callables: ({ callable }) => ({
        "ssh.hosts": callable({
          name: "SSH Hosts",
          description: "List SSH host aliases discovered from ~/.ssh/config on this server.",
          inputSchema: emptyInputSchema,
          validation: "zod",
          catalog,
          run: async () => {
            const { configPath, hosts, exists, readError } = await readConfiguredSshHosts();
            return Result.ok({
              configPath,
              exists,
              hosts,
              readError,
            });
          },
        }),
        "ssh.run": callable({
          name: "SSH Run",
          description:
            "Run a command on a remote host over SSH (StrictHostKeyChecking=yes, BatchMode=yes, bash --noprofile --norc).",
          inputSchema: runInputSchema,
          validation: "zod",
          catalog,
          run: (input, opts) => this.callRun(input, opts?.signal),
        }),
        "ssh.probe": callable({
          name: "SSH Probe",
          description:
            "Probe remote host capabilities (expected tools + basic system and git context).",
          inputSchema: probeInputSchema,
          validation: "zod",
          primaryPositional: "host",
          catalog,
          run: (input, opts) => this.callProbe(input, opts?.signal),
        }),
      }),
    });
  }

  async init(): Promise<void> {
    await this.tool.init();
  }

  async destroy(): Promise<void> {
    await this.tool.destroy();
  }

  async list() {
    return await this.tool.list();
  }

  async call(
    callableId: string,
    input: Record<string, unknown>,
    opts?: ServerToolCallOptions,
  ): Promise<ServerToolResult> {
    return await this.tool.call(callableId, input, opts);
  }

  private async callRun(
    input: RunInput,
    signal: AbortSignal | undefined,
  ): Promise<ServerToolResult> {
    const required = await requireSshHost(input.host);
    const requirementFailure = required.match({
      ok: () => undefined,
      err: (failure) => failure,
    });
    if (requirementFailure) return Result.err(requirementFailure);
    if (signal?.aborted) {
      return Result.err(sshFailure("cancelled", "SSH command was cancelled"));
    }

    const result = await sshExecBash({
      host: input.host,
      cmd: input.cmd,
      cwd: input.cwd,
      timeoutMs: input.timeoutMs ?? DEFAULT_SSH_TIMEOUT_MS,
      signal,
      maxOutputChars: MAX_OUTPUT_CHARS,
    });
    if (result.timedOut) return Result.err(sshFailure("timeout", "SSH command timed out"));
    if (result.aborted) return Result.err(sshFailure("cancelled", "SSH command was cancelled"));
    return Result.ok({
      ok:
        result.exitCode === 0 &&
        !result.errors?.stdoutRead &&
        !result.errors?.stderrRead &&
        !result.errors?.exitRead,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      timedOut: result.timedOut,
      target: { host: input.host, cwd: input.cwd, strictHostKeyChecking: true, batchMode: true },
      stdout: result.stdout,
      stderr: result.stderr,
      truncated: result.capped,
      transportError: result.transportError,
      errors: {
        stdoutRead: result.errors?.stdoutRead ? "stdout read failed" : undefined,
        stderrRead: result.errors?.stderrRead ? "stderr read failed" : undefined,
        exitRead: result.errors?.exitRead,
      },
    });
  }

  private async callProbe(
    input: ProbeInput,
    signal: AbortSignal | undefined,
  ): Promise<ServerToolResult> {
    const required = await requireSshHost(input.host);
    const failure = required.match({ ok: () => undefined, err: (error) => error });
    if (failure) return Result.err(failure);
    const script = await loadProbeScript();
    const result = await sshExecBash({
      host: input.host,
      cmd: script,
      cwd: input.cwd,
      timeoutMs: input.timeoutMs ?? DEFAULT_SSH_TIMEOUT_MS,
      signal,
      maxOutputChars: MAX_OUTPUT_CHARS,
    });
    if (result.timedOut) return Result.err(sshFailure("timeout", "SSH probe timed out"));
    if (result.aborted) return Result.err(sshFailure("cancelled", "SSH probe was cancelled"));
    if (result.errors?.stdoutRead || result.errors?.stderrRead || result.errors?.exitRead)
      return Result.ok({ ok: false, errors: result.errors, parseError: undefined });
    if (result.exitCode !== 0)
      return Result.err(sshFailure("unavailable", result.stderr || "SSH probe failed"));
    return decodeSshProbeOutput(result.stdout.trim())
      .mapError((error) => sshFailure("unavailable", error.message))
      .map((probe) => ({
        ok: true,
        probe: { ...probe, cwd: { ...probe.cwd, attempted: input.cwd ?? "" } },
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        timedOut: false,
        target: { host: input.host, cwd: input.cwd, strictHostKeyChecking: true, batchMode: true },
        stderr: result.stderr,
        truncated: result.capped,
        errors: {},
      }));
  }
}
