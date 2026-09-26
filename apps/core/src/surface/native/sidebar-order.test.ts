import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { NativeStore } from "./store";
import type { SidebarSection } from "@stanley2058/lilac-client-protocol";

function fixture() {
  let now = 1_000_000;
  const db = new Database(":memory:");
  const store = new NativeStore(db, () => now);
  store.initialize().unwrap();
  for (const id of ["owner", "alice", "bob"] as const)
    store
      .upsertUser({
        id,
        providerId: id,
        displayName: id,
        role: id === "owner" ? "owner" : "participant",
        toolMode: "full",
      })
      .unwrap();
  const create = (id: string, user = "alice") => {
    now++;
    return store.createThread(user, { commandId: id, title: id }).unwrap().id;
  };
  const list = (section: SidebarSection, user = "alice") =>
    store
      .listSidebar(user, { section, limit: 100 })
      .unwrap()
      .items.map((t) => t.id);
  const move = (threadId: string, section: SidebarSection, beforeId?: string) =>
    store.moveSidebarThread("alice", { threadId, section, beforeId, atStart: !beforeId }).unwrap();
  const activity = (threadId: string) => {
    now++;
    store
      .acceptInput("alice", {
        threadId,
        commandId: String(now),
        historyGeneration: 0,
        text: "New activity",
        mode: "prompt",
        attachmentIds: [],
        skillIds: [],
      })
      .unwrap();
  };
  return {
    store,
    db,
    create,
    list,
    move,
    activity,
    advance: (days: number) => {
      now += days * 86_400_000;
    },
  };
}

describe("personal sidebar queues", () => {
  test("new and unsettled threads enqueue at the top; activity preserves manual order", () => {
    const f = fixture();
    const a = f.create("a"),
      b = f.create("b"),
      c = f.create("c");
    expect(f.list("active")).toEqual([c, b, a]);
    f.move(a, "active", c);
    expect(f.list("active")).toEqual([a, c, b]);
    f.activity(b);
    expect(f.list("active")).toEqual([a, c, b]);
    const d = f.create("d");
    expect(f.list("active")).toEqual([d, a, c, b]);
    f.move(c, "settled");
    expect(f.list("active")).toEqual([d, a, b]);
    f.move(c, "active");
    expect(f.list("active")).toEqual([c, d, a, b]);
    f.store.close();
  });
  test("auto settles at the configured threshold, exempts pinned and working threads, and reactivates on activity", () => {
    const f = fixture();
    const a = f.create("a"),
      b = f.create("b"),
      c = f.create("c");
    f.move(b, "pinned");
    f.store.setActiveRun(c, 0, "run").unwrap();
    f.advance(2);
    expect(f.list("settled")).toEqual([]);
    f.advance(1);
    expect(f.list("settled")).toEqual([a]);
    expect(f.list("pinned")).toEqual([b]);
    expect(f.list("active")).toEqual([c]);
    f.activity(a);
    expect(f.list("active")).toEqual([a, c]);
    f.store.configureSidebar("alice", { autoSettleDays: 1 }).unwrap();
    f.advance(1);
    expect(f.list("settled")).toEqual([a]);
    f.move(a, "active");
    expect(f.list("active")).toEqual([a, c]);
    f.store.close();
  });
  test("reordering within a section does not delay auto settling", () => {
    const f = fixture();
    const a = f.create("a"),
      b = f.create("b");
    f.advance(2);
    f.move(a, "active", b);
    expect(f.list("active")).toEqual([a, b]);
    f.advance(1);
    expect(f.list("active")).toEqual([]);
    expect(new Set(f.list("settled"))).toEqual(new Set([a, b]));
    f.store.close();
  });
  test("rename does not reactivate; settle is personal and does not archive", () => {
    const f = fixture();
    const a = f.create("a");
    f.move(a, "settled");
    f.advance(1);
    f.store
      .updateThread("alice", {
        threadId: a,
        commandId: "rename",
        revision: f.store.getThread("alice", a).unwrap().revision,
        title: "renamed",
      })
      .unwrap();
    expect(f.list("settled")).toEqual([a]);
    expect(f.list("active", "owner")).toEqual([a]);
    expect(f.store.getThread("alice", a).unwrap().archived).toBe(false);
    expect(f.store.moveSidebarThread("bob", { threadId: a, section: "pinned" }).isErr()).toBe(true);
    expect(f.list("settled", "bob")).toEqual([]);
    f.store.close();
  });
  test("preferences and ordering survive reopening; pages honor order and exclude archived threads", () => {
    const f = fixture();
    const a = f.create("a"),
      b = f.create("b"),
      c = f.create("c");
    f.move(a, "active", c);
    f.store.configureSidebar("alice", { autoSettleDays: 7 }).unwrap();
    const reopened = new NativeStore(f.db);
    reopened.initialize().unwrap();
    expect(reopened.getSidebarPreferences("alice").unwrap().autoSettleDays).toBe(7);
    // Use the fixture clock for pagination so these synthetic old threads remain active.
    const first = f.store.listSidebar("alice", { section: "active", limit: 2 }).unwrap();
    expect(first.items.map((t) => t.id)).toEqual([a, c]);
    expect(first.total).toBe(3);
    expect(
      f.store
        .listSidebar("alice", { section: "active", limit: 2, cursor: first.nextCursor })
        .unwrap()
        .items.map((t) => t.id),
    ).toEqual([b]);
    f.store
      .updateThread("alice", {
        threadId: a,
        commandId: "archive",
        revision: f.store.getThread("alice", a).unwrap().revision,
        archived: true,
      })
      .unwrap();
    expect(f.list("active")).toEqual([c, b]);
    expect(
      f.store.listSidebar("alice", { section: "active", limit: 2, cursor: "bad" }).isErr(),
    ).toBe(true);
    f.store.close();
  });
});

