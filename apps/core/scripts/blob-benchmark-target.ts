import path from "node:path";

import {
  createLocalBlobStore,
  createS3BlobStore,
  type BlobStore,
  type BlobStoreCreateError,
  type S3BlobStoreOptions,
} from "@stanley2058/lilac-blob-storage";
import {
  decodeCoreConfigYaml,
  parseCoreConfigResult,
  type CoreConfig,
} from "@stanley2058/lilac-utils";
import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";

import { preserveToolPanic } from "../src/tools/tool-result-adapters";

export type BlobBenchmarkTarget =
  | {
      readonly kind: "local";
      readonly root: string;
    }
  | {
      readonly kind: "s3";
      readonly bucket: string;
      readonly prefix: string;
      readonly endpoint: string;
      readonly region: string;
      readonly accessKeyId: string;
      readonly secretAccessKey: string;
      readonly sessionToken?: string;
      readonly forcePathStyle: boolean;
    };

export type LoadedBlobBenchmarkTarget = {
  readonly coreConfig: CoreConfig;
  readonly target: BlobBenchmarkTarget;
};

export class BlobBenchmarkConfigReadFailed extends TaggedError("BlobBenchmarkConfigReadFailed")<{
  readonly configPath: string;
  readonly message: string;
}> {}

export class BlobBenchmarkConfigInvalid extends TaggedError("BlobBenchmarkConfigInvalid")<{
  readonly configPath: string;
  readonly message: string;
}> {}

export class BlobBenchmarkCredentialMissing extends TaggedError("BlobBenchmarkCredentialMissing")<{
  readonly environmentVariable: string;
  readonly message: string;
}> {}

export type BlobBenchmarkTargetConfigError =
  | BlobBenchmarkConfigReadFailed
  | BlobBenchmarkConfigInvalid
  | BlobBenchmarkCredentialMissing;

export type BlobBenchmarkTargetDependencies = {
  readonly readConfigText?: (configPath: string) => Promise<string>;
  readonly environment?: Readonly<Record<string, string | undefined>>;
};

type CapturedConfigReadFailure =
  | { readonly kind: "panic"; readonly panic: Panic }
  | { readonly kind: "ordinary" };
type ConfigReadFailureSettlement = () => CapturedConfigReadFailure;

function configInvalid(configPath: string, message: string): BlobBenchmarkConfigInvalid {
  return new BlobBenchmarkConfigInvalid({ configPath, message });
}

function captureConfigReadFailure(cause: unknown): ConfigReadFailureSettlement {
  return () => {
    const inspected = Result.try({
      try: (): Panic | undefined => (Panic.is(cause) ? cause : undefined),
      catch: () => undefined,
    });
    const panic = inspected.match({ ok: (value) => value, err: () => undefined });
    return panic === undefined ? { kind: "ordinary" } : { kind: "panic", panic };
  };
}

function decodeCoreConfig(raw: unknown): ReturnType<typeof parseCoreConfigResult> {
  return parseCoreConfigResult(raw);
}

function requiredEnvironmentValue(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): ResultType<string, BlobBenchmarkCredentialMissing> {
  const value = environment[name];
  if (value !== undefined && value.length > 0) return Result.ok(value);
  return Result.err(
    new BlobBenchmarkCredentialMissing({
      environmentVariable: name,
      message: `Blob storage credential environment variable ${name} is not set`,
    }),
  );
}

function resolveBlobBenchmarkTarget(
  coreConfig: CoreConfig,
  dataDir: string,
  environment: Readonly<Record<string, string | undefined>>,
): ResultType<BlobBenchmarkTarget, BlobBenchmarkCredentialMissing> {
  const configured = coreConfig.blobStorage;
  if (configured.kind === "local") {
    return Result.ok({
      kind: "local",
      root: configured.root ?? path.resolve(dataDir, "blobs"),
    });
  }

  return Result.gen(function* () {
    const accessKeyId = yield* requiredEnvironmentValue(environment, configured.accessKeyIdEnv);
    const secretAccessKey = yield* requiredEnvironmentValue(
      environment,
      configured.secretAccessKeyEnv,
    );
    const sessionToken = configured.sessionTokenEnv
      ? yield* requiredEnvironmentValue(environment, configured.sessionTokenEnv)
      : undefined;
    return Result.ok({
      kind: "s3" as const,
      bucket: configured.bucket,
      prefix: configured.prefix,
      endpoint: configured.endpoint,
      region: configured.region,
      accessKeyId,
      secretAccessKey,
      ...(sessionToken === undefined ? {} : { sessionToken }),
      forcePathStyle: configured.forcePathStyle,
    });
  });
}

export async function loadBlobBenchmarkTargetConfig(
  input: {
    readonly configPath: string;
    readonly dataDir: string;
  },
  dependencies: BlobBenchmarkTargetDependencies = {},
): Promise<ResultType<LoadedBlobBenchmarkTarget, BlobBenchmarkTargetConfigError>> {
  const readConfigText =
    dependencies.readConfigText ?? ((configPath: string) => Bun.file(configPath).text());
  const environment = dependencies.environment ?? process.env;
  const captured = await Result.tryPromise<string, ConfigReadFailureSettlement>({
    try: () => readConfigText(input.configPath),
    catch: captureConfigReadFailure,
  });
  const settled = captured.mapError((settle) => settle());
  const source = settled.match<() => ResultType<string, BlobBenchmarkConfigReadFailed>>({
    ok: (value) => () => Result.ok(value),
    err: (failure) => () => {
      if (failure.kind === "panic") preserveToolPanic(failure.panic);
      return Result.err(
        new BlobBenchmarkConfigReadFailed({
          configPath: input.configPath,
          message: `Failed to read Core config from ${input.configPath}`,
        }),
      );
    },
  })();

  return source
    .andThen((text) =>
      decodeCoreConfigYaml(text)
        .andThen(decodeCoreConfig)
        .mapError((error) => configInvalid(input.configPath, error.message)),
    )
    .andThen((coreConfig) =>
      resolveBlobBenchmarkTarget(coreConfig, input.dataDir, environment).map((target) => ({
        coreConfig,
        target,
      })),
    );
}

function s3StoreOptions(
  target: Extract<BlobBenchmarkTarget, { readonly kind: "s3" }>,
): S3BlobStoreOptions {
  return {
    bucket: target.bucket,
    prefix: target.prefix,
    endpoint: target.endpoint,
    region: target.region,
    accessKeyId: target.accessKeyId,
    secretAccessKey: target.secretAccessKey,
    sessionToken: target.sessionToken,
    forcePathStyle: target.forcePathStyle,
  };
}

export function createBlobBenchmarkTargetStore(
  target: BlobBenchmarkTarget,
): Promise<ResultType<BlobStore, BlobStoreCreateError>> {
  if (target.kind === "local") return createLocalBlobStore({ root: target.root });
  return createS3BlobStore(s3StoreOptions(target));
}
