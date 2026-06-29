import { describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";

import { SqliteWorkflowStore } from "../../src/workflow/workflow-store";

function getUnsafeDb(store: SqliteWorkflowStore): Database {
  return (store as unknown as { db: Database }).db;
}

describe("SqliteWorkflowStore", () => {
  it("throws contextual errors for malformed workflow JSON", () => {
    const store = new SqliteWorkflowStore(":memory:");
    store.upsertWorkflow({
      workflowId: "wf_bad",
      state: "queued",
      createdAt: 1,
      updatedAt: 1,
      definition: {
        version: 2,
        origin: {
          request_id: "req:test",
          session_id: "s",
          request_client: "discord",
        },
        resumeTarget: {
          session_id: "s",
          request_client: "discord",
        },
        summary: "test",
        completion: "all",
      },
      resumeSeq: 0,
    });

    getUnsafeDb(store)
      .query("UPDATE workflows SET definition_json = ? WHERE workflow_id = ?")
      .run("{", "wf_bad");

    expect(() => store.getWorkflow("wf_bad")).toThrow(
      "Failed to parse workflow JSON (field=workflows.definition_json workflowId=wf_bad)",
    );
  });

  it("filters malformed workflow JSON from list paths", () => {
    const store = new SqliteWorkflowStore(":memory:");
    for (const workflowId of ["wf_good", "wf_bad"]) {
      store.upsertWorkflow({
        workflowId,
        state: "queued",
        createdAt: 1,
        updatedAt: 1,
        definition: {
          version: 2,
          origin: {
            request_id: `req:${workflowId}`,
            session_id: "s",
            request_client: "discord",
          },
          resumeTarget: {
            session_id: "s",
            request_client: "discord",
          },
          summary: workflowId,
          completion: "all",
        },
        resumeSeq: 0,
      });
    }

    getUnsafeDb(store)
      .query("UPDATE workflows SET definition_json = ? WHERE workflow_id = ?")
      .run("{", "wf_bad");

    expect(store.listWorkflows().map((workflow) => workflow.workflowId)).toEqual(["wf_good"]);
  });

  it("fills workflow list pages after filtering malformed rows", () => {
    const store = new SqliteWorkflowStore(":memory:");
    for (const [index, workflowId] of ["wf_bad", "wf_good"].entries()) {
      store.upsertWorkflow({
        workflowId,
        state: "queued",
        createdAt: index + 1,
        updatedAt: 100 - index,
        definition: {
          version: 2,
          origin: {
            request_id: `req:${workflowId}`,
            session_id: "s",
            request_client: "discord",
          },
          resumeTarget: {
            session_id: "s",
            request_client: "discord",
          },
          summary: workflowId,
          completion: "all",
        },
        resumeSeq: 0,
      });
    }

    getUnsafeDb(store)
      .query("UPDATE workflows SET definition_json = ? WHERE workflow_id = ?")
      .run("{", "wf_bad");

    expect(store.listWorkflows({ limit: 1 }).map((workflow) => workflow.workflowId)).toEqual([
      "wf_good",
    ]);
    expect(store.listWorkflows({ limit: 1, offset: 1 })).toEqual([]);
  });

  it("keeps state-machine task reads fail-fast but filters malformed task rows from query paths", () => {
    const store = new SqliteWorkflowStore(":memory:");
    store.upsertWorkflow({
      workflowId: "wf",
      state: "blocked",
      createdAt: 1,
      updatedAt: 1,
      definition: {
        version: 2,
        origin: {
          request_id: "req:test",
          session_id: "s",
          request_client: "discord",
        },
        resumeTarget: {
          session_id: "s",
          request_client: "discord",
        },
        summary: "test",
        completion: "all",
      },
      resumeSeq: 0,
    });

    store.upsertTask({
      workflowId: "wf",
      taskId: "bad",
      kind: "discord.wait_for_reply",
      description: "bad row",
      state: "queued",
      input: {
        channelId: "c",
        messageId: "m-bad",
      },
      createdAt: 1,
      updatedAt: 1,
      discordChannelId: "c",
      discordMessageId: "m-bad",
      timeoutAt: 10,
    });
    store.upsertTask({
      workflowId: "wf",
      taskId: "good",
      kind: "discord.wait_for_reply",
      description: "good row",
      state: "queued",
      input: {
        channelId: "c",
        messageId: "m-good",
      },
      createdAt: 2,
      updatedAt: 2,
      discordChannelId: "c",
      discordMessageId: "m-good",
      timeoutAt: 10,
    });

    getUnsafeDb(store)
      .query("UPDATE workflow_tasks SET input_json = ? WHERE workflow_id = ? AND task_id = ?")
      .run("{", "wf", "bad");

    expect(() => store.getTask("wf", "bad")).toThrow(
      "Failed to parse workflow JSON (field=workflow_tasks.input_json workflowId=wf taskId=bad)",
    );
    expect(() => store.listTasks("wf")).toThrow(
      "Failed to parse workflow JSON (field=workflow_tasks.input_json workflowId=wf taskId=bad)",
    );
    expect(
      store.unsafeListActiveDiscordWaitForReplyTasksByChannelId("c").map((task) => task.taskId),
    ).toEqual(["good"]);
    expect(store.unsafeListActiveTimeoutTasks(10).map((task) => task.taskId)).toEqual(["good"]);
  });
});
