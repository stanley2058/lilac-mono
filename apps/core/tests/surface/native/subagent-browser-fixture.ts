import { writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { Result } from "better-result";
import { createNativeIntegrationFixture, integrationValue } from "./integration-fixture";
import { seedNativeSubagent } from "./subagent-fixture";

const fixture = await createNativeIntegrationFixture({
  port: 8791,
  allowedOrigins: ["http://127.0.0.1:5175", "http://127.0.0.1:8791"],
});
await writeFile(
  path.join(fixture.workspaceRoot, "report.html"),
  "<!doctype html><html><body><h1>Verified report</h1><p>Child previews share the parent resource permissions.</p></body></html>",
);
const thread = fixture.store
  .createThread("owner", { commandId: "stream-browser", title: "Shared agent streams" })
  .unwrap();
const receipt = fixture.store
  .acceptInput("owner", {
    threadId: thread.id,
    commandId: "stream-browser-prompt",
    historyGeneration: 0,
    text: "Check the sources and prepare the report.",
    mode: "prompt",
    attachmentIds: [],
    skillIds: [],
  })
  .unwrap();
fixture.store.settleInput(receipt.inputId, "admitted").unwrap();
fixture.store.markInputCompleted(receipt.inputId).unwrap();
const child = seedNativeSubagent(fixture.store, fixture.workflows, thread.id, { id: "browser" });
fixture.store
  .appendMessage(thread.id, 0, receipt.turnId!, {
    id: "browser_spawn",
    role: "assistant",
    parts: [
      {
        type: "data-activity",
        id: createHash("sha256").update(child.parentToolCallId).digest("hex").slice(0, 24),
        data: { kind: "tool", label: "subagent_delegate", state: "complete" },
      },
    ],
  })
  .unwrap();
fixture.store
  .projectTurn(thread.id, 0, "browser_parent_complete", receipt.turnId!, (slot) =>
    Result.ok({
      slot: { ...slot, state: "complete" },
      changes: [
        { kind: "turn-state", turnId: slot.turnId, position: slot.position, state: "complete" },
      ],
    }),
  )
  .unwrap();
const publisher = fixture.runtime.createOutput({
  getSafetyMode: () => "trusted",
  workflowRunId: child.run.runId,
  sessionId: child.sessionId,
  requestId: child.requestId,
  requestClient: "unknown",
  prompt: "Check the sources and prepare the report.",
})!;
publisher.activity({
  activityId: "think_one",
  stepId: "step",
  kind: "thinking",
  state: "complete",
  detail: "Checking the source material",
});
publisher.activity({
  activityId: "command_one",
  stepId: "step",
  kind: "tool",
  state: "complete",
  label: "bash tools fetch 'https://example.com/source'",
  output: "Source retrieved",
  exitCode: 0,
  durationMs: 180,
});
publisher.activity({
  activityId: "think_two",
  stepId: "step",
  kind: "thinking",
  state: "complete",
  detail: "Building the report",
});
publisher.activity({
  activityId: "command_two",
  stepId: "step",
  kind: "tool",
  state: "start",
  label: "bash cat report.md",
  detail: "bash cat report.md",
});
integrationValue(await publisher.captureBarrier());
let stage = 0;
const control = Bun.serve({
  hostname: "127.0.0.1",
  port: 8792,
  async fetch(request) {
    if (request.method !== "POST") return new Response("POST required", { status: 405 });
    if (new URL(request.url).pathname === "/complete") {
      publisher.activity({
        activityId: "command_two",
        stepId: "step",
        kind: "tool",
        state: "complete",
        label: "bash cat report.md",
        output: "Report verified",
        exitCode: 0,
        durationMs: 50,
      });
      publisher.textStart({ partId: "final", stepId: "step", phase: "final_answer" });
      publisher.textDelta(
        "final",
        "The report is ready. All sources have been checked.\n\n```html-preview-file\nreport.html\n```",
      );
      integrationValue(await publisher.terminal("complete"));
      fixture.workflows.transitionRun({
        runId: child.run.runId,
        from: "running",
        to: "succeeded",
        now: Date.now(),
      });
    } else {
      stage++;
      publisher.activity({
        activityId: `live_${stage}`,
        stepId: "step",
        kind: "thinking",
        state: "complete",
        detail: `Verifying section ${stage}`,
      });
      publisher.activity({
        activityId: `command_${stage}`,
        stepId: "step",
        kind: "tool",
        state: "complete",
        label: `bash cat section-${stage}.md`,
        output: "Section checked",
        exitCode: 0,
        durationMs: 15,
      });
      integrationValue(await publisher.captureBarrier());
    }
    return Response.json({ stage });
  },
});
console.info(
  JSON.stringify({ url: `http://127.0.0.1:5175/threads/${thread.id}`, threadId: thread.id }),
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    control.stop(true);
    void fixture.close().then(() => process.exit(0));
  });
