import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { DisplayMessage, ReadyTurnSlot } from "@stanley2058/lilac-client-protocol";
import { partitionTurnMessages, workSegmentKeyForMessage } from "../src/turn-segments";
import { Turn } from "../src/components/Timeline";
import { MessageIdentityContext } from "../src/components/message-identity";
import { MessageServicesContext } from "../src/components/message-services";

const t0 = 1_760_000_000_000;

function toolMsg(id: string, label: string, offsetMs: number): DisplayMessage {
  return {
    id,
    role: "assistant",
    metadata: { authorId: "lilac", createdAt: t0 + offsetMs },
    parts: [
      { type: "data-activity", id: `${id}_act`, data: { kind: "tool", label, state: "complete" } },
    ],
  };
}

function commentaryMsg(id: string, text: string, offsetMs: number): DisplayMessage {
  return {
    id,
    role: "assistant",
    metadata: { authorId: "lilac", createdAt: t0 + offsetMs, phase: "commentary" },
    parts: [{ type: "text", text }],
  };
}

function finalMsg(id: string, text: string, offsetMs: number): DisplayMessage {
  return {
    id,
    role: "assistant",
    metadata: { authorId: "lilac", createdAt: t0 + offsetMs, phase: "final" },
    parts: [{ type: "text", text }],
  };
}

function resourceMsg(
  id: string,
  name: string,
  mediaType: string,
  offsetMs: number,
): DisplayMessage {
  return {
    id,
    role: "assistant",
    metadata: { authorId: "lilac", createdAt: t0 + offsetMs },
    parts: [
      {
        type: "data-resource",
        id: `${id}_res`,
        data: { resourceId: `${id}_res`, name, mediaType, size: 1024, state: "ready" },
      },
    ],
  };
}

function steerMsg(id: string, text: string, offsetMs: number, authorId = "user_1"): DisplayMessage {
  return {
    id,
    role: "user",
    metadata: { authorId, createdAt: t0 + offsetMs, inputMode: "steer" },
    parts: [{ type: "text", text }],
  };
}

