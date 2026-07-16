import { describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createWorkflowDeniedRootPolicy,
  workflowPathDenialReason,
  workflowWritableRootDenialReason,
} from "../../src/workflow/workflow-denied-root-policy";
import { ensureWorkflowRunScratch } from "../../src/workflow/workflow-scratch";

describe("global workflow denied-root policy", () => {
  it("denies only deployment-owned system, Core, and credential roots", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-denied-policy-"));
    try {
      const policy = createWorkflowDeniedRootPolicy(dataDir);
      for (const candidate of [
        path.parse(dataDir).root,
        "/run/lilac",
        path.join(dataDir, "secret"),
        path.join(dataDir, "plugins"),
        path.join(dataDir, "prompts"),
        path.join(dataDir, "core-config.yaml"),
        path.join(dataDir, "data.sqlite3"),
        path.join(dataDir, "workflow-artifacts"),
        path.join(os.homedir(), ".ssh"),
        path.join(os.homedir(), ".npmrc"),
      ]) {
        expect(workflowPathDenialReason({ policy, candidate })).not.toBeNull();
      }
      for (const candidate of [
        path.join(os.tmpdir(), "project", ".env.example"),
        path.join(os.tmpdir(), "project", ".gitmodules"),
        path.join(os.tmpdir(), "project", ".npmrc"),
        path.join(os.tmpdir(), "project", "test", "secrets", "fixture.txt"),
      ]) {
        expect(workflowPathDenialReason({ policy, candidate })).toBeNull();
      }
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  it("allows ordinary workspace paths and only the selected run scratch exception", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-denied-exception-"));
    try {
      const policy = createWorkflowDeniedRootPolicy(dataDir);
      const scratch = await ensureWorkflowRunScratch({ dataDir, runId: "run-1" });
      const otherScratch = await ensureWorkflowRunScratch({ dataDir, runId: "run-2" });
      expect(
        workflowPathDenialReason({ policy, candidate: path.join(dataDir, "workspace", "src") }),
      ).toBeNull();
      expect(
        workflowPathDenialReason({
          policy,
          candidate: path.join(scratch, "handoff.txt"),
          scratchRoot: scratch,
        }),
      ).toBeNull();
      expect(
        workflowPathDenialReason({
          policy,
          candidate: path.join(otherScratch, "handoff.txt"),
          scratchRoot: scratch,
        }),
      ).not.toBeNull();
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  it("allows ancestors while denying exact authority and credential roots", async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-denied-ancestor-"));
    const dataDir = path.join(parent, "data", "lilac");
    const home = path.join(parent, "home", "user");
    await fs.mkdir(path.join(dataDir, "secret"), { recursive: true });
    await fs.mkdir(path.join(home, ".ssh"), { recursive: true });
    await fs.mkdir(path.join(home, "projects", "focused"), { recursive: true });
    try {
      const policy = createWorkflowDeniedRootPolicy(dataDir);
      const credentialPolicy = {
        ...policy,
        absoluteDeniedRoots: [...policy.absoluteDeniedRoots, path.join(home, ".ssh")],
      };
      expect(
        workflowWritableRootDenialReason({ policy, candidate: path.join(parent, "data") }),
      ).toBeNull();
      expect(workflowWritableRootDenialReason({ policy, candidate: dataDir })).toBeNull();
      expect(
        workflowWritableRootDenialReason({
          policy,
          candidate: path.join(dataDir, "secret"),
        }),
      ).not.toBeNull();
      expect(
        workflowWritableRootDenialReason({
          policy,
          candidate: path.join(dataDir, "workspace"),
        }),
      ).toBeNull();
      expect(
        workflowWritableRootDenialReason({ policy: credentialPolicy, candidate: home }),
      ).toBeNull();
      expect(
        workflowWritableRootDenialReason({
          policy: credentialPolicy,
          candidate: path.join(home, ".ssh"),
        }),
      ).not.toBeNull();
      expect(
        workflowWritableRootDenialReason({
          policy: credentialPolicy,
          candidate: path.join(home, "projects", "focused"),
        }),
      ).toBeNull();
    } finally {
      await fs.rm(parent, { recursive: true, force: true });
    }
  });
});
