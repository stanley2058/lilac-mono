import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Result } from "better-result";
import { decodeRecords, storageFailure, type RunnerRecord } from "./contracts";

export class RunnerStore {
  constructor(private readonly db: Database) {}

  static open(path: string) {
    return Result.gen(function* () {
      const db = yield* Result.try({
        try: () => {
          if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
          const database = new Database(path, { create: true, strict: true });
          if (path !== ":memory:") chmodSync(path, 0o600);
          return database;
        },
        catch: () => storageFailure("io", "Cannot open computer lifecycle database"),
      });
      const setup = Result.try({
        try: () => {
          const version = db
            .query<{ user_version: number }, []>("PRAGMA user_version")
            .get()?.user_version;
          if (version !== 0 && version !== 1)
            return Result.err(
              storageFailure(
                "unsupported_version",
                "Unsupported computer lifecycle database version",
              ),
            );
          db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
          db.exec(`CREATE TABLE IF NOT EXISTS runners (
            session TEXT PRIMARY KEY, generation TEXT NOT NULL UNIQUE, containerId TEXT, runtimeId TEXT,
            port INTEGER NOT NULL UNIQUE, state TEXT NOT NULL, password TEXT NOT NULL,
            idleSeconds INTEGER NOT NULL, expiresAt INTEGER NOT NULL
          ); PRAGMA user_version=1;`);
          return Result.ok(undefined);
        },
        catch: () => storageFailure("io", "Cannot initialize computer lifecycle database"),
      });
      const initialized = setup.andThen((result) => result);
      const error = initialized.match({ ok: () => null, err: (value) => value });
      if (error) {
        db.close();
        return Result.err(error);
      }
      return Result.ok(new RunnerStore(db));
    });
  }

  list() {
    const db = this.db;
    return Result.gen(function* () {
      const rows = yield* Result.try({
        try: () => db.query("SELECT * FROM runners").all(),
        catch: () => storageFailure("io", "Cannot read computer lifecycle records"),
      });
      return decodeRecords(rows);
    });
  }

  reserve(record: RunnerRecord) {
    return Result.try({
      try: () => {
        this.db
          .query("INSERT INTO runners VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .run(
            record.session,
            record.generation,
            record.containerId,
            record.runtimeId,
            record.port,
            record.state,
            record.password,
            record.idleSeconds,
            record.expiresAt,
          );
      },
      catch: () => storageFailure("io", "Cannot reserve computer lifecycle record"),
    });
  }

  update(record: RunnerRecord) {
    return Result.try({
      try: () =>
        this.db
          .query(
            "UPDATE runners SET containerId=?, runtimeId=?, state=?, idleSeconds=?, expiresAt=? WHERE session=? AND generation=?",
          )
          .run(
            record.containerId,
            record.runtimeId,
            record.state,
            record.idleSeconds,
            record.expiresAt,
            record.session,
            record.generation,
          ),
      catch: () => storageFailure("io", "Cannot update computer lifecycle record"),
    }).map(() => undefined);
  }

  remove(record: RunnerRecord) {
    return Result.try({
      try: () => {
        this.db
          .query("DELETE FROM runners WHERE session=? AND generation=?")
          .run(record.session, record.generation);
      },
      catch: () => storageFailure("io", "Cannot release computer lifecycle record"),
    });
  }

  close() {
    this.db.close();
  }
}
