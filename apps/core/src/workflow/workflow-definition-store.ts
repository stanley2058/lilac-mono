import fs from "node:fs/promises";
import path from "node:path";
import { Result, TaggedError, type Result as ResultType } from "better-result";
import type { BlobStore } from "@stanley2058/lilac-blob-storage";
import { errorCode, isPanic, opaqueErrorMessage } from "@stanley2058/lilac-utils";

import { projectRuntimeError } from "../runtime/error-format";
import { adaptToolResultToHost, preserveToolPanic } from "../tools/tool-result-adapters";

import {
  MAX_WORKFLOW_SOURCE_BYTES,
  sha256,
  validateWorkflowSourceUnchecked,
  workflowDefinitionNameSchema,
  type ValidatedWorkflowDefinition,
} from "./workflow-definition";
import type { DurableWorkflowStore } from "./durable-workflow-store";
import { readWorkflowSourceArtifact, writeWorkflowSourceArtifact } from "./workflow-artifact-store";
import type { WorkflowArtifactReference } from "./workflow-domain";
import { compareCodeUnits, workflowScopeSchema, type WorkflowScope } from "./workflow-domain";

export type WorkflowDefinitionScope = WorkflowScope | "auto";

export type ResolvedWorkflowDefinition = {
  scope: WorkflowScope;
  name: string;
  normalizedPath: string;
  canonicalPath: string;
  source: string;
  validation: ValidatedWorkflowDefinition;
};

type WorkflowDefinitionStoreOperation =
  | "create"
  | "get"
  | "save"
  | "list"
  | "create-snapshot"
  | "read-snapshot";

export class WorkflowDefinitionStoreFailed extends TaggedError("WorkflowDefinitionStoreFailed")<{
  readonly operation: WorkflowDefinitionStoreOperation;
  readonly message: string;
}> {}

async function captureWorkflowDefinitionStoreOperation<T>(
  operation: WorkflowDefinitionStoreOperation,
  effect: () => Promise<ResultType<T, WorkflowDefinitionStoreFailed>>,
): Promise<ResultType<T, WorkflowDefinitionStoreFailed>> {
  const [settled] = await Promise.allSettled([effect()]);
  if (settled.status === "rejected") {
    if (isPanic(settled.reason)) preserveToolPanic(settled.reason);
    return Result.err(
      new WorkflowDefinitionStoreFailed({
        operation,
        message: opaqueErrorMessage(settled.reason, `Workflow definition ${operation} failed`),
      }),
    );
  }
  return settled.value;
}

function storeFailure(
  operation: WorkflowDefinitionStoreOperation,
  message: string,
): WorkflowDefinitionStoreFailed {
  return new WorkflowDefinitionStoreFailed({ operation, message });
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

async function lstatOrNull(target: string) {
  const [stat] = await Promise.allSettled([fs.lstat(target)]);
  if (stat.status === "fulfilled") return stat.value;
  if (isPanic(stat.reason)) preserveToolPanic(stat.reason);
  if (errorCode(stat.reason) === "ENOENT") return null;
  return adaptToolResultToHost(
    Result.err(projectRuntimeError(stat.reason, `Could not inspect workflow path: ${target}`)),
  );
}

async function ensureDirectoryWithoutSymlinks(
  root: string,
  segments: readonly string[],
  operation: WorkflowDefinitionStoreOperation,
): Promise<ResultType<string, WorkflowDefinitionStoreFailed>> {
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    const existing = await lstatOrNull(current);
    if (existing?.isSymbolicLink()) {
      return Result.err(
        storeFailure(operation, `Workflow path cannot contain symlinks: ${current}`),
      );
    }
    if (existing && !existing.isDirectory()) {
      return Result.err(
        storeFailure(operation, `Workflow path component is not a directory: ${current}`),
      );
    }
    if (!existing) await fs.mkdir(current, { mode: 0o700 });
  }
  const canonical = await fs.realpath(current);
  if (!isContained(root, canonical)) {
    return Result.err(
      storeFailure(operation, `Workflow root escapes canonical containment: ${canonical}`),
    );
  }
  return Result.ok(canonical);
}

