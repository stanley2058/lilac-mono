import type {
  DisplayMessage,
  DisplayPart,
  ReadyTurnSlot,
  SubagentSummary,
  WorkflowCard,
} from "@stanley2058/lilac-client-protocol";
import {
  subagentActivities,
  subagentTranscripts,
  toolActivities,
  workflowProgress,
} from "./generated/tool-activities";

type Activity = Extract<DisplayPart, { type: "data-activity" }>;
/** A turn frame, optionally followed by a workflow card that Core posts as its own slot. */
export type AgentWorkFrame = ReadyTurnSlot & { following?: ReadyTurnSlot };
export type AgentWorkStage = {
  id: string;
  label: string;
  description: string;
  frames: AgentWorkFrame[];
};
export const demoTime = Date.parse("2026-09-19T09:00:00Z");

export function workflowFrame(key: keyof typeof workflowProgress): ReadyTurnSlot {
  return workflowCardFrame(workflowProgress[key]);
}

function workflowCardFrame(progress: {
  readonly text: string;
  readonly actions: readonly Extract<
    DisplayPart,
    { type: "data-actions" }
  >["data"]["actions"][number][];
  readonly workflow: WorkflowCard;
}): ReadyTurnSlot {
  // Matches the slot and parts Core's native adapter creates when it posts a workflow card.
  return {
    kind: "ready",
    slotId: "demo_workflow",
    turnId: "demo_workflow",
    position: 1,
    state: "complete",
    messages: [
      {
        id: "demo_workflow",
        role: "assistant",
        metadata: { authorId: "demo_agent", createdAt: demoTime + 3000 },
        parts: [
          { type: "text", text: progress.text },
          { type: "data-workflow", id: "workflow_demo_workflow", data: progress.workflow },
          ...(progress.actions.length
            ? [
                {
                  type: "data-actions" as const,
                  id: "demo_workflow_actions",
                  data: { requestId: "demo_request", revision: 0, actions: [...progress.actions] },
                },
              ]
            : []),
        ],
      },
    ],
  };
}

/** Moves workflow card times so the sample's present is `at`, keeping live timers realistic. */
export function rebaseWorkflowTimes(slot: ReadyTurnSlot, at: number): ReadyTurnSlot {
  const shift = (value: number) => value + at - demoTime;
  return {
    ...slot,
    messages: slot.messages.map((message) => ({
      ...message,
      parts: message.parts.map((part) => {
        if (part.type !== "data-workflow") return part;
        const card = part.data;
        return {
          ...part,
          data: {
            ...card,
            startedAt: shift(card.startedAt),
            ...(card.endedAt !== undefined ? { endedAt: shift(card.endedAt) } : {}),
            ...(card.nextRunAt !== undefined ? { nextRunAt: shift(card.nextRunAt) } : {}),
            ...(card.wait
              ? {
                  wait: {
                    ...card.wait,
                    ...(card.wait.dueAt !== undefined ? { dueAt: shift(card.wait.dueAt) } : {}),
                    ...(card.wait.deadlineAt !== undefined
                      ? { deadlineAt: shift(card.wait.deadlineAt) }
                      : {}),
                  },
                }
              : {}),
          },
        };
      }),
    })),
  };
}

export function workflowActionFrame(
  frame: AgentWorkFrame,
  actionId: string,
): AgentWorkFrame | undefined {
  if (frame.following) {
    const following = workflowActionFrame(frame.following, actionId);
    return following && { ...frame, following };
  }
  const message = frame.messages.find((item) => item.id === "demo_workflow");
  const text = message?.parts.find((part) => part.type === "text")?.text;
  const sample = Object.values(workflowProgress).find(
    (progress) =>
      progress.text === text ||
      Object.values(progress.transitions).some((transition) => transition.text === text),
  );
  if (!sample) return;
  let transition: keyof typeof sample.transitions;
  switch (actionId) {
    case "demo_workflow_pause":
      transition = "paused";
      break;
    case "demo_workflow_resume":
      transition = "resumed";
      break;
    case "demo_workflow_cancel":
      transition = "cancelled";
      break;
    default:
      return;
  }
  return workflowCardFrame(sample.transitions[transition]);
}

