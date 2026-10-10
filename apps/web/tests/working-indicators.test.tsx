import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { agentWorkStages } from "../src/agent-work-fixtures";
import { MessageServicesContext } from "../src/components/message-services";
import { Turn } from "../src/components/Timeline";
import { WorkingIndicatorsContext } from "../src/components/WorkVerb";
import {
  pastTense,
  rememberShownWorkingIndicator,
  settledWorkingIndicatorBucket,
  workingIndicatorAt,
  workingIndicatorBucket,
  WORKING_INDICATOR_INTERVAL_MS,
} from "../src/working-indicators";

const words = ["Brewing", "Photosynthesizing", "Tiptoeing", "Tuning", "Humming"];

test("past tense replaces a trailing -ing", () => {
  expect(
    ["Brewing", "Composing", "Humming", "Tiptoeing", "Origami-ing", "WORKING", "Zest"].map(
      pastTense,
    ),
  ).toEqual(["Brewed", "Composed", "Hummed", "Tiptoed", "Origami-ed", "WORKED", "Zest"]);
});

test("a turn picks the same word sequence everywhere and never repeats a word back to back", () => {
  const sequence = Array.from({ length: 50 }, (_, bucket) =>
    workingIndicatorAt(words, "turn_1", bucket),
  );
  expect(sequence).toEqual(
    Array.from({ length: 50 }, (_, bucket) => workingIndicatorAt(words, "turn_1", bucket)),
  );
  for (let index = 1; index < sequence.length; index += 1)
    expect(sequence[index]).not.toBe(sequence[index - 1]);
  expect(new Set(sequence).size).toBeGreaterThan(1);
  expect(workingIndicatorAt([], "turn_1", 3)).toBe("Working");
});

test("buckets advance once per interval", () => {
  expect(workingIndicatorBucket(-5)).toBe(0);
  expect(workingIndicatorBucket(WORKING_INDICATOR_INTERVAL_MS - 1)).toBe(0);
  expect(workingIndicatorBucket(WORKING_INDICATOR_INTERVAL_MS * 3)).toBe(3);
});

function render(id: string, indicators?: readonly string[]) {
  const slot = agentWorkStages.find((stage) => stage.id === id)!.frames[0]!;
  const turn = (
    <MessageServicesContext
      value={{ canEdit: false, resourceUrl: () => "", onAction: () => {}, onReaction: () => {} }}
    >
      <Turn slot={slot} onRewind={() => {}} onLoadMore={() => {}} />
    </MessageServicesContext>
  );
  return {
    slot,
    html: renderToStaticMarkup(
      indicators ? (
        <WorkingIndicatorsContext value={indicators}>{turn}</WorkingIndicatorsContext>
      ) : (
        turn
      ),
    ),
  };
}

test("a settled turn shows the past tense of the word it ended on", () => {
  const { slot, html } = render("complete", words);
  const duration = slot.settledAt! - slot.startedAt!;
  const word = workingIndicatorAt(words, slot.turnId, workingIndicatorBucket(duration));
  expect(html).toContain(`${pastTense(word)} for 12s`);
  expect(render("complete").html).toContain("Worked for 12s");
});

test("a running turn shows a rotating word in place of Working", () => {
  const { html } = render("full-turn-working", words);
  expect(html).toMatch(
    /class="work-verb-word">(Brewing|Photosynthesizing|Tiptoeing|Tuning|Humming)</u,
  );
  expect(html).not.toContain("Working for");
});

test("a turn watched live settles on the bucket it last showed", () => {
  expect(settledWorkingIndicatorBucket("turn_unseen", WORKING_INDICATOR_INTERVAL_MS * 5)).toBe(5);
  rememberShownWorkingIndicator("turn_seen", 4);
  expect(settledWorkingIndicatorBucket("turn_seen", WORKING_INDICATOR_INTERVAL_MS * 5)).toBe(4);
});
