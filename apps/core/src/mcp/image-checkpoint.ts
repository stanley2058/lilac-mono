import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { constants } from "node:fs";

import type { ModelMessage } from "ai";
import type { StoredMessageV1 } from "@stanley2058/lilac-event-bus";
import { Result } from "better-result";
import { z } from "zod";

import { materializeStoredMessagesV1 } from "../transcript/stored-message-materialization";

export const mcpImageCheckpointReferenceSchema = z.strictObject({
  toolCallId: z.string().min(1),
  outputIndex: z.number().int().nonnegative().safe(),
  localPath: z.string().regex(/^\/[^\0]+$/u),
  mediaType: z.string().startsWith("image/"),
  byteLength: z.number().int().nonnegative().safe(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  filename: z.string().optional(),
});

export type McpImageCheckpointReference = z.output<typeof mcpImageCheckpointReferenceSchema>;

type ToolMessage = Extract<ModelMessage, { role: "tool" }>;
type ToolResult = Extract<ToolMessage["content"][number], { type: "tool-result" }>;
type ContentPart = Extract<ToolResult["output"], { type: "content" }>["value"][number];

function imageMarker(reference: McpImageCheckpointReference): string {
  return `MCP image saved locally: ${reference.localPath} (${reference.mediaType}, ${reference.byteLength} bytes).`;
}

function unavailableImageMarker(reference: McpImageCheckpointReference): string {
  return `${imageMarker(reference)} Image unavailable during recovery: the local file is missing, unreadable, or changed.`;
}

export function validMcpImageCheckpointReferences(input: {
  readonly messages: readonly StoredMessageV1[];
  readonly mcpImages?: readonly McpImageCheckpointReference[];
}): boolean {
  const keys = new Set<string>();
  for (const reference of input.mcpImages ?? []) {
    const key = JSON.stringify([reference.toolCallId, reference.outputIndex]);
    if (keys.has(key)) return false;
    keys.add(key);
    const matched = input.messages.some((message) => {
      if (typeof message.content === "string") return false;
      return message.content.some((part) => {
        if (part.type !== "tool-result" || part.toolCallId !== reference.toolCallId) return false;
        if (part.output.type !== "content") return false;
        const output = part.output.value[reference.outputIndex];
        return output?.type === "text" && output.text === imageMarker(reference);
      });
    });
    if (!matched) return false;
  }
  return true;
}

function matchesImage(part: ContentPart, reference: McpImageCheckpointReference): boolean {
  if (part.type === "text") {
    return part.text === imageMarker(reference) || part.text === unavailableImageMarker(reference);
  }
  if (part.type !== "file" || part.mediaType !== reference.mediaType || part.data.type !== "data") {
    return false;
  }
  const data = part.data.data;
  const bytes = typeof data === "string" ? Buffer.from(data, "base64") : new Uint8Array(data);
  return (
    bytes.byteLength === reference.byteLength &&
    createHash("sha256").update(bytes).digest("hex") === reference.sha256
  );
}

async function readCheckpointImage(reference: McpImageCheckpointReference): Promise<ContentPart> {
  const read = await Result.tryPromise({
    try: async () => {
      // A path replaced with a FIFO must not wait for a writer before stat rejects it.
      await using file = await fs.open(
        reference.localPath,
        constants.O_RDONLY | constants.O_NONBLOCK,
      );
      const stat = await file.stat();
      if (!stat.isFile() || stat.size !== reference.byteLength) return null;
      const bytes = Buffer.alloc(reference.byteLength);
      let offset = 0;
      while (offset < bytes.byteLength) {
        const read = await file.read(bytes, offset, bytes.byteLength - offset, offset);
        if (read.bytesRead === 0) return null;
        offset += read.bytesRead;
      }
      const tail = await file.read(Buffer.alloc(1), 0, 1, offset);
      if (tail.bytesRead !== 0) return null;
      if (createHash("sha256").update(bytes).digest("hex") !== reference.sha256) return null;
      return bytes.toString("base64");
    },
    catch: () => null,
  });
  const data = read.match({ ok: (value) => value, err: () => null });
  if (data === null) return { type: "text", text: unavailableImageMarker(reference) };
  return {
    type: "file",
    data: { type: "data", data },
    mediaType: reference.mediaType,
    ...(reference.filename === undefined ? {} : { filename: reference.filename }),
  };
}

function mapToolResults(
  message: ModelMessage,
  transform: (part: ToolResult) => ToolResult,
): ModelMessage {
  if (message.role === "tool") {
    return {
      ...message,
      content: message.content.map((part) =>
        part.type === "tool-result" ? transform(part) : part,
      ),
    };
  }
  if (message.role === "assistant" && typeof message.content !== "string") {
    return {
      ...message,
      content: message.content.map((part) =>
        part.type === "tool-result" ? transform(part) : part,
      ),
    };
  }
  return message;
}

export class McpImageCheckpointRegistry {
  readonly #references = new Map<string, Map<number, McpImageCheckpointReference>>();

  remember(reference: McpImageCheckpointReference): void {
    let call = this.#references.get(reference.toolCallId);
    if (!call) {
      call = new Map();
      this.#references.set(reference.toolCallId, call);
    }
    call.set(reference.outputIndex, reference);
  }

  project(messages: readonly ModelMessage[]): {
    messages: ModelMessage[];
    references: McpImageCheckpointReference[];
  } {
    const references = new Map<string, McpImageCheckpointReference>();
    const projected = messages.map((message): ModelMessage => {
      let changed = false;
      const candidate = mapToolResults(message, (part) => {
        if (part.output.type !== "content") return part;
        const call = this.#references.get(part.toolCallId);
        if (!call) return part;
        const value = part.output.value.map((output, index) => {
          const reference = call.get(index);
          if (!reference || !matchesImage(output, reference)) return output;
          references.set(JSON.stringify([reference.toolCallId, index]), reference);
          changed = true;
          return { type: "text" as const, text: imageMarker(reference) };
        });
        return { ...part, output: { ...part.output, value } };
      });
      return changed ? candidate : message;
    });
    return { messages: projected, references: [...references.values()] };
  }

  async restore(
    messages: readonly ModelMessage[],
    references: readonly McpImageCheckpointReference[],
  ): Promise<ModelMessage[]> {
    const replacements = new Map<
      string,
      Map<number, { reference: McpImageCheckpointReference; part: ContentPart }>
    >();
    for (const reference of references) {
      this.remember(reference);
      let call = replacements.get(reference.toolCallId);
      if (!call) {
        call = new Map();
        replacements.set(reference.toolCallId, call);
      }
      call.set(reference.outputIndex, { reference, part: await readCheckpointImage(reference) });
    }
    return messages.map((message) =>
      mapToolResults(message, (part) => {
        if (part.output.type !== "content") return part;
        const call = replacements.get(part.toolCallId);
        if (!call) return part;
        const value = part.output.value.map((output, index) => {
          const replacement = call.get(index);
          if (
            output.type !== "text" ||
            !replacement ||
            output.text !== imageMarker(replacement.reference)
          )
            return output;
          return replacement.part;
        });
        return { ...part, output: { ...part.output, value } };
      }),
    );
  }
}

export async function materializeMcpImageCheckpoint(
  input: Parameters<typeof materializeStoredMessagesV1>[0] & {
    readonly mcpImages?: readonly McpImageCheckpointReference[];
    readonly imageRegistry: McpImageCheckpointRegistry;
  },
): ReturnType<typeof materializeStoredMessagesV1> {
  if (!input.mcpImages?.length) return materializeStoredMessagesV1(input);
  return Result.gen(async function* () {
    const messages = yield* Result.await(
      materializeStoredMessagesV1({ ...input, identityProjection: undefined }),
    );
    const restored = await input.imageRegistry.restore(messages, input.mcpImages ?? []);
    const imageCalls = new Set(input.mcpImages?.map((image) => image.toolCallId));
    const retainedMessages: ModelMessage[] = [];
    const retainedStoredMessages: StoredMessageV1[] = [];
    for (const [index, message] of restored.entries()) {
      const hasImage =
        typeof message.content !== "string" &&
        message.content.some(
          (part) => part.type === "tool-result" && imageCalls.has(part.toolCallId),
        );
      // Image results must upload normally if this recovered run later writes its final transcript.
      if (hasImage) continue;
      retainedMessages.push(message);
      retainedStoredMessages.push(input.messages[index]!);
    }
    if (input.identityProjection) {
      yield* input.identityProjection.remember(retainedMessages, retainedStoredMessages);
    }
    return Result.ok(restored);
  });
}
