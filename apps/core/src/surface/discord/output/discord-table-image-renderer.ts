import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";
import type { Browser, Page } from "playwright";
import { createLogger } from "@stanley2058/lilac-utils";

import type { MarkdownTableData } from "../../../shared/markdown-table-renderer";
import { settleSurfaceFallback } from "../../adapter";

export const DISCORD_TABLE_IMAGE_MAX_BYTES = 20 * 1024 * 1024;

class DiscordTableRenderFailed extends TaggedError("DiscordTableRenderFailed")<{
  message: string;
}> {}

async function captureTableRender<T>(
  operation: () => Promise<T>,
): Promise<ResultType<T, DiscordTableRenderFailed>> {
  return settleSurfaceFallback(
    await Result.tryPromise({
      try: operation,
      catch: (cause) => {
        const fallback = new DiscordTableRenderFailed({ message: "Table image rendering failed" });
        if (Panic.is(cause)) return { kind: "panic", panic: cause, fallback };
        return { kind: "fallback", fallback };
      },
    }),
  );
}

function drawTable(table: MarkdownTableData): void {
  const element = document.createElement("table");
  element.style.cssText =
    'border-collapse:collapse;table-layout:fixed;font:25px/32px "Liberation Sans",Arial,sans-serif;color:#eeeef5;outline:1px solid #474656;outline-offset:-1px';
  document.body.style.margin = "0";
  document.body.replaceChildren(element);
  const cells = table.rows.map((row, rowIndex) => {
    const tr = element.insertRow();
    return row.map((cell) => {
      const td = tr.insertCell();
      td.style.cssText = "padding:4px 6px;vertical-align:top;box-shadow:inset 1px 1px #474656";
      td.style.background = rowIndex % 2 ? "#20212d" : "#262735";
      if (rowIndex === 0) {
        td.style.background = "#333044";
        td.style.color = "#c1a2ff";
        td.style.fontSize = "23px";
        td.style.fontWeight = "700";
      }
      const content = document.createElement("div");
      // This is a wrapping target. Unbroken words may extend the column beyond it.
      content.style.cssText =
        "width:360px;min-height:32px;white-space:pre-wrap;overflow-wrap:normal;word-break:normal";
      td.append(content);
      for (const run of cell.runs) {
        const span = document.createElement("span");
        span.textContent = run.text;
        if (run.bold) span.style.fontWeight = "700";
        if (run.italic) span.style.fontStyle = "italic";
        span.style.textDecorationLine = [
          run.underline ? "underline" : "",
          run.strike ? "line-through" : "",
        ]
          .filter(Boolean)
          .join(" ");
        if (run.code) {
          span.style.fontFamily = '"Liberation Mono",monospace';
          span.style.background = "#353642";
          span.style.borderRadius = "3px";
        }
        content.append(span);
      }
      return content;
    });
  });
  const widths = (cells[0] ?? []).map((_, column) => {
    let width = 0;
    for (const row of cells) {
      const content = row[column]!;
      const left = content.getBoundingClientRect().left;
      const range = document.createRange();
      range.selectNodeContents(content);
      for (const rect of range.getClientRects()) width = Math.max(width, rect.right - left);
    }
    return Math.ceil(width) + 1;
  });
  element.style.width = `${widths.reduce((sum, width) => sum + width + 12, 0)}px`;
  for (const row of cells) {
    for (const [column, content] of row.entries()) {
      content.style.width = `${widths[column]}px`;
      content.parentElement!.style.width = `${widths[column]}px`;
      content.style.textAlign = table.align[column] ?? "left";
    }
  }
}

export type DiscordTableRenderContext = {
  requestId?: string;
  channelId?: string;
};

async function launchDiscordTableBrowser(): Promise<Browser> {
  const executablePath =
    process.env.LILAC_CHROMIUM_PATH ??
    process.env.CHROMIUM_PATH ??
    Bun.which("chromium") ??
    Bun.which("chromium-browser") ??
    Bun.which("google-chrome") ??
    Bun.which("google-chrome-stable") ??
    undefined;
  const { chromium } = await import("playwright");
  return chromium.launch({ headless: true, executablePath });
}

export class DiscordTableImageRenderer {
  private readonly logger = createLogger({ module: "surface:discord:table-image" });
  private readonly rendererId = crypto.randomUUID();
  private browser: Browser | null = null;
  private page: Page | null = null;
  private enabled = false;
  private requestedEnabled = false;
  private pending: Promise<void> = Promise.resolve();
  private configuration: Promise<void> = Promise.resolve();
  private nextRenderId = 0;

  constructor(private readonly launchBrowser: () => Promise<Browser> = launchDiscordTableBrowser) {}

  setEnabled(enabled: boolean): Promise<void> {
    if (this.requestedEnabled === enabled) return this.configuration;
    this.requestedEnabled = enabled;
    this.logger.debug("table_image.configured", { rendererId: this.rendererId, enabled });
    this.configuration = this.exclusive(async () => {
      this.enabled = enabled;
      if (!enabled) return this.closeBrowser("disabled");
      await this.ensureReady();
    });
    return this.configuration;
  }

  close(): Promise<void> {
    return this.setEnabled(false);
  }

