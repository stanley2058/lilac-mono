const MAX_TIMER_DELAY_MS = 2_147_483_647;

export type IdleTimer = {
  reset(): void;
  stop(): void;
};

export function createIdleTimer(idleTimeoutMs: number, onIdle: () => void): IdleTimer {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let generation = 0;
  let deadlineAt = 0;

  const stop = () => {
    generation += 1;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
  const arm = (expectedGeneration: number) => {
    const remainingMs = Math.max(0, deadlineAt - Date.now());
    timer = setTimeout(
      () => {
        if (expectedGeneration !== generation) return;
        const remaining = deadlineAt - Date.now();
        if (remaining > 0) {
          arm(expectedGeneration);
          return;
        }
        timer = null;
        generation += 1;
        onIdle();
      },
      Math.min(remainingMs, MAX_TIMER_DELAY_MS),
    );
  };

  return {
    reset() {
      stop();
      deadlineAt = Date.now() + idleTimeoutMs;
      arm(generation);
    },
    stop,
  };
}

export class AgentIdleTimeoutError extends Error {
  constructor(readonly idleTimeoutMs: number) {
    super(
      `agent idle timed out after ${idleTimeoutMs}ms without model, tool, or subagent activity`,
    );
    this.name = "AgentIdleTimeoutError";
  }
}

export function createAgentRunIdleWatchdog(params: {
  idleTimeoutMs: number;
  onTimeout: (error: AgentIdleTimeoutError) => void;
}) {
  let timedOut = false;
  let monitoring = false;
  let rejectTimeout: ((error: AgentIdleTimeoutError) => void) | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    rejectTimeout = reject;
  });
  void timeoutPromise.catch(() => undefined);

  const timer = createIdleTimer(params.idleTimeoutMs, () => {
    if (timedOut) return;
    timedOut = true;
    const error = new AgentIdleTimeoutError(params.idleTimeoutMs);
    params.onTimeout(error);
    rejectTimeout?.(error);
    rejectTimeout = null;
  });

  return {
    start() {
      if (timedOut) return;
      monitoring = true;
      timer.reset();
    },
    reset() {
      if (!timedOut && monitoring) timer.reset();
    },
    waitFor<T>(promise: Promise<T>): Promise<T> {
      return Promise.race([promise, timeoutPromise]);
    },
    pause() {
      monitoring = false;
      timer.stop();
    },
    stop() {
      monitoring = false;
      timer.stop();
      rejectTimeout = null;
    },
  };
}
