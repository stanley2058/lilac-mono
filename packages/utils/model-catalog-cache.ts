import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { findWorkspaceRoot } from "./find-root";
import { createLogger } from "./logging";
import {
  decodeModelsDevModel,
  decodeModelsDevProviderInfo,
  decodeModelsDevRegistry,
  type ModelCatalog,
  type ModelsDevModel,
  type ModelsDevProviderInfo,
  type ModelsDevRegistry,
} from "./model-catalog-schema";
import { errorMessage, settlePromiseResult, settleSyncResult } from "./runtime-utils";

const DAY = 24 * 60 * 60 * 1000;
const BUSY_TIMEOUT_MS = 10_000;
// The store is a rebuildable cache: a different version discards it and reseeds from the snapshot.
// Bump this when a change to the catalog schemas could make stored rows fail to decode.
const STORE_VERSION = 1;

const logger = createLogger({ module: "utils:model-catalog-cache" });

type DataRow = { data: string };

class SqliteModelCatalog implements ModelCatalog {
  constructor(private readonly db: Database) {}

  providerIds(): string[] {
    return this.db
      .query<{ id: string }, []>("SELECT id FROM providers ORDER BY rowid")
      .all()
      .map((row) => row.id);
  }

  provider(id: string): ModelsDevProviderInfo | undefined {
    const row = this.db.query<DataRow, [string]>("SELECT data FROM providers WHERE id = ?").get(id);
    return row ? decodeModelsDevProviderInfo(JSON.parse(row.data)) : undefined;
  }

  model(provider: string, id: string): ModelsDevModel | undefined {
    const row = this.db
      .query<DataRow, [string, string]>("SELECT data FROM models WHERE provider = ? AND id = ?")
      .get(provider, id);
    return row ? decodeModelsDevModel(JSON.parse(row.data)) : undefined;
  }

  models(provider: string): ModelsDevModel[] {
    return this.db
      .query<DataRow, [string]>("SELECT data FROM models WHERE provider = ? ORDER BY rowid")
      .all(provider)
      .flatMap((row) => decodeModelsDevModel(JSON.parse(row.data)) ?? []);
  }

  modelIds(provider: string): string[] {
    return this.db
      .query<{ id: string }, [string]>("SELECT id FROM models WHERE provider = ? ORDER BY rowid")
      .all(provider)
      .map((row) => row.id);
  }
}

function replaceCatalog(db: Database, registry: ModelsDevRegistry, fetchedAt: number): void {
  db.run("DELETE FROM models");
  db.run("DELETE FROM providers");
  const insertProvider = db.query("INSERT INTO providers (id, data) VALUES (?, ?)");
  const insertModel = db.query("INSERT INTO models (provider, id, data) VALUES (?, ?, ?)");
  for (const [providerId, { models, ...provider }] of Object.entries(registry)) {
    insertProvider.run(providerId, JSON.stringify(provider));
    for (const [modelId, model] of Object.entries(models)) {
      insertModel.run(providerId, modelId, JSON.stringify(model));
    }
  }
  db.query("INSERT OR REPLACE INTO catalog_meta (id, fetched_at) VALUES (1, ?)").run(fetchedAt);
}

function storeVersion(db: Database): number {
  return db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
}

function rebuildStore(db: Database, seed: () => ModelsDevRegistry): void {
  if (storeVersion(db) === STORE_VERSION) return;
  db.run(`
    DROP TABLE IF EXISTS models;
    DROP TABLE IF EXISTS providers;
    DROP TABLE IF EXISTS catalog_meta;
    CREATE TABLE providers (id TEXT NOT NULL UNIQUE, data TEXT NOT NULL);
    CREATE TABLE models (
      provider TEXT NOT NULL,
      id TEXT NOT NULL,
      data TEXT NOT NULL,
      UNIQUE (provider, id)
    );
    CREATE TABLE catalog_meta (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      fetched_at INTEGER NOT NULL
    );
  `);
  // Seeded data was never fetched, so the first supervised read refreshes it.
  replaceCatalog(db, seed(), 0);
  db.run(`PRAGMA user_version = ${STORE_VERSION}`);
}

