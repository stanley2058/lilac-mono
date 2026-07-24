import { describe, expect, it } from "bun:test";
import type { UIMessageChunk } from "ai";

import {
  RGBA,
  type CapturedSpan,
  type ScrollBoxRenderable,
  type TextareaRenderable,
} from "@opentui/core";
import { testRender } from "@opentui/solid";
import { Show, createSignal } from "solid-js";
import {
  MiniLilacTransport,
  type MiniLilacSessionSnapshot,
  type MiniLilacTodoState,
  type MiniLilacUIMessage,
} from "@stanley2058/mini-lilac-client";

import { MiniLilacApp, formatRunDuration } from "./app";
import type { SessionBindings } from "./controller";
import { COLORS } from "./theme";

const snapshot: MiniLilacSessionSnapshot = {
  id: "session-1",
  activeRunId: null,
  status: "idle",
  cwd: "/workspace",
  model: "test/model",
  profile: "coding",
  reasoning: "low",
  title: "Click test",
  inputTokens: 23_700,
  contextWindow: 400_000,
  queuedSteeringCount: 0,
};

async function renderApp(
  messages: readonly MiniLilacUIMessage[],
  transport = new MiniLilacTransport({ cwd: "/workspace" }),
  width = 90,
  cwd = "/workspace",
  onNewSession: (bindings: SessionBindings) => Promise<void> = async () => {},
  initialTodos: MiniLilacTodoState = { revision: 0, todos: [] },
  initialSnapshot: MiniLilacSessionSnapshot = { ...snapshot, cwd },
  height = 30,
) {
  return testRender(
    () => (
      <MiniLilacApp
        transport={transport}
        cwd={cwd}
        sessionId="session-1"
        model="test/model"
        profile="coding"
        reasoning="low"
        models={[]}
        profiles={[{ id: "coding", label: "Coding", subagentOnly: false }]}
        initialSnapshot={initialSnapshot}
        initialMessages={messages}
        initialTodos={initialTodos}
        onNewSession={onNewSession}
        onSessionSelect={async () => {}}
        onExit={() => {}}
      />
    ),
    { width, height },
  );
}

async function clickRenderedText(
  app: Awaited<ReturnType<typeof renderApp>>,
  text: string,
): Promise<void> {
  await app.flush();
  const { x, y } = renderedTextPosition(app, text);
  await app.mockMouse.click(x, y);
  await app.flush();
}

function renderedTextPosition(
  app: Awaited<ReturnType<typeof renderApp>>,
  text: string,
): { x: number; y: number } {
  const rows = app.captureCharFrame().split("\n");
  const y = rows.findIndex((row) => row.includes(text));
  expect(y).toBeGreaterThanOrEqual(0);
  const x = rows[y]?.indexOf(text) ?? -1;
  expect(x).toBeGreaterThanOrEqual(0);
  return { x, y };
}

function renderedSpan(app: Awaited<ReturnType<typeof renderApp>>, text: string): CapturedSpan {
  const span = app
    .captureSpans()
    .lines.flatMap((line) => line.spans)
    .find((candidate) => candidate.text.includes(text));
  if (span === undefined) throw new Error(`Could not find rendered span containing ${text}`);
  return span;
}

function subagentMessagesResponse(): Response {
  return new Response(
    JSON.stringify([
      {
        id: "child-prompt",
        role: "user",
        parts: [{ type: "text", text: "Inspect the routing flow" }],
      },
      {
        id: "child-message",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolName: "read_file",
            toolCallId: "read-1",
            state: "output-available",
            input: { path: "/workspace/first.ts" },
            output: "first",
          },
          {
            type: "dynamic-tool",
            toolName: "read_file",
            toolCallId: "read-2",
            state: "output-available",
            input: { path: "/workspace/second.ts" },
            output: "second",
          },
          { type: "text", text: "Read-only child result" },
        ],
      },
    ]),
    { headers: { "Content-Type": "application/json" } },
  );
}

