import { Result, TaggedError, type Result as ResultType } from "better-result";

import { isRecord } from "../runtime-utils";
import { parseModelSpecifierResult } from "../model-capability";
import { validateConfiguredModelProviderOptions } from "../model-provider-option-validation";
import { decodeCoreConfigV1ToUniversal, CoreConfigV1Invalid } from "./v1";
import {
  CURRENT_CORE_CONFIG_VERSION,
  DEFAULT_CORE_CONFIG_VERSION,
  SUPPORTED_CORE_CONFIG_VERSIONS,
  decodeCoreConfigV2ToUniversal,
  CoreConfigV2Invalid,
} from "./v2";
import type {
  CoreConfig,
  CoreConfigModelOptionWarning,
  CoreConfigParseOptions,
  CoreConfigVersion,
  JSONObject,
} from "./types";

export class CoreConfigVersionInvalid extends TaggedError("CoreConfigVersionInvalid")<{
  readonly version: string;
  readonly message: string;
}> {}

export class CoreConfigMustBeObject extends TaggedError("CoreConfigMustBeObject")<{
  readonly message: string;
}> {}

export function readCoreConfigVersionResult(
  raw: unknown,
): ResultType<CoreConfigVersion, CoreConfigVersionInvalid> {
  if (!isRecord(raw)) return Result.ok(DEFAULT_CORE_CONFIG_VERSION);

  const version = raw.configVersion;
  if (version === undefined || version === null) return Result.ok(DEFAULT_CORE_CONFIG_VERSION);
  if (version === 1 || version === CURRENT_CORE_CONFIG_VERSION) return Result.ok(version);
  const versionDescription =
    typeof version === "string" ||
    typeof version === "number" ||
    typeof version === "boolean" ||
    typeof version === "bigint"
      ? String(version)
      : "<non-scalar>";
  return Result.err(
    new CoreConfigVersionInvalid({
      version: versionDescription,
      message: `Unsupported core config version: ${versionDescription} (supported: ${SUPPORTED_CORE_CONFIG_VERSIONS.join(", ")})`,
    }),
  );
}

function reportConfiguredModelOptionWarnings(
  cfg: CoreConfig,
  report: (warning: CoreConfigModelOptionWarning, source: string) => void,
): void {
  const validate = (model: string, options: JSONObject | undefined, source: string) => {
    if (!options) return;
    const modelSpec = model.includes("/") ? model : cfg.models.def[model]?.model;
    if (!modelSpec?.includes("/")) return;

    const parsedModel = parseModelSpecifierResult(modelSpec);
    const provider = parsedModel.match({
      ok: (value) => value.provider,
      err: () => undefined,
    });
    if (provider === undefined) return;
    for (const warning of validateConfiguredModelProviderOptions(provider, options)) {
      report(warning, source);
    }
  };

  for (const [alias, preset] of Object.entries(cfg.models.def)) {
    validate(preset.model, preset.options, `models.def.${alias}.options`);
    for (const [index, fallback] of (preset.fallback ?? []).entries()) {
      if (typeof fallback !== "string") {
        validate(
          fallback.model,
          fallback.options,
          `models.def.${alias}.fallback[${index}].options`,
        );
      }
    }
  }
  validate(cfg.models.main.model, cfg.models.main.options, "models.main.options");
  validate(cfg.models.fast.model, cfg.models.fast.options, "models.fast.options");
  for (const slot of ["main", "fast"] as const) {
    for (const [index, fallback] of (cfg.models[slot].fallback ?? []).entries()) {
      if (typeof fallback !== "string") {
        validate(fallback.model, fallback.options, `models.${slot}.fallback[${index}].options`);
      }
    }
  }
}

export function parseCoreConfigResult(
  raw: unknown,
  options?: CoreConfigParseOptions,
): ResultType<
  CoreConfig,
  CoreConfigVersionInvalid | CoreConfigMustBeObject | CoreConfigV1Invalid | CoreConfigV2Invalid
> {
  const version = readCoreConfigVersionResult(raw);
  const parsedVersion = version.match<CoreConfigVersion | CoreConfigVersionInvalid>({
    ok: (value) => value,
    err: (error) => error,
  });
  if (CoreConfigVersionInvalid.is(parsedVersion)) return Result.err(parsedVersion);
  if (!isRecord(raw)) {
    return Result.err(new CoreConfigMustBeObject({ message: "Core config must be an object" }));
  }

  const onUnknownKey = options?.onUnknownKey;

  const parsed =
    parsedVersion === 1
      ? decodeCoreConfigV1ToUniversal(raw, { onUnknownKey })
      : decodeCoreConfigV2ToUniversal(raw, { onUnknownKey });
  const cfg = Result.match<
    CoreConfig,
    CoreConfigV1Invalid | CoreConfigV2Invalid,
    CoreConfig | CoreConfigV1Invalid | CoreConfigV2Invalid
  >(parsed, {
    ok: (value) => value,
    err: (error) => error,
  });
  if (CoreConfigV1Invalid.is(cfg) || CoreConfigV2Invalid.is(cfg)) return Result.err(cfg);
  if (options?.onUnknownModelOption) {
    reportConfiguredModelOptionWarnings(cfg, options.onUnknownModelOption);
  }
  return Result.ok(cfg);
}