async function assertDirectorySegmentsWithoutSymlinks(
  root: string,
  segments: readonly string[],
  operation: WorkflowDefinitionStoreOperation,
): Promise<ResultType<string, WorkflowDefinitionStoreFailed>> {
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    const existing = await lstatOrNull(current);
    if (!existing) return Result.ok(path.join(root, ...segments));
    if (existing.isSymbolicLink()) {
      return Result.err(
        storeFailure(operation, `Workflow path cannot contain symlinks: ${current}`),
      );
    }
    if (!existing.isDirectory()) {
      return Result.err(
        storeFailure(operation, `Workflow path component is not a directory: ${current}`),
      );
    }
  }
  return Result.ok(current);
}

async function canonicalDirectory(
  target: string,
  operation: WorkflowDefinitionStoreOperation,
): Promise<ResultType<string, WorkflowDefinitionStoreFailed>> {
  await fs.mkdir(target, { recursive: true, mode: 0o700 });
  const stats = await fs.lstat(target);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    return Result.err(storeFailure(operation, `Workflow base must be a real directory: ${target}`));
  }
  return Result.ok(await fs.realpath(target));
}

async function readBoundedRegularFile(
  filePath: string,
  operation: WorkflowDefinitionStoreOperation,
): Promise<ResultType<{ source: string; canonicalPath: string }, WorkflowDefinitionStoreFailed>> {
  const stats = await fs.lstat(filePath);
  if (stats.isSymbolicLink()) {
    return Result.err(
      storeFailure(operation, `Workflow definition cannot be a symlink: ${filePath}`),
    );
  }
  if (!stats.isFile()) {
    return Result.err(
      storeFailure(operation, `Workflow definition is not a regular file: ${filePath}`),
    );
  }
  if (stats.size > MAX_WORKFLOW_SOURCE_BYTES) {
    return Result.err(
      storeFailure(operation, `Workflow source exceeds ${MAX_WORKFLOW_SOURCE_BYTES} bytes`),
    );
  }
  const canonicalPath = await fs.realpath(filePath);
  const source = await fs.readFile(canonicalPath, "utf8");
  if (Buffer.byteLength(source, "utf8") > MAX_WORKFLOW_SOURCE_BYTES) {
    return Result.err(
      storeFailure(operation, `Workflow source exceeds ${MAX_WORKFLOW_SOURCE_BYTES} bytes`),
    );
  }
  return Result.ok({ source, canonicalPath });
}

export class WorkflowDefinitionStore {
  readonly canonicalWorkspaceRoot: string;
  readonly canonicalProjectId: string;

  private constructor(
    canonicalWorkspaceRoot: string,
    private readonly canonicalDataDir: string,
    private readonly blobStore: BlobStore,
    private readonly workflowStore: DurableWorkflowStore,
  ) {
    this.canonicalWorkspaceRoot = canonicalWorkspaceRoot;
    this.canonicalProjectId = `project:${sha256(canonicalWorkspaceRoot)}`;
  }

  static async createResult(params: {
    workspaceRoot: string;
    dataDir: string;
    blobStore: BlobStore;
    workflowStore: DurableWorkflowStore;
  }): Promise<ResultType<WorkflowDefinitionStore, WorkflowDefinitionStoreFailed>> {
    return captureWorkflowDefinitionStoreOperation("create", async () => {
      const workspaceStats = await fs.lstat(params.workspaceRoot);
      if (workspaceStats.isSymbolicLink() || !workspaceStats.isDirectory()) {
        return Result.err(
          storeFailure(
            "create",
            `Workspace root must be a real directory: ${params.workspaceRoot}`,
          ),
        );
      }
      const canonicalWorkspaceRoot = await fs.realpath(params.workspaceRoot);
      const canonicalDataDir = await canonicalDirectory(params.dataDir, "create");
      return canonicalDataDir.map(
        (dataDir) =>
          new WorkflowDefinitionStore(
            canonicalWorkspaceRoot,
            dataDir,
            params.blobStore,
            params.workflowStore,
          ),
      );
    });
  }

