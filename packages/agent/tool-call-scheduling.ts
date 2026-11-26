import { captureAgentPromise } from "./failure-adapters";

type ToolCallAccess = "read" | "effect" | "exclusive";

const READ_TOOLS = new Set(["read", "read_file", "grep", "glob", "fuzzy_search", "model_catalog"]);
const EXCLUSIVE_TOOLS = new Set([
  "write",
  "write_file",
  "edit",
  "edit_file",
  "patch",
  "apply_patch",
]);

function toolCallAccess(name: string): ToolCallAccess {
  const localName = name.startsWith("mcp__lilac__") ? name.slice("mcp__lilac__".length) : name;
  if (EXCLUSIVE_TOOLS.has(localName)) return "exclusive";
  if (READ_TOOLS.has(localName)) return "read";
  return "effect";
}

function canJoinGroup(group: ToolCallAccess, next: ToolCallAccess): boolean {
  return group === next && next !== "exclusive";
}

/** Splits calls into received-order groups; each group runs in parallel after the previous one. */
export function groupToolCalls<T>(calls: readonly T[], name: (call: T) => string): T[][] {
  const groups: T[][] = [];
  let current: T[] = [];
  let currentAccess: ToolCallAccess | undefined;
  for (const call of calls) {
    const access = toolCallAccess(name(call));
    if (currentAccess !== undefined && canJoinGroup(currentAccess, access)) {
      current.push(call);
      continue;
    }
    if (current.length > 0) groups.push(current);
    current = [call];
    currentAccess = access;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

interface WaitingToolCall {
  access: ToolCallAccess;
  start: () => void;
}

/** MCP calls arrive individually, so reserve their order before asynchronous validation. */
export class ToolCallScheduler {
  private readonly waiting: WaitingToolCall[] = [];
  private activeAccess: ToolCallAccess = "read";
  private running = 0;

  run<T>(name: string, execute: () => Promise<T>): Promise<T> {
    const { promise, resolve } = Promise.withResolvers<T>();
    this.waiting.push({
      access: toolCallAccess(name),
      start: () => {
        const result = Promise.resolve().then(execute);
        resolve(result);
        void captureAgentPromise(() => result).then(() => this.release());
      },
    });
    this.drain();
    return promise;
  }

  private release(): void {
    this.running -= 1;
    this.drain();
  }

  private drain(): void {
    while (this.waiting.length > 0) {
      const next = this.waiting[0]!;
      if (this.running > 0 && !canJoinGroup(this.activeAccess, next.access)) return;
      this.waiting.shift();
      this.activeAccess = next.access;
      this.running += 1;
      next.start();
    }
  }
}
