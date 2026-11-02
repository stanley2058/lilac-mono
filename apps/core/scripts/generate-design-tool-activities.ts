/**
 * Generates native display fixtures used by the web design-system page. Each sample tool call
 * passes through the same label, detail, result, failure, subagent, and projection code that native
 * sessions use. Workflow samples use Core's progress-message formatter and action labels.
 */
import path from "node:path";
import type { Level1ToolName } from "@stanley2058/lilac-coding-tools/schemas";
import type { Level1ToolSpec } from "@stanley2058/lilac-plugin-runtime";
import type { ModelMessage } from "ai";

import { BUILTIN_LEVEL1_TOOLS } from "../src/plugins/builtin/local-tools";
import {
  nativeToolActivityDetail,
  nativeToolActivityLabel,
  nativeToolActivityResult,
} from "../src/surface/bridge/bus-agent-runner/native-activity-result";
import { summarizeToolFailure } from "../src/surface/bridge/bus-agent-runner/tool-failure-logging";
import { activityPartData } from "../src/surface/native/output-projection";
import { subagentMessages } from "../src/surface/native/subagents";
import { renderSubagentDisplay, type ChildToolState } from "../src/tools/subagent";
import { formatToolArgsForDisplayWithSpecs } from "../src/tools/tool-args-display";
import { designWorkflowProgress } from "./design-workflow-progress";

const ROOT_DIR = path.resolve(import.meta.dir, "../../..");
const OUTPUT_PATH = path.join(ROOT_DIR, "apps/web/src/generated/tool-activities.ts");
const CHECK = process.argv.includes("--check");

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type ToolCall = {
  toolName: Level1ToolName;
  args: { [key: string]: Json };
  result: Json;
  durationMs: number;
};

const specs = new Map<string, Level1ToolSpec<unknown>>(
  Object.values(BUILTIN_LEVEL1_TOOLS).map((spec) => [spec.name, spec]),
);

function bash(command: string, stdout: string) {
  return {
    toolName: "bash" as const,
    args: { command },
    result: { stdout, stderr: "", exitCode: 0 },
  };
}

function readText(filePath: string, lines: string[]) {
  return {
    toolName: "read" as const,
    args: { path: filePath },
    result: {
      success: true,
      resolvedPath: filePath.replace(/^~/, "/home/alex"),
      fileHash: "sample",
      startLine: 1,
      endLine: lines.length,
      totalLines: lines.length,
      hasMoreLines: false,
      truncatedByChars: false,
      format: "numbered",
      numberedContent: lines.map((line, index) => `${index + 1}| ${line}`).join("\n"),
    },
  };
}

function webSearchCommand(query: string): string {
  return `tools web.search ${JSON.stringify(query)}`;
}

function webSearch(query: string, results: { title: string; url: string; content: string }[]) {
  return bash(
    webSearchCommand(query),
    JSON.stringify({ results: results.map((result) => ({ ...result, score: null })) }),
  );
}

