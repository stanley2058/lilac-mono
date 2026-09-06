import { expect, test } from "bun:test";
import { createAgentEventChannel } from "../agent-execution-events";
import type { AgentExecutionEvent } from "../agent-adapter";

function output(sequence: number): AgentExecutionEvent {
  return {
    attemptId: "attempt",
    sequence,
    type: "output",
    output: {
      id: "text",
      kind: "text",
      phase: "delta",
      delta: String(sequence),
    },
  };
}

test("adapter output buffers independently of consumption and drains after close", async () => {
  const channel = createAgentEventChannel();
  expect(channel.push(output(0))).toBe(true);
  expect(channel.push(output(1))).toBe(true);
  channel.close();
  expect(channel.push(output(2))).toBe(false);
  const received = [];
  for await (const event of channel.events) received.push(event.sequence);
  expect(received).toEqual([0, 1]);
});

test("concurrent reads consume a single ordered stream and close settles pending readers", async () => {
  const channel = createAgentEventChannel();
  const iterator = channel.events[Symbol.asyncIterator]();
  const first = iterator.next();
  const second = iterator.next();
  const third = iterator.next();
  channel.push(output(0));
  channel.push(output(1));
  channel.close();
  expect(await first).toEqual({ done: false, value: output(0) });
  expect(await second).toEqual({ done: false, value: output(1) });
  expect(await third).toEqual({ done: true, value: undefined });
});

test("returning the iterator disposes buffered output and closes the stream", async () => {
  const channel = createAgentEventChannel();
  channel.push(output(0));
  const iterator = channel.events[Symbol.asyncIterator]();
  expect(iterator.return).toBeDefined();
  await iterator.return?.();
  expect(await iterator.next()).toEqual({ done: true, value: undefined });
  expect(channel.push(output(1))).toBe(false);
});