const workflowExamples: {
  key: keyof typeof workflowProgress;
  label: string;
  description: string;
}[] = [
  {
    key: "queued",
    label: "Queued",
    description: "Accepted before any steps start. Try Pause or Cancel.",
  },
  {
    key: "starting",
    label: "Starting",
    description: "One agent is starting; another step is queued.",
  },
  {
    key: "parallel",
    label: "Parallel steps",
    description: "Weather and opening hours run together.",
  },
  {
    key: "partial",
    label: "Partial results",
    description: "One step completes while another continues and an alternate step stops.",
  },
  {
    key: "running",
    label: "Phase progress",
    description: "Research is complete. Route planning runs before the coffee-stop step.",
  },
  {
    key: "blocked",
    label: "Blocked",
    description: "An agent operation is blocked. Pause and Cancel remain available.",
  },
  {
    key: "waiting",
    label: "Waiting",
    description: "A timed wait shows when the workflow resumes.",
  },
  {
    key: "reply",
    label: "Waiting for reply · Discord only",
    description:
      "A Discord-origin workflow needs a reply in Discord. Native workflows cannot create reply waits.",
  },
  {
    key: "paused",
    label: "Paused",
    description: "Try Resume to return to running, or Cancel to stop.",
  },
  {
    key: "resumed",
    label: "Resumed",
    description: "After resuming, the card returns to Running with its existing progress.",
  },
  {
    key: "succeeded",
    label: "Succeeded",
    description:
      "All steps complete. The result replaces the recent-operation list and controls disappear.",
  },
  {
    key: "failed",
    label: "Failed",
    description: "The failure reason and completed research remain visible.",
  },
  {
    key: "timeout",
    label: "Step timed out",
    description: "A timed-out step stays visible while a fallback step runs.",
  },
  {
    key: "stepFailed",
    label: "Step failed",
    description: "A failed step stays visible while a fallback step runs.",
  },
  {
    key: "cancelled",
    label: "Cancelled",
    description: "Stopped steps and the cancellation reason remain visible.",
  },
  {
    key: "attention",
    label: "Needs attention",
    description: "An operation's outcome is uncertain. Only Cancel is available.",
  },
  {
    key: "scheduled",
    label: "Scheduled next run",
    description: "A recurring workflow shows its next run time.",
  },
  {
    key: "largeResult",
    label: "Result stored separately",
    description: "A large result directs you to ask Lilac for the full output.",
  },
  {
    key: "noResult",
    label: "Succeeded without output",
    description: "A successful run can finish without a result block.",
  },
  {
    key: "shortenedResult",
    label: "Shortened result",
    description: "A long result is shortened with a prompt to ask for the full output.",
  },
  {
    key: "sensitive",
    label: "Sensitive result",
    description: "Sensitive workflow output and phase names stay hidden.",
  },
  {
    key: "manyPhases",
    label: "Many phases",
    description: "Every phase shows its own progress.",
  },
];

