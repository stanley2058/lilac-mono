import type { Database } from "bun:sqlite";
import { Result } from "better-result";
import type { DisplayMessage, NativeQuestion } from "@stanley2058/lilac-client-protocol";
import type { SqliteTranscriptStore } from "../../../src/transcript/transcript-store";
import { NativeStore } from "../../../src/surface/native/store";
import {
  directMessageHistory,
  novelDraft,
  searchInvestigation,
  tripPlanning,
  type ScriptTurn,
} from "./browser-seed-long";

const richMarkdown = `# Native surface check

This reply exercises the real renderer. **Bold**, *emphasis*, ~~removed text~~, and \`inline code\` should share the theme tokens.

- [x] Latest turns arrive first
- [x] Older history hydrates in the background
- [ ] Review the queued attachment

| Surface | Input | Output |
| --- | --- | --- |
| Web | Text and files | Rich content |
| TUI | Text and files | Plain text |

The inline relation is $E = mc^2$. A display equation follows:

$$
\\int_0^1 x^2\\,dx = \\frac{1}{3}
$$

\`\`\`mermaid
flowchart LR
  Client -->|one socket| Core
  Core --> Store
  Store -->|recent turn| Client
  Store -. older turns .-> Client
\`\`\`

\`\`\`typescript
type Turn = { id: string; revision: number };

export function isNewer(current: Turn, next: Turn): boolean {
  return current.id === next.id && next.revision > current.revision;
}
\`\`\`

> Keep the current viewport stable while the older range is filled.

See the [local thread](#) or [reference documentation](https://example.com).

Read: https://claude.dev/blog/how-we-made-claude-ai-faster/

## Malformed content stays contained

The unfinished **bold marker and [unclosed link( remain readable.

\`\`\`mermaid
flowchart LR
  broken node --> [
\`\`\`

$$
\\frac{1}{
$$

<script>window.nativeFixtureUnsafe = true</script>
<img src="missing-fixture-image" onerror="window.nativeFixtureUnsafe = true">
[Blocked script link](javascript:alert('native-fixture'))

The composer must still work after this malformed reply.

## File viewer

Open \`./example.md\`, jump to \`./example.ts:123\`, or check \`./missing.txt\`.

`;

