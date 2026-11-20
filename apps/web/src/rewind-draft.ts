import { Result } from "better-result";
import type { DisplayPart } from "@stanley2058/lilac-client-protocol";
import { messageClipboard } from "./message-clipboard";
import { attempt } from "./components/ui";
import type { UploadPool } from "./uploads";

type RewindCallbacks = {
  rewind: () => Promise<{ text: string } | undefined>;
  onError: (message: string) => void;
};
export type PreparedRewind = (
  callbacks: RewindCallbacks,
) => Promise<{ text: string; attachments: string[] } | undefined>;
export type RewindAttempt = {
  target: string;
  draftKey?: string;
  owner: symbol;
  running: boolean;
  completed?: { text: string; attachments: string[] };
  prepared?: {
    request: {
      threadId: string;
      commandId: string;
      historyGeneration: number;
      expectedRevision: number;
      turnId: string;
    };
    finish: PreparedRewind;
  };
};

export async function prepareRewindDraft(options: {
  parts: readonly DisplayPart[];
  threadId: string;
  resourceUrl: (id: string) => string;
  pool: Pick<UploadPool, "add" | "get" | "signal">;
  onError: (message: string) => void;
}): Promise<PreparedRewind | undefined> {
  const resources = messageClipboard("", options.parts).resources;
  const prepared = await attempt(async () => {
    const { restoreMessageAttachments } = await import("./components/composer-editor");
    const downloads = await Promise.all(
      resources.map(async (resource) => {
        const local = options.pool
          .get(options.threadId)
          .find((attachment) => attachment.resourceId === resource.resourceId);
        if (local) return Result.ok<File | undefined>(local.file);
        const part = options.parts.find(
          (part) => part.type === "data-resource" && part.data.resourceId === resource.resourceId,
        );
        if (part?.type === "data-resource" && part.data.state !== "ready")
          return Result.ok<File | undefined>(undefined);
        const response = await fetch(options.resourceUrl(resource.resourceId), {
          signal: options.pool.signal,
        });
        if (!response.ok) return Result.err(`Could not restore attachment ${resource.name}`);
        return Result.ok(
          new File([await response.blob()], resource.name, { type: resource.mediaType }),
        );
      }),
    );
    const files = Result.all(downloads).match({
      ok: (value) => value,
      err: (message) => {
        options.onError(message);
        return undefined;
      },
    });
    if (!files) return;
    return { files, restoreMessageAttachments };
  }, options.onError);
  if (!prepared || options.pool.signal.aborted) return;
  return async (callbacks) => {
    // Keep the bytes before rewind releases the original turn's resource references.
    const reply = await callbacks.rewind();
    if (!reply || options.pool.signal.aborted) return;
    const restored = prepared.files.flatMap((file, index) =>
      file
        ? [
            {
              key: options.pool.add(options.threadId, file),
              resource: resources[index]!,
            },
          ]
        : [],
    );
    const missing = new Map(
      resources.flatMap((resource, index) =>
        prepared.files[index] ? [] : [[resource.resourceId, resource.name] as const],
      ),
    );
    const attachments = options.pool.get(options.threadId);
    if (missing.size)
      callbacks.onError(`Reattach missing files: ${[...missing.values()].join(", ")}`);
    return {
      text: resources.length
        ? prepared.restoreMessageAttachments(
            reply.text,
            new Map(
              restored.map(({ key, resource }) => [
                resource.resourceId,
                attachments.find((attachment) => attachment.key === key)!,
              ]),
            ),
            missing,
          )
        : reply.text,
      attachments: restored.map(({ key }) => key),
    };
  };
}

export async function rewindDraft(
  options: Parameters<typeof prepareRewindDraft>[0] & RewindCallbacks,
) {
  const prepared = await prepareRewindDraft(options);
  return prepared?.(options);
}
