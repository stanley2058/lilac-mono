import type { Client } from "discord.js";
import { type Result as ResultType } from "better-result";
import type { SurfaceAttachment } from "../../../../src/surface/types";

export function resultValue<T, E>(result: ResultType<T, E>): T {
  if (result.status === "error") throw result.error;
  return result.value;
}

export function createFakeDiscordClient(opts?: {
  failEdit?: boolean;
  editFailure?: unknown;
  failEditWithFiles?: boolean;
  sendFailure?: unknown;
  failSendAt?: number;
  failReplyAt?: number;
  replyFailure?: unknown;
  failResumeFetch?: boolean;
  resumeFetchFailure?: unknown;
  onEdit?: (options: unknown) => void;
  guildPremiumTier?: number;
}): {
  client: Client;
  createdMessageIds: string[];
  deletedMessageIds: string[];
  operations: Array<{
    kind: "send" | "reply" | "edit";
    messageId: string;
    parentId?: string;
    options: unknown;
  }>;
} {
  type RecordedOp = {
    kind: "send" | "reply" | "edit";
    messageId: string;
    parentId?: string;
    options: unknown;
  };

  type FakeMessage = {
    readonly id: string;
    readonly channelId: string;
    readonly attachments: Map<string, { id: string }>;
    edit(options: unknown): Promise<FakeMessage>;
    reply(options: unknown): Promise<FakeMessage>;
    delete(): Promise<void>;
  };

  const operations: RecordedOp[] = [];
  const deletedMessageIds: string[] = [];
  const createdMessageIds: string[] = [];
  const messages = new Map<string, FakeMessage>();
  let nextMessageId = 1;
  let nextAttachmentId = 1;
  let replyAttempts = 0;
  let sendAttempts = 0;
  const channelId = "chan";

  const fileCountFromOptions = (options: unknown): number => {
    if (!options || typeof options !== "object") return 0;
    const files = (options as { files?: unknown }).files;
    if (!Array.isArray(files)) return 0;
    return files.length;
  };

  const keepAttachmentIdsFromOptions = (options: unknown): Set<string> | null => {
    if (!options || typeof options !== "object") return null;
    const raw = (options as { attachments?: unknown }).attachments;
    if (!Array.isArray(raw)) return null;

    const keep = new Set<string>();
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const id = (item as { id?: unknown }).id;
      if (typeof id === "string") keep.add(id);
    }
    return keep;
  };

  const appendNewAttachments = (message: FakeMessage, count: number): void => {
    for (let i = 0; i < count; i++) {
      const id = `att_${nextAttachmentId++}`;
      message.attachments.set(id, { id });
    }
  };

  const applyEditAttachments = (message: FakeMessage, options: unknown): void => {
    const keep = keepAttachmentIdsFromOptions(options);
    if (keep) {
      const idsToDelete: string[] = [];
      for (const id of message.attachments.keys()) {
        if (!keep.has(id)) {
          idsToDelete.push(id);
        }
      }
      for (const id of idsToDelete) {
        message.attachments.delete(id);
      }
    }

    const newFileCount = fileCountFromOptions(options);
    appendNewAttachments(message, newFileCount);
  };

  const createMessage = (params?: {
    operation: "send" | "reply";
    options: unknown;
    parentId?: string;
  }): FakeMessage => {
    const id = `m_${nextMessageId++}`;
    createdMessageIds.push(id);

    const attachments = new Map<string, { id: string }>();

    const message: FakeMessage = {
      id,
      channelId,
      attachments,
      edit: async (options) => {
        operations.push({ kind: "edit", messageId: id, options });
        opts?.onEdit?.(options);
        if (opts?.editFailure) throw opts.editFailure;
        if (opts?.failEdit) throw new Error("edit failed");
        if (opts?.failEditWithFiles && fileCountFromOptions(options) > 0) {
          throw new Error("edit failed");
        }
        applyEditAttachments(message, options);
        return message;
      },
      reply: async (options) => {
        replyAttempts += 1;
        if (replyAttempts === opts?.failReplyAt) {
          throw opts.replyFailure ?? new Error("reply failed");
        }
        return createMessage({ operation: "reply", parentId: id, options });
      },
      delete: async () => {
        deletedMessageIds.push(id);
        messages.delete(id);
      },
    };

    if (params) {
      operations.push({
        kind: params.operation,
        messageId: id,
        parentId: params.parentId,
        options: params.options,
      });
      appendNewAttachments(message, fileCountFromOptions(params.options));
    }

    messages.set(id, message);
    return message;
  };

  const channel = {
    ...(opts?.guildPremiumTier === undefined
      ? {}
      : { guild: { premiumTier: opts.guildPremiumTier } }),
    send: async (options: unknown) => {
      if (opts?.sendFailure) throw opts.sendFailure;
      sendAttempts += 1;
      if (sendAttempts === opts?.failSendAt) {
        throw Object.assign(new Error("send unavailable"), { status: 503 });
      }
      return createMessage({ operation: "send", options });
    },
    messages: {
      fetch: async (messageId: string) => {
        if (opts?.resumeFetchFailure) throw opts.resumeFetchFailure;
        if (opts?.failResumeFetch) throw new Error("resume fetch failed");
        return messages.get(messageId) ?? null;
      },
    },
  };

  const client = {
    channels: {
      fetch: async (id: string) => (id === channelId ? channel : null),
    },
  };

  return {
    client: client as unknown as Client,
    createdMessageIds,
    deletedMessageIds,
    operations,
  };
}