  private async scopeRoot(
    scope: WorkflowScope,
    create: boolean,
    operation: WorkflowDefinitionStoreOperation,
  ): Promise<ResultType<string, WorkflowDefinitionStoreFailed>> {
    if (scope === "project") {
      if (create) {
        return await ensureDirectoryWithoutSymlinks(
          this.canonicalWorkspaceRoot,
          [".lilac", "workflows"],
          operation,
        );
      }
      return await assertDirectorySegmentsWithoutSymlinks(
        this.canonicalWorkspaceRoot,
        [".lilac", "workflows"],
        operation,
      );
    }
    if (create) {
      return await ensureDirectoryWithoutSymlinks(this.canonicalDataDir, ["workflows"], operation);
    }
    return await assertDirectorySegmentsWithoutSymlinks(
      this.canonicalDataDir,
      ["workflows"],
      operation,
    );
  }

  private async definitionPath(
    scope: WorkflowScope,
    nameInput: string,
    createRoot: boolean,
    operation: WorkflowDefinitionStoreOperation,
  ): Promise<
    ResultType<{ name: string; root: string; candidate: string }, WorkflowDefinitionStoreFailed>
  > {
    const parsedName = workflowDefinitionNameSchema.safeParse(nameInput);
    if (!parsedName.success) {
      return Result.err(
        storeFailure(operation, parsedName.error.issues[0]?.message ?? "Workflow name is invalid"),
      );
    }
    const name = parsedName.data;
    const rootResult = await this.scopeRoot(scope, createRoot, operation);
    return rootResult.andThen((root) => {
      const candidate = path.join(root, `${name}.js`);
      return !isContained(root, candidate) || path.dirname(candidate) !== root
        ? Result.err(storeFailure(operation, `Workflow definition escapes scope root: ${name}`))
        : Result.ok({ name, root, candidate });
    });
  }

  private async validateSource(
    input: {
      name: string;
      source: string;
    },
    operation: WorkflowDefinitionStoreOperation,
  ): Promise<ResultType<ValidatedWorkflowDefinition, WorkflowDefinitionStoreFailed>> {
    return validateWorkflowSourceUnchecked(input).mapError((error) =>
      storeFailure(operation, error.message),
    );
  }

