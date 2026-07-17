import { lilacEventTypes, type LilacBus } from "@stanley2058/lilac-event-bus";
import { createLogger } from "@stanley2058/lilac-utils";

import { DEFAULT_MAX_ACTIVE_WORKFLOW_RUNS, DurableWorkflowStore } from "./durable-workflow-store";
import { computeNextCronAtMs } from "./cron";
import { sha256 } from "./workflow-definition";
import type { WorkflowRun, WorkflowTrigger } from "./workflow-domain";
import type { WorkflowProgressCardService } from "./workflow-progress-projector";

const TERMINAL_RUN_STATES = new Set(["succeeded", "failed", "cancelled"]);

export class WorkflowTriggerScheduler {
  private readonly logger = createLogger({ module: "workflow-trigger-scheduler" });
  private readonly workerId = `workflow-trigger-scheduler:${process.pid}:${crypto.randomUUID()}`;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly input: {
      bus: LilacBus;
      store: DurableWorkflowStore;
      progressCards?: WorkflowProgressCardService;
      now?: () => number;
      pollMs?: number;
      getMaxActiveRuns?: () => number | Promise<number>;
    },
  ) {}

  async start(): Promise<void> {
    this.timer = setInterval(() => void this.tick(), this.input.pollMs ?? 500);
    this.timer.unref?.();
    await this.tick();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const now = this.input.now?.() ?? Date.now();
      this.reconcileTimestampCompletion(now);
      for (const trigger of this.input.store.listTriggers({ state: "active", dueBefore: now })) {
        const claimed = this.input.store.tryClaimDueTrigger({
          triggerId: trigger.triggerId,
          claimerId: this.workerId,
          now,
        });
        if (claimed) await this.fire(claimed, now);
      }
    } catch (error) {
      this.logger.error("Workflow trigger reconciliation failed", error);
    } finally {
      this.running = false;
    }
  }

  private reconcileTimestampCompletion(now: number): void {
    for (const trigger of this.input.store.listTriggers({ state: "active", limit: 1_000 })) {
      if (
        trigger.definition.kind !== "timestamp" ||
        trigger.nextFireAt !== null ||
        !trigger.lastRunId
      ) {
        continue;
      }
      const run = this.input.store.getRun(trigger.lastRunId);
      if (!run || !TERMINAL_RUN_STATES.has(run.state)) continue;
      this.input.store.transitionTrigger({
        triggerId: trigger.triggerId,
        from: "active",
        to: "completed",
        now,
      });
    }
  }

  private async fire(trigger: WorkflowTrigger, now: number): Promise<void> {
    const revision = this.input.store.getRevision(trigger.revisionId);
    const fireAt = trigger.nextFireAt;
    if (!revision || fireAt === null) return;
    const nextFireAt =
      trigger.definition.kind === "cron"
        ? computeNextCronAtMs(
            {
              expr: trigger.definition.expression,
              tz: trigger.definition.timezone ?? undefined,
            },
            (trigger.schedulingPolicy.skipMissed ? now : fireAt) + 1,
          )
        : null;
    const runId = `wfrun:${sha256(`${trigger.triggerId}:${fireAt}`)}`;
    const run: WorkflowRun = {
      runId,
      revisionId: revision.revisionId,
      state: "queued",
      inputSchemaSnapshot: revision.inputSchema,
      args: trigger.args,
      argsSha256: trigger.argsSha256,
      origin: trigger.origin,
      completionTarget: trigger.completionTarget,
      progressTarget: trigger.progressTarget,
      terminalDetail: null,
      result: null,
      resultArtifactId: null,
      claimedBy: null,
      claimedAt: null,
      createdAt: now,
      startedAt: null,
      updatedAt: now,
      terminalAt: null,
    };
    const maxActiveRuns =
      (await this.input.getMaxActiveRuns?.()) ?? DEFAULT_MAX_ACTIVE_WORKFLOW_RUNS;
    const fired = this.input.store.fireClaimedTrigger({
      triggerId: trigger.triggerId,
      claimerId: this.workerId,
      expectedFireAt: fireAt,
      nextFireAt,
      run,
      maxActiveRuns,
      now,
    });
    if (!fired || fired.status === "skipped") return;
    if (fired.run.progressTarget && this.input.progressCards) {
      await this.input.progressCards.ensureInitialCard(fired.run.runId).catch((error: unknown) => {
        this.logger.warn("Scheduled workflow progress card creation failed", {
          runId: fired.run.runId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
    await this.input.bus.publish(lilacEventTypes.EvtWorkflowRunChanged, {
      runId: fired.run.runId,
      revisionId: fired.run.revisionId,
      state: fired.run.state,
      ts: now,
    });
    await this.input.bus.publish(lilacEventTypes.EvtWorkflowProgressRequested, {
      runId: fired.run.runId,
      revisionId: fired.run.revisionId,
      reason: "created",
      ts: now,
    });
  }
}
