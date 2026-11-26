import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { JobRecord } from "../../src/jobs/job-domain";
import { JobService } from "../../src/jobs/job-service";
import { SqliteJobStore } from "../../src/jobs/job-store";
import { resolveRestrictedSessionTmpDir } from "../../src/shared/attachment-utils";
import { bashBackgroundInputSchema } from "../../src/tools/bash-background";
import { bashToolWithCwd } from "../../src/tools/bash";
import { createJobTool, formatJobToolArgs } from "../../src/tools/job";

const context = {
  requestId: "request",
  requestDeliveryId: "delivery",
  sessionId: "native:thread",
  requestClient: "native",
  currentTurnUserId: "user",
  currentTurnMessageRef: { platform: "native", channelId: "thread", messageId: "message" },
};

type ToolLike = { execute?: (input: never, options: never) => unknown };

describe("bash background and the job tool", () => {
  let dir: string;
  let workspace: string;
  let store: SqliteJobStore;
  let jobs: JobService;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "lilac-job-tool-"));
    workspace = realpathSync(mkdtempSync(path.join(tmpdir(), "lilac-job-workspace-")));
    store = new SqliteJobStore({ dbPath: path.join(dir, "jobs.db") });
    jobs = new JobService({ store, logDir: path.join(dir, "logs") });
  });

  afterEach(async () => {
    await jobs.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
    rmSync(resolveRestrictedSessionTmpDir(context.sessionId), { recursive: true, force: true });
  });

  function untilEnded(jobId: string): Promise<JobRecord> {
    return new Promise((resolve) => {
      const check = () => {
        const job = store.get(jobId).match({ ok: (value) => value, err: () => null });
        if (job && job.status !== "running" && job.status !== "starting") {
          unsubscribe();
          resolve(job);
        }
      };
      const unsubscribe = jobs.subscribe(check);
      check();
    });
  }

  function untilLogContains(jobId: string, text: string): Promise<void> {
    const logPath = path.join(dir, "logs", `${jobId}.log`);
    return new Promise((resolve) => {
      const poll = () => {
        if (existsSync(logPath) && readFileSync(logPath, "utf8").includes(text)) {
          resolve();
          return;
        }
        setImmediate(poll);
      };
      poll();
    });
  }

  function execute(tool: ToolLike, input: Record<string, unknown>, callContext: unknown) {
    return tool.execute!(
      input as never,
      { toolCallId: crypto.randomUUID(), messages: [], context: callContext } as never,
    ) as Promise<Record<string, any>>;
  }

  function bash(
    input: Record<string, unknown>,
    options: {
      context?: unknown;
      modes?: readonly ["await"] | readonly ["await", "service"];
      runProfile?: string;
    } = {},
  ) {
    const created = bashToolWithCwd(workspace, {
      background: {
        service: jobs,
        modes: options.modes ?? ["await", "service"],
        runProfile: options.runProfile ?? "primary",
      },
    }).bash;
    return execute(created, input, options.context ?? context);
  }

  function job(input: Record<string, unknown>, callContext: unknown = context) {
    return execute(createJobTool({ service: jobs }), input, callContext);
  }

  it("starts a job from bash, then lists, reads, and stops it with job", async () => {
    const started = await bash({
      command: "echo ready; sleep 60",
      background: "service",
      label: "dev server",
    });
    expect(started).toMatchObject({ exitCode: 0, job: { label: "dev server", mode: "service" } });
    const { jobId } = started["job"];
    expect(started["job"].status).toBe("running");
    expect(started["stdout"]).toContain(jobId);

    const listed = await job({ action: "list" });
    expect(listed["jobs"].map((entry: { jobId: string }) => entry.jobId)).toEqual([jobId]);

    await untilLogContains(jobId, "ready");
    const read = await job({ action: "read", jobId });
    expect(read["output"]).toBe("ready\n");

    const stopped = await job({ action: "stop", jobId });
    expect(stopped["job"].status).toBe("stopped");
  });

  it("labels a job with its command when no label is given", async () => {
    const started = await bash({ command: "sleep 60\necho later", background: "await" });
    expect(started["job"].label).toBe("sleep 60");
    await job({ action: "stop", jobId: started["job"].jobId });
  });

  it("returns a blocked Bash result for a command the guardrails refuse", async () => {
    const blocked = await bash({ command: "rm -rf /", background: "await" });
    expect(blocked).toMatchObject({ exitCode: -1, executionError: { type: "blocked" } });
    expect(blocked["job"]).toBeUndefined();
    expect(store.listActive().match({ ok: (values) => values.length, err: () => -1 })).toBe(0);
  });

  it("redacts secrets from a blocked command's segment", async () => {
    const token = `ghp_${"a".repeat(36)}`;
    const blocked = await bash({ command: `GH_TOKEN=${token} rm -rf /`, background: "await" });
    expect(blocked["executionError"]).toMatchObject({ type: "blocked" });
    expect(JSON.stringify(blocked)).not.toContain(token);
  });

  it("refuses SSH targets", async () => {
    await expect(
      bash({ command: "true", background: "await", cwd: "example-host:/srv/app" }),
    ).rejects.toThrow("SSH");
  });

  it("refuses a mode the session does not offer", async () => {
    await expect(
      bash({ command: "true", background: "service" }, { modes: ["await"] }),
    ).rejects.toThrow("service is unavailable");
  });

  it("offers only the session's modes in its input schema", () => {
    const awaitOnly = bashBackgroundInputSchema(["await"]);
    expect(awaitOnly.safeParse({ command: "true", background: "await" }).success).toBe(true);
    expect(awaitOnly.safeParse({ command: "true", background: "service" }).success).toBe(false);
  });

  it("runs a restricted session's job in restricted Bash", async () => {
    const restricted = { ...context, safetyMode: "restricted" };
    const started = await bash(
      { command: "printf sandboxed > out.txt; echo $PWD", background: "await" },
      { context: restricted, modes: ["await"] },
    );
    const ended = await untilEnded(started["job"].jobId);
    expect(ended).toMatchObject({ status: "exited", exitCode: 0, pid: null });
    const read = await job({ action: "read", jobId: ended.jobId });
    expect(read["output"]).toBe("/workspace\n");
    expect(readFileSync(path.join(workspace, "out.txt"), "utf8")).toBe("sandboxed");
  });

  it("refuses a request from an unsupported surface", async () => {
    await expect(job({ action: "list" }, { ...context, requestClient: "slack" })).rejects.toThrow(
      "supported surface",
    );
  });

  it("keeps a plain bash call in the foreground", async () => {
    const result = await bash({ command: "echo now" });
    expect(result).toMatchObject({ stdout: "now\n", exitCode: 0 });
    expect(result["job"]).toBeUndefined();
  });

  it("formats its arguments for display", () => {
    expect(formatJobToolArgs({ action: "read", jobId: "job_1" })).toBe("read job_1");
    expect(formatJobToolArgs({ action: "list" })).toBe("list");
    expect(formatJobToolArgs({ action: "start", label: "build" })).toBe("job");
  });
});
