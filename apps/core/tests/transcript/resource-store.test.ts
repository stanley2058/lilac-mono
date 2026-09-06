import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { StoredMessageV1 } from "@stanley2058/lilac-event-bus";
import { Panic, type Result as ResultType } from "better-result";

import type { ResourceCacheV1, ResourceId } from "../../src/resource/contracts";
import {
  CORE_SURFACE_PROJECTION_FORMAT_VERSION,
  SqliteTranscriptStore,
} from "../../src/transcript/transcript-store";

function value<T, E>(result: ResultType<T, E>): T {
  if (result.status === "error") throw result.error;
  return result.value;
}

function resourceId(hexPair: string): ResourceId {
  return `r1_${hexPair.repeat(16)}`;
}

function resourceMessage(id: ResourceId, filename = "notes.txt"): StoredMessageV1 {
  return {
    role: "user",
    content: [
      { type: "text", text: "inspect" },
      {
        type: "resource",
        uri: `resource://${id}`,
        filename,
        mediaType: "text/plain",
        size: 7,
      },
    ],
  };
}

function register(store: SqliteTranscriptStore, id: ResourceId, messageId = "message") {
  return value(
    store.registerOrGet({
      candidateResourceId: id,
      origin: {
        version: 1,
        kind: "discord-attachment",
        channelId: "channel",
        messageId,
        ordinal: 0,
        attachmentId: `attachment-${messageId}`,
      },
      filename: "notes.txt",
      declaredMediaType: "text/plain",
      reportedByteLength: 7,
      createdAt: 1,
    }),
  );
}

const cache: ResourceCacheV1 = {
  blob: {
    version: 1,
    objectId: `b1_${"34".repeat(16)}`,
    sha256: "56".repeat(32),
    byteLength: 7,
  },
  cachedAt: 2,
};

