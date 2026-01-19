import type { AdapterPlatform } from "@stanley2058/lilac-event-bus";
import type { RequestContext } from "../tool-server/types";
import { isAdapterPlatform } from "./is-adapter-platform";

export type RequiredToolServerHeaders = {
  request_id: string;
  session_id: string;
  request_client: AdapterPlatform;
};

export function requireToolServerHeaders(
  ctx: RequestContext | undefined,
  label: string,
): RequiredToolServerHeaders {
  const requestId = ctx?.requestId;
  const sessionId = ctx?.sessionId;
  const requestClient = ctx?.requestClient;

  if (!requestId || !sessionId || !requestClient) {
    throw new Error(
      `${label} tool requires request context (requestId/sessionId/requestClient)`,
    );
  }

  if (!isAdapterPlatform(requestClient)) {
    throw new Error(`Invalid requestClient '${requestClient}'`);
  }

  return {
    request_id: requestId,
    session_id: sessionId,
    request_client: requestClient,
  };
}
