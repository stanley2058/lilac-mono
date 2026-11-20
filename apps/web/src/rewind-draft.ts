import type { DisplayPart, NativeRpcOutputs } from "@stanley2058/lilac-client-protocol";
import { referencedAttachment } from "./attachment-reference";
import type { Attachment, UploadReference } from "./types";
import { attempt } from "./components/ui";
import type { UploadPool } from "./uploads";

type RewindCallbacks = {
  rewind: () => Promise<NativeRpcOutputs["threads"]["rewind"] | undefined>;
  onError: (message: string) => void;
};
type RestoredDraft = {
  text: string;
  attachments: string[];
  attachmentReferences?: UploadReference[];
};
export type PreparedRewind = (callbacks: RewindCallbacks) => Promise<RestoredDraft | undefined>;
export type RewindAttempt = {
  target: string;
  draftKey?: string;
  owner: symbol;
  running: boolean;
  completed?: RestoredDraft;
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
  pool: Pick<UploadPool, "add" | "signal"> & {
    get: (threadId: string) => readonly Attachment[];
  };
  onError: (message: string) => void;
}): Promise<PreparedRewind | undefined> {
  const resources = new Map(
    options.parts.flatMap((part) =>
      part.type === "data-resource" ? [[part.data.resourceId, part.data] as const] : [],
    ),
  );
  const editor = resources.size
    ? await attempt(() => import("./components/composer-editor"), options.onError)
    : undefined;
  if (options.pool.signal.aborted || (resources.size && !editor)) return;

  const localFiles = new Map(
    options.pool
      .get(options.threadId)
      .flatMap((attachment) =>
        attachment.resourceId && attachment.file
          ? [[attachment.resourceId, attachment.file] as const]
          : [],
      ),
  );
  return async (callbacks) => {
    const reply = await callbacks.rewind();
    if (!reply || options.pool.signal.aborted) return;
    const restored = new Map<string, Attachment>();
    const references: UploadReference[] = [];
    const missing = new Map<string, string>();
    for (const [id, resource] of resources) {
      const name = resource.name ?? "Attachment";
      if (resource.state === "ready") {
        const reference = {
          key: crypto.randomUUID(),
          resourceId: id,
          name,
          type: resource.mediaType ?? "application/octet-stream",
          size: resource.size,
        };
        references.push(reference);
        restored.set(id, referencedAttachment(reference));
        continue;
      }
      const file = localFiles.get(id);
      if (!file) {
        missing.set(id, name);
        continue;
      }
      const key = options.pool.add(options.threadId, file, reply.checkpoint.historyGeneration);
      const attachment = options.pool.get(options.threadId).find((item) => item.key === key);
      if (attachment) restored.set(id, attachment);
    }
    if (missing.size)
      callbacks.onError(`Reattach missing files: ${[...missing.values()].join(", ")}`);
    return {
      text: editor?.restoreMessageAttachments(reply.text, restored, missing) ?? reply.text,
      attachments: [...restored.values()].map((attachment) => attachment.key),
      ...(references.length ? { attachmentReferences: references } : {}),
    };
  };
}

export async function rewindDraft(
  options: Parameters<typeof prepareRewindDraft>[0] & RewindCallbacks,
) {
  const prepared = await prepareRewindDraft(options);
  return prepared?.(options);
}
