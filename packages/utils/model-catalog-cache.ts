import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { settlePromiseResult } from "./runtime-utils";
import { findWorkspaceRoot } from "./find-root";
import snapshot from "./model-catalog-snapshot.generated";
import { decodeModelsDevRegistry, type ModelsDevRegistry } from "./model-catalog-schema";

const DAY = 24 * 60 * 60 * 1000;

export class ModelCatalogCache {
  private registry: ModelsDevRegistry;
  private initialization: Promise<void> | undefined;
  private pending: Promise<void> | undefined;
  private checkedAt = 0;
  private reportFatalError: ((error: Error) => void) | undefined;

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
  ) {
    this.registry = options.snapshot ?? decodeModelsDevRegistry(snapshot) ?? {};
  }

  current(): ModelsDevRegistry {
    return this.registry;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async read(): Promise<ModelsDevRegistry> {
    this.initialization ??= this.initialize();
    await this.initialization;
    const now = (this.options.now ?? Date.now)();
    if (!this.pending && now - this.checkedAt >= DAY) {
      this.checkedAt = now;
      this.pending = this.refreshInBackground();
      if (!this.reportFatalError) await this.pending;
    }
    return this.registry;
  }

  private get cachePath() {
    return (
      this.options.cachePath ??
      path.join(
        process.env.DATA_DIR ?? path.join(findWorkspaceRoot(), "data"),
        "cache",
        "models.dev.json",
      )
    );
  }

  private async refreshInBackground(): Promise<void> {
    const reporter = this.reportFatalError;
    const outcome = await settlePromiseResult(() => this.refresh());
    this.pending = undefined;
    if (outcome.kind === "value") return;
    const cause = outcome.kind === "panic" ? outcome.panic : outcome.restoreCause();
    const error = cause instanceof Error ? cause : new Error("Model catalog refresh defect");
    if (!reporter) signalCatalogDefect(error);
    reporter(error);
  }

  private async initialize(): Promise<void> {
    const cached = await settlePromiseResult(async () => {
      const file = Bun.file(this.cachePath);
      const text = await readFile(this.cachePath, "utf8");
      return { text, timestamp: file.lastModified };
    });
    if (cached.kind === "panic") signalCatalogDefect(cached.panic);
    if (cached.kind !== "value") return;
    const decoded = await settlePromiseResult(async () => JSON.parse(cached.value.text));
    if (decoded.kind === "panic") signalCatalogDefect(decoded.panic);
    if (decoded.kind !== "value") return;
    const registry = decodeModelsDevRegistry(decoded.value);
    if (!registry) return;
    this.registry = registry;
    this.checkedAt = cached.value.timestamp;
    for (const listener of this.listeners) listener();
  }

  private async refresh(): Promise<void> {
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
    this.registry = registry;
    for (const listener of this.listeners) listener();
    const serialized = JSON.stringify(registry);
    const written = await settlePromiseResult(async () => {
      await mkdir(path.dirname(this.cachePath), { recursive: true });
      const temporary = `${this.cachePath}.${crypto.randomUUID()}.tmp`;
      await writeFile(temporary, serialized);
      await rename(temporary, this.cachePath);
    });
    if (written.kind === "panic") signalCatalogDefect(written.panic);
  }
}

export const modelCatalogCache = new ModelCatalogCache();

function signalCatalogDefect(error: Error): never {
  throw error;
}
