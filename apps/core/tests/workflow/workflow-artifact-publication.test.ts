import { afterEach, describe, expect, it, spyOn } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  BlobAdapterFailure,
  createLocalBlobStore,
  type BlobStore,
} from "@stanley2058/lilac-blob-storage";
import { Result } from "better-result";
import { MemoryBlobBackend } from "../../../../packages/blob-storage/src/memory-backend";
import { SupervisedBlobStore } from "../../../../packages/blob-storage/src/store";
import { DurableWorkflowStore } from "../../src/workflow/durable-workflow-store";
import { encodeWorkflowValueArtifact } from "../../src/workflow/workflow-artifact-persistence-codec";
import {
  maintainWorkflowArtifactPublications,
  readWorkflowValueArtifact,
  writeWorkflowValueArtifact,
} from "../../src/workflow/workflow-artifact-store";
import type { WorkflowArtifactReference } from "../../src/workflow/workflow-domain";

const roots: string[] = [];
const openStores = new Set<{ blobStore: BlobStore; workflowStore: DurableWorkflowStore }>();
afterEach(async () => {
  for (const stores of openStores) {
    stores.workflowStore.close();
    (await stores.blobStore.close({ deadlineAtMs: Date.now() + 1_000 })).unwrap();
  }
  openStores.clear();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function open(root?: string) {
  if (root === undefined) {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-publication-"));
    roots.push(root);
  }
  const blobStore = (await createLocalBlobStore({ root: path.join(root, "blobs") })).unwrap();
  const workflowStore = new DurableWorkflowStore(path.join(root, "workflow.db"));
  const stores = { root, blobStore, workflowStore };
  openStores.add(stores);
  return stores;
}

async function reopen(stores: Awaited<ReturnType<typeof open>>) {
  stores.workflowStore.close();
  (await stores.blobStore.close({ deadlineAtMs: Date.now() + 1_000 })).unwrap();
  openStores.delete(stores);
  return open(stores.root);
}

async function stage(
  blobStore: BlobStore,
  stagingExpiresAt = Date.now() + 60_000,
): Promise<WorkflowArtifactReference> {
  const encoded = encodeWorkflowValueArtifact({ value: "recover me" });
  const source = new TextEncoder().encode(encoded.encoded);
  const upload = (
    await blobStore.startStagedUpload({
      source,
      stagingExpiresAt,
      expectedSha256: Bun.CryptoHasher.hash("sha256", source, "hex"),
      expectedByteLength: source.byteLength,
    })
  ).unwrap();
  const blobRef = (await upload.completion).unwrap();
  return { artifactId: `workflow-value:${encoded.payloadHash}`, blobRef };
}

describe("workflow artifact publication recovery", () => {
  for (const phase of ["intent", "adoption", "registration"] as const) {
    it(`recovers after process loss at ${phase}`, async () => {
      let stores = await open();
      const reference = await stage(stores.blobStore);
      stores.workflowStore.beginWorkflowArtifactPublication(reference, 10).unwrap();
      if (phase !== "intent")
        (
          await stores.blobStore.adopt({ version: 1, objectId: reference.blobRef.objectId })
        ).unwrap();
      if (phase === "registration")
        stores.workflowStore.completeWorkflowArtifactPublication(reference, 10).unwrap();
      stores = await reopen(stores);

      (await maintainWorkflowArtifactPublications(stores)).unwrap();
      expect(stores.workflowStore.getWorkflowArtifact(reference.artifactId).unwrap()).toEqual(
        reference,
      );
      expect(stores.workflowStore.listWorkflowArtifactPublications().unwrap()).toEqual([]);
      expect(
        (await readWorkflowValueArtifact({ ...stores, reference, maxBytes: 1_024 })).unwrap(),
      ).toEqual({ value: "recover me" });
    });
  }

  it("expires staging left before publication ownership was persisted", async () => {
    let stores = await open();
    const deadline = Date.now() + 60_000;
    const reference = await stage(stores.blobStore, deadline);
    stores = await reopen(stores);
    expect((await stores.blobStore.maintain({ now: deadline + 1 })).unwrap().deleted).toBe(1);
    expect((await maintainWorkflowArtifactPublications(stores)).unwrap().inspected).toBe(0);
    expect((await stores.blobStore.open(reference.blobRef)).isErr()).toBe(true);
  });

  it("keeps a canonical artifact when an adopter wins against concurrent deadline recovery", async () => {
    const backend = new MemoryBlobBackend();
    const blobStore = new SupervisedBlobStore(backend);
    const workflowStore = new DurableWorkflowStore(":memory:");
    const stores = { blobStore, workflowStore };
    openStores.add(stores);
    const deadline = Date.now() + 60_000;
    const reference = await stage(blobStore, deadline);
    workflowStore.beginWorkflowArtifactPublication(reference, 10).unwrap();

    const adoptionStarted = Promise.withResolvers<void>();
    const resumeAdoption = Promise.withResolvers<void>();
    const expiryStarted = Promise.withResolvers<void>();
    const resumeExpiry = Promise.withResolvers<void>();
    const compareAndSwap = backend.compareAndSwapReservation.bind(backend);
    backend.compareAndSwapReservation = async (objectId, expected, next) => {
      if (next.includes('"state":"ready"')) {
        adoptionStarted.resolve();
        await resumeAdoption.promise;
      }
      if (next.includes('"state":"deleted"')) {
        expiryStarted.resolve();
        await resumeExpiry.promise;
      }
      return compareAndSwap(objectId, expected, next);
    };
    const deleteBlob = blobStore.delete.bind(blobStore);
    blobStore.delete = async (target) => {
      expiryStarted.resolve();
      await resumeExpiry.promise;
      return deleteBlob(target);
    };

    const adopter = maintainWorkflowArtifactPublications(stores);
    await adoptionStarted.promise;
    const now = spyOn(Date, "now").mockReturnValue(deadline + 1);
    try {
      const expirer = maintainWorkflowArtifactPublications(stores);
      await expiryStarted.promise;
      resumeAdoption.resolve();
      expect((await adopter).unwrap().recovered).toBe(1);
      resumeExpiry.resolve();
      (await expirer).unwrap();

      expect(workflowStore.getWorkflowArtifact(reference.artifactId).unwrap()).toEqual(reference);
      expect(workflowStore.listWorkflowArtifactPublications().unwrap()).toEqual([]);
      expect(
        (await readWorkflowValueArtifact({ ...stores, reference, maxBytes: 1_024 })).unwrap(),
      ).toEqual({ value: "recover me" });
    } finally {
      now.mockRestore();
      resumeAdoption.resolve();
      resumeExpiry.resolve();
    }
  });

  it("retires an intent whose staging expired before adoption", async () => {
    const stores = await open();
    const deadline = Date.now() + 60_000;
    const reference = await stage(stores.blobStore, deadline);
    stores.workflowStore.beginWorkflowArtifactPublication(reference, 10).unwrap();
    (await stores.blobStore.maintain({ now: deadline + 1 })).unwrap();
    expect((await maintainWorkflowArtifactPublications(stores)).unwrap().discarded).toBe(1);
    expect(stores.workflowStore.listWorkflowArtifactPublications().unwrap()).toEqual([]);
    expect(stores.workflowStore.getWorkflowArtifact(reference.artifactId).unwrap()).toBeNull();
  });

  it("retains failed duplicate cleanup across reopening", async () => {
    let stores = await open();
    const winner = (
      await writeWorkflowValueArtifact({
        ...stores,
        value: { value: "recover me" },
        maxBytes: 1_024,
      })
    ).unwrap();
    const loser = await stage(stores.blobStore);
    stores.workflowStore.beginWorkflowArtifactPublication(loser, 10).unwrap();
    (await stores.blobStore.adopt({ version: 1, objectId: loser.blobRef.objectId })).unwrap();
    const remove = stores.blobStore.delete.bind(stores.blobStore);
    stores.blobStore.delete = async () =>
      Result.err(
        new BlobAdapterFailure({
          adapter: "local",
          kind: "io",
          operation: "delete",
          message: "injected cleanup failure",
        }),
      );
    expect((await maintainWorkflowArtifactPublications(stores)).isErr()).toBe(true);
    expect(stores.workflowStore.listWorkflowArtifactPublications().unwrap()).toEqual([loser]);
    stores.blobStore.delete = remove;
    stores = await reopen(stores);
    (await maintainWorkflowArtifactPublications(stores)).unwrap();
    expect(stores.workflowStore.listWorkflowArtifactPublications().unwrap()).toEqual([]);
    expect((await stores.blobStore.open(loser.blobRef)).isErr()).toBe(true);
    expect(
      (await readWorkflowValueArtifact({ ...stores, reference: winner, maxBytes: 1_024 })).unwrap(),
    ).toEqual({ value: "recover me" });
  });

  it("concurrent duplicate writers return the same canonical artifact", async () => {
    const stores = await open();
    const originalStage = stores.blobStore.startStagedUpload.bind(stores.blobStore);
    const bothStaged = Promise.withResolvers<void>();
    const candidates: WorkflowArtifactReference["blobRef"][] = [];
    stores.blobStore.startStagedUpload = async (input) => {
      const started = await originalStage(input);
      const upload = started.unwrap();
      candidates.push((await upload.completion).unwrap());
      if (candidates.length === 2) bothStaged.resolve();
      await bothStaged.promise;
      return started;
    };
    const writes = await Promise.all(
      [1, 2].map(() =>
        writeWorkflowValueArtifact({
          ...stores,
          value: { concurrent: true },
          maxBytes: 1_024,
        }),
      ),
    );
    const first = writes[0]!.unwrap();
    expect(writes[1]!.unwrap()).toEqual(first);
    expect(stores.workflowStore.listWorkflowArtifactPublications().unwrap()).toEqual([]);
    for (const candidate of candidates) {
      expect((await stores.blobStore.open(candidate)).isOk()).toBe(
        candidate.objectId === first.blobRef.objectId,
      );
    }
  });
  it("returns a concurrent canonical winner when recovery deletes the paused writer's duplicate", async () => {
    const stores = await open();
    const originalOpen = stores.blobStore.open.bind(stores.blobStore);
    const verifying = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    let paused = false;
    stores.blobStore.open = async (reference) => {
      if (!paused) {
        paused = true;
        verifying.resolve();
        await resume.promise;
      }
      return originalOpen(reference);
    };
    const written = writeWorkflowValueArtifact({
      ...stores,
      value: { value: "recover me" },
      maxBytes: 1_024,
    });
    await verifying.promise;
    const winner = await stage(stores.blobStore);
    stores.workflowStore.beginWorkflowArtifactPublication(winner, 10).unwrap();
    (await stores.blobStore.adopt({ version: 1, objectId: winner.blobRef.objectId })).unwrap();
    stores.workflowStore.completeWorkflowArtifactPublication(winner, 10).unwrap();
    (await maintainWorkflowArtifactPublications(stores)).unwrap();
    resume.resolve();
    expect((await written).unwrap()).toEqual(winner);
    expect(stores.workflowStore.listWorkflowArtifactPublications().unwrap()).toEqual([]);
  });
});
