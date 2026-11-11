import { tool } from "ai";
import {
  modelCatalogCache,
  projectModelCatalog,
  configuredCatalogProviders,
} from "@stanley2058/lilac-utils";
import { modelRuleDefaults } from "@stanley2058/lilac-utils/model-rules";
import { captureError } from "../../shared/error-capture.js";
import type { ServerTool } from "@stanley2058/lilac-plugin-runtime";
import {
  LEVEL1_TOOL_NAMES,
  type ApplyPatchInput,
  type Level1ToolName,
} from "@stanley2058/lilac-coding-tools/schemas";
import { expandTilde } from "@stanley2058/lilac-fs";
import {
  errorCode,
  opaqueErrorMessage,
  resolveSubagentPermissionProfile,
} from "@stanley2058/lilac-utils";
import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { parseSshCwdTarget } from "../../ssh/ssh-cwd";
import { applyPatchTool } from "../../tools/apply-patch";
import { parsePatchResult } from "../../tools/apply-patch/apply-patch-core";
import { bashToolWithCwd } from "../../tools/bash";
import { fsTool } from "../../tools/fs/fs";
import { readRemoteMedia } from "../../tools/fs/remote-media-download";
import {
  subagentTools,
  type SubagentDelegationHandle,
  type SubagentDelegationRegistration,
} from "../../tools/subagent";
import {
  summarizeApplyPatchFailure,
  summarizeBashFailure,
  summarizeReadOrEditFailure,
  summarizeSearchFailure,
  summarizeSubagentFailure,
} from "../../surface/bridge/bus-agent-runner/tool-failure-logging";
import {
  formatApplyPatchToolArgs,
  formatBashToolArgs,
  formatEditFileToolArgs,
  formatFuzzySearchToolArgs,
  formatGlobToolArgs,
  formatGrepToolArgs,
  formatReadFileToolArgs,
  formatSubagentDelegateToolArgs,
} from "../../tools/tool-args-display";
import { defineLevel1Tool } from "./define-level1-tool";
import { type CoreLevel1ToolSpec, type CoreToolPlugin } from "../types";
import { isWebFetchAllowedForNativeProfile } from "../profile-authority";

type CoreToolBuildContext = Parameters<CoreLevel1ToolSpec["createTool"]>[0];

const localFsToolsByBuildContext = new WeakMap<CoreToolBuildContext, ReturnType<typeof fsTool>>();

type DelegateHandler = (
  registration: SubagentDelegationRegistration,
) => Promise<SubagentDelegationHandle>;
type AgentActivityHandler = (source: "tool" | "subagent") => void;

function isDelegateHandler(value: unknown): value is DelegateHandler {
  return typeof value === "function";
}

function isAgentActivityHandler(value: unknown): value is AgentActivityHandler {
  return typeof value === "function";
}

const coreToolRequestMetadataSchema = z
  .object({
    readFileDirectAttachmentSupported: z.boolean().optional(),
    readFileDirectImageSupported: z.boolean().optional(),
    readFileDirectPdfSupported: z.boolean().optional(),
    controlCapability: z.string().optional(),
    onSubagentDelegate: z.custom<DelegateHandler>(isDelegateHandler).optional(),
    onActivity: z.custom<AgentActivityHandler>(isAgentActivityHandler).optional(),
  })
  .loose();

export function decodeCoreToolRequestMetadata(
  metadata: Readonly<Record<string, unknown>> | undefined,
): z.output<typeof coreToolRequestMetadataSchema> {
  const decoded = coreToolRequestMetadataSchema.safeParse(metadata ?? {});
  return decoded.success ? decoded.data : {};
}

function getReadFileDirectMediaSupport(context: CoreToolBuildContext): {
  readonly image: boolean;
  readonly pdf: boolean;
} {
  const metadata = decodeCoreToolRequestMetadata(context.requestContext?.metadata);
  const legacy = metadata.readFileDirectAttachmentSupported === true;
  return {
    image: metadata.readFileDirectImageSupported ?? legacy,
    pdf: metadata.readFileDirectPdfSupported ?? legacy,
  };
}

function canReadRemoteMedia(context: CoreToolBuildContext): boolean {
  const config = context.runtime.config;
  if (!config || config.plugins.disabled.includes("web")) return false;
  if (context.runProfile === "primary") return true;
  return isWebFetchAllowedForNativeProfile({ config, profileName: context.runProfile });
}

