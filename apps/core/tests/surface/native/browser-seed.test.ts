import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { DEFAULT_DM_CONTEXT_GAP_MS, replayReplySchema } from "@stanley2058/lilac-client-protocol";
import { SqliteTranscriptStore } from "../../../src/transcript/transcript-store";
import { NativeStore } from "../../../src/surface/native/store";
import { seedNativeBrowserFixture } from "./browser-seed";

describe("native browser fixture seeding", () => {
  test("creates completed full turns, bounded replay, rich content, and an uploading input", () => {
    using db = new Database(":memory:");
    const store = new NativeStore(db);
    store.initialize().unwrap();
    store
      .upsertUser({
        id: "owner",
        providerId: "owner",
        displayName: "Owner",
        role: "owner",
        toolMode: "full",
      })
      .unwrap();
    const transcript = new SqliteTranscriptStore(":memory:");
    const threads = seedNativeBrowserFixture(store, {
      historyTurns: 12,
      sidebarThreads: 2,
      transcript,
      database: db,
    });
    const canonicalId = store.getLatestCanonicalRequestId(threads.history).unwrap();
    expect(canonicalId).toBeDefined();
    expect(
      transcript.getRequestTranscript({ requestId: canonicalId! }).unwrap()?.messages,
    ).toHaveLength(24);
    const history = store.sync("owner", threads.history).unwrap();
    expect(replayReplySchema.safeParse(history).success).toBe(true);
    expect(history.kind).toBe("window");
    if (history.kind !== "window") throw new Error("Expected a fixture window");
    expect(history.slots[0]?.kind).toBe("deferred");
    expect(history.slots.at(-1)?.kind).toBe("ready");
    expect(JSON.stringify(history)).toContain("Checkpoint **12**");
    const rich = store.sync("owner", threads.rich).unwrap();
    expect(replayReplySchema.safeParse(rich).success).toBe(true);
    expect(JSON.stringify(rich)).toContain("mermaid");
    expect(JSON.stringify(rich)).toContain("typescript");
    const large = store.sync("owner", threads.largeTurn).unwrap();
    expect(replayReplySchema.safeParse(large).success).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(large)).byteLength).toBeLessThan(262_144);
    const pending = store.listPendingInputs().unwrap();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.threadId).toBe(threads.uploads);
    expect(pending[0]?.state).toBe("uploading");
    expect(store.getThread("participant", threads.rich).unwrap().capabilities).toEqual({
      read: true,
      edit: false,
      share: false,
    });
    transcript.close();
  });

  test("seeds an idle DM whose latest session is past the default context gap", () => {
    using db = new Database(":memory:");
    const store = new NativeStore(db);
    store.initialize().unwrap();
    store
      .upsertUser({
        id: "owner",
        providerId: "owner",
        displayName: "Owner",
        role: "owner",
        toolMode: "full",
      })
      .unwrap();
    const threads = seedNativeBrowserFixture(store, {
      historyTurns: 1,
      sidebarThreads: 0,
      longTurns: 4,
      dmWindows: 6,
      database: db,
    });
    expect(store.ensureDirectThread("owner").unwrap().id).toBe(threads.dm);
    const now = Date.now();
    const options = { gapMs: DEFAULT_DM_CONTEXT_GAP_MS, at: now };
    expect(store.selectSessionWindow(threads.dm, options).unwrap().firstPosition).toBeNull();
    const outline = store
      .outline("owner", threads.dm, { dmContextGapMs: DEFAULT_DM_CONTEXT_GAP_MS })
      .unwrap();
    // Six generated windows, then the Kyoto and release-checklist sessions.
    expect(outline.windows).toHaveLength(8);
    const latest = store.selectSessionWindow(threads.dm, {
      ...options,
      at: now - 3 * 3_600_000 + 60_000,
    });
    expect(latest.unwrap().firstPosition).toBe(outline.windows!.at(-1)!.firstPosition);
    expect(outline.windows!.at(-1)!.endPosition - outline.windows!.at(-1)!.firstPosition).toBe(2);
  });
});
