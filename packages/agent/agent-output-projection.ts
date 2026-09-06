import type { ToolSet } from "ai";
import type { AgentOutput } from "./agent-adapter";
import type { AgentAssistantMessageEvent } from "./agent-runtime-support";

export function projectAgentOutput(output: AgentOutput): AgentAssistantMessageEvent<ToolSet> {
  const providerMetadata =
    output.messagePhase === undefined
      ? output.providerOptions
      : {
          ...output.providerOptions,
          openai: { ...output.providerOptions?.openai, phase: output.messagePhase },
        };
  const metadata = providerMetadata === undefined ? {} : { providerMetadata };
  switch (output.kind) {
    case "text":
      switch (output.phase) {
        case "start":
          return {
            type: "text_start",
            id: output.id,
            raw: { type: "text-start", id: output.id, ...metadata },
          };
        case "delta":
          return {
            type: "text_delta",
            id: output.id,
            delta: output.delta ?? "",
            raw: { type: "text-delta", id: output.id, text: output.delta ?? "", ...metadata },
          };
        case "end":
          return {
            type: "text_end",
            id: output.id,
            raw: { type: "text-end", id: output.id, ...metadata },
          };
      }
    case "reasoning":
      switch (output.phase) {
        case "start":
          return {
            type: "thinking_start",
            id: output.id,
            raw: { type: "reasoning-start", id: output.id, ...metadata },
          };
        case "delta":
          return {
            type: "thinking_delta",
            id: output.id,
            delta: output.delta ?? "",
            raw: { type: "reasoning-delta", id: output.id, text: output.delta ?? "", ...metadata },
          };
        case "end":
          return {
            type: "thinking_end",
            id: output.id,
            raw: { type: "reasoning-end", id: output.id, ...metadata },
          };
      }
    case "tool-input":
      switch (output.phase) {
        case "start":
          return {
            type: "toolcall_start",
            toolCallId: output.id,
            toolName: output.toolName ?? "",
            raw: {
              type: "tool-input-start",
              id: output.id,
              toolName: output.toolName ?? "",
              ...metadata,
            },
          };
        case "delta":
          return {
            type: "toolcall_delta",
            toolCallId: output.id,
            delta: output.delta ?? "",
            raw: {
              type: "tool-input-delta",
              id: output.id,
              delta: output.delta ?? "",
              ...metadata,
            },
          };
        case "end":
          return {
            type: "toolcall_end",
            toolCallId: output.id,
            raw: { type: "tool-input-end", id: output.id, ...metadata },
          };
      }
  }
}