export const workflowStages: AgentWorkStage[] = [
  {
    id: "workflow",
    label: "Workflow · full run",
    description:
      "Play from queued to succeeded, or use the frame arrows. Pause, Resume, and Cancel update this demo locally.",
    frames: (["queued", "starting", "parallel", "running", "succeeded"] as const).map(
      workflowFrame,
    ),
  },
  ...workflowExamples.map(({ key, label, description }) => ({
    id: `workflow-${key}`,
    label: `Workflow · ${label}`,
    description,
    frames: [workflowFrame(key)],
  })),
];
const prompt: DisplayMessage = {
  id: "demo_prompt",
  role: "user",
  metadata: { authorId: "demo_user", createdAt: demoTime, inputMode: "prompt" },
  parts: [
    {
      type: "text",
      text: "Compare a riverside walk with a museum visit for Saturday. Check the weather and opening hours, then recommend a plan.",
    },
  ],
};
function activity(
  id: string,
  kind: Activity["data"]["kind"],
  label: string,
  state: Activity["data"]["state"],
  detail: string,
  durationMs?: number,
): Activity {
  return { type: "data-activity", id, data: { kind, label, state, detail, durationMs } };
}
function tool(id: string, data: Activity["data"]): Activity {
  return { type: "data-activity", id, data };
}
function message(
  id: string,
  parts: DisplayPart[],
  phase: "commentary" | "final" = "commentary",
): DisplayMessage {
  return {
    id,
    role: "assistant",
    metadata: { authorId: "demo_agent", createdAt: demoTime + 3000, phase },
    parts,
  };
}
function turn(
  messages: DisplayMessage[],
  state: ReadyTurnSlot["state"] = "running",
): ReadyTurnSlot {
  const settled = state === "complete" || state === "failed" || state === "canceled";
  return {
    kind: "ready",
    slotId: "demo_slot",
    turnId: "demo_turn",
    position: 0,
    state,
    startedAt: demoTime,
    ...(settled ? { settledAt: demoTime + 12_400 } : {}),
    messages: [prompt, ...messages],
  };
}
/** The question the "Needs input" stage asks, as a pending native question for the demo viewer. */
export const demoQuestion: Extract<DisplayPart, { type: "data-question" }>["data"] = (() => {
  const prompts = [
    {
      header: "Plan",
      question: "Would you prefer an outdoor plan or a quieter indoor visit?",
      options: [
        ["Riverside walk", "Best if Saturday morning stays dry."],
        ["Museum visit", "Open 10:00–18:00 and unaffected by rain."],
      ],
    },
    {
      header: "Start time",
      question: "When should the day start?",
      options: [
        ["Morning", "Leave around 9:00 to beat the crowds."],
        ["Afternoon", "Start after lunch, around 13:00."],
      ],
    },
  ].map((source, position, all) => ({
    ordinal: position + 1,
    total: all.length,
    header: source.header,
    question: source.question,
    options: source.options.map(([label, description], index) => ({
      index: index + 1,
      label: label!,
      description: description!,
      token: `demo-question-${position}-${index}`,
    })),
    customToken: `demo-question-${position}-custom`,
  }));
  return {
    questionCallId: "demo_question",
    requestId: "demo_request",
    respondentId: "demo_user",
    historyGeneration: 0,
    mode: "deferred",
    prompts,
    view: { state: "pending", prompt: prompts[0]! },
  };
})();
const demoQuestionMessage = message("demo_question", [
  { type: "data-question", id: "demo_question", data: demoQuestion },
]);
const thought = activity(
  "demo_think",
  "thinking",
  "Thinking",
  "complete",
  "**Comparing both plans**\n\nThe forecast decides between them. A dry morning favors the riverside walk; rain points to the museum, so I need its Saturday hours as a fallback.",
  2100,
);
const forecast = tool("demo_forecast", toolActivities.forecast.settled);
const notes = tool("demo_notes", toolActivities.notes.settled);
const routeMap = tool("demo_route_map", toolActivities.routeMap.settled);
const weather = tool("demo_weather", toolActivities.weather.settled);
const hours = tool("demo_hours", toolActivities.hours.settled);
const notesSearch = tool("demo_notes_search", toolActivities.notesSearch.settled);
const hoursAndNotes = tool("demo_hours_notes", toolActivities.hoursAndNotes.settled);
const planEdit = tool("demo_plan_edit", toolActivities.planEdit.settled);
const work = message("demo_work", [
  thought,
  notes,
  routeMap,
  notesSearch,
  forecast,
  weather,
  hours,
]);
const commentary = message("demo_commentary", [
  {
    type: "text",
    text: "The weather looks good for a walk. I'll check the museum as a backup before choosing.",
  },
]);
const multiple = [
  message("demo_reasoning", [thought]),
  commentary,
  message("demo_tools", [forecast, hoursAndNotes, planEdit]),
  message("demo_comparison", [
    {
      type: "text",
      text: "Both options fit. Here's the comparison:\n\n| Plan | Best for | Time |\n| --- | --- | --- |\n| Riverside walk | Fresh air, flexible stops | 2 hours |\n| Museum | Rainy weather, a quieter pace | 90 minutes |",
    },
  ]),
  message("demo_followup_work", [tool("demo_route", toolActivities.firstRoute.running)]),
];
const answer = [
  "I'd choose the **riverside walk** for Saturday and keep the museum as a backup. The forecast is mild at 18°C, with light cloud and only a small chance of rain. That makes the river the more flexible choice, especially if you want time to stop along the way.",
  "Start at Sanjo Station around 10:00 and walk north beside the water. The full route takes about two hours, but you can turn back whenever you like. There are several bridges, so shortening the walk does not require retracing the whole route.",
  "Plan a coffee stop after the first stretch. A café with indoor seating gives you somewhere to rest if the wind picks up, and it keeps the morning relaxed. Leave a little room in the schedule for photos or a detour through the nearby streets.",
  "If the weather changes, switch to the museum. It is open from 10:00 to 18:00, with last admission at 17:30, so you can make that call after breakfast. Allow about 90 minutes for the visit and another 15 minutes for the bus ride from the riverside area.",
  "For the afternoon, keep the plan open. You could return to the river for a shorter stroll, browse nearby shops, or stay longer at the museum if an exhibition catches your eye. The two options are close enough that you do not need to commit to both in advance.",
  "Bring a light jacket and comfortable shoes. No reservation is needed for the walk; check the museum's ticket page before leaving if you decide to go indoors.",
].join("\n\n");
const final = message("demo_final", [{ type: "text", text: answer }], "final");
const paragraphs = answer.split("\n\n");
const streamFrames = paragraphs.map((_paragraph, index) =>
  turn([
    work,
    commentary,
    {
      ...final,
      parts: [
        {
          type: "text",
          text:
            paragraphs.slice(0, index + 1).join("\n\n") +
            (index < paragraphs.length - 1 ? "\n\n" : ""),
        },
      ],
    },
  ]),
);