describe("Core resource SQLite store", () => {
  it("registers a stable canonical origin and resolves only retained records", () => {
    const store = new SqliteTranscriptStore(":memory:");
    const id = resourceId("12");
    expect(register(store, id)).toEqual({
      kind: "created",
      record: expect.objectContaining({ resourceId: id, filename: "notes.txt" }),
    });
    expect(store.getRetained(id)).toMatchObject({ status: "ok", value: null });

    const reused = value(
      store.registerOrGet({
        candidateResourceId: resourceId("13"),
        origin: {
          version: 1,
          kind: "discord-attachment",
          channelId: "channel",
          messageId: "message",
          ordinal: 0,
          attachmentId: "attachment-message",
        },
        filename: "edited-name.txt",
        declaredMediaType: "text/plain",
        reportedByteLength: 9,
        createdAt: 9,
      }),
    );
    expect(reused.kind).toBe("existing");
    if (reused.kind !== "collision") expect(reused.record.resourceId).toBe(id);
    expect(
      value(
        store.registerOrGet({
          candidateResourceId: id,
          origin: {
            version: 1,
            kind: "discord-attachment",
            channelId: "channel",
            messageId: "different-message",
            ordinal: 0,
          },
          createdAt: 10,
        }),
      ),
    ).toEqual({ kind: "collision" });

    value(
      store.saveRequestTranscript({
        requestId: "request",
        sessionId: "session",
        requestClient: "discord",
        messages: [resourceMessage(id)],
      }),
    );
    expect(value(store.getRetained(id))?.resourceId).toBe(id);
    store.close();
  });

  it("atomically replaces transcript references and rejects an unknown resource", () => {
    const store = new SqliteTranscriptStore(":memory:");
    const id = resourceId("21");
    register(store, id);
    value(
      store.saveRequestTranscript({
        requestId: "request",
        sessionId: "session",
        requestClient: "discord",
        messages: [resourceMessage(id)],
      }),
    );

    const missingId = resourceId("22");
    expect(
      store.saveRequestTranscript({
        requestId: "request",
        sessionId: "session",
        requestClient: "discord",
        messages: [resourceMessage(missingId)],
      }).status,
    ).toBe("error");
    expect(value(store.getRequestTranscript({ requestId: "request" }))?.messages).toEqual([
      resourceMessage(id),
    ]);
    expect(value(store.getRetained(id))?.resourceId).toBe(id);

    value(
      store.saveRequestTranscript({
        requestId: "request",
        sessionId: "session",
        requestClient: "discord",
        messages: [{ role: "user", content: "replacement" }],
      }),
    );
    expect(value(store.getRetained(id))).toBeNull();
    expect(value(store.listUnretained({ limit: 10 })).map((record) => record.resourceId)).toEqual([
      id,
    ]);
    store.close();
  });

  it("supports cache CAS, detected media CAS, and final-reference cleanup", () => {
    const store = new SqliteTranscriptStore(":memory:");
    const id = resourceId("31");
    register(store, id);
    value(
      store.saveRequestTranscript({
        requestId: "request",
        sessionId: "session",
        requestClient: "discord",
        messages: [resourceMessage(id)],
      }),
    );

    expect(
      value(
        store.compareAndSwapCache({
          resourceId: id,
          next: cache,
          detectedMediaType: "text/plain",
        }),
      ),
    ).toMatchObject({ kind: "attached", record: { cache, detectedMediaType: "text/plain" } });
    expect(value(store.clearCache({ resourceId: id, expected: { ...cache, cachedAt: 3 } }))).toBe(
      false,
    );
    expect(value(store.clearCache({ resourceId: id, expected: cache }))).toBe(true);
    expect(
      value(
        store.compareAndSwapCache({
          resourceId: id,
          next: cache,
          detectedMediaType: "text/plain",
        }),
      ).kind,
    ).toBe("attached");
    expect(
      value(
        store.compareAndSwapCache({
          resourceId: id,
          next: { ...cache, cachedAt: 3 },
        }),
      ).kind,
    ).toBe("lost");
    expect(
      value(
        store.recordDetectedMediaType({
          resourceId: id,
          expected: "application/pdf",
          next: "image/png",
        }),
      ),
    ).toBe(false);

    value(
      store.saveRequestTranscript({
        requestId: "request",
        sessionId: "session",
        requestClient: "discord",
        messages: [{ role: "user", content: "released" }],
      }),
    );
    expect(value(store.listUnretained({ limit: 1 }))[0]?.cache).toEqual(cache);

    value(
      store.saveRequestTranscript({
        requestId: "request",
        sessionId: "session",
        requestClient: "discord",
        messages: [resourceMessage(id)],
      }),
    );
    const retained = value(store.finalizeUnretained({ resourceId: id, expectedCache: cache }));
    expect(retained).toMatchObject({ kind: "retained", record: { resourceId: id } });
    if (retained.kind === "retained") expect(retained.record.cache).toBeUndefined();

    value(
      store.saveRequestTranscript({
        requestId: "request",
        sessionId: "session",
        requestClient: "discord",
        messages: [{ role: "user", content: "released again" }],
      }),
    );
    expect(value(store.finalizeUnretained({ resourceId: id }))).toEqual({ kind: "deleted" });
    expect(value(store.finalizeUnretained({ resourceId: id }))).toEqual({ kind: "absent" });
    store.close();
  });

  it("retains a resource through a projection until that projection is deleted", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-projection-resource-"));
    const dbPath = path.join(directory, "transcripts.db");
    const store = new SqliteTranscriptStore(dbPath);
    const id = resourceId("41");
    register(store, id, "projection-message");
    value(
      store.admitCoreSurfaceProjection({
        requestClient: "discord",
        surfaceId: "discord:channel",
        sessionId: "channel",
        messageId: "projection-message",
        projectionFormatVersion: CORE_SURFACE_PROJECTION_FORMAT_VERSION,
        canonicalMessages: [resourceMessage(id)],
        sourceFacts: {},
        ownedBlobs: [],
      }),
    );
    expect(value(store.getRetained(id))?.resourceId).toBe(id);
    store.close();

    const restarted = new SqliteTranscriptStore(dbPath);
    expect(value(restarted.getRetained(id))?.resourceId).toBe(id);
    const reused = value(
      restarted.registerOrGet({
        candidateResourceId: resourceId("42"),
        origin: {
          version: 1,
          kind: "discord-attachment",
          channelId: "channel",
          messageId: "projection-message",
          ordinal: 0,
          attachmentId: "attachment-projection-message",
        },
        filename: "renamed.txt",
        declaredMediaType: "text/plain",
        reportedByteLength: 8,
        createdAt: 3,
      }),
    );
    expect(reused).toMatchObject({ kind: "existing", record: { resourceId: id } });
    restarted.close();

    const raw = new Database(dbPath);
    raw.run("PRAGMA foreign_keys = ON");
    raw.run("DELETE FROM core_surface_projections WHERE message_id = ?", ["projection-message"]);
    expect(raw.query("PRAGMA foreign_key_check").all()).toEqual([]);
    raw.close();

    const reopened = new SqliteTranscriptStore(dbPath);
    expect(value(reopened.getRetained(id))).toBeNull();
    reopened.close();
    await fs.rm(directory, { recursive: true, force: true });
  });

  it("migrates an exact schema-6 database additively and preserves old messages", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-resource-schema-8-"));
    const dbPath = path.join(directory, "transcripts.db");
    const initial = new SqliteTranscriptStore(dbPath);
    value(
      initial.saveRequestTranscript({
        requestId: "schema-6-transcript",
        sessionId: "session",
        requestClient: "discord",
        messages: [{ role: "user", content: "historical text" }],
      }),
    );
    initial.close();

    const schema6 = new Database(dbPath);
    schema6.run("DROP TRIGGER delete_transcript_surface_aliases");
    schema6.run("ALTER TABLE surface_message_to_request DROP COLUMN deleted_ts");
    schema6.run("DROP TABLE core_agent_run_checkpoint_blobs");
    schema6.run("DROP TABLE core_transcript_blob_refs");
    schema6.run("ALTER TABLE core_owned_blobs DROP COLUMN deletion_claim_ts");
    schema6.run("DROP TABLE core_surface_projection_resource_refs");
    schema6.run("DROP TABLE core_transcript_resource_refs");
    schema6.run("DROP TABLE core_resources");
    schema6.run("DELETE FROM transcript_schema_migrations WHERE version >= 7");
    schema6.close();

    const migrated = new SqliteTranscriptStore(dbPath);
    expect(
      value(migrated.getRequestTranscript({ requestId: "schema-6-transcript" }))?.messages,
    ).toEqual([{ role: "user", content: "historical text" }]);
    migrated.close();

    const inspected = new Database(dbPath);
    expect(
      inspected.query("SELECT MAX(version) AS version FROM transcript_schema_migrations").get(),
    ).toEqual({ version: 11 });
    expect(inspected.query("PRAGMA foreign_key_check").all()).toEqual([]);
    inspected.close();
    await fs.rm(directory, { recursive: true, force: true });
  });

  it("reports corrupt resource rows before returning failure and preserves observer Panic identity", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-corrupt-resource-"));
    const dbPath = path.join(directory, "transcripts.db");
    const observerPanic = new Panic({ message: "resource diagnostic observer failed" });
    const diagnostics: Array<{ readonly recordId: string; readonly field: string }> = [];
    let panicOnDiagnostic = false;
    const store = new SqliteTranscriptStore(dbPath, undefined, (diagnostic) => {
      diagnostics.push({ recordId: diagnostic.recordId, field: diagnostic.field });
      if (panicOnDiagnostic) throw observerPanic;
    });
    const id = resourceId("51");
    register(store, id, "corrupt-resource");
    value(
      store.saveRequestTranscript({
        requestId: "corrupt-resource-owner",
        sessionId: "session",
        requestClient: "discord",
        messages: [resourceMessage(id)],
      }),
    );
    const raw = new Database(dbPath);
    raw.run("UPDATE core_resources SET origin_json = '{' WHERE resource_id = ?", [id]);

    const failed = store.getRetained(id);
    expect(failed.status).toBe("error");
    if (failed.status === "error") {
      expect(failed.error).toMatchObject({
        _tag: "ResourceStoreFailure",
        operation: "get-retained-resource",
      });
    }
    expect(diagnostics).toEqual([{ recordId: id, field: "origin_json" }]);

    panicOnDiagnostic = true;
    expect(() => store.getRetained(id)).toThrow(observerPanic);
    expect(diagnostics).toEqual([
      { recordId: id, field: "origin_json" },
      { recordId: id, field: "origin_json" },
    ]);

    raw.close();
    store.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
});
