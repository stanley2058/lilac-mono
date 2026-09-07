import { Result, type Result as ResultType } from "better-result";
import { z } from "zod";
import {
  decodeRunnerReply,
  failure,
  type GatewayConfig,
  type GatewayFailure,
  type RunnerRecord,
  type RunnerReply,
  type RunnerRequest,
} from "./contracts";

export const OWNER_LABEL = "io.lilac.computer.owner";
const GENERATION_LABEL = "io.lilac.computer.generation";
const SESSION_LABEL = "io.lilac.computer.session";
export type Container = {
  id: string;
  generation: string;
  session: string;
  running: boolean;
  port: number | null;
  bindAddress: string | null;
};
export interface RunnerDocker {
  list(): Promise<ResultType<Container[], GatewayFailure>>;
  create(record: RunnerRecord): Promise<ResultType<string, GatewayFailure>>;
  start(id: string): Promise<ResultType<void, GatewayFailure>>;
  remove(id: string): Promise<ResultType<void, GatewayFailure>>;
  call(
    id: string,
    request: RunnerRequest,
    signal?: AbortSignal,
  ): Promise<ResultType<RunnerReply, GatewayFailure>>;
}

const inspectSchema = z.array(
  z.object({
    Id: z.string().regex(/^[a-f0-9]{64}$/),
    State: z.object({ Running: z.boolean() }),
    Config: z.object({ Labels: z.record(z.string(), z.string()).nullable() }),
    HostConfig: z.object({
      PortBindings: z
        .record(
          z.string(),
          z.array(z.object({ HostIp: z.string(), HostPort: z.string() })).nullable(),
        )
        .nullable(),
    }),
  }),
);

export function decodeContainers(text: string, owner: string) {
  return Result.gen(function* () {
    const raw: unknown = yield* Result.try({
      try: () => JSON.parse(text),
      catch: () => failure("unavailable", "Invalid Docker inspection"),
    });
    const parsed = inspectSchema.safeParse(raw);
    if (!parsed.success) return Result.err(failure("unavailable", "Invalid Docker inspection"));
    const containers: Container[] = [];
    for (const item of parsed.data) {
      if (item.Config.Labels?.[OWNER_LABEL] !== owner)
        return Result.err(failure("unavailable", "Docker ownership mismatch"));
      const bindings = item.HostConfig.PortBindings?.["6901/tcp"];
      const binding = bindings?.length === 1 ? bindings[0] : undefined;
      const port = binding ? Number(binding.HostPort) : NaN;
      containers.push({
        id: item.Id,
        generation: item.Config.Labels[GENERATION_LABEL] ?? "",
        session: item.Config.Labels[SESSION_LABEL] ?? "",
        running: item.State.Running,
        port: Number.isInteger(port) && port > 0 && port <= 65535 ? port : null,
        bindAddress: binding?.HostIp ?? null,
      });
    }
    return Result.ok(containers);
  });
}

async function readOutput(stream: ReadableStream<Uint8Array>, stop: () => void) {
  return Result.gen(async function* () {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const part = yield* Result.await(
        Result.tryPromise({
          try: () => reader.read(),
          catch: () => failure("unavailable", "Docker output interrupted"),
        }),
      );
      if (part.done) break;
      length += part.value.length;
      if (length > 16777216) {
        stop();
        return Result.err(failure("unavailable", "Docker output exceeds limit"));
      }
      chunks.push(part.value);
    }
    return Result.ok(Buffer.concat(chunks).toString("utf8"));
  });
}

