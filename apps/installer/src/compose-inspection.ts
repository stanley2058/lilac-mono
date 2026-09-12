import path from "node:path";
import { Result } from "better-result";
import { parseDocument, type Document } from "yaml";
import { z } from "zod";
import { composeArguments, InstallerDeploymentFailed } from "./deployment";
import { command } from "./system";

const serviceSchema = z.object({
  image: z.string().optional(),
  build: z.object({ context: z.string().optional() }).optional(),
  environment: z.record(z.string(), z.string().nullable()).default({}),
  volumes: z
    .array(
      z.object({
        type: z.string(),
        source: z.string().optional(),
        target: z.string(),
        read_only: z.boolean().optional(),
      }),
    )
    .default([]),
  tmpfs: z.array(z.string()).default([]),
  volumes_from: z.array(z.string()).default([]),
  network_mode: z.string().optional(),
  networks: z.record(z.string(), z.object({}).nullable()).default({}),
  user: z.string().optional(),
});

const deploymentSchema = z.object({
  services: z.object({
    lilac: serviceSchema,
    "computer-use-gateway": serviceSchema.optional(),
  }),
});

export type ResolvedDeployment = z.infer<typeof deploymentSchema>;
export type ExistingDeployment = { document: Document; resolved: ResolvedDeployment };

export async function inspectDeployment(
  root: string,
  document: Document,
  run: typeof command = command,
): Promise<Result<ResolvedDeployment, InstallerDeploymentFailed>> {
  const sourceServiceSchema = z.object({
    extends: z.unknown().transform((value) => value !== undefined),
  });
  const serviceNamesSchema = z.array(z.string().regex(/^[a-zA-Z0-9._-]+$/)).min(1);
  const sourceDeploymentSchema = z.object({
    services: z.object({
      lilac: sourceServiceSchema,
      "computer-use-gateway": sourceServiceSchema.optional(),
    }),
  });
  const failed = () =>
    new InstallerDeploymentFailed({
      message:
        "Could not inspect the existing Compose deployment. Check compose.yaml and its referenced files, then rerun setup. Installation files were not changed.",
    });
  const notEditable = () =>
    new InstallerDeploymentFailed({
      message:
        "Guided setup requires standalone managed service definitions in compose.yaml. Replace Compose extends/include for Lilac and the computer-use gateway, or manage this deployment manually. Installation files were not changed.",
    });
  return Result.gen(async function* () {
    const compose = yield* composeArguments(root, document);
    const metadata = yield* Result.await(
      run([...compose, "--profile", "*", "config", "--services"], { cwd: root }).then((result) =>
        result.mapError(failed),
      ),
    );
    if (metadata.code !== 0) return Result.err(failed());
    const names = serviceNamesSchema.safeParse(metadata.stdout.trim().split(/\r?\n/));
    if (!names.success || !names.data.includes("lilac")) return Result.err(failed());
    const hasGateway = names.data.includes("computer-use-gateway");
    const authored = yield* Result.try({
      try: (): unknown =>
        parseDocument(document.toString(), { merge: true }).toJS({ maxAliasCount: 100 }),
      catch: notEditable,
    });
    const source = sourceDeploymentSchema.safeParse(authored);
    if (!source.success) return Result.err(notEditable());
    if (
      source.data.services.lilac.extends ||
      source.data.services["computer-use-gateway"]?.extends ||
      (hasGateway && source.data.services["computer-use-gateway"] === undefined)
    )
      return Result.err(notEditable());
    const services = hasGateway ? ["lilac", "computer-use-gateway"] : ["lilac"];
    const inspected = yield* Result.await(
      run([...compose, "--profile", "", "config", "--format", "json", ...services], {
        cwd: root,
      }).then((result) => result.mapError(failed)),
    );
    if (inspected.code !== 0) return Result.err(failed());
    const decoded = yield* Result.try({
      try: (): unknown => JSON.parse(inspected.stdout.replaceAll("$$", () => "$")),
      catch: failed,
    });
    const parsed = deploymentSchema.safeParse(decoded);
    if (!parsed.success) return Result.err(failed());
    if (hasGateway !== (parsed.data.services["computer-use-gateway"] !== undefined))
      return Result.err(failed());
    yield* validateManagedLayout(root, parsed.data);
    return Result.ok(parsed.data);
  });
}

export function validateManagedLayout(
  root: string,
  resolved: ResolvedDeployment,
): Result<void, InstallerDeploymentFailed> {
  const core = resolved.services.lilac;
  const dataDir = core.environment.DATA_DIR ?? "/data";
  if (!path.posix.isAbsolute(dataDir) || path.posix.resolve(dataDir) !== "/data")
    return Result.err(
      new InstallerDeploymentFailed({
        message:
          "Guided setup requires Core DATA_DIR to resolve to /data. Restore that setting before rerunning setup.",
      }),
    );
  const dataMounts = core.volumes.filter(
    (volume) =>
      path.posix.isAbsolute(volume.target) && path.posix.resolve(volume.target) === "/data",
  );
  const mount = dataMounts[0];
  if (
    dataMounts.length !== 1 ||
    mount?.type !== "bind" ||
    mount.source === undefined ||
    !path.isAbsolute(mount.source) ||
    path.resolve(mount.source) !== path.resolve(root, "data") ||
    mount.read_only === true
  )
    return Result.err(
      new InstallerDeploymentFailed({
        message:
          "Guided setup requires one writable bind mount from this installation's data directory to /data. Restore that mount before rerunning setup.",
      }),
    );
  if (
    core.volumes.some(
      (volume) =>
        path.posix.isAbsolute(volume.target) &&
        path.posix.resolve(volume.target).startsWith("/data/"),
    )
  )
    return Result.err(
      new InstallerDeploymentFailed({
        message:
          "Guided setup cannot update Core data beneath additional mounts inside /data. Remove those mounts before rerunning setup.",
      }),
    );
  if (
    core.tmpfs.some((entry) => {
      const target = path.posix.normalize(entry.split(":", 1)[0] ?? "");
      return target === "/data" || target.startsWith("/data/");
    })
  )
    return Result.err(
      new InstallerDeploymentFailed({
        message:
          "Guided setup cannot use tmpfs mounts at or inside /data. Remove those mounts before rerunning setup.",
      }),
    );
  if (core.volumes_from.length > 0)
    return Result.err(
      new InstallerDeploymentFailed({
        message:
          "Guided setup cannot verify Core data with volumes_from. Replace it with the managed /data bind mount before rerunning setup.",
      }),
    );
  if (core.user !== undefined && !/^(?:1000|lilac)(?::.*)?$/.test(core.user))
    return Result.err(
      new InstallerDeploymentFailed({
        message:
          "Guided setup requires Core to run as UID 1000 or user lilac. Remove the Core user override or set it to 1000, then rerun setup.",
      }),
    );
  return Result.ok(undefined);
}
