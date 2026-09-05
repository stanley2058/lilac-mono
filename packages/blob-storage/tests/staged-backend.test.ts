import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, expect, test } from "bun:test";
import type { Result } from "better-result";

import {
  reservationDecisionKey,
  reservationFenceKey,
  reservationKey,
  reservationTransitionKey,
  type BlobBackend,
} from "../src/backend";
import { LocalBlobBackend } from "../src/local-backend";
import { MemoryBlobBackend } from "../src/memory-backend";

function success<T, E>(result: Result<T, E>): T {
  return result.match({
    ok: (value) => value,
    err: (error) => {
      throw error;
    },
  });
}

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function backendPair(kind: "memory" | "local"): Promise<readonly [BlobBackend, BlobBackend]> {
  if (kind === "memory") {
    const backend = new MemoryBlobBackend();
    return [backend, backend];
  }
  const root = await mkdtemp(path.join(tmpdir(), "lilac-staged-backend-"));
  roots.push(root);
  const first = new LocalBlobBackend(root);
  const second = new LocalBlobBackend(root);
  success(await first.initialize({ createIfMissing: true }));
  success(await second.initialize({ createIfMissing: false }));
  return [first, second];
}

for (const kind of ["memory", "local"] as const) {
  test(`${kind} staged adoption and expiry have one shared decision winner`, async () => {
    const [first, second] = await backendPair(kind);
    const objectId = `b1_${"a".repeat(32)}`;
    const pending = '{"state":"pending"}\n';
    const staged = '{"state":"staged"}\n';
    const ready = '{"state":"ready"}\n';
    const deleted = '{"state":"deleted"}\n';
    success(await first.createReservation(objectId, pending));
    expect(success(await first.compareAndSwapReservation(objectId, pending, staged))).toBe(true);

    const decisions = await Promise.all([
      first.compareAndSwapReservation(objectId, staged, ready),
      second.compareAndSwapReservation(objectId, staged, deleted),
    ]);
    expect(decisions.map(success).filter(Boolean)).toHaveLength(1);
    const expected = success(decisions[0]!) ? ready : deleted;
    expect(success(await first.readReservation(objectId))).toBe(expected);
    expect(success(await second.readReservation(objectId))).toBe(expected);
    expect(success(await second.compareAndSwapReservation(objectId, staged, ready))).toBe(false);
    expect(success(await first.compareAndSwapReservation(objectId, staged, deleted))).toBe(false);
  });

  test(`${kind} adopted reservations can still be fenced by explicit deletion`, async () => {
    const [first, second] = await backendPair(kind);
    const objectId = `b1_${"b".repeat(32)}`;
    const pending = '{"state":"pending"}\n';
    const staged = '{"state":"staged"}\n';
    const ready = '{"state":"ready"}\n';
    const deleted = '{"state":"deleted"}\n';
    success(await first.createReservation(objectId, pending));
    expect(success(await first.compareAndSwapReservation(objectId, pending, staged))).toBe(true);
    expect(success(await first.compareAndSwapReservation(objectId, staged, ready))).toBe(true);
    expect(success(await second.compareAndSwapReservation(objectId, ready, deleted))).toBe(true);
    expect(success(await first.readReservation(objectId))).toBe(deleted);
    expect(success(await second.compareAndSwapReservation(objectId, staged, ready))).toBe(false);
  });
}

for (const kind of ["memory", "local"] as const) {
  test(`${kind} a delayed staged adopter cannot recreate a deleted reservation`, async () => {
    const [first, second] = await backendPair(kind);
    const objectId = `b1_${"c".repeat(32)}`;
    const pending = '{"state":"pending"}\n';
    const staged = '{"state":"staged"}\n';
    const ready = '{"state":"ready"}\n';
    const deleted = '{"state":"deleted"}\n';
    success(await first.createReservation(objectId, pending));
    expect(success(await first.compareAndSwapReservation(objectId, pending, staged))).toBe(true);
    const observed = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const readReservation = first.readReservation.bind(first);
    let pause = true;
    first.readReservation = async (id) => {
      const result = await readReservation(id);
      if (pause) {
        pause = false;
        observed.resolve();
        await resume.promise;
      }
      return result;
    };

    const adopting = first.compareAndSwapReservation(objectId, staged, ready);
    await observed.promise;
    expect(success(await second.compareAndSwapReservation(objectId, staged, deleted))).toBe(true);
    success(
      await second.deleteKeys([
        reservationKey(objectId),
        reservationFenceKey(objectId),
        reservationDecisionKey(objectId),
        reservationTransitionKey(objectId),
      ]),
    );
    resume.resolve();

    expect(success(await adopting)).toBe(false);
    expect(success(await second.readReservation(objectId))).toBeNull();
    expect(success(await second.deleteKeys([reservationDecisionKey(objectId)]))).toBe(0);
  });
}

for (const kind of ["memory", "local"] as const) {
  test(`${kind} expiry pages advance past retained entries and wrap for retries`, async () => {
    const [adapter] = await backendPair(kind);
    const first = `b1_${"a".repeat(32)}`;
    const second = `b1_${"b".repeat(32)}`;
    const third = `b1_${"c".repeat(32)}`;
    const future = `b1_${"d".repeat(32)}`;
    success(await adapter.createReservation(second, '{"state":"deleted"}\n', 1));
    success(await adapter.createReservation(third, '{"state":"deleted"}\n', 2));
    success(await adapter.createReservation(first, '{"state":"deleted"}\n', 1));
    success(await adapter.createReservation(future, '{"state":"pending"}\n', 10));

    expect(success(await adapter.listExpiredReservationIds(2, 1))).toEqual({
      ids: [first],
      remaining: true,
    });
    expect(success(await adapter.listExpiredReservationIds(2, 1))).toEqual({
      ids: [second],
      remaining: true,
    });
    expect(success(await adapter.listExpiredReservationIds(2, 1))).toEqual({
      ids: [third],
      remaining: false,
    });
    expect(success(await adapter.listExpiredReservationIds(2, 1))).toEqual({
      ids: [first],
      remaining: true,
    });
  });
}
