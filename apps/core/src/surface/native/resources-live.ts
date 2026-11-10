import { nativeSessionId } from "./native-protocol";
import { fromMarkdown } from "mdast-util-from-markdown";
import type { Root, RootContent } from "mdast";
import { realpath } from "node:fs/promises";
import { basename, posix } from "node:path";
import type { FileSystem } from "@stanley2058/lilac-fs";
import type { PersistedDataError } from "@stanley2058/lilac-utils";
import { Result, type Result as ResultType } from "better-result";
import { RESOURCE_MAX_BYTES } from "../../resource/contracts";
import {
  inferMimeTypeFromFilename,
  isPathInside,
  resolveRestrictedSessionTmpDir,
  resolveToolPathForRequestContextResult,
} from "../../shared/attachment-utils";
import { parseSshCwdTarget } from "../../ssh/ssh-cwd";
import { remoteReadFileBytes } from "../../tools/fs/remote-fs";
import type { NativeThreadRecord, NativeUser } from "./codec";
import { NATIVE_TEXT_PREVIEW_BYTES, textPreview } from "./resource-preview";
import { nativeFailure, type NativeStoreFailure } from "./errors";

type NativeFileError = NativeStoreFailure | PersistedDataError;
type NativeFileResult<T> = ResultType<T, NativeFileError>;
export type PublishedNativePath = { id: string; threadId: string; path: string; cwd?: string };

export class NativeLiveFileService {
  // The filesystem checks the revision and then writes asynchronously, so competing editor saves
  // for one file must run one at a time or both can pass the same revision check.
  private readonly saves = new Map<string, Promise<void>>();

  constructor(
    readonly dependencies: {
      native: {
        readPublishedPath(actorId: string, id: string): NativeFileResult<PublishedNativePath>;
        getThreadRecord(threadId: string): NativeFileResult<NativeThreadRecord>;
        getUser(actorId: string): NativeFileResult<NativeUser>;
        authorizeThread(
          actorId: string,
          threadId: string,
          edit?: boolean,
        ): NativeFileResult<NativeThreadRecord>;
        registerPublishedPath(
          actorId: string,
          threadId: string,
          path: string,
          cwd?: string,
        ): NativeFileResult<PublishedNativePath>;
      };
      filesystem: FileSystem;
      toolRoot: string;
      remoteDenyPaths: readonly string[];
    },
  ) {}

  async resolve(actorId: string, threadId: string, inputPath: string, signal?: AbortSignal) {
    return Result.gen(async function* () {
      const reference = yield* this.publish(actorId, threadId, inputPath);
      const file = yield* Result.await(this.read(actorId, reference.id, signal, true));
      return Result.ok({
        path: reference.path,
        name: file.filename,
        mediaType: file.mediaType,
        href: `/api/files/${reference.id}`,
      });
    }, this);
  }

  /** Reads a whole file under the thread's filesystem permissions, as `resolve` previews it. */
  async readThreadFile(actorId: string, threadId: string, inputPath: string, signal?: AbortSignal) {
    return Result.gen(async function* () {
      const reference = yield* this.publish(actorId, threadId, inputPath);
      const file = yield* Result.await(this.read(actorId, reference.id, signal));
      return Result.ok({ ...file, path: reference.path });
    }, this);
  }

  private editorPath(actorId: string, threadId: string, inputPath: string) {
    return Result.gen(async function* () {
      const thread = yield* this.dependencies.native.authorizeThread(actorId, threadId, true);
      const actor = yield* this.dependencies.native.getUser(actorId);
      const starter = yield* this.dependencies.native.getUser(thread.starterId);
      if (actor.toolMode === "restricted" && starter.toolMode !== "restricted")
        return Result.err(nativeFailure("forbidden", "File browsing is outside your tool access"));
      const restricted = starter.toolMode === "restricted";
      const root = restricted ? "/tmp" : this.dependencies.toolRoot;
      const path = posix.resolve(root, inputPath);
      const sessionId = nativeSessionId(threadId);
      const resolved = yield* resolveToolPathForRequestContextResult({
        cwd: root,
        inputPath: path,
        context: { sessionId, safetyMode: restricted ? "restricted" : "trusted" },
      }).mapError(() => nativeFailure("forbidden", "File path is outside this thread's access"));
      const canonical = yield* Result.await(
        Result.tryPromise({
          try: () => realpath(resolved),
          catch: () => nativeFailure("not-found", "File not found"),
        }),
      );
      if (!restricted) return Result.ok({ root, path, resolved, canonical });
      // Restricted paths are checked lexically; a symlink in the session directory must not
      // lead the editor outside it.
      const sessionRoot = yield* Result.await(
        Result.tryPromise({
          try: () => realpath(resolveRestrictedSessionTmpDir(sessionId)),
          catch: () => nativeFailure("not-found", "File not found"),
        }),
      );
      if (!isPathInside(sessionRoot, canonical))
        return Result.err(nativeFailure("forbidden", "File path is outside this thread's access"));
      return Result.ok({ root, path, resolved, canonical });
    }, this);
  }