describe("partitionTurnMessages", () => {
  test("hoists mid-work attachments to the bottom of the following final reply without splitting work", () => {
    const messages = [
      toolMsg("t1", "bash render.sh", 1_000),
      resourceMsg("r1", "lilac-en.wav", "audio/wav", 2_000),
      resourceMsg("r2", "lilac-ja.wav", "audio/wav", 2_500),
      toolMsg("t2", "bash rm -rf /tmp/render", 3_000),
      finalMsg("f1", "Both samples are attached.", 4_000),
    ];
    const segments = partitionTurnMessages(messages, { startedAt: t0, settledAt: t0 + 10_000 });
    expect(segments).toHaveLength(2);
    expect(segments[0]).toMatchObject({ kind: "work", workIndex: 0, durationMs: 10_000 });
    if (segments[0]?.kind === "work") {
      // Adjacent activities across the hoisted resources merge cleanly into one activity message.
      expect(segments[0].messages).toHaveLength(1);
      expect(segments[0].messages[0]?.parts).toHaveLength(2);
    }
    expect(segments[1]).toMatchObject({ kind: "visible", role: "assistant" });
    if (segments[1]?.kind === "visible") {
      expect(segments[1].messages.map((m) => m.id)).toEqual(["f1"]);
      expect(segments[1].trailingAttachments.get("f1")?.map((p) => p.data.name)).toEqual([
        "lilac-en.wav",
        "lilac-ja.wav",
      ]);
    }
  });

  test("keeps orphan attachments visible when no final reply follows before a steer or turn end", () => {
    const messages = [
      toolMsg("t1", "bash export.sh", 1_000),
      resourceMsg("r1", "a.wav", "audio/wav", 2_000),
      resourceMsg("r2", "b.wav", "audio/wav", 2_100),
      steerMsg("s1", "now convert them to mp3", 5_000),
      toolMsg("t2", "bash ffmpeg", 6_000),
      finalMsg("f2", "Converted.", 9_000),
    ];
    const segments = partitionTurnMessages(messages, { startedAt: t0, settledAt: t0 + 12_000 });
    expect(segments.map((s) => `${s.kind}:${s.kind === "visible" ? s.role : s.workIndex}`)).toEqual(
      ["work:0", "visible:assistant", "visible:user", "work:1", "visible:assistant"],
    );
    const orphan = segments[1];
    expect(orphan?.kind).toBe("visible");
    if (orphan?.kind === "visible") {
      expect(orphan.messages).toHaveLength(1);
      expect(
        orphan.messages[0]?.parts.map((p) => (p.type === "data-resource" ? p.data.name : "")),
      ).toEqual(["a.wav", "b.wav"]);
    }
  });

  test("attaches trailing resources emitted right after a final reply to that reply", () => {
    const messages = [
      toolMsg("t1", "bash build", 1_000),
      finalMsg("f1", "Here is the chart.", 3_000),
      resourceMsg("r1", "chart.png", "image/png", 3_500),
    ];
    const segments = partitionTurnMessages(messages, { startedAt: t0, settledAt: t0 + 5_000 });
    expect(segments).toHaveLength(2);
    expect(segments[1]?.kind).toBe("visible");
    if (segments[1]?.kind === "visible") {
      expect(segments[1].trailingAttachments.get("f1")?.map((p) => p.data.name)).toEqual([
        "chart.png",
      ]);
    }
  });

  test("preserves steer and in-flight final output followed by continued work and final reply", () => {
    const messages = [
      commentaryMsg("c1", "Checking quiet hours.", 1_000),
      toolMsg("t1", "bash check", 2_000),
      steerMsg("s1", "oh, and make it post only after 10AM", 40_000),
      finalMsg("f1", "Set up through the existing heartbeat agent.", 45_000),
      toolMsg("t2", "read config.ts", 50_000),
      finalMsg("f2", "Updated. The brief will post only after 10:00 AM.", 60_000),
    ];
    const segments = partitionTurnMessages(messages, { startedAt: t0, settledAt: t0 + 114_000 });
    expect(segments.map((s) => `${s.kind}:${s.kind === "visible" ? s.role : s.workIndex}`)).toEqual(
      ["work:0", "visible:user", "visible:assistant", "work:1", "visible:assistant"],
    );
    if (segments[0]?.kind === "work") expect(segments[0].durationMs).toBe(40_000);
    if (segments[3]?.kind === "work") expect(segments[3].durationMs).toBe(69_000);
    expect(workSegmentKeyForMessage(segments, "c1")).toBe(segments[0]?.key);
    expect(workSegmentKeyForMessage(segments, "t2")).toBe(segments[3]?.key);
    expect(workSegmentKeyForMessage(segments, "f1")).toBeUndefined();
  });

  test("binds hoisted attachments to the immediately following final reply when multiple finals sit adjacent", () => {
    const messages = [
      toolMsg("t1", "bash render.sh", 1_000),
      resourceMsg("r1", "first.wav", "audio/wav", 2_000),
      finalMsg("f1", "First reply with audio.", 3_000),
      finalMsg("f2", "Second follow-up note.", 4_000),
    ];
    const segments = partitionTurnMessages(messages, { startedAt: t0, settledAt: t0 + 5_000 });
    expect(segments).toHaveLength(2);
    const visible = segments[1];
    expect(visible?.kind).toBe("visible");
    if (visible?.kind === "visible") {
      expect(visible.trailingAttachments.get("f1")?.map((p) => p.data.name)).toEqual(["first.wav"]);
      expect(visible.trailingAttachments.get("f2")).toBeUndefined();
    }
  });

  test("preserves hoisted attachments on joined turns when bottom controls are hidden", () => {
    const slot: ReadyTurnSlot = {
      kind: "ready",
      slotId: "turn_joined",
      turnId: "turn_joined",
      position: 0,
      state: "complete",
      startedAt: t0,
      settledAt: t0 + 10_000,
      messages: [
        toolMsg("t1", "bash render", 1_000),
        resourceMsg("r1", "clip.wav", "audio/wav", 2_000),
        finalMsg("f1", "Attached clip.", 4_000),
      ],
    };
    const html = renderToStaticMarkup(
      <MessageIdentityContext
        value={{
          viewerId: "user_1",
          agent: { displayName: "Lilac" },
          users: new Map([["user_1", { displayName: "Stanley" }]]),
        }}
      >
        <MessageServicesContext
          value={{
            canEdit: true,
            resourceUrl: (id) => `/api/resources/${id}`,
            onAction: () => {},
            onReaction: () => {},
          }}
        >
          <Turn slot={slot} joinedAfter onRewind={() => {}} onLoadMore={() => {}} />
        </MessageServicesContext>
      </MessageIdentityContext>,
    );
    expect(html).toContain("Attached clip.");
    expect(html).toContain("clip.wav");
    expect(html).not.toContain('data-ui="message-controls"');
  });

  test("does not move a trailing attachment backward across a question card into an earlier final", () => {
    const questionMessage: DisplayMessage = {
      id: "q1",
      role: "assistant",
      metadata: { authorId: "lilac", createdAt: t0 + 3_000 },
      parts: [
        {
          type: "data-question",
          id: "q1_part",
          data: {
            questionCallId: "q1_call",
            requestId: "req_1",
            respondentId: "user_1",
            historyGeneration: 0,
            mode: "deferred",
            prompts: [
              {
                ordinal: 1,
                total: 1,
                header: "Voice",
                question: "Which clip?",
                options: [
                  { index: 1, label: "English", description: "English voice", token: "tok_1" },
                ],
                customToken: "custom_1",
              },
            ],
            view: {
              state: "pending",
              prompt: {
                ordinal: 1,
                total: 1,
                header: "Voice",
                question: "Which clip?",
                options: [
                  { index: 1, label: "English", description: "English voice", token: "tok_1" },
                ],
                customToken: "custom_1",
              },
            },
          },
        },
      ],
    };
    const messages = [
      finalMsg("f1", "Initial answer.", 1_000),
      questionMessage,
      resourceMsg("r1", "sample.wav", "audio/wav", 4_000),
    ];
    const segments = partitionTurnMessages(messages, { startedAt: t0, settledAt: t0 + 5_000 });
    expect(segments).toHaveLength(2);
    expect(segments[0]?.kind).toBe("visible");
    if (segments[0]?.kind === "visible") {
      expect(segments[0].messages.map((m) => m.id)).toEqual(["f1", "q1"]);
      expect(segments[0].trailingAttachments.size).toBe(0);
    }
    expect(segments[1]?.kind).toBe("visible");
    if (segments[1]?.kind === "visible") {
      expect(segments[1].messages.map((m) => m.id)).toEqual(["r1"]);
    }
  });
});