function openStore(filename: string, seed: () => ModelsDevRegistry): Database {
  const db = new Database(filename);
  // This store keeps the rollback journal. Enabling WAL does not wait on the busy timeout, so
  // isolates opening a new store together can fail, and one daily writer does not need WAL.
  db.run(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  if (storeVersion(db) !== STORE_VERSION) {
    // Isolates can open a new store together. The write lock makes one seed it and the rest wait.
    db.transaction(() => rebuildStore(db, seed)).immediate();
  }
  return db;
}

function bundledSnapshot(): ModelsDevRegistry {
  // Keep the data lazy while letting Bun embed it in bundles. Source require wraps text in default;
  // bundled require returns the string directly.
  const snapshot: string | { default: string } = require("./model-catalog-snapshot.json.txt");
  return (
    decodeModelsDevRegistry(
      JSON.parse(typeof snapshot === "string" ? snapshot : snapshot.default),
    ) ?? {}
  );
}

export class ModelCatalogCache {
  private store: { db: Database; catalog: ModelCatalog } | undefined;
  private pending: Promise<void> | undefined;
  private checkedAt: number | undefined;
  private reportFatalError: ((error: Error) => void) | undefined;

  // Supervising marks this isolate as the store's only fetcher; other isolates only read it.
  supervise(reportFatalError: (error: Error) => void): void {
    this.reportFatalError = reportFatalError;
  }
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly options: {
      snapshot?: ModelsDevRegistry;
      cachePath?: string;
      fetch?: (input: string, init?: RequestInit) => Promise<Response>;
      now?: () => number;
    } = {},
  ) {}

  current(): ModelCatalog {
    return this.connect().catalog;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async read(): Promise<ModelCatalog> {
    const { db, catalog } = this.connect();
    if (!this.reportFatalError || this.pending) return catalog;
    const now = (this.options.now ?? Date.now)();
    this.checkedAt ??=
      db.query<{ fetched_at: number }, []>("SELECT fetched_at FROM catalog_meta").get()
        ?.fetched_at ?? 0;
    if (now - this.checkedAt < DAY) return catalog;
    this.checkedAt = now;
    this.pending = this.refreshInBackground(this.reportFatalError, now);
    return catalog;
  }

  private get cachePath() {
    return (
      this.options.cachePath ??
      path.join(
        process.env.DATA_DIR ?? path.join(findWorkspaceRoot(), "data"),
        "cache",
        "models.dev.sqlite",
      )
    );
  }

  private connect(): { db: Database; catalog: ModelCatalog } {
    if (this.store) return this.store;
    const seed = () => this.options.snapshot ?? bundledSnapshot();
    const filename = this.cachePath;
    const opened = settleSyncResult(() => {
      mkdirSync(path.dirname(filename), { recursive: true });
      return openStore(filename, seed);
    });
    if (opened.kind === "panic") signalCatalogDefect(opened.panic);
    let db: Database;
    if (opened.kind === "value") {
      db = opened.value;
    } else {
      logger.warn("model catalog store unavailable; using an in-memory copy", {
        filename,
        reason: errorMessage(opened.restoreCause()),
      });
      db = openStore(":memory:", seed);
    }
    this.store = { db, catalog: new SqliteModelCatalog(db) };
    return this.store;
  }

  private async refreshInBackground(
    reporter: (error: Error) => void,
    fetchedAt: number,
  ): Promise<void> {
    const outcome = await settlePromiseResult(() => this.refresh(fetchedAt));
    this.pending = undefined;
    if (outcome.kind === "value") return;
    const cause = outcome.kind === "panic" ? outcome.panic : outcome.restoreCause();
    reporter(cause instanceof Error ? cause : new Error("Model catalog refresh defect"));
  }

  private async refresh(fetchedAt: number): Promise<void> {
    const fetched = await settlePromiseResult(async () => {
      const response = await (this.options.fetch ?? fetch)("https://models.dev/api.json", {
        signal: AbortSignal.timeout(15_000),
      });
      return response.ok ? await response.json() : null;
    });
    if (fetched.kind === "panic") signalCatalogDefect(fetched.panic);
    if (fetched.kind !== "value") return;
    const registry = decodeModelsDevRegistry(fetched.value);
    if (!registry) return;
    const { db } = this.connect();
    const written = settleSyncResult(() =>
      db.transaction(() => replaceCatalog(db, registry, fetchedAt)).immediate(),
    );
    if (written.kind === "panic") signalCatalogDefect(written.panic);
    if (written.kind !== "value") return;
    for (const listener of this.listeners) listener();
  }
}

export const modelCatalogCache = new ModelCatalogCache();

function signalCatalogDefect(error: Error): never {
  throw error;
}
