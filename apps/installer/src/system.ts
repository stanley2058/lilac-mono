import { Result, TaggedError } from "better-result";

export class InstallerSystemFailed extends TaggedError("InstallerSystemFailed")<{
  readonly message: string;
}> {}

export async function command(
  args: string[],
  options: { cwd?: string; inherit?: boolean; timeoutMs?: number } = {},
) {
  return Result.tryPromise({
    try: async () => {
      const child = Bun.spawn(args, {
        cwd: options.cwd,
        stdin: "ignore",
        stdout: options.inherit ? "inherit" : "pipe",
        stderr: options.inherit ? "inherit" : "pipe",
        env: { ...process.env, COMPOSE_IGNORE_ORPHANS: "true" },
        signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
      });
      const [code, stdout] = await Promise.all([
        child.exited,
        child.stdout instanceof ReadableStream
          ? new Response(child.stdout).text()
          : Promise.resolve(""),
        child.stderr instanceof ReadableStream
          ? new Response(child.stderr).text()
          : Promise.resolve(""),
      ]);
      return { code, stdout };
    },
    catch: () => new InstallerSystemFailed({ message: `Could not run ${args[0] ?? "command"}.` }),
  });
}

export async function checkMachine() {
  return Result.gen(async function* () {
    if (
      !["linux", "darwin"].includes(process.platform) ||
      !["x64", "arm64"].includes(process.arch)
    ) {
      return Result.err(
        new InstallerSystemFailed({
          message: "Lilac setup supports Linux and macOS on x64 and ARM64.",
        }),
      );
    }
    if (!Bun.which("docker"))
      return Result.err(
        new InstallerSystemFailed({
          message: "Docker is missing. Install Docker, then rerun setup.",
        }),
      );
    const compose = yield* Result.await(command(["docker", "compose", "version", "--short"]));
    const version = compose.stdout.trim().replace(/^v/, "").split(".").map(Number);
    if (
      compose.code !== 0 ||
      (version[0] ?? 0) < 2 ||
      (version[0] === 2 && (version[1] ?? 0) < 30)
    ) {
      return Result.err(
        new InstallerSystemFailed({
          message:
            "Docker Compose 2.30 or newer is required. Update the Compose plugin, then rerun setup.",
        }),
      );
    }
    const daemon = yield* Result.await(command(["docker", "info", "--format", "{{.OSType}}"]));
    if (daemon.code !== 0)
      return Result.err(
        new InstallerSystemFailed({
          message:
            "Cannot access the Docker daemon. Start Docker and check your user's Docker permissions.",
        }),
      );
    if (daemon.stdout.trim() !== "linux")
      return Result.err(
        new InstallerSystemFailed({ message: "Docker must be running Linux containers." }),
      );
    return Result.ok(undefined);
  });
}
