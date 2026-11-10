import { describe, expect, it, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import SuperJSON from "superjson";
import type { ModelMessage } from "ai";
import { Panic } from "better-result";
import { storedMessagesV1Schema } from "@stanley2058/lilac-event-bus";
import { z } from "zod";

import {
  coreLineageManifestRowCodecCases,
  coreSurfaceProjectionRowCodecCases,
  decodeResourceRecordRow,
  decodeCoreLineageManifestRow,
  decodeCoreSurfaceProjectionRow,
  decodeDiscoveryRecordRow,
  decodeRecentAgentWriteRow,
  decodeSurfaceMessageLinkRow,
  decodeTranscriptCompactionContext,
  decodeTranscriptMessages,
  decodeTranscriptProviderState,
  decodeTranscriptRow,
  discoveryRecordRowCodecCases,
  recentAgentWriteRowCodecCases,
  resourceRecordRowCodecCases,
  hashCanonicalStoredMessagesV2,
  normalizeStoredMessagesV1,
  surfaceMessageLinkRowCodecCases,
  transcriptCompactionContextCodecCases,
  transcriptProviderStateCodecCases,
  transcriptRowCodecCases,
  transcriptStoreRowFixtures,
  type StoredMessageV1,
} from "../../src/transcript/transcript-persistence-codec";
import { SqliteTranscriptStore } from "../../src/transcript/transcript-store";
import {
  createTranscriptSchemaMigrationFixture,
  SUPPORTED_TRANSCRIPT_SCHEMA_STARTS,
} from "./fixtures/transcript-schema-migration-fixtures";

function expectCatalog(
  catalog: Readonly<
    Record<
      string,
      { readonly input: object; readonly outcome: "ok" | "error"; readonly provenance?: string }
    >
  >,
  decode: (input: never) => {
    readonly status: "ok" | "error";
    readonly value?: { readonly provenance: string };
  },
): void {
  for (const fixture of Object.values(catalog)) {
    const decoded = decode(fixture.input as never);
    expect(decoded.status).toBe(fixture.outcome);
    if (decoded.status === "ok") expect(decoded.value?.provenance).toBe(fixture.provenance);
  }
}

describe("transcript persistence codecs", () => {
  it("covers the strict current-schema resource record persistence cases", () => {
    expectCatalog(resourceRecordRowCodecCases, decodeResourceRecordRow as never);
    expect(
      decodeResourceRecordRow({
        ...resourceRecordRowCodecCases.current.input,
        row: {
          ...resourceRecordRowCodecCases.current.input.row,
          origin_key: '{"version":1}',
        },
      }).status,
    ).toBe("error");
  });

  it("omits explicit undefined optional fields before hashing or persistence", () => {
    const messages = [
      {
        role: "assistant",
        providerOptions: undefined,
        content: [
          {
            type: "tool-call",
            toolCallId: "call-undefined",
            toolName: "inspect",
            input: { path: "note.txt" },
            providerOptions: undefined,
            providerExecuted: undefined,
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-undefined",
            toolName: "inspect",
            providerOptions: undefined,
            output: { type: "text", value: "done", providerOptions: undefined },
          },
        ],
      },
    ] satisfies StoredMessageV1[];

    const normalized = normalizeStoredMessagesV1(messages);
    expect(normalized).toEqual([
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-undefined",
            toolName: "inspect",
            input: { path: "note.txt" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-undefined",
            toolName: "inspect",
            output: { type: "text", value: "done" },
          },
        ],
      },
    ]);
    expect(hashCanonicalStoredMessagesV2(messages).status).toBe("ok");
  });

  it("hashes nested blobs by content and media identity instead of object ownership", () => {
    const messagesFor = (
      objectId: string,
      sha256: string,
      mediaType = "image/png",
    ): StoredMessageV1[] => [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "inspect",
            output: {
              type: "content",
              value: [
                {
                  type: "blob",
                  blob: { version: 1, objectId, sha256, byteLength: 3 },
                  mediaType,
                  filename: "pixel.png",
                },
              ],
            },
          },
        ],
      },
    ];
    const digest = (messages: readonly StoredMessageV1[]) => {
      const result = hashCanonicalStoredMessagesV2(messages);
      if (result.status === "error") throw result.error;
      return result.value.hash;
    };
    const sha = "11".repeat(32);
    expect(digest(messagesFor(`b1_${"01".repeat(16)}`, sha))).toBe(
      digest(messagesFor(`b1_${"02".repeat(16)}`, sha)),
    );
    expect(digest(messagesFor(`b1_${"01".repeat(16)}`, sha))).not.toBe(
      digest(messagesFor(`b1_${"01".repeat(16)}`, "22".repeat(32))),
    );
    expect(digest(messagesFor(`b1_${"01".repeat(16)}`, sha))).not.toBe(
      digest(messagesFor(`b1_${"01".repeat(16)}`, sha, "image/jpeg")),
    );
  });

  it("round-trips resource marker metadata but hashes only resource URI identity", () => {
    const messagesFor = (
      uri: string,
      metadata: { readonly filename: string; readonly mediaType: string; readonly size: number },
    ): StoredMessageV1[] => [
      {
        role: "user",
        content: [
          { type: "text", text: "inspect" },
          { type: "resource", uri, ...metadata },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "resource-call",
            toolName: "inspect",
            output: {
              type: "content",
              value: [{ type: "resource", uri, ...metadata }],
            },
          },
        ],
      },
    ];
    const first = messagesFor(`resource://r1_${"12".repeat(16)}`, {
      filename: "notes.txt",
      mediaType: "text/plain",
      size: 7,
    });
    expect(normalizeStoredMessagesV1(first)).toEqual(first);

    const digest = (messages: readonly StoredMessageV1[]) => {
      const result = hashCanonicalStoredMessagesV2(messages);
      if (result.status === "error") throw result.error;
      return result.value.hash;
    };
    expect(digest(first)).not.toBe(
      digest(
        messagesFor(`resource://r1_${"13".repeat(16)}`, {
          filename: "notes.txt",
          mediaType: "text/plain",
          size: 7,
        }),
      ),
    );
    expect(digest(first)).toBe(
      digest(
        messagesFor(`resource://r1_${"12".repeat(16)}`, {
          filename: "transformed.png",
          mediaType: "image/png",
          size: 83,
        }),
      ),
    );
  });

  it("preserves Panic thrown while decoding serialized data", () => {
    const panic = new Panic({ message: "serialized transcript invariant failed" });
    const originalParse = globalThis.JSON.parse;
    globalThis.JSON.parse = () => {
      throw panic;
    };
    try {
      expect(() =>
        decodeTranscriptMessages({
          raw: "[]",
          schemaVersion: 5,
          recordId: "panic-transcript",
        }),
      ).toThrow(panic);
    } finally {
      globalThis.JSON.parse = originalParse;
    }
  });

  it("covers current, legacy, missing, unsupported, malformed, and corrupt transcript values", () => {
    expectCatalog(transcriptCompactionContextCodecCases, decodeTranscriptCompactionContext);
    expectCatalog(transcriptProviderStateCodecCases, decodeTranscriptProviderState);
    expectCatalog(transcriptRowCodecCases, decodeTranscriptRow);
    expectCatalog(transcriptStoreRowFixtures, decodeTranscriptRow);
    expectCatalog(coreSurfaceProjectionRowCodecCases, decodeCoreSurfaceProjectionRow);
    expectCatalog(coreLineageManifestRowCodecCases, decodeCoreLineageManifestRow);
    expectCatalog(recentAgentWriteRowCodecCases, decodeRecentAgentWriteRow);
    expectCatalog(surfaceMessageLinkRowCodecCases, decodeSurfaceMessageLinkRow);
    expectCatalog(discoveryRecordRowCodecCases, decodeDiscoveryRecordRow);
  });

  it("rejects non-canonical loaded catalog snapshots", () => {
    const current = transcriptRowCodecCases.current.input;
    const decoded = decodeTranscriptRow({
      row: {
        ...current.row,
        loaded_catalog_ids_json: '["mcp_duplicate","mcp_duplicate"]',
      },
      schemaVersion: current.schemaVersion,
    });

    expect(decoded.status).toBe("error");
  });

  it("keeps placeholder request and linked platforms broad at the persistence boundary", () => {
    const discovery = decodeDiscoveryRecordRow({
      row: {
        request_id: "placeholder-request",
        session_id: "placeholder-session",
        request_client: "whatsapp",
        updated_ts: 10,
        final_text: null,
        surface_platform: "telegram",
        surface_channel_id: "placeholder-channel",
        surface_message_id: "placeholder-message",
        surface_created_ts: 9,
      },
      schemaVersion: 5,
      recordId: "placeholder-request",
    });
    expect(discovery.status).toBe("ok");
    if (discovery.status === "ok") {
      expect(discovery.value.value.requestClient).toBe("whatsapp");
      expect(discovery.value.value.surfaceRef?.platform).toBe("telegram");
    }

    const recent = decodeRecentAgentWriteRow({
      row: {
        request_id: "placeholder-request",
        platform: "web",
        channel_id: "placeholder-channel",
        message_id: "placeholder-message",
        updated_ts: 10,
        final_text: null,
      },
      schemaVersion: 5,
      recordId: "placeholder-request",
    });
    expect(recent.status).toBe("ok");
    if (recent.status === "ok") expect(recent.value.value.platform).toBe("web");

    const linked = decodeSurfaceMessageLinkRow({
      row: {
        request_id: "placeholder-request",
        platform: "telegram",
        channel_id: "placeholder-channel",
        message_id: "placeholder-message",
      },
      schemaVersion: 5,
      recordId: "placeholder-request",
    });
    expect(linked.status).toBe("ok");
    if (linked.status === "ok") expect(linked.value.value.platform).toBe("telegram");
  });

  for (const startVersion of SUPPORTED_TRANSCRIPT_SCHEMA_STARTS) {
    it(`rejects an independent schema-v${startVersion} fixture with the offline migration command`, async () => {
      const dir = await fs.mkdtemp(
        path.join(os.tmpdir(), `lilac-transcript-schema-v${startVersion}-`),
      );
      const dbPath = path.join(dir, "transcripts.db");
      createTranscriptSchemaMigrationFixture(dbPath, startVersion);
      expect(() => new SqliteTranscriptStore(dbPath)).toThrow(
        "check out commit f2c90667 (see MIGRATIONS.md), then bun run migrate:blob-storage -- --config /path/to/core-config.yaml --data-dir /path/to/data",
      );
      const inspection = new Database(dbPath, { strict: true });
      try {
        expect(
          inspection
            .query("SELECT version FROM transcript_schema_migrations ORDER BY version")
            .all(),
        ).toEqual(Array.from({ length: startVersion }, (_, index) => ({ version: index + 1 })));
      } finally {
        inspection.close();
        await fs.rm(dir, { recursive: true, force: true });
      }
    });
  }

  it("validates plain JSON transcript messages once per row read", () => {
    const current = transcriptRowCodecCases.current.input;
    const safeParse = spyOn(storedMessagesV1Schema, "safeParse");
    try {
      const decoded = decodeTranscriptRow(current);
      expect(decoded.status).toBe("ok");
      expect(safeParse).toHaveBeenCalledTimes(1);
    } finally {
      safeParse.mockRestore();
    }
  });

  it("decodes transcript and projection rows without building object schemas", () => {
    const transcript = transcriptRowCodecCases.current.input;
    const projection = coreSurfaceProjectionRowCodecCases.current.input;
    const object = spyOn(z, "object");
    try {
      expect(decodeTranscriptRow(transcript).status).toBe("ok");
      expect(decodeCoreSurfaceProjectionRow(projection).status).toBe("ok");
      expect(object).not.toHaveBeenCalled();
    } finally {
      object.mockRestore();
    }
  });

  it("decodes literal plain JSON and SuperJSON message bytes", () => {
    const messages = [{ role: "assistant", content: "literal" }] satisfies ModelMessage[];
    const plain = '[{"role":"assistant","content":"literal"}]';
    const superJson = SuperJSON.stringify(messages);
    for (const raw of [plain, superJson]) {
      const decoded = decodeTranscriptMessages({ raw, schemaVersion: 6, recordId: "literal" });
      expect(decoded.status).toBe("ok");
      if (decoded.status === "ok") expect(decoded.value.value).toEqual(messages);
    }
  });

  it("returns malformed metadata as an error without rewriting persisted bytes", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-transcript-codec-"));
    const dbPath = path.join(dir, "transcripts.db");
    const store = new SqliteTranscriptStore(dbPath);
    expect(
      store.saveRequestTranscript({
        requestId: "no-rewrite",
        sessionId: "session",
        requestClient: "discord",
        messages: [{ role: "assistant", content: "stored" }],
      }).status,
    ).toBe("ok");
    const db = new Database(dbPath);
    const malformed = '{"type":"compaction"';
    db.run("UPDATE request_transcripts SET context_meta_json = ? WHERE request_id = ?", [
      malformed,
      "no-rewrite",
    ]);

    const read = store.getRequestTranscript({ requestId: "no-rewrite" });
    expect(read.status).toBe("error");
    if (read.status === "error") expect(read.error._tag).toBe("MalformedSerialization");
    const persisted = db
      .query<{ context_meta_json: string }, [string]>(
        "SELECT context_meta_json FROM request_transcripts WHERE request_id = ?",
      )
      .get("no-rewrite");
    expect(persisted?.context_meta_json).toBe(malformed);

    db.close();
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
});