function getFsTools(context: CoreToolBuildContext): ReturnType<typeof fsTool> {
  const cached = localFsToolsByBuildContext.get(context);
  if (cached) return cached;

  const directMediaSupport = getReadFileDirectMediaSupport(context);
  const tools = fsTool(context.cwd, {
    includeEditFile: true,
    experimentalHashlineEdit:
      context.editingToolMode === "edit_file" &&
      context.runtime.config?.tools.editFile.hashline === true,
    fsBackend: context.runtime.config?.tools.fsBackend,
    readFileDirectImageSupported: directMediaSupport.image,
    readFileDirectPdfSupported: directMediaSupport.pdf,
    readRemoteMedia: canReadRemoteMedia(context) ? readRemoteMedia : undefined,
    maxOutputBytes: context.runtime.config?.tools.output.maxPreviewBytes,
    maxInlineMediaBytesPerPart: context.runtime.config?.tools.media.maxInlineBytesPerPart,
    artifactOnly: context.requestContext?.safetyMode === "restricted",
    toolResultArtifacts: context.runtime.toolResultArtifacts,
    resourceAccess: context.runtime.resourceAccessForContext
      ? context.runtime.resourceAccessForContext(
          context.requestContext
            ? {
                requestId: context.requestContext.requestId,
                requestDeliveryId: context.requestContext.requestDeliveryId,
                sessionId: context.requestContext.sessionId,
                requestClient: context.requestContext.requestClient,
                serverOwnedRequest: context.requestContext.serverOwnedRequest,
                requestInitiator: context.requestContext.requestInitiator,
                requestInitiatorSessionId: context.requestContext.requestInitiatorSessionId,
                safetyMode: context.requestContext.safetyMode,
                cwd: context.cwd,
              }
            : undefined,
        )
      : context.runtime.resourceAccess,
    requestContext: context.requestContext
      ? {
          requestId: context.requestContext.requestId,
          sessionId: context.requestContext.sessionId,
        }
      : undefined,
    loadInstructions: true,
  });
  localFsToolsByBuildContext.set(context, tools);
  return tools;
}

function getFsReadOnlyTool(
  name: "read" | "glob" | "grep" | "fuzzy_search",
  context: CoreToolBuildContext,
): unknown {
  const tools = getFsTools(context);
  return tools[name];
}

function getEditFileTool(context: CoreToolBuildContext): unknown {
  return (getFsTools(context) as ReturnType<typeof fsTool> & { readonly edit?: unknown }).edit;
}

