import {
  CorruptPersistedFields,
  MalformedSerialization,
  UnsupportedVersion,
  type DecodedPersistedValue,
  type PersistedDataError,
  type PersistedDataIssueCode,
} from "@stanley2058/lilac-utils";
import { Result, type Result as ResultType } from "better-result";
import { z } from "zod";

export const CONVERSATION_THREAD_SUMMARY_FORMAT_VERSION = 1;

const SUMMARY_TABLE = "conversation_thread_summaries";

const importanceSchema = z.enum(["low", "medium", "high"]);
const stringArraySchema = z.array(z.string());
const currentAboutnessSchema = z.object({
  domains: stringArraySchema,
  situations: stringArraySchema,
  complaintTargets: stringArraySchema,
  entities: stringArraySchema,
  userWouldAskForThisAs: stringArraySchema,
});
const legacyAboutnessSchema = z.object({
  domains: stringArraySchema.optional(),
  situations: stringArraySchema.optional(),
  complaintTargets: stringArraySchema.optional(),
  entities: stringArraySchema.optional(),
  userWouldAskForThisAs: stringArraySchema.optional(),
});

export type ConversationThreadImportance = z.output<typeof importanceSchema>;

export type ConversationThreadAboutness = {
  readonly domains: string[];
  readonly situations: string[];
  readonly complaintTargets: string[];
  readonly entities: string[];
  readonly userWouldAskForThisAs: string[];
};

export type DecodedConversationThreadSummaryRow = {
  readonly threadId: string;
  readonly title: string;
  readonly brief: string;
  readonly topics: string[];
  readonly retrievalHints: string[];
  readonly aboutness: ConversationThreadAboutness;
  readonly importance: ConversationThreadImportance;
  readonly importanceReasons: string[];
  readonly createdAt: number;
  readonly updatedAt: number;
};

export type PersistedSqliteValue = string | number | bigint | Uint8Array | null;

export type PersistedConversationThreadSummaryRow = {
  readonly thread_id: PersistedSqliteValue;
  readonly title: PersistedSqliteValue;
  readonly brief: PersistedSqliteValue;
  readonly topics_json: PersistedSqliteValue;
  readonly retrieval_hints_json: PersistedSqliteValue;
  readonly aboutness_json: PersistedSqliteValue;
  readonly importance: PersistedSqliteValue;
  readonly importance_reasons_json: PersistedSqliteValue;
  readonly created_at: PersistedSqliteValue;
  readonly updated_at: PersistedSqliteValue;
  readonly summary_format_version: PersistedSqliteValue;
};

type SummaryField =
  | "row"
  | "summary_format_version"
  | "thread_id"
  | "title"
  | "brief"
  | "topics_json"
  | "retrieval_hints_json"
  | "aboutness_json"
  | "importance"
  | "importance_reasons_json"
  | "created_at"
  | "updated_at";

type VersionedFieldInput = {
  readonly raw: PersistedSqliteValue;
  readonly version: PersistedSqliteValue;
  readonly recordId: string;
};

export type ConversationThreadStringArrayCodecInput = VersionedFieldInput & {
  readonly field: "topics_json" | "retrieval_hints_json" | "importance_reasons_json";
};

export type ConversationThreadAboutnessCodecInput = VersionedFieldInput;
export type ConversationThreadImportanceCodecInput = VersionedFieldInput;

type DecodedSummaryVersion = {
  readonly version: 0 | 1;
  readonly provenance: "current" | "migrated";
};

function storageContext(input: {
  readonly field: SummaryField;
  readonly version: number;
  readonly issueCode: PersistedDataIssueCode;
  readonly recordId: string;
}) {
  return {
    table: SUMMARY_TABLE,
    field: input.field,
    version: input.version,
    issueCode: input.issueCode,
    recordId: input.recordId,
    message: `Persisted conversation summary ${input.issueCode}`,
  };
}

function corrupt(input: {
  readonly field: SummaryField;
  readonly version: number;
  readonly issueCode: PersistedDataIssueCode;
  readonly recordId: string;
}): CorruptPersistedFields {
  return new CorruptPersistedFields(storageContext(input));
}

