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
});
