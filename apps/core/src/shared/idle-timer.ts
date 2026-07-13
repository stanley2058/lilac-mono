export type IdleTimer = {
  reset(): void;
  stop(): void;
};

const MAX_TIMER_DELAY_MS = 2_147_483_647;

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