function completedTurn(
  store: NativeStore,
  transcript: SqliteTranscriptStore | undefined,
  threadId: string,
  index: number,
  text: string,
  answer: string,
  rich = false,
  createdAt = Date.now() - (1000 - index) * 60_000,
) {
  const receipt = store
    .acceptInput("owner", {
      threadId,
      commandId: `seed_${threadId}_${index}`,
      historyGeneration: 0,
      text,
      mode: "prompt",
      attachmentIds: [],
      skillIds: [],
    })
    .unwrap();
  const input = store.getInput(receipt.inputId).unwrap();
  if (!input.turnId) throw new Error("Fixture full turn was not created");
  store.settleInput(input.id, "admitted").unwrap();
  const messages: DisplayMessage[] = [];
  if (rich) {
    messages.push({
      id: `activity_${input.id}`,
      role: "assistant",
      metadata: { authorId: "lilac", createdAt, phase: "commentary" },
      parts: [
        {
          type: "data-activity",
          id: `thinking_${index}`,
          data: { kind: "thinking", label: "Thinking", state: "complete", durationMs: 2400 },
        },
        {
          type: "data-activity",
          id: `search_${index}`,
          data: {
            kind: "tool",
            label: "Searched the workspace",
            detail: "Found the transport, replay cache, and resource resolver modules.",
            state: "complete",
            durationMs: 180,
          },
        },
        {
          type: "text",
          text: "I found the transport and cache boundaries. I am checking the rendered result next.",
        },
        {
          type: "data-activity",
          id: `remote_image_${index}`,
          data: {
            kind: "tool",
            label: "read",
            detail: 'read {"path":"https://pbs.twimg.com/media/HT6WgFLWoAAelfQ.png"}',
            state: "complete",
            durationMs: 120,
            file: {
              path: "https://pbs.twimg.com/media/HT6WgFLWoAAelfQ.png",
              mediaType: "image/png",
            },
          },
        },
        {
          type: "data-activity",
          id: `read_${index}`,
          data: {
            kind: "tool",
            label: "Read the protocol definition",
            detail: "Reviewed display messages, turn slots, and replay cursors.",
            state: "complete",
            durationMs: 120,
          },
        },
      ],
    });
  }
  messages.push({
    id: `answer_${input.id}`,
    role: "assistant",
    metadata: { authorId: "lilac", createdAt: createdAt + 3200, phase: "final" },
    parts: [{ type: "text", text: answer }],
  });
  for (const message of messages) store.appendMessage(threadId, 0, input.turnId, message).unwrap();
  store
    .projectTurn(threadId, 0, `seed_complete_${input.id}`, input.turnId, (slot) =>
      Result.ok({
        slot: { ...slot, state: "complete", startedAt: createdAt, settledAt: createdAt + 8400 },
        changes: [
          {
            kind: "turn-state",
            turnId: slot.turnId,
            position: slot.position,
            state: "complete",
            startedAt: createdAt,
            settledAt: createdAt + 8400,
          },
        ],
      }),
    )
    .unwrap();
  if (transcript) {
    const previousId = store.getLatestCanonicalRequestId(threadId).unwrap();
    const previous = previousId
      ? transcript.getRequestTranscript({ requestId: previousId }).unwrap()
      : null;
    transcript
      .saveRequestTranscript({
        requestId: input.requestId,
        sessionId: `native:${threadId}`,
        requestClient: "native",
        messages: [
          ...(previous?.messages ?? []),
          { role: "user", content: [{ type: "text", text }] },
          { role: "assistant", content: [{ type: "text", text: answer }] },
        ],
        finalText: answer,
        modelLabel: "native-browser-fixture",
      })
      .unwrap();
  }
  store.markInputCompleted(input.id).unwrap();
  return input;
}

const HOUR_MS = 3_600_000;

// The DM context window reads stored timestamps, so these turns go through a store whose clock is set
// to each turn's time. The latest session is older than the default two-hour context gap.
function seedDirectMessages(
  database: Database,
  transcript: SqliteTranscriptStore | undefined,
  historyWindows?: number,
): string {
  let now = Date.now();
  const store = new NativeStore(database, () => now);
  const dm = store.ensureDirectThread("owner").unwrap();
  const sessions: { startedAt: number; turns: [string, string][] }[] = [
    {
      startedAt: Date.now() - 26 * HOUR_MS,
      turns: [
        [
          "What should I pack for Kyoto next week?",
          "Layers, a light rain jacket, and comfortable walking shoes.",
        ],
        [
          "Anything I should book ahead?",
          "Book kaiseki dinners and the Katsura Imperial Villa now. Most temples need no reservation.",
        ],
      ],
    },
    {
      startedAt: Date.now() - 3 * HOUR_MS,
      turns: [
        [
          "Remind me what the release checklist says about migrations.",
          "Run the migration dry run, then record the result in the release notes.",
        ],
        ["Thanks, that's all for now.", "Anytime."],
      ],
    },
  ];
  let index = 0;
  // Months of earlier windows give the timeline rail a long DM; only recent turns get transcripts.
  for (const window of directMessageHistory(Date.now(), sessions[0]!.startedAt, historyWindows))
    for (const turn of window) {
      now = turn.at;
      completedTurn(store, undefined, dm.id, index++, turn.text, turn.answer, false, now);
    }
  for (const session of sessions)
    for (const [offset, [text, answer]] of session.turns.entries()) {
      now = session.startedAt + offset * 5 * 60_000;
      completedTurn(store, transcript, dm.id, index++, text, answer, false, now);
    }
  return dm.id;
}