const toolCalls = {
  notes: {
    ...readText("~/notes/kyoto-weekend.md", [
      "# Kyoto weekend",
      "",
      "- Prefer walking routes under two hours",
      "- Museum pass expires in October",
    ]),
    durationMs: 90,
  },
  routeMap: {
    toolName: "read",
    args: { path: "~/Pictures/riverside-route.svg" },
    result: {
      success: true,
      kind: "attachment",
      resolvedPath: "/home/alex/Pictures/riverside-route.svg",
      fileHash: "sample",
      filename: "riverside-route.svg",
      mimeType: "image/svg+xml",
      bytes: 2400,
    },
    durationMs: 120,
  },
  forecast: {
    ...bash(
      "curl -s https://weather.example/kyoto/saturday | jq '.summary'",
      '"18°C, light cloud, 10% chance of rain"\n',
    ),
    durationMs: 640,
  },
  weather: {
    ...webSearch("Kyoto weather Saturday", [
      {
        title: "Kyoto weekend forecast",
        url: "https://weather.example/kyoto",
        content: "Saturday: 18°C, light cloud, 10% chance of rain.",
      },
    ]),
    durationMs: 850,
  },
  hours: {
    ...webSearch("Kyoto museum Saturday hours", [
      {
        title: "Visit | Kyoto Museum",
        url: "https://museum.example/visit",
        content: "Open 10:00–18:00. Last admission 17:30.",
      },
    ]),
    durationMs: 1200,
  },
  hoursAndNotes: {
    ...bash(
      `${webSearchCommand("Kyoto museum Saturday hours")}; cat ~/notes/museum.md`,
      '{"results":[{"title":"Visit | Kyoto Museum","url":"https://museum.example/visit","content":"Open 10:00–18:00.","score":null}]}\n# Museum\n\n- Pass expires in October\n',
    ),
    durationMs: 1300,
  },
  planEdit: {
    toolName: "edit",
    args: {
      path: "~/notes/kyoto-weekend.md",
      oldText: "- Museum pass expires in October",
      newText: "- Museum pass expires in October\n- Saturday: riverside walk, museum if it rains",
    },
    result: {
      success: true,
      resolvedPath: "/home/alex/notes/kyoto-weekend.md",
      oldHash: "sample-old",
      newHash: "sample-new",
      changesMade: true,
      replacementsMade: 1,
    },
    durationMs: 70,
  },
  nearby: {
    ...webSearch("cafés and bookstores near Kamogawa", [
      {
        title: "Chapter House",
        url: "https://places.example/chapter-house",
        content: "Café and bookstore. Open 8:00–18:00.",
      },
    ]),
    durationMs: 900,
  },
  notesSearch: {
    toolName: "grep",
    args: { pattern: "museum", path: "~/notes" },
    result: {
      mode: "default",
      truncated: false,
      results: [
        {
          file: "/home/alex/notes/kyoto-weekend.md",
          line: 4,
          text: "- Museum pass expires in October",
        },
      ],
    },
    durationMs: 60,
  },
  firstRoute: {
    ...bash(
      "./scripts/route.sh --from 'Sanjo Station' --to 'Riverside café' --mode walk",
      "Walk: 2h 05m, 7.8 km\n",
    ),
    durationMs: 20_000,
  },
  shorterRoute: {
    ...bash(
      "./scripts/route.sh --from 'Sanjo Station' --loop --max-minutes 60",
      "Loop: 45m, 3.4 km, returns to Sanjo Station\n",
    ),
    durationMs: 10_000,
  },
  travelTimes: {
    ...bash(
      "./scripts/route.sh --from 'Sanjo Station' --to 'Kyoto Museum' --mode transit",
      "Bus 206: 15m\n",
    ),
    durationMs: 8000,
  },
  forecastTimeout: {
    toolName: "bash",
    args: { command: "curl -sf https://weather.example/kyoto/saturday" },
    result: {
      stdout: "",
      stderr: "curl: (28) Operation timed out after 5000 milliseconds\n",
      exitCode: 28,
    },
    durationMs: 5000,
  },
  forecastUnavailable: {
    toolName: "bash",
    args: { command: "curl -s --retry 3 https://weather.example/kyoto/saturday" },
    result: {
      stdout: "",
      stderr: "",
      exitCode: 124,
      executionError: {
        type: "timeout",
        code: "wall_clock_timeout",
        timeoutMs: 30_000,
        timeoutKind: "wall_clock",
        signal: "SIGTERM",
      },
    },
    durationMs: 30_000,
  },
} satisfies Record<string, ToolCall>;

/** Mirrors the bus agent runner's start and end tool publications. */
function toolActivity({ toolName, args, result, durationMs }: ToolCall) {
  const event = { args, result };
  const label = nativeToolActivityLabel({ toolName, event });
  const detail = nativeToolActivityDetail({ toolName, event });
  const { ok } = summarizeToolFailure({ toolName, isError: false, event, toolSpecs: specs });
  return {
    running: activityPartData({ kind: "tool", state: "start", label, ...detail }),
    settled: activityPartData({
      kind: "tool",
      state: ok ? "complete" : "failed",
      label,
      ...detail,
      ...nativeToolActivityResult({ toolName, event }),
      durationMs,
    }),
  };
}

type ChildCall = { toolName: Level1ToolName; args: { [key: string]: Json }; done: boolean };
type SubagentSample = {
  profile: "restricted" | "full";
  task: string;
  children: ChildCall[];
  final: string;
};

const subagentSamples: Record<"weather" | "museum", SubagentSample> = {
  weather: {
    profile: "restricted",
    task: "Check Saturday's weather and the riverside walking conditions.",
    children: [
      {
        toolName: "bash",
        args: { command: webSearchCommand("Kyoto weather Saturday") },
        done: true,
      },
      { toolName: "read", args: { path: "~/notes/riverside-path.md" }, done: false },
    ],
    final: "Mild and dry on Saturday. The riverside path is open; bring a light jacket.",
  },
  museum: {
    profile: "full",
    task: "Check the museum's opening hours and ticket availability.",
    children: [
      {
        toolName: "bash",
        args: { command: webSearchCommand("Kyoto museum Saturday hours") },
        done: false,
      },
      {
        toolName: "bash",
        args: { command: webSearchCommand("Kyoto museum tickets") },
        done: false,
      },
    ],
    final:
      "The museum is open 10:00–18:00, with last admission at 17:30. No advance booking is needed.",
  },
};