  /** Runs `task` after earlier saves of `key`; `task` must resolve with a Result instead of rejecting. */
  private exclusive<T>(key: string, task: () => Promise<T>): Promise<T> {
    const run = (this.saves.get(key) ?? Promise.resolve()).then(task);
    const tail = run.then(() => {
      if (this.saves.get(key) === tail) this.saves.delete(key);
    });
    this.saves.set(key, tail);
    return run;
  }

  async tree(actorId: string, threadId: string) {
    return Result.gen(async function* () {
      const location = yield* Result.await(this.editorPath(actorId, threadId, "."));
      const listing = await this.dependencies.filesystem.glob({
        baseDir: location.resolved,
        patterns: ["**/*", "!**/.git/**", "!**/node_modules/**"],
        maxEntries: 10_000,
        mode: "detailed",
      });
      if (listing.error || listing.mode !== "detailed")
        return Result.err(nativeFailure("not-found", "Could not list workspace files"));
      return Result.ok({
        root: location.root,
        paths: listing.entries
          .filter((entry) => entry.type === "file")
          .map((entry) => entry.path)
          .sort(),
        truncated: listing.truncated,
      });
    }, this);
  }

  async document(actorId: string, threadId: string, inputPath: string) {
    return Result.gen(async function* () {
      const location = yield* Result.await(this.editorPath(actorId, threadId, inputPath));
      const read = await this.dependencies.filesystem.readFileBytes({
        path: location.resolved,
        maxBytes: 262_144,
      });
      if (!read.success)
        return Result.err(
          nativeFailure(
            "invalid",
            "Cannot edit this file. It must be readable and no larger than 256 KiB.",
          ),
        );
      const text = yield* Result.try({
        try: () => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(read.bytes),
        catch: () => nativeFailure("invalid", "Only UTF-8 text files can be edited"),
      });
      if (text.includes("\0"))
        return Result.err(nativeFailure("invalid", "Binary files cannot be edited"));
      return Result.ok({ path: location.path, text, revision: read.fileHash });
    }, this);
  }

  async saveDocument(
    actorId: string,
    input: { threadId: string; path: string; text: string; expectedRevision: string },
  ) {
    return Result.gen(async function* () {
      if (Buffer.byteLength(input.text) > 262_144 || input.text.includes("\0"))
        return Result.err(nativeFailure("invalid", "Only text files up to 256 KiB can be saved"));
      const location = yield* Result.await(this.editorPath(actorId, input.threadId, input.path));
      const written = yield* Result.await(
        this.exclusive(location.canonical, () =>
          Result.tryPromise({
            try: () =>
              this.dependencies.filesystem.writeFile({
                path: location.resolved,
                content: input.text,
                overwrite: true,
                expectedHash: input.expectedRevision,
                createParents: false,
              }),
            catch: () => nativeFailure("forbidden", "Could not save this file"),
          }),
        ),
      );
      if (!written.success) {
        const conflict =
          written.error.code === "HASH_MISMATCH" || written.error.code === "NOT_FOUND";
        return Result.err(
          nativeFailure(
            conflict ? "conflict" : "forbidden",
            conflict
              ? "File changed on disk. Reload it before saving."
              : "Could not save this file",
          ),
        );
      }
      return Result.ok({ path: location.path, text: input.text, revision: written.fileHash });
    }, this);
  }

