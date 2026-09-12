import path from "node:path";
import { Result } from "better-result";
import { parseDocument, type Document } from "yaml";
import { z } from "zod";
import { composeArguments, InstallerDeploymentFailed, readEnvironment } from "./deployment";
import { command } from "./system";

const environmentFileSchema = z.union([
  z.string(),
  z.object({ path: z.string(), format: z.string().optional() }),
]);
const serviceFilesSchema = z.object({
  env_file: z.union([environmentFileSchema, z.array(environmentFileSchema)]).optional(),
});
const deploymentFilesSchema = z.object({
  services: z.object({
    lilac: serviceFilesSchema,
    "computer-use-gateway": serviceFilesSchema.optional(),
  }),
});
const serviceEnvironmentSchema = z.object({
  environment: z.record(z.string(), z.string().nullable()).optional(),
});
const resolvedEnvironmentSchema = z.object({
  services: z.object({
    lilac: serviceEnvironmentSchema,
    "computer-use-gateway": serviceEnvironmentSchema.optional(),
  }),
});

type SetupEnvironment = {
  secrets: Record<string, string>;
  preservedEnvironmentSource?: string;
};

export async function readSetupEnvironment(
  root: string,
  existing?: Document,
  source?: string,
  run: typeof command = command,
): Promise<Result<SetupEnvironment, InstallerDeploymentFailed>> {
  if (!existing) return Result.ok({ secrets: readEnvironment(source ?? "") });
  const failed = () =>
    new InstallerDeploymentFailed({
      message:
        "Could not read the existing Compose environment. Check compose.yaml and its env_file entries, then rerun setup. Installation files were not changed.",
    });
  return Result.gen(async function* () {
    const projection = yield* Result.try({
      try: (): unknown =>
        parseDocument(existing.toString(), { merge: true }).toJS({ maxAliasCount: 100 }),
      catch: failed,
    });
    const parsed = deploymentFilesSchema.safeParse(projection);
    if (!parsed.success) return Result.err(failed());
    const files = Object.values(parsed.data.services).flatMap((service) => {
      const entries = service?.env_file;
      if (entries === undefined) return [];
      return Array.isArray(entries) ? entries : [entries];
    });
    const managedFiles = files.filter((file) => {
      const filename = typeof file === "string" ? file : file.path;
      return path.resolve(root, filename) === path.resolve(root, "secrets.env");
    });
    const hasInterpolatedPath = files.some((file) =>
      (typeof file === "string" ? file : file.path).includes("$"),
    );
    const canRewriteRaw =
      !hasInterpolatedPath &&
      managedFiles.length > 0 &&
      managedFiles.every((file) => typeof file !== "string" && file.format === "raw");
    if (canRewriteRaw || (source === undefined && files.length === 0))
      return Result.ok({ secrets: readEnvironment(source ?? "") });
    const compose = yield* composeArguments(root, existing);
    const services = parsed.data.services["computer-use-gateway"]
      ? ["lilac", "computer-use-gateway"]
      : ["lilac"];
    const resolved = yield* Result.await(
      run([...compose, "config", "--format", "json", ...services], { cwd: root }).then((result) =>
        result.mapError(failed),
      ),
    );
    if (resolved.code !== 0) return Result.err(failed());
    const json = yield* Result.try({
      try: (): unknown => JSON.parse(resolved.stdout),
      catch: failed,
    });
    const environment = resolvedEnvironmentSchema.safeParse(json);
    if (!environment.success) return Result.err(failed());
    const gateway = environment.data.services["computer-use-gateway"]?.environment;
    const values = { ...gateway, ...environment.data.services.lilac.environment };
    for (const key of [
      "MCP_BEARER_SECRET",
      "BIND_ADDR",
      "RENDERED_HOST",
      "PORT_RANGE_START",
      "PORT_RANGE_END",
    ]) {
      if (gateway?.[key] !== undefined) values[key] = gateway[key];
    }
    const secrets: Record<string, string> = {};
    for (const [key, value] of Object.entries(values)) {
      // Compose config doubles dollars so its output can be used as another Compose file.
      if (value !== null) secrets[key] = value.replaceAll("$$", () => "$");
    }
    return Result.ok({ secrets, preservedEnvironmentSource: source ?? "" });
  });
}
