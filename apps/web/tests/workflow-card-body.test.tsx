import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { WorkflowCard as WorkflowCardData } from "@stanley2058/lilac-client-protocol";
import { MessageServicesContext } from "../src/components/message-services";
import { WorkflowCard } from "../src/components/WorkflowCard";

const base: WorkflowCardData = {
  name: "audit-routes",
  description: "",
  status: "succeeded",
  startedAt: 1,
  endedAt: 2,
  progress: { completed: 1, queued: 0, active: 0, waiting: 0, failed: 0, cancelled: 0, total: 1 },
  phases: [],
  steps: [],
  agents: { used: 1, active: 0, queued: 0 },
  sensitive: false,
};

function render(card: WorkflowCardData, body: "scroll" | "preview" | "full") {
  return renderToStaticMarkup(
    <MessageServicesContext
      value={{
        canEdit: false,
        resourceUrl: (id) => id,
        onAction: () => {},
        onReaction: () => {},
      }}
    >
      <WorkflowCard messageId="card" card={card} body={body} />
    </MessageServicesContext>,
  );
}

const longResult: WorkflowCardData = {
  ...base,
  result: { kind: "json", text: `{"report":"${"x".repeat(5_000)}"}`, truncated: true },
};

test("a long result on the board is a short plain preview with no inner scrolling", () => {
  const html = render(longResult, "preview");
  expect(html).toContain('data-ui="workflow-text-preview"');
  expect(html).toContain("Shortened.");
  expect(html).not.toContain("overflow-y-auto");
  expect(html.length).toBeLessThan(5_000);
});

test("every result on the board is plain text, so short Markdown cannot embed images", () => {
  const text = Array.from({ length: 6 }, (_, index) => `![a](/a${index}.png)`).join(" ");
  const html = render({ ...base, result: { kind: "text", text, truncated: false } }, "preview");
  expect(html).toContain('data-ui="workflow-text-preview"');
  expect(html).not.toContain("<img");
  expect(render({ ...base, result: { kind: "text", text, truncated: false } }, "full")).toContain(
    "<img",
  );
});

test("many short lines also collapse", () => {
  const text = ["one", "two", "three", "four", "five"].join("\n");
  expect(
    render({ ...base, result: { kind: "text", text, truncated: false } }, "preview"),
  ).toContain('data-ui="workflow-text-preview"');
});

const longFailure: WorkflowCardData = {
  ...base,
  status: "failed",
  reason: "at frame\n".repeat(200),
};

test("a long failure reason previews on the board and stays bounded in the timeline", () => {
  expect(render(longFailure, "preview")).toContain('data-ui="workflow-text-preview"');
  expect(render(longFailure, "scroll")).toMatch(/data-ui="workflow-reason"[^>]*max-h-96/u);
});

test("the dialog shows full text with no inner scrolling, since the dialog itself scrolls", () => {
  for (const card of [longResult, longFailure]) {
    const html = render(card, "full");
    expect(html).not.toContain('data-ui="workflow-text-preview"');
    expect(html).not.toContain("max-h-96");
  }
  expect(render(longResult, "full")).toContain("x".repeat(5_000));
});

test("the timeline card keeps the full result in a bounded scroll area", () => {
  const html = render(longResult, "scroll");
  expect(html).toMatch(/data-ui="workflow-result-body"[^>]*max-h-96[^>]*overflow-y-auto/u);
});

test("the open control appears only where a card can open", () => {
  const open = renderToStaticMarkup(
    <WorkflowCard messageId="card" card={base} onOpen={() => {}} />,
  );
  expect(open).toContain('aria-label="Open workflow"');
  expect(render(base, "preview")).not.toContain("Open workflow");
});

test("the board preview limits a long description and many phases; the dialog shows them all", () => {
  const phases = Array.from({ length: 64 }, (_, index) => ({
    ...base.progress,
    name: `phase-${index}`,
  }));
  const card: WorkflowCardData = { ...base, description: "long ".repeat(200), phases };
  const preview = render(card, "preview");
  expect(preview).toContain("line-clamp-3");
  expect(preview).toContain("phase-5");
  expect(preview).not.toContain("phase-6<");
  expect(preview).toContain("+58");
  const full = render(card, "full");
  expect(full).not.toContain("line-clamp-3");
  expect(full).toContain("phase-63");
  expect(full).not.toContain('data-ui="workflow-phases-more"');
});

test("the copy control appears only where the card knows its run", () => {
  const known = renderToStaticMarkup(
    <WorkflowCard messageId="card" card={base} runId="wfrun:known" />,
  );
  expect(known).toContain('aria-label="Copy workflow ID"');
  expect(render(base, "scroll")).not.toContain("Copy workflow ID");
});

test("a running status keeps its spinner out of a paragraph", () => {
  const html = render({ ...base, status: "running", endedAt: undefined }, "scroll");
  expect(html).toMatch(/<div data-ui="workflow-status"/u);
  expect(html).not.toMatch(/<p [^>]*data-ui="workflow-status"/u);
});