const introduction = message("demo_introduction", [
  { type: "text", text: "I'll compare both plans and check the conditions for Saturday." },
]);
const firstWork = message("demo_first_work", [
  tool("demo_first_tool", toolActivities.firstRoute.settled),
]);
const steer = (id: string, authorId: string, text: string, offset: number): DisplayMessage => ({
  id,
  role: "user",
  metadata: { authorId, inputMode: "steer", createdAt: demoTime + offset },
  parts: [{ type: "text", text }],
});
const ownSteer = steer(
  "demo_own_steer",
  "demo_user",
  "Keep the walking part under an hour, please.",
  25_000,
);
const otherSteer = steer(
  "demo_other_steer",
  "demo_other_user",
  "Let's include a café with indoor seating too.",
  55_000,
);
const afterSteer = [
  message("demo_steer_thought", [
    activity(
      "demo_steer_think",
      "thinking",
      "Compared shorter routes",
      "complete",
      "A shorter river loop leaves time for a café stop.",
      5000,
    ),
  ]),
  message("demo_steer_commentary", [
    { type: "text", text: "I'll shorten the walk and look for a coffee stop along the way." },
  ]),
];
const nextTool = (data: Activity["data"]) =>
  message("demo_steer_work", [tool("demo_steer_tool", data)]);
const firstSteering = [
  introduction,
  firstWork,
  ownSteer,
  ...afterSteer,
  nextTool(toolActivities.shorterRoute.running),
];
const secondSteering = [
  introduction,
  firstWork,
  ownSteer,
  ...afterSteer,
  nextTool(toolActivities.shorterRoute.settled),
  otherSteer,
  message("demo_cafe_thought", [
    activity(
      "demo_cafe_think",
      "thinking",
      "Compared indoor stops",
      "complete",
      "Choose a café near the station in case it rains.",
      5000,
    ),
  ]),
  message("demo_cafe_commentary", [
    {
      type: "text",
      text: "I'll include an indoor café near the station, with the museum as an optional stop.",
    },
  ]),
];
const steeredFinal = message(
  "demo_steered_final",
  [
    {
      type: "text",
      text: "Take the **45-minute riverside loop** from Sanjo Station, then stop at a café with indoor seating. Keep the museum as an optional rainy-day alternative.",
    },
  ],
  "final",
);
const finalSteering = {
  ...turn([...secondSteering, steeredFinal], "complete"),
  settledAt: demoTime + 240_000,
};

