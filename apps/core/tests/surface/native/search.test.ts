import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { NativeStore } from "../../../src/surface/native/store";
import { NativeSearchStore } from "../../../src/surface/native/store-search";
import { NativeSearchService } from "../../../src/surface/native/search";
import { nativeSearchTool } from "../../../src/surface/native/search-tools";
import { Discovery } from "../../../src/tool-server/tools/discovery";
import type { DiscoveryService } from "../../../src/discovery/discovery-service";

let db: Database;
let store: NativeStore;
let search: NativeSearchService;
let messages: NativeSearchStore;
beforeEach(() => {
  db = new Database(":memory:");
  store = new NativeStore(db, () => 1000);
  store.initialize().unwrap();
  for (const id of ["owner", "alice", "bob"])
    store
      .upsertUser({
        id,
        providerId: id,
        displayName: id,
        role: id === "owner" ? "owner" : "participant",
        toolMode: "full",
      })
      .unwrap();
  messages = new NativeSearchStore({ db, store });
  search = new NativeSearchService({ store, searchStore: messages });
});
afterEach(() => db.close());
function thread(userId: string, title: string, text: string) {
  const created = store.createThread(userId, { commandId: `create_${title}`, title }).unwrap();
  const input = store
    .acceptInput(userId, {
      threadId: created.id,
      commandId: `input_${title}`,
      text,
      historyGeneration: 0,
      mode: "prompt",
      attachmentIds: [],
      skillIds: [],
    })
    .unwrap();
  return { id: created.id, turnId: input.turnId! };
}

