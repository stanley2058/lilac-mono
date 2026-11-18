import { basename } from "node:path";
import {
  HTML_PREVIEW_BOOTSTRAP_MARKUP,
  HTML_PREVIEW_LANGUAGE,
  HTML_PREVIEW_ROUTE,
  htmlPreviewPath,
  parseHtmlPreviewHref,
} from "@stanley2058/lilac-client-protocol";
import { Result, type Result as ResultType } from "better-result";
import type { Root, RootContent } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import type { SessionSafetyMode } from "../session-policy";
import { nativeFailure } from "./errors";
import type { NativeLiveFileService } from "./resources-live";
import type { NativeResourceService } from "./resources";
import type { NativeStore } from "./store";

const MAX_PREVIEWS_PER_TURN = 8;
const MAX_PAGE_BYTES = 16 * 1024 * 1024;
const decoder = new TextDecoder();

type Failure = { readonly message: string };
type PreviewRun = { readonly sessionId: string; readonly safetyMode: SessionSafetyMode };

function fencePath(node: Root | RootContent): string | undefined {
  if (node.type !== "code" || node.lang !== HTML_PREVIEW_LANGUAGE) return undefined;
  return htmlPreviewPath(node.value);
}

export function htmlPreviewPaths(texts: readonly string[]): string[] {
  const paths = new Set<string>();
  function inspect(node: Root | RootContent): void {
    const path = fencePath(node);
    if (path !== undefined) paths.add(path);
    if ("children" in node) for (const child of node.children) inspect(child);
  }
  for (const text of texts) inspect(fromMarkdown(text));
  return [...paths];
}

export function injectHtmlPreviewBootstrap(html: string): string {
  let injected = false;
  const rewritten = Result.try({
    try: () =>
      new HTMLRewriter()
        .on("head", {
          element(element) {
            if (injected) return;
            injected = true;
            element.prepend(HTML_PREVIEW_BOOTSTRAP_MARKUP, { html: true });
          },
        })
        .transform(html),
    catch: () => html,
  }).match({ ok: (value) => value, err: () => html });
  if (injected) return rewritten;
  const doctype = /^\s*<!doctype[^>]*>/iu.exec(html)?.[0] ?? "";
  return `${doctype}<head>${HTML_PREVIEW_BOOTSTRAP_MARKUP}</head>${html.slice(doctype.length)}`;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/gu, (character) => `&#${character.charCodeAt(0)};`);
}

function previewResponse(html: string, status = 200): Response {
  return new Response(injectHtmlPreviewBootstrap(html), {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      // Scripts and remote assets such as CDN chart libraries run, but in an opaque origin
      // without the app's cookies or storage.
      "Content-Security-Policy": "sandbox allow-scripts allow-forms allow-popups",
    },
  });
}

function unavailable(message: string, status: number): Response {
  return previewResponse(
    `<!doctype html><html><head></head><body><p style="margin:0;padding:8px 0;color:var(--muted-foreground)">Preview unavailable: ${escapeHtml(message)}</p></body></html>`,
    status,
  );
}

function failureStatus(error: Failure & { readonly code?: string }): number {
  switch (error.code) {
    case "forbidden":
      return 403;
    case "not-found":
      return 404;
    case "invalid":
      return 422;
    default:
      return 503;
  }
}

/**
 * Mirrors the output publisher's text parts, one entry per displayed message: a part ID names a
 * new message once its earlier part ended. A reset drops what the projection removes, which is the
 * previous attempt's messages or only its retried step's.
 */
export class HtmlPreviewReply {
  readonly #entries: { attemptId: string; stepId: string; text: string }[] = [];
  readonly #active = new Map<string, { attemptId: string; stepId: string; text: string }>();

  constructor(private attemptId: string) {}

