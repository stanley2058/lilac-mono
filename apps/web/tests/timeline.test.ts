import { describe, expect, it } from "bun:test";
import type {
  DisplayMessage,
  DisplayPart,
  ReadyTurnSlot,
  TurnSlot,
} from "@stanley2058/lilac-client-protocol";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { aroundTurnGap, loadTurnGap, unloadedPlace } from "../src/turn-gap";
import { MessageServicesContext } from "../src/components/message-services";
import {
  Message,
  Turn,
  groupActivityMessages,
  groupParts,
  messageArrivalIds,
} from "../src/components/Timeline";
import {
  Activity,
  ActivityItem,
  ActivitySourceContext,
  LiveTailContext,
  RequestActiveContext,
} from "../src/components/ActivityLog";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { activityTextOptions } from "../src/queries";

function activity(id: string): DisplayMessage {
  return {
    id,
    role: "assistant",
    parts: [{ type: "data-activity", id, data: { kind: "tool", label: id, state: "complete" } }],
  };
}
describe("native conversation grouping", () => {
  it("folds adjacent work across published messages while commentary keeps separate blocks", () => {
    const commentary: DisplayMessage = {
      id: "commentary",
      role: "assistant",
      metadata: { phase: "commentary" },
      parts: [{ type: "text", text: "Checking the result." }],
    };
    const messages = [activity("tool1"), activity("tool2"), commentary, activity("tool3")];
    const grouped = groupActivityMessages(messages);
    expect(grouped).toHaveLength(3);
    expect(grouped[0]?.parts).toHaveLength(2);
    expect(grouped[1]).toBe(commentary);
    expect(grouped[2]?.parts).toHaveLength(1);
    expect(messages[0]?.parts).toHaveLength(1);
  });
  it("joins adjacent publication fragments before rendering Markdown", () => {
    const parts: DisplayPart[] = [
      { type: "text", text: "```ts\nconst x =" },
      { type: "text", text: " 1;\n```" },
      {
        type: "data-activity",
        id: "tool",
        data: { kind: "tool", label: "Checked", state: "complete" },
      },
      { type: "text", text: "Done." },
    ];
    expect(groupParts(parts)).toEqual([
      { kind: "text", text: "```ts\nconst x = 1;\n```" },
      {
        kind: "activity",
        parts: [
          {
            type: "data-activity",
            id: "tool",
            data: { kind: "tool", label: "Checked", state: "complete" },
          },
        ],
      },
      { kind: "text", text: "Done." },
    ]);
  });
});

describe("native turn activity disclosure", () => {
  const parts: Extract<DisplayPart, { type: "data-activity" }>[] = [
    {
      type: "data-activity",
      id: "thinking",
      data: { kind: "thinking", label: "Thinking", state: "complete", detail: "Reasoning detail" },
    },
    {
      type: "data-activity",
      id: "tool",
      data: {
        kind: "tool",
        label: "bash ls -la",
        state: "complete",
        detail: "bash ls -la",
        output: "total 0",
        exitCode: 0,
        durationMs: 2200,
      },
    },
  ];
  it("summarizes several activities and keeps the group collapsed on initial render", () => {
    const html = renderToStaticMarkup(createElement(Activity, { parts }));
    expect(html).toContain("Ran 1 command");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("Reasoning detail");
    expect(html).not.toContain("total 0");
  });
  it("renders a single visible activity as its own row", () => {
    const empty = { ...parts[0]!, data: { ...parts[0]!.data, detail: undefined } };
    const html = renderToStaticMarkup(createElement(Activity, { parts: [empty, parts[1]!] }));
    expect(html).toContain("ls -la");
    expect(html).not.toContain("Ran 1 command");
    expect(html).not.toContain("Thought");
  });
  it("keeps each command result collapsed", () => {
    const html = renderToStaticMarkup(createElement(ActivityItem, { part: parts[1]! }));
    expect(html).toContain("ls -la");
    expect(html).not.toContain("bash ls");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("Process exited");
  });
  it("shows a running command by its program name", () => {
    const running = {
      ...parts[1]!,
      data: {
        ...parts[1]!.data,
        label: "bash cd /tmp && ./search.sh --since 1d",
        detail: "bash cd /tmp && ./search.sh --since 1d",
        state: "running" as const,
      },
    };
    const html = renderToStaticMarkup(createElement(Activity, { parts: [parts[0]!, running] }));
    expect(html).toContain("Running search.sh");
    expect(html).toContain("working-text");
  });
  it("keeps the Thinking fallback when a settled subagent ends a running turn", () => {
    const agent: (typeof parts)[number] = {
      type: "data-activity",
      id: "agent",
      data: { kind: "tool", label: "subagent (explore) Check hours", state: "complete" },
    };
    const html = renderToStaticMarkup(
      createElement(
        RequestActiveContext,
        { value: true },
        createElement(
          LiveTailContext,
          { value: "agent" },
          createElement(Activity, { parts: [parts[1]!, agent] }),
        ),
      ),
    );
    expect(html).toContain(
      '>Thinking<span aria-hidden="true" class="working-text-shine">Thinking</span>',
    );
  });
  it("marks failures on the icon without a badge", () => {
    const failed = {
      ...parts[1]!,
      data: {
        ...parts[1]!.data,
        state: "failed" as const,
        detail: undefined,
        output: undefined,
        exitCode: undefined,
      },
    };
    const html = renderToStaticMarkup(createElement(ActivityItem, { part: failed }));
    expect(html).toContain("text-danger");
    expect(html).not.toContain("<button");
  });
});