function decodeSummaryVersion(
  raw: PersistedSqliteValue,
  recordId: string,
): ResultType<DecodedSummaryVersion, UnsupportedVersion | CorruptPersistedFields> {
  if (raw === null || raw === 0) return Result.ok({ version: 0, provenance: "migrated" });
  if (raw === CONVERSATION_THREAD_SUMMARY_FORMAT_VERSION) {
    return Result.ok({ version: 1, provenance: "current" });
  }
  if (typeof raw === "number" && Number.isInteger(raw)) {
    return Result.err(
      new UnsupportedVersion(
        storageContext({
          field: "summary_format_version",
          version: raw,
          issueCode: "unsupported-version",
          recordId,
        }),
      ),
    );
  }
  return Result.err(
    corrupt({
      field: "summary_format_version",
      version: -1,
      issueCode: "invalid-row-version",
      recordId,
    }),
  );
}

function parseJson(input: {
  readonly raw: string;
  readonly field: SummaryField;
  readonly version: number;
  readonly recordId: string;
}): ResultType<unknown, MalformedSerialization> {
  const parsed = Result.try({ try: () => JSON.parse(input.raw) as unknown, catch: () => null });
  return parsed.match<ResultType<unknown, MalformedSerialization>>({
    ok: (value) => Result.ok(value),
    err: () =>
      Result.err(
        new MalformedSerialization(
          storageContext({
            field: input.field,
            version: input.version,
            issueCode: "malformed-json",
            recordId: input.recordId,
          }),
        ),
      ),
  });
}

function nonEmptyStrings(values: readonly string[]): string[] {
  return values.filter((value) => value.length > 0);
}

function continuePersisted<T, U>(
  result: ResultType<T, PersistedDataError>,
  onOk: (value: T) => ResultType<U, PersistedDataError>,
): ResultType<U, PersistedDataError> {
  const continuation = result.match<() => ResultType<U, PersistedDataError>>({
    err: (error) => () => Result.err(error),
    ok: (value) => () => onOk(value),
  });
  return continuation();
}

export function decodeConversationThreadStringArray(
  input: ConversationThreadStringArrayCodecInput,
): ResultType<DecodedPersistedValue<string[]>, PersistedDataError> {
  const versionResult = decodeSummaryVersion(input.version, input.recordId);
  return continuePersisted(versionResult, (version) => {
    if (input.raw === null) {
      if (input.field === "topics_json") {
        return Result.err(
          corrupt({
            field: input.field,
            version: version.version,
            issueCode: "missing-required-field",
            recordId: input.recordId,
          }),
        );
      }
      return Result.ok<DecodedPersistedValue<string[]>>({
        value: [],
        provenance: "missing-defaulted",
      });
    }
    if (typeof input.raw !== "string") {
      return Result.err(
        corrupt({
          field: input.field,
          version: version.version,
          issueCode: "invalid-string-array",
          recordId: input.recordId,
        }),
      );
    }
    const parsed = parseJson({
      raw: input.raw,
      field: input.field,
      version: version.version,
      recordId: input.recordId,
    });
    return continuePersisted(parsed, (parsedValue) => {
      const decoded = stringArraySchema.safeParse(parsedValue);
      if (decoded.success) {
        return Result.ok<DecodedPersistedValue<string[]>>({
          value: nonEmptyStrings(decoded.data),
          provenance: version.provenance,
        });
      }
      return Result.err(
        corrupt({
          field: input.field,
          version: version.version,
          issueCode: Array.isArray(parsedValue) ? "mixed-string-array" : "invalid-string-array",
          recordId: input.recordId,
        }),
      );
    });
  });
}

