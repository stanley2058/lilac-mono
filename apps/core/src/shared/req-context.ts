import type { AdapterPlatform } from "@stanley2058/lilac-event-bus";
import { isAdapterPlatform } from "./is-adapter-platform";

export type RequiredRequestContext = {
  requestId: string;
  sessionId: string;
  requestClient: AdapterPlatform;
};

export function requireRequestContext(
  ctx: unknown,
  label: string,
): RequiredRequestContext {
  if (!ctx || typeof ctx !== "object") {
    throw new Error(
      `${label} requires experimental_context { requestId, sessionId, requestClient }`,
    );
  }

  const o = ctx as Record<string, unknown>;
  const requestId = o.requestId;
  const sessionId = o.sessionId;
  const requestClient = o.requestClient;

  if (
    typeof requestId !== "string" ||
    typeof sessionId !== "string" ||
    !isAdapterPlatform(requestClient)
  ) {
    throw new Error(
      `${label} requires experimental_context { requestId, sessionId, requestClient }`,
    );
  }

  return { requestId, sessionId, requestClient };
}
