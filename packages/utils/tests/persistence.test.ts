import { describe, expect, it } from "bun:test";
import { Database, SQLiteError } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";

import { classifyBunSqliteError, runBunSqliteTransaction } from "../index";

class TestOperationRejected extends TaggedError("TestOperationRejected")<{
  readonly message: string;
}> {}

class TestSqliteDriverFailure extends TaggedError("TestSqliteDriverFailure")<{
  readonly code: string;
  readonly message: string;
}> {}

function classifyTestSqliteDriverFailure(cause: Error): TestSqliteDriverFailure | undefined {
  const sqliteError = classifyBunSqliteError(cause);
  if (sqliteError?.code !== "SQLITE_BUSY" && sqliteError?.code !== "SQLITE_CONSTRAINT_UNIQUE") {
    return undefined;
  }
  return new TestSqliteDriverFailure({
    code: sqliteError.code,
    message: "recognized SQLite driver failure",
  });
}

function rejectDriverFailures(): undefined {
  return undefined;
}

function createTestDatabase(): Database {
  const database = new Database(":memory:", { strict: true });
  database.run("CREATE TABLE entries (value TEXT NOT NULL UNIQUE)");
  return database;
}

function values(database: Database): readonly string[] {
  return database
    .query<{ value: string }, []>("SELECT value FROM entries ORDER BY rowid")
    .all()
    .map((row) => row.value);
}

function caughtFrom(operation: () => void): unknown {
  try {
    operation();
  } catch (cause) {
    return cause;
  }
  throw new Error("Expected operation to throw");
}

describe("shared persistence contracts", () => {
  it("classifies only real Bun SQLiteError instances", () => {
    const database = createTestDatabase();
    try {
      database.run("INSERT INTO entries (value) VALUES (?)", ["duplicate"]);
      const real = caughtFrom(() => {
        database.run("INSERT INTO entries (value) VALUES (?)", ["duplicate"]);
      });
      if (!Error.isError(real)) throw new Error("Expected a real SQLite Error");
      expect(classifyBunSqliteError(real)).toEqual({ code: "SQLITE_CONSTRAINT_UNIQUE" });

      const ordinary = new Error("synthetic SQLite failure");
      Object.defineProperty(ordinary, "code", { value: "SQLITE_BUSY" });
      expect(classifyBunSqliteError(ordinary)).toBeUndefined();

      const prototypeForged = Object.setPrototypeOf(
        new Error("prototype-forged SQLite failure"),
        SQLiteError.prototype,
      );
      Object.defineProperty(prototypeForged, "code", { value: "SQLITE_BUSY" });
      expect(classifyBunSqliteError(prototypeForged)).toBeUndefined();
    } finally {
      database.close();
    }
  });
});