export function decodeConversationThreadImportance(
  input: ConversationThreadImportanceCodecInput,
): ResultType<DecodedPersistedValue<ConversationThreadImportance>, PersistedDataError> {
  return decodeSummaryVersion(input.version, input.recordId).andThen((version) => {
    if (input.raw === null) {
      return Result.ok<DecodedPersistedValue<ConversationThreadImportance>>({
        value: "medium",
        provenance: "missing-defaulted",
      });
    }
    const decoded = importanceSchema.safeParse(input.raw);
    if (!decoded.success) {
      return Result.err(
        corrupt({
          field: "importance",
          version: version.version,
          issueCode: "invalid-importance",
          recordId: input.recordId,
        }),
      );
    }
    return Result.ok<DecodedPersistedValue<ConversationThreadImportance>>({
      value: decoded.data,
      provenance: version.provenance,
    });
  });
}

export function decodeConversationThreadAboutness(
  input: ConversationThreadAboutnessCodecInput,
): ResultType<DecodedPersistedValue<ConversationThreadAboutness>, PersistedDataError> {
  const versionResult = decodeSummaryVersion(input.version, input.recordId);
  return continuePersisted(versionResult, (version) => {
    const empty: ConversationThreadAboutness = {
      domains: [],
      situations: [],
      complaintTargets: [],
      entities: [],
      userWouldAskForThisAs: [],
    };
    if (input.raw === null) {
      return Result.ok<DecodedPersistedValue<ConversationThreadAboutness>>({
        value: empty,
        provenance: "missing-defaulted",
      });
    }
    if (typeof input.raw !== "string") {
      return Result.err(
        corrupt({
          field: "aboutness_json",
          version: version.version,
          issueCode: "invalid-aboutness",
          recordId: input.recordId,
        }),
      );
    }
    const parsed = parseJson({
      raw: input.raw,
      field: "aboutness_json",
      version: version.version,
      recordId: input.recordId,
    });
    return continuePersisted(parsed, (parsedValue) => {
      const decoded =
        version.version === 0
          ? legacyAboutnessSchema.safeParse(parsedValue)
          : currentAboutnessSchema.safeParse(parsedValue);
      if (!decoded.success) {
        return Result.err(
          corrupt({
            field: "aboutness_json",
            version: version.version,
            issueCode: "invalid-aboutness",
            recordId: input.recordId,
          }),
        );
      }
      return Result.ok<DecodedPersistedValue<ConversationThreadAboutness>>({
        value: {
          domains: nonEmptyStrings(decoded.data.domains ?? []),
          situations: nonEmptyStrings(decoded.data.situations ?? []),
          complaintTargets: nonEmptyStrings(decoded.data.complaintTargets ?? []),
          entities: nonEmptyStrings(decoded.data.entities ?? []),
          userWouldAskForThisAs: nonEmptyStrings(decoded.data.userWouldAskForThisAs ?? []),
        },
        provenance: version.provenance,
      });
    });
  });
}

function requiredString(input: {
  readonly raw: PersistedSqliteValue;
  readonly field: SummaryField;
  readonly version: number;
  readonly recordId: string;
}): ResultType<string, CorruptPersistedFields> {
  if (typeof input.raw === "string") return Result.ok(input.raw);
  return Result.err(
    corrupt({
      field: input.field,
      version: input.version,
      issueCode: input.raw === null ? "missing-required-field" : "invalid-row-field",
      recordId: input.recordId,
    }),
  );
}

function requiredTimestamp(input: {
  readonly raw: PersistedSqliteValue;
  readonly field: "created_at" | "updated_at";
  readonly version: number;
  readonly recordId: string;
}): ResultType<number, CorruptPersistedFields> {
  if (typeof input.raw === "number" && Number.isFinite(input.raw)) return Result.ok(input.raw);
  return Result.err(
    corrupt({
      field: input.field,
      version: input.version,
      issueCode: input.raw === null ? "missing-required-field" : "invalid-row-field",
      recordId: input.recordId,
    }),
  );
}

