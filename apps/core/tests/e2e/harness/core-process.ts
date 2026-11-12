import { chmod, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { withinRedisDeadline } from "../../../../../packages/event-bus/tests/helpers/isolated-redis";

const REPO_ROOT = path.resolve(import.meta.dir, "../../../../..");

export async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test listener address");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

export type CoreLayout = {
  directory: string;
  dataDir: string;
  workspace: string;
  nativeUrl: string;
  toolUrl: string;
  env: Record<string, string | undefined>;
};

export type CoreConfigOptions = {
  modelUrl: string;
  /** Extra Core config merged over the defaults at the top level. */
  config?: Record<string, unknown>;
  env?: Record<string, string | undefined>;
};

export const OWNER = { username: "owner", password: "e2e-owner-password" };

/** Writes Core's data directory and returns the environment for its process. */
export async function prepareCore(
  directory: string,
  options: CoreConfigOptions,
): Promise<CoreLayout> {
  const dataDir = path.join(directory, "data");
  const workspace = path.join(directory, "workspace");
  const bin = path.join(directory, "bin");
  await Promise.all([mkdir(dataDir, { recursive: true }), mkdir(workspace), mkdir(bin)]);
  const nativePort = await unusedPort();
  const toolPort = await unusedPort();
  const nativeUrl = `http://127.0.0.1:${nativePort}`;
  const toolUrl = `http://127.0.0.1:${toolPort}`;
  // Agents reach Level 2 tools through the `tools` command; run the current client source.
  await writeFile(
    path.join(bin, "tools"),
    `#!/bin/sh\nexec "${process.execPath}" "${path.join(REPO_ROOT, "apps/tool-bridge/client.ts")}" "$@"\n`,
  );
  await chmod(path.join(bin, "tools"), 0o755);
  const { surface: surfaceOverride, ...configOverride } = options.config ?? {};
  await writeFile(
    path.join(dataDir, "core-config.yaml"),
    JSON.stringify({
      configVersion: 3,
      basePrompt: "You are the e2e scenario agent.",
      models: {
        main: { model: "openai-compatible/scripted-main" },
        fast: { model: "openai-compatible/scripted-fast" },
      },
      ...configOverride,
      surface: {
        native: {
          enabled: true,
          installationId: "e2e",
          host: "127.0.0.1",
          port: nativePort,
          publicUrl: nativeUrl,
          allowedOrigins: [nativeUrl],
        },
        ...(surfaceOverride as Record<string, unknown> | undefined),
      },
    }),
  );
  await writeFile(path.join(dataDir, "mcp-config.yaml"), "configVersion: 1\nservers: {}\n");
  const env = {
    PATH: `${bin}:${process.env.PATH}`,
    HOME: directory,
    TMPDIR: directory,
    DATA_DIR: dataDir,
    LILAC_WORKSPACE_DIR: workspace,
    LL_TOOL_SERVER_PORT: String(toolPort),
    TOOL_SERVER_BACKEND_URL: toolUrl,
    LOG_LEVEL: "error",
    CLERK_TELEMETRY_DISABLED: "1",
    OPENAI_COMPATIBLE_BASE_URL: options.modelUrl,
    OPENAI_COMPATIBLE_API_KEY: "e2e",
    LILAC_NATIVE_LOCAL_USERNAME: OWNER.username,
    LILAC_NATIVE_LOCAL_PASSWORD_HASH: await Bun.password.hash(OWNER.password, {
      algorithm: "argon2id",
      memoryCost: 4096,
      timeCost: 1,
    }),
    LILAC_NATIVE_SESSION_SECRET: "e2e-native-session-secret-0123456789abcdef",
    ...options.env,
  };
  return { directory, dataDir, workspace, nativeUrl, toolUrl, env };
}

export type CoreProcess = {
  readonly child: Bun.Subprocess;
  readonly output: () => string;
  ready(): Promise<void>;
  stop(): Promise<void>;
  kill(): Promise<void>;
};

export function startCore(layout: CoreLayout, redisUrl: string): CoreProcess {
  const phases = new Map<string, PromiseWithResolvers<void>>();
  const seen = new Set<string>();
  const fatal: string[] = [];
  let output = "";
  const child = Bun.spawn(
    [process.execPath, "--no-env-file", path.join(import.meta.dir, "core-child.ts")],
    {
      cwd: layout.directory,
      env: { ...layout.env, REDIS_URL: redisUrl },
      stdout: "pipe",
      stderr: "pipe",
      ipc(message: { phase: string; error?: string }) {
        if (message.phase === "fatal") fatal.push(message.error ?? "Unknown runtime failure");
        seen.add(message.phase);
        phases.get(message.phase)?.resolve();
      },
    },
  );
  const drain = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) output += decoder.decode(chunk, { stream: true });
  };
  void drain(child.stdout);
  void drain(child.stderr);
  const phase = async (name: string, timeoutMs = 30_000) => {
    if (seen.has(name)) return;
    const waiter = phases.get(name) ?? Promise.withResolvers<void>();
    phases.set(name, waiter);
    await withinRedisDeadline(
      Promise.race([
        waiter.promise,
        child.exited.then((code) => {
          if (seen.has(name)) return;
          throw new Error(`Core exited ${code} before ${name}:\n${output.slice(-8_000)}`);
        }),
      ]),
      `Core ${name}`,
      timeoutMs,
    );
  };
  return {
    child,
    output: () => output,
    ready: () => phase("ready"),
    async stop() {
      if (child.exitCode !== null) return;
      child.send("stop");
      await phase("stopped");
      await child.exited;
      if (fatal.length) throw new Error(`Core reported fatal errors:\n${fatal.join("\n")}`);
    },
    async kill() {
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
    },
  };
}