const delegation = message("demo_delegation", [
  {
    type: "text",
    text: "I'll ask one subagent to check the weather and another to check the museum. Meanwhile, I'll compare travel times.",
  },
]);
function subagent(id: string, data: Activity["data"]) {
  return message(id, [tool(id, data)]);
}
const weatherSubagent = subagent("demo_subagent_weather", subagentActivities.weather.working);
const museumSubagent = subagent("demo_subagent_museum", subagentActivities.museum.working);
const weatherSubagentDone = subagent("demo_subagent_weather", subagentActivities.weather.done);
const museumSubagentDone = subagent("demo_subagent_museum", subagentActivities.museum.done);
const subagentUpdate = message("demo_subagent_update", [
  {
    type: "text",
    text: "The weather check is back: mild and dry, with the riverside path open. The museum check is still running.",
  },
]);
const parentRouteDone = message("demo_parent_work", [
  tool("demo_parent_route", toolActivities.travelTimes.settled),
]);

const foldedActivityMessages = [
  message("demo_old_thought", [
    activity("thinking", "thinking", "Thinking", "complete", "Compared both options."),
  ]),
  message("demo_first_update", [{ type: "text", text: "The route comparison is ready." }]),
  message("demo_background_agent", [
    tool("demo_subagent_museum", subagentActivities.museum.started),
  ]),
  message("demo_second_update", [
    { type: "text", text: "The agent is checking opening hours while I finish the plan." },
  ]),
  message("demo_latest_thought", [
    activity(
      "demo_latest_think",
      "thinking",
      "Thinking",
      "running",
      "Finishing the recommendation.",
    ),
  ]),
];

