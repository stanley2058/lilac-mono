import { describe, expect, it } from "bun:test";

import { createSerialJobQueue } from "../../src/conversation/thread-job-queue";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (predicate()) return;
    await Bun.sleep(1);
  }
  throw new Error("condition not met");
}

describe("conversation thread serial job queue", () => {
  it("runs queued jobs one at a time in FIFO order", async () => {
    const releases = new Map<number, ReturnType<typeof deferred>>();
    const events: string[] = [];
    let active = 0;
    let maxActive = 0;

    const queue = createSerialJobQueue<number>({
      async run(job) {
        active += 1;
        maxActive = Math.max(maxActive, active);
        events.push(`start:${job}`);
        const release = deferred();
        releases.set(job, release);
        await release.promise;
        events.push(`end:${job}`);
        active -= 1;
      },
    });

    queue.enqueue(1);
    queue.enqueue(2);
    queue.enqueue(3);

    await waitFor(() => events.includes("start:1"));
    expect(events).toEqual(["start:1"]);
    expect(queue.running).toBe(true);

    releases.get(1)?.resolve();
    await waitFor(() => events.includes("start:2"));
    expect(events).toEqual(["start:1", "end:1", "start:2"]);

    releases.get(2)?.resolve();
    await waitFor(() => events.includes("start:3"));
    expect(events).toEqual(["start:1", "end:1", "start:2", "end:2", "start:3"]);

    releases.get(3)?.resolve();
    await waitFor(() => queue.running === false);
    expect(events).toEqual(["start:1", "end:1", "start:2", "end:2", "start:3", "end:3"]);
    expect(maxActive).toBe(1);
  });
});