  readonly render = (
    tables: readonly MarkdownTableData[],
    context: DiscordTableRenderContext = {},
  ): Promise<readonly (Uint8Array | null)[]> => {
    if (tables.length === 0) return Promise.resolve([]);
    const requestedAt = performance.now();
    const renderId = ++this.nextRenderId;
    return this.exclusive(async () => {
      const startedAt = performance.now();
      const logContext = { ...context, rendererId: this.rendererId, renderId };
      this.logger.debug("table_image.render.start", {
        ...logContext,
        tableCount: tables.length,
        waitMs: startedAt - requestedAt,
      });
      const page = this.enabled ? await this.ensureReady() : null;
      if (!page) {
        this.logger.debug("table_image.render.fallback", {
          ...logContext,
          reason: this.enabled ? "browser-unavailable" : "disabled",
          durationMs: performance.now() - startedAt,
        });
        return tables.map(() => null);
      }
      const images: (Uint8Array | null)[] = [];
      for (const [tableIndex, table] of tables.entries()) {
        const tableStartedAt = performance.now();
        let layoutMs = 0;
        let screenshotStartedAt: number | null = null;
        const rendered = await captureTableRender(async () => {
          await page.evaluate(drawTable, table);
          screenshotStartedAt = performance.now();
          layoutMs = screenshotStartedAt - tableStartedAt;
          return page.locator("table").screenshot({ type: "png" });
        });
        const bytes = rendered.match({ ok: (value) => value, err: () => null });
        images.push(bytes);
        this.logger.debug("table_image.render.table", {
          ...logContext,
          tableIndex,
          rows: table.rows.length,
          columns: table.rows[0]?.length ?? 0,
          layoutMs: screenshotStartedAt === null ? performance.now() - tableStartedAt : layoutMs,
          screenshotMs: screenshotStartedAt === null ? 0 : performance.now() - screenshotStartedAt,
          bytes: bytes?.byteLength ?? 0,
          fallback: bytes === null,
        });
      }
      this.logger.debug("table_image.render.complete", {
        ...logContext,
        tableCount: tables.length,
        durationMs: performance.now() - startedAt,
        totalMs: performance.now() - requestedAt,
      });
      return images;
    });
  };

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    // One page owns the DOM, so rendering and lifecycle changes must not overlap.
    const result = this.pending.then(operation);
    this.pending = Promise.allSettled([result]).then(() => undefined);
    return result;
  }

  private async ensureReady(): Promise<Page | null> {
    if (this.browser?.isConnected() && this.page && !this.page.isClosed()) return this.page;
    await this.closeBrowser("unavailable");
    const startedAt = performance.now();
    this.logger.debug("table_image.browser.start", { rendererId: this.rendererId });
    const launched = await captureTableRender(this.launchBrowser);
    this.browser = launched.match({ ok: (value) => value, err: () => null });
    const launchMs = performance.now() - startedAt;
    if (!this.browser) {
      this.logger.debug("table_image.browser.failed", {
        rendererId: this.rendererId,
        stage: "launch",
        durationMs: launchMs,
      });
      return null;
    }
    const browser = this.browser;
    browser.on("disconnected", () => {
      this.logger.debug("table_image.browser.disconnected", { rendererId: this.rendererId });
    });
    const pageStartedAt = performance.now();
    const opened = await captureTableRender(() => browser.newPage({ deviceScaleFactor: 2 }));
    this.page = opened.match({ ok: (value) => value, err: () => null });
    const pageMs = performance.now() - pageStartedAt;
    if (!this.page) {
      this.logger.debug("table_image.browser.failed", {
        rendererId: this.rendererId,
        stage: "page",
        durationMs: pageMs,
      });
      await this.closeBrowser("page-failed");
      return null;
    }
    const page = this.page;
    page.on("crash", () => {
      if (this.page === page) this.page = null;
      this.logger.debug("table_image.page.crashed", { rendererId: this.rendererId });
    });
    const warmupStartedAt = performance.now();
    const warmed = await captureTableRender(async () => {
      await page.evaluate(drawTable, { rows: [[{ runs: [{ text: "Table" }] }]], align: [] });
      await page.locator("table").screenshot({ type: "png" });
      return true;
    });
    const ready = warmed.match({ ok: (value) => value, err: () => false });
    if (!ready) {
      this.logger.debug("table_image.browser.failed", {
        rendererId: this.rendererId,
        stage: "warmup",
        durationMs: performance.now() - warmupStartedAt,
      });
      await this.closeBrowser("warmup-failed");
      return null;
    }
    this.logger.debug("table_image.browser.ready", {
      rendererId: this.rendererId,
      launchMs,
      pageMs,
      warmupMs: performance.now() - warmupStartedAt,
      durationMs: performance.now() - startedAt,
    });
    return page;
  }

  private async closeBrowser(reason: string): Promise<void> {
    const browser = this.browser;
    this.browser = null;
    this.page = null;
    if (!browser) return;
    const startedAt = performance.now();
    this.logger.debug("table_image.browser.close", { rendererId: this.rendererId, reason });
    const closed = await captureTableRender(() => browser.close());
    this.logger.debug("table_image.browser.closed", {
      rendererId: this.rendererId,
      reason,
      durationMs: performance.now() - startedAt,
      success: closed.match({ ok: () => true, err: () => false }),
    });
  }
}

export async function renderDiscordTableImages(
  tables: readonly MarkdownTableData[],
  context: DiscordTableRenderContext = {},
): Promise<readonly (Uint8Array | null)[]> {
  if (tables.length === 0) return [];
  const renderer = new DiscordTableImageRenderer();
  const render = async () => {
    await renderer.setEnabled(true);
    return renderer.render(tables, context);
  };
  return render().finally(() => renderer.close());
}
