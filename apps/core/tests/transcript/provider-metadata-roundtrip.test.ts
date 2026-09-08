import { describe, expect, it } from "bun:test";
import type { ModelMessage } from "ai";
import { openAIRequestCodec } from "@stanley2058/lilac-agent/adapters/openai-responses/input";
import { openAIResponseCodec } from "@stanley2058/lilac-agent/adapters/openai-responses/output";
import { createMemoryBlobStore } from "@stanley2058/lilac-blob-storage";
import type { Result } from "better-result";

import {
  materializeStoredMessagesV1,
  projectStoredMessagesV1,
} from "../../src/transcript/stored-message-materialization";
import {
  decodeTranscriptMessages,
  TRANSCRIPT_PERSISTENCE_SCHEMA_VERSION,
} from "../../src/transcript/transcript-persistence-codec";

function value<T, E>(result: Result<T, E>): T {
  if (result.status === "error") throw result.error;
  return result.value;
}

async function persistAndReplay(messages: ModelMessage[]): Promise<ModelMessage[]> {
  const snapshot = structuredClone(messages);
  const stored = value(projectStoredMessagesV1(messages));
  const decoded = value(
    decodeTranscriptMessages({
      raw: JSON.stringify(stored),
      schemaVersion: TRANSCRIPT_PERSISTENCE_SCHEMA_VERSION,
      recordId: "provider-metadata-roundtrip",
    }),
  );
  const blobStore = value(await createMemoryBlobStore());
  const replayed = value(await materializeStoredMessagesV1({ messages: decoded.value, blobStore }));
  value(await blobStore.close({ deadlineAtMs: Date.now() + 1_000 }));
  expect(replayed).toEqual(snapshot);
  expect(messages).toEqual(snapshot);
  return replayed;
}