function seedScript(
  store: NativeStore,
  transcript: SqliteTranscriptStore | undefined,
  commandId: string,
  title: string,
  turns: readonly ScriptTurn[],
): string {
  const thread = store.createThread("owner", { commandId, title }).unwrap();
  for (const [index, turn] of turns.entries())
    completedTurn(
      store,
      // Transcripts copy every earlier message, so only the recent tail gets one.
      index >= turns.length - 10 ? transcript : undefined,
      thread.id,
      index,
      turn.text,
      turn.answer,
      false,
      turn.at,
    );
  return thread.id;
}

export function seedNativeBrowserFixture(
  store: NativeStore,
  options: {
    historyTurns?: number;
    sidebarThreads?: number;
    /** Turns in the long scripted threads; the novel gets half. */
    longTurns?: number;
    dmWindows?: number;
    transcript?: SqliteTranscriptStore;
    database: Database;
  },
) {
  const historyTurns = options.historyTurns ?? 600;
  const sidebarThreads = options.sidebarThreads ?? 60;
  const long = store
    .createThread("owner", { commandId: "browser-long", title: "Long history and replay" })
    .unwrap();
  for (let index = 0; index < historyTurns; index++) {
    completedTurn(
      store,
      options.transcript,
      long.id,
      index,
      `Review the implementation checkpoint ${index + 1}.`,
      `Checkpoint **${index + 1}** is complete. The backend owns authorization and sends a bounded projection.\n\nThe client keeps the current viewport stable while older turns are hydrated.\n\n\`revision_${index + 1}\``,
    );
  }
  const empty = store
    .createThread("owner", { commandId: "browser-empty", title: "Fresh conversation" })
    .unwrap();
  for (let index = 0; index < sidebarThreads; index++) {
    const thread = store
      .createThread("owner", {
        commandId: `browser-sidebar-${index}`,
        title: `Workspace note ${String(index + 1).padStart(2, "0")}`,
      })
      .unwrap();
    completedTurn(
      store,
      options.transcript,
      thread.id,
      0,
      `Remember note ${index + 1}.`,
      `Saved the visible note for fixture ${index + 1}.`,
    );
  }
  const rich = store
    .createThread("owner", { commandId: "browser-rich", title: "Markdown, math, and diagrams" })
    .unwrap();
  completedTurn(
    store,
    options.transcript,
    rich.id,
    0,
    "Explain the native architecture and include code, a diagram, and an equation.",
    richMarkdown,
    true,
  );
  const largeTurn = store
    .createThread("owner", { commandId: "browser-large-turn", title: "Large turn pagination" })
    .unwrap();
  const largeInput = completedTurn(
    store,
    options.transcript,
    largeTurn.id,
    0,
    "Inspect the long report without blocking the interface.",
    "The report is attached below as a long text response.",
  );
  store
    .appendMessage(largeTurn.id, 0, largeInput.turnId!, {
      id: "large_fixture_answer",
      role: "assistant",
      metadata: { authorId: "lilac", phase: "final", createdAt: Date.now() },
      parts: Array.from({ length: 80 }, (_, index) => ({
        type: "text" as const,
        text: `### Report section ${index + 1}\n\n${"This section checks incremental turn paging and rendering without transferring the whole report. ".repeat(55)}\n\n`,
      })),
    })
    .unwrap();
  if (options.transcript) {
    const saved = options.transcript
      .getRequestTranscript({ requestId: largeInput.requestId })
      .unwrap();
    if (!saved) throw new Error("Large fixture transcript is unavailable");
    options.transcript
      .saveRequestTranscript({
        requestId: largeInput.requestId,
        sessionId: `native:${largeTurn.id}`,
        requestClient: "native",
        messages: [
          ...saved.messages,
          {
            role: "assistant",
            content: Array.from({ length: 80 }, (_, index) => ({
              type: "text" as const,
              text: `### Report section ${index + 1}\n\n${"This section checks incremental turn paging and rendering without transferring the whole report. ".repeat(55)}\n\n`,
            })),
          },
        ],
        modelLabel: "native-browser-fixture",
      })
      .unwrap();
  }
  const uploads = store
    .createThread("owner", { commandId: "browser-upload", title: "Pending attachment" })
    .unwrap();
  const upload = store
    .reserveUpload("owner", {
      threadId: uploads.id,
      filename: "large-design.pdf",
      mediaType: "application/pdf",
      size: 32 * 1024 * 1024,
    })
    .unwrap();
  store
    .acceptInput("owner", {
      threadId: uploads.id,
      commandId: "browser-pending",
      historyGeneration: 0,
      text: "Review this attachment when its upload finishes.",
      mode: "prompt",
      attachmentIds: [upload.id],
      skillIds: [],
    })
    .unwrap();
  store
    .upsertUser({
      id: "participant",
      providerId: "fixture_participant",
      displayName: "Participant",
      role: "participant",
      toolMode: "restricted",
    })
    .unwrap();
  store.shareThread("owner", { threadId: rich.id, userId: "participant", grant: "read" }).unwrap();
  const now = Date.now();
  const search = seedScript(
    store,
    options.transcript,
    "browser-search",
    "Search latency investigation",
    searchInvestigation(now, options.longTurns),
  );
  const novel = seedScript(
    store,
    options.transcript,
    "browser-novel",
    "Novel draft: The Lantern Keeper",
    novelDraft(now, options.longTurns === undefined ? undefined : Math.ceil(options.longTurns / 2)),
  );
  const trip = seedScript(
    store,
    options.transcript,
    "browser-trip",
    "Lisbon trip",
    tripPlanning(now),
  );
  const dm = seedDirectMessages(options.database, options.transcript, options.dmWindows);
  const questions = seedQuestionThread(store, options.transcript);
  return {
    dm,
    search,
    novel,
    trip,
    questions,
    rich: rich.id,
    history: long.id,
    largeTurn: largeTurn.id,
    empty: empty.id,
    uploads: uploads.id,
    historyTurns,
    sidebarThreads,
  };
}

