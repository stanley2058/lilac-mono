import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Result } from "better-result";
import { decodeRecords, failure, type RunnerRecord } from "./contracts";

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
        catch: () => failure("storage", "Cannot open computer lifecycle database"),
      });
      const setup = Result.try({
        try: () => {
          const version = db
            .query<{ user_version: number }, []>("PRAGMA user_version")
            .get()?.user_version;
          if (version !== 0 && version !== 1) return false;
          db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
          db.exec(`CREATE TABLE IF NOT EXISTS runners (
            session TEXT PRIMARY KEY, generation TEXT NOT NULL UNIQUE, containerId TEXT, runtimeId TEXT,
            port INTEGER NOT NULL UNIQUE, state TEXT NOT NULL, password TEXT NOT NULL,
            idleSeconds INTEGER NOT NULL, expiresAt INTEGER NOT NULL
          ); PRAGMA user_version=1;`);
          return true;
        },
        catch: () => failure("storage", "Cannot initialize computer lifecycle database"),
      });
      const ready = setup.match({ ok: (value) => value, err: () => false });
      if (!ready) {
        db.close();
        return Result.err(
          failure("storage", "Unsupported or inaccessible computer lifecycle database"),
        );
      }
      return Result.ok(new RunnerStore(db));
    });
  }

  list() {
    const db = this.db;
    return Result.gen(function* () {
      const rows = yield* Result.try({
        try: () => db.query("SELECT * FROM runners").all(),
        catch: () => failure("storage", "Cannot read computer lifecycle records"),
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
      catch: () => failure("storage", "Cannot reserve computer lifecycle record"),
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
      catch: () => failure("storage", "Cannot update computer lifecycle record"),
    }).map(() => undefined);
  }

  remove(record: RunnerRecord) {
    return Result.try({
      try: () => {
        this.db
          .query("DELETE FROM runners WHERE session=? AND generation=?")
          .run(record.session, record.generation);
      },
      catch: () => failure("storage", "Cannot release computer lifecycle record"),
    });
  }

  close() {
    this.db.close();
  }
}
