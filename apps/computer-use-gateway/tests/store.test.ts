import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunnerStore } from "../src/store";

test("gateway database rejects unknown versions and malformed persisted rows", () => {
  const dir = mkdtempSync(join(tmpdir(), "lilac-computer-store-"));
  const path = join(dir, "store.sqlite");
  try {
    const future = new Database(path);
    future.exec("PRAGMA user_version=99");
    future.close();
    expect(RunnerStore.open(path).isErr()).toBe(true);
    const reset = new Database(path);
    reset.exec("PRAGMA user_version=0");
    reset.close();
    const opened = RunnerStore.open(path);
    if (opened.isErr()) throw new Error("Expected new database");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const corrupt = new Database(path);
    corrupt.exec(
      "INSERT INTO runners VALUES ('invalid','invalid',NULL,NULL,17000,'ready','invalid',3600,1)",
    );
    corrupt.close();
    expect(opened.value.list().isErr()).toBe(true);
    opened.value.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
