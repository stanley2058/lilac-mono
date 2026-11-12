import { beforeAll, expect, test } from "bun:test";
import { assertCompatible, loadCompatValidators } from "./client-compat";

let validators: Awaited<ReturnType<typeof loadCompatValidators>>;
beforeAll(async () => {
  validators = await loadCompatValidators();
}, 30_000);

test("previous-release snapshots exist and compile as JSON Schema", () => {
  expect(validators.size).toBeGreaterThan(100);
});

test("the compatibility gate rejects additional fields and reports paths and remediation", () => {
  const checkpoint = {
    protocolVersion: 1,
    historyGeneration: 0,
    projectionRevision: 0,
    cursor: "compat",
  };
  expect(() => assertCompatible(validators, "replayCheckpointSchema", checkpoint)).not.toThrow();
  expect(() =>
    assertCompatible(validators, "replayCheckpointSchema", { ...checkpoint, unexpected: true }),
  ).toThrow("backward compatible");
  expect(() =>
    assertCompatible(validators, "replayCheckpointSchema", { protocolVersion: 2 }),
  ).toThrow("/protocolVersion");
});
