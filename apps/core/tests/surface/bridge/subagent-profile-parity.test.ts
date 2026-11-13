import { describe, expect, it } from "bun:test";
import {
  parseCoreConfigV3ToUniversal,
  resolveSubagentPermissionProfile,
} from "@stanley2058/lilac-utils";

import { Result } from "better-result";

import {
  buildSystemPromptForProfile,
  resolveSubagentConversation,
  selectWorkspaceSystemPrompt,
} from "../../../src/surface/bridge/bus-agent-runner/subagent-prompt";
import { DurableWorkflowSqliteDriverFailure } from "../../../src/workflow/durable-workflow-store";

describe("subagent permission profile prompts", () => {
  const config = parseCoreConfigV3ToUniversal({
    configVersion: 3,
    agent: {
      subagents: {
        permissions: {
          offline: { network: false, execution: false, promptOverlay: "Work from local files." },
        },
      },
    },
  });

  it("uses the worker prompt for every subagent, including legacy self runs", () => {
    for (const profile of ["full", "restricted", "self", "explore"]) {
      expect(
        selectWorkspaceSystemPrompt({
          profile,
          primarySystemPrompt: "primary",
          workerSystemPrompt: "worker",
        }),
      ).toBe("worker");
    }
    expect(
      selectWorkspaceSystemPrompt({
        profile: "primary",
        primarySystemPrompt: "primary",
        workerSystemPrompt: "worker",
      }),
    ).toBe("primary");
  });

  it("falls back to the primary prompt when a worker prompt has not been loaded", () => {
    expect(
      selectWorkspaceSystemPrompt({
        profile: "full",
        primarySystemPrompt: "primary",
        workerSystemPrompt: "",
      }),
    ).toBe("primary");
  });

  it("renders one overlay with the skills section and the customize-lilac pointer", () => {
    const prompt = buildSystemPromptForProfile({
      baseSystemPrompt: "base",
      profile: "full",
      profileConfig: resolveSubagentPermissionProfile(config, "full"),
      skillsSection: "skills",
    });

    expect(prompt).toContain("skills");
    expect(prompt).toContain("## Subagent (permissions: full)");
    expect(prompt).toContain("names in the task refer to that user");
    expect(prompt).toContain("load the customize-lilac skill");
    expect(prompt).toContain("TOOLS.md describes capabilities and conventions");
    expect(prompt).not.toContain("Do not delegate");
    expect(prompt).not.toContain("Do not edit");
  });

  it("derives constraint lines and the overlay from the permission profile", () => {
    const restricted = buildSystemPromptForProfile({
      baseSystemPrompt: "base",
      profile: "restricted",
      profileConfig: resolveSubagentPermissionProfile(config, "restricted"),
    });
    expect(restricted).toContain("Do not edit project files.");
    expect(restricted).toContain("Do not delegate to another subagent.");
    expect(restricted).not.toContain("Do not use bash.");

    const offline = buildSystemPromptForProfile({
      baseSystemPrompt: "base",
      profile: "offline",
      profileConfig: resolveSubagentPermissionProfile(config, "offline"),
    });
    expect(offline).toContain("Do not use bash.");
    expect(offline).toContain("Do not use network access or network-backed tools.");
    expect(offline).toContain("Work from local files.");
  });

  it("leaves the primary prompt without a subagent overlay", () => {
    expect(
      buildSystemPromptForProfile({
        baseSystemPrompt: "base",
        profile: "primary",
        skillsSection: "skills",
      }),
    ).toBe("base\n\nskills");
  });

  it("names the conversation thread and a delegating subagent run", () => {
    const profileConfig = resolveSubagentPermissionProfile(config, "full");
    const direct = buildSystemPromptForProfile({
      baseSystemPrompt: "base",
      profile: "full",
      profileConfig,
      conversation: { threadId: "thread-1" },
    });
    expect(direct).toContain("The user's conversation thread id is thread-1.");
    expect(direct).not.toContain("delegated this task");

    const nested = buildSystemPromptForProfile({
      baseSystemPrompt: "base",
      profile: "full",
      profileConfig,
      conversation: { threadId: "thread-1", parentRunId: "wfrun:subagent:parent" },
    });
    expect(nested).toContain("The subagent run that delegated this task is wfrun:subagent:parent.");
  });

  it("finds the parent run only when another subagent delegated", () => {
    const parentRequests: Record<string, string> = {
      "wfrun:subagent:child": "req:subagent",
      "wfrun:subagent:direct": "req:primary",
      "wfrun:subagent:scripted-child": "req:scripted-step",
    };
    const operationRuns: Record<string, string> = {
      "req:subagent": "wfrun:subagent:parent",
      "req:scripted-step": "wfrun:scripted",
    };
    const workflows = {
      getRun: (runId: string) => {
        const parentRequestId = parentRequests[runId];
        return Result.ok(
          parentRequestId ? { completionTarget: { kind: "live_parent", parentRequestId } } : null,
        );
      },
      getOperationByRequestId: (requestId: string) => {
        const runId = operationRuns[requestId];
        return Result.ok(runId ? { runId } : null);
      },
    } as unknown as Parameters<typeof resolveSubagentConversation>[0]["workflows"];
    const errors: unknown[] = [];

    const resolve = (runId: string) =>
      resolveSubagentConversation({
        workflows,
        runId,
        threadId: "thread-1",
        onReadError: (error) => errors.push(error),
      });

    expect(resolve("wfrun:subagent:child")).toEqual({
      threadId: "thread-1",
      parentRunId: "wfrun:subagent:parent",
    });
    expect(resolve("wfrun:subagent:direct")).toEqual({ threadId: "thread-1" });
    expect(resolve("wfrun:subagent:scripted-child")).toEqual({ threadId: "thread-1" });
    expect(errors).toEqual([]);
  });

  it("keeps the thread id when the workflow store cannot be read", () => {
    const failure = new DurableWorkflowSqliteDriverFailure({
      operation: "get-run",
      code: "SQLITE_BUSY",
      message: "database is locked",
    });
    const workflows = {
      getRun: () => Result.err(failure),
      getOperationByRequestId: () => Result.ok(null),
    } as unknown as Parameters<typeof resolveSubagentConversation>[0]["workflows"];
    const errors: unknown[] = [];

    expect(
      resolveSubagentConversation({
        workflows,
        runId: "wfrun:subagent:child",
        threadId: "thread-1",
        onReadError: (error) => errors.push(error),
      }),
    ).toEqual({ threadId: "thread-1" });
    expect(errors).toEqual([failure]);
  });
});