function seedQuestionThread(store: NativeStore, transcript: SqliteTranscriptStore | undefined) {
  const thread = store
    .createThread("owner", { commandId: "browser-questions", title: "Preview deploy questions" })
    .unwrap();
  const input = completedTurn(
    store,
    transcript,
    thread.id,
    0,
    "Check with me before you deploy the preview.",
    "These cards show settled questions. Send `ask me` for live ones.",
  );
  const question = (id: string, respondentId: string, view: NativeQuestion["view"]) => {
    store
      .appendMessage(thread.id, 0, input.turnId!, {
        id,
        role: "assistant",
        metadata: { authorId: "lilac", createdAt: Date.now() },
        parts: [
          {
            type: "data-question",
            id,
            data: {
              questionCallId: id,
              requestId: input.requestId,
              respondentId,
              historyGeneration: 0,
              mode: "deferred",
              view,
            },
          },
        ],
      })
      .unwrap();
  };
  question("seed_question_answered", "owner", {
    state: "answered",
    summary: {
      answers: [
        { header: "Deploy target", answer: { kind: "option", label: "Preview link" } },
        { header: "Database", answer: { kind: "custom" } },
      ],
    },
  });
  question("seed_question_expired", "owner", { state: "expired" });
  question("seed_question_cancelled", "owner", { state: "cancelled" });
  // Another respondent's question stays read-only for the owner.
  question("seed_question_other", "participant", {
    state: "pending",
    prompt: {
      ordinal: 1,
      total: 1,
      header: "Reviewer",
      question: "Should I request your review on the preview pull request?",
      options: [
        { index: 1, label: "Yes", description: "Add you as a reviewer.", token: "seed-other-1" },
        { index: 2, label: "No", description: "Leave reviewers unchanged.", token: "seed-other-2" },
      ],
      customToken: "seed-other-custom",
    },
  });
  return thread.id;
}
