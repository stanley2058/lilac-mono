import { describe, expect, it } from "bun:test";

import { DurableWorkflowStore } from "../../src/workflow/durable-workflow-store";
import {
  deleteWorkflowArtifactIfUnreferenced,
  readWorkflowValueArtifact,
  writeWorkflowValueArtifact,
  WorkflowArtifactValueTooLarge,
} from "../../src/workflow/workflow-artifact-store";
import { createWorkflowTestBlobStore } from "./workflow-test-blob-store";
import type { JsonValue } from "../../src/workflow/workflow-domain";

describe("workflow artifact store", () => {
  it("stores one durable blob for one content-addressed value identity", async () => {
    const blobStore = await createWorkflowTestBlobStore();
    const workflowStore = new DurableWorkflowStore(":memory:");
    const value: JsonValue = { nested: ["same", 1, true] };

    const first = await writeWorkflowValueArtifact({
      blobStore,
      workflowStore,
      value,
      maxBytes: 4_096,
      now: () => 10,
    });
    const second = await writeWorkflowValueArtifact({
      blobStore,
      workflowStore,
      value,
      maxBytes: 4_096,
      now: () => 20,
    });

    expect(first.status).toBe("ok");
    expect(second.status).toBe("ok");
    if (first.status === "error" || second.status === "error") return;
    expect(second.value).toEqual(first.value);
    expect(workflowStore.getWorkflowArtifact(first.value.artifactId).unwrap()).toEqual(first.value);

    const read = await readWorkflowValueArtifact({
      blobStore,
      reference: first.value,
      maxBytes: 4_096,
    });
    expect(read.unwrap()).toEqual(value);
    workflowStore.close();
  });

  it("keeps the canonical value size contract", async () => {
    const blobStore = await createWorkflowTestBlobStore();
    const workflowStore = new DurableWorkflowStore(":memory:");
    const written = await writeWorkflowValueArtifact({
      blobStore,
      workflowStore,
      value: "too large",
      maxBytes: 1,
    });
    expect(written.status).toBe("error");
    if (written.status === "error")
      expect(written.error).toBeInstanceOf(WorkflowArtifactValueTooLarge);
    workflowStore.close();
  });

  it("removes registry ownership before deleting an unreferenced blob", async () => {
    const blobStore = await createWorkflowTestBlobStore();
    const workflowStore = new DurableWorkflowStore(":memory:");
    const written = await writeWorkflowValueArtifact({
      blobStore,
      workflowStore,
      value: "orphan",
      maxBytes: 1_024,
    });
    if (written.status === "error") throw written.error;

    const deleted = await deleteWorkflowArtifactIfUnreferenced({
      blobStore,
      workflowStore,
      artifactId: written.value.artifactId,
    });
    expect(deleted.unwrap()).toBe("deleted");
    expect(workflowStore.getWorkflowArtifact(written.value.artifactId).unwrap()).toBeNull();
    expect((await blobStore.open(written.value.blobRef)).status).toBe("error");
    workflowStore.close();
  });
});
