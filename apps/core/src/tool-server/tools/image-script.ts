import { env, errorCode } from "@stanley2058/lilac-utils";
import { serverToolFailure, type ServerToolFailure } from "@stanley2058/lilac-plugin-runtime";
import { Panic, Result, type Result as ResultType } from "better-result";
import { z } from "zod";
import { fileURLToPath } from "node:url";
import { captureError } from "../../shared/error-capture";
import { readSanitizedStreamTextCappedResult } from "../../tools/bash-output-sanitizer";
import { redactSecrets } from "../../tools/bash-safety/format";
import { preserveToolPanic } from "../../tools/tool-result-adapters";
import type { ServerToolCallOptions } from "../types";

const IMAGE_PROVIDER_DEFAULT_URLS = {
  openai: "https://api.openai.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
  xai: "https://api.x.ai/v1",
} as const;

type ImageProviderName = keyof typeof IMAGE_PROVIDER_DEFAULT_URLS;
type ImageProviders = Partial<Record<ImageProviderName, { baseURL: string; apiKey?: string }>>;

export function configuredImageProviders(): ImageProviders {
  const providers: ImageProviders = {};
  for (const name of Object.keys(IMAGE_PROVIDER_DEFAULT_URLS) as ImageProviderName[]) {
    const config = env.providers[name];
    const apiKey = config.apiKey?.trim();
    const baseURL = config.baseUrl?.trim();
    if (!apiKey && !baseURL) continue;
    providers[name] = {
      baseURL: (baseURL || IMAGE_PROVIDER_DEFAULT_URLS[name]).replace(/\/+$/u, ""),
      ...(apiKey ? { apiKey } : {}),
    };
  }
  return providers;
}

export function imageScriptDescription(providers = configuredImageProviders()): string {
  return (
    "Execute JavaScript with Bun for image generation/editing in the caller's cwd and container environment. " +
    "Read the image-generation skill for default models, request recipes, and upstream docs. " +
    "The global providers object supplies each configured provider's baseURL and optional apiKey. " +
    "Save images with Bun.write and print their paths. Returns stdout, stderr, exitCode, and truncated. " +
    `Configured providers: ${Object.keys(providers).join(", ") || "none"}. Configuration does not guarantee model access.`
  );
}

export const imageScriptInputSchema = z.strictObject({
  code: z
    .string()
    .min(1)
    .describe(
      "JavaScript source, with top-level await, standard imports, fetch, FormData, Bun, and the global providers object. Save images to files and print paths; keep credentials and base64 image bytes out of output.",
    ),
});

type ImageScriptOutput = {
  stdout: string;
  stderr: string;
  exitCode: number;
  truncated: boolean;
};

function scriptFailure(kind: ServerToolFailure["kind"], message: string): ServerToolFailure {
  return serverToolFailure({ kind, code: `image_script_${kind}`, message, retryable: false });
}

export async function runImageScript(
  input: z.infer<typeof imageScriptInputSchema>,
  opts?: ServerToolCallOptions,
): Promise<ResultType<ImageScriptOutput, ServerToolFailure>> {
  if (opts?.context?.safetyMode === "restricted") {
    return Result.err(
      scriptFailure("denied", "Image scripts require trusted container execution."),
    );
  }
  if (opts?.signal?.aborted) {
    return Result.err(scriptFailure("cancelled", "Image script cancelled before execution."));
  }

  const providers = configuredImageProviders();
  if (Object.keys(providers).length === 0) {
    return Result.err(scriptFailure("unavailable", "No image providers are configured."));
  }

  const literalSecrets = Object.values(providers).flatMap((provider) =>
    provider.apiKey ? [provider.apiKey] : [],
  );
  const timeout = AbortSignal.timeout(10 * 60 * 1000);
  const signal = opts?.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  const spawned = Result.try({
    try: () =>
      Bun.spawn(
        [
          process.execPath,
          "--no-env-file",
          "run",
          "--preload",
          fileURLToPath(new URL("./image-script-preload.ts", import.meta.url)),
          "-",
        ],
        {
          cwd: opts?.context?.cwd ?? process.cwd(),
          env: { ...process.env, LILAC_IMAGE_PROVIDERS: JSON.stringify(providers) },
          stdin: new Blob([input.code]),
          stdout: "pipe",
          stderr: "pipe",
          signal,
          killSignal: "SIGKILL",
          detached: true,
        },
      ),
    catch: captureError,
  });
  const spawnOutcome = spawned.match<
    { readonly child: Bun.Subprocess<Blob, "pipe", "pipe"> } | { readonly cause: Error }
  >({
    ok: (child) => ({ child }),
    err: ({ cause }) => ({ cause }),
  });
  if ("cause" in spawnOutcome) {
    if (Panic.is(spawnOutcome.cause)) return preserveToolPanic(spawnOutcome.cause);
    return Result.err(
      scriptFailure("unavailable", "Could not start the image script in the requested cwd."),
    );
  }
  const { child } = spawnOutcome;
  const terminationErrors: Error[] = [];
  const stopProcessGroup = () => {
    const stopped = Result.try({
      try: () => process.kill(-child.pid, "SIGKILL"),
      catch: captureError,
    });
    if (stopped.isErr()) {
      if (errorCode(stopped.error.cause) !== "ESRCH") terminationErrors.push(stopped.error.cause);
    }
  };
  signal.addEventListener("abort", stopProcessGroup, { once: true });
  if (signal.aborted) stopProcessGroup();
  const exited = child.exited.then((exitCode) => {
    // Descendants can retain output pipes after the script exits.
    stopProcessGroup();
    return exitCode;
  });
  const settled = await Result.tryPromise({
    try: () =>
      Promise.all([
        readSanitizedStreamTextCappedResult(child.stdout, 40 * 1024, { literalSecrets }),
        readSanitizedStreamTextCappedResult(child.stderr, 40 * 1024, { literalSecrets }),
        exited,
      ]),
    catch: captureError,
  });
  signal.removeEventListener("abort", stopProcessGroup);
  if (settled.isErr()) {
    stopProcessGroup();
    await Promise.allSettled([exited]);
    if (Panic.is(settled.error.cause)) return preserveToolPanic(settled.error.cause);
    return Result.err(scriptFailure("unavailable", "Could not collect image script output."));
  }

  for (const error of terminationErrors) {
    if (Panic.is(error)) return preserveToolPanic(error);
  }
  if (terminationErrors.length > 0) {
    return Result.err(scriptFailure("unavailable", "Could not terminate image script processes."));
  }

  const [stdout, stderr, exitCode] = settled.value;
  if (opts?.signal?.aborted) {
    return Result.err(scriptFailure("cancelled", "Image script cancelled."));
  }
  if (timeout.aborted) {
    return Result.err(
      scriptFailure("timeout", "Image script exceeded its 10-minute execution limit."),
    );
  }
  return Result.all([stdout, stderr])
    .mapError(() => scriptFailure("unavailable", "Could not read image script output."))
    .map(([out, err]) => ({
      stdout: redactSecrets(out.text, literalSecrets),
      stderr: redactSecrets(err.text, literalSecrets),
      exitCode,
      truncated: out.capped || err.capped,
    }));
}
