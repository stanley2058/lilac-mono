/** Names one consumer of a work subscription; unique per process and per start. */
export function consumerId(prefix: string): string {
  return `${prefix}:${process.pid}:${Math.random().toString(16).slice(2)}`;
}
