import { describe, expect, it } from "bun:test";

import type { MiniLilacTodoState, MiniLilacUIMessage } from "@stanley2058/mini-lilac-client";

import {
  ChunkRenderer,
  explorationTranscriptText,
  groupNearbyEdits,
  isShellTranscriptCollapsible,
  renderInitialMessages,
  shellTranscriptText,
  type TranscriptEntry,
} from "./render";

function createRendererHarness() {
  let sequence = 0;
  let entries: TranscriptEntry[] = [];
  const renderer = new ChunkRenderer(
    {
      append: (entry) => {
        const id = `entry-${sequence++}`;
        entries = [...entries, { id, ...entry }];
        return id;
      },
      update: (id, next) => {
        entries = entries.map((entry) => (entry.id === id ? { id, ...next } : entry));
      },
      appendText: (id, delta) => {
        entries = entries.map((entry) =>
          entry.id === id ? { ...entry, text: entry.text + delta } : entry,
        );
      },
      finish: (id) => {
        entries = entries.map((entry) =>
          entry.id === id ? { ...entry, streaming: false } : entry,
        );
      },
    },
    { onSnapshot: () => {}, onTranscriptReset: () => {} },
  );
  return { renderer, entries: () => entries };
}

function transcriptSemantics(entries: readonly TranscriptEntry[]) {
  return entries.map(({ kind, tone, text }) => ({ kind, tone, text }));
}

