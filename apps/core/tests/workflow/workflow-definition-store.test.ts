import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { WorkflowDefinitionStore } from "../../src/workflow/workflow-definition-store";

function source(name: string, description = "Test workflow") {
  return `import { defineWorkflow } from "@lilac/workflow";
export default defineWorkflow({
  name: "${name}",
  description: "${description}",
  input: { type: "object", properties: {} },
  capabilities: {
    agents: { profiles: ["explore"], models: ["inherit"], maxConcurrent: 1, maxTotal: 1, editing: false, isolation: "shared" },
    waits: [],
  },
  async run({ args }) { return args; },
});
`;
}

describe("WorkflowDefinitionStore", () => {
  let root: string | null = null;

  afterEach(async () => {
    if (root) await fs.rm(root, { recursive: true, force: true });
    root = null;
  });

  it("saves atomically, requires optimistic hashes, and resolves project before personal", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-definition-store-"));
    const workspaceRoot = path.join(root, "workspace");
    const dataDir = path.join(root, "data");
    await fs.mkdir(workspaceRoot);
    const store = await WorkflowDefinitionStore.create({ workspaceRoot, dataDir });

    const personal = await store.save({
      scope: "personal",
      name: "audit-routes",
      source: source("audit-routes", "Personal"),
    });
    expect((await fs.stat(personal.canonicalPath)).mode & 0o777).toBe(0o600);
    await expect(
      store.save({
        scope: "personal",
        name: "audit-routes",
        source: source("audit-routes", "New"),
      }),
    ).rejects.toThrow("expectedSha256 is required");
    await expect(
      store.save({
        scope: "personal",
        name: "audit-routes",
        source: source("audit-routes", "New"),
        expectedSha256: "a".repeat(64),
      }),
    ).rejects.toThrow("optimistic hash mismatch");
    const replaced = await store.save({
      scope: "personal",
      name: "audit-routes",
      source: source("audit-routes", "New"),
      expectedSha256: personal.validation.sourceSha256,
    });
    expect(replaced.validation.metadata.description).toBe("New");

    await store.save({
      scope: "project",
      name: "audit-routes",
      source: source("audit-routes", "Project"),
    });
    expect((await store.get({ scope: "auto", name: "audit-routes" })).scope).toBe("project");
    expect(await store.list({ scope: "auto" })).toHaveLength(1);
  });

  it("rejects symlink roots and files, traversal names, and creates immutable snapshots", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-definition-security-"));
    const workspaceRoot = path.join(root, "workspace");
    const dataDir = path.join(root, "data");
    await fs.mkdir(workspaceRoot);
    const store = await WorkflowDefinitionStore.create({ workspaceRoot, dataDir });
    await expect(
      store.save({ scope: "project", name: "../escape", source: source("escape") }),
    ).rejects.toThrow("kebab-case");

    const outside = path.join(root, "outside.js");
    await fs.writeFile(outside, source("linked"));
    const workflowRoot = path.join(workspaceRoot, ".lilac", "workflows");
    await fs.mkdir(workflowRoot, { recursive: true });
    await fs.symlink(outside, path.join(workflowRoot, "linked.js"));
    await expect(store.get({ scope: "project", name: "linked" })).rejects.toThrow("symlink");

    const saved = await store.save({
      scope: "personal",
      name: "snapshot-test",
      source: source("snapshot-test"),
    });
    const first = await store.createSnapshot(saved.source, saved.validation.sourceSha256);
    const second = await store.createSnapshot(saved.source, saved.validation.sourceSha256);
    expect(first).toEqual(second);
    expect(await store.readSnapshot(saved.validation.sourceSha256)).toBe(saved.source);
    expect(path.basename(first.path)).toBe(`${saved.validation.sourceSha256}.js`);
    expect((await fs.stat(first.path)).mode & 0o777).toBe(0o600);
    await expect(
      store.createSnapshot(`${saved.source}\n`, saved.validation.sourceSha256),
    ).rejects.toThrow("hash mismatch");
  });

  it("rejects symlinks in intermediate scope-root components", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-definition-root-symlink-"));
    const workspaceRoot = path.join(root, "workspace");
    const dataDir = path.join(root, "data");
    const outside = path.join(root, "outside");
    await fs.mkdir(workspaceRoot);
    await fs.mkdir(path.join(outside, "workflows"), { recursive: true });
    await fs.writeFile(path.join(outside, "workflows", "linked.js"), source("linked"));
    await fs.symlink(outside, path.join(workspaceRoot, ".lilac"));
    const store = await WorkflowDefinitionStore.create({ workspaceRoot, dataDir });

    await expect(store.get({ scope: "project", name: "linked" })).rejects.toThrow(
      "cannot contain symlinks",
    );
  });
});
