import { createORPCClient } from "@orpc/client";
import { RPCLink as HttpRPCLink } from "@orpc/client/fetch";
import { RPCLink } from "@orpc/client/websocket";
import type { ContractRouterClient } from "@orpc/contract";
import type { NativeContract } from "@stanley2058/lilac-client-protocol";

export type NativeRPC = ContractRouterClient<NativeContract>;
export function createNativeRPC(socket: WebSocket): NativeRPC {
  return createORPCClient(new RPCLink({ websocket: socket }));
}

export function reconnectDelay(attempt: number, random = Math.random): number {
  const maximum = Math.min(30_000, 500 * 2 ** Math.min(attempt, 6));
  return Math.round(maximum * (0.5 + random() * 0.5));
}

export function createNativeHttpRPC(options: {
  url: string | URL;
  headers?: () => Promise<Record<string, string | undefined>> | Record<string, string | undefined>;
}): NativeRPC {
  return createORPCClient(
    new HttpRPCLink({
      ...options,
      fetch: (request, init) =>
        fetch(request, { ...init, credentials: "same-origin", cache: "no-store" }),
    }),
  );
}