export async function dockerCommand(
  args: string[],
  options: {
    input?: string;
    password?: string;
    signal?: AbortSignal;
    timeoutMs?: number;
    missingId?: string;
  } = {},
) {
  if (options.signal?.aborted)
    return Result.err(failure("cancelled", "Computer operation cancelled"));
  const started = Result.try({
    try: () =>
      Bun.spawn(["docker", ...args], {
        stdin: options.input === undefined ? "ignore" : new Blob([options.input]),
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          ...(options.password === undefined ? {} : { VNC_PW: options.password }),
        },
      }),
    catch: () => failure("unavailable", "Cannot invoke Docker"),
  });
  if (started.isErr()) return started;
  const child = started.value;
  let timedOut = false;
  const stop = () => {
    child.kill();
  };
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, options.timeoutMs ?? 15000);
  options.signal?.addEventListener("abort", stop, { once: true });
  const result = await Result.gen(async function* () {
    const [stdout, stderr, exit] = await Promise.all([
      readOutput(child.stdout, stop),
      readOutput(child.stderr, stop),
      child.exited,
    ]);
    const output = yield* stdout;
    const errorText = yield* stderr;
    if (timedOut) return Result.err(failure("timeout", "Computer operation timed out"));
    if (options.signal?.aborted)
      return Result.err(failure("cancelled", "Computer operation cancelled"));
    if (exit !== 0) {
      if (
        options.missingId &&
        errorText.trim().toLowerCase() === `error: no such object: ${options.missingId}`
      )
        return Result.ok("");
      const binding = /port is already allocated|address already in use|Bind for .* failed/.test(
        errorText,
      );
      return Result.err(
        failure(
          binding ? "binding" : "unavailable",
          binding ? "Host port is occupied" : "Docker operation failed",
        ),
      );
    }
    return Result.ok(output);
  });
  clearTimeout(timer);
  options.signal?.removeEventListener("abort", stop);
  return result;
}

export class DockerCli implements RunnerDocker {
  constructor(
    private readonly config: GatewayConfig,
    private readonly run: typeof dockerCommand = dockerCommand,
  ) {}

  async list() {
    const owner = this.config.owner;
    const run = this.run;
    return Result.gen(async function* () {
      const output = yield* Result.await(
        run(["ps", "-aq", "--no-trunc", "--filter", `label=${OWNER_LABEL}=${owner}`]),
      );
      const ids = output.trim().split(/\s+/).filter(Boolean);
      if (ids.length === 0) return Result.ok([]);
      const containers: Container[] = [];
      for (const id of ids) {
        if (!/^[a-f0-9]{64}$/.test(id))
          return Result.err(failure("unavailable", "Invalid Docker container identity"));
        const inspected = yield* Result.await(run(["inspect", id], { missingId: id }));
        if (!inspected) continue;
        containers.push(...(yield* decodeContainers(inspected, owner)));
      }
      return Result.ok(containers);
    });
  }

  async create(record: RunnerRecord) {
    const host = this.config.bindAddress.includes(":")
      ? `[${this.config.bindAddress}]`
      : this.config.bindAddress;
    const result = await this.run(
      [
        "create",
        "--name",
        `lilac-computer-${record.generation}`,
        "--label",
        `${OWNER_LABEL}=${this.config.owner}`,
        "--label",
        `${GENERATION_LABEL}=${record.generation}`,
        "--label",
        `${SESSION_LABEL}=${record.session}`,
        "--shm-size=1g",
        "--memory=4g",
        "--pids-limit=1024",
        "--security-opt",
        `seccomp=${this.config.seccomp}`,
        "--publish",
        `${host}:${record.port}:6901`,
        "--env",
        "VNC_PW",
        this.config.image,
      ],
      { password: record.password, timeoutMs: 30000 },
    );
    return result.andThen((text) =>
      /^[a-f0-9]{64}$/.test(text.trim())
        ? Result.ok(text.trim())
        : Result.err(failure("unavailable", "Invalid created container identity")),
    );
  }

  async start(id: string) {
    return (await this.run(["start", id], { timeoutMs: 30000 })).map(() => undefined);
  }

  async remove(id: string): Promise<ResultType<void, GatewayFailure>> {
    const removed = await this.run(["rm", "--force", "--volumes", id]);
    const error = removed.match({ ok: () => null, err: (value) => value });
    if (!error) return Result.ok(undefined);
    const remaining = await this.list();
    return remaining.andThen(
      (items): ResultType<void, GatewayFailure> =>
        items.some((item) => item.id === id) ? Result.err(error) : Result.ok(undefined),
    );
  }

  async call(id: string, request: RunnerRequest, signal?: AbortSignal) {
    const result = await this.run(
      [
        "exec",
        "-i",
        "--user",
        "cua",
        id,
        "/opt/venv/bin/python",
        "-B",
        "/opt/lilac-computer/runtime.py",
        "client",
      ],
      {
        input: JSON.stringify(request) + "\n",
        signal,
        timeoutMs: request.operation === "execute" ? 120000 : 10000,
      },
    );
    return result.andThen(decodeRunnerReply);
  }
}