describe("provider metadata durable roundtrip", () => {
  it("preserves OpenAI output identity, phase, encrypted reasoning and compaction on replay", async () => {
    const projected = value(
      openAIResponseCodec.project({
        id: "resp_metadata",
        status: "completed",
        output: [
          {
            type: "message",
            id: "msg_commentary",
            role: "assistant",
            status: "completed",
            phase: "commentary",
            content: [{ type: "output_text", text: "Checking", annotations: [] }],
          },
          {
            type: "message",
            id: "msg_final",
            role: "assistant",
            status: "completed",
            phase: "final_answer",
            content: [{ type: "output_text", text: "Done", annotations: [] }],
          },
          {
            type: "reasoning",
            id: "rs_encrypted",
            summary: [],
            encrypted_content: "encrypted-reasoning",
          },
          {
            type: "reasoning",
            id: "rs_null",
            summary: [],
            encrypted_content: null,
          },
          {
            type: "compaction",
            id: "cmp_metadata",
            encrypted_content: "encrypted-compaction",
          },
          {
            type: "function_call",
            id: "fc_metadata",
            call_id: "call_metadata",
            name: "read",
            arguments: '{"path":"notes.txt"}',
            status: "completed",
          },
        ],
      }),
    );
    expect(projected.assistant.content).toEqual([
      {
        type: "text",
        text: "Checking",
        providerOptions: { openai: { itemId: "msg_commentary", phase: "commentary" } },
      },
      {
        type: "text",
        text: "Done",
        providerOptions: { openai: { itemId: "msg_final", phase: "final_answer" } },
      },
      {
        type: "reasoning",
        text: "",
        providerOptions: {
          openai: { itemId: "rs_encrypted", reasoningEncryptedContent: "encrypted-reasoning" },
        },
      },
      {
        type: "reasoning",
        text: "",
        providerOptions: { openai: { itemId: "rs_null", reasoningEncryptedContent: null } },
      },
      {
        type: "custom",
        kind: "openai.compaction",
        providerOptions: {
          openai: {
            type: "compaction",
            itemId: "cmp_metadata",
            encryptedContent: "encrypted-compaction",
          },
        },
      },
      {
        type: "tool-call",
        toolCallId: "call_metadata",
        toolName: "read",
        input: { path: "notes.txt" },
        providerOptions: { openai: { itemId: "fc_metadata" } },
      },
    ]);

    const replayed = await persistAndReplay(projected.messages);
    const encoded = value(await openAIRequestCodec.messages(replayed));
    expect(encoded).toEqual([
      {
        type: "message",
        id: "msg_commentary",
        role: "assistant",
        status: "completed",
        phase: "commentary",
        content: [{ type: "output_text", text: "Checking", annotations: [] }],
      },
      {
        type: "message",
        id: "msg_final",
        role: "assistant",
        status: "completed",
        phase: "final_answer",
        content: [{ type: "output_text", text: "Done", annotations: [] }],
      },
      {
        type: "reasoning",
        id: "rs_encrypted",
        encrypted_content: "encrypted-reasoning",
        summary: [],
      },
      { type: "compaction", id: "cmp_metadata", encrypted_content: "encrypted-compaction" },
      {
        type: "function_call",
        id: "fc_metadata",
        call_id: "call_metadata",
        name: "read",
        arguments: '{"path":"notes.txt"}',
      },
    ]);
    expect(replayed).toEqual(projected.messages);
  });

  it("preserves tool content cache metadata and keeps foreign provider options out of OpenAI requests", async () => {
    const foreignOptions = {
      anthropic: {
        cacheControl: { type: "ephemeral" },
        promptCacheBreakpoint: { mode: "explicit" },
        itemId: "foreign-id",
        phase: "commentary",
      },
    };
    const messages: ModelMessage[] = [
      {
        role: "user",
        providerOptions: foreignOptions,
        content: [{ type: "text", text: "Read notes", providerOptions: foreignOptions }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Reading", providerOptions: foreignOptions }],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_metadata",
            toolName: "read",
            providerOptions: foreignOptions,
            output: {
              type: "content",
              value: [
                {
                  type: "text",
                  text: "cached notes",
                  providerOptions: {
                    ...foreignOptions,
                    openai: { promptCacheBreakpoint: { mode: "explicit" } },
                  },
                },
                { type: "text", text: "foreign cache", providerOptions: foreignOptions },
                { type: "text", text: "uncached notes" },
              ],
            },
          },
        ],
      },
    ];
    const replayed = await persistAndReplay(messages);
    const encoded = value(await openAIRequestCodec.messages(replayed));
    expect(encoded).toEqual([
      { role: "user", content: [{ type: "input_text", text: "Read notes" }] },
      { role: "assistant", content: "Reading", phase: undefined },
      {
        type: "function_call_output",
        call_id: "call_metadata",
        output: [
          {
            type: "input_text",
            text: "cached notes",
            prompt_cache_breakpoint: { mode: "explicit" },
          },
          { type: "input_text", text: "foreign cache" },
          { type: "input_text", text: "uncached notes" },
        ],
      },
    ]);
    expect(replayed).toEqual(messages);
  });
});

it("round-trips native tool-loading seeds and schema snapshots through the stored codec", async () => {
  const definition = {
    name: "mcp_echo",
    description: "Echo",
    inputSchemaJson: '{"type":"object","properties":{}}',
    strict: false,
  };
  const messages: ModelMessage[] = [
    {
      role: "user",
      content: "resume",
      providerOptions: { openai: { toolSearchSeed: [definition] } },
    },
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "search",
          toolName: "find_tools",
          input: { query: "echo" },
          providerOptions: { openai: { itemId: "search-item", toolSearchCall: true } },
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "search",
          toolName: "find_tools",
          output: { type: "json", value: { matches: [{ name: "mcp_echo" }] } },
          providerOptions: { openai: { toolSearchTools: [definition] } },
        },
      ],
    },
  ];
  const expected = value(await openAIRequestCodec.messages(messages, { nativeToolSearch: true }));
  const replayed = await persistAndReplay(messages);
  expect(value(await openAIRequestCodec.messages(replayed, { nativeToolSearch: true }))).toEqual(
    expected,
  );
  expect(expected.map((item) => item.type)).toEqual([
    "additional_tools",
    undefined,
    "tool_search_call",
    "tool_search_output",
  ]);
});