describe("runBunSqliteTransaction", () => {
  it("rolls back an earlier write when the logical operation returns Err", () => {
    const database = createTestDatabase();
    const error = new TestOperationRejected({ message: "reject write" });

    try {
      const result = runBunSqliteTransaction(
        database,
        () => {
          database.run("INSERT INTO entries (value) VALUES (?)", ["rolled-back"]);
          return Result.err(error);
        },
        rejectDriverFailures,
      );

      expect(result.status).toBe("error");
      if (result.status === "error") expect(result.error).toBe(error);
      expect(values(database)).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("runs an Ok operation once and commits once", () => {
    const database = createTestDatabase();
    let calls = 0;

    try {
      const result = runBunSqliteTransaction(
        database,
        () => {
          calls += 1;
          database.run("INSERT INTO entries (value) VALUES (?)", ["committed"]);
          return Result.ok("complete");
        },
        rejectDriverFailures,
      );

      expect(result.status).toBe("ok");
      if (result.status === "ok") expect(result.value).toBe("complete");
      expect(calls).toBe(1);
      expect(values(database)).toEqual(["committed"]);
    } finally {
      database.close();
    }
  });

  it("rolls back and propagates the exact Panic", () => {
    const database = createTestDatabase();
    const panic = new Panic({ message: "transaction invariant" });

    try {
      const caught = caughtFrom(() => {
        runBunSqliteTransaction(
          database,
          (): ResultType<void, TestOperationRejected> => {
            database.run("INSERT INTO entries (value) VALUES (?)", ["rolled-back-panic"]);
            throw panic;
          },
          rejectDriverFailures,
        );
      });

      expect(caught).toBe(panic);
      expect(values(database)).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("maps a recognized constraint failure and rolls back preceding writes", () => {
    const database = createTestDatabase();
    database.run("INSERT INTO entries (value) VALUES (?)", ["duplicate"]);

    try {
      const result = runBunSqliteTransaction(
        database,
        () => {
          database.run("INSERT INTO entries (value) VALUES (?)", ["before-constraint"]);
          database.run("INSERT INTO entries (value) VALUES (?)", ["duplicate"]);
          return Result.ok(undefined);
        },
        classifyTestSqliteDriverFailure,
      );

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error).toBeInstanceOf(TestSqliteDriverFailure);
        expect(result.error.code).toBe("SQLITE_CONSTRAINT_UNIQUE");
      }
      expect(values(database)).toEqual(["duplicate"]);
    } finally {
      database.close();
    }
  });

  it("uses immediate mode and maps lock contention before invoking the operation", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "lilac-utils-sqlite-transaction-"));
    const filename = path.join(directory, "contention.sqlite");
    const writer = new Database(filename, { create: true, strict: true });
    const contender = new Database(filename, { strict: true });
    let operationCalls = 0;

    try {
      writer.run("CREATE TABLE entries (value TEXT NOT NULL UNIQUE)");
      writer.run("PRAGMA busy_timeout = 0");
      contender.run("PRAGMA busy_timeout = 0");
      writer.run("BEGIN IMMEDIATE");
      writer.run("INSERT INTO entries (value) VALUES (?)", ["uncommitted"]);

      const result = runBunSqliteTransaction(
        contender,
        () => {
          operationCalls += 1;
          return Result.ok(undefined);
        },
        classifyTestSqliteDriverFailure,
      );

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error).toBeInstanceOf(TestSqliteDriverFailure);
        expect(result.error.code).toBe("SQLITE_BUSY");
      }
      expect(operationCalls).toBe(0);

      writer.run("ROLLBACK");
      expect(values(contender)).toEqual([]);
    } finally {
      writer.close();
      contender.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("contains a nested Err to its savepoint while the outer transaction commits", () => {
    const database = createTestDatabase();
    const innerError = new TestOperationRejected({ message: "reject nested write" });

    try {
      const outer = runBunSqliteTransaction(
        database,
        () => {
          database.run("INSERT INTO entries (value) VALUES (?)", ["outer-before"]);
          const inner = runBunSqliteTransaction(
            database,
            () => {
              database.run("INSERT INTO entries (value) VALUES (?)", ["inner-rolled-back"]);
              return Result.err(innerError);
            },
            rejectDriverFailures,
          );
          if (inner.status === "ok") return Result.err(innerError);
          expect(inner.error).toBe(innerError);
          database.run("INSERT INTO entries (value) VALUES (?)", ["outer-after"]);
          return Result.ok(undefined);
        },
        rejectDriverFailures,
      );

      expect(outer.status).toBe("ok");
      expect(values(database)).toEqual(["outer-before", "outer-after"]);
    } finally {
      database.close();
    }
  });

  it("rethrows unrecognized Error, object, and primitive values unchanged", () => {
    const database = createTestDatabase();
    const causes: readonly unknown[] = [
      new Error("unrecognized"),
      { defect: "object" },
      "primitive-defect",
      17,
    ];

    try {
      for (const cause of causes) {
        const caught = caughtFrom(() => {
          runBunSqliteTransaction(
            database,
            (): ResultType<void, TestOperationRejected> => {
              database.run("INSERT INTO entries (value) VALUES (?)", [String(cause)]);
              throw cause;
            },
            rejectDriverFailures,
          );
        });
        expect(caught).toBe(cause);
        expect(values(database)).toEqual([]);
      }
    } finally {
      database.close();
    }
  });

  it("turns a detectable rollback failure into Panic", () => {
    const database = createTestDatabase();
    const operationError = new TestOperationRejected({ message: "rollback requested" });

    const caught = caughtFrom(() => {
      runBunSqliteTransaction(
        database,
        () => {
          database.run("INSERT INTO entries (value) VALUES (?)", ["atomicity-unknown"]);
          database.close();
          return Result.err(operationError);
        },
        classifyTestSqliteDriverFailure,
      );
    });

    expect(Panic.is(caught)).toBe(true);
    if (Panic.is(caught)) {
      expect(caught.message).toContain("atomicity is unknown");
      expect(caught.cause).not.toBe(operationError);
    }
  });
});
