import type z from "zod";
import type { BridgeFnHelpResponse } from "./schema";

export type ServerToolListResult = z.infer<typeof BridgeFnHelpResponse>[];

export type RequestContext = {
  requestId?: string;
  sessionId?: string;
  requestClient?: string;
  cwd?: string;
};

export interface ServerTool {
  id: string;

  init(): Promise<void>;
  destroy(): Promise<void>;
  list(): Promise<ServerToolListResult>;
  call(
    callableId: string,
    input: Record<string, unknown>,
    opts?: {
      signal?: AbortSignal;
      context?: RequestContext;
      /** Request-scoped model messages (if available). */
      messages?: readonly unknown[];
    },
  ): Promise<unknown>;
}
