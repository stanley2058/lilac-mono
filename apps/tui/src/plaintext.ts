import type { DisplayMessage, TurnSlot } from "@stanley2058/lilac-client-protocol";
import { stringWidth } from "bun";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function safeText(value: string): string {
  // Terminal sanitization must match raw ESC and control bytes before rendering untrusted text.
  /* oxlint-disable no-control-regex */
  return value
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\|$)/g, "")
    .replace(/\x1b[P^_X][\s\S]*?(?:\x1b\\|$)/g, "")
    .replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-_]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "")
    .replace(/[\u202a-\u202e\u2066-\u2069]/g, "");
  /* oxlint-enable no-control-regex */
}

export function messageText(message: DisplayMessage): string {
  const parts = message.parts.flatMap((part) => {
    switch (part.type) {
      case "text":
        return part.text;
      case "data-activity":
        return `[${part.data.state}] ${part.data.label}`;
      case "data-resource":
        return `[File: ${part.data.name}, ${part.data.state}${part.data.progress === undefined ? "" : ` ${Math.round(part.data.progress * 100)}%`}${part.data.error ? `, ${part.data.error}` : ""}]`;
      case "data-compaction":
        return `[Conversation compaction: ${part.data.state}]`;
      case "data-input-state":
        return `[${part.data.state}${part.data.reason ? `: ${part.data.reason}` : ""}]`;
      case "data-actions":
        return `[Actions available in web: ${part.data.actions.map((action) => action.label).join(", ")}]`;
      case "data-reactions":
        return part.data.items.map((reaction) => `${reaction.emoji} ${reaction.count}`).join(" ");
      case "data-workflow":
        // Workflow cards also carry a text summary, which the text part already shows.
        return [];
    }
  });
  return safeText(`${message.metadata?.authorId ?? message.role}:\n${parts.join("\n")}`);
}

/** A background job's wake runs with no message and appears only if the agent writes a reply. */
export function isHiddenSlot(slot: TurnSlot): boolean {
  return slot.kind === "ready" && slot.messages.length === 0;
}

export function slotText(slot: TurnSlot): string {
  if (slot.kind === "failed")
    return safeText(`History unavailable: ${slot.message}. :older retries.`);
  if (slot.kind === "deferred") return "Earlier turns are loading…";
  const footer = slot.partsCursor ? "\n:more loads the rest of this turn" : "";
  return `[Turn ${slot.turnId}${slot.state ? ` · ${slot.state}` : ""}]\n${slot.messages.map(messageText).join("\n\n")}${footer}`;
}

export function textWindow(
  text: string,
  width: number,
  height: number,
  offset: number,
): { lines: string[]; total: number; offset: number } {
  const columns = Math.max(8, width);
  const lines: string[] = [];
  for (const line of safeText(text).split("\n")) {
    let row = "";
    let cells = 0;
    for (const { segment } of graphemes.segment(line)) {
      const text = segment === "\t" ? " ".repeat(4 - (cells % 4)) : segment;
      const width = stringWidth(text);
      if (cells + width > columns && row) {
        lines.push(row);
        row = "";
        cells = 0;
      }
      row += text;
      cells += width;
    }
    lines.push(row);
  }
  const start = Math.max(0, Math.min(offset, Math.max(0, lines.length - height)));
  return { lines: lines.slice(start, start + height), total: lines.length, offset: start };
}
