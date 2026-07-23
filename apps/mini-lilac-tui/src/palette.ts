import {
  MINI_LILAC_REASONING_LEVELS,
  type MiniLilacModelSummary,
  type MiniLilacProfileSummary,
  type MiniLilacReasoning,
  type MiniLilacSessionSnapshot,
  type MiniLilacSkillSummary,
  type MiniLilacTodo,
  type MiniLilacTodoState,
} from "@stanley2058/mini-lilac-client";

export type PaletteKind = "commands" | "models" | "reasoning" | "sessions" | "skills" | "todos";

export interface PaletteItem {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly todoStatus?: MiniLilacTodo["status"];
}

export const COMMAND_PALETTE_ITEMS: readonly PaletteItem[] = [
  { id: "new", label: "/new", description: "start a new session" },
  { id: "todo", label: "/todo", description: "view all todos" },
  { id: "compact", label: "/compact", description: "compact session context" },
  { id: "undo", label: "/undo", description: "remove the latest turn" },
  { id: "model", label: "/model", description: "switch language model" },
  { id: "reasoning", label: "/reasoning", description: "change reasoning effort" },
  { id: "session", label: "/session", description: "switch to an old session" },
  { id: "skills", label: "/skills", description: "insert an available skill" },
];

export interface TodoFloatingSummary {
  readonly todo: MiniLilacTodo;
  readonly index: number;
  readonly completed: number;
  readonly coming: number;
}

export function todoMarker(status: MiniLilacTodo["status"]): "[✓]" | "[•]" | "[ ]" | "[-]" {
  if (status === "completed") return "[✓]";
  if (status === "in_progress") return "[•]";
  if (status === "cancelled") return "[-]";
  return "[ ]";
}

export function todoFloatingSummary(state: MiniLilacTodoState): TodoFloatingSummary | undefined {
  if (state.todos.length === 0) return undefined;
  const current = state.todos.findIndex((todo) => todo.status === "in_progress");
  const pending = state.todos.findIndex((todo) => todo.status === "pending");
  const index = current >= 0 ? current : pending;
  if (index < 0) return undefined;
  const todo = state.todos[index];
  if (todo === undefined) return undefined;
  return {
    todo,
    index,
    completed: state.todos.filter((item) => item.status === "completed").length,
    coming: state.todos.filter((item) => item.status === "pending").length,
  };
}

export function todoPaletteItems(state: MiniLilacTodoState): PaletteItem[] {
  return state.todos.map((todo, index) => ({
    id: `todo-${index}`,
    label: `${todoMarker(todo.status)} ${todo.content}`,
    description: todo.priority,
    todoStatus: todo.status,
  }));
}

export function modelPaletteItems(models: readonly MiniLilacModelSummary[]): PaletteItem[] {
  return models.map((model) => ({
    id: model.id,
    label: model.label,
    description: model.id === model.label ? model.provider : model.id,
  }));
}

export function reasoningPaletteItems(model: MiniLilacModelSummary | undefined): PaletteItem[] {
  const levels: readonly MiniLilacReasoning[] =
    model?.supportsReasoning === false
      ? ["provider-default", "none"]
      : (model?.reasoningLevels ?? MINI_LILAC_REASONING_LEVELS);
  return levels.map((level) => ({
    id: level,
    label: level === "provider-default" ? "provider default" : level,
  }));
}

export function sessionPaletteItems(sessions: readonly MiniLilacSessionSnapshot[]): PaletteItem[] {
  return sessions.map((session) => ({
    id: session.id,
    label: session.title ?? "Mini Lilac",
    description: [session.status, session.updatedAt ?? session.createdAt]
      .filter((value) => value !== undefined)
      .join(" | "),
  }));
}

export function skillPaletteItems(skills: readonly MiniLilacSkillSummary[]): PaletteItem[] {
  return skills.map((skill) => ({
    id: skill.name,
    label: skill.name,
    description: skill.description,
  }));
}

export function nextProfile(
  profiles: readonly MiniLilacProfileSummary[],
  currentProfile: string | undefined,
): MiniLilacProfileSummary | undefined {
  const selectable = profiles.filter((profile) => !profile.subagentOnly);
  if (selectable.length === 0) return undefined;
  const current = selectable.findIndex((profile) => profile.id === currentProfile);
  return selectable[(current + 1) % selectable.length];
}

export function movePaletteIndex(current: number, delta: number, length: number): number {
  if (length <= 0) return 0;
  return (current + delta + length) % length;
}

export function filterPaletteItems(items: readonly PaletteItem[], query: string): PaletteItem[] {
  const needle = query.toLowerCase().replace(/^\//, "").trim();
  if (needle.length === 0) return [...items];
  return items
    .map((item, index) => ({ item, index, rank: paletteItemRank(item, needle) }))
    .filter(
      (result): result is typeof result & { readonly rank: number } => result.rank !== undefined,
    )
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map((result) => result.item);
}

function paletteItemRank(item: PaletteItem, needle: string): number | undefined {
  const labels = [item.label.replace(/^\//u, ""), item.id].map((value) => value.toLowerCase());
  if (labels.some((value) => value === needle)) return 0;
  if (labels.some((value) => value.startsWith(needle))) return 1;
  if (labels.some((value) => value.includes(needle))) return 2;
  if (labels.some((value) => fuzzyIncludes(value, needle))) return 3;

  const description = item.description?.toLowerCase();
  if (description === undefined) return undefined;
  if (description.includes(needle)) return 4;
  return fuzzyIncludes(description, needle) ? 5 : undefined;
}

function fuzzyIncludes(value: string, needle: string): boolean {
  let offset = 0;
  for (const character of needle) {
    offset = value.indexOf(character, offset);
    if (offset < 0) return false;
    offset += 1;
  }
  return true;
}

export function isSlashPaletteKey(event: {
  readonly name: string;
  readonly sequence: string;
}): boolean {
  return event.name === "slash" || event.name === "/" || event.sequence === "/";
}
