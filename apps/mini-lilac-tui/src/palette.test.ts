import { describe, expect, it } from "bun:test";

import {
  COMMAND_PALETTE_ITEMS,
  filterPaletteItems,
  isSlashPaletteKey,
  movePaletteIndex,
  nextProfile,
  reasoningPaletteItems,
  sessionPaletteItems,
  skillPaletteItems,
  todoFloatingSummary,
  todoPaletteItems,
} from "./palette";

describe("palette helpers", () => {
  it("recognizes slash and wraps menu navigation", () => {
    expect(isSlashPaletteKey({ name: "slash", sequence: "/" })).toBe(true);
    expect(movePaletteIndex(0, -1, 3)).toBe(2);
    expect(movePaletteIndex(2, 1, 3)).toBe(0);
  });

  it("fuzzy-filters commands and model-like labels", () => {
    expect(filterPaletteItems(COMMAND_PALETTE_ITEMS, "un").map((item) => item.id)).toEqual([
      "undo",
    ]);
    expect(
      filterPaletteItems(
        [
          { id: "openrouter/alpha", label: "Alpha" },
          { id: "openrouter/gpt-5", label: "GPT 5" },
        ],
        "or/g5",
      ).map((item) => item.id),
    ).toEqual(["openrouter/gpt-5"]);
  });

  it("ranks an exact command before matches in descriptions", () => {
    expect(filterPaletteItems(COMMAND_PALETTE_ITEMS, "session").map((item) => item.id)).toEqual([
      "session",
      "new",
      "compact",
    ]);
  });

  it("offers manual compaction in the command palette", () => {
    expect(COMMAND_PALETTE_ITEMS.map((item) => item.id)).toContain("new");
    expect(COMMAND_PALETTE_ITEMS.map((item) => item.id)).toContain("todo");
    expect(COMMAND_PALETTE_ITEMS.map((item) => item.id)).toContain("compact");
    expect(COMMAND_PALETTE_ITEMS.map((item) => item.id)).toContain("session");
    expect(COMMAND_PALETTE_ITEMS.map((item) => item.id)).toContain("skills");
  });

  it("projects the current todo with aggregate counts and falls back to the first item", () => {
    const state = {
      revision: 4,
      todos: [
        { content: "Oldest", status: "completed" as const, priority: "low" as const },
        { content: "Previous", status: "completed" as const, priority: "medium" as const },
        { content: "Current", status: "in_progress" as const, priority: "high" as const },
        { content: "Next", status: "pending" as const, priority: "high" as const },
        { content: "Later", status: "pending" as const, priority: "low" as const },
        { content: "Dropped", status: "cancelled" as const, priority: "low" as const },
      ],
    };

    expect(todoFloatingSummary(state)).toEqual({
      todo: { content: "Current", status: "in_progress", priority: "high" },
      index: 2,
      completed: 2,
      coming: 2,
    });
    expect(
      todoPaletteItems(state).map(({ label, description }) => ({ label, description })),
    ).toEqual([
      { label: "[✓] Oldest", description: "low" },
      { label: "[✓] Previous", description: "medium" },
      { label: "[•] Current", description: "high" },
      { label: "[ ] Next", description: "high" },
      { label: "[ ] Later", description: "low" },
      { label: "[-] Dropped", description: "low" },
    ]);
    expect(
      todoFloatingSummary({
        revision: 1,
        todos: [
          { content: "First", status: "pending", priority: "low" },
          { content: "Second", status: "completed", priority: "high" },
        ],
      }),
    ).toEqual({
      todo: { content: "First", status: "pending", priority: "low" },
      index: 0,
      completed: 1,
      coming: 1,
    });
    expect(
      todoFloatingSummary({
        revision: 2,
        todos: [
          { content: "Done", status: "completed", priority: "low" },
          { content: "Dropped", status: "cancelled", priority: "low" },
        ],
      }),
    ).toBeUndefined();
  });

  it("makes skill names and descriptions searchable", () => {
    const items = skillPaletteItems([
      { name: "frontend-design", description: "Build deliberate terminal interfaces" },
      { name: "typehint", description: "Inspect TypeScript language server types" },
    ]);
    expect(items[0]).toEqual({
      id: "frontend-design",
      label: "frontend-design",
      description: "Build deliberate terminal interfaces",
    });
    expect(filterPaletteItems(items, "terminal").map((item) => item.id)).toEqual([
      "frontend-design",
    ]);
  });

  it("makes session titles, ids, status, and timestamps searchable", () => {
    const items = sessionPaletteItems([
      {
        id: "session-abc",
        activeRunId: null,
        status: "idle",
        cwd: "/workspace",
        model: "test/model",
        profile: "coding",
        reasoning: "low",
        title: "Fix reconnect handling",
        queuedSteeringCount: 0,
        updatedAt: "2026-07-22T12:00:00.000Z",
      },
    ]);

    expect(items).toEqual([
      {
        id: "session-abc",
        label: "Fix reconnect handling",
        description: "idle | 2026-07-22T12:00:00.000Z",
      },
    ]);
    expect(filterPaletteItems(items, "reconn")).toHaveLength(1);
    expect(filterPaletteItems(items, "sabc")).toHaveLength(1);
  });

  it("cycles only top-level profiles in one direction", () => {
    const profiles = [
      { id: "coding", label: "Coding", subagentOnly: false },
      { id: "research", label: "Research", subagentOnly: true },
      { id: "review", label: "Review", subagentOnly: false },
    ];
    expect(nextProfile(profiles, "coding")?.id).toBe("review");
    expect(nextProfile(profiles, "review")?.id).toBe("coding");
  });

  it("limits non-reasoning models to provider defaults or none", () => {
    expect(
      reasoningPaletteItems({
        id: "provider/plain",
        label: "Plain",
        supportsReasoning: false,
      }).map((item) => item.id),
    ).toEqual(["provider-default", "none"]);
  });
});
