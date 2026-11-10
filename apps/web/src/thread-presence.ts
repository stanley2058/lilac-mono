import { Result } from "better-result";
import type { NativeClient } from "@stanley2058/lilac-client";

export function createThreadPresence(client: Pick<NativeClient, "rpc" | "subscribe">) {
  const clientId = crypto.randomUUID();
  let viewedThread: string | undefined;
  // The view last sent to the server. Focus and blur repeat the same view, which needs no report.
  let reported: { threadId?: string } | undefined;

  async function report() {
    const rpc = client.rpc;
    const threadId = viewedThread;
    if (!rpc) {
      reported = undefined;
      return;
    }
    const sent = { threadId };
    reported = sent;
    const result = await Result.tryPromise({
      try: () => rpc.notifications.presence({ clientId, threadId }),
      catch: () => "Presence unavailable",
    });
    if (result.isErr() && reported === sent) reported = undefined;
  }

  /** Settles once the report, if one was needed, has finished. */
  function view(threadId?: string): Promise<void> {
    if (reported && reported.threadId === threadId) return Promise.resolve();
    viewedThread = threadId;
    return report();
  }

  function start() {
    void report();
    const timer = setInterval(() => {
      if (viewedThread) void report();
    }, 30_000);
    const unsubscribe = client.subscribe((event) => {
      if (event.kind === "connection" && event.state === "online") void report();
    });
    return () => {
      clearInterval(timer);
      unsubscribe();
      void view();
    };
  }

  return { view, start };
}
