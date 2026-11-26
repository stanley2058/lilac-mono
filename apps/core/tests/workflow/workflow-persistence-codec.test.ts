import { describe, expect, it } from "bun:test";

import {
  decodeWorkflowPersistenceRow,
  workflowPersistenceRowFamilyFixtures,
  workflowPersistenceRowCodecCases,
} from "../../src/workflow/workflow-persistence-codec";

describe("workflow persistence row codec catalog", () => {
  it("executes and classifies all six outcomes for every persisted row family", () => {
    const errorTags = {
      "unsupported-version": "UnsupportedVersion",
      "malformed-serialization": "MalformedSerialization",
      "corrupt-fields": "CorruptPersistedFields",
      "missing-rejected": "CorruptPersistedFields",
    } as const;
    for (const fixtures of Object.values(workflowPersistenceRowFamilyFixtures)) {
      for (const [outcome, fixture] of Object.entries(fixtures)) {
        const result = (() => {
          switch (fixture.input.kind) {
            case "artifact":
              return decodeWorkflowPersistenceRow(fixture.input);
            case "revision":
              return decodeWorkflowPersistenceRow(fixture.input);
            case "run":
              return decodeWorkflowPersistenceRow(fixture.input);
            case "operation":
              return decodeWorkflowPersistenceRow(fixture.input);
            case "wait":
              return decodeWorkflowPersistenceRow(fixture.input);
            case "trigger":
              return decodeWorkflowPersistenceRow(fixture.input);
            case "binding":
              return decodeWorkflowPersistenceRow(fixture.input);
            case "action":
              return decodeWorkflowPersistenceRow(fixture.input);
            case "dispatch":
              return decodeWorkflowPersistenceRow(fixture.input);
            case "receipt":
              return decodeWorkflowPersistenceRow(fixture.input);
            case "outbox":
              return decodeWorkflowPersistenceRow(fixture.input);
            case "legacy-audit":
              return decodeWorkflowPersistenceRow(fixture.input);
          }
          throw new Error("Unhandled workflow persistence fixture family");
        })();
        const successful =
          outcome === "current" || outcome === "legacy" || outcome === "missing-defaulted";
        expect(result.status).toBe(successful ? "ok" : "error");
        if ("value" in result) {
          let provenance: "current" | "migrated" | "missing-defaulted";
          if (outcome === "current") provenance = "current";
          else if (outcome === "legacy") provenance = "migrated";
          else provenance = "missing-defaulted";
          expect(result.value.provenance).toBe(provenance);
        } else {
          expect(result.error._tag).toBe(errorTags[outcome as keyof typeof errorTags]);
        }
      }
    }
  });

  it("decodes legacy rows without rewriting the persisted input", () => {
    const input = structuredClone(workflowPersistenceRowCodecCases.legacy.input);
    const before = JSON.stringify(input);
    const decoded = decodeWorkflowPersistenceRow(input);

    expect(decoded.status).toBe("ok");
    if (decoded.status === "ok") expect(decoded.value.provenance).toBe("migrated");
    expect(JSON.stringify(input)).toBe(before);
  });

  it("defaults the v24 binding gate without rewriting legacy rows and requires it in v25", () => {
    const fixture = workflowPersistenceRowFamilyFixtures.binding.legacy.input;
    const { permanent_failure_json: _omitted, ...legacyRow } = fixture.row;
    const before = JSON.stringify(legacyRow);
    const legacy = decodeWorkflowPersistenceRow({
      kind: "binding",
      row: legacyRow,
      schemaVersion: 24,
    });
    expect(legacy.status).toBe("ok");
    if (legacy.status === "ok") {
      expect(legacy.value.provenance).toBe("migrated");
      expect(legacy.value.value.permanentFailure).toBeNull();
    }
    expect(JSON.stringify(legacyRow)).toBe(before);

    const current = decodeWorkflowPersistenceRow({
      kind: "binding",
      row: legacyRow,
      schemaVersion: 25,
    });
    expect(current.status).toBe("error");
    if (current.status === "error") expect(current.error._tag).toBe("CorruptPersistedFields");
  });

  it("rejects JSON comments and trailing commas as malformed serialization", () => {
    for (const argsJson of ['{"value":1,}', '{/* comment */"value":1}']) {
      const current = workflowPersistenceRowCodecCases.current.input;
      const decoded = decodeWorkflowPersistenceRow({
        ...current,
        row: { ...current.row, args_json: argsJson },
      });
      expect(decoded.status).toBe("error");
      if (decoded.status === "error") {
        expect(decoded.error._tag).toBe("MalformedSerialization");
      }
    }
  });

  it("preserves independent workflow targets and rejects invalid action correlation", () => {
    const runFixture = workflowPersistenceRowFamilyFixtures.run.current.input;
    const run = decodeWorkflowPersistenceRow({
      ...runFixture,
      row: {
        ...runFixture.row,
        origin_client: "discord",
        origin_session_id: "discord-channel",
        origin_user_id: "user-1",
        progress_target_json:
          '{"platform":"github","channelId":"octo/repo#1","replyToMessageId":null}',
      },
    });
    expect(run.status).toBe("ok");
    if (run.status === "ok") {
      expect(run.value.value).toMatchObject({
        origin: { client: "discord", sessionId: "discord-channel", userId: "user-1" },
        progressTarget: { platform: "github", channelId: "octo/repo#1" },
      });
    }
    const migratedRun = decodeWorkflowPersistenceRow({
      ...runFixture,
      row: {
        ...runFixture.row,
        origin_client: "discord",
        origin_session_id: "discord-channel",
        origin_user_id: "user-1",
        progress_target_json:
          '{"platform":"github","channelId":"octo/repo#1","replyToMessageId":null}',
      },
      schemaVersion: 24,
    });
    expect(migratedRun.status).toBe("ok");
    if (migratedRun.status === "ok") expect(migratedRun.value.provenance).toBe("migrated");

    const actionFixture = workflowPersistenceRowFamilyFixtures.action.current.input;
    const action = decodeWorkflowPersistenceRow({
      ...actionFixture,
      row: { ...actionFixture.row, expected_platform: "github" },
    });
    expect(action.status).toBe("error");
    if (action.status === "error") expect(action.error._tag).toBe("CorruptPersistedFields");

    const consumedByWrongUser = decodeWorkflowPersistenceRow({
      ...actionFixture,
      row: {
        ...actionFixture.row,
        consumed_at: 2,
        consumed_by_platform: "discord",
        consumed_by_user_id: "wrong-user",
      },
    });
    expect(consumedByWrongUser.status).toBe("error");
    if (consumedByWrongUser.status === "error") {
      expect(consumedByWrongUser.error._tag).toBe("CorruptPersistedFields");
    }
    const consumedByExpectedUser = decodeWorkflowPersistenceRow({
      ...actionFixture,
      row: {
        ...actionFixture.row,
        consumed_at: 2,
        consumed_by_platform: "discord",
        consumed_by_user_id: "fixture-user",
      },
    });
    expect(consumedByExpectedUser.status).toBe("ok");
  });

  it("decodes the permanent projection gate and distinguishes malformed from corrupt gate data", () => {
    const fixture = workflowPersistenceRowFamilyFixtures.binding.current.input;
    const permanentFailure = {
      operation: "send",
      reason: "unsupported",
      configurationRevision: "discord-workflow-progress-v1",
      message: "unsupported",
      failedAt: 10,
    } as const;
    const current = decodeWorkflowPersistenceRow({
      ...fixture,
      row: { ...fixture.row, permanent_failure_json: JSON.stringify(permanentFailure) },
    });
    expect(current.status).toBe("ok");
    if (current.status === "ok") {
      expect(current.value.value.permanentFailure).toEqual(permanentFailure);
    }

    const malformed = decodeWorkflowPersistenceRow({
      ...fixture,
      row: { ...fixture.row, permanent_failure_json: "{" },
    });
    expect(malformed.status).toBe("error");
    if (malformed.status === "error") expect(malformed.error._tag).toBe("MalformedSerialization");

    const corrupt = decodeWorkflowPersistenceRow({
      ...fixture,
      row: { ...fixture.row, permanent_failure_json: '{"operation":"send"}' },
    });
    expect(corrupt.status).toBe("error");
    if (corrupt.status === "error") expect(corrupt.error._tag).toBe("CorruptPersistedFields");

    for (const reason of [
      "permission-denied",
      "rate-limited",
      "unavailable",
      "correlation-mismatch",
    ]) {
      const retryableOnly = decodeWorkflowPersistenceRow({
        ...fixture,
        row: {
          ...fixture.row,
          permanent_failure_json: JSON.stringify({ ...permanentFailure, reason }),
        },
      });
      expect(retryableOnly.status).toBe("error");
      if (retryableOnly.status === "error") {
        expect(retryableOnly.error._tag).toBe("CorruptPersistedFields");
      }
    }
  });
});
