import { describe, expect, it } from "bun:test";
import { type Result as ResultType } from "better-result";

import {
  CORE_PRIMARY_LINEAGE_INITIAL_DIGEST_V2,
  buildCoreLineageManifestV2,
  canonicalizeCoreLineageAtomV2,
  computeCoreLineagePrefixDigestV2,
  coreLineageManifestV2Schema,
  createCorePrimaryLineageFreshOnlyV2,
  decodeCorePrimaryLineageV2,
  extendCoreLineagePrefixDigestV2,
  parseCmdRequestMessageData,
  type CoreLineageAtomV2,
  type CoreLineageManifestV2,
  type StoredMessageV1,
} from "../index";

function requireOk<TValue, TError>(result: ResultType<TValue, TError>): TValue {
  if (result.status === "error") throw result.error;
  return result.value;
}

const ATOMS = [
  {
    kind: "surface",
    requestClient: "discord",
    surfaceId: "discord",
    sessionId: "channel-1",
    messageId: "message-1",
  },
  {
    kind: "request",
    requestId: "request-1",
    transcriptDigest: "11".repeat(32),
    providerFamily: "claude-code",
    containsCrossFamilyTurns: false,
  },
  {
    kind: "synthetic",
    source: "system-policy",
    messageDigest: "22".repeat(32),
  },
  {
    kind: "checkpoint",
    requestId: "request-2",
    transcriptDigest: "33".repeat(32),
  },
] as const satisfies readonly CoreLineageAtomV2[];

const MESSAGES = [
  { role: "user", content: "hello" },
  { role: "assistant", content: "hi" },
  { role: "system", content: "policy" },
  { role: "user", content: "checkpoint summary" },
] as const;

const PREFIX_DIGESTS = [
  "d1c9999403b46d6217163706e86e95e61740d185997b67f7aa784691f4893772",
  "a226c950ad75aa08593cea241058264a03bcf1b40b8949dbcf6a7c98859dd697",
  "a19c48888fe8215407c10ed383b6310910c62c1615f7f928ea4ed13308762ef2",
  "8d9819353cf5938c04d773778a4d19d68a8bdc7230e59087223c35e369a3fe90",
] as const;

function manifestFixture(): CoreLineageManifestV2 {
  return coreLineageManifestV2Schema.parse({
    state: "complete",
    lineageVersion: 2,
    currentCanonicalStart: 3,
    segments: ATOMS.map((atom, index) => ({
      atoms: [atom],
      canonicalMessages: [MESSAGES[index]],
      ...(atom.kind === "request"
        ? {
            requestSource: {
              aliases: [
                {
                  requestClient: "discord",
                  surfaceId: "discord",
                  sessionId: "channel-1",
                  messageId: "request-output-1",
                },
              ],
            },
          }
        : {}),
      canonicalStart: index,
      canonicalEnd: index + 1,
      cumulativeAtomCount: index + 1,
      cumulativePrefixDigest: PREFIX_DIGESTS[index],
    })),
  });
}