export function decodeConversationThreadSummaryRow(
  row: PersistedConversationThreadSummaryRow,
): ResultType<DecodedPersistedValue<DecodedConversationThreadSummaryRow>, PersistedDataError> {
  const recordId = typeof row.thread_id === "string" ? row.thread_id : "unknown-record";
  return Result.gen(function* () {
    const version = yield* decodeSummaryVersion(row.summary_format_version, recordId);
    const required = (raw: PersistedSqliteValue, field: SummaryField) =>
      requiredString({ raw, field, version: version.version, recordId });
    const threadId = yield* required(row.thread_id, "thread_id");
    const title = yield* required(row.title, "title");
    const brief = yield* required(row.brief, "brief");
    const topics = yield* decodeConversationThreadStringArray({
      raw: row.topics_json,
      version: row.summary_format_version,
      field: "topics_json",
      recordId,
    });
    const retrievalHints = yield* decodeConversationThreadStringArray({
      raw: row.retrieval_hints_json,
      version: row.summary_format_version,
      field: "retrieval_hints_json",
      recordId,
    });
    const aboutness = yield* decodeConversationThreadAboutness({
      raw: row.aboutness_json,
      version: row.summary_format_version,
      recordId,
    });
    const importance = yield* decodeConversationThreadImportance({
      raw: row.importance,
      version: row.summary_format_version,
      recordId,
    });
    const importanceReasons = yield* decodeConversationThreadStringArray({
      raw: row.importance_reasons_json,
      version: row.summary_format_version,
      field: "importance_reasons_json",
      recordId,
    });
    const createdAt = yield* requiredTimestamp({
      raw: row.created_at,
      field: "created_at",
      version: version.version,
      recordId,
    });
    const updatedAt = yield* requiredTimestamp({
      raw: row.updated_at,
      field: "updated_at",
      version: version.version,
      recordId,
    });
    const defaulted = [topics, retrievalHints, aboutness, importance, importanceReasons].some(
      (decoded) => decoded.provenance === "missing-defaulted",
    );
    let provenance: "current" | "migrated" | "missing-defaulted" = "current";
    if (version.provenance === "migrated") {
      provenance = "migrated";
    } else if (defaulted) {
      provenance = "missing-defaulted";
    }
    return Result.ok({
      value: {
        threadId,
        title,
        brief,
        topics: topics.value,
        retrievalHints: retrievalHints.value,
        aboutness: aboutness.value,
        importance: importance.value,
        importanceReasons: importanceReasons.value,
        createdAt,
        updatedAt,
      },
      provenance,
    });
  });
}

const fixtureCurrentRow = {
  thread_id: "thread-current",
  title: "Current",
  brief: "Current brief",
  topics_json: '["runtime"]',
  retrieval_hints_json: "[]",
  aboutness_json:
    '{"domains":[],"situations":[],"complaintTargets":[],"entities":[],"userWouldAskForThisAs":[]}',
  importance: "medium",
  importance_reasons_json: "[]",
  created_at: 1,
  updated_at: 2,
  summary_format_version: 1,
} as const satisfies PersistedConversationThreadSummaryRow;

export const conversationThreadSummaryRowCodecCases = {
  current: { input: fixtureCurrentRow, outcome: "ok", provenance: "current" },
  legacy: {
    input: { ...fixtureCurrentRow, thread_id: "thread-legacy", summary_format_version: null },
    outcome: "ok",
    provenance: "migrated",
  },
  "missing-defaulted": {
    input: { ...fixtureCurrentRow, thread_id: "thread-missing", retrieval_hints_json: null },
    outcome: "ok",
    provenance: "missing-defaulted",
  },
  "unsupported-version": {
    input: { ...fixtureCurrentRow, thread_id: "thread-unsupported", summary_format_version: 2 },
    outcome: "error",
    errorTag: "UnsupportedVersion",
    issueCode: "unsupported-version",
  },
  "malformed-serialization": {
    input: { ...fixtureCurrentRow, thread_id: "thread-malformed", topics_json: "{" },
    outcome: "error",
    errorTag: "MalformedSerialization",
    issueCode: "malformed-json",
  },
  "corrupt-fields": {
    input: { ...fixtureCurrentRow, thread_id: "thread-corrupt", topics_json: '["runtime",1]' },
    outcome: "error",
    errorTag: "CorruptPersistedFields",
    issueCode: "mixed-string-array",
  },
} as const;
