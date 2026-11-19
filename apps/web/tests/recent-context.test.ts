import { expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { contextCoversTurn, NextContextStartAfter } from "../src/components/RecentContext";

test("a context read from before a fast reply settled does not mark a new context", () => {
  const turn = { startedAt: 1_000, settledAt: 1_400 };
  // The last poll ran while the DM was idle, before this turn was sent.
  expect(contextCoversTurn(900, turn)).toBe(false);
  // It also ran during the turn, which had not settled yet.
  expect(contextCoversTurn(1_200, turn)).toBe(false);
  expect(contextCoversTurn(1_400, turn)).toBe(true);
  expect(contextCoversTurn(undefined, turn)).toBe(false);
  expect(contextCoversTurn(5, {})).toBe(true);
});

test("a standalone DM timeline reserves space for the next-context divider", () => {
  const html = renderToStaticMarkup(
    createElement(QueryClientProvider, {
      client: new QueryClient(),
      children: createElement(NextContextStartAfter, {
        threadId: "rail-demo-dm",
        turn: { settledAt: 1_400 },
        show: false,
      }),
    }),
  );
  expect(html).toContain('data-ui="next-context-start" aria-hidden="true"');
});