export const agentWorkStages: AgentWorkStage[] = [
  {
    id: "grouped-messages",
    label: "Grouped messages",
    description:
      "A deferred post shares the completed reply’s avatar, including older queued timestamps.",
    frames: [
      {
        ...turn([], "complete"),
        messages: [
          message("grouped_work", [forecast]),
          message(
            "grouped_first",
            [{ type: "text", text: "The forecast is ready. The morning looks clear." }],
            "final",
          ),
        ],
        following: {
          kind: "ready",
          slotId: "grouped_post",
          turnId: "grouped_post",
          position: 1,
          state: "complete",
          messages: [
            {
              ...message(
                "grouped_post",
                [{ type: "text", text: "Bring a light jacket for the riverside walk." }],
                "final",
              ),
              metadata: { authorId: "demo_agent", createdAt: demoTime - 30_000, phase: "final" },
            },
          ],
        },
      },
    ],
  },
  {
    id: "surface-message",
    label: "Cross-thread message",
    description: "An incoming agent message stays visible above the destination run's work.",
    frames: [
      {
        ...turn([], "complete"),
        messages: [
          {
            ...message(
              "demo_surface_message",
              [{ type: "text", text: "Notification test. Did your phone blink?" }],
              "final",
            ),
            metadata: {
              authorId: "demo_agent",
              createdAt: demoTime,
              phase: "final",
              inputId: "demo_surface_input",
              inputMode: "prompt",
            },
          },
          message("demo_surface_recall", [
            activity(
              "demo_surface_recall",
              "tool",
              "conversation_thread_search auto-injected metadata",
              "complete",
              "Related conversation context was added to the destination run.",
            ),
          ]),
        ],
      },
    ],
  },
  {
    id: "sent",
    label: "Message sent",
    description: "The agent shows Thinking immediately after sending.",
    frames: [
      {
        ...turn([], "pending"),
        messages: [
          {
            ...prompt,
            parts: [
              ...prompt.parts,
              { type: "data-input-state", id: "demo_input", data: { state: "queued" } },
            ],
          },
        ],
      },
    ],
  },
  {
    id: "thinking",
    label: "Thinking",
    description: "A running reasoning block. Expand it to inspect its sample detail.",
    frames: [
      turn([
        message("demo_work", [
          activity(
            "demo_think",
            "thinking",
            "Thinking…",
            "running",
            "Sample reasoning summary: weighing an outdoor plan against an indoor alternative.",
          ),
        ]),
      ]),
    ],
  },
  {
    id: "folded-activity-running",
    label: "Folded activity running",
    description: "Only the last section and the section with a running agent shine.",
    frames: [turn(foldedActivityMessages)],
  },
  {
    id: "folded-activity-complete",
    label: "Folded activity complete",
    description: "Completed work stops shining even when activity records still say running.",
    frames: [turn([...foldedActivityMessages, final], "complete")],
  },
  {
    id: "tool-call",
    label: "Tool call",
    description: "Completed reasoning followed by a running tool.",
    frames: [
      turn([message("demo_work", [thought, tool("demo_weather", toolActivities.weather.running)])]),
    ],
  },
  {
    id: "parallel-tools",
    label: "Parallel tools",
    description: "Two tools running in the same activity group.",
    frames: [
      turn([
        message("demo_work", [
          thought,
          tool("demo_weather", toolActivities.weather.running),
          tool("demo_hours", toolActivities.hours.running),
        ]),
      ]),
    ],
  },
  {
    id: "tool-results",
    label: "Tool results",
    description: "Completed tools with durations and expandable results.",
    frames: [turn([work, commentary])],
  },
  {
    id: "multiple-blocks",
    label: "Multiple blocks",
    description: "Reasoning, commentary, tools, a table, and another tool call interleaved.",
    frames: [turn(multiple)],
  },
  {
    id: "subagents-working",
    label: "Subagents · working",
    description: "Two subagents work in parallel while the parent checks travel times.",
    frames: [
      turn([
        delegation,
        weatherSubagent,
        museumSubagent,
        message("demo_parent_work", [
          tool("demo_parent_route", toolActivities.travelTimes.running),
        ]),
      ]),
    ],
  },
  {
    id: "subagents-results",
    label: "Subagents · partial results",
    description: "One subagent finishes; the parent shares an update while the other continues.",
    frames: [
      turn([delegation, weatherSubagentDone, museumSubagent, parentRouteDone, subagentUpdate]),
    ],
  },
  {
    id: "subagents-complete",
    label: "Subagents · complete",
    description: "Both subagents finish. Expand the work summary to inspect their progress.",
    frames: [
      {
        ...turn(
          [
            delegation,
            weatherSubagentDone,
            museumSubagentDone,
            parentRouteDone,
            subagentUpdate,
            final,
          ],
          "complete",
        ),
        settledAt: demoTime + 60_000,
      },
    ],
  },
  ...workflowStages,
  {
    id: "streaming",
    label: "Paragraph streaming",
    description:
      "Play to watch a longer answer arrive one paragraph at a time. Pause to inspect a partial answer.",
    frames: streamFrames,
  },
  {
    id: "complete",
    label: "Complete",
    description: "The final answer stays visible; prior work collapses into the work summary.",
    frames: [turn([work, commentary, final], "complete")],
  },
  {
    id: "full-turn-working",
    label: "Full turn · working",
    description:
      "One agent avatar introduces commentary, thinking, another update, and a running tool.",
    frames: [
      turn([
        introduction,
        message("demo_full_thought", [thought]),
        commentary,
        message("demo_full_tool", [tool("demo_full_call", toolActivities.hours.running)]),
      ]),
    ],
  },
  {
    id: "full-turn-complete",
    label: "Full turn · complete",
    description:
      "The same turn settles into one work summary above the final response. Expand to inspect earlier updates.",
    frames: [
      {
        ...turn(
          [
            introduction,
            message("demo_full_thought", [thought]),
            commentary,
            message("demo_full_tool", [hours]),
            final,
          ],
          "complete",
        ),
        settledAt: demoTime + 120_000,
      },
    ],
  },
  {
    id: "steering",
    label: "Steering · your update",
    description:
      "Your steering prompt stays right aligned and starts a new agent group. Earlier commentary stays visible while work continues.",
    frames: [turn(firstSteering)],
  },
  {
    id: "steering-other",
    label: "Steering · another participant",
    description: "Another participant's prompt stays left aligned, followed by a new agent group.",
    frames: [turn(secondSteering)],
  },
  {
    id: "steering-complete",
    label: "Steering · complete",
    description:
      "All intermediate work and steering prompts collapse together, with the final response below.",
    frames: [finalSteering],
  },
  {
    id: "needs-input",
    label: "Needs input",
    description:
      "A deferred question. The composer answers one prompt at a time; replies only update this demo.",
    frames: [turn([message("demo_work", [thought]), demoQuestionMessage], "complete")],
  },
  {
    id: "compacting",
    label: "Compacting context",
    description: "A context-compaction marker between activity and commentary.",
    frames: [
      turn([
        work,
        message("demo_compact", [
          {
            type: "data-compaction",
            id: "demo_compaction",
            data: { state: "running", beforeCount: 128 },
          },
        ]),
      ]),
    ],
  },
  {
    id: "tool-error",
    label: "Tool failed",
    description: "A failed tool while the agent is still working on a fallback.",
    frames: [
      turn([
        message("demo_work", [
          thought,
          tool("demo_weather", toolActivities.forecastTimeout.settled),
        ]),
        message("demo_fallback", [
          { type: "text", text: "The forecast service timed out. I'll use another source." },
        ]),
      ]),
    ],
  },
  {
    id: "failed",
    label: "Run failed",
    description: "A failed run with its partial work preserved in the expandable summary.",
    frames: [
      turn(
        [
          message("demo_work", [
            thought,
            tool("demo_weather", toolActivities.forecastUnavailable.settled),
          ]),
        ],
        "failed",
      ),
    ],
  },
  {
    id: "canceled",
    label: "Canceled",
    description: "A stopped run with completed work and partial commentary preserved.",
    frames: [turn([work, commentary], "canceled")],
  },
];

