import fs from "node:fs/promises";
import path from "node:path";

import {
  MAX_WORKFLOW_SOURCE_BYTES,
  sha256,
  validateWorkflowSource,
  workflowDefinitionNameSchema,
  type ValidatedWorkflowDefinition,
} from "./workflow-definition";
import {
  compareCodeUnits,
  workflowScopeSchema,
  type WorkflowSafetyMode,
  type WorkflowScope,
} from "./workflow-domain";

export type WorkflowDefinitionScope = WorkflowScope | "auto";

export type ResolvedWorkflowDefinition = {
  scope: WorkflowScope;
  name: string;
  normalizedPath: string;
  canonicalPath: string;
  source: string;
  validation: ValidatedWorkflowDefinition;
};

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

async function lstatOrNull(target: string) {
  try {
    return await fs.lstat(target);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

async function ensureDirectoryWithoutSymlinks(
  root: string,
  segments: readonly string[],
): Promise<string> {
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    const existing = await lstatOrNull(current);
    if (existing?.isSymbolicLink())
      throw new Error(`Workflow path cannot contain symlinks: ${current}`);
    if (existing && !existing.isDirectory())
      throw new Error(`Workflow path component is not a directory: ${current}`);
    if (!existing) await fs.mkdir(current, { mode: 0o700 });
  }
  const canonical = await fs.realpath(current);
  if (!isContained(root, canonical))
    throw new Error(`Workflow root escapes canonical containment: ${canonical}`);
  return canonical;
}

async function assertDirectorySegmentsWithoutSymlinks(
  root: string,
  segments: readonly string[],
): Promise<string> {
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    const existing = await lstatOrNull(current);
    if (!existing) return path.join(root, ...segments);
    if (existing.isSymbolicLink()) {
      throw new Error(`Workflow path cannot contain symlinks: ${current}`);
    }
    if (!existing.isDirectory()) {
      throw new Error(`Workflow path component is not a directory: ${current}`);
    }
  }
  return current;
}

async function canonicalDirectory(target: string): Promise<string> {
  await fs.mkdir(target, { recursive: true, mode: 0o700 });
  const stats = await fs.lstat(target);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`Workflow base must be a real directory: ${target}`);
  }
  return await fs.realpath(target);
}

async function readBoundedRegularFile(
  filePath: string,
): Promise<{ source: string; canonicalPath: string }> {
  const stats = await fs.lstat(filePath);
  if (stats.isSymbolicLink())
    throw new Error(`Workflow definition cannot be a symlink: ${filePath}`);
  if (!stats.isFile()) throw new Error(`Workflow definition is not a regular file: ${filePath}`);
  if (stats.size > MAX_WORKFLOW_SOURCE_BYTES) {
    throw new Error(`Workflow source exceeds ${MAX_WORKFLOW_SOURCE_BYTES} bytes`);
  }
  const canonicalPath = await fs.realpath(filePath);
  const source = await fs.readFile(canonicalPath, "utf8");
  if (Buffer.byteLength(source, "utf8") > MAX_WORKFLOW_SOURCE_BYTES) {
    throw new Error(`Workflow source exceeds ${MAX_WORKFLOW_SOURCE_BYTES} bytes`);
  }
  return { source, canonicalPath };
}

export class WorkflowDefinitionStore {
  readonly canonicalWorkspaceRoot: string;
  readonly canonicalProjectId: string;

  private constructor(
    canonicalWorkspaceRoot: string,
    private readonly canonicalDataDir: string,
  ) {
    this.canonicalWorkspaceRoot = canonicalWorkspaceRoot;
    this.canonicalProjectId = `project:${sha256(canonicalWorkspaceRoot)}`;
  }

  static async create(params: {
    workspaceRoot: string;
    dataDir: string;
  }): Promise<WorkflowDefinitionStore> {
    const workspaceStats = await fs.lstat(params.workspaceRoot);
    if (workspaceStats.isSymbolicLink() || !workspaceStats.isDirectory()) {
      throw new Error(`Workspace root must be a real directory: ${params.workspaceRoot}`);
    }
    const canonicalWorkspaceRoot = await fs.realpath(params.workspaceRoot);
    const canonicalDataDir = await canonicalDirectory(params.dataDir);
    return new WorkflowDefinitionStore(canonicalWorkspaceRoot, canonicalDataDir);
  }

