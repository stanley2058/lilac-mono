import { describe, expect, it, mock } from "bun:test";
import { Result } from "better-result";

import {
  adaptToolResultArtifactReadToAvailability,
  adaptToolResultArtifactReadToUnavailablePolicy,
  adaptToolResultArtifactStoreInitToHost,
  ToolResultArtifactInvalidInput,
  ToolResultArtifactReadCancelled,
  ToolResultArtifactReadTooLarge,
  ToolResultArtifactStorageFailure,
  ToolResultArtifactUnavailable,
  type ToolResultArtifactStore,
} from "../src/tool-result-artifact-store";

describe("tool result artifact adapters", () => {
  function storeWithMaintenance(
    maintain: ToolResultArtifactStore["maintain"],
  ): ToolResultArtifactStore {
    const unavailable = () =>
      Promise.resolve(
        Result.err(new ToolResultArtifactUnavailable({ reason: "absent", message: "Absent" })),
      );
    return {
      rootDir: "unused",
      init: async () => Result.ok(undefined),
      create: unavailable,
      createFromFile: unavailable,
      createFromStream: unavailable,
      read: unavailable,
      readWindow: unavailable,
      maintain,
    };
  }

  it("preserves successful reads and rejects invalid options", () => {
    expect(adaptToolResultArtifactReadToAvailability(Result.ok({ content: "hello" }))).toEqual({
      ok: true,
      content: "hello",
    });
    expect(() =>
      adaptToolResultArtifactReadToAvailability(
        Result.err(new ToolResultArtifactInvalidInput({ message: "Invalid limit" })),
      ),
    ).toThrow(RangeError);
  });

  it("maintains unavailable artifacts only when requested", async () => {
    const maintain = mock(async () => Result.ok({ removedInvalid: 0, removedExpired: 1 }));
    const store = storeWithMaintenance(maintain);
    const read = Result.err(
      new ToolResultArtifactUnavailable({ reason: "expired-or-evicted", message: "Unavailable" }),
    );

    expect(
      await adaptToolResultArtifactReadToUnavailablePolicy(store, read, { kind: "none" }),
    ).toEqual({ ok: false });
    expect(maintain).not.toHaveBeenCalled();
    expect(await adaptToolResultArtifactReadToUnavailablePolicy(store, read)).toEqual({
      ok: false,
    });
    expect(maintain).toHaveBeenCalledTimes(1);
  });

  it("preserves the selected maintenance failure disposition", async () => {
    const failure = new ToolResultArtifactStorageFailure({
      operation: "maintenance",
      code: "EIO",
      message: "Maintenance failed",
    });
    const store = storeWithMaintenance(async () => Result.err(failure));
    const read = Result.err(
      new ToolResultArtifactUnavailable({ reason: "absent", message: "Absent" }),
    );

    expect(await adaptToolResultArtifactReadToUnavailablePolicy(store, read)).toEqual({
      ok: false,
    });
    await expect(
      adaptToolResultArtifactReadToUnavailablePolicy(store, read, {
        kind: "maintain-after-unavailable",
        onMaintenanceError: "reject",
      }),
    ).rejects.toBe(failure);
  });

  it.each([
    new ToolResultArtifactReadTooLarge({ maxBytes: 1, actualBytes: 2, message: "Too large" }),
    new ToolResultArtifactReadCancelled({ message: "Cancelled" }),
  ])("does not maintain artifacts for a rejected read: $message", async (error) => {
    const maintain = mock(async () => Result.ok({ removedInvalid: 0, removedExpired: 0 }));
    const store = storeWithMaintenance(maintain);

    expect(await adaptToolResultArtifactReadToUnavailablePolicy(store, Result.err(error))).toEqual({
      ok: false,
    });
    expect(maintain).not.toHaveBeenCalled();
  });

  it("surfaces initialization errors at the host boundary", () => {
    expect(adaptToolResultArtifactStoreInitToHost(Result.ok(undefined))).toBeUndefined();
    expect(() =>
      adaptToolResultArtifactStoreInitToHost(
        Result.err(
          new ToolResultArtifactStorageFailure({
            operation: "initialize",
            code: "EACCES",
            message: "Cannot initialize artifacts",
          }),
        ),
      ),
    ).toThrow("Cannot initialize artifacts");
  });
});