describe("MiniLilacApp tool interactions", () => {
  it("formats completed run durations", () => {
    expect(formatRunDuration(12 * 60_000 + 32_000)).toBe("12m 32s");
    expect(formatRunDuration(3_500)).toBe("3s");
  });

  it("opens a subagent block as a read-only transcript and returns with escape", async () => {
    const fetchMock = Object.assign(
      async (input: string | URL | Request) => {
        if (String(input).includes("/messages")) return subagentMessagesResponse();
        if (String(input).includes("/sessions/child-session-1")) {
          return new Response(
            JSON.stringify({
              ...snapshot,
              id: "child-session-1",
              activeRunId: null,
              status: "idle",
              profile: "explore",
            }),
            { headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(null, { status: 204 });
      },
      { preconnect() {} },
    );
    const transport = new MiniLilacTransport({
      baseUrl: "/mini",
      cwd: "/workspace",
      fetch: fetchMock,
    });
    const messages: MiniLilacUIMessage[] = [
      {
        id: "assistant-subagent",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolName: "subagent_delegate",
            toolCallId: "delegate-1",
            state: "output-available",
            input: { profile: "explore", prompt: "Inspect the routing flow", mode: "sync" },
            output: {
              status: "completed",
              childRunId: "child-1",
              childSessionId: "child-session-1",
              sessionName: "routing",
              profile: "explore",
              text: "Read-only child result",
            },
          },
          {
            type: "data-subagentStatus",
            id: "child-1",
            data: {
              toolCallId: "delegate-1",
              runId: "child-1",
              sessionId: "child-session-1",
              sessionName: "routing",
              profile: "explore",
              prompt: "Inspect the routing flow",
              mode: "sync",
              state: "completed",
              toolCount: 2,
              text: "Read-only child result",
            },
          },
        ],
      },
    ];
    const app = await renderApp(messages, transport);
    try {
      await clickRenderedText(app, "✓ Explore Task");
      await Bun.sleep(100);
      await app.flush();
      await app.waitForFrame((frame) => frame.includes("Read-only child result"));
      const childFrame = app.captureCharFrame();
      expect(childFrame).toContain("explore subagent");
      expect(childFrame).toContain("2 reads");
      expect(childFrame).toContain("read-only");
      expect(childFrame).toContain("esc parent");
      expect(childFrame).not.toContain("Ask anything...");

      app.mockInput.pressEscape();
      await Bun.sleep(20);
      await app.flush();
      const parentFrame = app.captureCharFrame();
      expect(parentFrame).toContain("✓ Explore Task");
      expect(parentFrame).toContain("Ask anything...");
    } finally {
      app.renderer.destroy();
    }
  });

  it("opens a subagent at the bottom and restores the parent scroll offset", async () => {
    const fetchMock = Object.assign(
      async (input: string | URL | Request) => {
        if (String(input).includes("/messages")) {
          return new Response(
            JSON.stringify(
              Array.from({ length: 30 }, (_, index) => ({
                id: `child-${index}`,
                role: "user",
                parts: [
                  {
                    type: "text",
                    text: index === 29 ? "CHILD TAIL" : `Child history ${index + 1}`,
                  },
                ],
              })),
            ),
            { headers: { "Content-Type": "application/json" } },
          );
        }
        if (String(input).includes("/sessions/child-scroll")) {
          return new Response(
            JSON.stringify({
              ...snapshot,
              id: "child-scroll",
              activeRunId: null,
              status: "idle",
              profile: "explore",
            }),
            { headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(null, { status: 204 });
      },
      { preconnect() {} },
    );
    const transport = new MiniLilacTransport({
      baseUrl: "/mini",
      cwd: "/workspace",
      fetch: fetchMock,
    });
    const parentMessages: MiniLilacUIMessage[] = [
      ...Array.from({ length: 12 }, (_, index) => ({
        id: `parent-${index}`,
        role: "user" as const,
        parts: [{ type: "text" as const, text: `Parent history ${index + 1}` }],
      })),
      {
        id: "assistant-subagent-scroll",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolName: "subagent_delegate",
            toolCallId: "delegate-scroll",
            state: "output-available",
            input: {
              profile: "explore",
              prompt: "Inspect deeply",
              mode: "sync",
              sessionName: "scroll-test",
            },
            output: {
              status: "completed",
              childRunId: "child-run-scroll",
              childSessionId: "child-scroll",
              sessionName: "scroll-test",
              profile: "explore",
              text: "CHILD TAIL",
            },
          },
        ],
      },
    ];
    const app = await renderApp(parentMessages, transport);
    try {
      await app.flush();
      const transcript = app.renderer.root.findDescendantById(
        "transcript-scrollbox",
      ) as ScrollBoxRenderable;
      transcript.scrollTo(Math.max(0, transcript.scrollHeight - transcript.height - 2));
      await app.flush();
      const parentScrollTop = transcript.scrollTop;
      expect(parentScrollTop).toBeGreaterThan(0);

      await clickRenderedText(app, "Explore Task");
      await Bun.sleep(30);
      await app.flush();
      expect(app.captureCharFrame()).toContain("CHILD TAIL");
      expect(transcript.scrollTop).toBeGreaterThan(0);
      expect(
        transcript.scrollHeight - transcript.height - transcript.scrollTop,
      ).toBeLessThanOrEqual(1);

      app.mockInput.pressEscape();
      await Bun.sleep(20);
      await app.flush();
      expect(transcript.scrollTop).toBe(parentScrollTop);
    } finally {
      app.renderer.destroy();
    }
  });

  it("floats the current todo, expands four nearby items, and opens the complete menu", async () => {
    const initialTodos: MiniLilacTodoState = {
      revision: 6,
      todos: [
        { content: "Oldest", status: "completed", priority: "low" },
        { content: "Previous", status: "completed", priority: "medium" },
        { content: "Current", status: "in_progress", priority: "high" },
        { content: "Next", status: "pending", priority: "high" },
        { content: "Later", status: "pending", priority: "medium" },
        { content: "Dropped", status: "cancelled", priority: "low" },
      ],
    };
    const app = await renderApp(
      [],
      new MiniLilacTransport({ cwd: "/workspace" }),
      130,
      "/workspace",
      async () => {},
      initialTodos,
    );
    try {
      await app.flush();
      const compact = app.captureCharFrame();
      expect(compact).toContain("[•] Current");
      expect(compact).toContain("(2 completed; 2 coming)");
      expect(compact).not.toContain("Oldest");
      expect(compact).not.toContain("Previous");
      expect(compact).not.toContain("Next");
      expect(compact).not.toContain("Later");
      expect(compact).not.toContain("Dropped");
      expect(renderedSpan(app, "[•] ").fg.equals(RGBA.fromHex(COLORS.warning))).toBe(true);

      await clickRenderedText(app, "[•] Current");
      const expanded = app.captureCharFrame();
      expect(expanded).toContain("[✓] Previous");
      expect(expanded).toContain("[•] Current");
      expect(expanded).toContain("[ ] Next");
      expect(expanded).toContain("[ ] Later");
      expect(expanded).not.toContain("Oldest");
      expect(expanded).not.toContain("Dropped");

      await clickRenderedText(app, "[•] Current");
      expect(app.captureCharFrame()).not.toContain("[✓] Previous");

      app.mockInput.pressKey("/");
      await app.mockInput.typeText("todo");
      app.mockInput.pressEnter();
      await app.waitForFrame((frame) => frame.includes("[-] Dropped"));
      const menu = app.captureCharFrame();
      for (const content of ["Oldest", "Previous", "Current", "Next", "Later", "Dropped"]) {
        expect(menu).toContain(content);
      }
      expect(menu).toContain("↑/↓ browse | type search | esc close");

      app.mockInput.pressEnter();
      await app.flush();
      expect(app.captureCharFrame()).not.toContain("[-] Dropped");
      expect(app.captureCharFrame()).toContain("[•] Current");
    } finally {
      app.renderer.destroy();
    }
  });

  it("keeps counts visible while truncating the floating todo on narrow terminals", async () => {
    const initialTodos: MiniLilacTodoState = {
      revision: 3,
      todos: [
        { content: "Previous", status: "completed", priority: "low" },
        {
          content: "Current todo content that must truncate",
          status: "in_progress",
          priority: "high",
        },
        { content: "Next", status: "pending", priority: "medium" },
      ],
    };
    const app = await renderApp(
      [],
      new MiniLilacTransport({ cwd: "/workspace" }),
      50,
      "/workspace",
      async () => {},
      initialTodos,
    );
    try {
      await app.flush();
      const frame = app.captureCharFrame();
      const todoLine = frame.split("\n").find((line) => line.includes("[•]"));
      expect(todoLine).toContain("...");
      expect(todoLine).toContain("(1 completed; 1 coming)");
      expect(frame).toContain("Ask anything...");
      expect(frame.split("\n").filter((line) => line.includes("[•]"))).toHaveLength(1);
      expect(renderedTextPosition(app, "[•]").y).toBeLessThan(
        renderedTextPosition(app, "Ask anything...").y,
      );
    } finally {
      app.renderer.destroy();
    }
  });

  it("renders a large paste as a bracketed attachment block", async () => {
    const app = await renderApp([]);
    try {
      await app.flush();
      await app.mockInput.pasteBracketedText("first line\nsecond line\nthird line");
      await app.flush();

      const paste = renderedSpan(app, "[Pasted ~3 lines]");
      expect(paste.fg.toInts()).toEqual(RGBA.fromHex(COLORS.selectedText).toInts());
      expect(paste.bg.toInts()).toEqual(RGBA.fromHex(COLORS.warning).toInts());
    } finally {
      app.renderer.destroy();
    }
  });

  it("renders a pasted image as a bracketed attachment block", async () => {
    const app = await renderApp([]);
    try {
      await app.flush();
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      app.renderer.stdin.emit(
        "data",
        Buffer.concat([Buffer.from("\x1b[200~"), png, Buffer.from("\x1b[201~")]),
      );
      await app.waitForFrame((frame) => frame.includes("[Image 1]"));

      const image = renderedSpan(app, "[Image 1]");
      expect(image.fg.toInts()).toEqual(RGBA.fromHex(COLORS.selectedText).toInts());
      expect(image.bg.toInts()).toEqual(RGBA.fromHex(COLORS.warning).toInts());
    } finally {
      app.renderer.destroy();
    }
  });

  it("renders edits as colored single-line cwd-relative summaries with front truncation", async () => {
    const cwd = "/home/stanley/Workspace/HackMD/hackmd-production-local/frontend/next-app";
    const patchText = [
      "*** Begin Patch",
      `*** Update File: ${cwd}/components/Community/Topic.tsx`,
      "@@",
      "-old one",
      "-old two",
      ...Array.from({ length: 32 }, (_, index) => `+new ${index}`),
      "*** End Patch",
    ].join("\n");
    const app = await renderApp(
      [
        {
          id: "assistant-edit-summary",
          role: "assistant",
          parts: [
            {
              type: "dynamic-tool",
              toolName: "apply_patch",
              toolCallId: "patch-summary-1",
              state: "output-available",
              input: { patchText },
              output: "Success",
            },
          ],
        },
      ],
      new MiniLilacTransport({ cwd }),
      40,
      cwd,
    );
    try {
      await app.flush();
      const editLines = app
        .captureCharFrame()
        .split("\n")
        .filter((line) => line.includes("Patch"));
      expect(editLines).toHaveLength(1);
      expect(editLines[0]).toContain("Patch ...");
      expect(editLines[0]).toContain("Community/Topic.tsx +32 -2");
      expect(editLines[0]).not.toContain(cwd);
      expect(renderedSpan(app, "Patch ").fg.equals(RGBA.fromHex(COLORS.tool))).toBe(true);
      expect(renderedSpan(app, "+32").fg.equals(RGBA.fromHex(COLORS.success))).toBe(true);
      expect(renderedSpan(app, "-2").fg.equals(RGBA.fromHex(COLORS.danger))).toBe(true);
    } finally {
      app.renderer.destroy();
    }
  });

  it("folds nearby edits and toggles their file details on click", async () => {
    const app = await renderApp([
      {
        id: "assistant-nearby-edits",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolName: "apply_patch",
            toolCallId: "patch-nearby-1",
            state: "output-available",
            input: {
              patchText:
                "*** Begin Patch\n*** Update File: /workspace/src/first.ts\n@@\n-old\n+new\n+next\n*** End Patch",
            },
            output: "Success",
          },
          {
            type: "dynamic-tool",
            toolName: "apply_patch",
            toolCallId: "patch-nearby-2",
            state: "output-available",
            input: {
              patchText:
                "*** Begin Patch\n*** Update File: /workspace/src/second.ts\n@@\n+added\n*** End Patch",
            },
            output: "Success",
          },
        ],
      },
    ]);
    try {
      await app.flush();
      expect(app.captureCharFrame()).toContain("Patch 2 files");
      expect(app.captureCharFrame()).toContain("expand");
      expect(app.captureCharFrame()).not.toContain("src/first.ts");
      expect(renderedSpan(app, "Patch").fg.equals(RGBA.fromHex(COLORS.tool))).toBe(true);
      expect(renderedSpan(app, "2 files").fg.equals(RGBA.fromHex(COLORS.muted))).toBe(true);

      await clickRenderedText(app, "Patch 2 files");
      expect(app.captureCharFrame()).toContain("Patch src/first.ts +2 -1");
      expect(app.captureCharFrame()).toContain("Patch src/second.ts +1");
      expect(app.captureCharFrame()).toContain("collapse");
      expect(renderedSpan(app, "+2").fg.equals(RGBA.fromHex(COLORS.success))).toBe(true);
      expect(renderedSpan(app, "-1").fg.equals(RGBA.fromHex(COLORS.danger))).toBe(true);

      await clickRenderedText(app, "src/first.ts");
      expect(app.captureCharFrame()).toContain("Patch 2 files");
      expect(app.captureCharFrame()).not.toContain("src/first.ts");
    } finally {
      app.renderer.destroy();
    }
  });

  it("closes an empty command palette with backspace", async () => {
    const app = await renderApp([]);
    try {
      await app.flush();
      app.mockInput.pressKey("/");
      await app.flush();
      expect(app.captureCharFrame()).toContain("start a new session");
      expect(app.captureCharFrame()).toContain("compact session context");
      expect(app.captureCharFrame()).toContain("↑/↓ select | type search | enter confirm");
      expect(app.captureCharFrame()).not.toContain("ctrl-n/p");
      expect(renderedSpan(app, "/compact").fg.equals(RGBA.fromHex(COLORS.warning))).toBe(true);
      expect(renderedSpan(app, "/model").fg.equals(RGBA.fromHex(COLORS.model))).toBe(true);
      expect(renderedSpan(app, "/todo").fg.equals(RGBA.fromHex(COLORS.accent))).toBe(true);

      app.mockInput.pressBackspace();
      await app.flush();
      expect(app.captureCharFrame()).not.toContain("compact session context");
      expect(app.captureCharFrame()).toContain("Ask anything...");
    } finally {
      app.renderer.destroy();
    }
  });

  it("starts a new session with the current bindings", async () => {
    const requests: SessionBindings[] = [];
    const app = await renderApp(
      [],
      new MiniLilacTransport({ cwd: "/workspace" }),
      90,
      "/workspace",
      async (bindings) => {
        requests.push(bindings);
      },
    );
    try {
      await app.flush();
      app.mockInput.pressKey("/");
      await app.mockInput.typeText("new");
      app.mockInput.pressEnter();
      await app.flush();

      expect(requests).toEqual([{ model: "test/model", profile: "coding", reasoning: "low" }]);
    } finally {
      app.renderer.destroy();
    }
  });

  it("focuses the new session composer after /new", async () => {
    const transport = new MiniLilacTransport({ cwd: "/workspace" });
    const app = await testRender(
      () => {
        const [sessionId, setSessionId] = createSignal("session-1");
        return (
          <Show when={sessionId()} keyed>
            {(id) => (
              <MiniLilacApp
                transport={transport}
                cwd="/workspace"
                sessionId={id}
                model="test/model"
                profile="coding"
                reasoning="low"
                models={[]}
                profiles={[{ id: "coding", label: "Coding", subagentOnly: false }]}
                initialSnapshot={id === "session-1" ? snapshot : undefined}
                initialMessages={[]}
                initialTodos={{ revision: 0, todos: [] }}
                onNewSession={async () => {
                  setSessionId("session-2");
                }}
                onSessionSelect={async () => {}}
                onExit={() => {}}
              />
            )}
          </Show>
        );
      },
      { width: 90, height: 30 },
    );
    try {
      await app.flush();
      app.mockInput.pressKey("/");
      await app.mockInput.typeText("new");
      app.mockInput.pressEnter();
      await app.flush();

      const composer = app.renderer.root.findDescendantById("composer") as TextareaRenderable;
      expect(composer.focused).toBe(true);
      await app.mockInput.typeText("next prompt");
      expect(composer.plainText).toBe("next prompt");
    } finally {
      app.renderer.destroy();
    }
  });

  it("redirects an unbound key to an unfocused composer", async () => {
    const app = await renderApp([]);
    try {
      await app.flush();
      const composer = app.renderer.root.findDescendantById("composer") as TextareaRenderable;
      composer.blur();
      expect(composer.focused).toBe(false);

      app.mockInput.pressKey("x");
      await app.flush();

      expect(composer.focused).toBe(true);
      expect(composer.plainText).toBe("x");
    } finally {
      app.renderer.destroy();
    }
  });

  it("renders markdown tables with visible borders", async () => {
    const app = await renderApp([
      {
        id: "assistant-table",
        role: "assistant",
        parts: [
          {
            type: "text",
            text: [
              "| Interaction | Current event |",
              "| --- | --- |",
              "| Open Community Home | user_view_community_home |",
            ].join("\n"),
          },
        ],
      },
    ]);
    try {
      await app.flush();
      const frame = app.captureCharFrame();

      expect(frame).toContain("┌");
      expect(frame).toContain("│Interaction");
      expect(frame).toContain("├");
      expect(frame).toContain("┘");
    } finally {
      app.renderer.destroy();
    }
  });

  it("gives session titles a flexible two-line area without showing UUIDs", async () => {
    const sessionId = "269c8f51-11d2-430b-9993-1a97974c2d4a";
    const title = Array.from(
      { length: 12 },
      (_, index) => `TITLE${String(index + 1).padStart(2, "0")}`,
    ).join(" ");
    const calls: string[] = [];
    const fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        calls.push(String(input));
        return Response.json([
          {
            id: sessionId,
            activeRunId: null,
            status: "idle",
            cwd: "/workspace",
            model: "test/model",
            profile: "coding",
            reasoning: "low",
            title,
            queuedSteeringCount: 0,
            updatedAt: "2026-07-22T11:39:57.491Z",
          },
        ]);
      },
      { preconnect() {} },
    );
    const app = await renderApp(
      [],
      new MiniLilacTransport({ cwd: "/workspace", baseUrl: "/mini", fetch }),
    );
    try {
      await app.flush();
      app.mockInput.pressKey("/");
      await app.mockInput.typeText("session");
      app.mockInput.pressEnter();
      await app.waitForFrame((frame) => frame.includes("TITLE01"));

      const frame = app.captureCharFrame();
      const titleLines = frame.split("\n").filter((line) => /TITLE\d{2}/u.test(line));
      expect(titleLines).toHaveLength(2);
      expect(frame).toContain("TITLE09");
      expect(frame).not.toContain("TITLE12");
      expect(frame).toContain("idle | 2026-07-22T11:39:57.491Z");
      expect(frame).not.toContain(sessionId);
      expect(calls).toEqual(["/mini/sessions?cwd=%2Fworkspace"]);
    } finally {
      app.renderer.destroy();
    }
  });

  it("separates shell and generic tool surfaces and moves metadata below the composer", async () => {
    const app = await renderApp([
      {
        id: "assistant-surfaces",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolName: "bash",
            toolCallId: "bash-surfaces-1",
            state: "output-available",
            input: { command: "bun test" },
            output: { stdout: "pass", stderr: "", exitCode: 0 },
          },
          {
            type: "dynamic-tool",
            toolName: "webfetch",
            toolCallId: "fetch-surfaces-1",
            state: "output-available",
            input: { url: "https://example.test" },
            output: {},
          },
          {
            type: "dynamic-tool",
            toolName: "deploy_preview",
            toolCallId: "generic-surfaces-1",
            state: "output-available",
            input: {},
            output: {},
          },
        ],
      },
    ]);
    try {
      await app.flush();
      expect(renderedSpan(app, "Click test").bg.equals(RGBA.fromHex(COLORS.background))).toBe(true);
      expect(renderedSpan(app, "$ bun test").bg.equals(RGBA.fromHex(COLORS.raised))).toBe(true);
      const tool = renderedSpan(app, "Fetch https://example.test");
      expect(tool.fg.equals(RGBA.fromHex(COLORS.tool))).toBe(true);
      expect(tool.bg.equals(RGBA.fromHex(COLORS.toolBackground))).toBe(true);
      const genericTool = renderedSpan(app, "Deploy Preview");
      expect(genericTool.fg.equals(RGBA.fromHex(COLORS.tool))).toBe(true);
      expect(genericTool.bg.equals(RGBA.fromHex(COLORS.toolBackground))).toBe(true);
      expect(app.captureCharFrame()).toContain("coding | test/model | low | 23.7K (6%)");
      expect(renderedTextPosition(app, "Click test").y).toBeGreaterThan(
        renderedTextPosition(app, "Ask anything...").y,
      );
      expect(renderedTextPosition(app, "coding").y).toBe(
        renderedTextPosition(app, "Click test").y + 1,
      );
      expect(renderedSpan(app, "coding").fg.equals(RGBA.fromHex(COLORS.accent))).toBe(true);
      expect(renderedSpan(app, "test/model").fg.equals(RGBA.fromHex(COLORS.model))).toBe(true);
      expect(renderedSpan(app, "low").fg.equals(RGBA.fromHex(COLORS.warning))).toBe(true);
    } finally {
      app.renderer.destroy();
    }
  });

  it("preserves the cwd suffix within thirty percent of the terminal width", async () => {
    const app = await renderApp(
      [],
      new MiniLilacTransport({ cwd: "/workspace" }),
      60,
      "/home/stanley/workspace/lilac-mono",
    );
    try {
      await app.flush();
      expect(app.captureCharFrame()).toContain("...pace/lilac-mono");
    } finally {
      app.renderer.destroy();
    }
  });

  it("searches skills and inserts an explicit skill token", async () => {
    const calls: string[] = [];
    const fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        calls.push(String(input));
        return Response.json([
          { name: "frontend-design", description: "Build deliberate terminal interfaces" },
        ]);
      },
      { preconnect() {} },
    );
    const app = await renderApp(
      [],
      new MiniLilacTransport({ cwd: "/workspace", baseUrl: "/mini", fetch }),
    );
    try {
      await app.flush();
      app.mockInput.pressKey("/");
      await app.flush();
      await app.mockInput.typeText("skills");
      app.mockInput.pressEnter();
      await app.waitForFrame((frame) => frame.includes("frontend-design"));
      app.mockInput.pressEnter();
      await app.waitForFrame((frame) => frame.includes("@skills:frontend-design"));
      expect(calls).toEqual(["/mini/skills?cwd=%2Fworkspace&profile=coding"]);
    } finally {
      app.renderer.destroy();
    }
  });

  it("expands a shell block when its rendered text is clicked", async () => {
    const output = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n");
    const app = await renderApp([
      {
        id: "assistant-shell",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolName: "bash",
            toolCallId: "bash-1",
            state: "output-available",
            input: { command: "bun test" },
            output: { stdout: output, stderr: "", exitCode: 0 },
          },
        ],
      },
    ]);
    try {
      await app.flush();
      expect(app.captureCharFrame()).toContain("Click to expand");
      await clickRenderedText(app, "$ bun test");
      expect(app.captureCharFrame()).toContain("Click to collapse");
    } finally {
      app.renderer.destroy();
    }
  });

  it("caps collapsed shell output height and restores it after expansion", async () => {
    const output = Array.from(
      { length: 14 },
      (_, index) => `line ${index + 1} ${"detail ".repeat(16)}`,
    ).join("\n");
    const app = await renderApp([
      {
        id: "assistant-shell-height",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolName: "bash",
            toolCallId: "bash-height-1",
            state: "output-available",
            input: { command: "docker system df -v" },
            output: { stdout: output, stderr: "", exitCode: 0 },
          },
          {
            type: "dynamic-tool",
            toolName: "deploy_preview",
            toolCallId: "after-shell-height",
            state: "output-available",
            input: {},
            output: {},
          },
        ],
      },
    ]);
    try {
      await app.flush();
      const initialCommandY = renderedTextPosition(app, "$ docker system df -v").y;
      const initialNextY = renderedTextPosition(app, "Deploy Preview").y;
      expect(initialNextY - initialCommandY).toBeLessThanOrEqual(13);

      await clickRenderedText(app, "$ docker system df -v");
      await clickRenderedText(app, "Click to collapse");
      expect(renderedTextPosition(app, "Deploy Preview").y).toBe(initialNextY);
    } finally {
      app.renderer.destroy();
    }
  });

  it("marks running and completed shell commands independently of color", async () => {
    const app = await renderApp([
      {
        id: "assistant-shell-states",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolName: "bash",
            toolCallId: "bash-complete",
            state: "output-available",
            input: { command: "df -h" },
            output: { stdout: "done", stderr: "", exitCode: 0 },
          },
          {
            type: "dynamic-tool",
            toolName: "bash",
            toolCallId: "bash-running",
            state: "input-available",
            input: { command: "du -x -h /" },
          },
          {
            type: "dynamic-tool",
            toolName: "deploy_preview",
            toolCallId: "tool-running",
            state: "input-available",
            input: {},
          },
          {
            type: "dynamic-tool",
            toolName: "skill",
            toolCallId: "tool-complete",
            state: "output-available",
            input: { name: "frontend-design" },
            output: {},
          },
        ],
      },
    ]);
    try {
      await app.flush();
      const frame = app.captureCharFrame();
      expect(frame).toContain("✓ $ df -h");
      expect(frame).toContain("● $ du -x -h /");
      expect(frame).toContain("● Deploy Preview");
      expect(frame).toContain("✓ Loaded skill frontend-design");
      expect(renderedSpan(app, "✓ ").fg.equals(RGBA.fromHex(COLORS.success))).toBe(true);
      expect(renderedSpan(app, "● ").fg.equals(RGBA.fromHex(COLORS.accent))).toBe(true);
    } finally {
      app.renderer.destroy();
    }
  });

  it("keeps a stationary session status row across idle and active states", async () => {
    const idleApp = await renderApp([]);
    let idleComposerY: number;
    try {
      await idleApp.flush();
      expect(idleApp.captureCharFrame()).toContain("▣ Ready");
      idleComposerY = renderedTextPosition(idleApp, "Ask anything...").y;
    } finally {
      idleApp.renderer.destroy();
    }

    const fetch = Object.assign(async () => await new Promise<Response>(() => {}), {
      preconnect() {},
    });
    const activeSnapshot = {
      ...snapshot,
      activeRunId: "run-active",
      status: "streaming" as const,
      queuedSteeringCount: 2,
    };
    const app = await renderApp(
      [],
      new MiniLilacTransport({ cwd: "/workspace", baseUrl: "/mini", fetch }),
      90,
      "/workspace",
      async () => {},
      { revision: 0, todos: [] },
      activeSnapshot,
    );
    try {
      await app.flush();
      const frame = app.captureCharFrame();
      expect(frame).toMatch(/[·▪■▣] \S+\.\.\. 0s/u);
      expect(frame).toContain("2 queued / esc interrupt");
      expect(renderedTextPosition(app, "2 queued / esc interrupt").y).toBeLessThan(
        renderedTextPosition(app, "Steer the active run...").y,
      );
      expect(renderedTextPosition(app, "Steer the active run...").y).toBe(idleComposerY);
      expect(frame).not.toContain("working / esc interrupt");
    } finally {
      app.renderer.destroy();
    }
  });

  it("pins a capped steering queue above the composer until messages commit", async () => {
    const steering = ["first queued", "second queued", "third queued", "fourth queued"].map(
      (text, index) => ({
        id: `steering-${index + 1}`,
        role: "user" as const,
        parts: [{ type: "text" as const, text }],
      }),
    );
    class QueuedSteeringTransport extends MiniLilacTransport {
      streamController: ReadableStreamDefaultController<UIMessageChunk> | undefined;

      override async reconnectToStream() {
        return new ReadableStream<UIMessageChunk>({
          start: (controller) => {
            this.streamController = controller;
            steering.forEach((message) => {
              controller.enqueue({ type: "data-steering", id: message.id, data: message });
            });
          },
        });
      }
    }

    const activeSnapshot = {
      ...snapshot,
      activeRunId: "run-steering",
      status: "streaming" as const,
      queuedSteeringCount: steering.length,
    };
    const transport = new QueuedSteeringTransport({ cwd: "/workspace" });
    const app = await renderApp(
      [{ id: "root", role: "user", parts: [{ type: "text", text: "root prompt" }] }],
      transport,
      90,
      "/workspace",
      async () => {},
      { revision: 0, todos: [] },
      activeSnapshot,
    );
    try {
      await app.waitForFrame((frame) => frame.includes("+1 more queued"));
      const queuedFrame = app.captureCharFrame();
      expect(queuedFrame).toContain("first queued");
      expect(queuedFrame).toContain("third queued");
      expect(queuedFrame).not.toContain("fourth queued");
      expect(renderedTextPosition(app, "4 messages · send in order").y).toBeGreaterThan(
        renderedTextPosition(app, "root prompt").y,
      );
      expect(renderedTextPosition(app, "4 messages · send in order").y).toBeLessThan(
        renderedTextPosition(app, "Steer the active run...").y,
      );

      const committed = steering[0];
      if (committed === undefined) throw new Error("expected steering fixture");
      transport.streamController?.enqueue({
        type: "data-steeringCommitted",
        id: committed.id,
        data: committed,
      });
      await app.waitForFrame((frame) => !frame.includes("+1 more queued"));
      expect(renderedTextPosition(app, "first queued").y).toBeLessThan(
        renderedTextPosition(app, "3 messages · send in order").y,
      );
    } finally {
      app.renderer.destroy();
    }

    const narrowApp = await renderApp(
      [],
      new QueuedSteeringTransport({ cwd: "/workspace" }),
      50,
      "/workspace",
      async () => {},
      { revision: 0, todos: [] },
      activeSnapshot,
    );
    try {
      await narrowApp.waitForFrame((frame) => frame.includes("first queued"));
      const narrowFrame = narrowApp.captureCharFrame();
      expect(narrowFrame).toContain("first queued");
      expect(narrowFrame).not.toContain("second queued");
      expect(narrowFrame).not.toContain("more queued");
    } finally {
      narrowApp.renderer.destroy();
    }

    const shortApp = await renderApp(
      [],
      new QueuedSteeringTransport({ cwd: "/workspace" }),
      90,
      "/workspace",
      async () => {},
      { revision: 0, todos: [] },
      activeSnapshot,
      12,
    );
    try {
      await shortApp.waitForFrame((frame) => frame.includes("first queued"));
      const shortFrame = shortApp.captureCharFrame();
      expect(shortFrame).toContain("first queued");
      expect(shortFrame).toContain("Steer the active run...");
      expect(shortFrame).not.toContain("second queued");
    } finally {
      shortApp.renderer.destroy();
    }
  });

  it("keeps the completed run duration in the ready status", async () => {
    class FinishedRunTransport extends MiniLilacTransport {
      override async reconnectToStream() {
        return null;
      }

      override async getMessages() {
        return [];
      }
    }

    const activeSnapshot = {
      ...snapshot,
      activeRunId: "run-finished",
      status: "streaming" as const,
    };
    const app = await renderApp(
      [],
      new FinishedRunTransport({ cwd: "/workspace" }),
      90,
      "/workspace",
      async () => {},
      { revision: 0, todos: [] },
      activeSnapshot,
    );
    try {
      await app.waitForFrame((frame) => frame.includes("▣ Ready · Ran for 0s"));
      expect(app.captureCharFrame()).toContain("▣ Ready · Ran for 0s");
    } finally {
      app.renderer.destroy();
    }
  });

  it("expands exploration when its rendered text is clicked", async () => {
    const app = await renderApp([
      {
        id: "assistant-explore",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolName: "read_file",
            toolCallId: "read-1",
            state: "output-available",
            input: { path: "src/app.ts", maxLines: 12 },
            output: {},
          },
        ],
      },
    ]);
    try {
      await app.flush();
      expect(app.captureCharFrame()).not.toContain("src/app.ts · 12 lines");
      await clickRenderedText(app, "Explored");
      expect(app.captureCharFrame()).toContain("src/app.ts · 12 lines");
    } finally {
      app.renderer.destroy();
    }
  });

  it("does not expand a shell block when its text is selected", async () => {
    const output = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n");
    const app = await renderApp([
      {
        id: "assistant-shell-selection",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolName: "bash",
            toolCallId: "bash-selection-1",
            state: "output-available",
            input: { command: "bun test" },
            output: { stdout: output, stderr: "", exitCode: 0 },
          },
        ],
      },
    ]);
    try {
      await app.flush();
      const { x, y } = renderedTextPosition(app, "$ bun test");
      await app.mockMouse.drag(x, y, x + 5, y);
      await app.flush();
      expect(app.renderer.getSelection()?.getSelectedText()).toContain("$ bun");
      expect(app.captureCharFrame()).toContain("Click to expand");
    } finally {
      app.renderer.destroy();
    }
  });

  it("keeps web tool details on one truncated line", async () => {
    const url = "https://example.test/a/very/long/path/that/exceeds/the/terminal/width";
    const query = "current release notes for the runtime with all compatibility details";
    const app = await renderApp(
      [
        {
          id: "assistant-web-tools",
          role: "assistant",
          parts: [
            {
              type: "dynamic-tool",
              toolName: "webfetch",
              toolCallId: "fetch-1",
              state: "output-available",
              input: { url },
              output: {},
            },
            {
              type: "dynamic-tool",
              toolName: "websearch",
              toolCallId: "search-1",
              state: "output-available",
              input: {},
              output: { action: { type: "search", query } },
            },
          ],
        },
      ],
      new MiniLilacTransport({ cwd: "/workspace" }),
      44,
    );
    try {
      await app.flush();
      const frame = app.captureCharFrame();
      const fetchLine = frame.split("\n").find((line) => line.includes("Fetch https://"));
      const searchLine = frame.split("\n").find((line) => line.includes('Search "current'));
      expect(fetchLine).toContain("...");
      expect(fetchLine).not.toContain(url);
      expect(searchLine).toContain("...");
      expect(searchLine).not.toContain(query);
    } finally {
      app.renderer.destroy();
    }
  });
});