  start(partId: string, stepId: string): void {
    if (this.#active.has(partId)) return;
    const entry = { attemptId: this.attemptId, stepId, text: "" };
    this.#entries.push(entry);
    this.#active.set(partId, entry);
  }

  append(partId: string, delta: string): void {
    const entry = this.#active.get(partId);
    if (entry) entry.text += delta;
  }

  end(partId: string): void {
    this.#active.delete(partId);
  }

  endStep(): void {
    this.#active.clear();
  }

  reset(nextAttemptId: string, stepId?: string): void {
    if (nextAttemptId === this.attemptId) return;
    const removed = (entry: { attemptId: string; stepId: string }) =>
      entry.attemptId === this.attemptId && (stepId === undefined || entry.stepId === stepId);
    const kept = this.#entries.filter((entry) => !removed(entry));
    this.#entries.splice(0, this.#entries.length, ...kept);
    this.#active.clear();
    this.attemptId = nextAttemptId;
  }

  texts(): string[] {
    return this.#entries.map((entry) => entry.text);
  }
}

export class NativeHtmlPreviews {
  constructor(
    private readonly dependencies: {
      store: Pick<
        NativeStore,
        "getThreadRecord" | "saveHtmlPreview" | "readHtmlPreview" | "publishUpload"
      >;
      files: Pick<NativeLiveFileService, "readRunFile">;
      resources: Pick<NativeResourceService, "ingest" | "get" | "readBytes">;
    },
  ) {}

  /**
   * Stores a copy of each page a turn's reply previews. Core reads only the named file, with the
   * file access of the run that wrote the reply, and never follows the page's references. A page
   * that cannot be read records why, and the preview route shows that reason instead.
   */
  async snapshot(input: {
    threadId: string;
    turnId: string;
    run: PreviewRun;
    texts: readonly string[];
  }) {
    const paths = htmlPreviewPaths(input.texts);
    if (paths.length === 0) return;
    const starterId = this.dependencies.store
      .getThreadRecord(input.threadId)
      .match({ ok: (thread) => thread.starterId, err: () => undefined });
    if (starterId === undefined) return;
    for (const [index, path] of paths.entries()) {
      const captured =
        index < MAX_PREVIEWS_PER_TURN
          ? await this.capture(starterId, input.threadId, input.run, path)
          : Result.err(
              nativeFailure(
                "invalid",
                `Only ${MAX_PREVIEWS_PER_TURN} previews are saved per reply`,
              ),
            );
      const outcome = captured.match<{ uploadId: string } | { error: string }>({
        ok: (uploadId) => ({ uploadId }),
        err: (error) => ({ error: error.message.slice(0, 1024) }),
      });
      this.dependencies.store
        .saveHtmlPreview({ threadId: input.threadId, turnId: input.turnId, path, ...outcome })
        .match({ ok: () => undefined, err: () => undefined });
    }
  }

  private async capture(
    actorId: string,
    threadId: string,
    run: PreviewRun,
    path: string,
  ): Promise<ResultType<string, Failure>> {
    return Result.gen(async function* () {
      const file = yield* Result.await(
        this.dependencies.files.readRunFile(actorId, threadId, path, run, MAX_PAGE_BYTES),
      );
      // The reader checks the size before reading, so a file that grew in between is caught here.
      if (file.bytes.byteLength > MAX_PAGE_BYTES)
        return Result.err(nativeFailure("invalid", "File exceeds the preview size limit"));
      const upload = yield* Result.await(
        this.dependencies.resources.ingest(actorId, threadId, {
          filename: basename(file.path),
          mediaType: "text/html",
          bytes: file.bytes,
        }),
      );
      yield* this.dependencies.store.publishUpload(actorId, upload.id);
      return Result.ok(upload.id);
    }, this);
  }

  async handle(request: Request, actorId: string): Promise<Response | undefined> {
    const url = new URL(request.url);
    if (url.pathname !== HTML_PREVIEW_ROUTE) return undefined;
    if (request.method !== "GET") return new Response(null, { status: 405 });
    const target = parseHtmlPreviewHref(url);
    if (!target) return unavailable("the preview link is invalid", 400);
    const page = await Result.gen(async function* () {
      const record = yield* this.dependencies.store.readHtmlPreview(actorId, target);
      if (record.uploadId === undefined)
        return Result.err(nativeFailure("invalid", record.error ?? "the page was not saved"));
      const upload = yield* this.dependencies.resources.get(actorId, record.uploadId);
      if (upload.state !== "ready" || !upload.resourceUri)
        return Result.err(nativeFailure("not-found", "the saved page is unavailable"));
      const file = yield* Result.await(
        this.dependencies.resources.readBytes(actorId, upload.resourceUri),
      );
      return Result.ok(decoder.decode(file.bytes));
    }, this);
    return page.match({
      ok: (html) => previewResponse(html),
      err: (error) => unavailable(error.message, failureStatus(error)),
    });
  }
}
