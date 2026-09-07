import type { Result } from "better-result";
import type { GatewayFailure } from "./contracts";

export function createExpiryTick(
  expire: () => Promise<Result<void, GatewayFailure>>,
  reportFailure: (error: GatewayFailure) => void,
) {
  let cleaning = false;
  return async () => {
    if (cleaning) return;
    cleaning = true;
    using _reset = {
      [Symbol.dispose]() {
        cleaning = false;
      },
    };
    (await expire()).match({ ok: () => {}, err: reportFailure });
  };
}
