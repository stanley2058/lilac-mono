/** Tracks whether a run has nothing to do until a subagent or a person responds. */
export function createRunWaitTracker(report: (waiting: boolean) => void) {
  const tools = new Map<string, boolean>();
  let idle = false;
  let reported = false;
  const update = () => {
    const waiting = idle || (tools.size > 0 && [...tools.values()].every(Boolean));
    if (waiting === reported) return;
    reported = waiting;
    report(waiting);
  };
  return {
    toolStarted(toolCallId: string, onlyWaits: boolean) {
      tools.set(toolCallId, onlyWaits);
      update();
    },
    toolEnded(toolCallId: string) {
      tools.delete(toolCallId);
      update();
    },
    enterIdleWait() {
      idle = true;
      update();
    },
    /** A new model turn or the end of the wait loop means every earlier wait is over. */
    resume() {
      idle = false;
      tools.clear();
      update();
    },
  };
}