function isPathWithin(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

class LocalApplyPatchGuardFailed extends TaggedError("LocalApplyPatchGuardFailed")<{
  readonly code?: string;
  readonly cause?: unknown;
  readonly message: string;
}> {}

async function captureLocalApplyPatchFs<T>(
  run: () => Promise<T>,
): Promise<ResultType<T, LocalApplyPatchGuardFailed>> {
  const captured = (
    await Result.tryPromise({
      try: run,
      catch: captureError,
    })
  ).match<
    | { readonly kind: "success"; readonly value: T }
    | { readonly kind: "failure"; readonly failure: Error }
  >({
    ok: (value) => ({ kind: "success", value }),
    err: ({ cause }) => ({ kind: "failure", failure: cause }),
  });
  if (captured.kind === "success") return Result.ok(captured.value);
  const cause = captured.failure;
  if (Panic.is(cause)) throw cause;
  return Result.err(
    new LocalApplyPatchGuardFailed({
      ...(errorCode(cause) === undefined ? {} : { code: errorCode(cause) }),
      cause,
      message: opaqueErrorMessage(cause, "Local patch filesystem operation failed"),
    }),
  );
}

async function canonicalizeAsFarAsExists(
  inputPath: string,
): Promise<ResultType<string, LocalApplyPatchGuardFailed>> {
  let current = path.resolve(inputPath);
  const missingSegments: string[] = [];
  const followedSymlinks = new Set<string>();
  let symlinkHops = 0;

  const resolveCurrent = async (): Promise<ResultType<string, LocalApplyPatchGuardFailed>> => {
    const canonical = await captureLocalApplyPatchFs(() => fs.realpath(current));
    return canonical.match({
      ok: (value) => async () => Result.ok(path.resolve(value, ...missingSegments)),
      err: (error) => async () => {
        if (error.code !== "ENOENT" && error.code !== "ENOTDIR") return Result.err(error);

        const stats = (await captureLocalApplyPatchFs(() => fs.lstat(current))).match({
          ok: (value) => value,
          err: () => undefined,
        });
        if (stats?.isSymbolicLink()) {
          if (followedSymlinks.has(current) || ++symlinkHops > 40) {
            return Result.err(
              new LocalApplyPatchGuardFailed({
                message: `Too many symbolic links resolving '${inputPath}'`,
              }),
            );
          }
          followedSymlinks.add(current);
          const target = await captureLocalApplyPatchFs(() => fs.readlink(current));
          return target.match({
            err: (error) => async () => Result.err(error),
            ok: (value) => async () => {
              current = path.isAbsolute(value)
                ? path.resolve(value)
                : path.resolve(path.dirname(current), value);
              return resolveCurrent();
            },
          })();
        }

        const parent = path.dirname(current);
        if (parent === current) return Result.ok(path.resolve(current, ...missingSegments));
        missingSegments.unshift(path.basename(current));
        current = parent;
        return resolveCurrent();
      },
    })();
  };

  return resolveCurrent();
}

async function assertLocalApplyPatchPathsAllowed(params: {
  input: ApplyPatchInput;
  defaultCwd: string;
  denyPath: string;
}): Promise<ResultType<void, Error>> {
  const cwdTarget = parseSshCwdTarget(params.input.cwd ?? params.defaultCwd);
  if (cwdTarget.kind !== "local") return Result.ok(undefined);

  const baseDir = path.resolve(expandTilde(cwdTarget.cwd || params.defaultCwd));
  const denyResolved = path.resolve(expandTilde(params.denyPath));
  const denyCanonicalResult = await captureLocalApplyPatchFs(() => fs.realpath(denyResolved));
  const denyCanonical = denyCanonicalResult.match({
    ok: (value) => value,
    err: () => denyResolved,
  });
  const parsed = parsePatchResult(params.input.patchText);
  const continueParsed = parsed.match<() => Promise<ResultType<void, Error>>>({
    err: (error) => async () => Result.err(error),
    ok: (hunks) => async () => {
      const targets = hunks.flatMap((hunk) => [
        hunk.path,
        ...(hunk.type === "update" && hunk.movePath ? [hunk.movePath] : []),
      ]);
      // This closes lexical and symlink aliases but cannot prevent another process racing resolution.
      const checkAt = async (index: number): Promise<ResultType<void, Error>> => {
        const target = targets[index];
        if (!target) return Result.ok(undefined);
        const resolved = path.isAbsolute(target)
          ? path.resolve(target)
          : path.resolve(baseDir, target);
        const canonical = await canonicalizeAsFarAsExists(resolved);
        const continueCanonical = canonical.match<() => Promise<ResultType<void, Error>>>({
          err: (error) => async () => Result.err(error),
          ok: (canonicalPath) => async () => {
            if (
              isPathWithin(resolved, denyResolved) ||
              isPathWithin(resolved, denyCanonical) ||
              isPathWithin(canonicalPath, denyResolved) ||
              isPathWithin(canonicalPath, denyCanonical)
            ) {
              return Result.err(
                new LocalApplyPatchGuardFailed({
                  message: `Access denied: '${resolved}' is blocked for patch`,
                }),
              );
            }
            return await checkAt(index + 1);
          },
        });
        return await continueCanonical();
      };
      return await checkAt(0);
    },
  });
  return await continueParsed();
}

function signalBuiltinToolHostError(message: string): never {
  throw new Error(message);
}

function getApplyPatchTool(context: CoreToolBuildContext) {
  const denyPath = context.runtime.dataDir
    ? path.join(context.runtime.dataDir, "secret")
    : undefined;
  const guarded = applyPatchTool({
    cwd: context.cwd,
    denyPaths: denyPath ? [denyPath] : undefined,
  }).apply_patch;
  if (!denyPath) return guarded;

  const unrestricted = applyPatchTool({ cwd: context.cwd }).apply_patch;
  const guardedExecute = guarded.execute;
  const unrestrictedExecute = unrestricted.execute;
  if (!guardedExecute || !unrestrictedExecute) return guarded;

  return {
    ...guarded,
    description: `${guarded.description} Local denylist checks are best-effort guardrails, not filesystem isolation.`,
    execute: async (...args: Parameters<typeof guardedExecute>) => {
      const [input] = args;
      if (input.dangerouslyAllow === true) return unrestrictedExecute(...args);

      const allowed = await assertLocalApplyPatchPathsAllowed({
        input,
        defaultCwd: context.cwd,
        denyPath,
      });
      return allowed.match({
        err: (error) => async () => ({
          status: "failed" as const,
          output: error.message,
        }),
        ok: () => async () => guardedExecute(...args),
      })();
    },
  };
}

function getDelegateHandler(requestContext: {
  metadata?: Readonly<Record<string, unknown>>;
}): DelegateHandler | undefined {
  return decodeCoreToolRequestMetadata(requestContext.metadata).onSubagentDelegate;
}

function getAgentActivityHandler(requestContext: {
  metadata?: Readonly<Record<string, unknown>>;
}): AgentActivityHandler | undefined {
  return decodeCoreToolRequestMetadata(requestContext.metadata).onActivity;
}

export const BUILTIN_LEVEL1_TOOLS = {
  bash: defineLevel1Tool("bounded", {
    name: "bash",
    isEnabled: () => true,
    formatArgs: formatBashToolArgs,
    summarizeFailure: ({ result }) => summarizeBashFailure(result),
    createTool: (context) => {
      const { cwd, runtime, requestContext, runProfile } = context;
      const onActivity = requestContext ? getAgentActivityHandler(requestContext) : undefined;
      const controlCapability = decodeCoreToolRequestMetadata(
        requestContext?.metadata,
      ).controlCapability;
      return bashToolWithCwd(cwd, {
        artifacts: runtime.toolResultArtifacts,
        outputConfig: runtime.config?.tools.output,
        onActivity: onActivity ? () => onActivity("tool") : undefined,
        controlCapability: typeof controlCapability === "string" ? controlCapability : undefined,
        nativeProfile:
          runProfile === "primary" || !runtime.config
            ? undefined
            : resolveSubagentPermissionProfile(runtime.config, runProfile),
      }).bash;
    },
  }),
  read: defineLevel1Tool("bounded-and-aggregate-exempt", {
    name: "read",
    isEnabled: () => true,
    formatArgs: formatReadFileToolArgs,
    summarizeFailure: ({ result }) => summarizeReadOrEditFailure(result, "read"),
    createTool: (context) => getFsReadOnlyTool("read", context),
  }),
  glob: defineLevel1Tool("generic", {
    name: "glob",
    isEnabled: (context) => context.requestContext?.safetyMode !== "restricted",
    formatArgs: formatGlobToolArgs,
    summarizeFailure: ({ result }) => summarizeSearchFailure(result, "glob"),
    createTool: (context) => getFsReadOnlyTool("glob", context),
  }),
  grep: defineLevel1Tool("bounded-and-aggregate-exempt", {
    name: "grep",
    isEnabled: (context) => context.requestContext?.safetyMode !== "restricted",
    formatArgs: formatGrepToolArgs,
    summarizeFailure: ({ result }) => summarizeSearchFailure(result, "grep"),
    createTool: (context) => getFsReadOnlyTool("grep", context),
  }),
  fuzzy_search: defineLevel1Tool("generic", {
    name: "fuzzy_search",
    isEnabled: (context) =>
      context.runtime.config?.tools.fsBackend === "fff" &&
      context.requestContext?.safetyMode !== "restricted",
    formatArgs: formatFuzzySearchToolArgs,
    summarizeFailure: ({ result }) => summarizeSearchFailure(result, "fuzzy_search"),
    createTool: (context) => getFsReadOnlyTool("fuzzy_search", context),
  }),
  edit: defineLevel1Tool("bounded", {
    name: "edit",
    isEnabled: (context) =>
      context.editingToolMode === "edit_file" &&
      context.requestContext?.safetyMode !== "restricted",
    formatArgs: formatEditFileToolArgs,
    summarizeFailure: ({ result }) => summarizeReadOrEditFailure(result, "edit"),
    createTool: (context) => getEditFileTool(context),
  }),
  patch: defineLevel1Tool("bounded", {
    name: "patch",
    isEnabled: (context) =>
      context.editingToolMode === "apply_patch" &&
      context.requestContext?.safetyMode !== "restricted",
    formatArgs: formatApplyPatchToolArgs,
    summarizeFailure: ({ result }) => summarizeApplyPatchFailure(result),
    createTool: (context) => getApplyPatchTool(context),
  }),
  model_catalog: defineLevel1Tool("bounded", {
    name: "model_catalog",
    isEnabled: ({ runtime }) => runtime.config?.configVersion === 3,
    formatArgs: () => "model catalog",
    summarizeFailure: ({ result }) => summarizeSearchFailure(result, "model_catalog"),
    createTool: ({ runtime }) =>
      tool({
        description:
          "Find available models for delegation. Omit filters for providers and a short list; search by provider or text. Exact model lookup accepts an alias or provider/model and returns supported reasoning and effective defaults. Any available model can be delegated; favorites do not restrict selection.",
        inputSchema: z.object({
          provider: z.string().optional(),
          search: z.string().optional(),
          model: z.string().optional(),
          offset: z.number().int().min(0).default(0),
        }),
        execute: async (input) => {
          const config = runtime.config;
          if (!config) return { providers: [], models: [], omittedModels: 0 };
          const registry = await modelCatalogCache.read();
          const search = input.search?.toLowerCase();
          const models = projectModelCatalog(config, registry)
            .filter(
              (entry) =>
                (!input.provider || entry.provider === input.provider) &&
                (!input.model || entry.id === input.model) &&
                (!search || `${entry.id} ${entry.label}`.toLowerCase().includes(search)),
            )
            .sort((a, b) => Number(a.legacy) - Number(b.legacy) || a.id.localeCompare(b.id));
          return {
            providers: configuredCatalogProviders(config),
            models: models.slice(input.offset, input.offset + 20).map((entry) => ({
              ...entry,
              ...(input.model
                ? {
                    defaults: modelRuleDefaults(config, `${entry.provider}/${entry.model}`),
                    aliasOptions: config.models.def[entry.id]?.options,
                  }
                : {}),
            })),
            omittedModels: Math.max(0, models.length - input.offset - 20),
          };
        },
      }),
  }),
  subagent_delegate: defineLevel1Tool("bounded", {
    name: "subagent_delegate",
    isEnabled: ({ runtime, subagentConfig, subagentDepth, requestContext }) =>
      Boolean(runtime.bus) &&
      subagentConfig.enabled &&
      subagentDepth < subagentConfig.maxDepth &&
      requestContext?.safetyMode !== "restricted",
    formatArgs: formatSubagentDelegateToolArgs,
    summarizeFailure: ({ result }) => summarizeSubagentFailure(result),
    createTool: ({ runtime, subagentConfig, requestContext, runProfile, getLevel1ToolSpecs }) => {
      if (!runtime.bus) {
        return signalBuiltinToolHostError("subagent_delegate requires bus");
      }
      if (!runtime.config) {
        return signalBuiltinToolHostError("subagent_delegate requires config");
      }
      return subagentTools({
        idleTimeoutMs: subagentConfig.idleTimeoutMs,
        maxDepth: subagentConfig.maxDepth,
        runProfile,
        config: runtime.config,
        modelPresets: runtime.config.models.def,
        delegatePromptOverlay: runtime.config.agent.subagents.delegatePromptOverlay,
        orchestrateAvailable: getLevel1ToolSpecs().has("orchestrate"),
        onDelegate: requestContext ? getDelegateHandler(requestContext) : undefined,
      }).subagent_delegate;
    },
  }),
} satisfies {
  readonly [Name in Level1ToolName]: CoreLevel1ToolSpec & { readonly name: Name };
};

export function createLocalToolSpecs(): CoreLevel1ToolSpec[] {
  return LEVEL1_TOOL_NAMES.map((name) => BUILTIN_LEVEL1_TOOLS[name]);
}

export function createBuiltinLocalToolsPlugin(): CoreToolPlugin {
  return {
    meta: {
      id: "builtin-local-tools",
      name: "Built-in Local Tools",
    },
    create() {
      return {
        level1: createLocalToolSpecs(),
        level2: [] satisfies readonly ServerTool[],
      };
    },
  };
}