  private async scopeRoot(scope: WorkflowScope, create: boolean): Promise<string> {
    if (scope === "project") {
      if (create) {
        return await ensureDirectoryWithoutSymlinks(this.canonicalWorkspaceRoot, [
          ".lilac",
          "workflows",
        ]);
      }
      return await assertDirectorySegmentsWithoutSymlinks(this.canonicalWorkspaceRoot, [
        ".lilac",
        "workflows",
      ]);
    }
    if (create) return await ensureDirectoryWithoutSymlinks(this.canonicalDataDir, ["workflows"]);
    return await assertDirectorySegmentsWithoutSymlinks(this.canonicalDataDir, ["workflows"]);
  }

  private async definitionPath(scope: WorkflowScope, nameInput: string, createRoot: boolean) {
    const name = workflowDefinitionNameSchema.parse(nameInput);
    const root = await this.scopeRoot(scope, createRoot);
    const candidate = path.join(root, `${name}.js`);
    if (!isContained(root, candidate) || path.dirname(candidate) !== root) {
      throw new Error(`Workflow definition escapes scope root: ${name}`);
    }
    return { name, root, candidate };
  }

  async get(params: {
    scope: WorkflowDefinitionScope;
    name: string;
    safetyMode?: WorkflowSafetyMode;
  }): Promise<ResolvedWorkflowDefinition> {
    const scopes: readonly WorkflowScope[] =
      params.scope === "auto" ? ["project", "personal"] : [workflowScopeSchema.parse(params.scope)];
    for (const scope of scopes) {
      const location = await this.definitionPath(scope, params.name, false);
      const rootStats = await lstatOrNull(location.root);
      if (!rootStats) continue;
      if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
        throw new Error(`Workflow scope root must be a real directory: ${location.root}`);
      }
      const root = await fs.realpath(location.root);
      const fileStats = await lstatOrNull(location.candidate);
      if (!fileStats) continue;
      const { source, canonicalPath } = await readBoundedRegularFile(location.candidate);
      if (!isContained(root, canonicalPath) || path.dirname(canonicalPath) !== root) {
        throw new Error(`Workflow definition escapes canonical scope root: ${canonicalPath}`);
      }
      return {
        scope,
        name: location.name,
        normalizedPath: `${location.name}.js`,
        canonicalPath,
        source,
        validation: validateWorkflowSource({
          name: location.name,
          source,
          safetyMode: params.safetyMode,
        }),
      };
    }
    throw new Error(`Workflow definition not found: ${params.name} (scope=${params.scope})`);
  }

  async save(params: {
    scope: WorkflowScope;
    name: string;
    source: string;
    expectedSha256?: string;
    safetyMode?: WorkflowSafetyMode;
  }): Promise<ResolvedWorkflowDefinition> {
    const scope = workflowScopeSchema.parse(params.scope);
    const location = await this.definitionPath(scope, params.name, true);
    const validation = validateWorkflowSource({
      name: location.name,
      source: params.source,
      safetyMode: params.safetyMode,
    });
    const lockPath = path.join(location.root, `.${location.name}.save.lock`);
    let lock;
    try {
      lock = await fs.open(lockPath, "wx", 0o600);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") {
        throw new Error(`Another save is already in progress for workflow: ${location.name}`);
      }
      throw error;
    }
    try {
      const existingStats = await lstatOrNull(location.candidate);
      if (existingStats) {
        const existing = await readBoundedRegularFile(location.candidate);
        if (!isContained(location.root, existing.canonicalPath)) {
          throw new Error(
            `Workflow definition escapes canonical scope root: ${existing.canonicalPath}`,
          );
        }
        const currentSha256 = sha256(existing.source);
        if (!params.expectedSha256) {
          throw new Error(
            `Workflow already exists; expectedSha256 is required (current ${currentSha256})`,
          );
        }
        if (params.expectedSha256 !== currentSha256) {
          throw new Error(
            `Workflow optimistic hash mismatch: expected ${params.expectedSha256}, current ${currentSha256}`,
          );
        }
      } else if (params.expectedSha256 !== undefined) {
        throw new Error("Workflow does not exist, but expectedSha256 was provided");
      }

      const tempPath = path.join(location.root, `.${location.name}.${crypto.randomUUID()}.tmp`);
      const mode = scope === "personal" ? 0o600 : 0o644;
      const handle = await fs.open(tempPath, "wx", mode);
      try {
        await handle.writeFile(params.source, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await fs.rename(tempPath, location.candidate);
        if (scope === "personal") await fs.chmod(location.candidate, 0o600);
      } catch (error) {
        await fs.rm(tempPath, { force: true });
        throw error;
      }

      const { canonicalPath } = await readBoundedRegularFile(location.candidate);
      if (!isContained(location.root, canonicalPath)) {
        throw new Error(`Saved workflow escapes canonical scope root: ${canonicalPath}`);
      }
      return {
        scope,
        name: location.name,
        normalizedPath: `${location.name}.js`,
        canonicalPath,
        source: params.source,
        validation,
      };
    } finally {
      await lock.close();
      await fs.rm(lockPath, { force: true });
    }
  }

  async list(params: { scope: WorkflowDefinitionScope; safetyMode?: WorkflowSafetyMode }): Promise<
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
    >
  > {
    const scopes: readonly WorkflowScope[] =
      params.scope === "auto" ? ["project", "personal"] : [workflowScopeSchema.parse(params.scope)];
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
      const rootCandidate = await this.scopeRoot(scope, false);
      const rootStats = await lstatOrNull(rootCandidate);
      if (!rootStats) continue;
      if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
        throw new Error(`Workflow scope root must be a real directory: ${rootCandidate}`);
      }
      const entries = await fs.readdir(rootCandidate, { withFileTypes: true });
      for (const entry of entries.sort((left, right) => compareCodeUnits(left.name, right.name))) {
        if (!entry.name.endsWith(".js")) continue;
        const name = entry.name.slice(0, -3);
        if (!workflowDefinitionNameSchema.safeParse(name).success || seen.has(name)) continue;
        seen.add(name);
        const candidate = path.join(rootCandidate, entry.name);
        try {
          const resolved = await this.get({ scope, name, safetyMode: params.safetyMode });
          results.push({
            scope,
            name,
            normalizedPath: resolved.normalizedPath,
            canonicalPath: resolved.canonicalPath,
            validation: resolved.validation,
            valid: true,
          });
        } catch (error) {
          results.push({
            scope,
            name,
            normalizedPath: entry.name,
            canonicalPath: candidate,
            valid: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    return results;
  }

  async createSnapshot(
    source: string,
    sourceSha256: string,
  ): Promise<{ artifactId: string; path: string }> {
    if (sha256(source) !== sourceSha256) throw new Error("Snapshot source hash mismatch");
    const root = await ensureDirectoryWithoutSymlinks(this.canonicalDataDir, [
      "workflow-snapshots",
    ]);
    const snapshotPath = path.join(root, `${sourceSha256}.js`);
    const existing = await lstatOrNull(snapshotPath);
    if (existing) {
      const stored = await readBoundedRegularFile(snapshotPath);
      if (!isContained(root, stored.canonicalPath) || sha256(stored.source) !== sourceSha256) {
        throw new Error(`Workflow snapshot hash collision or containment failure: ${sourceSha256}`);
      }
      return { artifactId: `workflow-source:${sourceSha256}`, path: stored.canonicalPath };
    }
    let handle;
    try {
      handle = await fs.open(snapshotPath, "wx", 0o600);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") {
        const stored = await readBoundedRegularFile(snapshotPath);
        if (isContained(root, stored.canonicalPath) && sha256(stored.source) === sourceSha256) {
          return { artifactId: `workflow-source:${sourceSha256}`, path: stored.canonicalPath };
        }
      }
      throw error;
    }
    try {
      await handle.writeFile(source, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.chmod(snapshotPath, 0o600);
    return {
      artifactId: `workflow-source:${sourceSha256}`,
      path: await fs.realpath(snapshotPath),
    };
  }

  async readSnapshot(sourceSha256: string): Promise<string> {
    if (!/^[a-f0-9]{64}$/u.test(sourceSha256)) throw new Error("Invalid workflow source hash");
    const root = await this.scopeRootForSnapshots();
    const snapshotPath = path.join(root, `${sourceSha256}.js`);
    const stored = await readBoundedRegularFile(snapshotPath);
    if (!isContained(root, stored.canonicalPath) || path.dirname(stored.canonicalPath) !== root) {
      throw new Error(`Workflow snapshot escapes canonical root: ${stored.canonicalPath}`);
    }
    if (sha256(stored.source) !== sourceSha256) {
      throw new Error(`Workflow snapshot hash mismatch: ${sourceSha256}`);
    }
    return stored.source;
  }

  private async scopeRootForSnapshots(): Promise<string> {
    return await ensureDirectoryWithoutSymlinks(this.canonicalDataDir, ["workflow-snapshots"]);
  }
}