  private publish(
    actorId: string,
    threadId: string,
    inputPath: string,
  ): NativeFileResult<PublishedNativePath> {
    return Result.gen(function* () {
      const thread = yield* this.dependencies.native.authorizeThread(actorId, threadId, true);
      const actor = yield* this.dependencies.native.getUser(actorId);
      const starter = yield* this.dependencies.native.getUser(thread.starterId);
      if (actor.toolMode === "restricted" && starter.toolMode !== "restricted")
        return Result.err(nativeFailure("forbidden", "File browsing is outside your tool access"));
      const restricted = starter.toolMode === "restricted";
      const cwd = restricted ? "/tmp" : this.dependencies.toolRoot;
      const resolved = yield* resolveToolPathForRequestContextResult({
        cwd,
        inputPath,
        context: {
          sessionId: nativeSessionId(threadId),
          safetyMode: restricted ? "restricted" : "trusted",
        },
      }).mapError(() => nativeFailure("forbidden", "File path is outside this thread's access"));
      // Restricted paths stay virtual so the existing reader applies its session sandbox mapping once.
      const path = restricted ? posix.resolve(cwd, inputPath) : resolved;
      return this.dependencies.native.registerPublishedPath(actorId, threadId, path, cwd);
    }, this);
  }

  async read(
    actorId: string,
    pathId: string,
    signal?: AbortSignal,
    preview = false,
  ): Promise<
    NativeFileResult<{ bytes: Uint8Array; filename: string; mediaType: string; byteLength: number }>
  > {
    return Result.gen(async function* () {
      const reference = yield* this.dependencies.native.readPublishedPath(actorId, pathId);
      const thread = yield* this.dependencies.native.getThreadRecord(reference.threadId);
      const starter = yield* this.dependencies.native.getUser(thread.starterId);
      const target = parseSshCwdTarget(reference.cwd);
      if (target.kind === "ssh" && starter.toolMode === "restricted")
        return Result.err(
          nativeFailure("forbidden", "Remote file preview is unavailable for this thread"),
        );
      if (target.kind === "ssh") {
        const read = yield* Result.await(
          remoteReadFileBytes({
            host: target.host,
            cwd: target.cwd,
            filePath: reference.path,
            denyPaths: this.dependencies.remoteDenyPaths,
            maxBytes: preview ? NATIVE_TEXT_PREVIEW_BYTES : RESOURCE_MAX_BYTES,
            ...(preview ? { prefixBytes: NATIVE_TEXT_PREVIEW_BYTES } : {}),
            ...(signal ? { signal } : {}),
          }).then((result) =>
            result.mapError(() => nativeFailure("not-found", "File is missing or unreadable")),
          ),
        );
        if (!read.ok)
          return Result.err(nativeFailure("not-found", "File is missing or unreadable"));
        const bytes = Buffer.from(read.base64, "base64");
        if (bytes.byteLength > RESOURCE_MAX_BYTES)
          return Result.err(nativeFailure("invalid", "File exceeds the preview size limit"));
        yield* this.dependencies.native.readPublishedPath(actorId, pathId);
        return Result.ok({
          bytes,
          byteLength: read.totalBytes ?? bytes.byteLength,
          filename: basename(reference.path),
          mediaType: inferMimeTypeFromFilename(reference.path),
        });
      }
      const path = yield* resolveToolPathForRequestContextResult({
        cwd: reference.cwd ?? this.dependencies.toolRoot,
        inputPath: reference.path,
        context: {
          sessionId: nativeSessionId(reference.threadId),
          safetyMode: starter.toolMode === "restricted" ? "restricted" : "trusted",
        },
      }).mapError(() => nativeFailure("forbidden", "File path is outside this thread's access"));
      const read = await this.dependencies.filesystem.readFileBytes({
        path,
        maxBytes: preview ? NATIVE_TEXT_PREVIEW_BYTES : RESOURCE_MAX_BYTES,
        ...(preview ? { prefixBytes: NATIVE_TEXT_PREVIEW_BYTES } : {}),
      });
      if (!read.success)
        return Result.err(nativeFailure("not-found", "File is missing or unreadable"));
      if (read.bytes.byteLength > RESOURCE_MAX_BYTES)
        return Result.err(nativeFailure("invalid", "File exceeds the preview size limit"));
      yield* this.dependencies.native.readPublishedPath(actorId, pathId);
      return Result.ok({
        bytes: read.bytes,
        byteLength: read.totalBytes ?? read.bytes.byteLength,
        filename: basename(reference.path),
        mediaType: inferMimeTypeFromFilename(reference.path),
      });
    }, this);
  }

