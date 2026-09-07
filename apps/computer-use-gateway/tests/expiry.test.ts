import { expect, test } from "bun:test";
import { Panic, Result, type Result as ResultType } from "better-result";
import { createExpiryTick } from "../src/expiry";
import { storageFailure, type GatewayFailure } from "../src/contracts";

test("rejected expiry releases the guard, preserves the defect, and prevents overlap", async () => {
  const pending = Promise.withResolvers<ResultType<void, GatewayFailure>>();
  const reported: GatewayFailure[] = [];
  let calls = 0;
  const tick = createExpiryTick(
    () => {
      calls++;
      return calls === 1 ? pending.promise : Promise.resolve(Result.ok(undefined));
    },
    (error) => reported.push(error),
  );
  const first = tick();
  await tick();
  expect(calls).toBe(1);
  const defect = new Panic({ message: "Test cleanup defect" });
  const rejection = Promise.allSettled([first]);
  pending.reject(defect);
  const settled = (await rejection)[0]!;
  expect(settled.status).toBe("rejected");
  if (settled.status !== "rejected") throw new Error("Expected cleanup defect");
  expect(settled.reason).toBe(defect);
  expect(reported).toEqual([]);
  await tick();
  expect(calls).toBe(2);
});

test("expected expiry failures remain reportable and do not suppress later ticks", async () => {
  const error = storageFailure("io", "Test storage failure");
  const reported: GatewayFailure[] = [];
  let calls = 0;
  const tick = createExpiryTick(
    async () => {
      calls++;
      return calls === 1 ? Result.err(error) : Result.ok(undefined);
    },
    (error) => reported.push(error),
  );
  await tick();
  await tick();
  expect(calls).toBe(2);
  expect(reported).toEqual([error]);
});