  private async getUnchecked(params: {
    scope: WorkflowDefinitionScope;
    name: string;
  }): Promise<ResultType<ResolvedWorkflowDefinition, WorkflowDefinitionStoreFailed>> {
    const parsedScope = workflowScopeSchema.safeParse(params.scope);
    if (params.scope !== "auto" && !parsedScope.success) {
      return Result.err(storeFailure("get", "Workflow scope is invalid"));
    }
    const scopes: readonly WorkflowScope[] =
      params.scope === "auto" ? ["project", "personal"] : [parsedScope.data!];
    const resolveScope = async (
      index: number,
    ): Promise<ResultType<ResolvedWorkflowDefinition, WorkflowDefinitionStoreFailed>> => {
      const scope = scopes[index];
      if (!scope) {
        return Result.err(
          storeFailure(
            "get",
            `Workflow definition not found: ${params.name} (scope=${params.scope})`,
          ),
        );
      }
      const locationResult = await this.definitionPath(scope, params.name, false, "get");
      if (locationResult.isErr()) return Result.err(locationResult.error);
      const location = locationResult.value;
      const rootStats = await lstatOrNull(location.root);
      if (!rootStats) return resolveScope(index + 1);
      if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
        return Result.err(
          storeFailure("get", `Workflow scope root must be a real directory: ${location.root}`),
        );
      }
      const root = await fs.realpath(location.root);
      const fileStats = await lstatOrNull(location.candidate);
      if (!fileStats) return resolveScope(index + 1);
      const fileResult = await readBoundedRegularFile(location.candidate, "get");
      const continueWithFile = fileResult.match<
        () => Promise<ResultType<ResolvedWorkflowDefinition, WorkflowDefinitionStoreFailed>>
      >({
        err: (error) => async () => Result.err(error),
        ok:
          ({ source, canonicalPath }) =>
          async () => {
            if (!isContained(root, canonicalPath) || path.dirname(canonicalPath) !== root) {
              return Result.err(
                storeFailure(
                  "get",
                  `Workflow definition escapes canonical scope root: ${canonicalPath}`,
                ),
              );
            }
            const validationResult = await this.validateSource(
              { name: location.name, source },
              "get",
            );
            return validationResult.map((validation) => ({
              scope,
              name: location.name,
              normalizedPath: `${location.name}.js`,
              canonicalPath,
              source,
              validation,
            }));
          },
      });
      return continueWithFile();
    };
    return resolveScope(0);
  }

  async getResult(params: {
    scope: WorkflowDefinitionScope;
    name: string;
  }): Promise<ResultType<ResolvedWorkflowDefinition, WorkflowDefinitionStoreFailed>> {
    return captureWorkflowDefinitionStoreOperation("get", () => this.getUnchecked(params));
  }

  private async saveUnchecked(params: {
    scope: WorkflowScope;
    name: string;
    source: string;
    expectedSha256?: string;
  }): Promise<ResultType<ResolvedWorkflowDefinition, WorkflowDefinitionStoreFailed>> {
    const parsedScope = workflowScopeSchema.safeParse(params.scope);
    if (!parsedScope.success) return Result.err(storeFailure("save", "Workflow scope is invalid"));
    const scope = parsedScope.data;
    const locationResult = await this.definitionPath(scope, params.name, true, "save");
    const prepare = locationResult.match<
      () => Promise<
        ResultType<
          {
            location: { name: string; root: string; candidate: string };
            validation: ValidatedWorkflowDefinition;
          },
          WorkflowDefinitionStoreFailed
        >
      >
    >({
      err: (error) => async () => Result.err(error),
      ok: (location) => async () =>
        (
          await this.validateSource(
            {
              name: location.name,
              source: params.source,
            },
            "save",
          )
        ).map((validation) => ({ location, validation })),
    });
    const prepared = await prepare();
    const preparedOutcome = prepared.match<
      | {
          readonly kind: "ok";
          readonly location: { name: string; root: string; candidate: string };
          readonly validation: ValidatedWorkflowDefinition;
        }
      | { readonly kind: "error"; readonly error: WorkflowDefinitionStoreFailed }
    >({
      ok: ({ location, validation }) => ({ kind: "ok", location, validation }),
      err: (error) => ({ kind: "error", error }),
    });
    if (preparedOutcome.kind === "error") return Result.err(preparedOutcome.error);
    const { location, validation } = preparedOutcome;
    const lockPath = path.join(location.root, `.${location.name}.save.lock`);
    const [openedLock] = await Promise.allSettled([fs.open(lockPath, "wx", 0o600)]);
    if (openedLock.status === "rejected") {
      if (isPanic(openedLock.reason)) preserveToolPanic(openedLock.reason);
      return Result.err(
        storeFailure(
          "save",
          `Could not acquire the save lock for workflow ${location.name}: ${opaqueErrorMessage(openedLock.reason, "opaque lock failure")}`,
        ),
      );
    }
    const lock = openedLock.value;
    const outcome = await (async () => {
      const existingStats = await lstatOrNull(location.candidate);
      if (existingStats) {
        const existingResult = await readBoundedRegularFile(location.candidate, "save");
        const existingOutcome = existingResult.match<
          | { readonly kind: "ok"; readonly source: string; readonly canonicalPath: string }
          | { readonly kind: "error"; readonly error: WorkflowDefinitionStoreFailed }
        >({
          ok: (existing) => ({ kind: "ok", ...existing }),
          err: (error) => ({ kind: "error", error }),
        });
        if (existingOutcome.kind === "error")
          return { status: "return", value: Result.err(existingOutcome.error) } as const;
        const existing = existingOutcome;
        if (!isContained(location.root, existing.canonicalPath)) {
          return {
            status: "return",
            value: Result.err(
              storeFailure(
                "save",
                `Workflow definition escapes canonical scope root: ${existing.canonicalPath}`,
              ),
            ),
          } as const;
        }
        const currentSha256 = sha256(existing.source);
        if (!params.expectedSha256) {
          return {
            status: "return",
            value: Result.err(
              storeFailure(
                "save",
                `Workflow already exists; expectedSha256 is required (current ${currentSha256})`,
              ),
            ),
          } as const;
        }
        if (params.expectedSha256 !== currentSha256) {
          return {
            status: "return",
            value: Result.err(
              storeFailure(
                "save",
                `Workflow optimistic hash mismatch: expected ${params.expectedSha256}, current ${currentSha256}`,
              ),
            ),
          } as const;
        }
      } else if (params.expectedSha256 !== undefined) {
        return {
          status: "return",
          value: Result.err(
            storeFailure("save", "Workflow does not exist, but expectedSha256 was provided"),
          ),
        } as const;
      }

      const tempPath = path.join(location.root, `.${location.name}.${crypto.randomUUID()}.tmp`);
      const mode = scope === "personal" ? 0o600 : 0o644;
      const handle = await fs.open(tempPath, "wx", mode);
      await (async () => {
        await handle.writeFile(params.source, "utf8");
        await handle.sync();
      })().finally(() => handle.close());
      const [renamed] = await Promise.allSettled([
        fs.rename(tempPath, location.candidate).then(async () => {
          if (scope === "personal") await fs.chmod(location.candidate, 0o600);
        }),
      ]);
      if (renamed.status === "rejected") {
        if (isPanic(renamed.reason)) preserveToolPanic(renamed.reason);
        await fs.rm(tempPath, { force: true });
        return {
          status: "return",
          value: Result.err(
            storeFailure(
              "save",
              `Could not commit workflow ${location.name}: ${opaqueErrorMessage(renamed.reason, "opaque save failure")}`,
            ),
          ),
        } as const;
      }

      const saved = await readBoundedRegularFile(location.candidate, "save");
      const savedOutcome = saved.match<
        | { readonly kind: "ok"; readonly canonicalPath: string }
        | { readonly kind: "error"; readonly error: WorkflowDefinitionStoreFailed }
      >({
        ok: ({ canonicalPath }) => ({ kind: "ok", canonicalPath }),
        err: (error) => ({ kind: "error", error }),
      });
      if (savedOutcome.kind === "error")
        return { status: "return", value: Result.err(savedOutcome.error) } as const;
      const { canonicalPath } = savedOutcome;
      if (!isContained(location.root, canonicalPath)) {
        return {
          status: "return",
          value: Result.err(
            storeFailure("save", `Saved workflow escapes canonical scope root: ${canonicalPath}`),
          ),
        } as const;
      }
      return {
        status: "return",
        value: Result.ok({
          scope,
          name: location.name,
          normalizedPath: `${location.name}.js`,
          canonicalPath,
          source: params.source,
          validation,
        }),
      } as const;
    })().finally(async () => {
      await lock.close();
      await fs.rm(lockPath, { force: true });
    });
    return outcome.value;
  }

  async saveResult(params: {
    scope: WorkflowScope;
    name: string;
    source: string;
    expectedSha256?: string;
  }): Promise<ResultType<ResolvedWorkflowDefinition, WorkflowDefinitionStoreFailed>> {
    return captureWorkflowDefinitionStoreOperation("save", () => this.saveUnchecked(params));
  }

  private async listUnchecked(params: { scope: WorkflowDefinitionScope }): Promise<
    ResultType<
      Array<
        | (Omit<ResolvedWorkflowDefinition, "source"> & { valid: true })
        | {
            scope: WorkflowScope;
            name: string;
            normalizedPath: string;
            canonicalPath: string;
            valid: false;
            error: string;
          }
      >,
      WorkflowDefinitionStoreFailed
    >
  > {
    const parsedScope = workflowScopeSchema.safeParse(params.scope);
    if (params.scope !== "auto" && !parsedScope.success) {
      return Result.err(storeFailure("list", "Workflow scope is invalid"));
    }
    const scopes: readonly WorkflowScope[] =
      params.scope === "auto" ? ["project", "personal"] : [parsedScope.data!];
    const seen = new Set<string>();
    const results: Array<
      | (Omit<ResolvedWorkflowDefinition, "source"> & { valid: true })
      | {
          scope: WorkflowScope;
          name: string;
          normalizedPath: string;
          canonicalPath: string;
          valid: false;
          error: string;
        }
    > = [];
    for (const scope of scopes) {
      const rootResult = await this.scopeRoot(scope, false, "list");
      const rootOutcome = rootResult.match<
        | { readonly kind: "ok"; readonly root: string }
        | { readonly kind: "error"; readonly error: WorkflowDefinitionStoreFailed }
      >({
        ok: (root) => ({ kind: "ok", root }),
        err: (error) => ({ kind: "error", error }),
      });
      if (rootOutcome.kind === "error") return Result.err(rootOutcome.error);
      const rootCandidate = rootOutcome.root;
      const rootStats = await lstatOrNull(rootCandidate);
      if (!rootStats) continue;
      if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
        return Result.err(
          storeFailure("list", `Workflow scope root must be a real directory: ${rootCandidate}`),
        );
      }
      const entries = await fs.readdir(rootCandidate, { withFileTypes: true });
      for (const entry of entries.sort((left, right) => compareCodeUnits(left.name, right.name))) {
        if (!entry.name.endsWith(".js")) continue;
        const name = entry.name.slice(0, -3);
        if (!workflowDefinitionNameSchema.safeParse(name).success || seen.has(name)) continue;
        seen.add(name);
        const candidate = path.join(rootCandidate, entry.name);
        const resolved = await this.getResult({ scope, name });
        resolved.match({
          ok: (definition) =>
            results.push({
              scope,
              name,
              normalizedPath: definition.normalizedPath,
              canonicalPath: definition.canonicalPath,
              validation: definition.validation,
              valid: true,
            }),
          err: (error) =>
            results.push({
              scope,
              name,
              normalizedPath: entry.name,
              canonicalPath: candidate,
              valid: false,
              error: error.message,
            }),
        });
      }
    }
    return Result.ok(results);
  }

  async listResult(params: {
    scope: WorkflowDefinitionScope;
  }): Promise<
    ResultType<
      Awaited<ReturnType<WorkflowDefinitionStore["listUnchecked"]>> extends ResultType<
        infer TValue,
        WorkflowDefinitionStoreFailed
      >
        ? TValue
        : never,
      WorkflowDefinitionStoreFailed
    >
  > {
    return captureWorkflowDefinitionStoreOperation("list", () => this.listUnchecked(params));
  }

  private async createSnapshotUnchecked(
    source: string,
    sourceSha256: string,
  ): Promise<ResultType<{ artifact: WorkflowArtifactReference }, WorkflowDefinitionStoreFailed>> {
    return (
      await writeWorkflowSourceArtifact({
        blobStore: this.blobStore,
        workflowStore: this.workflowStore,
        source,
        sourceSha256,
        maxBytes: MAX_WORKFLOW_SOURCE_BYTES,
      })
    )
      .map((artifact) => ({ artifact }))
      .mapError((error) => storeFailure("create-snapshot", error.message));
  }

  async createSnapshotResult(
    source: string,
    sourceSha256: string,
  ): Promise<ResultType<{ artifact: WorkflowArtifactReference }, WorkflowDefinitionStoreFailed>> {
    return captureWorkflowDefinitionStoreOperation("create-snapshot", () =>
      this.createSnapshotUnchecked(source, sourceSha256),
    );
  }

  private async readSnapshotUnchecked(
    artifact: WorkflowArtifactReference,
  ): Promise<ResultType<string, WorkflowDefinitionStoreFailed>> {
    return (
      await readWorkflowSourceArtifact({
        blobStore: this.blobStore,
        reference: artifact,
        maxBytes: MAX_WORKFLOW_SOURCE_BYTES,
      })
    ).mapError((error) => storeFailure("read-snapshot", error.message));
  }

  async readSnapshotResult(
    artifact: WorkflowArtifactReference,
  ): Promise<ResultType<string, WorkflowDefinitionStoreFailed>> {
    return captureWorkflowDefinitionStoreOperation("read-snapshot", () =>
      this.readSnapshotUnchecked(artifact),
    );
  }
}
