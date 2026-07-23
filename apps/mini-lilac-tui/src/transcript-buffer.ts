import type { ChunkOutputSink, TranscriptEntry } from "./render";

export interface BufferedChunkOutput {
  readonly output: ChunkOutputSink;
  flush(): void;
  dispose(): void;
  snapshot(): readonly TranscriptEntry[];
}

export function createBufferedChunkOutput(
  idPrefix: string,
  initialEntries: readonly TranscriptEntry[],
  publish: (entries: readonly TranscriptEntry[]) => void,
  publishDelayMs = 16,
): BufferedChunkOutput {
  const entries = [...initialEntries];
  const indexes = new Map(entries.map((entry, index) => [entry.id, index]));
  let outputSequence = 0;
  let publishTimer: ReturnType<typeof setTimeout> | undefined;

  const publishNow = () => {
    if (publishTimer !== undefined) clearTimeout(publishTimer);
    publishTimer = undefined;
    publish([...entries]);
  };
  const schedulePublish = () => {
    if (publishTimer !== undefined) return;
    publishTimer = setTimeout(publishNow, publishDelayMs);
  };
  const replace = (id: string, update: (entry: TranscriptEntry) => TranscriptEntry) => {
    const index = indexes.get(id);
    const entry = index === undefined ? undefined : entries[index];
    if (index === undefined || entry === undefined) return;
    entries[index] = update(entry);
    schedulePublish();
  };

  return {
    output: {
      append: (entry) => {
        const id = `${idPrefix}:${++outputSequence}`;
        indexes.set(id, entries.length);
        entries.push({ id, ...entry });
        schedulePublish();
        return id;
      },
      update: (id, entry) => replace(id, () => ({ id, ...entry })),
      appendText: (id, delta) => replace(id, (entry) => ({ ...entry, text: entry.text + delta })),
      finish: (id) => replace(id, (entry) => ({ ...entry, streaming: false })),
    },
    flush: publishNow,
    dispose: () => {
      if (publishTimer !== undefined) clearTimeout(publishTimer);
      publishTimer = undefined;
    },
    snapshot: () => [...entries],
  };
}