const flowStages = [
  "sent",
  "thinking",
  "tool-call",
  "parallel-tools",
  "tool-results",
  "workflow",
  "streaming",
  "complete",
];
export const conversationFrames = flowStages
  .flatMap((id) => {
    const frames = agentWorkStages.find((stage) => stage.id === id)!.frames;
    if (id === "workflow") return frames.map((card) => ({ ...turn([work]), following: card }));
    if (id === "streaming" || id === "complete")
      return frames.map((frame) => ({ ...frame, following: workflowFrame("succeeded") }));
    return frames;
  })
  .map((frame) => ({
    ...frame,
    messages: frame.messages.map((message) => ({
      ...message,
      parts: message.parts.map((part) => {
        if (part.type !== "data-activity") return part;
        const { detail: _detail, durationMs: _duration, ...data } = part.data;
        return {
          ...part,
          data: { ...data, ...(data.kind === "tool" ? { detail: data.label } : {}) },
        };
      }),
    })),
  }));
agentWorkStages.unshift({
  id: "conversation",
  label: "Send to completion",
  description: "Send a message to watch the same timeline and composer used in a thread.",
  frames: conversationFrames,
});

const demoSubagentSamples = {
  demo_subagent_weather: {
    profile: "restricted",
    name: "Weather and riverside",
    sample: "weather",
  },
  demo_subagent_museum: { profile: "full", name: "Museum visit", sample: "museum" },
} as const;

function demoSubagentSample(id: string) {
  return id in demoSubagentSamples
    ? demoSubagentSamples[id as keyof typeof demoSubagentSamples]
    : undefined;
}

export function demoSubagents(slot: ReadyTurnSlot): SubagentSummary[] {
  return slot.messages.flatMap((message) =>
    message.parts.flatMap((part) => {
      if (part.type !== "data-activity") return [];
      const sample = demoSubagentSample(part.id);
      if (!sample) return [];
      const running = part.data.state === "running";
      // Core titles a running subagent with its active tool's name.
      const activeTool = subagentTranscripts[sample.sample].running
        .flatMap((child) => child.parts)
        .findLast((child) => child.type === "data-activity" && child.data.state === "running");
      const title = activeTool?.type === "data-activity" ? activeTool.data.label : "Thinking…";
      return [
        {
          id: part.id,
          activityId: part.id,
          turnId: slot.turnId,
          profile: sample.profile,
          name: sample.name,
          state: part.data.state,
          title: running ? title : "Completed",
          startedAt: demoTime + 3000,
        },
      ];
    }),
  );
}

export function demoSubagentTranscript(agent: SubagentSummary): DisplayMessage[] {
  const sample = demoSubagentSample(agent.id);
  if (!sample) return [];
  return subagentTranscripts[sample.sample][agent.state === "running" ? "running" : "complete"];
}