describe("activity text Core leaves out", () => {
  const source = { target: { kind: "thread" as const, threadId: "thread" }, turnId: "turn" };
  const part: Extract<DisplayPart, { type: "data-activity" }> = {
    type: "data-activity",
    id: "bash",
    data: {
      kind: "tool",
      label: "bash cat build.log",
      detail: "bash cat build.log",
      state: "complete",
      omitted: { output: 900 },
    },
  };
  const opened = (client: QueryClient) =>
    renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client },
        createElement(
          ActivitySourceContext,
          { value: source },
          createElement(ActivityItem, { part, open: true }),
        ),
      ),
    );
  it("keeps a row expandable when only its output was left out", () => {
    const html = renderToStaticMarkup(createElement(ActivityItem, { part }));
    expect(html).toContain('aria-expanded="false"');
  });
  it("shows the loaded output, and says so when it cannot load", () => {
    const client = new QueryClient();
    expect(opened(client)).toContain("Details unavailable");
    client.setQueryData(activityTextOptions(undefined, source, part).queryKey, {
      detail: "bash cat build.log",
      output: "full build log",
    });
    const html = opened(client);
    expect(html).toContain("full build log");
    expect(html).not.toContain("Details unavailable");
  });
});

describe("unloaded turn messages", () => {
  const at = (...positions: number[]): DisplayMessage[] =>
    positions.map((position) => ({
      id: `m${position}`,
      role: "assistant",
      metadata: { position },
      parts: [],
    }));
  it("belong after the first message when the window skips messages after it", () => {
    expect(unloadedPlace(at(0, 7, 8))).toBe("after-first");
  });
  it("belong at the end when every message is present but the newest was cut", () => {
    expect(unloadedPlace(at(0, 1))).toBe("end");
  });
  it("belong at the top when the first message did not fit", () => {
    expect(unloadedPlace(at(9))).toBe("top");
  });
  it("hold back messages a page loaded into the gap until it closes", () => {
    const partial = at(0, 1, 2, 3, 9, 10);
    const ids = (messages: readonly DisplayMessage[]) => messages.map((message) => message.id);
    expect(ids(aroundTurnGap(partial, () => true))).toEqual(["m0", "m9", "m10"]);
    expect(ids(aroundTurnGap(partial, () => false))).toEqual(["m9", "m10"]);
    expect(unloadedPlace(partial)).toBe("after-first");
    const closed = at(0, 1, 2, 3);
    expect(aroundTurnGap(closed, () => true)).toBe(closed);
  });
  it("render the load button below the prompt and above the messages after the gap", () => {
    const slot: ReadyTurnSlot = {
      kind: "ready",
      slotId: "turn",
      turnId: "turn",
      position: 0,
      state: "complete",
      partsCursor: "p_1_0",
      messages: [
        {
          id: "m0",
          role: "assistant",
          metadata: { position: 0 },
          parts: [{ type: "text", text: "First reply" }],
        },
        {
          id: "m1",
          role: "assistant",
          metadata: { position: 1 },
          parts: [{ type: "text", text: "Paged reply" }],
        },
        {
          id: "m9",
          role: "assistant",
          metadata: { position: 9, phase: "final" },
          parts: [{ type: "text", text: "Newest reply" }],
        },
      ],
    };
    const html = renderToStaticMarkup(
      createElement(
        MessageServicesContext,
        {
          value: {
            canEdit: false,
            resourceUrl: () => "",
            onAction: () => {},
            onReaction: () => {},
          },
        },
        createElement(Turn, { slot, onRewind: () => {}, onLoadMore: () => {} }),
      ),
    );
    expect(html).not.toContain("First reply");
    expect(html).not.toContain("Paged reply");
    expect(html.indexOf("turn-load-more")).toBeLessThan(html.indexOf("Newest reply"));
    expect(html.indexOf("turn-load-more")).toBeGreaterThan(-1);
  });
});

