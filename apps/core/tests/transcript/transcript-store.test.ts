import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import SuperJSON from "superjson";

import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

import { Panic, Result, type Result as ResultType } from "better-result";
import {
  buildCoreLineageManifestV2 as buildCoreLineageManifestResultV2,
  computeCoreLineagePrefixDigestV2,
  type BusMessageV2,
  type CoreLineageAtomV2,
  type CoreLineageManifestV2,
  type CoreRequestAliasV2,
  type StoredMessageV1,
} from "@stanley2058/lilac-event-bus";
import {
  BlobAdapterFailure,
  BlobDeleteFailed,
  createMemoryBlobStore,
} from "@stanley2058/lilac-blob-storage";
import type { RetentionLimit } from "@stanley2058/lilac-utils";

import type { ResourceId } from "../../src/resource/contracts";
import {
  CORE_SURFACE_PROJECTION_FORMAT_VERSION,
  computeCorePrimaryClaudeTerminalHead as computeCorePrimaryClaudeTerminalHeadResult,
  CoreOwnedBlobIntegrityError,
  type CoreStoredLineageManifestV2,
  type CoreClaudeAttemptMutationError,
  type CoreClaudeBindingReadError,
  SqliteTranscriptStore,
  TranscriptStoreSqliteDriverFailure,
} from "../../src/transcript/transcript-store";
import {
  hashCanonicalStoredMessagesV2 as hashCanonicalStoredMessagesResultV2,
  normalizeStoredMessagesV1,
} from "../../src/transcript/transcript-persistence-codec";

function resultValue<T, E>(result: ResultType<T, E>): T {
  if (result.status === "error") throw result.error;
  return result.value;
}

function resultError<T, E>(result: ResultType<T, E>): E {
  if (result.status === "ok") throw new Error("expected Result error");
  return result.error;
}

function hashCanonicalStoredMessagesV2(messages: readonly StoredMessageV1[]) {
  return resultValue(hashCanonicalStoredMessagesResultV2(messages));
}

function computeCorePrimaryClaudeTerminalHead(
  input: Parameters<typeof computeCorePrimaryClaudeTerminalHeadResult>[0],
) {
  return resultValue(computeCorePrimaryClaudeTerminalHeadResult(input));
}

function attemptMutationValue<T>(result: ResultType<T, CoreClaudeAttemptMutationError>): T {
  if (result.status === "ok") return result.value;
  switch (result.error._tag) {
    case "CoreClaudeBindingCorrupt":
    case "TranscriptTransactionConflict":
    case "TranscriptStoreSqliteDriverFailure":
      throw result.error;
  }
}

function bindingValue<T>(result: ResultType<T, CoreClaudeBindingReadError>): T {
  if (result.status === "ok") return result.value;
  switch (result.error._tag) {
    case "CoreClaudeBindingCorrupt":
    case "TranscriptStoreSqliteDriverFailure":
      throw result.error;
  }
}

function getNamedBinding(
  store: SqliteTranscriptStore,
  input: Parameters<SqliteTranscriptStore["getCoreNamedClaudeSessionBinding"]>[0],
) {
  return bindingValue(store.getCoreNamedClaudeSessionBinding(input));
}

function getPrimaryBinding(
  store: SqliteTranscriptStore,
  input: Parameters<SqliteTranscriptStore["getCorePrimaryClaudeSessionBinding"]>[0],
) {
  return bindingValue(store.getCorePrimaryClaudeSessionBinding(input));
}

function promoteNamedBinding(
  store: SqliteTranscriptStore,
  input: Parameters<SqliteTranscriptStore["promoteCoreNamedClaudeSessionBinding"]>[0],
) {
  return attemptMutationValue(store.promoteCoreNamedClaudeSessionBinding(input));
}

function promotePrimaryBinding(
  store: SqliteTranscriptStore,
  input: Parameters<SqliteTranscriptStore["promoteCorePrimaryClaudeSessionBinding"]>[0],
) {
  return attemptMutationValue(store.promoteCorePrimaryClaudeSessionBinding(input));
}

function reserveNamedAttempt(
  store: SqliteTranscriptStore,
  input: Parameters<SqliteTranscriptStore["reserveCoreNamedClaudeSessionAttempt"]>[0],
) {
  return attemptMutationValue(store.reserveCoreNamedClaudeSessionAttempt(input));
}

function recordNamedAttemptOutcome(
  store: SqliteTranscriptStore,
  input: Parameters<SqliteTranscriptStore["recordCoreNamedClaudeSessionAttemptOutcome"]>[0],
) {
  return attemptMutationValue(store.recordCoreNamedClaudeSessionAttemptOutcome(input));
}

function reservePrimaryAttempt(
  store: SqliteTranscriptStore,
  input: Parameters<SqliteTranscriptStore["reserveCorePrimaryClaudeSessionAttempt"]>[0],
) {
  return attemptMutationValue(store.reserveCorePrimaryClaudeSessionAttempt(input));
}

function recordPrimaryAttemptOutcome(
  store: SqliteTranscriptStore,
  input: Parameters<SqliteTranscriptStore["recordCorePrimaryClaudeSessionAttemptOutcome"]>[0],
) {
  return attemptMutationValue(store.recordCorePrimaryClaudeSessionAttemptOutcome(input));
}

function buildCoreLineageManifestV2(...args: Parameters<typeof buildCoreLineageManifestResultV2>) {
  return resultValue(buildCoreLineageManifestResultV2(...args));
}

function getRequestTranscript(
  store: SqliteTranscriptStore,
  input: Parameters<SqliteTranscriptStore["getRequestTranscript"]>[0],
) {
  return resultValue(store.getRequestTranscript(input));
}

function getTranscriptBySurfaceMessage(
  store: SqliteTranscriptStore,
  input: Parameters<SqliteTranscriptStore["getTranscriptBySurfaceMessage"]>[0],
) {
  return resultValue(store.getTranscriptBySurfaceMessage(input));
}

function getLatestTranscriptBySession(
  store: SqliteTranscriptStore,
  input: Parameters<SqliteTranscriptStore["getLatestTranscriptBySession"]>[0],
) {
  return resultValue(store.getLatestTranscriptBySession(input));
}

function getLatestCompleteNamedTranscript(
  store: SqliteTranscriptStore,
  input: Parameters<SqliteTranscriptStore["getLatestCompleteNamedTranscript"]>[0],
) {
  return resultValue(store.getLatestCompleteNamedTranscript(input));
}

function getCoreSurfaceProjection(
  store: SqliteTranscriptStore,
  input: Parameters<SqliteTranscriptStore["getCoreSurfaceProjection"]>[0],
) {
  return resultValue(store.getCoreSurfaceProjection(input));
}

function admitCoreSurfaceProjection(
  store: SqliteTranscriptStore,
  input: Parameters<SqliteTranscriptStore["admitCoreSurfaceProjection"]>[0],
) {
  return resultValue(store.admitCoreSurfaceProjection(input));
}

function getCoreRequestAtomMetadata(
  store: SqliteTranscriptStore,
  input: Parameters<SqliteTranscriptStore["getCoreRequestAtomMetadata"]>[0],
) {
  return resultValue(store.getCoreRequestAtomMetadata(input));
}

function putCoreOwnedBlob(
  store: SqliteTranscriptStore,
  input: Parameters<SqliteTranscriptStore["putCoreOwnedBlob"]>[0],
) {
  return resultValue(store.putCoreOwnedBlob(input));
}

function durableBlob(value: string, objectId: string) {
  const bytes = new TextEncoder().encode(value);
  return {
    version: 1 as const,
    objectId: `b1_${createHash("sha256").update(objectId).digest("hex").slice(0, 32)}`,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    byteLength: bytes.byteLength,
  };
}

function getCoreOwnedBlob(
  store: SqliteTranscriptStore,
  input: Parameters<SqliteTranscriptStore["getCoreOwnedBlob"]>[0],
) {
  return resultValue(store.getCoreOwnedBlob(input));
}

function getCoreRetentionDiagnostics(store: SqliteTranscriptStore) {
  return resultValue(store.getCoreRetentionDiagnostics());
}

function getCorePrimaryLineageManifest(
  store: SqliteTranscriptStore,
  input: Parameters<SqliteTranscriptStore["getCorePrimaryLineageManifest"]>[0],
) {
  return resultValue(store.getCorePrimaryLineageManifest(input));
}

function unlinkSurfaceMessage(
  store: SqliteTranscriptStore,
  input: Parameters<SqliteTranscriptStore["unlinkSurfaceMessage"]>[0],
) {
  return resultValue(store.unlinkSurfaceMessage(input));
}

function deleteUnlinkedCheckpointCandidate(
  store: SqliteTranscriptStore,
  input: Parameters<SqliteTranscriptStore["deleteUnlinkedCheckpointCandidate"]>[0],
) {
  return resultValue(store.deleteUnlinkedCheckpointCandidate(input));
}

function validateCorePrimaryLineageReferences(
  store: SqliteTranscriptStore,
  input: Parameters<SqliteTranscriptStore["validateCorePrimaryLineageReferences"]>[0],
) {
  return resultValue(store.validateCorePrimaryLineageReferences(input));
}

function manifestFor(
  atoms: readonly CoreLineageAtomV2[],
  canonicalMessages: readonly StoredMessageV1[],
  requestAliases?: readonly CoreRequestAliasV2[],
): CoreStoredLineageManifestV2 {
  return {
    state: "complete",
    lineageVersion: 2,
    currentCanonicalStart: 0,
    segments: [
      {
        atoms: [...atoms],
        canonicalMessages: [...canonicalMessages],
        ...(requestAliases ? { requestSource: { aliases: [...requestAliases] } } : {}),
        canonicalStart: 0,
        canonicalEnd: canonicalMessages.length,
        cumulativeAtomCount: atoms.length,
        cumulativePrefixDigest: computeCoreLineagePrefixDigestV2(atoms),
      },
    ],
  };
}

function syntheticManifestSegment(messages: readonly StoredMessageV1[]) {
  return {
    atoms: [
      {
        kind: "synthetic" as const,
        source: "transcript-store-test",
        messageDigest: hashCanonicalStoredMessagesV2(messages).hash,
      },
    ],
    canonicalMessages: messages,
  };
}

function seedPrimaryBinding(store: SqliteTranscriptStore, requestId: string, sessionId: string) {
  const inputMessages = [
    { role: "user", content: `input:${requestId}` },
  ] satisfies StoredMessageV1[];
  const manifest = buildCoreLineageManifestV2([syntheticManifestSegment(inputMessages)]);
  const responseMessages = [
    { role: "assistant", content: `response:${requestId}` },
  ] satisfies StoredMessageV1[];
  const providerState = {
    lastFamily: "claude-code",
    containsCrossFamilyTurns: false,
  } as const;
  reservePrimaryAttempt(store, {
    providerId: "claude-code",
    requestClient: "discord",
    lilacSessionId: sessionId,
    executionScopeHashVersion: 1,
    executionScopeHash: "scope",
    requestId,
    attemptIndex: 0,
    candidateSessionId: crypto.randomUUID(),
    sourceSessionId: null,
    expectedBindingRevision: null,
  });
  store.saveRequestTranscript({
    requestId,
    sessionId,
    requestClient: "discord",
    messages: responseMessages,
    corePrimaryLineage: manifest,
  });
  const transcript = getRequestTranscript(store, { requestId });
  if (!transcript?.transcriptDigest) throw new Error("seed terminal transcript missing");
  const head = computeCorePrimaryClaudeTerminalHead({
    manifest,
    requestId,
    transcriptDigest: transcript.transcriptDigest,
    responseMessageCount: responseMessages.length,
    providerState,
  });
  store.publishCorePrimaryClaudeSuccess({
    providerId: "claude-code",
    requestClient: "discord",
    lilacSessionId: sessionId,
    requestId,
    attemptIndex: 0,
    terminalRequestId: requestId,
    terminalLineageVersion: 2,
    terminalAtomCount: head.atomCount,
    terminalPrefixDigest: head.prefixDigest,
    terminalCanonicalMessageCount: head.canonicalMessageCount,
    providerState,
    nativeCwd: "/workspace",
    nativeLastModified: 10,
    nativeContextTokens: 100,
    nativeContextMaxTokens: 1_000,
    lastModelSpecifier: "claude-code/sonnet",
    lastReasoning: "medium",
  });
  expect(
    promotePrimaryBinding(store, {
      providerId: "claude-code",
      requestClient: "discord",
      lilacSessionId: sessionId,
      requestId,
      attemptIndex: 0,
    }),
  ).toBe(true);
  const binding = getPrimaryBinding(store, {
    providerId: "claude-code",
    requestClient: "discord",
    lilacSessionId: sessionId,
  });
  if (!binding) throw new Error("seed primary binding missing");
  return { binding, canonicalMessages: [...inputMessages, ...responseMessages], manifest };
}

function prepareNamedBindingPromotion(
  store: SqliteTranscriptStore,
  requestId: string,
  sessionId: string,
) {
  const messages = [
    { role: "user", content: `input:${requestId}` },
    { role: "assistant", content: `response:${requestId}` },
  ] satisfies StoredMessageV1[];
  const candidateSessionId = crypto.randomUUID();
  reserveNamedAttempt(store, {
    providerId: "claude-code",
    requestClient: "discord",
    lilacSessionId: sessionId,
    executionScopeHashVersion: 1,
    executionScopeHash: "scope",
    requestId,
    attemptIndex: 0,
    candidateSessionId,
    sourceSessionId: null,
    expectedBindingRevision: null,
  });
  resultValue(
    store.saveRequestTranscript({
      requestId,
      sessionId,
      requestClient: "unknown",
      messages,
    }),
  );
  resultValue(
    store.publishCoreNamedClaudeSuccess({
      providerId: "claude-code",
      requestClient: "discord",
      lilacSessionId: sessionId,
      requestId,
      attemptIndex: 0,
      terminalRequestId: requestId,
      terminalCanonicalHeadHash: hashCanonicalStoredMessagesV2(messages).hash,
      terminalCanonicalMessageCount: messages.length,
      providerState: { lastFamily: "claude-code", containsCrossFamilyTurns: false },
      nativeCwd: "/workspace",
      nativeLastModified: 10,
      nativeContextTokens: 100,
      nativeContextMaxTokens: 1_000,
      lastModelSpecifier: "claude-code/sonnet",
      lastReasoning: "medium",
    }),
  );
  return {
    providerId: "claude-code",
    requestClient: "discord",
    lilacSessionId: sessionId,
    requestId,
    attemptIndex: 0,
  } as const;
}

function seedNamedBinding(store: SqliteTranscriptStore, requestId: string, sessionId: string) {
  expect(
    promoteNamedBinding(store, prepareNamedBindingPromotion(store, requestId, sessionId)),
  ).toBe(true);
}

function expectCorruptBinding<T>(
  result: ResultType<T, CoreClaudeBindingReadError | CoreClaudeAttemptMutationError>,
  bindingKind: "named" | "primary",
): void {
  expect(result.status).toBe("error");
  if (result.status === "ok") throw new Error("Expected corrupt binding failure");
  switch (result.error._tag) {
    case "CoreClaudeBindingCorrupt":
      expect(result.error.bindingKind).toBe(bindingKind);
      return;
    case "TranscriptTransactionConflict":
    case "TranscriptStoreSqliteDriverFailure":
      throw result.error;
  }
}

