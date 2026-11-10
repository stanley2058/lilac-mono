import { describe, expect, it } from "bun:test";

import { Panic } from "better-result";

import {
  createThreadMaterializer,
  ThreadMaterializerOperationFailed,
  type ThreadMaterializerScheduler,
} from "../../src/conversation/thread-materializer";
import type { ConversationThreadRepairKind } from "../../src/conversation/thread-store";

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function manualScheduler(): {
  schedule: ThreadMaterializerScheduler;
  runNext(): void;
  readonly size: number;
} {
  let nextId = 0;
  const tasks = new Map<number, () => void>();
  return {
    schedule(task) {
      nextId += 1;
      const id = nextId;
      tasks.set(id, task);
      return () => tasks.delete(id);
    },
    runNext() {
      const next = tasks.entries().next();
      if (next.done) throw new Error("no scheduled materializer task");
      const [id, task] = next.value;
      tasks.delete(id);
      task();
    },
    get size() {
      return tasks.size;
    },
  };
}

describe("conversation thread materializer coalescer", () => {
  it("debounces and coalesces channels with topology superseding content", async () => {
    const scheduler = manualScheduler();
    const repairs: Array<
      | { channelId: string; kind: "topology" }
      | { channelId: string; kind: "content"; messageIds: readonly string[] }
    > = [];
    const materializer = createThreadMaterializer({
      schedule: scheduler.schedule,
      listChannelIds: async () => [],
      async repairChannel(input) {
        repairs.push(input);
      },
    });

    materializer.markDirty({ channelId: "a", kind: "content", messageId: "m1" });
    materializer.markDirty({ channelId: "a", kind: "topology" });
    materializer.markDirty({ channelId: "a", kind: "content", messageId: "m2" });
    materializer.markDirty({ channelId: "b", kind: "content", messageId: "m3" });

    expect(repairs).toEqual([]);
    expect(scheduler.size).toBe(1);
    scheduler.runNext();
    await materializer.flush();
    expect(repairs).toEqual([
      { channelId: "a", kind: "topology" },
      { channelId: "b", kind: "content", messageIds: ["m3"] },
    ]);
  });

  it("runs only one repair at a time", async () => {
    const firstStarted = deferred();
    const secondStarted = deferred();
    const releaseFirst = deferred();
    const releaseSecond = deferred();
    let active = 0;
    let maxActive = 0;
    const materializer = createThreadMaterializer({
      schedule: manualScheduler().schedule,
      listChannelIds: async () => [],
      async repairChannel({ channelId }) {
        active += 1;
        maxActive = Math.max(maxActive, active);
        if (channelId === "a") {
          firstStarted.resolve();
          await releaseFirst.promise;
        } else {
          secondStarted.resolve();
          await releaseSecond.promise;
        }
        active -= 1;
      },
    });

    materializer.markDirty({ channelId: "a", kind: "content", messageId: "m1" });
    materializer.markDirty({ channelId: "b", kind: "content", messageId: "m2" });
    const flushed = materializer.flush();
    await firstStarted.promise;
    expect(active).toBe(1);

    releaseFirst.resolve();
    await secondStarted.promise;
    expect(active).toBe(1);
    expect(maxActive).toBe(1);

    releaseSecond.resolve();
    await flushed;
  });

  it("requeues a newer generation dirtied while its channel is in flight", async () => {
    const firstStarted = deferred();
    const secondStarted = deferred();
    const releaseFirst = deferred();
    const repairs: ConversationThreadRepairKind[] = [];
    const materializer = createThreadMaterializer({
      schedule: manualScheduler().schedule,
      listChannelIds: async () => [],
      async repairChannel({ kind }) {
        repairs.push(kind);
        if (repairs.length === 1) {
          firstStarted.resolve();
          await releaseFirst.promise;
        } else {
          secondStarted.resolve();
        }
      },
    });

    materializer.markDirty({ channelId: "a", kind: "topology" });
    const flushed = materializer.flush();
    await firstStarted.promise;

    materializer.markDirty({ channelId: "a", kind: "content", messageId: "m1" });
    materializer.markDirty({ channelId: "a", kind: "topology" });
    materializer.markDirty({ channelId: "a", kind: "content", messageId: "m2" });
    expect(repairs).toEqual(["topology"]);

    releaseFirst.resolve();
    await secondStarted.promise;
    await flushed;
    expect(repairs).toEqual(["topology", "topology"]);
  });

  it("moves a hot channel behind channels already waiting", async () => {
    const firstStarted = deferred();
    const releaseFirst = deferred();
    const repairs: string[] = [];
    const materializer = createThreadMaterializer({
      schedule: manualScheduler().schedule,
      listChannelIds: async () => [],
      async repairChannel({ channelId }) {
        repairs.push(channelId);
        if (repairs.length === 1) {
          firstStarted.resolve();
          await releaseFirst.promise;
        }
      },
    });

    materializer.markDirty({ channelId: "hot", kind: "topology" });
    materializer.markDirty({ channelId: "waiting", kind: "topology" });
    const flushed = materializer.flush();
    await firstStarted.promise;
    materializer.markDirty({ channelId: "hot", kind: "topology" });
    releaseFirst.resolve();
    await flushed;

    expect(repairs).toEqual(["hot", "waiting", "hot"]);
  });

  it("lists channels asynchronously and marks all of them topology-dirty", async () => {
    const listed = deferred<readonly string[]>();
    const repairs: Array<{ channelId: string; kind: ConversationThreadRepairKind }> = [];
    const materializer = createThreadMaterializer({
      schedule: manualScheduler().schedule,
      listChannelIds: () => listed.promise,
      async repairChannel(input) {
        repairs.push(input);
      },
    });

    materializer.markAllDirty();
    expect(repairs).toEqual([]);
    const flushed = materializer.flush();
    listed.resolve(["a", "b"]);
    await flushed;

    expect(repairs).toEqual([
      { channelId: "a", kind: "topology" },
      { channelId: "b", kind: "topology" },
    ]);
  });

  it("continues draining after a repair error", async () => {
    const failures: unknown[] = [];
    const repairs: string[] = [];
    const failure = new ThreadMaterializerOperationFailed({
      operation: "repair-channel",
      message: "failed a",
    });
    const materializer = createThreadMaterializer({
      schedule: manualScheduler().schedule,
      listChannelIds: async () => [],
      async repairChannel({ channelId }) {
        repairs.push(channelId);
        if (channelId === "a") throw failure;
      },
      onError(error) {
        failures.push(error);
      },
    });

    materializer.markDirty({ channelId: "a", kind: "content", messageId: "m1" });
    materializer.markDirty({ channelId: "b", kind: "content", messageId: "m2" });
    await materializer.flush();

    expect(repairs).toEqual(["a", "b"]);
    expect(failures).toEqual([failure]);
  });

  it("preserves onError Panic identity", async () => {
    const callbackPanic = new Panic({ message: "materializer error observer failed" });
    const materializer = createThreadMaterializer({
      schedule: manualScheduler().schedule,
      listChannelIds: async () => [],
      async repairChannel() {
        throw new ThreadMaterializerOperationFailed({
          operation: "repair-channel",
          message: "repair failed",
        });
      },
      onError() {
        throw callbackPanic;
      },
    });

    materializer.markDirty({ channelId: "a", kind: "topology" });
    await expect(materializer.flush()).rejects.toBe(callbackPanic);
  });

  it("preserves scheduler Panic identity after listing channels", async () => {
    const schedulerPanic = new Panic({ message: "materializer scheduler failed" });
    const materializer = createThreadMaterializer({
      schedule() {
        throw schedulerPanic;
      },
      listChannelIds: async () => ["a"],
      async repairChannel() {},
    });

    materializer.markAllDirty();
    await expect(materializer.flush()).rejects.toBe(schedulerPanic);
  });

  it("preserves repair Panic identity", async () => {
    const panic = new Panic({ message: "repair invariant failed" });
    const materializer = createThreadMaterializer({
      schedule: manualScheduler().schedule,
      listChannelIds: async () => [],
      async repairChannel() {
        throw panic;
      },
    });

    materializer.markDirty({ channelId: "a", kind: "topology" });
    await expect(materializer.flush()).rejects.toBe(panic);
  });

  it("propagates an unowned repair defect with exact identity", async () => {
    const defect = new Error("repair callback defect");
    const materializer = createThreadMaterializer({
      schedule: manualScheduler().schedule,
      listChannelIds: async () => [],
      async repairChannel() {
        throw defect;
      },
    });

    materializer.markDirty({ channelId: "a", kind: "topology" });
    await expect(materializer.flush()).rejects.toBe(defect);
  });

  it("preserves channel listing Panic identity", async () => {
    const panic = new Panic({ message: "channel listing invariant failed" });
    const materializer = createThreadMaterializer({
      schedule: manualScheduler().schedule,
      listChannelIds: async () => {
        throw panic;
      },
      async repairChannel() {},
    });

    materializer.markAllDirty();
    await expect(materializer.flush()).rejects.toBe(panic);
  });
});

it("retries materialization failures with increasing backoff and cancels retries on stop", async () => {
  const tasks = new Map<number, { task: () => void; delay: number }>();
  let id = 0;
  let calls = 0;
  const materializer = createThreadMaterializer({
    schedule(task, delay) {
      const key = ++id;
      tasks.set(key, { task, delay });
      return () => {
        tasks.delete(key);
      };
    },
    listChannelIds: async () => [],
    async repairChannel() {
      calls++;
      throw new ThreadMaterializerOperationFailed({
        operation: "repair-channel",
        message: "offline",
      });
    },
  });
  materializer.markDirty({ channelId: "a", kind: "topology" });
  await materializer.flush();
  expect(calls).toBe(1);
  const retry = [...tasks.values()][0]!;
  expect(retry.delay).toBe(1000);
  tasks.clear();
  retry.task();
  await materializer.flush();
  expect(calls).toBe(2);
  expect([...tasks.values()][0]?.delay).toBe(2000);
  await materializer.stop();
  expect(tasks.size).toBe(0);
});