describe("streaming block arrivals", () => {
  it("does not consume an empty placeholder before its first streamed text", () => {
    const message: DisplayMessage = {
      id: "stream",
      role: "assistant",
      parts: [{ type: "text", text: "" }],
    };
    expect(messageArrivalIds(message)).toEqual([]);
    message.parts[0] = { type: "text", text: "First token" };
    expect(messageArrivalIds(message)).toEqual(["stream:content:0"]);
  });
  it("keeps text tokens stable while identifying appended blocks", () => {
    const message: DisplayMessage = {
      id: "stream",
      role: "assistant",
      parts: [{ type: "text", text: "First" }],
    };
    const original = messageArrivalIds(message);
    message.parts[0] = { type: "text", text: "First block with more tokens" };
    expect(messageArrivalIds(message)).toEqual(original);
    message.parts.push(...activity("tool").parts, { type: "text", text: "Second block" });
    expect(messageArrivalIds(message)).toEqual([
      "stream:content:0",
      "activity:tool",
      "activity-item:tool",
      "stream:content:2",
    ]);
  });

  it("retains unique tool identities when adjacent work messages are grouped", () => {
    const grouped = groupActivityMessages([activity("first"), activity("second")]);
    expect(grouped.flatMap(messageArrivalIds)).toEqual([
      "activity:first",
      "activity-item:first",
      "activity:second",
      "activity-item:second",
    ]);
  });
});

it("caps user message previews before layout measurement without clamping assistant responses", () => {
  const render = (role: "user" | "assistant") =>
    renderToStaticMarkup(
      createElement(Message, {
        message: {
          id: "long",
          role,
          parts: [{ type: "text", text: "A long paragraph.\n\n".repeat(100) }],
        },
        canEdit: false,
        resourceUrl: (id) => id,
        onAction: () => {},
        onReaction: () => {},
      }),
    );
  expect(render("user")).toContain('data-collapsed="true"');
  expect(render("assistant")).toContain('data-collapsed="false"');
});

it("omits batch wrappers without losing their child tool calls", () => {
  const grouped = groupActivityMessages([activity("bash"), activity("batch"), activity("glob")]);
  expect(grouped).toHaveLength(1);
  expect(
    grouped[0]!.parts.map((part) => (part.type === "data-activity" ? part.data.label : "")),
  ).toEqual(["bash", "glob"]);
});

describe("loading a turn's missing messages", () => {
  const slot = (cursor: string | undefined, ...positions: number[]): TurnSlot => ({
    kind: "ready",
    slotId: "turn",
    turnId: "turn",
    position: 0,
    ...(cursor ? { partsCursor: cursor } : {}),
    messages: positions.map((position) => ({
      id: `m${position}`,
      role: "assistant",
      metadata: { position },
      parts: [],
    })),
  });
  it("keeps loading pages until the gap after the first message closes", async () => {
    const pages = [slot("p_4_0", 0, 1, 2, 3, 9), slot("p_9_1", 0, 1, 2, 3, 4, 5, 6, 7, 8, 9)];
    let current = slot("p_0_0", 0, 9);
    let loads = 0;
    await loadTurnGap(
      async () => {
        current = pages[loads++]!;
      },
      () => current,
    );
    expect(loads).toBe(2);
    expect(unloadedPlace((current as ReadyTurnSlot).messages)).toBe("end");
  });
  it("stops when a page leaves the cursor where it was", async () => {
    const current = slot("p_0_0", 0, 9);
    let loads = 0;
    await loadTurnGap(
      async () => {
        loads++;
      },
      () => current,
    );
    expect(loads).toBe(1);
  });
});