  async handle(request: Request, actorId: string): Promise<Response | undefined> {
    const match = /^\/api\/files\/([^/]+)(\/preview)?$/u.exec(new URL(request.url).pathname);
    const pathId = match?.[1];
    if (pathId === undefined || request.method !== "GET") return undefined;
    const result = await this.read(actorId, pathId, request.signal, !!match?.[2]);
    if (match?.[2])
      return result
        .andThen((file) => textPreview(file.bytes, file.byteLength))
        .match({
          ok: (preview) =>
            Response.json(preview, {
              headers: {
                "Cache-Control": "private, no-store",
                "X-Content-Type-Options": "nosniff",
              },
            }),
          err: (error) =>
            Response.json(
              { error: error.message },
              {
                status: previewErrorStatus(error),
                headers: { "Cache-Control": "no-store" },
              },
            ),
        });
    return result.match({
      ok: (file) =>
        new Response(new Blob([Uint8Array.from(file.bytes)]), {
          headers: {
            "Content-Type": file.mediaType,
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "sandbox; default-src 'none'",
            "Content-Disposition": `${["image/png", "image/jpeg", "image/webp", "image/gif", "application/pdf", "text/plain", "application/json"].includes(file.mediaType) ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(file.filename).replaceAll("'", "%27")}`,
          },
        }),
      err: (error) =>
        Response.json(
          { error: "File is missing or unavailable" },
          {
            status: error._tag === "NativeStoreFailure" && error.code === "forbidden" ? 403 : 404,
            headers: { "Cache-Control": "no-store" },
          },
        ),
    });
  }
}

export function rewriteNativePublishedFileLinks(input: {
  text: string;
  threadId: string;
  actorId: string;
  cwd: string;
  register: (
    actorId: string,
    threadId: string,
    path: string,
    cwd?: string,
  ) => NativeFileResult<PublishedNativePath>;
}): NativeFileResult<string> {
  const links: { start: number; end: number; marker: number; path: string }[] = [];
  function inspect(node: Root | RootContent): void {
    if (node.type === "link" || node.type === "image") {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      const path = publishedFilesystemPath(node.url);
      if (start !== undefined && end !== undefined && path !== null) {
        const marker = input.text.slice(start, end).lastIndexOf("](");
        if (marker >= 0) links.push({ start, end, marker, path });
      }
    }
    if ("children" in node) for (const child of node.children) inspect(child);
  }
  inspect(fromMarkdown(input.text));
  return Result.gen(function* () {
    let text = input.text;
    for (const link of links.toReversed()) {
      const reference = yield* input.register(input.actorId, input.threadId, link.path, input.cwd);
      const prefix = input.text.slice(link.start, link.start + link.marker + 2);
      text = `${text.slice(0, link.start)}${prefix}/api/files/${reference.id})${text.slice(link.end)}`;
    }
    return Result.ok(text);
  });
}

function publishedFilesystemPath(url: string): string | null {
  if (url.startsWith("/") && !url.startsWith("//")) return url;
  if (url.startsWith("./") || url.startsWith("../")) return url;
  if (!url.startsWith("file://") || !URL.canParse(url)) return null;
  const parsed = new URL(url);
  if (parsed.hostname && parsed.hostname !== "localhost") return null;
  const decoded = Result.try({ try: () => decodeURIComponent(parsed.pathname), catch: () => null });
  return decoded.match({ ok: (path) => path, err: () => null });
}

function previewErrorStatus(error: NativeFileError): number {
  if (error._tag !== "NativeStoreFailure") return 503;
  switch (error.code) {
    case "forbidden":
      return 403;
    case "invalid":
      return 422;
    case "not-found":
      return 404;
    case "sqlite":
    case "conflict":
    case "stale":
      return 503;
  }
}