/** The parent sees a child's tool calls through the short spec formatters. */
function childDisplay({ toolName, args }: ChildCall): string {
  return `${toolName}${formatToolArgsForDisplayWithSpecs(toolName, args, specs)}`;
}

function subagentProgress(sample: SubagentSample, allDone: boolean): string {
  const children = new Map<string, ChildToolState>(
    sample.children.map((child, index) => {
      const done = allDone || child.done;
      const state: ChildToolState = {
        toolCallId: `child_${index}`,
        status: done ? "done" : "running",
        ok: done ? true : null,
        display: childDisplay(child),
        updatedSeq: index + 1,
      };
      return [state.toolCallId, state];
    }),
  );
  return renderSubagentDisplay({ profile: sample.profile, children });
}

function subagentActivity(sample: SubagentSample) {
  const args = { permissions: sample.profile, task: sample.task };
  return {
    started: activityPartData({
      kind: "tool",
      state: "start",
      label: nativeToolActivityLabel({ toolName: "subagent_delegate", event: { args } }),
    }),
    working: activityPartData({
      kind: "tool",
      state: "start",
      label: subagentProgress(sample, false),
    }),
    done: activityPartData({
      kind: "tool",
      state: "complete",
      label: subagentProgress(sample, true),
    }),
  };
}

function subagentTranscript(sample: SubagentSample) {
  const calls = sample.children.map((child, index) => ({
    type: "tool-call" as const,
    toolCallId: `child_${index}`,
    toolName: child.toolName,
    input: child.args,
  }));
  const prompt: ModelMessage = { role: "user", content: sample.task };
  const working: ModelMessage = {
    role: "assistant",
    content: [
      { type: "reasoning", text: "Check the original source before summarizing." },
      ...calls,
    ],
  };
  const results: ModelMessage = {
    role: "tool",
    content: calls.map((call) => ({
      type: "tool-result",
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      output: { type: "text", value: "" },
    })),
  };
  const final: ModelMessage = { role: "assistant", content: sample.final };
  const running = sample.children
    .map((child, index) => ({ child, call: calls[index]! }))
    .filter(({ child }) => !child.done)
    .map(({ call }) => ({ toolCallId: call.toolCallId, toolName: call.toolName }));
  return {
    running: subagentMessages([prompt, working], true, running),
    complete: subagentMessages([prompt, working, results, final]),
  };
}

function mapValues<T, U>(record: Record<string, T>, map: (value: T) => U): Record<string, U> {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, map(value)]));
}

function render(): string {
  const tools = mapValues(toolCalls, toolActivity);
  const subagents = mapValues(subagentSamples, subagentActivity);
  const transcripts = mapValues(subagentSamples, subagentTranscript);
  const workflows = designWorkflowProgress();
  const source = `// Generated by \`bun run codegen:design-tool-activities\` from Core's native display code. Do not edit.
import type { DisplayMessage, DisplayPart, WorkflowCard } from "@stanley2058/lilac-client-protocol";

type ActivityData = Extract<DisplayPart, { type: "data-activity" }>["data"];

export const toolActivities = ${JSON.stringify(tools)} as const satisfies Record<string, { running: ActivityData; settled: ActivityData }>;

export const subagentActivities = ${JSON.stringify(subagents)} as const satisfies Record<string, { started: ActivityData; working: ActivityData; done: ActivityData }>;

export const subagentTranscripts: Record<keyof typeof subagentActivities, { running: DisplayMessage[]; complete: DisplayMessage[] }> = ${JSON.stringify(transcripts)};

type WorkflowCardContent = { text: string; actions: Extract<DisplayPart, { type: "data-actions" }>["data"]["actions"]; attachments: []; workflow: WorkflowCard };
export const workflowProgress = ${JSON.stringify(workflows)} as const satisfies Record<string, WorkflowCardContent & { transitions: Record<"paused" | "resumed" | "cancelled", WorkflowCardContent> }>;
`;
  const formatted = Bun.spawnSync(["bunx", "oxfmt", "--stdin-filepath", OUTPUT_PATH], {
    cwd: ROOT_DIR,
    stdin: Buffer.from(source),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (!formatted.success) {
    console.error(`Failed to format design tool activities:\n${formatted.stderr.toString()}`);
    process.exit(1);
  }
  return formatted.stdout.toString();
}

const output = render();
if (CHECK) {
  const file = Bun.file(OUTPUT_PATH);
  const current = (await file.exists()) ? await file.text() : "";
  if (current !== output) {
    console.error(
      `${path.relative(ROOT_DIR, OUTPUT_PATH)} is stale. Run bun run codegen:design-tool-activities.`,
    );
    process.exit(1);
  }
} else {
  await Bun.write(OUTPUT_PATH, output);
}
