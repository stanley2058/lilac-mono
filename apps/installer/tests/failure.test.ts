import { describe, expect, it } from "bun:test";
import { Panic, Result } from "better-result";
import {
  captureInstallerException,
  isInstallerCancellation,
  runInstallerHost,
  withInstallerCleanup,
} from "../src/failure";

describe("installer failure boundaries", () => {
  it("cleans up before returning the operation result", async () => {
    const events: string[] = [];
    const value = await withInstallerCleanup(
      async () => {
        events.push("operation");
        return 7;
      },
      () => {
        events.push("cleanup");
      },
    );
    expect(value).toBe(7);
    expect(events).toEqual(["operation", "cleanup"]);
  });

  it("preserves the original Panic after cleanup also fails", async () => {
    const panic = new Panic({ message: "fixture operation panic" });
    let cleaned = false;
    const outcome = await Result.tryPromise({
      try: () =>
        withInstallerCleanup(
          async () => {
            throw panic;
          },
          () => {
            cleaned = true;
            throw new Error("fixture cleanup failure");
          },
        ),
      catch: captureInstallerException,
    });
    expect(cleaned).toBe(true);
    expect(outcome.match({ ok: () => undefined, err: (error) => error })).toBe(panic);
  });

  it("does not hide a cleanup Panic behind ordinary cancellation", async () => {
    const panic = new Panic({ message: "fixture cleanup panic" });
    const outcome = await Result.tryPromise({
      try: () =>
        withInstallerCleanup(
          async () => {
            throw new DOMException("fixture cancellation", "AbortError");
          },
          () => {
            throw panic;
          },
        ),
      catch: captureInstallerException,
    });
    expect(outcome.match({ ok: () => undefined, err: (error) => error })).toBe(panic);
  });

  it("does not hide a cleanup Panic behind Result.gen's cancellation wrapper", async () => {
    const panic = new Panic({ message: "fixture cleanup panic" });
    const outcome = await Result.tryPromise({
      try: () =>
        withInstallerCleanup(
          () =>
            Result.gen(async function* () {
              await Promise.reject(new DOMException("fixture cancellation", "AbortError"));
              return Result.ok(undefined);
            }),
          () => {
            throw panic;
          },
        ),
      catch: captureInstallerException,
    });
    expect(outcome.match({ ok: () => undefined, err: (error) => error })).toBe(panic);
  });

  it("preserves cleanup failure identity after a successful operation", async () => {
    const failure = new Error("fixture cleanup failure");
    const outcome = await Result.tryPromise({
      try: () =>
        withInstallerCleanup(
          async () => 0,
          () => {
            throw failure;
          },
        ),
      catch: captureInstallerException,
    });
    expect(outcome.match({ ok: () => undefined, err: (error) => error })).toBe(failure);
  });

  it("recognizes readline cancellation wrapped by the installed Result.gen", async () => {
    const aborted = await Result.tryPromise({
      try: () =>
        Result.gen(async function* () {
          await Promise.reject(new DOMException("fixture cancellation", "AbortError"));
          return Result.ok(undefined);
        }),
      catch: captureInstallerException,
    });
    const cancelled = aborted.match({ ok: () => false, err: isInstallerCancellation });
    expect(cancelled).toBe(true);
    expect(isInstallerCancellation(new Panic({ message: "fixture defect" }))).toBe(false);
    expect(
      isInstallerCancellation(
        new Panic({
          message: "fixture defect",
          cause: new DOMException("fixture cancellation", "AbortError"),
        }),
      ),
    ).toBe(false);
  });

  it("reports a fatal exit without revealing exception messages or causes", async () => {
    const reports: string[] = [];
    const panic = new Panic({
      message: "fixture-sensitive-message",
      cause: new Error("fixture-sensitive-cause"),
    });
    const code = await runInstallerHost(
      async () => {
        throw panic;
      },
      (message) => reports.push(message),
    );
    expect(code).toBe(1);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain("internal error");
    expect(reports.join("\n")).not.toContain("fixture-sensitive");
  });

  it("retains cancellation exit status without fatal reporting", async () => {
    const reports: string[] = [];
    expect(
      await runInstallerHost(
        async () => 130,
        (message) => reports.push(message),
      ),
    ).toBe(130);
    expect(reports).toEqual([]);
  });
});
