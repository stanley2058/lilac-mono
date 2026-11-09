import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { JobService } from "../../src/jobs/job-service";
import { SqliteJobStore } from "../../src/jobs/job-store";
import { createJobTool, formatJobToolArgs } from "../../src/tools/job";

const context = {
  requestId: "request",
  requestDeliveryId: "delivery",
  sessionId: "native:thread",
  requestClient: "native",
  currentTurnUserId: "user",
  currentTurnMessageRef: { platform: "native", channelId: "thread", messageId: "message" },
};

describe("job tool", () => {
  let dir: string;
  let store: SqliteJobStore;
  let jobs: JobService;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "lilac-job-tool-"));
    store = new SqliteJobStore({ dbPath: path.join(dir, "jobs.db") });
    jobs = new JobService({ store, logDir: path.join(dir, "logs") });
  });

  afterEach(async () => {
    await jobs.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

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

  function call(input: Record<string, unknown>, overrides: { context?: unknown } = {}) {
    const created = createJobTool({ service: jobs, defaultCwd: tmpdir(), runProfile: "primary" });
    return created.execute!(
      input as never,
      {
        toolCallId: crypto.randomUUID(),
        messages: [],
        context: overrides.context ?? context,
      } as never,
    ) as unknown as Promise<Record<string, any>>;
  }

  it("starts, lists, reads, and stops a job", async () => {
    const started = await call({
      action: "start",
      mode: "service",
      label: "dev server",
      command: "echo ready; sleep 60",
    });
    const { jobId } = started["job"];
    expect(started["job"].status).toBe("running");

    const listed = await call({ action: "list" });
    expect(listed["jobs"].map((job: { jobId: string }) => job.jobId)).toEqual([jobId]);

    await untilLogContains(jobId, "ready");
    const read = await call({ action: "read", jobId });
    expect(read["output"]).toBe("ready\n");

    const stopped = await call({ action: "stop", jobId });
    expect(stopped["job"].status).toBe("stopped");
  });

  it("applies foreground Bash's guardrails", async () => {
    const blocked = await call({
      action: "start",
      mode: "await",
      label: "cleanup",
      command: "rm -rf /",
    });
    expect(blocked["blocked"]).toBe(true);
    expect(store.listActive().match({ ok: (values) => values.length, err: () => -1 })).toBe(0);
  });

  it("refuses SSH targets", async () => {
    const blocked = await call({
      action: "start",
      mode: "await",
      label: "remote",
      command: "true",
      cwd: "example-host:/srv/app",
    });
    expect(blocked["blocked"]).toBe(true);
    expect(blocked["message"]).toContain("SSH");
  });

  it("names the field a start is missing", async () => {
    await expect(call({ action: "start", command: "true", label: "x" })).rejects.toThrow(
      "job start requires mode",
    );
  });

  it("refuses a request from an unsupported surface", async () => {
    await expect(
      call({ action: "list" }, { context: { ...context, requestClient: "github" } }),
    ).rejects.toThrow("native or Discord");
  });

  it("formats its arguments for display", () => {
    expect(formatJobToolArgs({ action: "start", label: "build" })).toBe("start build");
    expect(formatJobToolArgs({ action: "stop", jobId: "job_1" })).toBe("stop job_1");
    expect(formatJobToolArgs({ nonsense: true })).toBe("job");
  });
});