export function hasFiles(options: unknown): boolean {
  if (!options || typeof options !== "object") return false;
  const files = (options as { files?: unknown }).files;
  return Array.isArray(files) && files.length > 0;
}

export function contentFromOptions(options: unknown): string | undefined {
  if (!options || typeof options !== "object") return undefined;
  const content = (options as { content?: unknown }).content;
  return typeof content === "string" ? content : undefined;
}

export function hasEmbeds(options: unknown): boolean {
  if (!options || typeof options !== "object") return false;
  const embeds = (options as { embeds?: unknown }).embeds;
  return Array.isArray(embeds) && embeds.length > 0;
}

export function embedDescriptionsFromOptions(options: unknown): string[] {
  if (!options || typeof options !== "object") return [];
  const embeds = (options as { embeds?: unknown }).embeds;
  if (!Array.isArray(embeds)) return [];

  return embeds.flatMap((embed) => {
    let serialized: unknown = embed;
    if (embed && typeof embed === "object") {
      const toJSON = (embed as { toJSON?: unknown }).toJSON;
      if (typeof toJSON === "function") serialized = toJSON.call(embed);
    }
    if (!serialized || typeof serialized !== "object") return [];
    const description = (serialized as { description?: unknown }).description;
    return typeof description === "string" ? [description] : [];
  });
}

export function embedFieldValuesFromOptions(options: unknown): string[] {
  if (!options || typeof options !== "object") return [];
  const embeds = (options as { embeds?: unknown }).embeds;
  if (!Array.isArray(embeds)) return [];

  const values: string[] = [];
  for (const embed of embeds) {
    let serialized: unknown = embed;
    if (embed && typeof embed === "object") {
      const toJSON = (embed as { toJSON?: unknown }).toJSON;
      if (typeof toJSON === "function") {
        serialized = toJSON.call(embed);
      }
    }

    if (!serialized || typeof serialized !== "object") continue;
    const fields = (serialized as { fields?: unknown }).fields;
    if (!Array.isArray(fields)) continue;

    for (const field of fields) {
      if (!field || typeof field !== "object") continue;
      const value = (field as { value?: unknown }).value;
      if (typeof value === "string") values.push(value);
    }
  }

  return values;
}

export function filesCount(options: unknown): number {
  if (!options || typeof options !== "object") return 0;
  const files = (options as { files?: unknown }).files;
  return Array.isArray(files) ? files.length : 0;
}

export function uploadedFileNames(options: unknown): string[] {
  if (!options || typeof options !== "object") return [];
  const files = (options as { files?: unknown }).files;
  if (!Array.isArray(files)) return [];

  const names: string[] = [];
  for (const file of files) {
    if (!file || typeof file !== "object") continue;
    const name = (file as { name?: unknown }).name;
    if (typeof name === "string") names.push(name);
  }
  return names;
}

export function allUploadedFileNames(
  operations: ReadonlyArray<{
    kind: "send" | "reply" | "edit";
    options: unknown;
  }>,
): string[] {
  return operations
    .filter((op) => hasFiles(op.options))
    .flatMap((op) => uploadedFileNames(op.options));
}

export function makeAttachment(index: number): SurfaceAttachment {
  return {
    kind: "image",
    mimeType: "image/png",
    filename: `image-${index}.png`,
    bytes: new Uint8Array([index]),
  };
}