describe("Core primary lineage v2", () => {
  it("uses stable canonical atoms and golden rolling SHA-256 digests", () => {
    expect(CORE_PRIMARY_LINEAGE_INITIAL_DIGEST_V2).toBe(
      "f840749255afa84f08861d9e7de3f84a64aa6b0a82154cc6a12bf5ee33639496",
    );
    expect(canonicalizeCoreLineageAtomV2(ATOMS[0])).toBe(
      '{"kind":"surface","messageId":"message-1","requestClient":"discord","sessionId":"channel-1","surfaceId":"discord"}',
    );

    let digest = CORE_PRIMARY_LINEAGE_INITIAL_DIGEST_V2;
    for (const [index, atom] of ATOMS.entries()) {
      digest = requireOk(extendCoreLineagePrefixDigestV2(digest, index + 1, atom));
      expect(digest).toBe(PREFIX_DIGESTS[index]!);
    }
    expect(computeCoreLineagePrefixDigestV2(ATOMS)).toBe(PREFIX_DIGESTS[3]);
  });

  it("accepts complete contiguous segment boundaries aligned to request messages", () => {
    const manifest = manifestFixture();
    const decoded = decodeCorePrimaryLineageV2(manifest, MESSAGES);
    expect(decoded.status).toBe("ok");
    if (decoded.status === "ok") expect(decoded.value).toEqual(manifest);
    expect(
      parseCmdRequestMessageData({
        requestDeliveryId: crypto.randomUUID(),
        queue: "prompt",
        messages: MESSAGES,
        corePrimaryLineage: manifest,
      }).corePrimaryLineage,
    ).toEqual(manifest);
  });

  it("rejects non-canonical ranges, cumulative counts, and rolling digests", () => {
    const rangeGap = structuredClone(manifestFixture());
    rangeGap.segments[1]!.canonicalStart = 0;
    expect(() => coreLineageManifestV2Schema.parse(rangeGap)).toThrow("canonicalStart");

    const incompleteRange = structuredClone(manifestFixture());
    incompleteRange.segments[2]!.canonicalEnd = 4;
    expect(() => coreLineageManifestV2Schema.parse(incompleteRange)).toThrow("canonicalEnd");

    const staleCount = structuredClone(manifestFixture());
    staleCount.segments[3]!.cumulativeAtomCount = 3;
    expect(() => coreLineageManifestV2Schema.parse(staleCount)).toThrow("cumulativeAtomCount");

    const staleDigest = structuredClone(manifestFixture());
    staleDigest.segments[2]!.cumulativePrefixDigest = "00".repeat(32);
    expect(() => coreLineageManifestV2Schema.parse(staleDigest)).toThrow(
      "Cumulative prefix digest",
    );
  });

  it("rejects empty contracts and exact message misalignment", () => {
    expect(() =>
      coreLineageManifestV2Schema.parse({
        state: "complete",
        lineageVersion: 2,
        currentCanonicalStart: 0,
        segments: [],
      }),
    ).toThrow();

    const emptyAtoms = structuredClone(manifestFixture());
    emptyAtoms.segments[0]!.atoms = [];
    expect(() => coreLineageManifestV2Schema.parse(emptyAtoms)).toThrow();

    expect(
      decodeCorePrimaryLineageV2(manifestFixture(), [
        { role: "user", content: "edited" },
        ...MESSAGES.slice(1),
      ]).status,
    ).toBe("error");

    const midSegmentBoundary = structuredClone(manifestFixture());
    midSegmentBoundary.currentCanonicalStart = 2.5;
    expect(() => coreLineageManifestV2Schema.parse(midSegmentBoundary)).toThrow();
  });

  it("requires exact segment variants and globally unique source claims", () => {
    const mixed = structuredClone(manifestFixture());
    mixed.segments[0]!.atoms.push(ATOMS[2]);
    expect(() => coreLineageManifestV2Schema.parse(mixed)).toThrow(
      "must contain only surface atoms",
    );

    const requestWithoutSource = structuredClone(manifestFixture());
    delete requestWithoutSource.segments[1]!.requestSource;
    expect(() => coreLineageManifestV2Schema.parse(requestWithoutSource)).toThrow(
      "request output alias",
    );

    const checkpointWithSource = structuredClone(manifestFixture());
    checkpointWithSource.segments[3]!.requestSource = {
      aliases: [
        {
          requestClient: "discord",
          surfaceId: "discord",
          sessionId: "channel-1",
          messageId: "checkpoint-output",
        },
      ],
    };
    expect(() => coreLineageManifestV2Schema.parse(checkpointWithSource)).toThrow(
      "Only a request segment",
    );

    const duplicateSurface = structuredClone(manifestFixture());
    duplicateSurface.segments[1]!.requestSource!.aliases[0] = {
      requestClient: "discord",
      surfaceId: "discord",
      sessionId: "channel-1",
      messageId: "message-1",
    };
    expect(() => coreLineageManifestV2Schema.parse(duplicateSurface)).toThrow("already claimed");
  });

  it("requires malformed lineage to be replaced explicitly with fresh-only state", () => {
    const malformed = structuredClone(manifestFixture());
    malformed.segments[0]!.cumulativePrefixDigest = "ff".repeat(32);
    expect(decodeCorePrimaryLineageV2(malformed, MESSAGES).status).toBe("error");

    const freshOnly = requireOk(createCorePrimaryLineageFreshOnlyV2("malformed-manifest"));
    const decoded = decodeCorePrimaryLineageV2(freshOnly, MESSAGES);
    expect(decoded.status).toBe("ok");
    if (decoded.status === "ok") {
      expect(decoded.value).toEqual({
        state: "fresh-only",
        lineageVersion: 2,
        currentCanonicalStart: 0,
        reason: "malformed-manifest",
      });
    }
  });

  it("returns owned Results for invalid digest and constructor inputs", () => {
    expect(extendCoreLineagePrefixDigestV2("invalid", 1, ATOMS[0]).status).toBe("error");
    expect(
      extendCoreLineagePrefixDigestV2(CORE_PRIMARY_LINEAGE_INITIAL_DIGEST_V2, 0, ATOMS[0]).status,
    ).toBe("error");
    expect(createCorePrimaryLineageFreshOnlyV2("").status).toBe("error");
    expect(createCorePrimaryLineageFreshOnlyV2("valid", -1).status).toBe("error");
    expect(buildCoreLineageManifestV2([]).status).toBe("error");
    expect(
      buildCoreLineageManifestV2([{ atoms: [ATOMS[2]], canonicalMessages: [MESSAGES[2]] }]).status,
    ).toBe("ok");
  });

  it("defers content-dependent request lineage mismatch until after blob resolution", () => {
    const editedMessages = [{ role: "user" as const, content: "edited" }, ...MESSAGES.slice(1)];
    const decoded = decodeCorePrimaryLineageV2(manifestFixture(), editedMessages);
    expect(decoded.status).toBe("error");
    if (decoded.status === "error") {
      expect(decoded.error.issues).toContainEqual({
        path: [],
        message: "Core primary lineage does not exactly align with canonical messages",
      });
    }
    expect(
      parseCmdRequestMessageData({
        requestDeliveryId: crypto.randomUUID(),
        queue: "prompt",
        messages: editedMessages,
        corePrimaryLineage: manifestFixture(),
      }).corePrimaryLineage,
    ).toEqual(manifestFixture());
  });

  it("compares resolved blob content identity without object ownership or expiry", () => {
    const atom = ATOMS[2];
    const firstMessage = {
      role: "user" as const,
      content: [
        {
          type: "blob" as const,
          blob: {
            version: 1 as const,
            objectId: `b1_${"11".repeat(16)}`,
            sha256: "aa".repeat(32),
            byteLength: 5,
          },
          mediaType: "text/plain",
          filename: "note.txt",
        },
      ],
    };
    const lineage = requireOk(
      buildCoreLineageManifestV2([{ atoms: [atom], canonicalMessages: [firstMessage] }]),
    );
    const independentOwner = {
      ...firstMessage,
      content: [
        {
          ...firstMessage.content[0]!,
          blob: {
            ...firstMessage.content[0]!.blob,
            objectId: `b1_${"22".repeat(16)}`,
            expiresAt: 9_999_999_999_999,
          },
        },
      ],
    };
    expect(decodeCorePrimaryLineageV2(lineage, [independentOwner]).status).toBe("ok");

    independentOwner.content[0]!.blob.sha256 = "bb".repeat(32);
    expect(decodeCorePrimaryLineageV2(lineage, [independentOwner]).status).toBe("error");
  });

  it("compares top-level and tool-result resources by URI without marker metadata", () => {
    const atom = ATOMS[0];
    const uri = `resource://r1_${"ab".repeat(16)}`;
    const topLevelMessage = {
      role: "user",
      content: [
        {
          type: "resource",
          uri,
          filename: "diagram.webp",
          mediaType: "image/webp",
          size: 321,
        },
      ],
    } satisfies StoredMessageV1;
    const toolResultMessage = {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "resource-call",
          toolName: "inspect",
          output: {
            type: "content",
            value: [
              {
                type: "resource",
                uri,
                filename: "diagram.webp",
                mediaType: "image/webp",
                size: 321,
              },
            ],
          },
        },
      ],
    } satisfies StoredMessageV1;
    const messages: [typeof topLevelMessage, typeof toolResultMessage] = [
      topLevelMessage,
      toolResultMessage,
    ];
    const lineage = requireOk(
      buildCoreLineageManifestV2([{ atoms: [atom], canonicalMessages: messages }]),
    );

    expect(decodeCorePrimaryLineageV2(lineage, structuredClone(messages)).status).toBe("ok");

    const changedTopLevelMetadata = structuredClone(messages);
    changedTopLevelMetadata[0]!.content[0]!.filename = "diagram.png";
    changedTopLevelMetadata[0]!.content[0]!.mediaType = "image/png";
    changedTopLevelMetadata[0]!.content[0]!.size = 999;
    expect(decodeCorePrimaryLineageV2(lineage, changedTopLevelMetadata).status).toBe("ok");

    const changedToolResultMetadata = structuredClone(messages);
    changedToolResultMetadata[1]!.content[0]!.output.value[0]!.filename = "diagram.png";
    changedToolResultMetadata[1]!.content[0]!.output.value[0]!.mediaType = "image/png";
    changedToolResultMetadata[1]!.content[0]!.output.value[0]!.size = 999;
    expect(decodeCorePrimaryLineageV2(lineage, changedToolResultMetadata).status).toBe("ok");

    const changedTopLevelUri = structuredClone(messages);
    changedTopLevelUri[0]!.content[0]!.uri = `resource://r1_${"cd".repeat(16)}`;
    expect(decodeCorePrimaryLineageV2(lineage, changedTopLevelUri).status).toBe("error");

    const changedToolResultUri = structuredClone(messages);
    changedToolResultUri[1]!.content[0]!.output.value[0]!.uri = `resource://r1_${"cd".repeat(16)}`;
    expect(decodeCorePrimaryLineageV2(lineage, changedToolResultUri).status).toBe("error");
  });
});