describe("SqliteTranscriptStore", () => {
  it("roundtrips transcripts without mutating tool outputs", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-transcripts-"));
    const dbPath = path.join(dir, "transcripts.db");

    const store = new SqliteTranscriptStore(dbPath);

    const big = "x".repeat(60_000);

    const messages = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "bash",
            input: { command: "echo hi" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "bash",
            output: { type: "text", value: big },
          },
        ],
      },
      { role: "assistant", content: "a1" },
    ] satisfies StoredMessageV1[];

    store.saveRequestTranscript({
      requestId: "r1",
      sessionId: "chan",
      requestClient: "discord",
      messages,
      finalText: "done",
      modelLabel: "test-model",
    });

    store.linkSurfaceMessagesToRequest({
      requestId: "r1",
      created: [{ platform: "discord", channelId: "chan", messageId: "bot-1" }],
      last: { platform: "discord", channelId: "chan", messageId: "bot-1" },
    });

    const snap = getTranscriptBySurfaceMessage(store, {
      platform: "discord",
      channelId: "chan",
      messageId: "bot-1",
    });

    expect(snap).not.toBeNull();
    expect(snap!.requestId).toBe("r1");
    expect(snap!.messages.length).toBe(messages.length);

    const toolMsg = snap!.messages.find((m) => m.role === "tool");
    expect(toolMsg).not.toBeUndefined();

    const parts = Array.isArray(toolMsg!.content) ? (toolMsg!.content as unknown[]) : [];
    const toolResult = parts.find((p) => {
      if (!p || typeof p !== "object") return false;
      return (p as Record<string, unknown>)["type"] === "tool-result";
    }) as Record<string, unknown> | undefined;

    const output = toolResult?.["output"] as Record<string, unknown> | undefined;
    expect(output?.["type"]).toBe("text");
    expect(output?.["value"]).toBe(big);

    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("omits explicit undefined tool fields before transcript persistence", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-transcripts-undefined-"));
    const store = new SqliteTranscriptStore(path.join(dir, "transcripts.db"));
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

    resultValue(
      store.saveRequestTranscript({
        requestId: "undefined-tool-fields",
        sessionId: "chan",
        requestClient: "discord",
        messages,
      }),
    );

    const normalized = normalizeStoredMessagesV1(messages);
    if (!normalized) throw new Error("expected valid normalized stored messages");
    expect(getRequestTranscript(store, { requestId: "undefined-tool-fields" })?.messages).toEqual(
      normalized,
    );

    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("rejects inline base64 tool attachments from durable messages", () => {
    const hugeBase64 = "A".repeat(400_000);
    const messages = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "read_file",
            input: { path: "doc.pdf" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "read_file",
            output: {
              type: "content",
              value: [
                { type: "text", text: "Attached file from read_file" },
                {
                  type: "file",
                  mediaType: "application/pdf",
                  filename: "doc.pdf",
                  data: { type: "data", data: hugeBase64 },
                },
              ],
            },
          },
        ],
      },
      { role: "assistant", content: "a1" },
    ];

    expect(normalizeStoredMessagesV1(messages)).toBeNull();
  });

  it("keeps the first surface-to-request writer and treats same-request relinks as idempotent", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-transcripts-"));
    const store = new SqliteTranscriptStore(path.join(dir, "transcripts.db"));
    for (const requestId of ["first", "second"]) {
      store.saveRequestTranscript({
        requestId,
        sessionId: "chan",
        requestClient: "discord",
        messages: [{ role: "assistant", content: requestId }],
      });
    }
    const ref = { platform: "discord", channelId: "chan", messageId: "output" } as const;
    store.linkSurfaceMessagesToRequest({ requestId: "first", created: [ref], last: ref });
    store.linkSurfaceMessagesToRequest({ requestId: "first", created: [ref], last: ref });
    store.linkSurfaceMessagesToRequest({ requestId: "second", created: [ref], last: ref });

    expect(getTranscriptBySurfaceMessage(store, ref)?.requestId).toBe("first");
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("returns latest transcript by session", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-transcripts-"));
    const dbPath = path.join(dir, "transcripts.db");

    const store = new SqliteTranscriptStore(dbPath);

    store.saveRequestTranscript({
      requestId: "r1",
      sessionId: "sub:s:1:r1",
      requestClient: "unknown",
      messages: [{ role: "assistant", content: "first" }],
      finalText: "first",
      modelLabel: "test-model",
    });

    // test-wait-justification: gives the second transcript a later wall-clock timestamp for latest ordering
    await new Promise((resolve) => setTimeout(resolve, 2));

    store.saveRequestTranscript({
      requestId: "r2",
      sessionId: "sub:s:1:r1",
      requestClient: "unknown",
      messages: [{ role: "assistant", content: "second" }],
      finalText: "second",
      modelLabel: "test-model",
    });

    const latest = getLatestTranscriptBySession(store, { sessionId: "sub:s:1:r1" });
    expect(latest).not.toBeNull();
    expect(latest?.requestId).toBe("r2");
    expect(latest?.finalText).toBe("second");

    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("preserves stringified assistant tool-call inputs in current transcripts", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-transcripts-"));
    const dbPath = path.join(dir, "transcripts.db");

    const store = new SqliteTranscriptStore(dbPath);

    const rawDb = new Database(dbPath);
    rawDb.run(
      `
      INSERT INTO request_transcripts (
        request_id, session_id, request_client, created_ts, updated_ts, model_label, final_text, messages_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        "r1",
        "chan",
        "discord",
        Date.now(),
        Date.now(),
        "test-model",
        null,
        SuperJSON.stringify([
          { role: "user", content: "hello" },
          {
            role: "assistant",
            content: [
              {
                type: "tool-call",
                toolCallId: "call-1",
                toolName: "edit_file",
                input: '{"path":"note.txt","edits":[{"op":"replace","lines":["after install."]}}',
              },
            ],
          },
        ] satisfies StoredMessageV1[]),
      ],
    );
    rawDb.close();

    const latest = getLatestTranscriptBySession(store, { sessionId: "chan" });
    expect(latest).not.toBeNull();

    const assistant = latest?.messages[1];
    expect(assistant?.role).toBe("assistant");
    if (!assistant || assistant.role !== "assistant" || !Array.isArray(assistant.content)) {
      throw new Error("expected assistant message");
    }

    const part = assistant.content[0];
    expect(part?.type).toBe("tool-call");
    if (!part || part.type !== "tool-call") {
      throw new Error("expected tool-call part");
    }

    expect(part.input).toBe(
      '{"path":"note.txt","edits":[{"op":"replace","lines":["after install."]}}',
    );

    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("preserves duplicate tool results in current transcripts", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-transcripts-"));
    const dbPath = path.join(dir, "transcripts.db");

    const store = new SqliteTranscriptStore(dbPath);

    const rawDb = new Database(dbPath);
    rawDb.run(
      `
      INSERT INTO request_transcripts (
        request_id, session_id, request_client, created_ts, updated_ts, model_label, final_text, messages_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        "r1",
        "chan",
        "discord",
        Date.now(),
        Date.now(),
        "test-model",
        null,
        SuperJSON.stringify([
          {
            role: "assistant",
            content: [
              {
                type: "tool-call",
                toolCallId: "call-1",
                toolName: "edit_file",
                input: { path: "note.txt" },
              },
            ],
          },
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: "call-1",
                toolName: "edit_file",
                output: { type: "error-text", value: "first" },
              },
            ],
          },
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: "call-1",
                toolName: "edit_file",
                output: { type: "error-text", value: "second" },
              },
            ],
          },
        ] satisfies StoredMessageV1[]),
      ],
    );
    rawDb.close();

    const latest = getLatestTranscriptBySession(store, { sessionId: "chan" });
    expect(latest).not.toBeNull();
    expect(latest?.messages).toHaveLength(3);

    const tool = latest?.messages[1];
    expect(tool?.role).toBe("tool");
    if (!tool || tool.role !== "tool") {
      throw new Error("expected tool message");
    }

    const part = tool.content[0];
    expect(part?.type).toBe("tool-result");
    if (!part || part.type !== "tool-result") {
      throw new Error("expected tool-result part");
    }

    expect(part.output).toEqual({ type: "error-text", value: "first" });

    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("lists linked surface messages by request in creation order", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-transcripts-"));
    const dbPath = path.join(dir, "transcripts.db");

    const diagnostics: Array<{ recordId: string; field: string }> = [];
    const store = new SqliteTranscriptStore(dbPath, undefined, (diagnostic) => {
      diagnostics.push({ recordId: diagnostic.recordId, field: diagnostic.field });
    });

    store.saveRequestTranscript({
      requestId: "r1",
      sessionId: "chan",
      requestClient: "unknown",
      messages: [{ role: "assistant", content: "first" }],
      finalText: "first",
      modelLabel: "test-model",
    });

    store.linkSurfaceMessagesToRequest({
      requestId: "r1",
      created: [
        { platform: "discord", channelId: "chan", messageId: "m1" },
        { platform: "discord", channelId: "chan", messageId: "m2" },
      ],
      last: { platform: "discord", channelId: "chan", messageId: "m2" },
    });

    const db = new Database(dbPath);
    const insert = db.prepare(
      `INSERT INTO surface_message_to_request
         (platform, channel_id, message_id, request_id, created_ts)
       VALUES (?, ?, ?, ?, ?)`,
    );
    insert.run("slack", "slack-channel", "slack-message", "r1", 3);
    insert.run("future", "future-channel", "future-message", "r1", 4);
    insert.run("discord", "", "empty-channel", "r1", 5);
    db.close();

    expect(store.listSurfaceMessagesForRequest?.({ requestId: "r1" })).toEqual([
      { platform: "discord", channelId: "chan", messageId: "m1" },
      { platform: "discord", channelId: "chan", messageId: "m2" },
    ]);
    expect(diagnostics).toEqual([
      { recordId: "r1", field: "surface-message-link-row" },
      { recordId: "r1", field: "surface-message-link-row" },
    ]);

    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("projects built-in transcript rows and diagnoses corrupt or unknown linked refs", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-transcript-projection-"));
    const dbPath = path.join(dir, "transcripts.db");
    const diagnostics: Array<{ recordId: string; field: string }> = [];
    const store = new SqliteTranscriptStore(dbPath, undefined, (diagnostic) => {
      diagnostics.push({ recordId: diagnostic.recordId, field: diagnostic.field });
    });
    const saveLinked = (
      requestId: string,
      requestClient: "discord" | "github" | "slack",
      platform: "discord" | "github",
      finalText: string,
    ) => {
      store.saveRequestTranscript({
        requestId,
        sessionId: `${requestId}-session`,
        requestClient,
        messages: [{ role: "assistant", content: finalText }],
        finalText,
      });
      const channelId = `${requestId}-channel`;
      const messageId = `${requestId}-message`;
      const ref =
        platform === "discord"
          ? { platform: "discord" as const, channelId, messageId }
          : { platform: "github" as const, channelId, messageId };
      store.linkSurfaceMessagesToRequest({
        requestId,
        created: [ref],
        last: ref,
      });
    };

    saveLinked("discord-write", "discord", "discord", "discord fallback");
    saveLinked("github-write", "github", "github", "github fallback");
    saveLinked("corrupt-write", "discord", "discord", "corrupt fallback");
    store.saveRequestTranscript({
      requestId: "placeholder-request",
      sessionId: "placeholder-session",
      requestClient: "slack",
      messages: [{ role: "assistant", content: "placeholder" }],
      finalText: "placeholder fallback",
    });

    const db = new Database(dbPath);
    db.run(
      `INSERT INTO surface_message_to_request
         (platform, channel_id, message_id, request_id, created_ts)
       VALUES (?, ?, ?, ?, ?)`,
      ["unknown", "placeholder-channel", "placeholder-message", "placeholder-request", 1],
    );
    db.run("UPDATE surface_message_to_request SET platform = ? WHERE request_id = ?", [
      "future",
      "corrupt-write",
    ]);

    const recent = store.listRecentAgentWrites({ limit: 20 });
    expect(recent).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          requestId: "discord-write",
          client: "discord",
          finalText: "discord fallback",
        }),
        expect.objectContaining({
          requestId: "github-write",
          client: "github",
          finalText: "github fallback",
        }),
      ]),
    );
    expect(recent.map((row) => row.requestId)).not.toContain("placeholder-request");
    expect(recent.map((row) => row.requestId)).not.toContain("corrupt-write");

    const discovery = store.listDiscoveryRecords();
    expect(discovery).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          requestId: "placeholder-request",
          requestClient: "slack",
          surfaceRefs: [],
        }),
        expect.objectContaining({
          requestId: "discord-write",
          surfaceRefs: [
            {
              platform: "discord",
              channelId: "discord-write-channel",
              messageId: "discord-write-message",
            },
          ],
        }),
        expect.objectContaining({
          requestId: "github-write",
          surfaceRefs: [
            {
              platform: "github",
              channelId: "github-write-channel",
              messageId: "github-write-message",
            },
          ],
        }),
      ]),
    );
    expect(discovery.map((row) => row.requestId)).not.toContain("corrupt-write");
    expect(diagnostics).toEqual([
      { recordId: "corrupt-write", field: "recent-agent-write-row" },
      { recordId: "corrupt-write", field: "discovery-record-row" },
    ]);

    db.close();
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("roundtrips compaction metadata and rejects invalid metadata", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-transcripts-"));
    const dbPath = path.join(dir, "transcripts.db");
    const store = new SqliteTranscriptStore(dbPath);

    store.saveRequestTranscript({
      requestId: "checkpoint",
      sessionId: "chan",
      requestClient: "discord",
      messages: [{ role: "assistant", content: "checkpoint" }],
      contextMeta: { type: "compaction", formatVersion: 1 },
    });
    store.linkSurfaceMessagesToRequest({
      requestId: "checkpoint",
      created: [{ platform: "discord", channelId: "chan", messageId: "m1" }],
      last: { platform: "discord", channelId: "chan", messageId: "m1" },
    });
    expect(
      getTranscriptBySurfaceMessage(store, {
        platform: "discord",
        channelId: "chan",
        messageId: "m1",
      })?.contextMeta,
    ).toEqual({ type: "compaction", formatVersion: 1 });

    const db = new Database(dbPath);
    db.run("UPDATE request_transcripts SET context_meta_json = ? WHERE request_id = ?", [
      '{"type":"compaction","formatVersion":999}',
      "checkpoint",
    ]);
    db.close();
    const corruptMetadata = store.getTranscriptBySurfaceMessage({
      platform: "discord",
      channelId: "chan",
      messageId: "m1",
    });
    expect(corruptMetadata.status).toBe("error");
    if (corruptMetadata.status === "error") {
      expect(corruptMetadata.error._tag).toBe("CorruptPersistedFields");
    }

    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("rolls back an unlink when persisted checkpoint metadata is corrupt", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-transcripts-rollback-"));
    const dbPath = path.join(dir, "transcripts.db");
    const store = new SqliteTranscriptStore(dbPath);
    store.saveRequestTranscript({
      requestId: "corrupt-checkpoint",
      sessionId: "chan",
      requestClient: "discord",
      messages: [{ role: "assistant", content: "checkpoint" }],
      contextMeta: { type: "compaction", formatVersion: 1 },
    });
    store.linkSurfaceMessagesToRequest({
      requestId: "corrupt-checkpoint",
      created: [{ platform: "discord", channelId: "chan", messageId: "output" }],
      last: { platform: "discord", channelId: "chan", messageId: "output" },
    });
    const raw = new Database(dbPath);
    raw.run(
      "UPDATE request_transcripts SET context_meta_json = ? WHERE request_id = 'corrupt-checkpoint'",
      ["{"],
    );

    const unlink = store.unlinkSurfaceMessage({
      platform: "discord",
      channelId: "chan",
      messageId: "output",
    });
    expect(unlink.status).toBe("error");
    expect(
      raw
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM surface_message_to_request WHERE message_id = 'output'",
        )
        .get(),
    ).toEqual({ count: 1 });

    raw.close();
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("emits transaction diagnostics after rollback without holding the SQLite lock", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-transcript-diagnostics-"));
    const dbPath = path.join(dir, "transcripts.db");
    const callbackPanic = new Panic({ message: "diagnostic observer invariant failed" });
    const store = new SqliteTranscriptStore(dbPath, undefined, (diagnostic) => {
      const observer = new Database(dbPath);
      try {
        observer.run("INSERT INTO diagnostic_observations (record_id) VALUES (?)", [
          diagnostic.recordId,
        ]);
      } finally {
        observer.close();
      }
      if (diagnostic.recordId === "panic-checkpoint") throw callbackPanic;
      throw new Error("diagnostic observer failed");
    });
    for (const requestId of ["unlink-checkpoint", "delete-checkpoint", "panic-checkpoint"]) {
      store.saveRequestTranscript({
        requestId,
        sessionId: "chan",
        requestClient: "discord",
        messages: [{ role: "assistant", content: requestId }],
        contextMeta: { type: "compaction", formatVersion: 1 },
      });
    }
    store.linkSurfaceMessagesToRequest({
      requestId: "unlink-checkpoint",
      created: [{ platform: "discord", channelId: "chan", messageId: "output" }],
      last: { platform: "discord", channelId: "chan", messageId: "output" },
    });
    const raw = new Database(dbPath);
    raw.run("CREATE TABLE diagnostic_observations (record_id TEXT NOT NULL)");
    raw.run("UPDATE request_transcripts SET context_meta_json = ?", ["{"]);

    const unlink = store.unlinkSurfaceMessage({
      platform: "discord",
      channelId: "chan",
      messageId: "output",
    });
    expect(unlink.status).toBe("error");
    if (unlink.status === "error") {
      expect(unlink.error._tag).toBe("MalformedSerialization");
      if (unlink.error._tag === "MalformedSerialization") {
        expect(unlink.error.recordId).toBe("unlink-checkpoint");
      }
    }
    const deletion = store.deleteUnlinkedCheckpointCandidate({
      requestId: "delete-checkpoint",
    });
    expect(deletion.status).toBe("error");
    if (deletion.status === "error") {
      expect(deletion.error._tag).toBe("MalformedSerialization");
      if (deletion.error._tag === "MalformedSerialization") {
        expect(deletion.error.recordId).toBe("delete-checkpoint");
      }
    }
    expect(() =>
      store.deleteUnlinkedCheckpointCandidate({
        requestId: "panic-checkpoint",
      }),
    ).toThrow(callbackPanic);

    expect(
      raw
        .query<{ request_id: string }, []>(
          "SELECT request_id FROM request_transcripts ORDER BY request_id",
        )
        .all(),
    ).toEqual([
      { request_id: "delete-checkpoint" },
      { request_id: "panic-checkpoint" },
      { request_id: "unlink-checkpoint" },
    ]);
    expect(
      raw
        .query<{ request_id: string }, []>(
          "SELECT request_id FROM surface_message_to_request WHERE message_id = 'output'",
        )
        .get(),
    ).toEqual({ request_id: "unlink-checkpoint" });
    expect(
      raw
        .query<{ record_id: string }, []>(
          "SELECT record_id FROM diagnostic_observations ORDER BY rowid",
        )
        .all(),
    ).toEqual([
      { record_id: "unlink-checkpoint" },
      { record_id: "delete-checkpoint" },
      { record_id: "panic-checkpoint" },
    ]);

    raw.close();
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("preserves direct persistence diagnostic Panic identity", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-transcript-diagnostic-panic-"));
    const dbPath = path.join(dir, "transcripts.db");
    const callbackPanic = new Panic({ message: "transcript diagnostic callback failed" });
    const store = new SqliteTranscriptStore(dbPath, undefined, () => {
      throw callbackPanic;
    });
    resultValue(
      store.saveRequestTranscript({
        requestId: "corrupt-diagnostic-row",
        sessionId: "session",
        requestClient: "discord",
        messages: [{ role: "user", content: "secret" }],
      }),
    );
    const mutation = new Database(dbPath);
    mutation.run("UPDATE request_transcripts SET messages_json = '{' WHERE request_id = ?", [
      "corrupt-diagnostic-row",
    ]);
    mutation.close();

    expect(() => store.getRequestTranscript({ requestId: "corrupt-diagnostic-row" })).toThrow(
      callbackPanic,
    );

    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("emits save and lineage diagnostics only after their transaction outcome is fixed", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-save-diagnostics-"));
    const dbPath = path.join(dir, "transcripts.db");
    const store = new SqliteTranscriptStore(dbPath, undefined, (diagnostic) => {
      const observer = new Database(dbPath);
      try {
        observer.run("INSERT INTO save_diagnostic_observations (record_id, field) VALUES (?, ?)", [
          diagnostic.recordId,
          diagnostic.field,
        ]);
      } finally {
        observer.close();
      }
      throw new Error("save diagnostic observer failed");
    });
    const manifestMessages = [
      { role: "user", content: "lineage input" },
    ] satisfies StoredMessageV1[];
    const manifest = buildCoreLineageManifestV2([syntheticManifestSegment(manifestMessages)]);
    store.saveRequestTranscript({
      requestId: "lineage-owner",
      sessionId: "chan",
      requestClient: "discord",
      messages: [{ role: "assistant", content: "before lineage" }],
      finalText: "before lineage",
      corePrimaryLineage: manifest,
    });
    store.saveRequestTranscript({
      requestId: "provider-owner",
      sessionId: "chan",
      requestClient: "discord",
      messages: [{ role: "assistant", content: "before provider" }],
      finalText: "before provider",
      providerState: { lastFamily: "ai-sdk", containsCrossFamilyTurns: false },
    });
    store.saveRequestTranscript({
      requestId: "corrupt-owner",
      sessionId: "chan",
      requestClient: "discord",
      messages: [{ role: "assistant", content: "before corruption" }],
      finalText: "before corruption",
    });
    const raw = new Database(dbPath);
    raw.run(`
      CREATE TABLE save_diagnostic_observations (
        record_id TEXT NOT NULL,
        field TEXT NOT NULL
      )
    `);
    raw.run(
      "UPDATE core_primary_lineage_manifests SET manifest_json = ? WHERE request_id = 'lineage-owner'",
      ["{"],
    );
    raw.run(
      "UPDATE request_transcripts SET provider_state_json = ? WHERE request_id = 'provider-owner'",
      ["{"],
    );
    raw.run("UPDATE request_transcripts SET messages_json = ? WHERE request_id = 'corrupt-owner'", [
      "{",
    ]);

    const lineageSave = store.saveRequestTranscript({
      requestId: "lineage-owner",
      sessionId: "chan",
      requestClient: "discord",
      messages: [{ role: "assistant", content: "after lineage" }],
      finalText: "after lineage",
      corePrimaryLineage: manifest,
    });
    expect(lineageSave.status).toBe("error");
    if (lineageSave.status === "error") {
      expect(lineageSave.error).toMatchObject({ _tag: "MalformedSerialization" });
    }
    const directLineageSave = store.saveCorePrimaryLineageManifest({
      requestId: "lineage-owner",
      manifest,
    });
    expect(directLineageSave.status).toBe("error");
    if (directLineageSave.status === "error") {
      expect(directLineageSave.error).toMatchObject({ _tag: "MalformedSerialization" });
    }
    const corruptOwnerSave = store.saveCorePrimaryLineageManifest({
      requestId: "corrupt-owner",
      manifest,
    });
    expect(corruptOwnerSave.status).toBe("error");
    if (corruptOwnerSave.status === "error") {
      expect(corruptOwnerSave.error).toMatchObject({ _tag: "MalformedSerialization" });
    }
    const providerSave = store.saveRequestTranscript({
      requestId: "provider-owner",
      sessionId: "chan",
      requestClient: "discord",
      messages: [{ role: "assistant", content: "after provider" }],
      finalText: "after provider",
    });
    expect(providerSave.status).toBe("error");
    if (providerSave.status === "error") {
      expect(providerSave.error).toMatchObject({ _tag: "MalformedSerialization" });
    }

    expect(
      raw
        .query<{ request_id: string; final_text: string | null }, []>(
          "SELECT request_id, final_text FROM request_transcripts ORDER BY request_id",
        )
        .all(),
    ).toEqual([
      { request_id: "corrupt-owner", final_text: "before corruption" },
      { request_id: "lineage-owner", final_text: "before lineage" },
      { request_id: "provider-owner", final_text: "before provider" },
    ]);
    expect(
      raw
        .query<{ manifest_json: string }, []>(
          "SELECT manifest_json FROM core_primary_lineage_manifests WHERE request_id = 'lineage-owner'",
        )
        .get(),
    ).toEqual({ manifest_json: "{" });
    expect(
      raw
        .query<{ record_id: string; field: string }, []>(
          "SELECT record_id, field FROM save_diagnostic_observations ORDER BY rowid",
        )
        .all(),
    ).toEqual([
      { record_id: "lineage-owner", field: "manifest_json" },
      { record_id: "lineage-owner", field: "manifest_json" },
      { record_id: "corrupt-owner", field: "messages_json" },
      { record_id: "provider-owner", field: "provider_state_json" },
    ]);

    raw.close();
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("classifies lineage SQLite failures and rolls back the transcript write", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-lineage-save-rollback-"));
    const dbPath = path.join(dir, "transcripts.db");
    const store = new SqliteTranscriptStore(dbPath);
    const raw = new Database(dbPath);
    raw.run(`
      CREATE TABLE lineage_save_probe (marker TEXT NOT NULL);
      CREATE TRIGGER reject_lineage_save
      BEFORE INSERT ON core_primary_lineage_manifests
      BEGIN
        INSERT INTO lineage_save_probe (marker) VALUES ('touched');
        SELECT RAISE(ABORT, 'reject lineage save');
      END;
    `);
    const messages = [{ role: "user", content: "lineage input" }] satisfies StoredMessageV1[];
    const manifest = buildCoreLineageManifestV2([syntheticManifestSegment(messages)]);

    const saved = store.saveRequestTranscript({
      requestId: "lineage-driver-failure",
      sessionId: "chan",
      requestClient: "discord",
      messages,
      corePrimaryLineage: manifest,
    });

    expect(saved.status).toBe("error");
    if (saved.status === "error") {
      expect(saved.error).toBeInstanceOf(TranscriptStoreSqliteDriverFailure);
      if (TranscriptStoreSqliteDriverFailure.is(saved.error)) {
        expect(saved.error.operation).toBe("save-request-transcript");
      }
    }
    expect(raw.query("SELECT * FROM lineage_save_probe").all()).toEqual([]);
    expect(raw.query("SELECT * FROM request_transcripts").all()).toEqual([]);
    expect(raw.query("SELECT * FROM core_primary_lineage_manifests").all()).toEqual([]);

    raw.close();
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("classifies retention SQLite failures and rolls back the saved transcript", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-retention-save-rollback-"));
    const dbPath = path.join(dir, "transcripts.db");
    const store = new SqliteTranscriptStore(dbPath, undefined, undefined, {
      retention: {
        maxAgeMs: { kind: "unlimited" },
        maxRequests: { kind: "bounded", value: 1 },
      },
    });
    resultValue(
      store.saveRequestTranscript({
        requestId: "retained-before-failure",
        sessionId: "chan",
        requestClient: "discord",
        messages: [{ role: "user", content: "first" }],
      }),
    );
    const raw = new Database(dbPath);
    raw.run(`
      CREATE TABLE retention_save_probe (marker TEXT NOT NULL);
      CREATE TRIGGER reject_retention_delete
      BEFORE DELETE ON request_transcripts
      BEGIN
        INSERT INTO retention_save_probe (marker) VALUES ('touched');
        SELECT RAISE(ABORT, 'reject retention delete');
      END;
    `);

    const saved = store.saveRequestTranscript({
      requestId: "rolled-back-after-failure",
      sessionId: "chan",
      requestClient: "discord",
      messages: [{ role: "user", content: "second" }],
    });

    expect(saved.status).toBe("error");
    if (saved.status === "error") {
      expect(saved.error).toBeInstanceOf(TranscriptStoreSqliteDriverFailure);
      if (TranscriptStoreSqliteDriverFailure.is(saved.error)) {
        expect(saved.error.operation).toBe("save-request-transcript");
      }
    }
    expect(raw.query("SELECT * FROM retention_save_probe").all()).toEqual([]);
    expect(
      raw.query<{ request_id: string }, []>("SELECT request_id FROM request_transcripts").all(),
    ).toEqual([{ request_id: "retained-before-failure" }]);

    raw.close();
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("preserves retention Panic identity and rolls back the saved transcript", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-retention-save-panic-"));
    const dbPath = path.join(dir, "transcripts.db");
    const retentionPanic = new Panic({ message: "retention policy invariant failed" });
    const store = new SqliteTranscriptStore(dbPath, undefined, undefined, {
      getRetention: () => {
        throw retentionPanic;
      },
    });

    expect(() =>
      store.saveRequestTranscript({
        requestId: "rolled-back-after-panic",
        sessionId: "chan",
        requestClient: "discord",
        messages: [{ role: "user", content: "panic" }],
      }),
    ).toThrow(retentionPanic);
    const raw = new Database(dbPath);
    expect(raw.query("SELECT * FROM request_transcripts").all()).toEqual([]);

    raw.close();
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("emits prune diagnostics after the save commits and releases its SQLite lock", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-prune-diagnostics-"));
    const dbPath = path.join(dir, "transcripts.db");
    const store = new SqliteTranscriptStore(dbPath, undefined, (diagnostic) => {
      const observer = new Database(dbPath);
      try {
        observer.run("INSERT INTO prune_diagnostic_observations (record_id) VALUES (?)", [
          diagnostic.recordId,
        ]);
      } finally {
        observer.close();
      }
      throw new Error("prune diagnostic observer failed");
    });
    store.saveRequestTranscript({
      requestId: "malformed-prune-candidate",
      sessionId: "chan",
      requestClient: "discord",
      messages: [{ role: "assistant", content: "old checkpoint" }],
      contextMeta: { type: "compaction", formatVersion: 1 },
    });
    const raw = new Database(dbPath);
    raw.run("CREATE TABLE prune_diagnostic_observations (record_id TEXT NOT NULL)");
    raw.run(
      `UPDATE request_transcripts
       SET context_meta_json = ?, updated_ts = ?
       WHERE request_id = 'malformed-prune-candidate'`,
      ["{", Date.now() - 2 * 24 * 60 * 60 * 1000],
    );

    const save = store.saveRequestTranscript({
      requestId: "committed-after-prune",
      sessionId: "chan",
      requestClient: "discord",
      messages: [{ role: "assistant", content: "committed" }],
      finalText: "committed",
    });
    expect(save.status).toBe("ok");
    expect(
      raw
        .query<{ request_id: string }, []>(
          "SELECT request_id FROM request_transcripts ORDER BY request_id",
        )
        .all(),
    ).toEqual([
      { request_id: "committed-after-prune" },
      { request_id: "malformed-prune-candidate" },
    ]);
    expect(
      raw
        .query<{ record_id: string }, []>("SELECT record_id FROM prune_diagnostic_observations")
        .all(),
    ).toEqual([{ record_id: "malformed-prune-candidate" }]);

    raw.close();
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("applies configured transcript age retention", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-transcript-age-retention-"));
    const dbPath = path.join(dir, "transcripts.db");
    const store = new SqliteTranscriptStore(dbPath, undefined, undefined, {
      retention: {
        maxAgeMs: { kind: "bounded", value: 1_000 },
        maxRequests: { kind: "unlimited" },
      },
    });
    store.saveRequestTranscript({
      requestId: "expired",
      sessionId: "chan",
      requestClient: "discord",
      messages: [{ role: "user", content: "expired" }],
    });
    const raw = new Database(dbPath);
    raw.run("UPDATE request_transcripts SET updated_ts = 0 WHERE request_id = ?", ["expired"]);

    store.saveRequestTranscript({
      requestId: "current",
      sessionId: "chan",
      requestClient: "discord",
      messages: [{ role: "user", content: "current" }],
    });

    expect(
      raw
        .query<{ request_id: string }, []>(
          "SELECT request_id FROM request_transcripts ORDER BY request_id",
        )
        .all(),
    ).toEqual([{ request_id: "current" }]);
    raw.close();
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("disables transcript age and count pruning when configured as unlimited", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-transcript-unlimited-"));
    const dbPath = path.join(dir, "transcripts.db");
    const store = new SqliteTranscriptStore(dbPath, undefined, undefined, {
      retention: {
        maxAgeMs: { kind: "unlimited" },
        maxRequests: { kind: "unlimited" },
      },
    });
    store.saveRequestTranscript({
      requestId: "old",
      sessionId: "chan",
      requestClient: "discord",
      messages: [{ role: "user", content: "old" }],
    });
    const raw = new Database(dbPath);
    raw.run("UPDATE request_transcripts SET updated_ts = 0 WHERE request_id = ?", ["old"]);
    store.saveRequestTranscript({
      requestId: "new",
      sessionId: "chan",
      requestClient: "discord",
      messages: [{ role: "user", content: "new" }],
    });

    expect(
      raw.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM request_transcripts").get(),
    ).toEqual({ count: 2 });
    raw.close();
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("applies configured transcript count retention independently", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-transcript-count-retention-"));
    const dbPath = path.join(dir, "transcripts.db");
    const store = new SqliteTranscriptStore(dbPath, undefined, undefined, {
      retention: {
        maxAgeMs: { kind: "unlimited" },
        maxRequests: { kind: "bounded", value: 1 },
      },
    });
    store.saveRequestTranscript({
      requestId: "first",
      sessionId: "chan",
      requestClient: "discord",
      messages: [{ role: "user", content: "first" }],
    });
    const ordering = new Database(dbPath);
    ordering.run("UPDATE request_transcripts SET updated_ts = 0 WHERE request_id = ?", ["first"]);
    ordering.close();
    store.saveRequestTranscript({
      requestId: "second",
      sessionId: "chan",
      requestClient: "discord",
      messages: [{ role: "user", content: "second" }],
    });

    const raw = new Database(dbPath);
    expect(
      raw.query<{ request_id: string }, []>("SELECT request_id FROM request_transcripts").all(),
    ).toEqual([{ request_id: "second" }]);
    raw.close();
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("reads transcript retention again before each prune", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-transcript-live-retention-"));
    const dbPath = path.join(dir, "transcripts.db");
    let retention: {
      readonly maxAgeMs: RetentionLimit;
      readonly maxRequests: RetentionLimit;
    } = {
      maxAgeMs: { kind: "unlimited" },
      maxRequests: { kind: "unlimited" },
    };
    const store = new SqliteTranscriptStore(dbPath, undefined, undefined, {
      getRetention: () => retention,
    });
    store.saveRequestTranscript({
      requestId: "old",
      sessionId: "chan",
      requestClient: "discord",
      messages: [{ role: "user", content: "old" }],
    });
    const raw = new Database(dbPath);
    raw.run("UPDATE request_transcripts SET updated_ts = 0 WHERE request_id = ?", ["old"]);

    retention = {
      maxAgeMs: { kind: "bounded", value: 1_000 },
      maxRequests: { kind: "unlimited" },
    };
    store.saveRequestTranscript({
      requestId: "current",
      sessionId: "chan",
      requestClient: "discord",
      messages: [{ role: "user", content: "current" }],
    });

    expect(
      raw
        .query<{ request_id: string }, []>(
          "SELECT request_id FROM request_transcripts ORDER BY request_id",
        )
        .all(),
    ).toEqual([{ request_id: "current" }]);
    raw.close();
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("migrates existing transcript databases with ordinary metadata defaults", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-transcripts-"));
    const dbPath = path.join(dir, "transcripts.db");
    const db = new Database(dbPath);
    db.run(`
      CREATE TABLE request_transcripts (
        request_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        request_client TEXT NOT NULL,
        created_ts INTEGER NOT NULL,
        updated_ts INTEGER NOT NULL,
        model_label TEXT,
        final_text TEXT,
        messages_json TEXT NOT NULL
      )
    `);
    db.run(`INSERT INTO request_transcripts VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [
      "old",
      "chan",
      "discord",
      1,
      1,
      null,
      "old",
      SuperJSON.stringify([{ role: "assistant", content: "old" }]),
    ]);
    db.close();

    const store = new SqliteTranscriptStore(dbPath);
    const old = getLatestTranscriptBySession(store, { sessionId: "chan" });
    expect(old?.requestId).toBe("old");
    expect(old?.contextMeta).toBeUndefined();

    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("preserves split-output checkpoints until the final mapping is unlinked", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-transcripts-"));
    const dbPath = path.join(dir, "transcripts.db");
    const store = new SqliteTranscriptStore(dbPath);
    store.saveRequestTranscript({
      requestId: "checkpoint",
      sessionId: "chan",
      requestClient: "discord",
      messages: [{ role: "assistant", content: "checkpoint" }],
      contextMeta: { type: "compaction", formatVersion: 1 },
    });
    store.linkSurfaceMessagesToRequest({
      requestId: "checkpoint",
      created: [
        { platform: "discord", channelId: "chan", messageId: "m1" },
        { platform: "discord", channelId: "chan", messageId: "m2" },
      ],
      last: { platform: "discord", channelId: "chan", messageId: "m2" },
    });

    expect(
      unlinkSurfaceMessage(store, { platform: "discord", channelId: "chan", messageId: "m1" }),
    ).toEqual({ requestId: "checkpoint", checkpointDeleted: false });
    expect(
      getTranscriptBySurfaceMessage(store, {
        platform: "discord",
        channelId: "chan",
        messageId: "m2",
      })?.requestId,
    ).toBe("checkpoint");
    expect(
      unlinkSurfaceMessage(store, { platform: "discord", channelId: "chan", messageId: "m2" }),
    ).toEqual({ requestId: "checkpoint", checkpointDeleted: true });
    expect(
      unlinkSurfaceMessage(store, { platform: "discord", channelId: "chan", messageId: "m2" }),
    ).toEqual({ checkpointDeleted: false });
    expect(getLatestTranscriptBySession(store, { sessionId: "chan" })).toBeNull();

    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("does not delete ordinary transcripts when their final mapping is unlinked", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-transcripts-"));
    const store = new SqliteTranscriptStore(path.join(dir, "transcripts.db"));
    store.saveRequestTranscript({
      requestId: "ordinary",
      sessionId: "chan",
      requestClient: "discord",
      messages: [{ role: "assistant", content: "ordinary" }],
    });
    store.linkSurfaceMessagesToRequest({
      requestId: "ordinary",
      created: [{ platform: "discord", channelId: "chan", messageId: "m1" }],
      last: { platform: "discord", channelId: "chan", messageId: "m1" },
    });

    expect(
      unlinkSurfaceMessage(store, { platform: "discord", channelId: "chan", messageId: "m1" }),
    ).toEqual({ requestId: "ordinary", checkpointDeleted: false });
    expect(getLatestTranscriptBySession(store, { sessionId: "chan" })?.requestId).toBe("ordinary");

    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("retains deleted aliases for history without advertising them as live output", () => {
    const store = new SqliteTranscriptStore(":memory:");
    const preview = { platform: "discord", channelId: "chan", messageId: "preview" } as const;
    const final = { ...preview, messageId: "final" };
    resultValue(
      store.saveRequestTranscript({
        requestId: "request",
        sessionId: "chan",
        requestClient: "discord",
        messages: [{ role: "assistant", content: "answer" }],
        finalText: "answer",
      }),
    );
    store.linkSurfaceMessagesToRequest({
      requestId: "request",
      created: [preview, final],
      last: final,
    });
    unlinkSurfaceMessage(store, preview);
    store.linkSurfaceMessagesToRequest({ requestId: "request", created: [preview], last: preview });
    expect(getTranscriptBySurfaceMessage(store, preview)?.requestId).toBe("request");
    expect(store.listSurfaceMessagesForRequest({ requestId: "request" })).toEqual([final]);
    expect(store.listRecentAgentWrites().map((row) => row.messageId)).toEqual(["final"]);
    expect(store.listDiscoveryRecords()[0]?.surfaceRefs).toEqual([final]);
    unlinkSurfaceMessage(store, final);
    expect(getTranscriptBySurfaceMessage(store, final)?.requestId).toBe("request");
    expect(store.listSurfaceMessagesForRequest({ requestId: "request" })).toEqual([]);
    expect(store.listRecentAgentWrites()).toEqual([]);
    expect(store.listDiscoveryRecords()[0]?.surfaceRefs).toEqual([]);
    store.close();
  });

  it("migrates schema 10 aliases as live and preserves tombstones across reopen", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-alias-migration-"));
    const dbPath = path.join(dir, "transcripts.db");
    const original = new SqliteTranscriptStore(dbPath);
    const ref = { platform: "discord", channelId: "chan", messageId: "output" } as const;
    resultValue(
      original.saveRequestTranscript({
        requestId: "request",
        sessionId: "chan",
        requestClient: "discord",
        messages: [{ role: "assistant", content: "answer" }],
      }),
    );
    original.linkSurfaceMessagesToRequest({ requestId: "request", created: [ref], last: ref });
    original.close();
    const legacy = new Database(dbPath);
    legacy.run("DROP TRIGGER delete_transcript_surface_aliases");
    legacy.run("ALTER TABLE surface_message_to_request DROP COLUMN deleted_ts");
    legacy.run("DELETE FROM transcript_schema_migrations WHERE version = 11");
    legacy.close();

    const migrated = new SqliteTranscriptStore(dbPath);
    expect(migrated.listSurfaceMessagesForRequest({ requestId: "request" })).toEqual([ref]);
    unlinkSurfaceMessage(migrated, ref);
    migrated.close();
    const reopened = new SqliteTranscriptStore(dbPath);
    expect(reopened.listSurfaceMessagesForRequest({ requestId: "request" })).toEqual([]);
    expect(getTranscriptBySurfaceMessage(reopened, ref)?.requestId).toBe("request");
    reopened.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it.each(["age", "count"] as const)(
    "removes live and deleted aliases during %s retention",
    async (mode) => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-alias-retention-"));
      const dbPath = path.join(dir, "transcripts.db");
      const store = new SqliteTranscriptStore(dbPath, undefined, undefined, {
        retention: {
          maxAgeMs: mode === "age" ? { kind: "bounded", value: 60_000 } : { kind: "unlimited" },
          maxRequests: mode === "count" ? { kind: "bounded", value: 1 } : { kind: "unlimited" },
        },
      });
      resultValue(
        store.saveRequestTranscript({
          requestId: "old",
          sessionId: "chan",
          requestClient: "discord",
          messages: [{ role: "assistant", content: "old answer" }],
        }),
      );
      const preview = { platform: "discord", channelId: "chan", messageId: "preview" } as const;
      const final = { ...preview, messageId: "final" };
      store.linkSurfaceMessagesToRequest({
        requestId: "old",
        created: [preview, final],
        last: final,
      });
      unlinkSurfaceMessage(store, preview);
      const raw = new Database(dbPath);
      raw.run("UPDATE request_transcripts SET updated_ts = 1 WHERE request_id = 'old'");
      resultValue(
        store.saveRequestTranscript({
          requestId: "new",
          sessionId: "chan",
          requestClient: "discord",
          messages: [{ role: "assistant", content: "new answer" }],
        }),
      );
      expect(getRequestTranscript(store, { requestId: "old" })).toBeNull();
      expect(
        raw
          .query("SELECT message_id FROM surface_message_to_request WHERE request_id = 'old'")
          .all(),
      ).toEqual([]);
      raw.close();
      store.close();
      await fs.rm(dir, { recursive: true, force: true });
    },
  );

  it("expires deleted orphan aliases using the configured transcript age limit", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-orphan-alias-retention-"));
    const dbPath = path.join(dir, "transcripts.db");
    let maxAgeMs: RetentionLimit = { kind: "unlimited" };
    const store = new SqliteTranscriptStore(dbPath, undefined, undefined, {
      getRetention: () => ({ maxAgeMs, maxRequests: { kind: "unlimited" } }),
    });
    const save = (requestId: string) =>
      resultValue(
        store.saveRequestTranscript({
          requestId,
          sessionId: "chan",
          requestClient: "discord",
          messages: [{ role: "assistant", content: "answer" }],
        }),
      );
    save("retained");
    for (const requestId of ["expired-orphan", "recent-orphan", "live-orphan", "retained"]) {
      const ref = { platform: "discord", channelId: "chan", messageId: requestId } as const;
      store.linkSurfaceMessagesToRequest({ requestId, created: [ref], last: ref });
      if (requestId !== "live-orphan") unlinkSurfaceMessage(store, ref);
    }
    const raw = new Database(dbPath);
    raw.run(
      "UPDATE surface_message_to_request SET deleted_ts = 1 WHERE request_id IN ('expired-orphan', 'retained')",
    );
    const aliasIds = () =>
      raw
        .query<{ request_id: string }, []>(
          "SELECT request_id FROM surface_message_to_request ORDER BY request_id",
        )
        .all()
        .map((row) => row.request_id);
    save("unlimited-prune");
    expect(aliasIds()).toEqual(["expired-orphan", "live-orphan", "recent-orphan", "retained"]);
    maxAgeMs = { kind: "bounded", value: 60_000 };
    save("bounded-prune");
    expect(aliasIds()).toEqual(["live-orphan", "recent-orphan", "retained"]);
    raw.close();
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("cleans only unlinked checkpoint candidates", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-transcripts-"));
    const store = new SqliteTranscriptStore(path.join(dir, "transcripts.db"));
    for (const requestId of ["unlinked", "linked"]) {
      store.saveRequestTranscript({
        requestId,
        sessionId: "chan",
        requestClient: "discord",
        messages: [{ role: "assistant", content: requestId }],
        contextMeta: { type: "compaction", formatVersion: 1 },
      });
    }
    store.linkSurfaceMessagesToRequest({
      requestId: "linked",
      created: [{ platform: "discord", channelId: "chan", messageId: "m1" }],
      last: { platform: "discord", channelId: "chan", messageId: "m1" },
    });

    expect(deleteUnlinkedCheckpointCandidate(store, { requestId: "unlinked" })).toBe(true);
    expect(deleteUnlinkedCheckpointCandidate(store, { requestId: "linked" })).toBe(false);
    expect(getLatestTranscriptBySession(store, { sessionId: "chan" })?.requestId).toBe("linked");

    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("persists a canonical loaded-tool snapshot with its terminal request", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-transcripts-"));
    const dbPath = path.join(dir, "transcripts.db");
    const first = new SqliteTranscriptStore(dbPath);
    first.saveRequestTranscript({
      requestId: "loaded-prefix",
      requestClient: "discord",
      sessionId: "shared-session-id",
      messages: [{ role: "assistant", content: "done" }],
      loadedCatalogIds: ["mcp_zeta", "mcp_alpha", "mcp_zeta"],
    });
    first.saveRequestTranscript({
      requestId: "empty-prefix",
      requestClient: "discord",
      sessionId: "shared-session-id",
      messages: [{ role: "assistant", content: "fresh" }],
      loadedCatalogIds: [],
    });
    first.close();

    const second = new SqliteTranscriptStore(dbPath);
    expect(getRequestTranscript(second, { requestId: "loaded-prefix" })?.loadedCatalogIds).toEqual([
      "mcp_alpha",
      "mcp_zeta",
    ]);
    expect(getRequestTranscript(second, { requestId: "empty-prefix" })?.loadedCatalogIds).toEqual(
      [],
    );
    second.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("removes legacy session-wide tool authority during migration", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-transcripts-"));
    const dbPath = path.join(dir, "transcripts.db");
    const db = new Database(dbPath);
    db.run(`
      CREATE TABLE session_loaded_tools (
        request_client TEXT NOT NULL,
        session_id TEXT NOT NULL,
        catalog_id TEXT NOT NULL,
        selected_ts INTEGER NOT NULL
      )
    `);
    db.run("INSERT INTO session_loaded_tools VALUES (?, ?, ?, ?)", [
      "discord",
      "session",
      "legacy-tool-id",
      1,
    ]);
    db.close();

    new SqliteTranscriptStore(dbPath).close();

    const rawDb = new Database(dbPath);
    expect(
      rawDb.query("SELECT name FROM sqlite_master WHERE name = 'session_loaded_tools'").all(),
    ).toEqual([]);
    rawDb.close();

    await fs.rm(dir, { recursive: true, force: true });
  });

  it("transactionally migrates the shipped layout with provider metadata and FK validation", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-transcripts-stage5-"));
    const dbPath = path.join(dir, "transcripts.db");
    const legacy = new Database(dbPath);
    legacy.run(`
      CREATE TABLE request_transcripts (
        request_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        request_client TEXT NOT NULL,
        created_ts INTEGER NOT NULL,
        updated_ts INTEGER NOT NULL,
        model_label TEXT,
        final_text TEXT,
        messages_json TEXT NOT NULL
      )
    `);
    legacy.run("INSERT INTO request_transcripts VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [
      "legacy",
      "sub:legacy:named:audit",
      "unknown",
      1,
      1,
      "old-model",
      "old",
      SuperJSON.stringify([{ role: "assistant", content: "old" }]),
    ]);
    legacy.close();

    const store = new SqliteTranscriptStore(dbPath);
    expect(getRequestTranscript(store, { requestId: "legacy" })?.providerState).toBeNull();
    store.close();

    const migrated = new Database(dbPath);
    const version = migrated
      .query("SELECT MAX(version) AS version FROM transcript_schema_migrations")
      .get();
    expect(version).toEqual({ version: 11 });
    expect(migrated.query("PRAGMA foreign_key_check").all()).toEqual([]);
    const columns = migrated.query("PRAGMA table_info(request_transcripts)").all() as Array<{
      name: string;
    }>;
    expect(columns.map(({ name }) => name)).toContain("provider_state_json");
    expect(columns.map(({ name }) => name)).toContain("stable_named_request_client");
    expect(columns.map(({ name }) => name)).toContain("loaded_catalog_ids_json");
    expect(
      migrated
        .query(
          `SELECT name FROM sqlite_master
           WHERE type = 'table' AND name LIKE 'core_primary_claude_%' ORDER BY name`,
        )
        .all(),
    ).toEqual([{ name: "core_primary_claude_attempts" }, { name: "core_primary_claude_bindings" }]);
    migrated.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("promotes a canonically verified named candidate and rejects a stale revision race", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-transcripts-stage5-"));
    const dbPath = path.join(dir, "transcripts.db");
    const store = new SqliteTranscriptStore(dbPath);
    const sessionId = "sub:parent:named:audit";
    const sourceMessages = [{ role: "user", content: "first" }] satisfies StoredMessageV1[];
    store.saveRequestTranscript({
      requestId: "source",
      sessionId,
      requestClient: "unknown",
      messages: sourceMessages,
      providerState: { lastFamily: "claude-code", containsCrossFamilyTurns: false },
      stableNamedRequestClient: "discord",
    });
    const firstCandidate = crypto.randomUUID();
    reserveNamedAttempt(store, {
      providerId: "claude-code",
      requestClient: "discord",
      lilacSessionId: sessionId,
      executionScopeHashVersion: 1,
      executionScopeHash: "scope-a",
      requestId: "candidate-1",
      attemptIndex: 0,
      candidateSessionId: firstCandidate,
      sourceSessionId: null,
      expectedBindingRevision: null,
    });
    const firstTerminal = [
      ...sourceMessages,
      { role: "assistant", content: "first answer" },
    ] satisfies StoredMessageV1[];
    const firstHash = hashCanonicalStoredMessagesV2(firstTerminal).hash;
    store.saveRequestTranscript({
      requestId: "candidate-1",
      sessionId,
      requestClient: "unknown",
      messages: firstTerminal,
    });
    store.publishCoreNamedClaudeSuccess({
      providerId: "claude-code",
      requestClient: "discord",
      lilacSessionId: sessionId,
      requestId: "candidate-1",
      attemptIndex: 0,
      terminalRequestId: "candidate-1",
      terminalCanonicalHeadHash: firstHash,
      terminalCanonicalMessageCount: firstTerminal.length,
      providerState: { lastFamily: "claude-code", containsCrossFamilyTurns: false },
      nativeCwd: "/workspace",
      nativeLastModified: 10,
      nativeContextTokens: 100,
      nativeContextMaxTokens: 1_000,
      lastModelSpecifier: "claude-code/sonnet",
      lastReasoning: "low",
    });
    expect(
      promoteNamedBinding(store, {
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: sessionId,
        requestId: "candidate-1",
        attemptIndex: 0,
      }),
    ).toBe(true);
    const base = getNamedBinding(store, {
      providerId: "claude-code",
      requestClient: "discord",
      lilacSessionId: sessionId,
    });
    expect(base?.claudeSessionId).toBe(firstCandidate);
    expect(base?.revision).toBe(1);

    const reserveCompeting = (requestId: string, candidateSessionId: string) =>
      reserveNamedAttempt(store, {
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: sessionId,
        executionScopeHashVersion: 1,
        executionScopeHash: "scope-a",
        requestId,
        attemptIndex: 0,
        candidateSessionId,
        sourceSessionId: firstCandidate,
        expectedBindingRevision: 1,
      });
    reserveCompeting("candidate-2", crypto.randomUUID());
    reserveCompeting("candidate-stale", crypto.randomUUID());
    for (const requestId of ["candidate-2", "candidate-stale"]) {
      const terminal = [
        ...firstTerminal,
        { role: "user", content: requestId },
        { role: "assistant", content: `answer:${requestId}` },
      ] satisfies StoredMessageV1[];
      const hash = hashCanonicalStoredMessagesV2(terminal).hash;
      store.saveRequestTranscript({
        requestId,
        sessionId,
        requestClient: "unknown",
        messages: terminal,
      });
      store.publishCoreNamedClaudeSuccess({
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: sessionId,
        requestId,
        attemptIndex: 0,
        terminalRequestId: requestId,
        terminalCanonicalHeadHash: hash,
        terminalCanonicalMessageCount: terminal.length,
        providerState: { lastFamily: "claude-code", containsCrossFamilyTurns: false },
        nativeCwd: "/workspace",
        nativeLastModified: 20,
        nativeContextTokens: 200,
        nativeContextMaxTokens: 1_000,
        lastModelSpecifier: "claude-code/opus",
        lastReasoning: "high",
      });
    }
    expect(
      promoteNamedBinding(store, {
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: sessionId,
        requestId: "candidate-2",
        attemptIndex: 0,
      }),
    ).toBe(true);
    expect(
      promoteNamedBinding(store, {
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: sessionId,
        requestId: "candidate-stale",
        attemptIndex: 0,
      }),
    ).toBe(false);
    expect(
      store.getCoreNamedClaudeSessionAttempt({
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: sessionId,
        requestId: "candidate-stale",
        attemptIndex: 0,
      })?.state,
    ).toBe("failed");

    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("classifies a named promotion SQLite failure and rolls back trigger effects", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-named-promotion-rollback-"));
    const dbPath = path.join(dir, "transcripts.db");
    const store = new SqliteTranscriptStore(dbPath);
    const promotion = prepareNamedBindingPromotion(store, "promotion-failure", "named-session");
    const raw = new Database(dbPath);
    raw.run(`
      CREATE TABLE named_promotion_probe (marker TEXT NOT NULL);
      CREATE TRIGGER reject_named_promotion
      BEFORE INSERT ON core_named_claude_bindings
      BEGIN
        INSERT INTO named_promotion_probe (marker) VALUES ('touched');
        SELECT RAISE(ABORT, 'reject named promotion');
      END;
    `);

    const promoted = store.promoteCoreNamedClaudeSessionBinding(promotion);

    expect(promoted.status).toBe("error");
    if (promoted.status === "error") {
      expect(promoted.error).toBeInstanceOf(TranscriptStoreSqliteDriverFailure);
      if (TranscriptStoreSqliteDriverFailure.is(promoted.error)) {
        expect(promoted.error.operation).toBe("promote-core-named-claude-binding");
      }
    }
    expect(raw.query("SELECT * FROM named_promotion_probe").all()).toEqual([]);
    expect(raw.query("SELECT * FROM core_named_claude_bindings").all()).toEqual([]);
    expect(
      raw
        .query<{ state: string }, [string]>(
          "SELECT state FROM core_named_claude_attempts WHERE request_id = ?",
        )
        .get("promotion-failure"),
    ).toEqual({ state: "succeeded" });

    raw.close();
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("preserves lifecycle Panic identity after a named recovery promotion failure", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-named-recovery-panic-"));
    const dbPath = path.join(dir, "transcripts.db");
    const first = new SqliteTranscriptStore(dbPath);
    prepareNamedBindingPromotion(first, "named-recovery-panic", "named-recovery-session");
    first.close();
    const raw = new Database(dbPath);
    raw.run(`
      CREATE TRIGGER reject_named_recovery_promotion
      BEFORE INSERT ON core_named_claude_bindings
      BEGIN
        SELECT RAISE(ABORT, 'reject named recovery promotion');
      END;
    `);
    raw.close();
    const panic = new Panic({ message: "named recovery lifecycle invariant" });
    let caught: unknown;

    try {
      new SqliteTranscriptStore(dbPath, (_level, event) => {
        expect(event).toBe("core_named_claude.promotion_recovery_failed");
        throw panic;
      });
    } catch (cause) {
      caught = cause;
    }

    expect(caught).toBe(panic);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("recovers succeeded promotions, marks crash-left attempts uncertain, and cascades deleted heads", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-transcripts-stage5-"));
    const dbPath = path.join(dir, "transcripts.db");
    const sessionId = "sub:parent:named:restart";
    const first = new SqliteTranscriptStore(dbPath);
    const terminal = [
      { role: "user", content: "restart" },
      { role: "assistant", content: "ready" },
    ] satisfies StoredMessageV1[];
    first.saveRequestTranscript({
      requestId: "succeeded-pending",
      sessionId,
      requestClient: "unknown",
      messages: terminal,
    });
    reserveNamedAttempt(first, {
      providerId: "claude-code",
      requestClient: "discord",
      lilacSessionId: sessionId,
      executionScopeHashVersion: 1,
      executionScopeHash: "scope",
      requestId: "succeeded-pending",
      attemptIndex: 0,
      candidateSessionId: crypto.randomUUID(),
      sourceSessionId: null,
      expectedBindingRevision: null,
    });
    first.publishCoreNamedClaudeSuccess({
      providerId: "claude-code",
      requestClient: "discord",
      lilacSessionId: sessionId,
      requestId: "succeeded-pending",
      attemptIndex: 0,
      terminalRequestId: "succeeded-pending",
      terminalCanonicalHeadHash: hashCanonicalStoredMessagesV2(terminal).hash,
      terminalCanonicalMessageCount: terminal.length,
      providerState: { lastFamily: "claude-code", containsCrossFamilyTurns: false },
      nativeCwd: "/workspace",
      nativeLastModified: 10,
      nativeContextTokens: 100,
      nativeContextMaxTokens: 1_000,
      lastModelSpecifier: "claude-code/sonnet",
      lastReasoning: "medium",
    });
    reserveNamedAttempt(first, {
      providerId: "claude-code",
      requestClient: "discord",
      lilacSessionId: "sub:parent:named:crashed",
      executionScopeHashVersion: 1,
      executionScopeHash: "scope",
      requestId: "crash-left",
      attemptIndex: 0,
      candidateSessionId: crypto.randomUUID(),
      sourceSessionId: null,
      expectedBindingRevision: null,
    });
    first.saveRequestTranscript({
      requestId: "crash-left",
      sessionId: "sub:parent:named:crashed",
      requestClient: "unknown",
      messages: terminal,
    });
    first.close();

    const recovered = new SqliteTranscriptStore(dbPath);
    expect(
      getNamedBinding(recovered, {
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: sessionId,
      })?.terminalRequestId,
    ).toBe("succeeded-pending");
    expect(
      recovered.getCoreNamedClaudeSessionAttempt({
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: "sub:parent:named:crashed",
        requestId: "crash-left",
        attemptIndex: 0,
      })?.state,
    ).toBe("uncertain");
    const recoveredAttempt = reserveNamedAttempt(recovered, {
      providerId: "claude-code",
      requestClient: "discord",
      lilacSessionId: "sub:parent:named:crashed",
      executionScopeHashVersion: 1,
      executionScopeHash: "scope",
      requestId: "crash-left",
      attemptIndex: 0,
      candidateSessionId: crypto.randomUUID(),
      sourceSessionId: null,
      expectedBindingRevision: null,
    });
    expect(recoveredAttempt.attemptIndex).toBe(2);
    expect(recoveredAttempt.state).toBe("active");
    expect(
      recovered.getCoreNamedClaudeSessionAttempt({
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: "sub:parent:named:crashed",
        requestId: "crash-left",
        attemptIndex: 0,
      })?.state,
    ).toBe("uncertain");
    expect(
      getLatestCompleteNamedTranscript(recovered, {
        requestClient: "discord",
        sessionId: "sub:parent:named:crashed",
      }),
    ).toBeNull();
    const crashTranscript = getRequestTranscript(recovered, { requestId: "crash-left" });
    expect(crashTranscript?.providerState).toBeNull();
    expect(crashTranscript?.stableNamedRequestClient).toBeUndefined();

    const raw = new Database(dbPath);
    raw.run("PRAGMA foreign_keys = ON");
    raw.run("DELETE FROM request_transcripts WHERE request_id = ?", ["succeeded-pending"]);
    raw.close();
    expect(
      getNamedBinding(recovered, {
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: sessionId,
      }),
    ).toBeNull();

    recovered.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("bounds terminal attempt metadata per exact named owner", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-transcripts-stage5-"));
    const dbPath = path.join(dir, "transcripts.db");
    const store = new SqliteTranscriptStore(dbPath);
    reserveNamedAttempt(store, {
      providerId: "claude-code",
      requestClient: "discord",
      lilacSessionId: "sub:parent:named:bounded",
      executionScopeHashVersion: 1,
      executionScopeHash: "scope",
      requestId: "bounded-active",
      attemptIndex: 0,
      candidateSessionId: crypto.randomUUID(),
      sourceSessionId: null,
      expectedBindingRevision: null,
    });
    for (let attemptIndex = 0; attemptIndex < 40; attemptIndex += 1) {
      reserveNamedAttempt(store, {
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: "sub:parent:named:bounded",
        executionScopeHashVersion: 1,
        executionScopeHash: "scope",
        requestId: "bounded-request",
        attemptIndex,
        candidateSessionId: crypto.randomUUID(),
        sourceSessionId: null,
        expectedBindingRevision: null,
      });
      recordNamedAttemptOutcome(store, {
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: "sub:parent:named:bounded",
        requestId: "bounded-request",
        attemptIndex,
        state: "failed",
      });
    }
    store.close();

    const raw = new Database(dbPath);
    expect(
      raw
        .query(
          `SELECT COUNT(*) AS count FROM core_named_claude_attempts
           WHERE request_client = 'discord' AND session_id = 'sub:parent:named:bounded'`,
        )
        .get(),
    ).toEqual({ count: 33 });
    expect(
      raw
        .query(
          `SELECT state FROM core_named_claude_attempts
           WHERE request_client = 'discord' AND session_id = 'sub:parent:named:bounded'
             AND request_id = 'bounded-active'`,
        )
        .get(),
    ).toEqual({ state: "active" });
    raw.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("cannot promote when the canonical terminal transcript was not durably saved", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-transcripts-stage5-"));
    const store = new SqliteTranscriptStore(path.join(dir, "transcripts.db"));
    const sessionId = "sub:parent:named:save-failure";
    reserveNamedAttempt(store, {
      providerId: "claude-code",
      requestClient: "discord",
      lilacSessionId: sessionId,
      executionScopeHashVersion: 1,
      executionScopeHash: "scope",
      requestId: "missing-terminal",
      attemptIndex: 0,
      candidateSessionId: crypto.randomUUID(),
      sourceSessionId: null,
      expectedBindingRevision: null,
    });
    expect(
      resultError(
        store.publishCoreNamedClaudeSuccess({
          providerId: "claude-code",
          requestClient: "discord",
          lilacSessionId: sessionId,
          requestId: "missing-terminal",
          attemptIndex: 0,
          terminalRequestId: "missing-terminal",
          terminalCanonicalHeadHash: "not-saved",
          terminalCanonicalMessageCount: 2,
          providerState: { lastFamily: "claude-code", containsCrossFamilyTurns: false },
          nativeCwd: "/workspace",
          nativeLastModified: 10,
          nativeContextTokens: 100,
          nativeContextMaxTokens: 1_000,
          lastModelSpecifier: "claude-code/sonnet",
          lastReasoning: "medium",
        }),
      ).message,
    ).toContain("failed publication verification");
    recordNamedAttemptOutcome(store, {
      providerId: "claude-code",
      requestClient: "discord",
      lilacSessionId: sessionId,
      requestId: "missing-terminal",
      attemptIndex: 0,
      state: "failed",
    });
    expect(
      getNamedBinding(store, {
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: sessionId,
      }),
    ).toBeNull();
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("atomically rolls back transcript publication when success recording fails", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-transcripts-stage5-"));
    const dbPath = path.join(dir, "transcripts.db");
    const store = new SqliteTranscriptStore(dbPath);
    const sessionId = "sub:parent:named:atomic-publication";
    const requestId = "atomic-publication";
    const terminal = [
      { role: "user", content: "publish" },
      { role: "assistant", content: "candidate" },
    ] satisfies StoredMessageV1[];
    reserveNamedAttempt(store, {
      providerId: "claude-code",
      requestClient: "discord",
      lilacSessionId: sessionId,
      executionScopeHashVersion: 1,
      executionScopeHash: "scope",
      requestId,
      attemptIndex: 0,
      candidateSessionId: crypto.randomUUID(),
      sourceSessionId: null,
      expectedBindingRevision: null,
    });
    store.saveRequestTranscript({
      requestId,
      sessionId,
      requestClient: "unknown",
      messages: terminal,
    });
    const publicationInput = {
      providerId: "claude-code",
      requestClient: "discord",
      lilacSessionId: sessionId,
      requestId,
      attemptIndex: 0,
      terminalRequestId: requestId,
      terminalCanonicalHeadHash: hashCanonicalStoredMessagesV2(terminal).hash,
      terminalCanonicalMessageCount: terminal.length,
      providerState: { lastFamily: "claude-code", containsCrossFamilyTurns: false },
      nativeCwd: "/workspace",
      nativeLastModified: 10,
      nativeContextTokens: 100,
      nativeContextMaxTokens: 1_000,
      lastModelSpecifier: "claude-code/sonnet",
      lastReasoning: "medium",
    } as const;
    const raw = new Database(dbPath);
    raw.run(`CREATE TRIGGER reject_core_named_success
      BEFORE UPDATE OF state ON core_named_claude_attempts
      WHEN NEW.state = 'succeeded'
      BEGIN SELECT RAISE(ABORT, 'simulated success recording failure'); END`);
    raw.close();

    const publication = store.publishCoreNamedClaudeSuccess(publicationInput);
    expect(publication.status).toBe("error");
    if (publication.status === "error") {
      expect(publication.error._tag).toBe("TranscriptStoreSqliteDriverFailure");
      if (publication.error._tag === "TranscriptStoreSqliteDriverFailure") {
        expect(publication.error.code).toBe("SQLITE_CONSTRAINT_TRIGGER");
      }
    }
    const unpublished = getRequestTranscript(store, { requestId });
    expect(unpublished?.providerState).toBeNull();
    expect(unpublished?.stableNamedRequestClient).toBeUndefined();
    expect(
      store.getCoreNamedClaudeSessionAttempt({
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: sessionId,
        requestId,
        attemptIndex: 0,
      })?.state,
    ).toBe("active");

    const fence = new Database(dbPath);
    fence.run(`
      DROP TRIGGER reject_core_named_success;
      CREATE TRIGGER steal_core_named_success_fence
      AFTER UPDATE OF provider_state_json ON request_transcripts
      WHEN NEW.request_id = '${requestId}'
      BEGIN
        UPDATE core_named_claude_attempts SET state = 'failed'
        WHERE request_id = NEW.request_id AND state = 'active';
      END;
    `);
    fence.close();
    expect(resultError(store.publishCoreNamedClaudeSuccess(publicationInput)).message).toContain(
      "lost its unmarked fence",
    );
    expect(getRequestTranscript(store, { requestId })?.providerState).toBeNull();
    expect(
      store.getCoreNamedClaudeSessionAttempt({
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: sessionId,
        requestId,
        attemptIndex: 0,
      })?.state,
    ).toBe("active");
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("rejects unmarked and cross-client named history", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-transcripts-stage5-"));
    const store = new SqliteTranscriptStore(path.join(dir, "transcripts.db"));
    const sessionId = "sub:parent:named:exact-client";
    store.saveRequestTranscript({
      requestId: "unmarked",
      sessionId,
      requestClient: "unknown",
      messages: [{ role: "assistant", content: "generic" }],
    });
    store.saveRequestTranscript({
      requestId: "discord-marked",
      sessionId,
      requestClient: "unknown",
      messages: [{ role: "assistant", content: "discord" }],
      stableNamedRequestClient: "discord",
      providerState: { lastFamily: "ai-sdk", containsCrossFamilyTurns: false },
    });
    store.saveRequestTranscript({
      requestId: "github-marked",
      sessionId,
      requestClient: "unknown",
      messages: [{ role: "assistant", content: "github" }],
      stableNamedRequestClient: "github",
      providerState: { lastFamily: "ai-sdk", containsCrossFamilyTurns: false },
    });
    store.saveRequestTranscript({
      requestId: "unmarked-only",
      sessionId: "sub:parent:named:unmarked-only",
      requestClient: "unknown",
      messages: [{ role: "assistant", content: "generic only" }],
    });

    expect(
      getLatestCompleteNamedTranscript(store, { requestClient: "discord", sessionId })?.requestId,
    ).toBe("discord-marked");
    expect(
      getLatestCompleteNamedTranscript(store, { requestClient: "github", sessionId })?.requestId,
    ).toBe("github-marked");
    expect(getLatestCompleteNamedTranscript(store, { requestClient: "web", sessionId })).toBeNull();
    expect(
      getLatestCompleteNamedTranscript(store, {
        requestClient: "discord",
        sessionId: "sub:parent:named:unmarked-only",
      }),
    ).toBeNull();

    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("rejects a schema-v1 database pending the offline blob migration", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-transcripts-stage6-"));
    const dbPath = path.join(dir, "transcripts.db");
    const db = new Database(dbPath);
    db.run(`CREATE TABLE transcript_schema_migrations (
      version INTEGER PRIMARY KEY, applied_ts INTEGER NOT NULL
    )`);
    db.run("INSERT INTO transcript_schema_migrations VALUES (1, 1)");
    db.run(`CREATE TABLE request_transcripts (
      request_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      request_client TEXT NOT NULL,
      created_ts INTEGER NOT NULL,
      updated_ts INTEGER NOT NULL,
      model_label TEXT,
      final_text TEXT,
      messages_json TEXT NOT NULL,
      context_meta_json TEXT,
      provider_state_json TEXT,
      stable_named_request_client TEXT
    )`);
    const messages = [{ role: "assistant", content: "legacy" }] satisfies StoredMessageV1[];
    db.run("INSERT INTO request_transcripts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [
      "legacy-v1",
      "session",
      "discord",
      1,
      1,
      null,
      "legacy",
      SuperJSON.stringify(messages),
      null,
      SuperJSON.stringify({ lastFamily: "ai-sdk", containsCrossFamilyTurns: false }),
      null,
    ]);
    db.close();

    expect(() => new SqliteTranscriptStore(dbPath)).toThrow(
      "Core transcript schema 1 requires offline blob migration. Run: bun run migrate:blob-storage -- --config /path/to/core-config.yaml --data-dir /path/to/data",
    );

    const migrated = new Database(dbPath);
    expect(
      migrated.query("SELECT version FROM transcript_schema_migrations ORDER BY version").all(),
    ).toEqual([{ version: 1 }]);
    expect(
      migrated
        .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'core_%'")
        .all(),
    ).not.toContainEqual({ name: "core_primary_lineage_manifests" });
    migrated.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("rolls back the schema-v1 migration when a transcript is corrupt", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-transcripts-migration-rollback-"));
    const dbPath = path.join(dir, "transcripts.db");
    const db = new Database(dbPath);
    db.run(`CREATE TABLE transcript_schema_migrations (
      version INTEGER PRIMARY KEY, applied_ts INTEGER NOT NULL
    )`);
    db.run("INSERT INTO transcript_schema_migrations VALUES (1, 1)");
    db.run(`CREATE TABLE request_transcripts (
      request_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      request_client TEXT NOT NULL,
      created_ts INTEGER NOT NULL,
      updated_ts INTEGER NOT NULL,
      model_label TEXT,
      final_text TEXT,
      messages_json TEXT NOT NULL,
      context_meta_json TEXT,
      provider_state_json TEXT,
      stable_named_request_client TEXT
    )`);
    db.run("INSERT INTO request_transcripts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [
      "corrupt-v1",
      "session",
      "discord",
      1,
      1,
      null,
      null,
      "not-superjson",
      null,
      null,
      null,
    ]);
    db.close();

    expect(() => new SqliteTranscriptStore(dbPath)).toThrow(
      "Core transcript schema 1 requires offline blob migration. Run: bun run migrate:blob-storage -- --config /path/to/core-config.yaml --data-dir /path/to/data",
    );

    const rolledBack = new Database(dbPath);
    expect(
      rolledBack.query("SELECT version FROM transcript_schema_migrations ORDER BY version").all(),
    ).toEqual([{ version: 1 }]);
    expect(
      rolledBack
        .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'core_owned_blobs'")
        .all(),
    ).toEqual([]);
    expect(
      rolledBack
        .query("SELECT name FROM pragma_table_info('request_transcripts') WHERE name = ?")
        .all("transcript_digest"),
    ).toEqual([]);
    rolledBack.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("keeps the first admitted surface projection and its owned blob immutable", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-transcripts-stage6-"));
    const dbPath = path.join(dir, "transcripts.db");
    const store = new SqliteTranscriptStore(dbPath);
    const blob = putCoreOwnedBlob(store, {
      blob: durableBlob("owned attachment", "owned-attachment"),
      mediaType: "text/plain",
      filename: "attachment.txt",
    });
    const key = {
      requestClient: "discord",
      surfaceId: "guild:channel",
      sessionId: "channel",
      messageId: "message-1",
      projectionFormatVersion: CORE_SURFACE_PROJECTION_FORMAT_VERSION,
    } as const;
    const first = admitCoreSurfaceProjection(store, {
      ...key,
      canonicalMessages: [{ role: "user", content: "first text" }],
      sourceFacts: {
        author: { id: "author-1", name: "First Author" },
        reactions: ["one"],
        attachmentUrl: "https://first.invalid/attachment",
      },
      ownedBlobs: [blob],
    });
    const readmitted = admitCoreSurfaceProjection(store, {
      ...key,
      canonicalMessages: [{ role: "user", content: "edited text" }],
      sourceFacts: {
        author: { id: "author-2", name: "Edited Author" },
        reactions: ["changed"],
        attachmentUrl: "https://edited.invalid/attachment",
      },
      ownedBlobs: [],
    });

    expect(readmitted).toEqual(first);
    expect(readmitted.canonicalMessages).toEqual([{ role: "user", content: "first text" }]);
    expect(readmitted.ownedBlobs).toEqual([
      {
        ownerId: blob.ownerId,
        blob: blob.blob,
        mediaType: "text/plain",
        filename: "attachment.txt",
      },
    ]);
    store.close();

    const reopened = new SqliteTranscriptStore(dbPath);
    expect(getCoreSurfaceProjection(reopened, key)).toEqual(first);
    reopened.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("rolls back projection admission when the inserted projection is not retained", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-projection-rollback-"));
    const dbPath = path.join(dir, "transcripts.db");
    const store = new SqliteTranscriptStore(dbPath);
    const raw = new Database(dbPath);
    raw.run(`
      CREATE TABLE projection_admission_audit (message_id TEXT NOT NULL);
      CREATE TRIGGER discard_admitted_projection
      AFTER INSERT ON core_surface_projections
      BEGIN
        INSERT INTO projection_admission_audit (message_id) VALUES (NEW.message_id);
        DELETE FROM core_surface_projections
        WHERE request_client = NEW.request_client
          AND surface_id = NEW.surface_id
          AND session_id = NEW.session_id
          AND message_id = NEW.message_id
          AND projection_format_version = NEW.projection_format_version;
      END;
    `);

    expect(
      resultError(
        store.admitCoreSurfaceProjection({
          requestClient: "discord",
          surfaceId: "discord:rollback",
          sessionId: "rollback",
          messageId: "discarded",
          projectionFormatVersion: CORE_SURFACE_PROJECTION_FORMAT_VERSION,
          canonicalMessages: [{ role: "user", content: "discard me" }],
          sourceFacts: {},
          ownedBlobs: [],
        }),
      ).message,
    ).toContain("was not retained");
    expect(
      raw
        .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM projection_admission_audit")
        .get(),
    ).toEqual({ count: 0 });
    expect(
      raw
        .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM core_surface_projections")
        .get(),
    ).toEqual({ count: 0 });

    raw.close();
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("reports immutable orphan projections and prunes only an explicitly selected unowned blob", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-transcripts-retention-"));
    const dbPath = path.join(dir, "transcripts.db");
    const store = new SqliteTranscriptStore(dbPath);
    const retainedBlob = putCoreOwnedBlob(store, {
      blob: durableBlob("retained", "retained"),
      mediaType: "text/plain",
      filename: "retained.txt",
    });
    const orphanBlob = putCoreOwnedBlob(store, {
      blob: durableBlob("orphan", "orphan"),
      mediaType: "text/plain",
      filename: "orphan.txt",
    });
    const projectionKey = {
      requestClient: "discord",
      surfaceId: "discord:retention",
      sessionId: "retention",
      messageId: "first-seen",
      projectionFormatVersion: CORE_SURFACE_PROJECTION_FORMAT_VERSION,
    } as const;
    admitCoreSurfaceProjection(store, {
      ...projectionKey,
      canonicalMessages: [{ role: "user", content: "first seen" }],
      sourceFacts: {},
      ownedBlobs: [retainedBlob],
    });
    expect(getCoreRetentionDiagnostics(store)).toMatchObject({
      unreferencedProjectionCount: 1,
      ownedBlobBytes: retainedBlob.blob.byteLength + orphanBlob.blob.byteLength,
      unreferencedOwnedBlobCount: 1,
      unreferencedOwnedBlobBytes: orphanBlob.blob.byteLength,
      orphanManifestCount: 0,
    });
    store.close();

    const reopened = new SqliteTranscriptStore(dbPath);
    expect(getCoreSurfaceProjection(reopened, projectionKey)?.ownedBlobs).toEqual([
      {
        ownerId: retainedBlob.ownerId,
        blob: retainedBlob.blob,
        mediaType: retainedBlob.mediaType,
        filename: retainedBlob.filename,
      },
    ]);
    expect(getCoreOwnedBlob(reopened, { ownerId: orphanBlob.ownerId }).ownerId).toBe(
      orphanBlob.ownerId,
    );
    expect(reopened.deleteCoreOwnedBlobIfUnreferenced({ ownerId: orphanBlob.ownerId })).toEqual(
      orphanBlob.blob,
    );
    const missingBlob = reopened.getCoreOwnedBlob({ ownerId: orphanBlob.ownerId });
    expect(missingBlob.status).toBe("error");
    expect(getCoreRetentionDiagnostics(reopened)).toMatchObject({
      unreferencedProjectionCount: 1,
      ownedBlobBytes: retainedBlob.blob.byteLength,
      unreferencedOwnedBlobCount: 0,
      unreferencedOwnedBlobBytes: 0,
    });
    const indexed = new Database(dbPath);
    expect(
      indexed
        .query(
          `SELECT name FROM sqlite_master WHERE type = 'index' AND name IN (
             'idx_core_lineage_projection_refs_projection',
             'idx_core_surface_projection_blobs_blob'
           ) ORDER BY name`,
        )
        .all(),
    ).toEqual([
      { name: "idx_core_lineage_projection_refs_projection" },
      { name: "idx_core_surface_projection_blobs_blob" },
    ]);
    indexed.close();
    reopened.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("owns transcript blob references until transcript retention releases them", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-transcript-blobs-"));
    const dbPath = path.join(dir, "transcripts.db");
    const blobStore = resultValue(await createMemoryBlobStore());
    const bytes = new TextEncoder().encode("local read output");
    const upload = resultValue(
      await blobStore.startUpload({ source: bytes, retention: { kind: "durable" } }),
    );
    const blob = resultValue(await upload.completion);
    let store = new SqliteTranscriptStore(dbPath);

    resultValue(
      store.saveRequestTranscript({
        requestId: "local-read",
        sessionId: "session",
        requestClient: "discord",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "blob",
                blob,
                mediaType: "text/plain",
                filename: "local.txt",
              },
            ],
          },
        ],
      }),
    );
    store.close();
    const schema7 = new Database(dbPath);
    schema7.run("DROP TRIGGER delete_transcript_surface_aliases");
    schema7.run("ALTER TABLE surface_message_to_request DROP COLUMN deleted_ts");
    schema7.run("DROP TABLE core_agent_run_checkpoint_blobs");
    schema7.run("DROP TABLE core_transcript_blob_refs");
    schema7.run("ALTER TABLE core_owned_blobs DROP COLUMN deletion_claim_ts");
    schema7.run("DELETE FROM transcript_schema_migrations WHERE version >= 8");
    schema7.close();
    store = new SqliteTranscriptStore(dbPath);
    expect(store.deleteCoreOwnedBlobIfUnreferenced({ ownerId: blob.objectId })).toBeNull();

    const inspection = new Database(dbPath);
    expect(
      inspection
        .query("SELECT request_id, position, blob_owner_id FROM core_transcript_blob_refs")
        .all(),
    ).toEqual([{ request_id: "local-read", position: 0, blob_owner_id: blob.objectId }]);
    inspection.run("PRAGMA foreign_keys = ON");
    inspection.run("DELETE FROM request_transcripts WHERE request_id = ?", ["local-read"]);
    inspection.close();

    expect(
      resultValue(
        await store.maintainCoreOwnedBlobs({
          blobStore,
          limit: 8,
          now: Date.now() + 10 * 60 * 1_000,
        }),
      ),
    ).toEqual({ inspected: 1, deleted: 1, retained: 0, failed: 0 });
    expect((await blobStore.open(blob)).status).toBe("error");

    store.close();
    resultValue(await blobStore.close({ deadlineAtMs: Date.now() + 1_000 }));
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("blocks new references while an unreferenced blob deletion is in progress", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-transcript-blob-claim-"));
    const store = new SqliteTranscriptStore(path.join(dir, "transcripts.db"));
    const blobStore = resultValue(await createMemoryBlobStore());
    const upload = resultValue(
      await blobStore.startUpload({
        source: new TextEncoder().encode("claimed local read"),
        retention: { kind: "durable" },
      }),
    );
    const blob = resultValue(await upload.completion);
    const owned = putCoreOwnedBlob(store, {
      blob,
      mediaType: "text/plain",
      filename: "claimed.txt",
    });
    let releaseDeletion: (() => void) | undefined;
    const deletionReleased = new Promise<void>((resolve) => {
      releaseDeletion = resolve;
    });
    let signalDeletionStarted: (() => void) | undefined;
    const deletionStarted = new Promise<void>((resolve) => {
      signalDeletionStarted = resolve;
    });

    const maintenance = store.maintainCoreOwnedBlobs({
      blobStore: {
        delete: async (target) => {
          signalDeletionStarted?.();
          await deletionReleased;
          return blobStore.delete(target);
        },
      },
      limit: 8,
      now: Date.now() + 10 * 60 * 1_000,
    });
    await deletionStarted;

    const transcriptFailure = resultError(
      store.saveRequestTranscript({
        requestId: "claimed-transcript",
        sessionId: "session",
        requestClient: "discord",
        messages: [
          {
            role: "user",
            content: [{ type: "blob", blob, mediaType: "text/plain", filename: "claimed.txt" }],
          },
        ],
      }),
    );
    expect(transcriptFailure).toBeInstanceOf(CoreOwnedBlobIntegrityError);
    expect(transcriptFailure.message).toContain("pending deletion");

    const projectionFailure = resultError(
      store.admitCoreSurfaceProjection({
        requestClient: "discord",
        surfaceId: "surface",
        sessionId: "session",
        messageId: "claimed-message",
        projectionFormatVersion: CORE_SURFACE_PROJECTION_FORMAT_VERSION,
        canonicalMessages: [{ role: "user", content: "claimed" }],
        sourceFacts: {},
        ownedBlobs: [owned],
      }),
    );
    expect(projectionFailure).toBeInstanceOf(CoreOwnedBlobIntegrityError);
    expect(projectionFailure.message).toContain("pending deletion");

    releaseDeletion?.();
    expect(resultValue(await maintenance)).toEqual({
      inspected: 1,
      deleted: 1,
      retained: 0,
      failed: 0,
    });
    expect((await blobStore.open(blob)).status).toBe("error");

    store.close();
    resultValue(await blobStore.close({ deadlineAtMs: Date.now() + 1_000 }));
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("keeps a failed deletion claimed until maintenance can retry it", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-transcript-blob-retry-"));
    const store = new SqliteTranscriptStore(path.join(dir, "transcripts.db"));
    const blobStore = resultValue(await createMemoryBlobStore());
    const upload = resultValue(
      await blobStore.startUpload({
        source: new TextEncoder().encode("fenced local read"),
        retention: { kind: "durable" },
      }),
    );
    const blob = resultValue(await upload.completion);
    putCoreOwnedBlob(store, {
      blob,
      mediaType: "text/plain",
      filename: "fenced.txt",
    });
    const firstMaintenanceNow = Date.now() + 10 * 60 * 1_000;

    expect(
      resultValue(
        await store.maintainCoreOwnedBlobs({
          blobStore: {
            delete: async () =>
              Result.err(
                new BlobDeleteFailed({
                  objectId: blob.objectId,
                  failure: new BlobAdapterFailure({
                    adapter: "memory",
                    kind: "io",
                    operation: "delete",
                    message: "physical deletion failed after fencing",
                  }),
                  message: "physical deletion failed after fencing",
                }),
              ),
          },
          limit: 8,
          now: firstMaintenanceNow,
        }),
      ),
    ).toEqual({ inspected: 1, deleted: 0, retained: 0, failed: 1 });

    const referenceFailure = resultError(
      store.saveRequestTranscript({
        requestId: "fenced-transcript",
        sessionId: "session",
        requestClient: "discord",
        messages: [
          {
            role: "user",
            content: [{ type: "blob", blob, mediaType: "text/plain", filename: "fenced.txt" }],
          },
        ],
      }),
    );
    expect(referenceFailure).toBeInstanceOf(CoreOwnedBlobIntegrityError);
    expect(referenceFailure.message).toContain("pending deletion");

    expect(
      resultValue(
        await store.maintainCoreOwnedBlobs({
          blobStore,
          limit: 8,
          now: firstMaintenanceNow + 31 * 60 * 1_000,
        }),
      ),
    ).toEqual({ inspected: 1, deleted: 1, retained: 0, failed: 0 });

    store.close();
    resultValue(await blobStore.close({ deadlineAtMs: Date.now() + 1_000 }));
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("fails explicitly for corrupt or missing owned projection blobs", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-transcripts-stage6-"));
    const dbPath = path.join(dir, "transcripts.db");
    const key = {
      requestClient: "discord",
      surfaceId: "surface",
      sessionId: "session",
      messageId: "message",
      projectionFormatVersion: CORE_SURFACE_PROJECTION_FORMAT_VERSION,
    } as const;
    const first = new SqliteTranscriptStore(dbPath);
    const blob = putCoreOwnedBlob(first, {
      blob: durableBlob("blob bytes", "corrupt-blob"),
      mediaType: "text/plain",
      filename: "blob.txt",
    });
    admitCoreSurfaceProjection(first, {
      ...key,
      canonicalMessages: [{ role: "user", content: "with blob" }],
      sourceFacts: {},
      ownedBlobs: [blob],
    });
    first.close();

    const raw = new Database(dbPath);
    raw.run("UPDATE core_owned_blobs SET blob_ref_json = ? WHERE owner_id = ?", [
      "{}",
      blob.ownerId,
    ]);
    raw.close();
    const corrupt = new SqliteTranscriptStore(dbPath);
    expect(() => getCoreSurfaceProjection(corrupt, key)).toThrow(CoreOwnedBlobIntegrityError);
    expect(() => getCoreSurfaceProjection(corrupt, key)).toThrow("failed validation");
    corrupt.close();

    const missing = new SqliteTranscriptStore(dbPath);
    const remove = new Database(dbPath);
    remove.run("UPDATE core_owned_blobs SET blob_ref_json = ? WHERE owner_id = ?", [
      JSON.stringify(blob.blob),
      blob.ownerId,
    ]);
    remove.run("PRAGMA foreign_keys = OFF");
    remove.run("DELETE FROM core_owned_blobs WHERE owner_id = ?", [blob.ownerId]);
    remove.close();
    expect(() => getCoreSurfaceProjection(missing, key)).toThrow(CoreOwnedBlobIntegrityError);
    expect(() => getCoreSurfaceProjection(missing, key)).toThrow("references a missing blob");
    missing.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("rejects unresolved lineage messages at the persistence boundary", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-transcripts-stored-lineage-"));
    const store = new SqliteTranscriptStore(path.join(dir, "transcripts.db"));
    store.saveRequestTranscript({
      requestId: "stored-lineage-owner",
      sessionId: "session",
      requestClient: "discord",
      messages: [{ role: "assistant", content: "owner" }],
    });
    const pendingMessages = [
      {
        role: "user",
        content: [
          {
            type: "blob",
            blob: { version: 1, objectId: `b1_${"01".repeat(16)}` },
            mediaType: "image/png",
          },
        ],
      },
    ] satisfies BusMessageV2[];
    const pendingAtom = {
      kind: "surface",
      requestClient: "discord",
      surfaceId: "discord:session",
      sessionId: "session",
      messageId: "pending-upload",
    } as const;
    const pendingManifest: CoreLineageManifestV2 = {
      state: "complete",
      lineageVersion: 2,
      currentCanonicalStart: 0,
      segments: [
        {
          atoms: [pendingAtom],
          canonicalMessages: pendingMessages,
          canonicalStart: 0,
          canonicalEnd: 1,
          cumulativeAtomCount: 1,
          cumulativePrefixDigest: computeCoreLineagePrefixDigestV2([pendingAtom]),
        },
      ],
    };

    const rejected = store.saveCorePrimaryLineageManifest({
      requestId: "stored-lineage-owner",
      manifest: pendingManifest,
    });
    expect(resultError(rejected)).toMatchObject({
      _tag: "TranscriptTransactionConflict",
      reason: "lineage-invalid",
    });
    expect(getCorePrimaryLineageManifest(store, { requestId: "stored-lineage-owner" })).toBeNull();

    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("roundtrips aligned manifests and exposes exact request atom metadata", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-transcripts-stage6-"));
    const dbPath = path.join(dir, "transcripts.db");
    const store = new SqliteTranscriptStore(dbPath);
    const sourceResourceId = `r1_${"61".repeat(16)}` as ResourceId;
    const sourceResourceUri = `resource://${sourceResourceId}`;
    resultValue(
      store.registerOrGet({
        candidateResourceId: sourceResourceId,
        origin: {
          version: 1,
          kind: "discord-attachment",
          channelId: "session",
          messageId: "source-resource",
          ordinal: 0,
          attachmentId: "source-resource",
        },
        filename: "source.webp",
        declaredMediaType: "image/webp",
        reportedByteLength: 321,
        createdAt: 1,
      }),
    );
    const sourceMessages = [
      {
        role: "assistant",
        content: [
          {
            type: "resource",
            uri: sourceResourceUri,
            filename: "source.webp",
            mediaType: "image/webp",
            size: 321,
          },
        ],
      },
    ] satisfies StoredMessageV1[];
    store.saveRequestTranscript({
      requestId: "source",
      sessionId: "session",
      requestClient: "discord",
      messages: sourceMessages,
      providerState: { lastFamily: "claude-code", containsCrossFamilyTurns: true },
    });
    const metadata = getCoreRequestAtomMetadata(store, { requestId: "source" });
    expect(metadata).toEqual({
      requestId: "source",
      transcriptDigest: hashCanonicalStoredMessagesV2(sourceMessages).hash,
      providerFamily: "claude-code",
      containsCrossFamilyTurns: true,
    });
    if (!metadata) throw new Error("expected request atom metadata");
    const atom = { kind: "request", ...metadata } as const;
    const requestAlias = {
      requestClient: "discord",
      surfaceId: "discord:session",
      sessionId: "session",
      messageId: "source-output",
    } as const;
    admitCoreSurfaceProjection(store, {
      ...requestAlias,
      projectionFormatVersion: CORE_SURFACE_PROJECTION_FORMAT_VERSION,
      canonicalMessages: [{ role: "assistant", content: "surface output" }],
      sourceFacts: {},
      ownedBlobs: [],
    });
    const sourceOutputRef = {
      platform: "discord",
      channelId: "session",
      messageId: "source-output",
    } as const;
    store.linkSurfaceMessagesToRequest({
      requestId: "source",
      created: [sourceOutputRef],
      last: sourceOutputRef,
    });
    const manifest = manifestFor([atom], sourceMessages, [requestAlias]);
    store.saveRequestTranscript({
      requestId: "destination",
      sessionId: "session",
      requestClient: "discord",
      messages: sourceMessages,
      corePrimaryLineage: manifest,
    });
    const storedManifest = getCorePrimaryLineageManifest(store, { requestId: "destination" });
    expect(storedManifest).toEqual(manifest);
    const storedCanonicalMessages: StoredMessageV1[] =
      storedManifest?.segments.flatMap((segment) => segment.canonicalMessages) ?? [];
    expect(storedCanonicalMessages).toEqual(sourceMessages);
    const transformedMetadataMessages = [
      {
        role: "assistant",
        content: [
          {
            type: "resource",
            uri: sourceResourceUri,
            filename: "downloaded.png",
            mediaType: "image/png",
            size: 999,
          },
        ],
      },
    ] satisfies StoredMessageV1[];
    expect(
      validateCorePrimaryLineageReferences(store, {
        manifest: manifestFor([atom], transformedMetadataMessages, [requestAlias]),
        requestClient: "discord",
        sessionId: "session",
        surfaceId: "discord:session",
      }),
    ).toBeNull();
    const differentResourceMessages = structuredClone(transformedMetadataMessages);
    differentResourceMessages[0]!.content[0]!.uri = `resource://r1_${"62".repeat(16)}`;
    expect(
      validateCorePrimaryLineageReferences(store, {
        manifest: manifestFor([atom], differentResourceMessages, [requestAlias]),
        requestClient: "discord",
        sessionId: "session",
        surfaceId: "discord:session",
      }),
    ).toBe("transformed-request-lineage");
    const constrained = new Database(dbPath);
    constrained.run("PRAGMA foreign_keys = ON");
    expect(() =>
      constrained.run("DELETE FROM core_surface_projections WHERE message_id = 'source-output'"),
    ).toThrow();
    constrained.close();

    const replacementMessages = [
      { role: "assistant", content: "different projection" },
    ] satisfies StoredMessageV1[];
    expect(
      resultError(
        store.saveCorePrimaryLineageManifest({
          requestId: "destination",
          manifest: manifestFor([atom], replacementMessages, [requestAlias]),
        }),
      ).message,
    ).toContain("is immutable");

    store.saveRequestTranscript({
      requestId: "provider-mismatch",
      sessionId: "session",
      requestClient: "discord",
      messages: sourceMessages,
    });
    expect(
      resultError(
        store.saveCorePrimaryLineageManifest({
          requestId: "provider-mismatch",
          manifest: manifestFor(
            [
              {
                ...atom,
                providerFamily: "ai-sdk",
                containsCrossFamilyTurns: false,
              },
            ],
            sourceMessages,
            [requestAlias],
          ),
        }),
      ).message,
    ).toContain("stale-request-provider-lineage");

    expect(
      resultError(
        store.saveRequestTranscript({
          requestId: "wrong-scope",
          sessionId: "other-session",
          requestClient: "discord",
          messages: sourceMessages,
          corePrimaryLineage: manifest,
        }),
      ).message,
    ).toContain("stale-request-lineage");
    expect(getRequestTranscript(store, { requestId: "wrong-scope" })).toBeNull();

    const ordinaryMessages = [
      { role: "assistant", content: "not a checkpoint" },
    ] satisfies StoredMessageV1[];
    store.saveRequestTranscript({
      requestId: "ordinary",
      sessionId: "session",
      requestClient: "discord",
      messages: ordinaryMessages,
    });
    expect(
      resultError(
        store.saveRequestTranscript({
          requestId: "invalid-checkpoint-owner",
          sessionId: "session",
          requestClient: "discord",
          messages: ordinaryMessages,
          corePrimaryLineage: buildCoreLineageManifestV2([
            {
              atoms: [
                {
                  kind: "checkpoint",
                  requestId: "ordinary",
                  transcriptDigest: hashCanonicalStoredMessagesV2(ordinaryMessages).hash,
                },
              ],
              canonicalMessages: ordinaryMessages,
            },
          ]),
        }),
      ).message,
    ).toContain("stale-checkpoint-lineage");

    store.saveRequestTranscript({
      requestId: "unlinked-checkpoint",
      sessionId: "session",
      requestClient: "discord",
      messages: ordinaryMessages,
      contextMeta: { type: "compaction", formatVersion: 1 },
    });
    const checkpointManifest = buildCoreLineageManifestV2([
      {
        atoms: [
          {
            kind: "checkpoint",
            requestId: "unlinked-checkpoint",
            transcriptDigest: hashCanonicalStoredMessagesV2(ordinaryMessages).hash,
          },
        ],
        canonicalMessages: ordinaryMessages,
      },
    ]);
    expect(
      resultError(
        store.saveRequestTranscript({
          requestId: "unlinked-checkpoint-owner",
          sessionId: "session",
          requestClient: "discord",
          messages: ordinaryMessages,
          corePrimaryLineage: checkpointManifest,
        }),
      ).message,
    ).toContain("stale-checkpoint-lineage");
    store.linkSurfaceMessagesToRequest({
      requestId: "unlinked-checkpoint",
      created: [{ platform: "discord", channelId: "other-session", messageId: "wrong-output" }],
      last: { platform: "discord", channelId: "other-session", messageId: "wrong-output" },
    });
    expect(
      resultError(
        store.saveRequestTranscript({
          requestId: "wrong-scope-checkpoint-owner",
          sessionId: "session",
          requestClient: "discord",
          messages: ordinaryMessages,
          corePrimaryLineage: checkpointManifest,
        }),
      ).message,
    ).toContain("stale-checkpoint-lineage");

    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("retains transcripts, projections, and blobs referenced by complete manifests", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-transcripts-stage6-"));
    const dbPath = path.join(dir, "transcripts.db");
    const store = new SqliteTranscriptStore(dbPath);
    const checkpointMessages = [
      { role: "assistant", content: "checkpoint" },
    ] satisfies StoredMessageV1[];
    store.saveRequestTranscript({
      requestId: "checkpoint",
      sessionId: "session",
      requestClient: "discord",
      messages: checkpointMessages,
      contextMeta: { type: "compaction", formatVersion: 1 },
    });
    const checkpointOutputRef = {
      platform: "discord",
      channelId: "session",
      messageId: "checkpoint-output",
    } as const;
    store.linkSurfaceMessagesToRequest({
      requestId: "checkpoint",
      created: [checkpointOutputRef],
      last: checkpointOutputRef,
    });
    const blob = putCoreOwnedBlob(store, {
      blob: durableBlob("retained", "lineage-retained"),
      mediaType: "text/plain",
      filename: "retained.txt",
    });
    const projectionKey = {
      requestClient: "discord",
      surfaceId: "discord:session",
      sessionId: "session",
      messageId: "surface-message",
      projectionFormatVersion: CORE_SURFACE_PROJECTION_FORMAT_VERSION,
    } as const;
    admitCoreSurfaceProjection(store, {
      ...projectionKey,
      canonicalMessages: [{ role: "user", content: "surface" }],
      sourceFacts: {
        segmentMessageIds: ["surface-message"],
        segmentDigest: hashCanonicalStoredMessagesV2([{ role: "user", content: "surface" }]).hash,
      },
      ownedBlobs: [blob],
    });
    const destinationMessages = [
      ...checkpointMessages,
      { role: "user", content: "surface" },
    ] satisfies StoredMessageV1[];
    const manifest = buildCoreLineageManifestV2([
      {
        atoms: [
          {
            kind: "checkpoint",
            requestId: "checkpoint",
            transcriptDigest: hashCanonicalStoredMessagesV2(checkpointMessages).hash,
          },
        ],
        canonicalMessages: checkpointMessages,
      },
      {
        atoms: [
          {
            kind: "surface",
            requestClient: "discord",
            surfaceId: "discord:session",
            sessionId: "session",
            messageId: "surface-message",
          },
        ],
        canonicalMessages: [{ role: "user", content: "surface" }],
      },
    ]);
    store.saveRequestTranscript({
      requestId: "destination",
      sessionId: "session",
      requestClient: "discord",
      messages: destinationMessages,
      corePrimaryLineage: manifest,
    });

    expect(unlinkSurfaceMessage(store, checkpointOutputRef)).toEqual({
      requestId: "checkpoint",
      checkpointDeleted: false,
    });
    expect(
      validateCorePrimaryLineageReferences(store, {
        manifest,
        requestClient: "discord",
        sessionId: "session",
        surfaceId: "discord:session",
      }),
    ).toBe("stale-checkpoint-lineage");
    expect(deleteUnlinkedCheckpointCandidate(store, { requestId: "checkpoint" })).toBe(false);
    const constrained = new Database(dbPath);
    constrained.run("PRAGMA foreign_keys = ON");
    expect(() =>
      constrained.run("DELETE FROM request_transcripts WHERE request_id = 'checkpoint'"),
    ).toThrow();
    expect(() =>
      constrained.run("DELETE FROM core_surface_projections WHERE message_id = 'surface-message'"),
    ).toThrow();
    expect(() =>
      constrained.run("DELETE FROM core_owned_blobs WHERE owner_id = ?", [blob.ownerId]),
    ).toThrow();

    constrained.run("DELETE FROM request_transcripts WHERE request_id = 'destination'");
    expect(deleteUnlinkedCheckpointCandidate(store, { requestId: "checkpoint" })).toBe(true);
    constrained.run("DELETE FROM core_surface_projections WHERE message_id = 'surface-message'");
    constrained.run("DELETE FROM core_owned_blobs WHERE owner_id = ?", [blob.ownerId]);
    expect(constrained.query("PRAGMA foreign_key_check").all()).toEqual([]);
    constrained.close();

    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("publishes and CAS-promotes a primary head without output links", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-transcripts-stage7-"));
    const dbPath = path.join(dir, "transcripts.db");
    const store = new SqliteTranscriptStore(dbPath);
    const sessionId = "primary-channel";
    const inputMessages = [{ role: "user", content: "first" }] satisfies StoredMessageV1[];
    const manifest = buildCoreLineageManifestV2([
      {
        atoms: [
          {
            kind: "synthetic",
            source: "stage7-test",
            messageDigest: hashCanonicalStoredMessagesV2(inputMessages).hash,
          },
        ],
        canonicalMessages: inputMessages,
      },
    ]);
    const response = [{ role: "assistant", content: "answer" }] satisfies StoredMessageV1[];
    const providerState = {
      lastFamily: "claude-code",
      containsCrossFamilyTurns: false,
    } as const;
    const candidateSessionId = crypto.randomUUID();
    reservePrimaryAttempt(store, {
      providerId: "claude-code",
      requestClient: "discord",
      lilacSessionId: sessionId,
      executionScopeHashVersion: 1,
      executionScopeHash: "scope",
      requestId: "primary-1",
      attemptIndex: 0,
      candidateSessionId,
      sourceSessionId: null,
      expectedBindingRevision: null,
    });
    store.saveRequestTranscript({
      requestId: "primary-1",
      sessionId,
      requestClient: "discord",
      messages: response,
      corePrimaryLineage: manifest,
    });
    const transcript = getRequestTranscript(store, { requestId: "primary-1" });
    if (!transcript?.transcriptDigest) throw new Error("terminal transcript missing");
    const head = computeCorePrimaryClaudeTerminalHead({
      manifest,
      requestId: "primary-1",
      transcriptDigest: transcript.transcriptDigest,
      responseMessageCount: response.length,
      providerState,
    });
    store.publishCorePrimaryClaudeSuccess({
      providerId: "claude-code",
      requestClient: "discord",
      lilacSessionId: sessionId,
      requestId: "primary-1",
      attemptIndex: 0,
      terminalRequestId: "primary-1",
      terminalLineageVersion: 2,
      terminalAtomCount: head.atomCount,
      terminalPrefixDigest: head.prefixDigest,
      terminalCanonicalMessageCount: head.canonicalMessageCount,
      providerState,
      nativeCwd: "/workspace",
      nativeLastModified: 10,
      nativeContextTokens: 100,
      nativeContextMaxTokens: 1_000,
      lastModelSpecifier: "claude-code/sonnet",
      lastReasoning: "medium",
    });
    expect(store.listSurfaceMessagesForRequest({ requestId: "primary-1" })).toEqual([]);
    expect(
      promotePrimaryBinding(store, {
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: sessionId,
        requestId: "primary-1",
        attemptIndex: 0,
      }),
    ).toBe(true);
    expect(
      getPrimaryBinding(store, {
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: sessionId,
      }),
    ).toMatchObject({
      claudeSessionId: candidateSessionId,
      lineageVersion: 2,
      atomCount: head.atomCount,
      prefixDigest: head.prefixDigest,
      canonicalMessageCount: 2,
      revision: 1,
    });
    expect(getRequestTranscript(store, { requestId: "primary-1" })?.providerState).toEqual(
      providerState,
    );

    const clean = getPrimaryBinding(store, {
      providerId: "claude-code",
      requestClient: "discord",
      lilacSessionId: sessionId,
    });
    if (!clean) throw new Error("clean binding missing");
    const reservePublished = (requestId: string) => {
      reservePrimaryAttempt(store, {
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: sessionId,
        executionScopeHashVersion: 1,
        executionScopeHash: "scope",
        requestId,
        attemptIndex: 0,
        candidateSessionId: crypto.randomUUID(),
        sourceSessionId: clean.claudeSessionId,
        expectedBindingRevision: clean.revision,
      });
      store.saveRequestTranscript({
        requestId,
        sessionId,
        requestClient: "discord",
        messages: [{ role: "assistant", content: requestId }],
        corePrimaryLineage: manifest,
      });
      const candidateTranscript = getRequestTranscript(store, { requestId });
      if (!candidateTranscript?.transcriptDigest) throw new Error("candidate transcript missing");
      const candidateHead = computeCorePrimaryClaudeTerminalHead({
        manifest,
        requestId,
        transcriptDigest: candidateTranscript.transcriptDigest,
        responseMessageCount: 1,
        providerState,
      });
      store.publishCorePrimaryClaudeSuccess({
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: sessionId,
        requestId,
        attemptIndex: 0,
        terminalRequestId: requestId,
        terminalLineageVersion: 2,
        terminalAtomCount: candidateHead.atomCount,
        terminalPrefixDigest: candidateHead.prefixDigest,
        terminalCanonicalMessageCount: candidateHead.canonicalMessageCount,
        providerState,
        nativeCwd: "/workspace",
        nativeLastModified: 20,
        nativeContextTokens: 200,
        nativeContextMaxTokens: 1_000,
        lastModelSpecifier: "claude-code/opus",
        lastReasoning: "high",
      });
    };
    reservePublished("primary-winner");
    reservePublished("primary-stale");
    expect(
      promotePrimaryBinding(store, {
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: sessionId,
        requestId: "primary-winner",
        attemptIndex: 0,
      }),
    ).toBe(true);
    expect(
      promotePrimaryBinding(store, {
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: sessionId,
        requestId: "primary-stale",
        attemptIndex: 0,
      }),
    ).toBe(false);
    expect(
      store.getCorePrimaryClaudeSessionAttempt({
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: sessionId,
        requestId: "primary-stale",
        attemptIndex: 0,
      })?.state,
    ).toBe("failed");

    const current = getPrimaryBinding(store, {
      providerId: "claude-code",
      requestClient: "discord",
      lilacSessionId: sessionId,
    });
    expect(current?.terminalRequestId).toBe("primary-winner");
    const corrupt = new Database(dbPath);
    corrupt.run(
      "UPDATE core_primary_lineage_manifests SET manifest_json = 'corrupt' WHERE request_id = ?",
      ["primary-winner"],
    );
    corrupt.close();
    store.close();
    const lazyVerification = new SqliteTranscriptStore(dbPath);
    expect(getCoreRetentionDiagnostics(lazyVerification)).toMatchObject({
      primaryBindingCount: 1,
      unverifiablePrimaryBindingCount: 0,
    });
    const unreadableBinding = lazyVerification.getCorePrimaryClaudeSessionBinding({
      providerId: "claude-code",
      requestClient: "discord",
      lilacSessionId: sessionId,
    });
    expect(unreadableBinding.status).toBe("error");
    if (unreadableBinding.status === "error") {
      switch (unreadableBinding.error._tag) {
        case "CoreClaudeBindingCorrupt":
          expect(unreadableBinding.error.bindingKind).toBe("primary");
          break;
        case "TranscriptStoreSqliteDriverFailure":
          throw unreadableBinding.error;
      }
    }
    expect(getCoreRetentionDiagnostics(lazyVerification)).toMatchObject({
      primaryBindingCount: 1,
      unverifiablePrimaryBindingCount: 0,
      orphanSucceededAttemptCount: 0,
    });

    lazyVerification.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("recovers primary outcomes and rejects stale promotion races", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-transcripts-stage7-"));
    const dbPath = path.join(dir, "transcripts.db");
    const sessionId = "primary-recovery";
    const providerState = {
      lastFamily: "claude-code",
      containsCrossFamilyTurns: false,
    } as const;
    const inputMessages = [{ role: "user", content: "recover" }] satisfies StoredMessageV1[];
    const manifest = buildCoreLineageManifestV2([
      {
        atoms: [
          {
            kind: "synthetic",
            source: "recovery",
            messageDigest: hashCanonicalStoredMessagesV2(inputMessages).hash,
          },
        ],
        canonicalMessages: inputMessages,
      },
    ]);
    const first = new SqliteTranscriptStore(dbPath);
    const publishPending = (requestId: string, expectedBindingRevision: number | null) => {
      const candidateSessionId = crypto.randomUUID();
      const binding = getPrimaryBinding(first, {
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: sessionId,
      });
      reservePrimaryAttempt(first, {
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: sessionId,
        executionScopeHashVersion: 1,
        executionScopeHash: "scope",
        requestId,
        attemptIndex: 0,
        candidateSessionId,
        sourceSessionId: binding?.claudeSessionId ?? null,
        expectedBindingRevision,
      });
      const response = [{ role: "assistant", content: requestId }] satisfies StoredMessageV1[];
      first.saveRequestTranscript({
        requestId,
        sessionId,
        requestClient: "discord",
        messages: response,
        corePrimaryLineage: manifest,
      });
      const transcript = getRequestTranscript(first, { requestId });
      if (!transcript?.transcriptDigest) throw new Error("terminal transcript missing");
      const head = computeCorePrimaryClaudeTerminalHead({
        manifest,
        requestId,
        transcriptDigest: transcript.transcriptDigest,
        responseMessageCount: response.length,
        providerState,
      });
      first.publishCorePrimaryClaudeSuccess({
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: sessionId,
        requestId,
        attemptIndex: 0,
        terminalRequestId: requestId,
        terminalLineageVersion: 2,
        terminalAtomCount: head.atomCount,
        terminalPrefixDigest: head.prefixDigest,
        terminalCanonicalMessageCount: head.canonicalMessageCount,
        providerState,
        nativeCwd: "/workspace",
        nativeLastModified: 10,
        nativeContextTokens: 100,
        nativeContextMaxTokens: 1_000,
        lastModelSpecifier: "claude-code/sonnet",
        lastReasoning: "medium",
      });
      return candidateSessionId;
    };
    const recoveredCandidate = publishPending("recover-pending", null);
    reservePrimaryAttempt(first, {
      providerId: "claude-code",
      requestClient: "discord",
      lilacSessionId: "crashed-owner",
      executionScopeHashVersion: 1,
      executionScopeHash: "scope",
      requestId: "crashed",
      attemptIndex: 0,
      candidateSessionId: crypto.randomUUID(),
      sourceSessionId: null,
      expectedBindingRevision: null,
    });
    first.close();

    const recovered = new SqliteTranscriptStore(dbPath);
    expect(
      getPrimaryBinding(recovered, {
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: sessionId,
      })?.claudeSessionId,
    ).toBe(recoveredCandidate);
    expect(
      getPrimaryBinding(recovered, {
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: sessionId,
      })?.revision,
    ).toBe(1);
    expect(
      recovered.getCorePrimaryClaudeSessionAttempt({
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: "crashed-owner",
        requestId: "crashed",
        attemptIndex: 0,
      })?.state,
    ).toBe("uncertain");
    const recoveredAttempt = reservePrimaryAttempt(recovered, {
      providerId: "claude-code",
      requestClient: "discord",
      lilacSessionId: "crashed-owner",
      executionScopeHashVersion: 1,
      executionScopeHash: "scope",
      requestId: "crashed",
      attemptIndex: 0,
      candidateSessionId: crypto.randomUUID(),
      sourceSessionId: null,
      expectedBindingRevision: null,
    });
    expect(recoveredAttempt.attemptIndex).toBe(2);
    expect(recoveredAttempt.state).toBe("active");
    expect(
      recovered.getCorePrimaryClaudeSessionAttempt({
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: "crashed-owner",
        requestId: "crashed",
        attemptIndex: 0,
      })?.state,
    ).toBe("uncertain");
    recovered.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("preserves primary fork and fresh-fallback parity across recovery collisions", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-primary-recovery-parity-"));
    const dbPath = path.join(dir, "transcripts.db");
    const owner = {
      providerId: "claude-code",
      requestClient: "discord" as const,
      lilacSessionId: "primary-recovery-parity",
      executionScopeHashVersion: 1 as const,
      executionScopeHash: "scope",
      requestId: "recovered-request",
      sourceSessionId: null,
      expectedBindingRevision: null,
    };
    const first = new SqliteTranscriptStore(dbPath);
    reservePrimaryAttempt(first, {
      ...owner,
      attemptIndex: 0,
      candidateSessionId: crypto.randomUUID(),
    });
    recordPrimaryAttemptOutcome(first, {
      providerId: owner.providerId,
      requestClient: owner.requestClient,
      lilacSessionId: owner.lilacSessionId,
      requestId: owner.requestId,
      attemptIndex: 0,
      state: "failed",
    });
    reservePrimaryAttempt(first, {
      ...owner,
      attemptIndex: 1,
      candidateSessionId: crypto.randomUUID(),
    });
    first.close();

    const recovered = new SqliteTranscriptStore(dbPath);
    expect(
      recovered.getCorePrimaryClaudeSessionAttempt({
        providerId: owner.providerId,
        requestClient: owner.requestClient,
        lilacSessionId: owner.lilacSessionId,
        requestId: owner.requestId,
        attemptIndex: 1,
      })?.state,
    ).toBe("uncertain");
    const fork = reservePrimaryAttempt(recovered, {
      ...owner,
      attemptIndex: 0,
      candidateSessionId: crypto.randomUUID(),
    });
    expect(fork.attemptIndex).toBe(2);
    recordPrimaryAttemptOutcome(recovered, {
      providerId: owner.providerId,
      requestClient: owner.requestClient,
      lilacSessionId: owner.lilacSessionId,
      requestId: owner.requestId,
      attemptIndex: fork.attemptIndex,
      state: "failed",
    });
    const freshFallback = reservePrimaryAttempt(recovered, {
      ...owner,
      attemptIndex: 1,
      candidateSessionId: crypto.randomUUID(),
    });
    expect(freshFallback.attemptIndex).toBe(3);
    expect(
      recovered.getCorePrimaryClaudeSessionAttempt({
        providerId: owner.providerId,
        requestClient: owner.requestClient,
        lilacSessionId: owner.lilacSessionId,
        requestId: owner.requestId,
        attemptIndex: 1,
      })?.state,
    ).toBe("uncertain");

    recovered.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("preserves lifecycle Panic identity after a primary recovery promotion failure", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-primary-recovery-panic-"));
    const dbPath = path.join(dir, "transcripts.db");
    const requestId = "primary-recovery-panic";
    const sessionId = "primary-recovery-session";
    const inputMessages = [{ role: "user", content: "recover" }] satisfies StoredMessageV1[];
    const responseMessages = [{ role: "assistant", content: "ready" }] satisfies StoredMessageV1[];
    const manifest = buildCoreLineageManifestV2([syntheticManifestSegment(inputMessages)]);
    const providerState = {
      lastFamily: "claude-code",
      containsCrossFamilyTurns: false,
    } as const;
    const first = new SqliteTranscriptStore(dbPath);
    reservePrimaryAttempt(first, {
      providerId: "claude-code",
      requestClient: "discord",
      lilacSessionId: sessionId,
      executionScopeHashVersion: 1,
      executionScopeHash: "scope",
      requestId,
      attemptIndex: 0,
      candidateSessionId: crypto.randomUUID(),
      sourceSessionId: null,
      expectedBindingRevision: null,
    });
    first.saveRequestTranscript({
      requestId,
      sessionId,
      requestClient: "discord",
      messages: responseMessages,
      corePrimaryLineage: manifest,
    });
    const transcript = getRequestTranscript(first, { requestId });
    if (!transcript?.transcriptDigest) throw new Error("primary recovery transcript missing");
    const head = computeCorePrimaryClaudeTerminalHead({
      manifest,
      requestId,
      transcriptDigest: transcript.transcriptDigest,
      responseMessageCount: responseMessages.length,
      providerState,
    });
    first.publishCorePrimaryClaudeSuccess({
      providerId: "claude-code",
      requestClient: "discord",
      lilacSessionId: sessionId,
      requestId,
      attemptIndex: 0,
      terminalRequestId: requestId,
      terminalLineageVersion: 2,
      terminalAtomCount: head.atomCount,
      terminalPrefixDigest: head.prefixDigest,
      terminalCanonicalMessageCount: head.canonicalMessageCount,
      providerState,
      nativeCwd: "/workspace",
      nativeLastModified: 10,
      nativeContextTokens: 100,
      nativeContextMaxTokens: 1_000,
      lastModelSpecifier: "claude-code/sonnet",
      lastReasoning: "medium",
    });
    first.close();
    const raw = new Database(dbPath);
    raw.run(`
      CREATE TRIGGER reject_primary_recovery_promotion
      BEFORE INSERT ON core_primary_claude_bindings
      BEGIN
        SELECT RAISE(ABORT, 'reject primary recovery promotion');
      END;
    `);
    raw.close();
    const panic = new Panic({ message: "primary recovery lifecycle invariant" });
    let caught: unknown;

    try {
      new SqliteTranscriptStore(dbPath, (_level, event) => {
        expect(event).toBe("core_primary_claude.promotion_recovery_failed");
        throw panic;
      });
    } catch (cause) {
      caught = cause;
    }

    expect(caught).toBe(panic);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("reports startup promotion rejection conservatively without claiming a CAS race", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-transcripts-recovery-event-"));
    const dbPath = path.join(dir, "transcripts.db");
    const sessionId = "recovery-rejected";
    const first = new SqliteTranscriptStore(dbPath);
    const seeded = seedPrimaryBinding(first, "recovery-base", sessionId);
    const requestId = "recovery-pending";
    const inputMessages = [{ role: "user", content: "pending" }] satisfies StoredMessageV1[];
    const manifest = buildCoreLineageManifestV2([syntheticManifestSegment(inputMessages)]);
    const responseMessages = [
      { role: "assistant", content: "pending response" },
    ] satisfies StoredMessageV1[];
    const providerState = {
      lastFamily: "claude-code",
      containsCrossFamilyTurns: false,
    } as const;
    reservePrimaryAttempt(first, {
      providerId: "claude-code",
      requestClient: "discord",
      lilacSessionId: sessionId,
      executionScopeHashVersion: 1,
      executionScopeHash: "scope",
      requestId,
      attemptIndex: 0,
      candidateSessionId: crypto.randomUUID(),
      sourceSessionId: seeded.binding.claudeSessionId,
      expectedBindingRevision: seeded.binding.revision,
    });
    first.saveRequestTranscript({
      requestId,
      sessionId,
      requestClient: "discord",
      messages: responseMessages,
      corePrimaryLineage: manifest,
    });
    const transcript = getRequestTranscript(first, { requestId });
    if (!transcript?.transcriptDigest) throw new Error("pending transcript missing");
    const head = computeCorePrimaryClaudeTerminalHead({
      manifest,
      requestId,
      transcriptDigest: transcript.transcriptDigest,
      responseMessageCount: responseMessages.length,
      providerState,
    });
    first.publishCorePrimaryClaudeSuccess({
      providerId: "claude-code",
      requestClient: "discord",
      lilacSessionId: sessionId,
      requestId,
      attemptIndex: 0,
      terminalRequestId: requestId,
      terminalLineageVersion: 2,
      terminalAtomCount: head.atomCount,
      terminalPrefixDigest: head.prefixDigest,
      terminalCanonicalMessageCount: head.canonicalMessageCount,
      providerState,
      nativeCwd: "/workspace",
      nativeLastModified: 20,
      nativeContextTokens: 200,
      nativeContextMaxTokens: 1_000,
      lastModelSpecifier: "claude-code/opus",
      lastReasoning: "high",
    });
    first.close();
    const raw = new Database(dbPath);
    raw.run(
      `UPDATE core_primary_claude_bindings SET revision = revision + 1
       WHERE request_client = 'discord' AND session_id = ? AND provider_id = 'claude-code'`,
      [sessionId],
    );
    raw.close();
    const events: Array<{
      level: string;
      event: string;
      detail: Readonly<Record<string, unknown>>;
    }> = [];
    const recovered = new SqliteTranscriptStore(dbPath, (level, event, detail) => {
      events.push({ level, event, detail });
    });

    expect(
      events.find(
        (entry) =>
          entry.event === "core_primary_claude.promotion_recovered" &&
          entry.detail["requestId"] === requestId,
      ),
    ).toMatchObject({
      level: "warn",
      detail: {
        reason: "promotion-rejected",
        outcome: "rejected",
        promoted: false,
      },
    });
    expect(events.some((entry) => entry.detail["reason"] === "binding-cas-lost")).toBe(false);
    recovered.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("rolls back primary publication failures and bounds terminal attempts", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-transcripts-stage7-"));
    const dbPath = path.join(dir, "transcripts.db");
    const store = new SqliteTranscriptStore(dbPath);
    const sessionId = "primary-atomic";
    const inputMessages = [{ role: "user", content: "atomic" }] satisfies StoredMessageV1[];
    const manifest = buildCoreLineageManifestV2([syntheticManifestSegment(inputMessages)]);
    const response = [{ role: "assistant", content: "candidate" }] satisfies StoredMessageV1[];
    const candidateSessionId = crypto.randomUUID();
    reservePrimaryAttempt(store, {
      providerId: "claude-code",
      requestClient: "discord",
      lilacSessionId: sessionId,
      executionScopeHashVersion: 1,
      executionScopeHash: "scope",
      requestId: "atomic-primary",
      attemptIndex: 0,
      candidateSessionId,
      sourceSessionId: null,
      expectedBindingRevision: null,
    });
    store.saveRequestTranscript({
      requestId: "atomic-primary",
      sessionId,
      requestClient: "discord",
      messages: response,
      corePrimaryLineage: manifest,
    });
    const transcript = getRequestTranscript(store, { requestId: "atomic-primary" });
    if (!transcript?.transcriptDigest) throw new Error("atomic transcript missing");
    const providerState = {
      lastFamily: "claude-code",
      containsCrossFamilyTurns: false,
    } as const;
    const head = computeCorePrimaryClaudeTerminalHead({
      manifest,
      requestId: "atomic-primary",
      transcriptDigest: transcript.transcriptDigest,
      responseMessageCount: response.length,
      providerState,
    });
    const publicationInput = {
      providerId: "claude-code",
      requestClient: "discord",
      lilacSessionId: sessionId,
      requestId: "atomic-primary",
      attemptIndex: 0,
      terminalRequestId: "atomic-primary",
      terminalLineageVersion: 2,
      terminalAtomCount: head.atomCount,
      terminalPrefixDigest: head.prefixDigest,
      terminalCanonicalMessageCount: head.canonicalMessageCount,
      providerState,
      nativeCwd: "/workspace",
      nativeLastModified: 10,
      nativeContextTokens: 100,
      nativeContextMaxTokens: 1_000,
      lastModelSpecifier: "claude-code/sonnet",
      lastReasoning: "medium",
    } as const;
    const raw = new Database(dbPath);
    raw.run(`CREATE TRIGGER reject_core_primary_success
      BEFORE UPDATE OF state ON core_primary_claude_attempts
      WHEN NEW.state = 'succeeded'
      BEGIN SELECT RAISE(ABORT, 'simulated primary success failure'); END`);
    raw.close();
    const publication = store.publishCorePrimaryClaudeSuccess(publicationInput);
    expect(publication.status).toBe("error");
    if (publication.status === "error") {
      expect(publication.error._tag).toBe("TranscriptStoreSqliteDriverFailure");
      if (publication.error._tag === "TranscriptStoreSqliteDriverFailure") {
        expect(publication.error.code).toBe("SQLITE_CONSTRAINT_TRIGGER");
      }
    }
    expect(getRequestTranscript(store, { requestId: "atomic-primary" })?.providerState).toBeNull();
    expect(
      getPrimaryBinding(store, {
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: sessionId,
      }),
    ).toBeNull();

    const fence = new Database(dbPath);
    fence.run(`
      DROP TRIGGER reject_core_primary_success;
      CREATE TRIGGER steal_core_primary_success_fence
      AFTER UPDATE OF provider_state_json ON request_transcripts
      WHEN NEW.request_id = 'atomic-primary'
      BEGIN
        UPDATE core_primary_claude_attempts SET state = 'failed'
        WHERE request_id = NEW.request_id AND state = 'active';
      END;
    `);
    fence.close();
    expect(resultError(store.publishCorePrimaryClaudeSuccess(publicationInput)).message).toContain(
      "lost its unmarked fence",
    );
    expect(getRequestTranscript(store, { requestId: "atomic-primary" })?.providerState).toBeNull();
    expect(
      store.getCorePrimaryClaudeSessionAttempt({
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: sessionId,
        requestId: "atomic-primary",
        attemptIndex: 0,
      })?.state,
    ).toBe("active");
    recordPrimaryAttemptOutcome(store, {
      providerId: "claude-code",
      requestClient: "discord",
      lilacSessionId: sessionId,
      requestId: "atomic-primary",
      attemptIndex: 0,
      state: "failed",
    });
    reservePrimaryAttempt(store, {
      providerId: "claude-code",
      requestClient: "discord",
      lilacSessionId: sessionId,
      executionScopeHashVersion: 1,
      executionScopeHash: "scope",
      requestId: "bounded-primary-active",
      attemptIndex: 0,
      candidateSessionId: crypto.randomUUID(),
      sourceSessionId: null,
      expectedBindingRevision: null,
    });

    for (let attemptIndex = 1; attemptIndex <= 40; attemptIndex += 1) {
      reservePrimaryAttempt(store, {
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: sessionId,
        executionScopeHashVersion: 1,
        executionScopeHash: "scope",
        requestId: "bounded-primary",
        attemptIndex,
        candidateSessionId: crypto.randomUUID(),
        sourceSessionId: null,
        expectedBindingRevision: null,
      });
      recordPrimaryAttemptOutcome(store, {
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: sessionId,
        requestId: "bounded-primary",
        attemptIndex,
        state: "failed",
      });
    }
    store.close();
    const retained = new Database(dbPath);
    expect(
      retained
        .query(
          `SELECT COUNT(*) AS count FROM core_primary_claude_attempts
           WHERE request_client = 'discord' AND session_id = ?`,
        )
        .get(sessionId),
    ).toEqual({ count: 33 });
    expect(
      retained
        .query(
          `SELECT state FROM core_primary_claude_attempts
           WHERE request_client = 'discord' AND session_id = ?
             AND request_id = 'bounded-primary-active'`,
        )
        .get(sessionId),
    ).toEqual({ state: "active" });
    retained.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("keeps corrupt named and primary bindings as immutable reservation fences", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-corrupt-binding-fences-"));
    const dbPath = path.join(dir, "transcripts.db");
    const store = new SqliteTranscriptStore(dbPath);
    const namedSessionId = "corrupt-named-fence";
    const primarySessionId = "corrupt-primary-fence";
    seedNamedBinding(store, "named-fence-head", namedSessionId);
    seedPrimaryBinding(store, "primary-fence-head", primarySessionId);

    const mutation = new Database(dbPath);
    mutation.run(
      `UPDATE core_named_claude_bindings SET canonical_head_hash = 'corrupt'
       WHERE session_id = ?`,
      [namedSessionId],
    );
    mutation.run(
      `UPDATE core_primary_claude_bindings SET prefix_digest = 'corrupt'
       WHERE session_id = ?`,
      [primarySessionId],
    );

    expectCorruptBinding(
      store.getCoreNamedClaudeSessionBinding({
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: namedSessionId,
      }),
      "named",
    );
    expectCorruptBinding(
      store.reserveCoreNamedClaudeSessionAttempt({
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: namedSessionId,
        executionScopeHashVersion: 1,
        executionScopeHash: "scope",
        requestId: "named-fence-reserve",
        attemptIndex: 0,
        candidateSessionId: crypto.randomUUID(),
        sourceSessionId: null,
        expectedBindingRevision: null,
      }),
      "named",
    );
    expectCorruptBinding(
      store.promoteCoreNamedClaudeSessionBinding({
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: namedSessionId,
        requestId: "named-fence-head",
        attemptIndex: 0,
      }),
      "named",
    );

    expectCorruptBinding(
      store.getCorePrimaryClaudeSessionBinding({
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: primarySessionId,
      }),
      "primary",
    );
    expectCorruptBinding(
      store.reserveCorePrimaryClaudeSessionAttempt({
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: primarySessionId,
        executionScopeHashVersion: 1,
        executionScopeHash: "scope",
        requestId: "primary-fence-reserve",
        attemptIndex: 0,
        candidateSessionId: crypto.randomUUID(),
        sourceSessionId: null,
        expectedBindingRevision: null,
      }),
      "primary",
    );
    expectCorruptBinding(
      store.promoteCorePrimaryClaudeSessionBinding({
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: primarySessionId,
        requestId: "primary-fence-head",
        attemptIndex: 0,
      }),
      "primary",
    );

    expect(
      mutation
        .query<{ canonical_head_hash: string }, [string]>(
          "SELECT canonical_head_hash FROM core_named_claude_bindings WHERE session_id = ?",
        )
        .get(namedSessionId),
    ).toEqual({ canonical_head_hash: "corrupt" });
    expect(
      mutation
        .query<{ prefix_digest: string }, [string]>(
          "SELECT prefix_digest FROM core_primary_claude_bindings WHERE session_id = ?",
        )
        .get(primarySessionId),
    ).toEqual({ prefix_digest: "corrupt" });
    expect(
      mutation
        .query<{ count: number }, [string, string]>(
          `SELECT COUNT(*) AS count FROM core_named_claude_attempts
           WHERE session_id = ? AND request_id = ?`,
        )
        .get(namedSessionId, "named-fence-reserve"),
    ).toEqual({ count: 0 });
    expect(
      mutation
        .query<{ count: number }, [string, string]>(
          `SELECT COUNT(*) AS count FROM core_primary_claude_attempts
           WHERE session_id = ? AND request_id = ?`,
        )
        .get(primarySessionId, "primary-fence-reserve"),
    ).toEqual({ count: 0 });
    expect(
      mutation
        .query<{ state: string }, [string, string]>(
          `SELECT state FROM core_named_claude_attempts
           WHERE session_id = ? AND request_id = ?`,
        )
        .get(namedSessionId, "named-fence-head"),
    ).toEqual({ state: "succeeded" });
    expect(
      mutation
        .query<{ state: string }, [string, string]>(
          `SELECT state FROM core_primary_claude_attempts
           WHERE session_id = ? AND request_id = ?`,
        )
        .get(primarySessionId, "primary-fence-head"),
    ).toEqual({ state: "succeeded" });

    mutation.close();
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("rolls back a reserved named attempt when retention pruning fails", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-named-reserve-atomicity-"));
    const dbPath = path.join(dir, "transcripts.db");
    const store = new SqliteTranscriptStore(dbPath);
    const owner = {
      providerId: "claude-code",
      requestClient: "discord" as const,
      lilacSessionId: "named-reserve-atomicity",
      executionScopeHashVersion: 1 as const,
      executionScopeHash: "scope",
      sourceSessionId: null,
      expectedBindingRevision: null,
    };
    for (let attemptIndex = 0; attemptIndex < 32; attemptIndex += 1) {
      reserveNamedAttempt(store, {
        ...owner,
        requestId: `terminal-${attemptIndex}`,
        attemptIndex,
        candidateSessionId: crypto.randomUUID(),
      });
      recordNamedAttemptOutcome(store, {
        providerId: owner.providerId,
        requestClient: owner.requestClient,
        lilacSessionId: owner.lilacSessionId,
        requestId: `terminal-${attemptIndex}`,
        attemptIndex,
        state: "failed",
      });
    }

    const mutation = new Database(dbPath);
    mutation.run(
      `INSERT INTO core_named_claude_attempts
       SELECT product, request_client, session_id, provider_id, source_terminal_request_id,
              source_canonical_head_hash, source_canonical_message_count,
              execution_scope_hash_version, execution_scope_hash, 'overflow', 100,
              candidate_session_id, source_session_id, expected_binding_revision, state,
              terminal_request_id, terminal_canonical_head_hash,
              terminal_canonical_message_count, native_cwd, native_last_modified,
              native_context_tokens, native_context_max_tokens, last_model_specifier,
              last_reasoning, created_ts, updated_ts
       FROM core_named_claude_attempts LIMIT 1`,
    );
    mutation.run(`
      CREATE TRIGGER fail_named_attempt_prune
      BEFORE DELETE ON core_named_claude_attempts
      BEGIN
        SELECT RAISE(ABORT, 'simulated retention prune failure');
      END
    `);

    const failedReservation = store.reserveCoreNamedClaudeSessionAttempt({
      ...owner,
      requestId: "must-roll-back",
      attemptIndex: 101,
      candidateSessionId: crypto.randomUUID(),
    });
    expect(failedReservation.status).toBe("error");
    if (failedReservation.status === "error") {
      switch (failedReservation.error._tag) {
        case "TranscriptTransactionConflict":
          throw new Error(`Unexpected transaction conflict: ${failedReservation.error.reason}`);
        case "TranscriptStoreSqliteDriverFailure":
          expect(failedReservation.error.code).toBe("SQLITE_CONSTRAINT_TRIGGER");
          break;
      }
    }
    expect(
      mutation
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM core_named_claude_attempts WHERE request_id = 'must-roll-back'",
        )
        .get(),
    ).toEqual({ count: 0 });

    mutation.close();
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
});
