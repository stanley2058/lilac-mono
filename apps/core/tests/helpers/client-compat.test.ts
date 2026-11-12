import { beforeAll, expect, test } from "bun:test";
import { assertCompatible, loadCompatValidators } from "./client-compat";

let validators: Awaited<ReturnType<typeof loadCompatValidators>>;
beforeAll(async () => {
  validators = await loadCompatValidators();
}, 30_000);

test("previous-release snapshots exist and compile as JSON Schema", () => {
  expect(validators.size).toBeGreaterThan(100);
});

test("strictly decoded payloads reject additions; other replies only reject removals", () => {
  const checkpoint = {
    protocolVersion: 1,
    historyGeneration: 0,
    projectionRevision: 0,
    cursor: "compat",
  };
  expect(() => assertCompatible(validators, "replayCheckpointSchema", checkpoint)).not.toThrow();
  // Unvalidated RPC results may gain fields that old clients ignore.
  expect(() =>
    assertCompatible(validators, "replayCheckpointSchema", { ...checkpoint, added: true }),
  ).not.toThrow();
  expect(() =>
    assertCompatible(validators, "replayCheckpointSchema", { protocolVersion: 2 }),
  ).toThrow("/protocolVersion");
  const { cursor: _cursor, ...withoutCursor } = checkpoint;
  expect(() => assertCompatible(validators, "replayCheckpointSchema", withoutCursor)).toThrow(
    "backward compatible",
  );
  // Cache rows are parsed with the released strict schema, so additions break them.
  const row = { checkpoint, slots: [] };
  expect(() => assertCompatible(validators, "cacheRow", row)).not.toThrow();
  expect(() => assertCompatible(validators, "cacheRow", { ...row, added: true })).toThrow(
    "backward compatible",
  );
});
