import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseCoreConfigV1ToUniversal } from "@stanley2058/lilac-utils";

import { ConversationThreadService } from "../../src/conversation/thread-service";
import {
  ConversationThreadSqliteDriverFailure,
  ConversationThreadStore,
  type ConversationThreadPersistenceDiagnostic,
} from "../../src/conversation/thread-store";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, {
        recursive: true,
        force: true,
      }),
    ),
  );
});

async function databasePath(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "lilac-summary-persistence-"));
  temporaryDirectories.push(directory);
  return path.join(directory, "summaries.sqlite");
}

function createLegacySummaryTable(database: Database): void {
  database.run(`
    CREATE TABLE conversation_thread_summaries (
      thread_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      brief TEXT NOT NULL,
      topics_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    INSERT INTO conversation_thread_summaries (
      thread_id, title, brief, topics_json, created_at, updated_at
    ) VALUES (
      'legacy-thread', 'Legacy title', 'Legacy brief', '["legacy"]', 1, 2
    );
  `);
}

describe("conversation thread summary persisted store", () => {
  it("rebuilds legacy derived state once and preserves subsequent summaries", async () => {
    const filename = await databasePath();
    const oldDatabase = new Database(filename, { create: true, strict: true });
    createLegacySummaryTable(oldDatabase);
    oldDatabase.close();

    const store = new ConversationThreadStore(filename);
    expect(store.getSummary("legacy-thread").unwrap()).toBeNull();
    store
      .upsertSummary("new-thread", "hash", { title: "New", brief: "Rebuilt", topics: [] })
      .unwrap();
    store.close();
    const reopened = new ConversationThreadStore(filename);
    expect(reopened.getSummary("new-thread").unwrap()?.title).toBe("New");
    reopened.close();
  });

  it("writes only the current row format version", async () => {
    const filename = await databasePath();
    const store = new ConversationThreadStore(filename);
    try {
      const written = store.upsertSummary("current-thread", "hash", {
        title: "Current title",
        brief: "Current brief",
        topics: ["current"],
      });
      expect(written.status).toBe("ok");

      const inspection = new Database(filename, { strict: true });
      try {
        const row = inspection
          .query<{ summary_format_version: number }, []>(
            "SELECT summary_format_version FROM conversation_thread_summaries WHERE thread_id = 'current-thread'",
          )
          .get();
        expect(row?.summary_format_version).toBe(1);
      } finally {
        inspection.close();
      }
    } finally {
      store.close();
    }
  });

  it("emits bounded content-redacted diagnostics", async () => {
    const filename = await databasePath();
    const diagnostics: ConversationThreadPersistenceDiagnostic[] = [];
    const store = new ConversationThreadStore(filename, {
      onPersistenceDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    const secret = "SECRET_SENTINEL_DO_NOT_LOG";
    try {
      const written = store.upsertSummary("corrupt-thread", "hash", {
        title: "Title",
        brief: "Brief",
        topics: ["topic"],
      });
      expect(written.status).toBe("ok");

      const mutation = new Database(filename, { strict: true });
      try {
        mutation.run(
          "UPDATE conversation_thread_summaries SET topics_json = ? WHERE thread_id = ?",
          [`{${secret}`, "corrupt-thread"],
        );
      } finally {
        mutation.close();
      }

      const summary = store.getSummary("corrupt-thread");
      expect(summary.status).toBe("error");
      expect(diagnostics).toEqual([
        {
          table: "conversation_thread_summaries",
          field: "topics_json",
          version: 1,
          issueCode: "malformed-json",
          recordId: "corrupt-thread",
        },
      ]);
      expect(JSON.stringify(diagnostics)).not.toContain(secret);
      if (summary.status === "error") expect(summary.error.message).not.toContain(secret);
    } finally {
      store.close();
    }
  });

  it("rolls back the summary row when a later facet write hits a driver failure", async () => {
    const filename = await databasePath();
    const store = new ConversationThreadStore(filename);
    const setup = new Database(filename, { strict: true });
    try {
      setup.run(`
        CREATE TRIGGER reject_summary_facet
        BEFORE INSERT ON conversation_thread_facets
        BEGIN
          SELECT RAISE(ABORT, 'reject test facet');
        END;
      `);
    } finally {
      setup.close();
    }

    try {
      const written = store.upsertSummary("rolled-back-thread", "hash", {
        title: "Rollback title",
        brief: "Rollback brief",
        topics: ["facet forces the later write"],
      });
      expect(written.status).toBe("error");
      if (written.status === "error") {
        expect(written.error).toBeInstanceOf(ConversationThreadSqliteDriverFailure);
      }

      const inspection = new Database(filename, { strict: true });
      try {
        const count = inspection
          .query<{ count: number }, []>(
            "SELECT count(*) AS count FROM conversation_thread_summaries WHERE thread_id = 'rolled-back-thread'",
          )
          .get();
        expect(count?.count).toBe(0);
      } finally {
        inspection.close();
      }
    } finally {
      store.close();
    }
  });

  it("propagates read and search decode failures as values without changing valid ranking", async () => {
    const filename = await databasePath();
    const store = new ConversationThreadStore(filename);
    const setup = new Database(filename, { strict: true });
    try {
      setup.run(
        `
        INSERT INTO conversation_threads (
          thread_id, channel_id, kind, start_message_id, end_message_id,
          start_ts, end_ts, message_count, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        ["search-thread", "c1", "inferred_channel_thread", "m1", "m2", 1, 2, 2, 2],
      );
    } finally {
      setup.close();
    }

    try {
      const written = store.upsertSummary("search-thread", "hash", {
        title: "Needle architecture",
        brief: "A stable searchable summary",
        topics: ["needle"],
      });
      expect(written.status).toBe("ok");

      const config = parseCoreConfigV1ToUniversal({
        surface: { discord: { botName: "lilac", allowedChannelIds: ["c1"] } },
      });
      const service = new ConversationThreadService({ store, getConfig: async () => config });
      const validSearch = await service.search({ query: "needle", mode: "lexical" });
      expect(validSearch.status).toBe("ok");
      if (validSearch.status === "ok") {
        expect(validSearch.value.results.map((result) => result.threadId)).toEqual([
          "search-thread",
        ]);
      }

      const mutation = new Database(filename, { strict: true });
      try {
        mutation.run(
          "UPDATE conversation_thread_summaries SET topics_json = ? WHERE thread_id = ?",
          ['["needle",1]', "search-thread"],
        );
      } finally {
        mutation.close();
      }

      const read = await service.read({ threadId: "search-thread" });
      expect(read.status).toBe("error");
      if (read.status === "error") {
        expect(read.error._tag).toBe("CorruptPersistedFields");
        if (read.error._tag === "CorruptPersistedFields") {
          expect(read.error.issueCode).toBe("mixed-string-array");
        }
      }

      const search = await service.search({ query: "needle", mode: "lexical" });
      expect(search.status).toBe("error");
      if (search.status === "error" && search.error._tag === "CorruptPersistedFields") {
        expect(search.error.issueCode).toBe("mixed-string-array");
      }
    } finally {
      store.close();
    }
  });
});
