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

test("every result on the board is plain text, so short Markdown cannot embed images", () => {
  const text = Array.from({ length: 6 }, (_, index) => `![a](/a${index}.png)`).join(" ");
  const html = render({ ...base, result: { kind: "text", text, truncated: false } }, "preview");
  expect(html).toContain('data-ui="workflow-text-preview"');
  expect(html).not.toContain("<img");
  expect(render({ ...base, result: { kind: "text", text, truncated: false } }, "full")).toContain(
    "<img",
  );
});