test("equal ranks preserve the exact neighbor when reordering", () => {
  const f = fixture();
  f.create("a");
  f.create("b");
  f.create("c");
  f.list("active");
  f.db.query("UPDATE native_thread_preferences SET position=0 WHERE user_id='alice'").run();
  const initial = f.list("active");
  const last = initial[2]!;
  f.move(last, "active", initial[1]);
  expect(f.list("active")).toEqual([initial[0]!, last, initial[1]!]);
  f.store
    .moveSidebarThread("alice", { threadId: last, section: "active", afterId: initial[1] })
    .unwrap();
  expect(f.list("active")).toEqual(initial);
  f.store.close();
});

test("old unobserved activity does not extend the inactivity deadline", () => {
  const f = fixture();
  const a = f.create("a");
  f.move(a, "settled");
  f.activity(a);
  f.advance(5);
  expect(f.list("active")).toEqual([]);
  expect(f.list("settled")).toEqual([a]);
  f.store.close();
});

test("count-only pages reconcile settlement without projecting thread records", () => {
  const f = fixture();
  const manual = f.create("manual");
  const automatic = f.create("automatic");
  const pinned = f.create("pinned");
  f.move(manual, "settled");
  f.move(pinned, "pinned");
  f.advance(3);
  expect(f.store.listSidebar("alice", { section: "settled", limit: 0 }).unwrap()).toEqual({
    items: [],
    total: 2,
  });
  expect(
    f.store
      .listThreads("alice", { excludeSettled: true })
      .unwrap()
      .map((t) => t.id),
  ).toEqual([pinned]);
  expect(new Set(f.list("settled"))).toEqual(new Set([automatic, manual]));
  f.activity(manual);
  expect(f.store.listSidebar("alice", { section: "settled", limit: 0 }).unwrap().total).toBe(1);
  expect(f.store.listSidebar("bob", { section: "settled", limit: 0 }).unwrap().total).toBe(0);
  f.store.close();
});

test("catalog settlement checks reconcile only the changed thread and reactivate on activity", () => {
  const f = fixture();
  const changed = f.create("changed");
  const untouched = f.create("untouched");
  f.list("active");
  f.advance(3);
  expect(f.store.isSidebarThreadSettled("alice", changed).unwrap()).toBe(true);
  expect(
    f.db
      .query<{ section: string }, [string]>(
        "SELECT section FROM native_thread_preferences WHERE user_id='alice' AND thread_id=?",
      )
      .get(untouched)?.section,
  ).toBe("active");
  f.activity(changed);
  expect(f.store.isSidebarThreadSettled("alice", changed).unwrap()).toBe(false);
  f.store.close();
});