describe("renderInitialMessages", () => {
  it("renders canonical startup messages into semantic transcript entries", () => {
    const messages: MiniLilacUIMessage[] = [
      { id: "user-1", role: "user", parts: [{ type: "text", text: "Existing prompt" }] },
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          { type: "reasoning", text: "private chain", state: "done" },
          { type: "text", text: "Existing answer", state: "done" },
        ],
      },
    ];

    expect(renderInitialMessages(messages)).toEqual([
      {
        id: "message:user-1:0",
        kind: "user",
        tone: "accent",
        text: "Existing prompt",
      },
      {
        id: "message:assistant-1:0",
        kind: "reasoning",
        tone: "muted",
        text: "Thought\nprivate chain",
      },
      {
        id: "message:assistant-1:1",
        kind: "assistant",
        tone: "normal",
        text: "Existing answer",
      },
    ]);
  });

  it("coalesces streamed text deltas into one assistant output entry", () => {
    let sequence = 0;
    let entries: TranscriptEntry[] = [];
    const renderer = new ChunkRenderer(
      {
        append: (entry) => {
          const id = `entry-${sequence}`;
          sequence += 1;
          entries = [...entries, { id, ...entry }];
          return id;
        },
        update: (id, next) => {
          entries = entries.map((entry) => (entry.id === id ? { id, ...next } : entry));
        },
        appendText: (id, delta) => {
          entries = entries.map((entry) =>
            entry.id === id ? { ...entry, text: entry.text + delta } : entry,
          );
        },
        finish: (id) => {
          entries = entries.map((entry) =>
            entry.id === id ? { ...entry, streaming: false } : entry,
          );
        },
      },
      { onSnapshot: () => {}, onTranscriptReset: () => {} },
    );

    renderer.handle({ type: "text-start", id: "text-1" });
    renderer.handle({ type: "text-delta", id: "text-1", delta: "hello " });
    renderer.handle({ type: "text-delta", id: "text-1", delta: "world" });
    renderer.handle({ type: "text-end", id: "text-1" });

    expect(entries).toEqual([
      {
        id: "entry-0",
        kind: "assistant",
        tone: "normal",
        text: "hello world",
        streaming: false,
      },
    ]);
  });

  it("finalizes open text when a stream finishes without text-end", () => {
    const { renderer, entries } = createRendererHarness();

    renderer.handle({ type: "text-delta", id: "text-1", delta: "partial response" });
    expect(entries()[0]?.streaming).toBe(true);
    renderer.handle({ type: "finish", finishReason: "stop" });

    expect(entries()[0]?.streaming).toBe(false);
  });

  it("routes transient todo chunks without adding transcript output", () => {
    const received: MiniLilacTodoState[] = [];
    const { entries } = createRendererHarness();
    const todos: MiniLilacTodoState = {
      revision: 1,
      todos: [{ content: "Wire todo state", status: "pending", priority: "medium" }],
    };
    const hookedRenderer = new ChunkRenderer(
      {
        append: () => {
          throw new Error("todo chunks must not append transcript output");
        },
        update: () => {},
        appendText: () => {},
        finish: () => {},
      },
      {
        onSnapshot: () => {},
        onTodos: (next) => {
          received.push(next);
        },
        onTranscriptReset: () => {},
      },
    );

    hookedRenderer.handle({ type: "data-todos", data: todos, transient: true });
    hookedRenderer.handle({ type: "data-todos", data: todos, transient: false });

    expect(received).toEqual([todos]);
    expect(entries()).toEqual([]);
  });

  it("updates one live subagent block instead of appending status results", () => {
    const { renderer, entries } = createRendererHarness();
    renderer.handle({
      type: "tool-input-available",
      toolCallId: "delegate-1",
      toolName: "subagent_delegate",
      input: { profile: "explore", prompt: "Trace the request flow", mode: "sync" },
      dynamic: true,
    });
    renderer.handle({
      type: "data-subagentStatus",
      id: "child-1",
      data: {
        toolCallId: "delegate-1",
        runId: "child-1",
        profile: "explore",
        prompt: "Trace the request flow",
        mode: "sync",
        state: "running",
        toolCount: 2,
        activity: "grep",
      },
    });
    renderer.handle({
      type: "data-subagentStatus",
      id: "child-1",
      data: {
        toolCallId: "delegate-1",
        runId: "child-1",
        profile: "explore",
        prompt: "Trace the request flow",
        mode: "sync",
        state: "completed",
        toolCount: 3,
        text: "Located the handler",
      },
    });

    expect(entries()).toHaveLength(1);
    expect(entries()[0]).toMatchObject({
      kind: "subagent",
      tone: "success",
      text: "✓ Explore Task - Trace the request flow\n  ↳ 3 tool calls",
      subagent: { runId: "child-1", state: "completed", toolCount: 3 },
    });
  });

  it("reconciles a canonical delegation and status into one subagent block", () => {
    const entries = renderInitialMessages([
      {
        id: "assistant-subagent",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolName: "subagent_delegate",
            toolCallId: "delegate-1",
            state: "output-available",
            input: { profile: "explore", prompt: "Inspect routing", mode: "sync" },
            output: {
              status: "completed",
              childRunId: "child-1",
              profile: "explore",
              text: "Done",
            },
          },
          {
            type: "data-subagentStatus",
            id: "child-1",
            data: {
              toolCallId: "delegate-1",
              runId: "child-1",
              profile: "explore",
              prompt: "Inspect routing",
              mode: "sync",
              state: "completed",
              toolCount: 4,
              text: "Done",
            },
          },
        ],
      },
    ]);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: "subagent",
      tone: "success",
      subagent: { runId: "child-1", toolCallId: "delegate-1", toolCount: 4 },
    });
  });

  it("hides synthetic subagent results in live and canonical transcripts", () => {
    const { renderer, entries } = createRendererHarness();
    renderer.handle({
      type: "tool-input-available",
      toolCallId: "result-1",
      toolName: "subagent_result",
      input: { childRunId: "child-1", profile: "explore" },
      dynamic: true,
    });
    renderer.handle({
      type: "tool-output-available",
      toolCallId: "result-1",
      output: { status: "completed", text: "Done" },
      dynamic: true,
    });
    expect(entries()).toEqual([]);

    expect(
      renderInitialMessages([
        {
          id: "assistant-result",
          role: "assistant",
          parts: [
            {
              type: "dynamic-tool",
              toolName: "subagent_result",
              toolCallId: "result-1",
              state: "output-available",
              input: { childRunId: "child-1", profile: "explore" },
              output: { status: "completed", text: "Done" },
            },
          ],
        },
      ]),
    ).toEqual([]);
  });

  it("renders canonical shell commands and output in one block", () => {
    const messages: MiniLilacUIMessage[] = [
      {
        id: "assistant-tool",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolName: "bash",
            toolCallId: "call-1",
            state: "output-available",
            input: { command: "pwd" },
            output: "/workspace",
          },
        ],
      },
    ];

    expect(renderInitialMessages(messages)).toEqual([
      {
        id: "message:assistant-tool:0",
        kind: "shell",
        tone: "normal",
        text: "$ pwd\n\n/workspace",
        shell: { command: "pwd", output: "/workspace" },
      },
    ]);
  });

  it("keeps completed Bash output after canonical transcript reconciliation", () => {
    const messages: MiniLilacUIMessage[] = [
      {
        id: "assistant-bash-complete",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolName: "bash",
            toolCallId: "bash-complete",
            state: "output-available",
            input: { command: "printf 'start\\ndone\\n'" },
            output: {
              stdout: "start\ndone\n",
              stderr: "",
              exitCode: 0,
              stdoutTruncated: false,
              stderrTruncated: false,
            },
          },
        ],
      },
    ];

    expect(renderInitialMessages(messages)[0]).toMatchObject({
      kind: "shell",
      tone: "normal",
      text: "$ printf 'start\\ndone\\n'\n\nstart\ndone",
      shell: { command: "printf 'start\\ndone\\n'", output: "start\ndone" },
    });
  });

  it("only labels a shell cwd when it differs from the client cwd", () => {
    const message: MiniLilacUIMessage = {
      id: "assistant-cwd",
      role: "assistant",
      parts: [
        {
          type: "dynamic-tool",
          toolName: "bash",
          toolCallId: "call-1",
          state: "input-available",
          input: { command: "pwd", cwd: "/workspace" },
        },
      ],
    };

    expect(renderInitialMessages([message], { cwd: "/workspace/" })[0]).toMatchObject({
      text: "$ pwd",
      running: true,
      shell: { command: "pwd" },
    });
    expect(renderInitialMessages([message], { cwd: "/other" })[0]).toMatchObject({
      text: "# Running in /workspace\n\n$ pwd",
      shell: { command: "pwd", cwd: "/workspace" },
    });
  });

  it("clamps shell output to eight lines and exposes expansion labels", () => {
    const shell = {
      command: "bun test",
      output: Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n"),
    };

    expect(isShellTranscriptCollapsible(shell)).toBe(true);
    const collapsed = shellTranscriptText(shell);
    expect(collapsed).toContain("line 8");
    expect(collapsed).not.toContain("line 9");
    expect(collapsed.endsWith("Click to expand")).toBe(true);
    const expanded = shellTranscriptText(shell, true);
    expect(expanded).toContain("line 10");
    expect(expanded.endsWith("Click to collapse")).toBe(true);

    const longLine = "x".repeat(2_100);
    const characterClamped = { command: "print", output: longLine };
    expect(isShellTranscriptCollapsible(characterClamped)).toBe(true);
    const characterCollapsedText = shellTranscriptText(characterClamped);
    expect(characterCollapsedText).not.toContain(longLine);
    expect(characterCollapsedText).toContain(`${"x".repeat(32)}...`);
    expect(shellTranscriptText(characterClamped, true)).toContain(longLine);
  });

  it("clamps shell command input and restores it after expansion", () => {
    const command = Array.from({ length: 10 }, (_, i) => `input line ${i + 1}`).join("\n");
    const shell = { command };

    expect(isShellTranscriptCollapsible(shell)).toBe(true);
    const collapsed = shellTranscriptText(shell);
    expect(collapsed).toContain("input line 8");
    expect(collapsed).not.toContain("input line 9");
    expect(collapsed.endsWith("Click to expand")).toBe(true);
    const expanded = shellTranscriptText(shell, true);
    expect(expanded).toContain("input line 10");
    expect(expanded.endsWith("Click to collapse")).toBe(true);
  });

  it("renders automatic and manual compaction as durable divider entries", () => {
    const automatic = {
      type: "data-compaction" as const,
      id: "automatic-1",
      data: {
        source: "automatic" as const,
        reason: "threshold" as const,
        status: "completed" as const,
        messageCountBefore: 20,
        messageCountAfter: 5,
        estimatedInputTokensBefore: 12_500,
        estimatedInputTokensAfter: 3_200,
      },
    };
    const messages: MiniLilacUIMessage[] = [
      { id: "compaction-1", role: "assistant", parts: [automatic] },
      {
        id: "compaction-2",
        role: "assistant",
        parts: [
          {
            type: "data-compaction",
            data: {
              source: "manual",
              reason: "manual",
              status: "failed",
              messageCountBefore: 8,
              error: "summary unavailable",
            },
          },
        ],
      },
    ];
    const { renderer, entries } = createRendererHarness();

    renderer.handle(automatic);

    expect(entries()).toMatchObject([
      {
        kind: "compaction",
        tone: "warning",
        text: "Context compacted · 12.5K → 3.2K",
      },
    ]);
    expect(renderInitialMessages(messages)).toMatchObject([
      {
        kind: "compaction",
        tone: "warning",
        text: "Context compacted · 12.5K → 3.2K",
      },
      {
        kind: "compaction",
        tone: "danger",
        text: "Context compaction failed: summary unavailable",
      },
    ]);
  });

  it("keeps canonical and live invalid/denied tool entries in parity", () => {
    const messages: MiniLilacUIMessage[] = [
      {
        id: "assistant-tools",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolName: "bash",
            toolCallId: "invalid",
            state: "output-error",
            input: { command: 42 },
            errorText: "command must be a string",
          },
          {
            type: "dynamic-tool",
            toolName: "write",
            toolCallId: "denied",
            state: "output-denied",
            input: { path: "/etc/hosts" },
            approval: { id: "approval-1", approved: false },
          },
        ],
      },
    ];
    const { renderer, entries } = createRendererHarness();

    renderer.handle({
      type: "tool-input-error",
      toolCallId: "invalid",
      toolName: "bash",
      input: { command: 42 },
      errorText: "command must be a string",
      dynamic: true,
    });
    renderer.handle({
      type: "tool-input-available",
      toolCallId: "denied",
      toolName: "write",
      input: { path: "/etc/hosts" },
      dynamic: true,
    });
    renderer.handle({ type: "tool-output-denied", toolCallId: "denied" });

    expect(transcriptSemantics(entries())).toEqual(
      transcriptSemantics(renderInitialMessages(messages)),
    );
  });

  it("does not render raw JSON tool errors", () => {
    const entries = renderInitialMessages([
      {
        id: "assistant-tool-error",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolName: "bash",
            toolCallId: "failed",
            state: "output-error",
            input: { command: "false" },
            errorText: '{"stderr":"large raw result"}',
          },
        ],
      },
    ]);

    expect(entries.map((entry) => entry.text)).toEqual(["$ false\n\nCommand failed"]);
  });

  it("summarizes structural skill results without printing instructions", () => {
    const [entry] = renderInitialMessages([
      {
        id: "assistant-skill",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolName: "skill",
            toolCallId: "skill-1",
            state: "output-available",
            input: { name: "frontend-design" },
            output: {
              name: "frontend-design",
              description: "Build interfaces",
              instructions: "large private display payload",
              baseDirectory: "/skills/frontend-design",
              resources: [],
              resourceListingTruncated: false,
            },
          },
        ],
      },
    ]);

    expect(entry).toMatchObject({
      kind: "tool",
      tone: "success",
      text: "Loaded skill frontend-design",
    });
    expect(entry?.text).not.toContain("large private display payload");
  });

  it("summarizes todowrite without duplicating the complete list", () => {
    const entries = renderInitialMessages([
      {
        id: "assistant-todos",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolName: "todowrite",
            toolCallId: "todos-1",
            state: "output-available",
            input: {
              todos: [
                { content: "Implement", status: "completed", priority: "high" },
                { content: "Verify", status: "in_progress", priority: "medium" },
              ],
            },
            output: { revision: 2, todos: [] },
          },
        ],
      },
    ]);

    expect(entries).toMatchObject([{ kind: "tool", text: "Update todos: 2 items" }]);
    expect(entries[0]?.text).not.toContain("Implement");
  });

  it("shows web fetch URLs and search queries as single-line tool summaries", () => {
    const messages: MiniLilacUIMessage[] = [
      {
        id: "assistant-web-tools",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolName: "webfetch",
            toolCallId: "fetch-1",
            state: "output-available",
            input: { url: "https://example.test/a/long/path?with=query" },
            output: {},
          },
          {
            type: "dynamic-tool",
            toolName: "websearch",
            toolCallId: "search-1",
            state: "output-error",
            input: { query: "latest   runtime\nrelease" },
            errorText: "search unavailable",
          },
        ],
      },
    ];
    const { renderer, entries } = createRendererHarness();

    renderer.handle({
      type: "tool-input-available",
      toolCallId: "fetch-1",
      toolName: "webfetch",
      input: { url: "https://example.test/a/long/path?with=query" },
      dynamic: true,
    });
    renderer.handle({
      type: "tool-output-available",
      toolCallId: "fetch-1",
      output: {},
      dynamic: true,
    });
    renderer.handle({
      type: "tool-input-available",
      toolCallId: "search-1",
      toolName: "websearch",
      input: { query: "latest   runtime\nrelease" },
      dynamic: true,
    });
    renderer.handle({
      type: "tool-output-error",
      toolCallId: "search-1",
      errorText: "search unavailable",
      dynamic: true,
    });

    const expected: Array<Omit<TranscriptEntry, "id">> = [
      {
        kind: "tool",
        tone: "success",
        text: "Fetch https://example.test/a/long/path?with=query",
        singleLine: true,
      },
      {
        kind: "error",
        tone: "danger",
        text: 'Search "latest runtime release": search unavailable',
        singleLine: true,
      },
    ];
    expect(entries().map(({ id: _id, ...entry }) => entry)).toEqual(expected);
    expect(renderInitialMessages(messages).map(({ id: _id, ...entry }) => entry)).toEqual(expected);
  });

  it("shows native OpenAI web search queries from provider output", () => {
    const query = "latest   runtime\nrelease";
    const output = { action: { type: "search", query } };
    const messages: MiniLilacUIMessage[] = [
      {
        id: "assistant-native-websearch",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolName: "websearch",
            toolCallId: "native-search-1",
            state: "output-available",
            input: {},
            output,
          },
        ],
      },
    ];
    const { renderer, entries } = createRendererHarness();

    renderer.handle({
      type: "tool-input-available",
      toolCallId: "native-search-1",
      toolName: "websearch",
      input: {},
      dynamic: true,
    });
    expect(entries()[0]?.text).toBe("Websearch");
    renderer.handle({
      type: "tool-output-available",
      toolCallId: "native-search-1",
      output,
      dynamic: true,
    });

    const expected = {
      kind: "tool",
      tone: "success",
      text: 'Search "latest runtime release"',
      singleLine: true,
    } satisfies Omit<TranscriptEntry, "id">;
    expect(entries().map(({ id: _id, ...entry }) => entry)).toEqual([expected]);
    expect(renderInitialMessages(messages).map(({ id: _id, ...entry }) => entry)).toEqual([
      expected,
    ]);
  });

  it("collapses live and canonical reads and searches into one updating entry", () => {
    const { renderer, entries } = createRendererHarness();
    renderer.startRun();
    renderer.handle({
      type: "tool-input-available",
      toolCallId: "read-1",
      toolName: "read_file",
      input: { path: "src/a.ts" },
      dynamic: true,
    });
    expect(entries()).toMatchObject([
      { kind: "exploration", tone: "accent", text: "Exploring · 1 read" },
    ]);
    renderer.handle({
      type: "tool-output-available",
      toolCallId: "read-1",
      output: { success: true, totalLines: 20 },
      dynamic: true,
    });
    renderer.handle({
      type: "tool-input-available",
      toolCallId: "grep-1",
      toolName: "grep",
      input: { pattern: "TODO" },
      dynamic: true,
    });
    expect(entries()).toHaveLength(1);
    expect(entries()[0]).toMatchObject({
      kind: "exploration",
      tone: "accent",
      text: "Exploring · 1 read, 1 search",
      running: true,
    });
    renderer.handle({
      type: "tool-output-available",
      toolCallId: "grep-1",
      output: { results: [] },
      dynamic: true,
    });
    expect(entries()[0]).toMatchObject({
      kind: "exploration",
      tone: "normal",
      text: "Explored · 1 read, 1 search",
    });
    expect(entries()[0]).not.toHaveProperty("running");

    expect(
      renderInitialMessages([
        {
          id: "assistant-explore",
          role: "assistant",
          parts: [
            {
              type: "dynamic-tool",
              toolName: "read_file",
              toolCallId: "read-1",
              state: "output-available",
              input: { path: "src/a.ts" },
              output: { success: true, totalLines: 20 },
            },
            {
              type: "dynamic-tool",
              toolName: "grep",
              toolCallId: "grep-1",
              state: "output-available",
              input: { pattern: "TODO" },
              output: { results: [] },
            },
          ],
        },
      ]).map((entry) => ({ kind: entry.kind, tone: entry.tone, text: entry.text })),
    ).toEqual([{ kind: "exploration", tone: "normal", text: "Explored · 1 read, 1 search" }]);
  });

  it("segments exploration around commentary and expands operation details", () => {
    const entries = renderInitialMessages(
      [
        {
          id: "assistant-segments",
          role: "assistant",
          parts: [
            {
              type: "dynamic-tool",
              toolName: "read_file",
              toolCallId: "read-1",
              state: "output-available",
              input: { path: "/workspace/render.test.ts", start: { offset: 1 }, maxLines: 12 },
              output: {},
            },
            { type: "text", text: "Adding imports" },
            {
              type: "dynamic-tool",
              toolName: "grep",
              toolCallId: "grep-1",
              state: "output-available",
              input: { cwd: "/workspace/src", pattern: "batch" },
              output: {},
            },
          ],
        },
      ],
      { cwd: "/workspace" },
    );

    expect(entries.map((entry) => entry.text)).toEqual([
      "Explored · 1 read",
      "Adding imports",
      "Explored · 1 search",
    ]);
    const first = entries[0]?.exploration;
    const last = entries[2]?.exploration;
    expect(first).toBeDefined();
    expect(last).toBeDefined();
    if (first === undefined || last === undefined) throw new Error("missing exploration metadata");
    expect(explorationTranscriptText(first, false, true)).toBe(
      "Explored · 1 read\nRead render.test.ts · offset 1 · 12 lines",
    );
    expect(explorationTranscriptText(last, true, true)).toBe(
      'Exploring · 1 search\nGrep src · "batch"',
    );

    expect(
      explorationTranscriptText(
        {
          reads: 0,
          searches: 1,
          failures: 0,
          operations: [{ action: "Grep", detail: "x".repeat(300) }],
        },
        true,
        true,
      ),
    ).not.toContain("x".repeat(300));
  });

  it("formats search operations as compact cwd-relative details", () => {
    const [entry] = renderInitialMessages(
      [
        {
          id: "assistant-searches",
          role: "assistant",
          parts: [
            {
              type: "dynamic-tool",
              toolName: "glob",
              toolCallId: "glob-1",
              state: "output-available",
              input: {
                cwd: "/workspace",
                patterns: ["*", "src/**/*", "!**/node_modules/**"],
              },
              output: {},
            },
            {
              type: "dynamic-tool",
              toolName: "fuzzy_search",
              toolCallId: "find-1",
              state: "output-available",
              input: { cwd: "/workspace", query: "package config readme app" },
              output: {},
            },
            {
              type: "dynamic-tool",
              toolName: "grep",
              toolCallId: "grep-1",
              state: "output-available",
              input: { cwd: "/workspace/src", pattern: "TODO|FIXME" },
              output: {},
            },
          ],
        },
      ],
      { cwd: "/workspace" },
    );

    expect(entry?.exploration?.operations).toEqual([
      { action: "Glob", detail: "*, src/**/*, !**/node_modules/**" },
      { action: "Find", detail: '"package config readme app"' },
      { action: "Grep", detail: 'src · "TODO|FIXME"' },
    ]);
  });

  it("shows edit paths and best-effort added and removed line counts", () => {
    const entries = renderInitialMessages(
      [
        {
          id: "assistant-edits",
          role: "assistant",
          parts: [
            {
              type: "dynamic-tool",
              toolName: "apply_patch",
              toolCallId: "patch-1",
              state: "output-available",
              input: {
                patchText:
                  "*** Begin Patch\n*** Update File: src/app.ts\n@@\n-old\n+new\n+next\n*** Update File: /workspace/src/other.ts\n@@\n-before\n+after\n*** End Patch",
              },
              output: "Success",
            },
            {
              type: "dynamic-tool",
              toolName: "edit_file",
              toolCallId: "edit-1",
              state: "output-available",
              input: { path: "/workspace/src/store.ts", oldText: "one\ntwo", newText: "a\nb\nc" },
              output: { replacementsMade: 1 },
            },
            {
              type: "dynamic-tool",
              toolName: "edit_file",
              toolCallId: "edit-2",
              state: "output-available",
              input: {
                path: "src/hash.ts",
                edits: [
                  {
                    op: "replace",
                    pos: "10#abcdef:old",
                    end: "11#123456:old",
                    lines: ["new one", "new two"],
                  },
                ],
              },
              output: { replacementsMade: 1 },
            },
          ],
        },
      ],
      { cwd: "/workspace" },
    );

    expect(
      entries.map((entry) => ({
        kind: entry.kind,
        text: entry.text,
        singleLine: entry.singleLine,
      })),
    ).toEqual([
      { kind: "edit", text: "Patch 2 files", singleLine: true },
      { kind: "edit", text: "Edit src/store.ts +3 -2", singleLine: true },
      { kind: "edit", text: "Edit src/hash.ts +2 -2", singleLine: true },
    ]);
    expect(entries[0]?.edit?.operations).toMatchObject([
      { action: "Patch", path: "src/app.ts", added: 2, removed: 1 },
      { action: "Patch", path: "src/other.ts", added: 1, removed: 1 },
    ]);
    expect(groupNearbyEdits(entries)).toMatchObject([
      { kind: "edit", text: "Edit 4 files", edit: { operations: expect.any(Array) } },
    ]);
  });

  it("flattens the batch parent into its emitted children", () => {
    const { renderer, entries } = createRendererHarness();
    renderer.handle({
      type: "tool-input-available",
      toolCallId: "batch-1",
      toolName: "batch",
      input: { tool_calls: [{ tool: "bash", parameters: { command: "pwd" } }] },
      dynamic: true,
    });
    renderer.handle({
      type: "tool-output-available",
      toolCallId: "batch-1",
      output: { ok: true, total: 1 },
      dynamic: true,
    });
    expect(entries()).toEqual([]);

    renderer.handle({
      type: "tool-input-available",
      toolCallId: "child-1",
      toolName: "bash",
      input: { command: "pwd" },
      dynamic: true,
    });
    renderer.handle({
      type: "tool-output-available",
      toolCallId: "child-1",
      output: { stdout: "/workspace\n", stderr: "", exitCode: 0 },
      dynamic: true,
    });
    expect(entries()).toMatchObject([
      { kind: "shell", tone: "normal", text: "$ pwd\n\n/workspace" },
    ]);

    const canonical = renderInitialMessages([
      {
        id: "assistant-batch",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolName: "batch",
            toolCallId: "batch-1",
            state: "output-available",
            input: { tool_calls: [{ tool: "bash", parameters: { command: "pwd" } }] },
            output: { ok: true, total: 1 },
          },
          {
            type: "dynamic-tool",
            toolName: "bash",
            toolCallId: "child-1",
            state: "output-available",
            input: { command: "pwd" },
            output: { stdout: "/workspace\n", stderr: "", exitCode: 0 },
          },
        ],
      },
    ]);
    expect(canonical).toHaveLength(1);
    expect(canonical[0]).toMatchObject({ kind: "shell", text: "$ pwd\n\n/workspace" });
  });

  it("flattens batch exploration children into the shared exploration counter", () => {
    const parts: MiniLilacUIMessage["parts"] = [
      {
        type: "dynamic-tool",
        toolName: "batch",
        toolCallId: "batch-1",
        state: "output-available",
        input: {
          tool_calls: [
            { tool: "read_file", parameters: { path: "a.ts" } },
            { tool: "read_file", parameters: { path: "b.ts" } },
            { tool: "glob", parameters: { patterns: ["**/*.ts"] } },
          ],
        },
        output: { ok: true, total: 3 },
      },
      ...[
        { toolName: "read_file", toolCallId: "read-1", input: { path: "a.ts" } },
        { toolName: "read_file", toolCallId: "read-2", input: { path: "b.ts" } },
        { toolName: "glob", toolCallId: "glob-1", input: { patterns: ["**/*.ts"] } },
      ].map((child) => ({
        type: "dynamic-tool" as const,
        ...child,
        state: "output-available" as const,
        output: {},
      })),
    ];

    expect(
      renderInitialMessages([{ id: "assistant-batch-explore", role: "assistant", parts }]),
    ).toMatchObject([{ kind: "exploration", text: "Explored · 2 reads, 1 search" }]);
  });

  it("keeps canonical and live file and source entries in parity", () => {
    const messages: MiniLilacUIMessage[] = [
      {
        id: "assistant-resources",
        role: "assistant",
        parts: [
          {
            type: "file",
            mediaType: "image/png",
            filename: "chart.png",
            url: "https://example.test/chart.png",
          },
          {
            type: "source-url",
            sourceId: "source-1",
            title: "Reference",
            url: "https://example.test/reference",
          },
          {
            type: "source-document",
            sourceId: "source-2",
            title: "Specification",
            filename: "spec.pdf",
            mediaType: "application/pdf",
          },
        ],
      },
    ];
    const { renderer, entries } = createRendererHarness();

    renderer.handle({
      type: "file",
      mediaType: "image/png",
      url: "https://example.test/chart.png",
    });
    renderer.handle({
      type: "source-url",
      sourceId: "source-1",
      title: "Reference",
      url: "https://example.test/reference",
    });
    renderer.handle({
      type: "source-document",
      sourceId: "source-2",
      title: "Specification",
      filename: "spec.pdf",
      mediaType: "application/pdf",
    });

    expect(entries()[0]?.text).toBe("Image");
    expect(renderInitialMessages(messages)[0]?.text).toBe("Image: chart.png");
    expect(transcriptSemantics(entries()).slice(1)).toEqual(
      transcriptSemantics(renderInitialMessages(messages)).slice(1),
    );
    expect(transcriptSemantics(entries())).toEqual([
      {
        kind: "file",
        tone: "muted",
        text: "Image",
      },
      {
        kind: "source",
        tone: "muted",
        text: "Reference: https://example.test/reference",
      },
      {
        kind: "source",
        tone: "muted",
        text: "Specification: spec.pdf; application/pdf",
      },
    ]);
  });

  it("updates live tool input without duplication and resets reused ids between runs", () => {
    let sequence = 0;
    let entries: TranscriptEntry[] = [];
    const renderer = new ChunkRenderer(
      {
        append: (entry) => {
          const id = `entry-${sequence++}`;
          entries = [...entries, { id, ...entry }];
          return id;
        },
        update: (id, next) => {
          entries = entries.map((entry) => (entry.id === id ? { id, ...next } : entry));
        },
        appendText: () => {},
        finish: () => {},
      },
      { onSnapshot: () => {}, onTranscriptReset: () => {} },
    );

    renderer.startRun();
    renderer.handle({
      type: "tool-input-start",
      toolCallId: "reused",
      toolName: "bash",
      dynamic: true,
    });
    renderer.handle({
      type: "tool-input-delta",
      toolCallId: "reused",
      inputTextDelta: '{"command":',
    });
    renderer.handle({
      type: "tool-input-delta",
      toolCallId: "reused",
      inputTextDelta: '"pwd"}',
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.text).toBe("Bash");
    renderer.handle({
      type: "tool-input-available",
      toolCallId: "reused",
      toolName: "bash",
      input: { command: "pwd" },
      dynamic: true,
    });
    renderer.handle({
      type: "tool-output-available",
      toolCallId: "reused",
      output: "first",
      dynamic: true,
    });

    renderer.startRun();
    renderer.handle({
      type: "tool-input-start",
      toolCallId: "reused",
      toolName: "read",
      dynamic: true,
    });
    renderer.handle({
      type: "tool-output-available",
      toolCallId: "reused",
      output: "second",
      dynamic: true,
    });

    expect(entries).toHaveLength(2);
    expect(entries[0]?.text).toBe("$ pwd\n\nfirst");
    expect(entries[0]?.tone).toBe("normal");
    expect(entries[1]?.text).toBe("Read");
    expect(entries[1]?.tone).toBe("success");
  });

  it("streams preliminary Bash output into the active shell block", () => {
    let entries: TranscriptEntry[] = [];
    const renderer = new ChunkRenderer(
      {
        append: (entry) => {
          entries = [{ id: "bash-stream", ...entry }];
          return "bash-stream";
        },
        update: (id, next) => {
          entries = entries.map((entry) => (entry.id === id ? { id, ...next } : entry));
        },
        appendText: () => {},
        finish: () => {},
      },
      { onSnapshot: () => {}, onTranscriptReset: () => {} },
    );

    renderer.handle({
      type: "tool-input-available",
      toolCallId: "bash-live",
      toolName: "bash",
      input: { command: "run-tests" },
      dynamic: true,
    });
    renderer.handle({
      type: "tool-output-available",
      toolCallId: "bash-live",
      output: { type: "output-delta", delta: "first\nwarning\n" },
      dynamic: true,
      preliminary: true,
    });
    expect(entries[0]?.text).toBe("$ run-tests\n\nfirst\nwarning");
    renderer.handle({
      type: "tool-output-available",
      toolCallId: "bash-live",
      output: { type: "output-delta", delta: "last\n" },
      dynamic: true,
      preliminary: true,
    });
    expect(entries[0]?.text).toBe("$ run-tests\n\nfirst\nwarning\nlast");
    renderer.handle({
      type: "tool-output-available",
      toolCallId: "bash-live",
      output: { stdout: "first\nwarning\nlast\n", stderr: "", exitCode: 0 },
      dynamic: true,
    });
    expect(entries[0]?.text).toBe("$ run-tests\n\nfirst\nwarning\nlast");
  });

  it("renders structured Bash failures and preserves live output on malformed final data", () => {
    const { renderer, entries } = createRendererHarness();
    renderer.handle({
      type: "tool-input-available",
      toolCallId: "bash-failure",
      toolName: "bash",
      input: { command: "slow-command" },
      dynamic: true,
    });
    renderer.handle({
      type: "tool-output-available",
      toolCallId: "bash-failure",
      output: { type: "output-delta", delta: "work completed before timeout\n" },
      dynamic: true,
      preliminary: true,
    });
    renderer.handle({
      type: "tool-output-available",
      toolCallId: "bash-failure",
      output: {
        stdout: "work completed before timeout\n",
        stderr: "",
        exitCode: 143,
        executionError: { type: "timeout", timeoutMs: 500, signal: "SIGTERM" },
      },
      dynamic: true,
    });
    expect(entries()[0]).toMatchObject({
      tone: "danger",
      text: "$ slow-command\n\nwork completed before timeout\nCommand timed out after 500ms",
    });

    renderer.startRun();
    renderer.handle({
      type: "tool-input-available",
      toolCallId: "bash-malformed",
      toolName: "bash",
      input: { command: "odd-command" },
      dynamic: true,
    });
    renderer.handle({
      type: "tool-output-available",
      toolCallId: "bash-malformed",
      output: { type: "output-delta", delta: "retain me\n" },
      dynamic: true,
      preliminary: true,
    });
    renderer.handle({
      type: "tool-output-available",
      toolCallId: "bash-malformed",
      output: { unexpected: true },
      dynamic: true,
    });
    expect(entries().at(-1)?.text).toBe("$ odd-command\n\nretain me");
  });

  it("appends one entry per reasoning chunk and finalizes on reasoning-end", () => {
    let count = 0;
    const renderer = new ChunkRenderer(
      {
        append: () => `entry-${count++}`,
        update: () => {},
        appendText: () => {},
        finish: () => {},
      },
      { onSnapshot: () => {}, onTranscriptReset: () => {} },
    );

    renderer.startRun();
    renderer.handle({ type: "reasoning-start", id: "reasoning-1" });
    renderer.handle({ type: "reasoning-end", id: "reasoning-1" });
    renderer.handle({ type: "reasoning-start", id: "reasoning-2" });
    expect(count).toBe(2);
  });

  it("streams a title and body into an active then finalized reasoning entry", () => {
    const { renderer, entries } = createRendererHarness();
    renderer.startRun();
    renderer.handle({ type: "reasoning-start", id: "reasoning-1" });
    renderer.handle({ type: "reasoning-delta", id: "reasoning-1", delta: "**Inspecting the " });
    renderer.handle({ type: "reasoning-delta", id: "reasoning-1", delta: "stream**\n\n" });
    renderer.handle({ type: "reasoning-delta", id: "reasoning-1", delta: "Checking ordering." });
    expect(transcriptSemantics(entries())).toEqual([
      {
        kind: "reasoning",
        tone: "muted",
        text: "Thinking: Inspecting the stream\nChecking ordering.",
      },
    ]);

    renderer.handle({ type: "reasoning-end", id: "reasoning-1" });
    expect(transcriptSemantics(entries())).toEqual([
      {
        kind: "reasoning",
        tone: "muted",
        text: "Thought: Inspecting the stream\nChecking ordering.",
      },
    ]);
  });

  it("renders a title-only reasoning summary", () => {
    const { renderer, entries } = createRendererHarness();
    renderer.startRun();
    renderer.handle({ type: "reasoning-start", id: "reasoning-1" });
    renderer.handle({ type: "reasoning-delta", id: "reasoning-1", delta: "**Reviewing plan**" });
    renderer.handle({ type: "reasoning-end", id: "reasoning-1" });
    expect(transcriptSemantics(entries())).toEqual([
      { kind: "reasoning", tone: "muted", text: "Thought: Reviewing plan" },
    ]);
  });

  it("renders a body-only reasoning summary without a title convention", () => {
    const { renderer, entries } = createRendererHarness();
    renderer.startRun();
    renderer.handle({ type: "reasoning-start", id: "reasoning-1" });
    renderer.handle({ type: "reasoning-delta", id: "reasoning-1", delta: "Just plain reasoning." });
    renderer.handle({ type: "reasoning-end", id: "reasoning-1" });
    expect(transcriptSemantics(entries())).toEqual([
      { kind: "reasoning", tone: "muted", text: "Thought\nJust plain reasoning." },
    ]);
  });

  it("supports implicit reasoning starts from a delta", () => {
    const { renderer, entries } = createRendererHarness();
    renderer.startRun();
    renderer.handle({ type: "reasoning-delta", id: "reasoning-1", delta: "no start chunk" });
    expect(transcriptSemantics(entries())).toEqual([
      { kind: "reasoning", tone: "muted", text: "Thinking\nno start chunk" },
    ]);
  });

  it("ignores an empty delta without an explicit reasoning start", () => {
    const { renderer, entries } = createRendererHarness();
    renderer.startRun();
    renderer.handle({ type: "reasoning-delta", id: "reasoning-1", delta: "" });
    renderer.handle({ type: "finish" });
    expect(entries()).toEqual([]);
  });

  it("finalizes open reasoning when text output begins without reasoning-end", () => {
    const { renderer, entries } = createRendererHarness();
    renderer.startRun();
    renderer.handle({ type: "reasoning-start", id: "reasoning-1" });
    renderer.handle({ type: "reasoning-delta", id: "reasoning-1", delta: "**Deciding**\n\nGo." });
    renderer.handle({ type: "text-delta", id: "text-1", delta: "Answer" });
    renderer.handle({ type: "finish" });
    expect(transcriptSemantics(entries())).toEqual([
      { kind: "reasoning", tone: "muted", text: "Thought: Deciding\nGo." },
      { kind: "assistant", tone: "normal", text: "Answer" },
    ]);
  });

  it("finalizes open reasoning when a finish boundary arrives without reasoning-end", () => {
    const { renderer, entries } = createRendererHarness();
    renderer.startRun();
    renderer.handle({ type: "reasoning-start", id: "reasoning-1" });
    renderer.handle({ type: "reasoning-delta", id: "reasoning-1", delta: "**Wrapping up**" });
    renderer.handle({ type: "finish" });
    expect(transcriptSemantics(entries())).toEqual([
      { kind: "reasoning", tone: "muted", text: "Thought: Wrapping up" },
    ]);
  });

  it("tracks multiple reasoning chunks without merging their content", () => {
    const { renderer, entries } = createRendererHarness();
    renderer.startRun();
    renderer.handle({ type: "reasoning-start", id: "reasoning-1" });
    renderer.handle({ type: "reasoning-delta", id: "reasoning-1", delta: "**First**\n\nOne." });
    renderer.handle({ type: "reasoning-end", id: "reasoning-1" });
    renderer.handle({ type: "reasoning-start", id: "reasoning-2" });
    renderer.handle({ type: "reasoning-delta", id: "reasoning-2", delta: "**Second**\n\nTwo." });
    renderer.handle({ type: "reasoning-end", id: "reasoning-2" });
    expect(transcriptSemantics(entries())).toEqual([
      { kind: "reasoning", tone: "muted", text: "Thought: First\nOne." },
      { kind: "reasoning", tone: "muted", text: "Thought: Second\nTwo." },
    ]);
  });

  it("matches persisted rendering for the same reasoning content", () => {
    const { renderer, entries } = createRendererHarness();
    renderer.startRun();
    renderer.handle({ type: "reasoning-start", id: "reasoning-1" });
    renderer.handle({ type: "reasoning-delta", id: "reasoning-1", delta: "**Plan**\n\nDo it." });
    renderer.handle({ type: "reasoning-end", id: "reasoning-1" });

    const persisted = renderInitialMessages([
      {
        id: "assistant-1",
        role: "assistant",
        parts: [{ type: "reasoning", text: "**Plan**\n\nDo it.", state: "done" }],
      },
    ]);
    expect(transcriptSemantics(entries())).toEqual(transcriptSemantics(persisted));
  });
});
