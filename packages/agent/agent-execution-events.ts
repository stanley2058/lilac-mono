import type { AgentExecutionEvent } from "./agent-adapter";

export type AgentEventChannel = {
  readonly events: AsyncIterable<AgentExecutionEvent>;
  push(event: AgentExecutionEvent): boolean;
  close(): void;
};

export function createAgentEventChannel(): AgentEventChannel {
  const queued: AgentExecutionEvent[] = [];
  const readers: Array<(result: IteratorResult<AgentExecutionEvent>) => void> = [];
  let closed = false;

  function close(): void {
    closed = true;
    for (const resolve of readers.splice(0)) resolve({ done: true, value: undefined });
  }

  const iterator: AsyncIterableIterator<AgentExecutionEvent> = {
    [Symbol.asyncIterator]() {
      return this;
    },
    next(): Promise<IteratorResult<AgentExecutionEvent>> {
      const event = queued.shift();
      if (event) return Promise.resolve({ done: false, value: event });
      if (closed) return Promise.resolve({ done: true, value: undefined });
      return new Promise((resolve) => readers.push(resolve));
    },
    return(): Promise<IteratorResult<AgentExecutionEvent>> {
      queued.length = 0;
      close();
      return Promise.resolve({ done: true, value: undefined });
    },
  };

  return {
    events: iterator,
    push(event) {
      if (closed) return false;
      const reader = readers.shift();
      if (reader) {
        reader({ done: false, value: event });
        return true;
      }
      queued.push(event);
      return true;
    },
    close,
  };
}
