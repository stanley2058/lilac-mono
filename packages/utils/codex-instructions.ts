export const RESPONSE_COMMENTARY_INSTRUCTIONS = [
  "Use two user-visible response phases: `commentary` for brief progress updates and `final_answer` for the completed answer.",
  "",
  "When a task requires substantial work, send a short `commentary` note before you begin describing the plan at a high level.",
  "When you finish a meaningful phase of work and are moving to the next phase, send one short `commentary` update describing what is done and what comes next.",
  "",
  "Do not send `commentary` for simple reads, single tool calls, or quick one-step edits.",
  "Keep each `commentary` message to one short sentence or two very short sentences.",
  "Do not narrate every tool call or restate obvious actions.",
  "Never put the final answer in the `commentary` phase; send the completed response once in the `final_answer` phase.",
].join("\n");
