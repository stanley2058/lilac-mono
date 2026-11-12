import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { NativeRPC } from "../../../../../packages/client/src/transport";

export type PayloadObserver = (kind: string, payload: unknown) => void;

export function observedHttpRPC(
  url: URL,
  headers: () => Record<string, string>,
  observe: PayloadObserver,
): NativeRPC {
  return createORPCClient(
    new RPCLink({
      url,
      headers,
      interceptors: [
        async ({ next, path, ...options }) => {
          const result = await next({ ...options, path });
          const kind = path.join(".");
          if (result && typeof result === "object" && Symbol.asyncIterator in result) {
            return (async function* () {
              for await (const payload of result as AsyncIterable<unknown>) {
                observe(kind, payload);
                yield payload;
              }
            })();
          }
          observe(kind, result);
          return result;
        },
      ],
    }),
  );
}