describe("native search authority", () => {
  test("filters thread content before limit, pagination, and snippets", () => {
    thread("alice", "secret", "Private needle secret");
    const allowed = thread("bob", "visible", "Visible needle");
    const result = search.query("bob", { query: "needle", limit: 1 }).unwrap();
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.threadId).toBe(allowed.id);
    expect(result.nextCursor).toBeUndefined();
    expect(search.query("owner", { query: "needle" }).unwrap().items).toHaveLength(2);
  });
  test("share removal revokes content, metadata, and reads immediately", () => {
    const hidden = thread("alice", "secret", "needle");
    store.shareThread("owner", { threadId: hidden.id, userId: "bob", grant: "read" }).unwrap();
    expect(messages.readThread("bob", hidden.id).unwrap().total).toBe(1);
    store.shareThread("owner", { threadId: hidden.id, userId: "bob", grant: null }).unwrap();
    expect(messages.readThread("bob", hidden.id).isErr()).toBe(true);
    expect(search.query("bob", { query: "needle" }).unwrap().items).toEqual([]);
  });
  test("agent data principal remains starter when owner edits", () => {
    const origin = thread("alice", "origin", "hello");
    thread("owner", "private", "ownerneedle");
    const context = {
      serverOwnedRequest: true,
      requestInitiator: { platform: "native" as const, userId: "owner" },
      requestInitiatorSessionId: origin.id,
    };
    const result = nativeSearchTool(search, context, (service, userId) =>
      service.query(userId, { query: "ownerneedle" }),
    ).unwrap();
    expect(result.items).toEqual([]);
    expect(
      nativeSearchTool(search, { ...context, serverOwnedRequest: false }, (service, userId) =>
        service.query(userId, { query: "hello" }),
      ).isErr(),
    ).toBe(true);
  });
  test("search uses current turn projection and excludes removed turns", () => {
    const origin = thread("alice", "origin", "needle");
    expect(messages.readThread("alice", origin.id).unwrap().total).toBe(1);
    db.query("DELETE FROM native_records WHERE kind='turn' AND thread_id=?").run(origin.id);
    expect(search.query("alice", { query: "needle" }).unwrap().items).toEqual([]);
  });
  test("native discovery surrounds only visible matches and validates time windows", () => {
    thread("owner", "secret", "needle private");
    const origin = thread("alice", "origin", "needle visible");
    const result = search.discovery("alice", { query: "needle", surrounding: 2 }).unwrap();
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]!.origin).toEqual({
      kind: "session",
      platform: "native",
      sessionId: origin.id,
      label: "origin",
    });
    expect(result.groups[0]!.entries.flat()[0]!.text).toBe("needle visible");
    expect(search.discovery("alice", { query: "needle", offsetTime: "1d" }).isErr()).toBe(true);
  });
  test("participant discovery never consults global files or external threads", async () => {
    thread("alice", "origin", "needle");
    const result = await search.discoveryWithExternal(
      "alice",
      { query: "needle" },
      {
        searchResult: () => {
          throw new Error("Unauthorized global source");
        },
      },
    );
    expect(result.unwrap().groups).toHaveLength(1);
  });
  test("native tool context never falls back to global discovery", async () => {
    const tool = new Discovery({
      discovery: {
        searchResult: () => {
          throw new Error("Global search must not run");
        },
      } as unknown as DiscoveryService,
    });
    const result = await tool.call(
      "discovery.search",
      { query: "needle" },
      { context: { requestInitiator: { platform: "native", userId: "alice" } } },
    );
    expect(result.isErr()).toBe(true);
  });
  test("indexed native search handles title/text terms, short terms, substrings, and live mutations", () => {
    const first = thread("alice", "Billing Ops", "First invoice approved");
    for (let i = 1; i <= 4; i++) {
      store
        .appendMessage(
          first.id,
          0,
          first.turnId,
          {
            id: `msg_billing_${i}`,
            role: "assistant",
            metadata: { createdAt: 1000 + i },
            parts: [{ type: "text", text: `Followup note ${i} with deploy_marker_${i}` }],
          },
          `evt_billing_${i}`,
        )
        .unwrap();
    }
    thread("alice", "Other Thread", "go check db");

    // Multi-term across title + text
    const titleAndText = messages
      .searchMessages("alice", { query: "billing invoice", limit: 10 })
      .unwrap();
    expect(titleAndText.map((row) => row.text)).toEqual(["First invoice approved"]);

    // Title-only match returns messages in that thread
    const titleOnly = messages.searchMessages("alice", { query: "billing", limit: 10 }).unwrap();
    expect(titleOnly).toHaveLength(5);

    // Mid-word substring match (trigram)
    const substring = messages.searchMessages("alice", { query: "ploy_mark", limit: 10 }).unwrap();
    expect(substring).toHaveLength(4);

    // Short (< 3 char) terms fallback
    const shortTerms = messages.searchMessages("alice", { query: "go db", limit: 10 }).unwrap();
    expect(shortTerms.map((row) => row.text)).toEqual(["go check db"]);

    // Paginated readThread preserves exact ordinals and bounds
    const page = messages.readThread("alice", first.id, { offset: 2, limit: 2 }).unwrap();
    expect(page.total).toBe(5);
    expect(page.messages.map((row) => row.ordinal)).toEqual([2, 3]);
    expect(page.startMessageId).toBe(titleOnly.at(-1)?.messageId ?? null);
    expect(page.endMessageId).toBe(titleOnly[0]?.messageId ?? null);

    // Discovery surrounding context uses exact ordinals and preserves start-of-thread window size
    const disc = search.discovery("alice", { query: "deploy_marker_2", surrounding: 1 }).unwrap();
    expect(disc.groups).toHaveLength(1);
    expect(disc.groups[0]!.entries[0]!.map((entry) => entry.text)).toEqual([
      "Followup note 1 with deploy_marker_1",
      "Followup note 2 with deploy_marker_2",
      "Followup note 3 with deploy_marker_3",
    ]);

    const startOfThread = search
      .discovery("alice", { query: "First invoice approved", surrounding: 2 })
      .unwrap();
    expect(startOfThread.groups[0]!.entries[0]!.map((entry) => entry.text)).toEqual([
      "First invoice approved",
      "Followup note 1 with deploy_marker_1",
      "Followup note 2 with deploy_marker_2",
      "Followup note 3 with deploy_marker_3",
      "Followup note 4 with deploy_marker_4",
    ]);

    // Live title rename and subsequent turn update reflect immediately after index warm-up
    store
      .updateThread("alice", {
        threadId: first.id,
        commandId: "rename_billing",
        title: "Treasury Ops",
      })
      .unwrap();
    expect(messages.searchMessages("alice", { query: "billing", limit: 10 }).unwrap()).toEqual([]);
    expect(
      messages.searchMessages("alice", { query: "treasury", limit: 10 }).unwrap(),
    ).toHaveLength(5);
  });

  test("preserves SQLite title case folding, rollback recovery, and malformed-thread isolation", () => {
    const unicodeThread = thread("alice", "AΣ漢字", "unrelated message body");
    const unicodeHits = messages.searchMessages("alice", { query: "Σ漢字", limit: 10 }).unwrap();
    expect(unicodeHits.map((row) => row.threadId)).toEqual([unicodeThread.id]);

    // Rollback on a corrupt cold search must not leave temp index state broken
    const freshDb = new Database(":memory:");
    try {
      const freshStore = new NativeStore(freshDb, () => 1000);
      freshStore.initialize().unwrap();
      freshStore
        .upsertUser({
          id: "alice",
          providerId: "alice",
          displayName: "alice",
          role: "participant",
          toolMode: "full",
        })
        .unwrap();
      const freshSearch = new NativeSearchStore({ db: freshDb, store: freshStore });
      const badThread = freshStore
        .createThread("alice", { commandId: "c_bad", title: "Bad" })
        .unwrap();
      const goodThread = freshStore
        .createThread("alice", { commandId: "c_good", title: "Good" })
        .unwrap();
      freshStore
        .acceptInput("alice", {
          threadId: goodThread.id,
          commandId: "in_good",
          text: "healthy searchable message",
          historyGeneration: 0,
          mode: "prompt",
          attachmentIds: [],
          skillIds: [],
        })
        .unwrap();
      freshDb.query("INSERT INTO native_records VALUES ('turn', 'bad_turn', ?, 0, 1000, 1, ?)").run(
        badThread.id,
        JSON.stringify({
          version: 1,
          value: {
            turnId: "bad_turn",
            messages: [
              {
                id: "m_bad",
                role: "user",
                metadata: { authorId: "alice", createdAt: -1 },
                parts: [{ type: "text", text: "corrupt_ts_needle" }],
              },
            ],
          },
        }),
      );

      expect(
        freshSearch.searchMessages("alice", { query: "corrupt_ts_needle", limit: 10 }).isErr(),
      ).toBe(true);
      expect(
        freshSearch.searchMessages("alice", { query: "healthy", limit: 10 }).unwrap(),
      ).toHaveLength(1);
    } finally {
      freshDb.close();
    }

    // Malformed JSON and non-object nested messages/parts in Bob's inaccessible turns must not break Alice
    const bobThread = thread("bob", "Bob Secret", "bob ok");
    db.query(
      "UPDATE native_records SET data_json = '{malformed' WHERE kind = 'turn' AND thread_id = ?",
    ).run(bobThread.id);
    db.query("INSERT INTO native_records VALUES ('turn', 'bob_bad_msg', ?, 1, 1000, 1, ?)").run(
      bobThread.id,
      JSON.stringify({ version: 1, value: { turnId: "bob_bad_msg", messages: ["oops"] } }),
    );
    db.query("INSERT INTO native_records VALUES ('turn', 'bob_bad_part', ?, 2, 1000, 1, ?)").run(
      bobThread.id,
      JSON.stringify({
        version: 1,
        value: { turnId: "bob_bad_part", messages: [{ id: "m_bad_part", parts: ["oops"] }] },
      }),
    );
    // Also exercise cold rebuild against nested malformed turns and orphan turns (null thread_id)
    db.query("INSERT INTO native_records VALUES ('turn', 'orphan_turn', NULL, 0, 1000, 1, ?)").run(
      JSON.stringify({
        version: 1,
        value: {
          turnId: "orphan_turn",
          messages: [{ id: "m_orphan", role: "user", parts: [{ type: "text", text: "orphan" }] }],
        },
      }),
    );
    const coldSearch = new NativeSearchStore({ db, store });
    db.run("DROP TABLE IF EXISTS temp.native_search_meta");
    expect(coldSearch.readThread("alice", unicodeThread.id).unwrap().messages).toHaveLength(1);
    expect(
      coldSearch.searchMessages("alice", { query: "unrelated", limit: 10 }).unwrap(),
    ).toHaveLength(1);
    // Warm trigger must also ignore orphan turns with null thread_id
    db.query(
      "INSERT INTO native_records VALUES ('turn', 'orphan_turn_2', NULL, 1, 1000, 1, ?)",
    ).run(
      JSON.stringify({
        version: 1,
        value: {
          turnId: "orphan_turn_2",
          messages: [{ id: "m_orphan2", role: "user", parts: [{ type: "text", text: "orphan2" }] }],
        },
      }),
    );

    // Column affinity must independently preserve numeric starterId, string deleted, and string createdAt
    store
      .upsertUser({
        id: "123",
        providerId: "123",
        displayName: "numeric-user",
        role: "participant",
        toolMode: "full",
      })
      .unwrap();
    db.query(
      "INSERT INTO native_records VALUES ('thread', 't_num_starter', 't_num_starter', 0, 1000, 1, ?)",
    ).run(
      JSON.stringify({
        version: 1,
        value: {
          id: "t_num_starter",
          title: "Numeric Starter",
          deleted: false,
          starterId: 123,
          createdAt: 1000,
        },
      }),
    );
    db.query(
      "INSERT INTO native_records VALUES ('turn', 'turn_num_starter', 't_num_starter', 0, 1000, 1, ?)",
    ).run(
      JSON.stringify({
        version: 1,
        value: {
          turnId: "turn_num_starter",
          messages: [
            {
              id: "m_num_starter",
              role: "user",
              metadata: { authorId: "123", createdAt: 1000 },
              parts: [{ type: "text", text: "affinity_numeric_starter_needle" }],
            },
          ],
        },
      }),
    );
    expect(
      coldSearch
        .searchMessages("123", { query: "affinity_numeric_starter_needle", limit: 10 })
        .unwrap(),
    ).toEqual([]);

    db.query(
      "INSERT INTO native_records VALUES ('thread', 't_str_deleted', 't_str_deleted', 0, 1000, 1, ?)",
    ).run(
      JSON.stringify({
        version: 1,
        value: {
          id: "t_str_deleted",
          title: "String Deleted",
          deleted: "0",
          starterId: "123",
          createdAt: 1000,
        },
      }),
    );
    db.query(
      "INSERT INTO native_records VALUES ('turn', 'turn_str_deleted', 't_str_deleted', 0, 1000, 1, ?)",
    ).run(
      JSON.stringify({
        version: 1,
        value: {
          turnId: "turn_str_deleted",
          messages: [
            {
              id: "m_str_deleted",
              role: "user",
              metadata: { authorId: "123", createdAt: 1000 },
              parts: [{ type: "text", text: "affinity_string_deleted_needle" }],
            },
          ],
        },
      }),
    );
    expect(
      coldSearch
        .searchMessages("123", { query: "affinity_string_deleted_needle", limit: 10 })
        .unwrap(),
    ).toEqual([]);

    const strTsThread = thread("alice", "String Ts", "seed");
    db.query("INSERT INTO native_records VALUES ('turn', 'turn_str_ts', ?, 1, 1001, 1, ?)").run(
      strTsThread.id,
      JSON.stringify({
        version: 1,
        value: {
          turnId: "turn_str_ts",
          messages: [
            {
              id: "m_str_ts",
              role: "user",
              metadata: { authorId: "alice", createdAt: "1001" },
              parts: [{ type: "text", text: "string_ts_needle" }],
            },
          ],
        },
      }),
    );
    expect(
      coldSearch.searchMessages("alice", { query: "string_ts_needle", limit: 10 }).isErr(),
    ).toBe(true);
  });
});
